// ブランチ一覧とマージ済みブランチの掃除(F5-1)。.base の refs を読む(worktree と refs は共有)。
// - 一覧の前に git fetch --prune(ミューテックス内、30 秒以内なら省略)
// - リモートブランチは消さない。ローカルブランチの削除は「マージ済み かつ どの worktree でもチェックアウトされていない」ものだけ
import type { BranchInfo, PrInfo, RepoInfo, SessionInfo, WorktreeInfo } from '@cc-hub/shared';
import { HttpError } from '../util';
import { git, gitOk, tail } from './exec';
import { baseOf, type WorktreePool } from './pool';

const MAX_BRANCHES = 300;
const PARALLEL = 8;

interface RefRow {
  name: string;
  sha: string;
  subject: string;
  author: string;
  date: number;
  upstream: string;
}

export interface BranchDeps {
  pool: WorktreePool;
  sessions: () => Record<string, SessionInfo>;
  prs: () => PrInfo[];
}

/** for-each-ref の出力(フィールドは \x1f 区切り) */
export function parseRefs(out: string): { local: Map<string, RefRow>; remote: Map<string, RefRow> } {
  const local = new Map<string, RefRow>();
  const remote = new Map<string, RefRow>();
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ref, sha, subject, author, date, upstream] = line.split('\x1f');
    const row = (name: string): RefRow => ({ name, sha, subject: subject ?? '', author: author ?? '', date: Number(date) * 1000 || 0, upstream: upstream ?? '' });
    if (ref.startsWith('refs/heads/')) local.set(ref.slice(11), row(ref.slice(11)));
    else if (ref.startsWith('refs/remotes/origin/')) {
      const n = ref.slice(20);
      if (n !== 'HEAD') remote.set(n, row(n));
    }
  }
  return { local, remote };
}

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

async function count(base: string, range: string): Promise<number> {
  const r = await git(['-C', base, 'rev-list', '--count', range], { timeout: 30_000 });
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

/** git worktree list --porcelain でチェックアウト中のブランチ名 */
async function checkedOut(base: string): Promise<Set<string>> {
  const r = await git(['-C', base, 'worktree', 'list', '--porcelain']);
  const out = new Set<string>();
  for (const line of r.stdout.split(/\r?\n/)) if (line.startsWith('branch refs/heads/')) out.add(line.slice(18).trim());
  return out;
}

export async function listBranches(repo: RepoInfo, d: BranchDeps): Promise<BranchInfo[]> {
  const base = baseOf(repo);
  try {
    await d.pool.fetchBase(repo.id);
  } catch (e) {
    console.warn(`[branches] ${repo.id}: fetch に失敗(手元の情報で表示します): ${(e as Error).message}`);
  }
  const fmt = ['%(refname)', '%(objectname)', '%(subject)', '%(authorname)', '%(committerdate:unix)', '%(upstream:short)'].join('%1f');
  const out = await gitOk(['-C', base, 'for-each-ref', `--format=${fmt}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes/origin']);
  const { local, remote } = parseRefs(out);
  const names = [...new Set([...local.keys(), ...remote.keys()])].slice(0, MAX_BRANCHES);
  const def = `origin/${repo.defaultBranch}`;

  const wts = d.pool.forRepo(repo.id);
  const sessions = Object.values(d.sessions()).filter((s) => s.repoId === repo.id);
  const prs = d.prs().filter((p) => p.repoId === repo.id);

  const list = await mapLimit(names, PARALLEL, async (name): Promise<BranchInfo> => {
    const l = local.get(name);
    const r = remote.get(name);
    const ref = l ? `refs/heads/${name}` : `refs/remotes/origin/${name}`;
    const lr = await git(['-C', base, 'rev-list', '--left-right', '--count', `${def}...${ref}`], { timeout: 30_000 });
    const m = /(\d+)\s+(\d+)/.exec(lr.stdout);
    const behind = m ? Number(m[1]) : 0;
    const ahead = m ? Number(m[2]) : 0;
    let unpushed = 0;
    if (l) {
      // upstream が既定ブランチ(switch -c で自動設定)なら無いものとみなす
      const up = l.upstream && l.upstream !== def ? l.upstream : r ? `origin/${name}` : '';
      unpushed = up ? await count(base, `${up}..refs/heads/${name}`) : ahead;
    }
    const top = l ?? r!;
    const wt = wts.find((w) => w.branch === name && w.state === 'assigned') ?? null;
    const sess =
      (wt?.sessionId ? sessions.find((s) => s.id === wt.sessionId) : undefined) ??
      sessions.filter((s) => s.branch === name).sort((a, b) => b.lastEventAt - a.lastEventAt)[0];
    const pr =
      prs
        .filter((p) => p.headRefName === name)
        .sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.updatedAt - a.updatedAt)[0] ?? null;
    const isDefault = name === repo.defaultBranch;
    return {
      repoId: repo.id,
      name,
      isLocal: !!l,
      hasRemote: !!r,
      ahead,
      behind,
      unpushed,
      lastCommit: { sha: top.sha, subject: top.subject, author: top.author, date: top.date },
      // squash マージは ahead が残るので、PR が MERGED なら マージ済みとする
      merged: !isDefault && (ahead === 0 || pr?.state === 'MERGED'),
      worktreeId: wt?.id ?? null,
      sessionId: sess?.id ?? null,
      prNumber: pr?.number ?? null,
    };
  });
  return list.sort((a, b) => b.lastCommit.date - a.lastCommit.date);
}

/** マージ済みのローカルブランチを削除する。条件を満たさないものが 1 つでもあれば何もせず 409 */
export async function cleanupBranches(repo: RepoInfo, names: unknown, d: BranchDeps): Promise<{ deleted: string[] }> {
  if (!Array.isArray(names) || !names.length) throw new HttpError(400, 'names(ブランチ名の配列)を指定してください');
  const want = [...new Set(names.map((x) => String(x).trim()).filter(Boolean))];
  const branches = await listBranches(repo, d);
  const base = baseOf(repo);
  return d.pool.withLock(repo.id, async () => {
    const out = await checkedOut(base);
    // プールの worktree が使っているブランチも除外(detached 中でも sessions が持っている場合に備えて)
    const held = new Set<string>(d.pool.forRepo(repo.id).filter((w: WorktreeInfo) => w.state === 'assigned' && w.branch).map((w) => w.branch!));
    const bad: string[] = [];
    for (const n of want) {
      const b = branches.find((x) => x.name === n);
      if (!b || !b.isLocal) bad.push(`${n}(ローカルブランチがありません)`);
      else if (!b.merged) bad.push(`${n}(マージされていません)`);
      else if (out.has(n) || held.has(n)) bad.push(`${n}(worktree で使用中です)`);
    }
    if (bad.length) throw new HttpError(409, `削除できないブランチがあります: ${bad.join(', ')}`);
    const deleted: string[] = [];
    for (const n of want) {
      // squash マージはコミットが既定ブランチに含まれないため -D(マージ済みかどうかは上で確認済み)
      const r = await git(['-C', base, 'branch', '-D', n]);
      if (r.code !== 0) throw new HttpError(500, `${n} の削除に失敗しました: ${tail(r)}`);
      deleted.push(n);
    }
    console.log(`[branches] ${repo.id}: ローカルブランチを削除しました: ${deleted.join(', ')}`);
    return { deleted };
  });
}

