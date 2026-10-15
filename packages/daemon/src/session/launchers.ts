// 「アプリを開く」ボタン(AppLauncher): 入力の検証・一覧の更新と、コマンドの切り離し起動。
// - kind 'unity' はそのフォルダの Unity プロジェクトを開く(unity/launcher.ts の launchUnity)
// - kind 'command' は cmd.exe /d /s /c "start "" <コマンドライン>" で、セッションの作業フォルダから切り離して起動する
//   (GUI のツールが前面に出るよう windowsHide: false。終了は待たない)
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AppLauncher, UnityStatus } from '@cc-hub/shared';
import { HttpError } from '../util';

export const LAUNCHER_MAX = 10;
export const LAUNCHER_LABEL_MAX = 30;
export const LAUNCHER_COMMAND_MAX = 1000;
/** 起動直後にこの時間内で異常終了したら失敗として記録する */
export const LAUNCH_WATCH_MS = 1500;

export interface LauncherSpec {
  label: string;
  kind: 'unity' | 'command';
  command: string | null;
}

/** ボタン 1 件分の入力を検証する(エラーは 400) */
export function validateLauncherSpec(raw: unknown): LauncherSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'ボタンの指定が不正です');
  const r = raw as Record<string, unknown>;
  const label = typeof r.label === 'string' ? r.label.trim() : '';
  if (!label) throw new HttpError(400, 'ボタンの名前(label)を指定してください');
  if (label.length > LAUNCHER_LABEL_MAX) throw new HttpError(400, `ボタンの名前は ${LAUNCHER_LABEL_MAX} 文字までです: ${label.slice(0, 40)}`);
  if (/[\0\r\n]/.test(label)) throw new HttpError(400, 'ボタンの名前に改行は使えません');
  const kind = r.kind == null ? 'command' : r.kind;
  if (kind !== 'unity' && kind !== 'command') throw new HttpError(400, "kind は 'unity' か 'command' です");
  if (kind === 'unity') return { label, kind, command: null };
  const command = typeof r.command === 'string' ? r.command.trim() : '';
  if (!command) throw new HttpError(400, `「${label}」の起動コマンド(command)を指定してください`);
  if (command.length > LAUNCHER_COMMAND_MAX) throw new HttpError(400, `起動コマンドは ${LAUNCHER_COMMAND_MAX} 文字までです`);
  if (/[\0\r\n]/.test(command)) throw new HttpError(400, '起動コマンドに改行や NUL は使えません(1 行で書いてください)');
  return { label, kind, command };
}

function newId(): string {
  return crypto.randomBytes(6).toString('hex');
}

const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * PUT /api/sessions/:id/launchers の一覧をまとめて検証する。
 * 既存の id のものは lastRunAt / lastError / addedBy を引き継ぎ、id が無い(知らない)ものは新規(addedBy 'user')
 */
export function normalizeLaunchers(input: unknown, existing: AppLauncher[] = []): AppLauncher[] {
  if (!Array.isArray(input)) throw new HttpError(400, 'launchers は配列で指定してください');
  if (input.length > LAUNCHER_MAX) throw new HttpError(400, `ボタンは ${LAUNCHER_MAX} 個までです`);
  const out: AppLauncher[] = [];
  const used = new Set<string>();
  for (const raw of input) {
    const spec = validateLauncherSpec(raw);
    if (out.some((x) => sameLabel(x.label, spec.label))) throw new HttpError(400, `同じ名前のボタンがあります: ${spec.label}`);
    const rid = typeof (raw as any).id === 'string' ? (raw as any).id : '';
    const prev = rid && !used.has(rid) ? existing.find((x) => x.id === rid) : undefined;
    if (prev) used.add(prev.id);
    out.push({
      id: prev?.id ?? newId(),
      ...spec,
      addedBy: prev?.addedBy ?? 'user',
      lastRunAt: prev?.lastRunAt ?? null,
      lastError: prev?.lastError ?? null,
    });
  }
  return out;
}

/** MCP の set_app_launcher: 同じ名前があれば上書き、無ければ追加(addedBy 'claude') */
export function upsertLauncher(list: AppLauncher[], raw: unknown, by: 'user' | 'claude'): AppLauncher[] {
  const spec = validateLauncherSpec(raw);
  const i = list.findIndex((x) => sameLabel(x.label, spec.label));
  if (i >= 0) {
    const next = [...list];
    next[i] = { ...list[i], ...spec, lastError: null };
    return next;
  }
  if (list.length >= LAUNCHER_MAX) throw new HttpError(409, `ボタンは ${LAUNCHER_MAX} 個までです。不要なものを remove_app_launcher で消してください`);
  return [...list, { id: newId(), ...spec, addedBy: by, lastRunAt: null, lastError: null }];
}

/** 名前で取り除く(無ければ 404) */
export function removeLauncher(list: AppLauncher[], label: string): AppLauncher[] {
  const l = String(label ?? '').trim();
  if (!l) throw new HttpError(400, 'ボタンの名前(label)を指定してください');
  if (!list.some((x) => sameLabel(x.label, l))) throw new HttpError(404, `その名前のボタンはありません: ${l}`);
  return list.filter((x) => !sameLabel(x.label, l));
}

/** {cwd} をセッションの作業フォルダに置き換える */
export function expandCommand(command: string, cwd: string): string {
  return command.split('{cwd}').join(cwd);
}

/**
 * cmd.exe に渡す引数(windowsVerbatimArguments で、そのまま並べる)。
 * /s 付きの /c は「最初と最後の " だけを外して残りをそのまま実行」なので、全体を "…" で囲めば中の引用符は崩れない。
 * start の最初の "" はウィンドウのタイトル(省略するとコマンドの最初の引用部分がタイトルとして食われる)
 */
export function startArgs(commandLine: string): string[] {
  return ['/d', '/s', '/c', `"start "" ${commandLine}"`];
}

/** 起動に渡す環境変数: CLAUDE* / CLAUDECODE は取り除く(Claude Code の中から起動されたと誤認させない) */
export function launcherEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v == null || /^CLAUDE/i.test(k) || k.toUpperCase() === 'CLAUDECODE') continue;
    env[k] = v;
  }
  return env;
}

/**
 * コマンドを切り離して起動する。spawn の失敗と、LAUNCH_WATCH_MS 以内の 0 以外の終了(start が見つけられない など)はエラー文を返す。
 * 正常なら null
 */
export function spawnDetached(commandLine: string, cwd: string, watchMs = LAUNCH_WATCH_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (err: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(err);
    };
    const timer = setTimeout(() => finish(null), watchMs);
    let child;
    try {
      child = spawn(process.env.ComSpec || 'cmd.exe', startArgs(commandLine), {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        windowsVerbatimArguments: true,
        env: launcherEnv(),
      });
    } catch (e) {
      finish(`起動できませんでした: ${(e as Error).message}`);
      return;
    }
    child.once('error', (e) => finish(`起動できませんでした: ${e.message}`));
    child.once('exit', (code) => finish(code && code !== 0 ? `起動に失敗しました(終了コード ${code})。コマンドを確認してください` : null));
    child.unref();
  });
}

/** launchUnity の結果をユーザー / Claude 向けの文にする */
export function unityMessage(r: UnityStatus & { launched: boolean }): string {
  return r.launched
    ? `Unity ${r.editorVersion} でプロジェクトを開きました(PID ${r.runningPid})。読み込みが終わるまで少し待ってください。`
    : `このプロジェクトは既に Unity エディタで開いています(PID ${r.runningPid})。`;
}
