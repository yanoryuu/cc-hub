// DeployService: アップロード先のサーバー(FTP / FTPS / SFTP)の登録と、アップロードのジョブ。
// - サーバーの秘密(パスワード / 鍵のパスフレーズ)は DPAPI で暗号化して SQLite に保存。復号は接続の直前だけ
// - ジョブ: ユーザーから = planning(ビルド → 差分計算)→ ready → start → uploading → done / failed(dryRun は ready で止まる)
//           Claude から(MCP request_deploy)= pending_approval → approve → planning → uploading → done(ready で止まらない)
//           reject(申請中のみ)/ cancel(終わっていないもの)
// - 同じサーバーへのビルド・送信は同時に 1 本だけ
// - 進捗(deploy.upsert)は 1 秒に 4 回まで
// - ジョブは最近 50 件を保存(申請中・実行中は消さない)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { DeployJob, DeployPlan, ServerInfo, ServerProtocol } from '@cc-hub/shared';
import { bus } from '../bus';
import type { Store } from '../store/db';
import type { SecretBox } from '../dpapi';
import { cleanEnv } from '../repo/exec';
import { HttpError } from '../util';
import { emitNotify } from '../notify/emit';
import {
  MANIFEST_NAME,
  buildManifest,
  compileExcludes,
  computePlan,
  joinRemote,
  normRemoteDir,
  parseManifest,
  relDir,
  sha1File,
  walkLocal,
} from './plan';
import { createRemote, explainError, listRecursive, uploadAtomic, type Remote } from './remote';

const KEEP_JOBS = 50;
const LOG_LINES = 200;
const BUILD_TIMEOUT_MS = 15 * 60_000;
const PROGRESS_INTERVAL_MS = 250;
const MANIFEST_MAX = 5 * 1024 * 1024;
const ACTIVE: DeployJob['state'][] = ['planning', 'uploading'];
const OPEN: DeployJob['state'][] = ['pending_approval', 'planning', 'ready', 'uploading'];
const PROTOCOLS: ServerProtocol[] = ['ftp', 'ftps', 'sftp'];

interface Rt {
  job: DeployJob;
  dryRun: boolean;
  cancelled: boolean;
  kill: (() => void) | null;
  lastEmit: number;
  emitTimer: NodeJS.Timeout | null;
}

export interface DeployDeps {
  store: Store;
  secrets: SecretBox;
  /** Claude の申請のセッション名(通知・表示用) */
  sessionName?: (id: string) => string | null;
}

/** ビルドを実行するフォルダ: localDir から上に辿って最初に package.json があるフォルダ(無ければ localDir) */
export function projectRootFor(localDir: string): string {
  let d = path.resolve(localDir);
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return path.resolve(localDir);
}

/** ログの末尾 LOG_LINES 行を保つ */
export function pushLog(log: string[], text: string): void {
  for (const line of String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if (line === '') continue;
    log.push(line.length > 500 ? line.slice(0, 500) + '…' : line);
  }
  if (log.length > LOG_LINES) log.splice(0, log.length - LOG_LINES);
}

