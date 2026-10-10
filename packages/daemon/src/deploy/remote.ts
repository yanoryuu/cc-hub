// アップロード先(FTP / FTPS / SFTP)への接続。プロトコルの違いをここで吸収する。
// - FTP / FTPS: basic-ftp(接続 1 本で順番に)。更新時刻は MLSD が使えれば取る(無ければサイズだけで比べる)
// - SFTP: ssh2-sftp-client(1 接続で 4 並列)。パスワード認証か秘密鍵(keyPath + パスフレーズ)
// - 置き換えは「一時ファイル名で送ってから rename」(rename で上書きできないサーバーは先に消してから rename)
// - パスワード / パスフレーズは接続時に渡すだけで保持しない。エラーメッセージにも含めない
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PassThrough, Readable, Writable } from 'node:stream';
import type { ServerInfo } from '@cc-hub/shared';
import { Client as FtpClient } from 'basic-ftp';
import { MANIFEST_NAME, TMP_MARK, type RemoteFile } from './plan';

const CONNECT_TIMEOUT_MS = 20_000;
const MAX_LIST_ENTRIES = 50_000;

export interface RemoteEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number | null;
}

export interface Remote {
  /** 同時に送ってよい数 */
  readonly parallel: number;
  connect(): Promise<void>;
  /** 相対パス(ログイン直後のフォルダ基準)を絶対パスにする */
  resolve(dir: string): string;
  /** フォルダが無ければ null */
  listDir(dir: string): Promise<RemoteEntry[] | null>;
  mkdirp(dir: string): Promise<void>;
  putFile(localAbs: string, remotePath: string): Promise<void>;
  putBuffer(buf: Buffer, remotePath: string): Promise<void>;
  /** 小さなファイルを読む(無ければ null) */
  readSmall(remotePath: string, maxBytes: number): Promise<Buffer | null>;
  rename(from: string, to: string): Promise<void>;
  remove(remotePath: string): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectSecret {
  /** パスワード(auth.type = 'password')または秘密鍵のパスフレーズ(auth.type = 'key') */
  secret: string | null;
}

/** 接続エラーを分かりやすい日本語にする(秘密は含めない) */
export function explainError(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  const code = (e as any)?.code;
  if (/530|login incorrect|authentication|auth fail|all configured authentication methods failed/i.test(msg)) {
    return '認証に失敗しました(ユーザー名 / パスワード / 鍵を確認してください)';
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) return '接続を拒否されました(ホスト名 / ポートを確認してください)';
  if (code === 'ENOTFOUND' || /ENOTFOUND|getaddrinfo/.test(msg)) return 'ホストが見つかりません(ホスト名を確認してください)';
  if (/timeout|timed out|ETIMEDOUT/i.test(msg)) return '接続がタイムアウトしました';
  if (/certificate|self[- ]signed|TLS|SSL/i.test(msg)) return `TLS の接続に失敗しました: ${msg.slice(0, 200)}`;
  return msg.slice(0, 300);
}

// ================================================================ FTP / FTPS
class FtpRemote implements Remote {
  readonly parallel = 1;
  private readonly c = new FtpClient(CONNECT_TIMEOUT_MS);
  private home = '/';

  constructor(
    private readonly s: ServerInfo,
    private readonly secret: string | null,
  ) {}

  async connect(): Promise<void> {
    await this.c.access({
      host: this.s.host,
      port: this.s.port,
      user: this.s.username,
      password: this.secret ?? '',
      secure: this.s.protocol === 'ftps',
    });
    // Windows の FTP サーバーは \ 区切りで返すことがある
    this.home = String((await this.c.pwd()) || '/').replace(/\\/g, '/') || '/';
  }

  resolve(dir: string): string {
    return dir.startsWith('/') ? dir : path.posix.join(this.home, dir);
  }

  async listDir(dir: string): Promise<RemoteEntry[] | null> {
    try {
      await this.c.cd(dir);
    } catch {
      return null;
    }
    try {
      const list = await this.c.list();
      return list
        .filter((f) => f.name !== '.' && f.name !== '..')
        .map((f) => ({ name: f.name, isDir: f.isDirectory, size: f.size, mtime: f.modifiedAt ? f.modifiedAt.getTime() : null }));
    } finally {
      await this.c.cd(this.home).catch(() => undefined);
    }
  }

  async mkdirp(dir: string): Promise<void> {
    const parts = dir.split('/').filter(Boolean);
    let cur = dir.startsWith('/') ? '' : '.';
    for (const p of parts) {
      cur = `${cur}/${p}`;
      // 既にあれば 550 が返るだけなので無視する
      await this.c.sendIgnoringError(`MKD ${cur}`);
    }
  }

  async putFile(localAbs: string, remotePath: string): Promise<void> {
    await this.c.uploadFrom(localAbs, remotePath);
  }

  async putBuffer(buf: Buffer, remotePath: string): Promise<void> {
    await this.c.uploadFrom(Readable.from([buf]), remotePath);
  }

  async readSmall(remotePath: string, maxBytes: number): Promise<Buffer | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    const w = new Writable({
      write(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size <= maxBytes) chunks.push(chunk);
        cb();
      },
    });
    try {
      await this.c.downloadTo(w, remotePath);
    } catch {
      return null;
    }
    return size > maxBytes ? null : Buffer.concat(chunks);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.c.rename(from, to);
  }

  async remove(remotePath: string): Promise<void> {
    await this.c.remove(remotePath);
  }

  async close(): Promise<void> {
    this.c.close();
  }
}

