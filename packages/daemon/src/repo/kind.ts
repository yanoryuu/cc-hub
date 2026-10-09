// プロジェクト種別の判定と、依存インストールコマンド・保持ディレクトリの既定値(design §7.2)。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RepoInfo, RepoKind } from '@cc-hub/shared';

const NODE_LOCKS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
/** lockfile のハッシュ対象(割当時に変わっていたら再インストールする) */
const DEP_FILES = ['package.json', ...NODE_LOCKS, 'uv.lock', 'requirements.txt', 'pyproject.toml'];

const has = (dir: string, f: string) => fs.existsSync(path.join(dir, f));

/** クローン後のファイルから種別を判定する */
export function detectKind(dir: string): RepoKind {
  if (has(dir, path.join('ProjectSettings', 'ProjectVersion.txt'))) return 'unity';
  if (has(dir, 'package.json') && NODE_LOCKS.some((f) => has(dir, f))) return 'node';
  if (has(dir, 'pyproject.toml') || has(dir, 'requirements.txt')) return 'python';
  return 'other';
}

export function defaultKeepDirs(kind: RepoKind): string[] {
  switch (kind) {
    case 'node':
      return ['node_modules'];
    case 'python':
      return ['.venv'];
    case 'unity':
      return ['Library'];
    default:
      return [];
  }
}

/** 種別から自動で決めるインストールコマンド(worktree のファイルを見て lockfile を選ぶ)。null = なし */
export function autoInstallCommand(kind: RepoKind, dir: string): string | null {
  if (kind === 'node') {
    if (has(dir, 'pnpm-lock.yaml')) return 'pnpm i --frozen-lockfile';
    if (has(dir, 'yarn.lock')) return 'yarn install --frozen-lockfile';
    if (has(dir, 'package-lock.json')) return 'npm ci';
    if (has(dir, 'package.json')) return 'npm install';
    return null;
  }
  if (kind === 'python') {
    if (has(dir, 'uv.lock')) return 'uv sync';
    if (has(dir, 'requirements.txt')) return 'python -m venv .venv && .venv\\Scripts\\pip install -r requirements.txt';
    if (has(dir, 'pyproject.toml')) return 'uv sync';
    return null;
  }
  return null;
}

/** repo.installCmd: null = 自動判定 / '' = インストールしない / それ以外 = そのコマンド */
export function installCommand(repo: RepoInfo, dir: string): string | null {
  if (repo.installCmd !== null && repo.installCmd !== undefined) return repo.installCmd.trim() || null;
  return autoInstallCommand(repo.kind, dir);
}

/** 依存ファイルのハッシュ */
export function lockHash(dir: string): string {
  const h = crypto.createHash('sha1');
  for (const f of DEP_FILES) {
    try {
      const buf = fs.readFileSync(path.join(dir, f));
      h.update(f).update('\0').update(buf).update('\0');
    } catch {
      /* 無いファイルは飛ばす */
    }
  }
  return h.digest('hex');
}
