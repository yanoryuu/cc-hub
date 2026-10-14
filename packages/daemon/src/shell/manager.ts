// ShellManager: CC Hub から開く PowerShell(Claude は動かさない、ただの端末)。
// スマホや Mac など、この PC の前にいないときに `npm run auth` のようなコマンドを打つためのもの。
// - ターミナルの購読(term:<id>)・入力・リサイズはセッションと同じ仕組みを使う(id は 'sh-' で始まる)
// - 保存はしない(デーモンを再起動すると消える)。終了しても画面は残し、閉じるまで一覧に出す
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ShellInfo } from '@cc-hub/shared';
import { bus } from '../bus';
import { HOME } from '../config';
import { HttpError, clampInt } from '../util';
import { PtyHost } from '../session/pty-host';

export const SHELL_PREFIX = 'sh-';
const MAX_SHELLS = 8;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

interface Entry {
  info: ShellInfo;
  host: PtyHost;
}

export function isShellId(id: string): boolean {
  return id.startsWith(SHELL_PREFIX);
}

export class ShellManager {
  private readonly shells = new Map<string, Entry>();
  private seq = 0;

  constructor(private readonly opts: { file?: string } = {}) {}

  list(): Record<string, ShellInfo> {
    const out: Record<string, ShellInfo> = {};
    for (const [id, e] of this.shells) out[id] = { ...e.info };
    return out;
  }

  /** POST /api/shells {cwd?, cols?, rows?} */
  start(body: { cwd?: unknown; cols?: unknown; rows?: unknown } = {}): ShellInfo {
    if (this.shells.size >= MAX_SHELLS) throw new HttpError(409, `PowerShell は ${MAX_SHELLS} 個までです。使っていないものを閉じてください`);
    const raw = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : HOME;
    const cwd = path.resolve(raw);
    let ok = false;
    try {
      ok = fs.statSync(cwd).isDirectory();
    } catch {
      /* 無い */
    }
    if (!ok) throw new HttpError(400, `フォルダが見つかりません: ${cwd}`);
    const cols = body.cols == null ? DEFAULT_COLS : clampInt(body.cols, 20, 300);
    const rows = body.rows == null ? DEFAULT_ROWS : clampInt(body.rows, 5, 100);
    const id = `${SHELL_PREFIX}${crypto.randomBytes(6).toString('hex')}`;
    const info: ShellInfo = { id, name: `PowerShell ${++this.seq}`, cwd, alive: true, exitCode: null, startedAt: Date.now(), cols, rows };
    const host = new PtyHost(cols, rows);
    const e: Entry = { info, host };
    host.onData = (data) => bus.term(id, { t: 'term.data', sid: id, data });
    host.onExit = (code) => {
      info.alive = false;
      info.exitCode = code;
      const msg = `\r\n\x1b[90m[PowerShell が終了しました(終了コード ${code})。「閉じる」で一覧から消せます]\x1b[0m\r\n`;
      host.writeLocal(msg);
      bus.term(id, { t: 'term.data', sid: id, data: msg });
      this.emit(e);
    };
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
    // CC Hub のセッション用の変数は渡さない(ここで claude を起動しても CC Hub のセッションに紐付かないように)
    delete env.CC_HUB_SESSION;
    host.spawn({ file: this.opts.file ?? 'powershell.exe', args: ['-NoLogo'], cwd, env });
    this.shells.set(id, e);
    console.log(`[shell] PowerShell を開きました: ${info.name} (${cwd})`);
    this.emit(e);
    return { ...info };
  }

  private require(id: string): Entry {
    const e = this.shells.get(id);
    if (!e) throw new HttpError(404, 'PowerShell が見つかりません(CC Hub を再起動すると消えます)');
    return e;
  }

  private emit(e: Entry): void {
    bus.state({ t: 'shell.upsert', shell: { ...e.info } });
  }

  /** 入力。submit = 末尾で Enter を送る */
  input(id: string, data: unknown, submit: unknown): void {
    const e = this.require(id);
    if (!e.host.alive) throw new HttpError(409, 'PowerShell は終了しています');
    const text = String(data ?? '');
    if (text) e.host.write(text);
    if (submit) setTimeout(() => e.host.alive && e.host.write('\r'), 30);
  }

  resize(id: string, cols: unknown, rows: unknown): { cols: number; rows: number } {
    const e = this.require(id);
    const c = clampInt(cols, 20, 300);
    const r = clampInt(rows, 5, 100);
    if (c !== e.info.cols || r !== e.info.rows) {
      e.host.resize(c, r);
      e.info.cols = c;
      e.info.rows = r;
      bus.term(id, { t: 'term.resize', sid: id, cols: c, rows: r });
    }
    return { cols: c, rows: r };
  }

  rename(id: string, name: unknown): ShellInfo {
    const e = this.require(id);
    const n = String(name ?? '').trim().slice(0, 50);
    if (!n) throw new HttpError(400, '名前が空です');
    e.info.name = n;
    this.emit(e);
    return { ...e.info };
  }

  /** 閉じる(動いていれば終了させて一覧から消す) */
  close(id: string): void {
    const e = this.require(id);
    this.shells.delete(id);
    e.host.onExit = () => {};
    e.host.dispose();
    bus.state({ t: 'shell.remove', id });
    console.log(`[shell] PowerShell を閉じました: ${e.info.name}`);
  }

  /** term:<id> 購読開始時のスナップショット */
  snapshot(id: string, cb: (data: string, cols: number, rows: number) => void): void {
    const e = this.shells.get(id);
    if (!e) return cb('\x1b[31m[PowerShell が見つかりません(CC Hub を再起動すると消えます)]\x1b[0m\r\n', DEFAULT_COLS, DEFAULT_ROWS);
    e.host.snapshot((data) => cb(data, e.info.cols, e.info.rows));
  }

  stopAll(): void {
    for (const id of [...this.shells.keys()]) this.close(id);
  }
}
