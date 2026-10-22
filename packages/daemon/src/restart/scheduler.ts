// CC Hub の再起動の予約: 「作業が終わったら再起動」を画面(と Discord の /status)から扱えるようにする。
// - when: 'idle' = CC Hub のセッションに作業中(実行中 / 承認待ち / 起動中)のものが無い状態が 20 秒続いたら再起動。'now' = すぐ
// - 再起動は scripts/deploy.ps1(build = false なら -SkipBuild)を切り離した PowerShell で実行する(このデーモンはそこで止められる)
//   インストール版(deploy.ps1 が無い)は、新しいデーモンを起動してから自分が終了する(relaunchSelf。ビルドはしない)
// - 再起動すると CC Hub のセッションは一度止まり、--resume で再開する
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { RestartStatus } from '@cc-hub/shared';
import { HttpError } from '../util';

const CHECK_MS = 10_000;
/** 作業中のものが無い状態がこの回数続いたら再起動する */
const IDLE_CHECKS = 2;
/** 再起動を始めてもこの時間デーモンが動いていたら失敗とみなす(ビルドの時間を含む) */
const FAIL_AFTER_MS = 10 * 60_000;

export interface RestartDeps {
  /** 再起動すると止まってしまう作業(セッション名やアップロード)。空なら再起動してよい */
  busy: () => string[];
  /** scripts/deploy.ps1 */
  script: string;
  /** deploy.ps1 の出力 */
  logFile: string;
  /** 再起動を実行する(テストで差し替える) */
  launch?: (script: string, build: boolean, logFile: string) => void;
  /** インストール版(deploy.ps1 が無い): script の代わりにこれで再起動する(relaunchSelf) */
  relaunch?: () => void;
}

/**
 * deploy.ps1 を切り離して実行する(このデーモンが止められても続く)。
 * Node の detached で powershell を起動するとコンソールが無くスクリプトが動かないので、
 * 外側の powershell が Start-Process で内側を起動してすぐ終わる形にする
 */
export function launchDeploy(script: string, build: boolean, logFile: string): void {
  const q = (s: string) => s.replace(/'/g, "''");
  const inner = `& '${q(script)}'${build ? '' : ' -SkipBuild'} *> '${q(logFile)}'`;
  const outer = `Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-Command','${q(inner)}')`;
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer], {
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (e) => console.error(`[restart] powershell を起動できません: ${e.message}`));
}

/**
 * インストール版(deploy.ps1 が無い)の再起動: 同じ node と main.js で新しいデーモンを切り離して起動し、自分は終了する。
 * 新しいデーモンは CC_HUB_WAIT_PID の終了を待ってから待ち受ける(ポートが空くまで)
 */
export function relaunchSelf(logFile: string, exit: () => void): void {
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, process.argv.slice(1), {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, CC_HUB_WAIT_PID: String(process.pid) },
  });
  child.on('error', (e) => console.error(`[restart] 新しいデーモンを起動できません: ${e.message}`));
  child.unref();
  fs.closeSync(fd);
  exit();
}

/** CC_HUB_WAIT_PID のプロセスが終わるまで待つ(最大 30 秒) */
export async function waitForPid(pid: string | undefined): Promise<void> {
  const n = Number(pid);
  if (!n) return;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      process.kill(n, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

export class RestartScheduler {
  private state: RestartStatus['state'] = 'idle';
  private build = true;
  private requestedAt: number | null = null;
  private error: string | null = null;
  private idleCount = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: RestartDeps) {}

  status(): RestartStatus {
    return {
      state: this.state,
      build: this.build,
      requestedAt: this.requestedAt,
      busy: this.state === 'waiting' ? this.d.busy() : [],
      error: this.error,
    };
  }

  /** 再起動を予約する(when = 'now' ならすぐ) */
  request(body: any): RestartStatus {
    if (this.state === 'restarting') throw new HttpError(409, '再起動を始めています');
    if (!this.d.relaunch && !fs.existsSync(this.d.script)) throw new HttpError(500, `再起動のスクリプトが見つかりません: ${this.d.script}`);
    this.build = body?.build !== false;
    this.error = null;
    this.requestedAt = Date.now();
    this.idleCount = 0;
    if (body?.when === 'now') {
      this.launch();
      return this.status();
    }
    this.state = 'waiting';
    console.log(`[restart] 作業が終わったら再起動します${this.build ? '(ビルドしてから)' : ''}`);
    if (!this.timer) this.timer = setInterval(() => this.tick(), CHECK_MS);
    this.tick();
    return this.status();
  }

  cancel(): RestartStatus {
    if (this.state === 'restarting') throw new HttpError(409, '再起動を始めているため取り消せません');
    if (this.state === 'waiting') console.log('[restart] 再起動の予約を取り消しました');
    this.stopTimer();
    this.state = 'idle';
    this.requestedAt = null;
    return this.status();
  }

  stop(): void {
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** deploy.ps1 の出力の最後の行(PowerShell の *> は UTF-16 で書く) */
  private logTail(): string {
    try {
      const buf = fs.readFileSync(this.d.logFile);
      const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
      return (
        text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .pop() ?? ''
      ).slice(0, 300);
    } catch {
      return '';
    }
  }

  private tick(): void {
    if (this.state !== 'waiting') return;
    const busy = this.d.busy();
    this.idleCount = busy.length ? 0 : this.idleCount + 1;
    if (this.idleCount >= IDLE_CHECKS) this.launch();
  }

  private launch(): void {
    this.stopTimer();
    this.state = 'restarting';
    console.log(`[restart] 再起動します${this.build ? '(ビルドしてから)' : ''}。ログ: ${this.d.logFile}`);
    try {
      fs.mkdirSync(path.dirname(this.d.logFile), { recursive: true });
      if (this.d.relaunch) this.d.relaunch();
      else (this.d.launch ?? launchDeploy)(this.d.script, this.build, this.d.logFile);
      // ビルドに失敗した場合などはデーモンが止められずに残る → しばらくしたら失敗として戻す
      setTimeout(() => {
        if (this.state !== 'restarting') return;
        this.state = 'idle';
        this.error = `再起動できませんでした。${this.logTail() || `ログ(${this.d.logFile})を確認してください`}`;
        console.error(`[restart] ${this.error}`);
      }, FAIL_AFTER_MS).unref();
    } catch (e) {
      this.state = 'idle';
      this.error = `再起動を始められませんでした: ${(e as Error).message}`;
      console.error(`[restart] ${this.error}`);
    }
  }
}
