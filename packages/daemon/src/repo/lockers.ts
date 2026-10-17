// worktree のフォルダをつかんでいるプロセス(開いたままの Unity エディタ、残った tail など)を探す。
// 削除・初期化の前に知らせるために使う。判定はコマンドラインにフォルダのパスが含まれるかで行う
// (カレントディレクトリだけでつかんでいるプロセスは Windows では外から分からないので対象外)
import type { WorktreeLocker } from '@cc-hub/shared';
import { run } from './exec';

export interface ProcRow {
  pid: number;
  name: string;
  cmd: string;
  title: string;
}

/** 比較用: 小文字・区切りを / に・末尾の / を取る */
function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Claude Code が作業フォルダから作る名前(D:\WorkTree\X\wt-01 → d--worktree-x-wt-01) */
function encoded(dir: string): string {
  return dir.replace(/[:\\/]/g, '-').replace(/-+$/, '').toLowerCase();
}

/** s の中に needle が「区切りで終わる形」で含まれるか(wt-1 が wt-10 に当たらないように) */
function containsPath(s: string, needle: string): boolean {
  let i = s.indexOf(needle);
  while (i >= 0) {
    const next = s.charAt(i + needle.length);
    if (next === '' || next === '/' || next === '"' || next === "'" || /\s/.test(next)) return true;
    i = s.indexOf(needle, i + 1);
  }
  return false;
}

function describe(p: ProcRow): Pick<WorktreeLocker, 'kind' | 'label'> {
  const name = p.name.toLowerCase();
  if (name === 'unity.exe') {
    if (/-batchmode/i.test(p.cmd) || /AssetImportWorker/i.test(p.cmd)) {
      return { kind: 'unity_worker', label: 'Unity のアセット取り込み(エディタの子プロセス)' };
    }
    return { kind: 'unity', label: p.title ? `Unity エディタ「${p.title}」` : 'Unity エディタ' };
  }
  return { kind: 'process', label: p.title ? `${p.name}「${p.title}」` : p.name };
}

/** プロセス一覧から dir をつかんでいそうなものを選ぶ(純粋関数。テスト用に公開) */
export function matchLockers(procs: ProcRow[], dir: string, selfPid = process.pid): WorktreeLocker[] {
  const plain = norm(dir);
  const enc = encoded(dir);
  const out: WorktreeLocker[] = [];
  for (const p of procs) {
    // Unity Hub は起動したプロジェクトのパスを引数に持ち続けるが、フォルダはつかまない
    if (p.pid === selfPid || !p.cmd || /^unity hub\.exe$/i.test(p.name)) continue;
    const cmd = p.cmd.replace(/\\/g, '/').toLowerCase();
    if (!containsPath(cmd, plain) && !containsPath(cmd, enc)) continue;
    out.push({ pid: p.pid, name: p.name, title: p.title || null, ...describe(p) });
  }
  // エディタ本体を先に
  const rank = { unity: 0, unity_worker: 1, process: 2 } as const;
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.pid - b.pid);
}

const PS_SCRIPT = [
  '$t = @{}',
  'Get-Process | ForEach-Object { if ($_.MainWindowTitle) { $t[[int]$_.Id] = $_.MainWindowTitle } }',
  'Get-CimInstance Win32_Process | ForEach-Object {',
  '  [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; cmd = [string]$_.CommandLine; title = [string]$t[[int]$_.ProcessId] }',
  '} | ConvertTo-Json -Compress',
].join('\n');

/** 動いているプロセスの一覧(読めなければ null) */
export async function listProcesses(): Promise<ProcRow[] | null> {
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${PS_SCRIPT}`], {
    timeout: 20_000,
  });
  if (r.code !== 0 || !r.stdout.trim()) return null;
  try {
    const v = JSON.parse(r.stdout) as ProcRow | ProcRow[];
    return Array.isArray(v) ? v : [v];
  } catch {
    return null;
  }
}

/** dir をつかんでいるプロセス(調べられなければ null) */
export async function findLockers(dir: string): Promise<WorktreeLocker[] | null> {
  const procs = await listProcesses();
  return procs ? matchLockers(procs, dir) : null;
}

/** 削除できない理由の一文 */
export function lockerMessage(lockers: WorktreeLocker[]): string {
  const hasUnity = lockers.some((l) => l.kind === 'unity' || l.kind === 'unity_worker');
  const names = lockers.map((l) => `${l.label}(PID ${l.pid})`).join('、');
  return hasUnity
    ? `Unity で開いたままです。Unity を保存して閉じてから実行してください: ${names}`
    : `このフォルダを使っているプログラムがあります。終了してから実行してください: ${names}`;
}
