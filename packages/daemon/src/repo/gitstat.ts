// GitStatWatcher: 使用中(assigned)の worktree の変更状況(WorktreeInfo.git)を数秒ごとに更新する(design §8 GitWatcher)。
// - fs.watch(.git / node_modules / Library は無視)で変更を検知して 1.5 秒デバウンス + 5 秒ごとの定期更新
//   (コミットは worktree のファイルを変えない = .base 側の gitdir だけが変わるため、定期更新が必要)
// - 読み取りだけなのでミューテックスは使わない(fetch はしない)
// - 値が変わったときだけ worktree.upsert を配信する
import fs from 'node:fs';
import type { RepoInfo, ServerMessage, WorktreeGitStat } from '@cc-hub/shared';
import { bus } from '../bus';
import type { WorktreeRow } from '../store/db';
import { git } from './exec';
import type { WorktreePool } from './pool';

const INTERVAL_MS = 5_000;
const DEBOUNCE_MS = 1_500;
const IGNORE_RE = /^(\.git|node_modules|Library|\.cc-hub)([\\/]|$)/i;

interface Watch {
  path: string;
  watcher: fs.FSWatcher | null;
  timer: NodeJS.Timeout | null;
  running: boolean;
  again: boolean;
}

/** git status --porcelain=v2 -b の出力 → 変更ファイル数と upstream */
export function parseStatusV2(out: string): { changed: number; upstream: string | null; head: string | null } {
  let changed = 0;
  let upstream: string | null = null;
  let head: string | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('# branch.upstream ')) upstream = line.slice(18).trim();
    else if (line.startsWith('# branch.head ')) head = line.slice(14).trim();
    else if (!line.startsWith('#')) changed++;
  }
  return { changed, upstream, head };
}

/** git diff --shortstat → 追加 / 削除行数 */
export function parseShortstat(out: string): { insertions: number; deletions: number } {
  const ins = /(\d+) insertions?\(\+\)/.exec(out);
  const del = /(\d+) deletions?\(-\)/.exec(out);
  return { insertions: ins ? Number(ins[1]) : 0, deletions: del ? Number(del[1]) : 0 };
}

