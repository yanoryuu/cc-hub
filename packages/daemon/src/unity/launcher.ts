// Unity エディタの起動: フォルダ(作業ツリー)の Unity プロジェクトを、ProjectVersion.txt のバージョンのエディタで開く。
// - エディタは Unity Hub の既定のインストール先(C:\Program Files\Unity\Hub\Editor\<version>)と Hub の追加インストール先から探す
// - 既にそのプロジェクトを開いているエディタがあれば、新しくは起動しない(同じプロジェクトを 2 つ開くと Unity が拒否する)
// - 起動したエディタは CC Hub から切り離す(CC Hub を再起動しても閉じない)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { UnityStatus } from '@cc-hub/shared';
import { HttpError } from '../util';
import { cleanEnv, run } from '../repo/exec';

const VERSION_FILE = path.join('ProjectSettings', 'ProjectVersion.txt');

/** cwd かその上位にある Unity プロジェクトのフォルダ(無ければ null) */
export function findUnityProject(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, VERSION_FILE)) && fs.existsSync(path.join(dir, 'Assets'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** ProjectVersion.txt の m_EditorVersion */
export function parseEditorVersion(text: string): string | null {
  const m = /^m_EditorVersion:\s*(\S+)/m.exec(text);
  return m ? m[1] : null;
}

/** エディタを探すフォルダ(<root>\<version>\Editor\Unity.exe) */
export function editorRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [path.join(env.ProgramFiles || 'C:\\Program Files', 'Unity', 'Hub', 'Editor')];
  // Unity Hub の「インストール先」を変えている場合
  try {
    const p = JSON.parse(fs.readFileSync(path.join(env.APPDATA || '', 'UnityHub', 'secondaryInstallPath.json'), 'utf8'));
    if (typeof p === 'string' && p.trim()) roots.push(p.trim());
  } catch {
    /* 無い */
  }
  return roots;
}

export function installedVersions(roots = editorRoots()): string[] {
  const out = new Set<string>();
  for (const r of roots) {
    try {
      for (const v of fs.readdirSync(r)) if (fs.existsSync(path.join(r, v, 'Editor', 'Unity.exe'))) out.add(v);
    } catch {
      /* 無い */
    }
  }
  return [...out].sort();
}

export function editorPath(version: string, roots = editorRoots()): string | null {
  for (const r of roots) {
    const exe = path.join(r, version, 'Editor', 'Unity.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

/** コマンドラインの -projectPath(Hub から開くと -projectpath と小文字) */
export function projectPathArg(cmdline: string): string | null {
  const m = /-projectpath\s+(?:"([^"]+)"|(\S+))/i.exec(cmdline);
  return m ? (m[1] ?? m[2]) : null;
}

const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

/** そのプロジェクトを開いている Unity エディタのプロセス ID(無ければ null) */
async function runningPid(project: string): Promise<number | null> {
  const r = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='Unity.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
    ],
    { timeout: 20_000 },
  );
  for (const line of r.stdout.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const arg = projectPathArg(line.slice(tab + 1));
    if (arg && norm(arg) === norm(project)) return Number(line.slice(0, tab)) || null;
  }
  return null;
}

export async function unityStatus(cwd: string): Promise<UnityStatus> {
  const project = findUnityProject(cwd);
  if (!project) throw new HttpError(404, `Unity のプロジェクトではありません(ProjectSettings/ProjectVersion.txt が見つかりません): ${cwd}`);
  const version = parseEditorVersion(fs.readFileSync(path.join(project, VERSION_FILE), 'utf8'));
  const exe = version ? editorPath(version) : null;
  return {
    projectPath: project,
    editorVersion: version,
    editorPath: exe,
    installedVersions: installedVersions(),
    runningPid: await runningPid(project),
  };
}

/** エディタで開く。既に開いていればそのまま返す */
export async function launchUnity(cwd: string): Promise<UnityStatus & { launched: boolean }> {
  const st = await unityStatus(cwd);
  if (st.runningPid) return { ...st, launched: false };
  if (!st.editorVersion) throw new HttpError(409, 'ProjectVersion.txt にエディタのバージョンが書かれていません');
  if (!st.editorPath) {
    throw new HttpError(
      409,
      `Unity ${st.editorVersion} がインストールされていません。Unity Hub でインストールしてください` +
        (st.installedVersions.length ? `(インストール済み: ${st.installedVersions.join(', ')})` : ''),
    );
  }
  const child = spawn(st.editorPath, ['-projectPath', st.projectPath], {
    cwd: st.projectPath,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: cleanEnv(),
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', (e) => reject(new HttpError(500, `Unity を起動できませんでした: ${e.message}`)));
    child.once('spawn', () => resolve());
  });
  child.unref();
  console.log(`[unity] 起動: ${st.projectPath} (Unity ${st.editorVersion}, PID ${child.pid})`);
  return { ...st, runningPid: child.pid ?? null, launched: true };
}
