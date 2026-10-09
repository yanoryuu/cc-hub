// 設定とデータディレクトリ(%APPDATA%\cc-hub)。
// 環境変数 CC_HUB_DATA_DIR で別ディレクトリを使える(テスト用に %APPDATA% を汚さないため)。
// PIN とトークンは絶対にログへ出さないこと。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DEFAULT_PORT } from '@cc-hub/shared';

export interface HubConfig {
  port: number;
  host: string;
  pin: string;
  claudePath: string;
  claudeArgs: string[];
  permissionMode: string;
  autoResume: boolean;
  // ---- フェーズ 2: リポジトリ / worktree プール
  /** worktree のルート。Unity は unity、それ以外は default(リポジトリごとに <root>\<name>) */
  worktreeRoots: { default: string; unity: string };
  /** 新規登録リポジトリの既定プール数 */
  defaultPoolMin: number;
  defaultPoolMax: number;
  /** poolMin を超えた待機 worktree を、この分数使われなければ削除する */
  idleTtlMinutes: number;
  /** ルートのドライブの空きがこれ未満なら補充を止める(GB) */
  minFreeDiskGB: number;
  // ---- フェーズ 3: ブランチ / PR
  /** gh コマンドのパス。.js / .cjs を指定すると node で実行する(検証用の偽 gh) */
  ghPath: string;
  /** PR 一覧の取得間隔(秒) */
  prPollSeconds: number;
}

// プロジェクトごとに D:\WorkTree\<name>\(.base + wt-NN)を作る。C ドライブの空きが少ないため D に統一
export const DEFAULT_WORKTREE_ROOTS = { default: 'D:\\WorkTree', unity: 'D:\\WorkTree' };

function numOr(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

export const HOME = process.env.USERPROFILE || os.homedir();

export function dataDir(): string {
  if (process.env.CC_HUB_DATA_DIR) return path.resolve(process.env.CC_HUB_DATA_DIR);
  const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  return path.join(appData, 'cc-hub');
}

const CC_REMOTE_CONFIG = path.join(HOME, 'cc-remote', 'config.json');

function defaultClaudePath(): string {
  const p = path.join(HOME, '.local', 'bin', 'claude.exe');
  return fs.existsSync(p) ? p : 'claude';
}

// 初回起動時: config.json を作り、CC Remote の PIN と claudePath を引き継ぐ
function createConfig(file: string): HubConfig {
  let pin = '';
  let claudePath = '';
  try {
    const old = JSON.parse(fs.readFileSync(CC_REMOTE_CONFIG, 'utf8'));
    if (old.pin != null) pin = String(old.pin);
    if (old.claudePath) claudePath = String(old.claudePath);
  } catch {
    /* CC Remote が無ければ新規生成 */
  }
  if (!pin) pin = String(crypto.randomInt(100000, 1000000));
  const cfg: HubConfig = {
    port: DEFAULT_PORT,
    host: '127.0.0.1',
    pin,
    claudePath: claudePath || defaultClaudePath(),
    claudeArgs: [],
    permissionMode: 'auto',
    autoResume: true,
    worktreeRoots: { ...DEFAULT_WORKTREE_ROOTS },
    defaultPoolMin: 3,
    defaultPoolMax: 10,
    idleTtlMinutes: 30,
    minFreeDiskGB: 20,
    ghPath: 'gh',
    prPollSeconds: 90,
  };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  console.log(`[config] ${file} を作成しました(PIN は config.json を参照)`);
  return cfg;
}

function readOrCreateToken(file: string): string {
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {
    /* 無ければ作る */
  }
  const t = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, t);
  return t;
}

export interface LoadedConfig {
  dir: string;
  config: HubConfig;
  localToken: string;
  ingestToken: string;
}

export function loadConfig(): LoadedConfig {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  let raw: Partial<HubConfig>;
  if (fs.existsSync(file)) {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    raw = createConfig(file);
  }
  const config: HubConfig = {
    port: Number(raw.port) || DEFAULT_PORT,
    host: raw.host || '127.0.0.1',
    pin: String(raw.pin ?? ''),
    claudePath: raw.claudePath || defaultClaudePath(),
    claudeArgs: Array.isArray(raw.claudeArgs) ? raw.claudeArgs.map(String) : [],
    permissionMode: raw.permissionMode || 'auto',
    autoResume: raw.autoResume !== false,
    // フェーズ 1 で作った config.json には無いので既定値で補う
    worktreeRoots: {
      default: String(raw.worktreeRoots?.default || DEFAULT_WORKTREE_ROOTS.default),
      unity: String(raw.worktreeRoots?.unity || DEFAULT_WORKTREE_ROOTS.unity),
    },
    defaultPoolMin: numOr(raw.defaultPoolMin, 3, 0, 50),
    defaultPoolMax: numOr(raw.defaultPoolMax, 10, 1, 50),
    idleTtlMinutes: numOr(raw.idleTtlMinutes, 30, 0, 1e6),
    minFreeDiskGB: numOr(raw.minFreeDiskGB, 20, 0, 1e6),
    ghPath: String(raw.ghPath || 'gh'),
    prPollSeconds: numOr(raw.prPollSeconds, 90, 10, 3600),
  };
  return {
    dir,
    config,
    localToken: readOrCreateToken(path.join(dir, 'local-token')),
    ingestToken: readOrCreateToken(path.join(dir, 'ingest-token')),
  };
}