// ================================================================ SFTP
class SftpRemote implements Remote {
  readonly parallel = 4;
  private c: any = null;
  private home = '/';

  constructor(
    private readonly s: ServerInfo,
    private readonly secret: string | null,
  ) {}

  async connect(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const SftpClient = require('ssh2-sftp-client');
    this.c = new SftpClient('cc-hub');
    const cfg: Record<string, unknown> = {
      host: this.s.host,
      port: this.s.port,
      username: this.s.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      retries: 0,
    };
    if (this.s.auth.type === 'key') {
      if (!this.s.auth.keyPath) throw new Error('秘密鍵のパス(keyPath)が設定されていません');
      cfg.privateKey = fs.readFileSync(this.s.auth.keyPath);
      if (this.secret) cfg.passphrase = this.secret;
    } else {
      cfg.password = this.secret ?? '';
      cfg.tryKeyboard = false;
    }
    await this.c.connect(cfg);
    try {
      this.home = String((await this.c.realPath('.')) || '/').replace(/\\/g, '/') || '/';
    } catch {
      this.home = '/';
    }
  }

  resolve(dir: string): string {
    return dir.startsWith('/') ? dir : path.posix.join(this.home, dir);
  }

  async listDir(dir: string): Promise<RemoteEntry[] | null> {
    const t = await this.c.exists(dir);
    if (t !== 'd') return null;
    const list: any[] = await this.c.list(dir);
    return list
      .filter((f) => f.name !== '.' && f.name !== '..' && (f.type === 'd' || f.type === '-'))
      .map((f) => ({ name: f.name, isDir: f.type === 'd', size: Number(f.size) || 0, mtime: Number.isFinite(f.modifyTime) ? f.modifyTime : null }));
  }

  async mkdirp(dir: string): Promise<void> {
    const t = await this.c.exists(dir);
    if (t === 'd') return;
    await this.c.mkdir(dir, true);
  }

  async putFile(localAbs: string, remotePath: string): Promise<void> {
    await this.c.put(fs.createReadStream(localAbs), remotePath);
  }

  async putBuffer(buf: Buffer, remotePath: string): Promise<void> {
    await this.c.put(buf, remotePath);
  }

  async readSmall(remotePath: string, maxBytes: number): Promise<Buffer | null> {
    const t = await this.c.exists(remotePath);
    if (t !== '-') return null;
    const st = await this.c.stat(remotePath);
    if (Number(st.size) > maxBytes) return null;
    const pt = new PassThrough();
    const chunks: Buffer[] = [];
    pt.on('data', (c: Buffer) => chunks.push(c));
    await this.c.get(remotePath, pt);
    return Buffer.concat(chunks);
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      // OpenSSH 拡張(上書きできる)。使えないサーバーは通常の rename(上書き不可)
      await this.c.posixRename(from, to);
    } catch {
      await this.c.rename(from, to);
    }
  }

  async remove(remotePath: string): Promise<void> {
    await this.c.delete(remotePath, true);
  }

  async close(): Promise<void> {
    try {
      await this.c?.end();
    } catch {
      /* 無視 */
    }
  }
}

export function createRemote(s: ServerInfo, secret: string | null): Remote {
  return s.protocol === 'sftp' ? new SftpRemote(s, secret) : new FtpRemote(s, secret);
}

// ================================================================ 共通処理
/** リモートを再帰的に列挙する(除外に一致するフォルダには入らない。一時ファイルとマニフェストは含めない) */
export async function listRecursive(r: Remote, base: string, isExcluded: (rel: string) => boolean): Promise<Map<string, RemoteFile> | null> {
  const out = new Map<string, RemoteFile>();
  const top = await r.listDir(base);
  if (!top) return null;
  const queue: { dir: string; prefix: string; entries: RemoteEntry[] | null }[] = [{ dir: base, prefix: '', entries: top }];
  while (queue.length) {
    const cur = queue.shift()!;
    const entries = cur.entries ?? (await r.listDir(cur.dir)) ?? [];
    for (const e of entries) {
      const rel = cur.prefix ? `${cur.prefix}/${e.name}` : e.name;
      if (rel === MANIFEST_NAME || e.name.includes(TMP_MARK) || isExcluded(rel)) continue;
      if (e.isDir) queue.push({ dir: `${cur.dir === '/' ? '' : cur.dir}/${e.name}`, prefix: rel, entries: null });
      else out.set(rel, { size: e.size, mtime: e.mtime });
      if (out.size > MAX_LIST_ENTRIES) throw new Error('リモートのファイルが多すぎます');
    }
  }
  return out;
}

/** 一時ファイル名で送ってから置き換える */
export async function uploadAtomic(r: Remote, src: { abs?: string; buf?: Buffer }, target: string): Promise<void> {
  const dir = path.posix.dirname(target);
  const name = path.posix.basename(target);
  const tmp = `${dir === '/' ? '' : dir}/${name}${TMP_MARK}${crypto.randomBytes(4).toString('hex')}`;
  if (src.buf) await r.putBuffer(src.buf, tmp);
  else await r.putFile(src.abs!, tmp);
  try {
    await r.rename(tmp, target);
  } catch {
    // rename で上書きできないサーバー: 消してから rename
    try {
      await r.remove(target);
    } catch {
      /* 無い場合 */
    }
    try {
      await r.rename(tmp, target);
    } catch (e) {
      await r.remove(tmp).catch(() => undefined);
      throw e;
    }
  }
}