/** rev-list --left-right --count A...B → [左だけ, 右だけ] */
export function parseLeftRight(out: string): [number, number] {
  const m = /(\d+)\s+(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

/**
 * worktree の変更状況を取る。
 * upstream が origin/<default> のとき(switch -c で自動設定された古い worktree)は「未 push」とみなす。
 */
export async function computeGitStat(wtPath: string, defaultBranch: string, branch: string | null): Promise<WorktreeGitStat | null> {
  const base = `origin/${defaultBranch}`;
  const [st, lr, mb] = await Promise.all([
    git(['-C', wtPath, 'status', '--porcelain=v2', '-b'], { timeout: 30_000 }),
    git(['-C', wtPath, 'rev-list', '--left-right', '--count', `${base}...HEAD`], { timeout: 30_000 }),
    git(['-C', wtPath, 'merge-base', base, 'HEAD'], { timeout: 30_000 }),
  ]);
  if (st.code !== 0) return null;
  const s = parseStatusV2(st.stdout);
  const [behind, ahead] = lr.code === 0 ? parseLeftRight(lr.stdout) : [0, 0];
  // base からの差分(コミット済み + 作業ツリー。未追跡は含まない)
  let insertions = 0;
  let deletions = 0;
  if (mb.code === 0 && mb.stdout.trim()) {
    const d = await git(['-C', wtPath, 'diff', '--shortstat', mb.stdout.trim()], { timeout: 30_000 });
    if (d.code === 0) ({ insertions, deletions } = parseShortstat(d.stdout));
  }
  const br = branch || (s.head && s.head !== '(detached)' ? s.head : null);
  let up: string | null = s.upstream && s.upstream !== base ? s.upstream : null;
  if (!up && br) {
    const r = await git(['-C', wtPath, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${br}`], { timeout: 30_000 });
    if (r.code === 0) up = `origin/${br}`;
  }
  let unpushed = ahead;
  if (up) {
    const r = await git(['-C', wtPath, 'rev-list', '--count', `${up}..HEAD`], { timeout: 30_000 });
    if (r.code === 0) unpushed = Number(r.stdout.trim()) || 0;
  }
  return { changed: s.changed, insertions, deletions, ahead, behind, unpushed, pushed: !!up, updatedAt: Date.now() };
}

function sameStat(a: WorktreeGitStat | null | undefined, b: WorktreeGitStat | null): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.changed === b.changed &&
    a.insertions === b.insertions &&
    a.deletions === b.deletions &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.unpushed === b.unpushed &&
    a.pushed === b.pushed
  );
}

export class GitStatWatcher {
  private readonly watches = new Map<string, Watch>();
  private timer: NodeJS.Timeout | null = null;
  private readonly onBus = (msg: ServerMessage) => {
    // assigned でなくなった worktree の監視はすぐ止める(ディレクトリのハンドルが削除を妨げないように)
    if (msg.t === 'worktree.upsert' && msg.worktree.state !== 'assigned') this.unwatch(msg.worktree.id);
    else if (msg.t === 'worktree.remove') this.unwatch(msg.id);
  };

  constructor(
    private readonly pool: WorktreePool,
    private readonly getRepo: (id: string) => RepoInfo | undefined,
  ) {}

  start(): void {
    bus.on('state', this.onBus);
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
    this.timer.unref();
    this.tick();
  }

  stop(): void {
    bus.off('state', this.onBus);
    if (this.timer) clearInterval(this.timer);
    for (const id of [...this.watches.keys()]) this.unwatch(id);
  }

  /** 定期処理: assigned の worktree を監視対象にそろえ、全部更新する */
  private tick(): void {
    const assigned = new Map<string, WorktreeRow>();
    for (const info of this.pool.list()) {
      if (info.state !== 'assigned' || info.progress) continue; // 割り当て中(ブランチ作成中)は待つ
      const w = this.pool.get(info.id);
      if (w) assigned.set(w.id, w);
    }
    for (const id of [...this.watches.keys()]) if (!assigned.has(id)) this.unwatch(id);
    for (const w of assigned.values()) {
      if (!this.watches.has(w.id)) this.watch(w);
      void this.refresh(w.id);
    }
  }

  private watch(w: WorktreeRow): void {
    const entry: Watch = { path: w.path, watcher: null, timer: null, running: false, again: false };
    this.watches.set(w.id, entry);
    try {
      entry.watcher = fs.watch(w.path, { recursive: true, persistent: false }, (_ev, file) => {
        if (file && IGNORE_RE.test(String(file))) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = null;
          void this.refresh(w.id);
        }, DEBOUNCE_MS);
      });
      entry.watcher.on('error', () => {
        entry.watcher?.close();
        entry.watcher = null; // 定期更新だけで続ける
      });
    } catch {
      entry.watcher = null;
    }
  }

  private unwatch(id: string): void {
    const e = this.watches.get(id);
    if (!e) return;
    this.watches.delete(id);
    if (e.timer) clearTimeout(e.timer);
    try {
      e.watcher?.close();
    } catch {
      /* 無視 */
    }
  }

  /** 1 本更新する(同時に 1 回だけ。実行中に呼ばれたら終わってからもう 1 回) */
  async refresh(id: string): Promise<void> {
    const e = this.watches.get(id);
    if (!e) return;
    if (e.running) {
      e.again = true;
      return;
    }
    e.running = true;
    try {
      do {
        e.again = false;
        const w = this.pool.get(id);
        if (!w || w.state !== 'assigned') return;
        const repo = this.getRepo(w.repoId);
        if (!repo || !fs.existsSync(w.path)) return;
        const stat = await computeGitStat(w.path, repo.defaultBranch, w.branch).catch(() => null);
        const cur = this.pool.get(id);
        if (!stat || !cur || cur.state !== 'assigned') return;
        if (!sameStat(cur.git, stat)) this.pool.setGitStat(id, stat);
      } while (e.again);
    } finally {
      e.running = false;
    }
  }
}