function str(v: unknown, max = 500): string {
  return String(v ?? '').trim().slice(0, max);
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** アップロード元のフォルダの検証(存在する絶対パスで、ドライブ直下ではない) */
export function checkLocalDir(p: unknown): string {
  const s = str(p, 1000);
  if (!s) throw new HttpError(400, 'アップロード元のフォルダ(localDir)を指定してください');
  if (!path.isAbsolute(s)) throw new HttpError(400, `localDir は絶対パスで指定してください: ${s}`);
  const abs = path.resolve(s);
  if (path.parse(abs).root === abs || /^[A-Za-z]:\\?$/.test(abs)) throw new HttpError(400, 'ドライブ直下はアップロード元にできません');
  if (!isDir(abs)) throw new HttpError(400, `フォルダが存在しません: ${abs}`);
  return abs;
}

export class DeployService {
  private readonly servers = new Map<string, ServerInfo>();
  private readonly jobs = new Map<string, Rt>();

  constructor(private readonly d: DeployDeps) {
    const db = d.store.db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS servers (id TEXT PRIMARY KEY, json TEXT NOT NULL, secret_enc TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deploys (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, json TEXT NOT NULL);
    `);
    for (const r of db.prepare('SELECT * FROM servers ORDER BY created_at').all() as { id: string; json: string; secret_enc: string | null }[]) {
      try {
        const s = JSON.parse(r.json) as ServerInfo;
        s.auth = { ...s.auth, hasSecret: !!r.secret_enc };
        this.servers.set(r.id, s);
      } catch {
        /* 壊れた行は無視 */
      }
    }
    for (const r of db.prepare('SELECT * FROM deploys ORDER BY created_at').all() as { json: string }[]) {
      try {
        const job = JSON.parse(r.json) as DeployJob;
        // 実行中のまま残ったジョブ(デーモンの停止で中断)
        if (ACTIVE.includes(job.state)) {
          job.state = 'failed';
          job.error = 'デーモンの再起動で中断しました';
          job.finishedAt = Date.now();
          this.saveJob(job);
        }
        this.jobs.set(job.id, this.newRt(job, false));
      } catch {
        /* 無視 */
      }
    }
  }

  private newRt(job: DeployJob, dryRun: boolean): Rt {
    return { job, dryRun, cancelled: false, kill: null, lastEmit: 0, emitTimer: null };
  }

  // ================================================================ 参照
  allServers(): Record<string, ServerInfo> {
    const out: Record<string, ServerInfo> = {};
    for (const [id, s] of this.servers) out[id] = this.pubServer(s);
    return out;
  }

  allJobs(): Record<string, DeployJob> {
    const out: Record<string, DeployJob> = {};
    for (const [id, r] of this.jobs) out[id] = this.pubJob(r.job);
    return out;
  }

  serverList(): ServerInfo[] {
    return [...this.servers.values()].map((s) => this.pubServer(s));
  }

  job(id: string): DeployJob | null {
    const r = this.jobs.get(id);
    return r ? this.pubJob(r.job) : null;
  }

  /** id か名前(大文字小文字を区別しない)でサーバーを探す */
  findServer(idOrName: string): ServerInfo | null {
    const k = String(idOrName ?? '').trim();
    if (!k) return null;
    const s = this.servers.get(k) ?? [...this.servers.values()].find((x) => x.name.toLowerCase() === k.toLowerCase());
    return s ? this.pubServer(s) : null;
  }

  private pubServer(s: ServerInfo): ServerInfo {
    return { ...s, auth: { ...s.auth }, exclude: [...s.exclude], lastTest: s.lastTest ? { ...s.lastTest } : null };
  }

  private pubJob(j: DeployJob): DeployJob {
    return JSON.parse(JSON.stringify(j));
  }

  private requireServer(id: string): ServerInfo {
    const s = this.servers.get(id);
    if (!s) throw new HttpError(404, 'サーバーが見つかりません');
    return s;
  }

  private requireJob(id: string): Rt {
    const r = this.jobs.get(id);
    if (!r) throw new HttpError(404, 'アップロードが見つかりません');
    return r;
  }

  // ================================================================ サーバーの登録・変更・削除
  /** 入力の検証。cur = 変更前(PATCH) */
  private parseServer(body: any, cur: ServerInfo | null): ServerInfo {
    if (!body || typeof body !== 'object') throw new HttpError(400, '入力が不正です');
    const pick = <K extends keyof ServerInfo>(k: K): any => (body[k] !== undefined ? body[k] : cur?.[k]);
    const name = str(pick('name'), 100);
    if (!name) throw new HttpError(400, '名前(name)を指定してください');
    const dup = [...this.servers.values()].find((x) => x.name.toLowerCase() === name.toLowerCase() && x.id !== cur?.id);
    if (dup) throw new HttpError(409, `同じ名前のサーバーがあります: ${name}`);
    const protocol = str(pick('protocol'), 10) as ServerProtocol;
    if (!PROTOCOLS.includes(protocol)) throw new HttpError(400, "protocol は 'ftp' / 'ftps' / 'sftp' のいずれかです");
    const host = str(pick('host'), 255);
    if (!/^[A-Za-z0-9.\-:[\]]+$/.test(host)) throw new HttpError(400, 'ホスト名(host)が不正です');
    const portRaw = pick('port');
    const port = portRaw == null || portRaw === '' ? (protocol === 'sftp' ? 22 : 21) : Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'ポート(port)が不正です');
    const username = str(pick('username'), 200);
    if (!username) throw new HttpError(400, 'ユーザー名(username)を指定してください');
    const authIn = body.auth ?? cur?.auth ?? { type: 'password' };
    const authType = authIn.type === 'key' ? 'key' : 'password';
    if (authType === 'key' && protocol !== 'sftp') throw new HttpError(400, '鍵認証は SFTP のみです');
    let keyPath: string | undefined;
    if (authType === 'key') {
      keyPath = str(authIn.keyPath ?? cur?.auth.keyPath, 1000);
      if (!keyPath || !path.isAbsolute(keyPath) || !fs.existsSync(keyPath)) throw new HttpError(400, `秘密鍵が見つかりません: ${keyPath || '(未指定)'}`);
    }
    let remoteDir: string;
    try {
      remoteDir = normRemoteDir(str(pick('remoteDir'), 1000));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const publicUrl = str(pick('publicUrl'), 1000) || null;
    if (publicUrl && !/^https?:\/\/\S+$/.test(publicUrl)) throw new HttpError(400, '公開 URL(publicUrl)は http(s):// で始めてください');
    const dl = str(pick('defaultLocalDir'), 1000);
    const defaultLocalDir = dl ? checkLocalDir(dl) : null;
    const buildCommand = str(pick('buildCommand'), 1000) || null;
    const exRaw = pick('exclude');
    const exclude = Array.isArray(exRaw) ? exRaw.map((x: unknown) => str(x, 200)).filter(Boolean).slice(0, 100) : [];
    return {
      id: cur?.id ?? crypto.randomUUID(),
      name,
      protocol,
      host,
      port,
      username,
      auth: { type: authType, hasSecret: cur?.auth.hasSecret ?? false, ...(keyPath ? { keyPath } : {}) },
      remoteDir,
      publicUrl,
      defaultLocalDir,
      buildCommand,
      exclude,
      deleteExtra: pick('deleteExtra') === true,
      note: str(pick('note'), 2000),
      lastDeployAt: cur?.lastDeployAt ?? null,
      lastTest: cur?.lastTest ?? null,
    };
  }

  private saveServer(s: ServerInfo, secretEnc?: string | null): void {
    const db = this.d.store.db;
    const json = JSON.stringify({ ...s, auth: { ...s.auth, hasSecret: undefined } });
    if (secretEnc === undefined) {
      const exists = db.prepare('SELECT 1 FROM servers WHERE id = ?').get(s.id);
      if (exists) db.prepare('UPDATE servers SET json = ? WHERE id = ?').run(json, s.id);
      else db.prepare('INSERT INTO servers (id, json, secret_enc, created_at) VALUES (?, ?, NULL, ?)').run(s.id, json, Date.now());
    } else {
      db.prepare(
        `INSERT INTO servers (id, json, secret_enc, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, secret_enc = excluded.secret_enc`,
      ).run(s.id, json, secretEnc, Date.now());
    }
    this.servers.set(s.id, s);
    bus.state({ t: 'server.upsert', server: this.pubServer(s) });
  }

  /** secret: 文字列 = 暗号化して保存 / null = 消す / undefined = 据え置き */
  private async secretFrom(body: any): Promise<string | null | undefined> {
    if (!('secret' in (body ?? {})) || body.secret === undefined) return undefined;
    if (body.secret === null) return null;
    const s = String(body.secret);
    if (!s) return undefined; // 空 = 据え置き
    if (s.length > 10_000) throw new HttpError(400, 'secret が長すぎます');
    return this.d.secrets.protect(s);
  }

  async createServer(body: any): Promise<ServerInfo> {
    const s = this.parseServer(body, null);
    const enc = await this.secretFrom(body);
    s.auth.hasSecret = !!enc;
    this.saveServer(s, enc ?? null);
    return this.pubServer(s);
  }

  async patchServer(id: string, body: any): Promise<ServerInfo> {
    const cur = this.requireServer(id);
    const s = this.parseServer(body, cur);
    const enc = await this.secretFrom(body);
    if (enc !== undefined) s.auth.hasSecret = !!enc;
    this.saveServer(s, enc);
    return this.pubServer(s);
  }

  deleteServer(id: string): void {
    this.requireServer(id);
    for (const r of this.jobs.values()) {
      if (r.job.serverId === id && OPEN.includes(r.job.state)) throw new HttpError(409, 'このサーバーへのアップロードが進行中です');
    }
    this.d.store.db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    this.servers.delete(id);
    bus.state({ t: 'server.remove', id });
  }

  /** 暗号化して保存した秘密(テスト・診断用。中身は返さない) */
  storedSecretBlob(id: string): string | null {
    const r = this.d.store.db.prepare('SELECT secret_enc FROM servers WHERE id = ?').get(id) as { secret_enc: string | null } | undefined;
    return r?.secret_enc ?? null;
  }

  /** 接続する(秘密は復号してすぐ渡し、変数を残さない) */
  private async connect(s: ServerInfo): Promise<Remote> {
    let secret: string | null = null;
    const enc = this.storedSecretBlob(s.id);
    if (enc) secret = await this.d.secrets.unprotect(enc);
    const r = createRemote(s, secret);
    secret = null;
    try {
      await r.connect();
    } catch (e) {
      await r.close();
      throw e;
    }
    return r;
  }

  /** 接続してリモートフォルダを確認する(作りはしない) */
  async testServer(id: string): Promise<{ ok: boolean; message: string; entries?: string[] }> {
    const s = this.requireServer(id);
    let result: { ok: boolean; message: string; entries?: string[] };
    let r: Remote | null = null;
    try {
      r = await this.connect(s);
      const dir = r.resolve(s.remoteDir);
      const list = await r.listDir(dir);
      if (!list) result = { ok: false, message: `接続できましたが、リモートフォルダがありません: ${dir}` };
      else {
        const entries = list.map((e) => (e.isDir ? `${e.name}/` : e.name)).sort().slice(0, 200);
        result = { ok: true, message: `接続できました(${dir}: ${list.length} 件)`, entries };
      }
    } catch (e) {
      result = { ok: false, message: explainError(e) };
    } finally {
      await r?.close();
    }
    s.lastTest = { ok: result.ok, message: result.message, at: Date.now() };
    this.saveServer(s);
    return result;
  }

  // ================================================================ ジョブ
  private saveJob(job: DeployJob): void {
    const db = this.d.store.db;
    db.prepare('INSERT OR REPLACE INTO deploys (id, created_at, json) VALUES (?, ?, ?)').run(job.id, job.createdAt, JSON.stringify(job));
  }

  /** 古いジョブを消す(終わったものだけ。最近 50 件を残す) */
  private prune(): void {
    const all = [...this.jobs.values()].sort((a, b) => b.job.createdAt - a.job.createdAt);
    let kept = 0;
    for (const r of all) {
      if (OPEN.includes(r.job.state) || kept < KEEP_JOBS) {
        kept++;
        continue;
      }
      this.jobs.delete(r.job.id);
      this.d.store.db.prepare('DELETE FROM deploys WHERE id = ?').run(r.job.id);
    }
  }

  /** 状態の変更を保存して配信する。progressOnly = 進捗だけ(間引く・保存しない) */
  private emit(r: Rt, progressOnly = false): void {
    if (progressOnly) {
      const wait = r.lastEmit + PROGRESS_INTERVAL_MS - Date.now();
      if (wait > 0) {
        if (!r.emitTimer) {
          r.emitTimer = setTimeout(() => {
            r.emitTimer = null;
            this.emit(r, true);
          }, wait);
        }
        return;
      }
    } else {
      if (r.emitTimer) clearTimeout(r.emitTimer);
      r.emitTimer = null;
      this.saveJob(r.job);
    }
    r.lastEmit = Date.now();
    bus.state({ t: 'deploy.upsert', deploy: this.pubJob(r.job) });
  }

  private busy(serverId: string, except?: string): boolean {
    for (const r of this.jobs.values()) if (r.job.serverId === serverId && r.job.id !== except && ACTIVE.includes(r.job.state)) return true;
    return false;
  }

  private newJob(s: ServerInfo, localDir: string, o: { buildCommand: string | null; note: string | null; requestedBy: DeployJob['requestedBy']; state: DeployJob['state'] }): DeployJob {
    return {
      id: crypto.randomUUID(),
      serverId: s.id,
      serverName: s.name,
      localDir,
      requestedBy: o.requestedBy,
      note: o.note,
      state: o.state,
      buildCommand: o.buildCommand,
      plan: null,
      progress: null,
      log: [],
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      url: null,
    };
  }

  /** POST /api/deploys(ユーザーから)。planning → ready で止まる */
  createUserJob(body: any): DeployJob {
    const s = this.requireServer(str(body?.serverId, 100));
    const localDir = checkLocalDir(body?.localDir ?? s.defaultLocalDir);
    if (this.busy(s.id)) throw new HttpError(409, 'このサーバーへのアップロードが進行中です');
    const buildCommand = body?.buildCommand === undefined ? s.buildCommand : str(body.buildCommand, 1000) || null;
    const job = this.newJob(s, localDir, { buildCommand, note: null, requestedBy: { kind: 'user' }, state: 'planning' });
    const r = this.newRt(job, body?.dryRun === true);
    this.jobs.set(job.id, r);
    this.prune();
    this.emit(r);
    void this.runPlan(r, false);
    return this.pubJob(job);
  }

  /** MCP request_deploy(Claude から)。承認待ちで止める */
  requestFromClaude(o: { server: string; localDir?: string | null; note: string; sessionId: string | null }): DeployJob {
    const found = this.findServer(o.server);
    if (!found) throw new HttpError(404, `サーバーが見つかりません: ${o.server}(list_servers で名前を確認してください)`);
    const s = this.requireServer(found.id);
    const localDir = checkLocalDir(o.localDir || s.defaultLocalDir);
    const note = str(o.note, 2000);
    if (!note) throw new HttpError(400, 'note(申請理由)を指定してください');
    const sessionName = o.sessionId ? (this.d.sessionName?.(o.sessionId) ?? null) : null;
    const job = this.newJob(s, localDir, {
      buildCommand: s.buildCommand,
      note,
      requestedBy: { kind: 'claude', sessionId: o.sessionId, sessionName },
      state: 'pending_approval',
    });
    const r = this.newRt(job, false);
    this.jobs.set(job.id, r);
    this.prune();
    this.emit(r);
    emitNotify(
      { kind: 'deploy', sessionId: o.sessionId ?? '', title: `アップロードの申請: ${s.name}`, body: `${note}\n(${localDir} → ${s.remoteDir})`, ts: Date.now() },
      { topic: 'deploy_request', sessionName, url: s.publicUrl },
    );
    return this.pubJob(job);
  }

  approve(id: string): DeployJob {
    const r = this.requireJob(id);
    if (r.job.state !== 'pending_approval') throw new HttpError(409, `承認待ちではありません(${r.job.state})`);
    if (this.busy(r.job.serverId, id)) throw new HttpError(409, 'このサーバーへのアップロードが進行中です。終わってから承認してください');
    this.requireServer(r.job.serverId);
    r.job.state = 'planning';
    pushLog(r.job.log, '承認されました');
    this.emit(r);
    void this.runPlan(r, true);
    return this.pubJob(r.job);
  }

  reject(id: string, reason: unknown): DeployJob {
    const r = this.requireJob(id);
    if (r.job.state !== 'pending_approval') throw new HttpError(409, `承認待ちではありません(${r.job.state})`);
    r.job.state = 'rejected';
    r.job.error = str(reason, 500) || null;
    r.job.finishedAt = Date.now();
    pushLog(r.job.log, `却下されました${r.job.error ? `: ${r.job.error}` : ''}`);
    this.emit(r);
    return this.pubJob(r.job);
  }

  cancel(id: string): DeployJob {
    const r = this.requireJob(id);
    if (!OPEN.includes(r.job.state)) throw new HttpError(409, `終わったアップロードです(${r.job.state})`);
    r.cancelled = true;
    r.kill?.();
    r.job.state = 'cancelled';
    r.job.finishedAt = Date.now();
    pushLog(r.job.log, '中止しました');
    this.emit(r);
    return this.pubJob(r.job);
  }

  start(id: string): DeployJob {
    const r = this.requireJob(id);
    if (r.job.state !== 'ready') throw new HttpError(409, `送信できる状態ではありません(${r.job.state})`);
    if (r.dryRun) throw new HttpError(409, '差分の確認だけ(dryRun)のアップロードです。送るには新しく作り直してください');
    if (this.busy(r.job.serverId, id)) throw new HttpError(409, 'このサーバーへのアップロードが進行中です');
    void this.runUpload(r);
    return this.pubJob(r.job);
  }

  // ================================================================ 実行
  private fail(r: Rt, message: string): void {
    if (r.cancelled) return;
    const s = this.servers.get(r.job.serverId);
    r.job.state = 'failed';
    r.job.error = message;
    r.job.finishedAt = Date.now();
    pushLog(r.job.log, `失敗: ${message}`);
    this.emit(r);
    console.warn(`[deploy] 失敗: ${r.job.serverName} ${message}`);
    this.notifyDone(r);
  }

  private notifyDone(r: Rt): void {
    const j = r.job;
    const ok = j.state === 'done';
    const body = ok
      ? `${j.plan?.upload.length ?? 0} ファイルを送信${j.plan?.delete.length ? `、${j.plan.delete.length} ファイルを削除` : ''}${j.url ? `\n${j.url}` : ''}`
      : (j.error ?? '');
    emitNotify(
      { kind: 'deploy', sessionId: j.requestedBy.kind === 'claude' ? (j.requestedBy.sessionId ?? '') : '', title: `アップロード${ok ? '完了' : '失敗'}: ${j.serverName}`, body, ts: Date.now() },
      { topic: 'deploy_done', url: ok ? j.url : null, sessionName: j.requestedBy.kind === 'claude' ? j.requestedBy.sessionName : null },
    );
  }

  /** ビルドを実行する(シェル。CLAUDE* は除く。15 分で打ち切り) */
  private runBuild(r: Rt, cmd: string, cwd: string): Promise<number> {
    return new Promise((resolve) => {
      pushLog(r.job.log, `$ ${cmd}  (${cwd})`);
      this.emit(r);
      const child = spawn(cmd, { cwd, shell: true, env: cleanEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let done = false;
      const killTree = () => {
        if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
      };
      r.kill = killTree;
      const timer = setTimeout(() => {
        pushLog(r.job.log, `[タイムアウト ${BUILD_TIMEOUT_MS / 60000} 分]`);
        killTree();
      }, BUILD_TIMEOUT_MS);
      const onData = (c: Buffer) => {
        pushLog(r.job.log, c.toString('utf8'));
        this.emit(r, true);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const finish = (code: number) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        r.kill = null;
        resolve(code);
      };
      child.on('error', (e) => {
        pushLog(r.job.log, String(e.message));
        finish(-1);
      });
      child.on('close', (code) => finish(code ?? -1));
    });
  }

  /** ビルド → 差分計算。auto = Claude の申請(ready で止めずに送る) */
  private async runPlan(r: Rt, auto: boolean): Promise<void> {
    const s = this.servers.get(r.job.serverId);
    if (!s) return this.fail(r, 'サーバーが削除されました');
    try {
      if (r.job.buildCommand) {
        const root = projectRootFor(r.job.localDir);
        const code = await this.runBuild(r, r.job.buildCommand, root);
        if (r.cancelled) return;
        if (code !== 0) return this.fail(r, `ビルドに失敗しました (code ${code})`);
        if (!isDir(r.job.localDir)) return this.fail(r, `ビルド後にフォルダがありません: ${r.job.localDir}`);
      }
      pushLog(r.job.log, '差分を計算しています');
      this.emit(r, true);
      const plan = await this.computeJobPlan(r, s);
      if (r.cancelled) return;
      r.job.plan = plan;
      pushLog(r.job.log, `送信 ${plan.upload.length} 件(${plan.totalBytes} バイト)/ 削除 ${plan.delete.length} 件 / 変更なし ${plan.unchanged} 件`);
      if (auto) {
        await this.runUpload(r);
        return;
      }
      r.job.state = 'ready';
      this.emit(r);
    } catch (e) {
      this.fail(r, explainError(e));
    }
  }

  private async computeJobPlan(r: Rt, s: ServerInfo): Promise<DeployPlan> {
    const isExcluded = compileExcludes(s.exclude);
    const local = await walkLocal(r.job.localDir, isExcluded);
    for (const f of local) f.sha1 = await sha1File(f.abs);
    const remote = await this.connect(s);
    try {
      const base = remote.resolve(s.remoteDir);
      const files = (await listRecursive(remote, base, isExcluded)) ?? new Map();
      const mtext = await remote.readSmall(joinRemote(base, MANIFEST_NAME), MANIFEST_MAX);
      const manifest = parseManifest(mtext ? mtext.toString('utf8') : null);
      if (manifest) pushLog(r.job.log, `前回のアップロードの記録(${MANIFEST_NAME})を使って比べます`);
      return computePlan({ local, remote: files, manifest, deleteExtra: s.deleteExtra, isExcluded });
    } finally {
      await remote.close();
    }
  }

  /** 送信(plan に従う)。最後にマニフェストを送る */
  private async runUpload(r: Rt): Promise<void> {
    const s = this.servers.get(r.job.serverId);
    if (!s) return this.fail(r, 'サーバーが削除されました');
    const plan = r.job.plan;
    if (!plan) return this.fail(r, '差分がありません');
    r.job.state = 'uploading';
    r.job.progress = { done: 0, total: plan.upload.length + plan.delete.length, bytes: 0, current: null };
    this.emit(r);
    let remote: Remote | null = null;
    try {
      const isExcluded = compileExcludes(s.exclude);
      remote = await this.connect(s);
      const base = remote.resolve(s.remoteDir);
      await remote.mkdirp(base);
      // フォルダを先に作る(浅い順)
      const dirs = [...new Set(plan.upload.map((u) => relDir(u.path)).filter(Boolean))].sort((a, b) => a.split('/').length - b.split('/').length);
      const made = new Set<string>();
      for (const d of dirs) {
        if (made.has(d)) continue;
        await remote.mkdirp(joinRemote(base, d));
        made.add(d);
      }
      // 送信(FTP は 1 本、SFTP は 4 並列)
      let next = 0;
      const rem = remote;
      const worker = async () => {
        for (;;) {
          if (r.cancelled) return;
          const i = next++;
          if (i >= plan.upload.length) return;
          const u = plan.upload[i];
          r.job.progress!.current = u.path;
          this.emit(r, true);
          await uploadAtomic(rem, { abs: path.join(r.job.localDir, ...u.path.split('/')) }, joinRemote(base, u.path));
          r.job.progress!.done++;
          r.job.progress!.bytes += u.size;
          this.emit(r, true);
        }
      };
      await Promise.all(Array.from({ length: Math.min(remote.parallel, Math.max(1, plan.upload.length)) }, worker));
      if (r.cancelled) return;
      for (const rel of plan.delete) {
        if (r.cancelled) return;
        r.job.progress!.current = rel;
        await remote.remove(joinRemote(base, rel));
        r.job.progress!.done++;
        this.emit(r, true);
      }
      // マニフェスト(今のローカルの全ファイルの size + sha1)を最後に送る
      const local = await walkLocal(r.job.localDir, isExcluded);
      for (const f of local) f.sha1 = await sha1File(f.abs);
      const manifest = Buffer.from(JSON.stringify(buildManifest(local), null, 1), 'utf8');
      await uploadAtomic(remote, { buf: manifest }, joinRemote(base, MANIFEST_NAME));
      if (r.cancelled) return;
      r.job.progress!.current = null;
      r.job.state = 'done';
      r.job.finishedAt = Date.now();
      r.job.url = s.publicUrl;
      pushLog(r.job.log, `完了しました(${plan.upload.length} 件送信 / ${plan.delete.length} 件削除)`);
      s.lastDeployAt = r.job.finishedAt;
      this.saveServer(s);
      this.emit(r);
      console.log(`[deploy] 完了: ${s.name} ${plan.upload.length} 件 / 削除 ${plan.delete.length} 件`);
      this.notifyDone(r);
    } catch (e) {
      this.fail(r, explainError(e));
    } finally {
      await remote?.close();
    }
  }
}
