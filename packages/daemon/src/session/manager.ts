// SessionManager: N 個の claude セッション(PTY)と、外部セッション(読み取り専用)の状態を管理する。
// 状態判定の主な情報源は hooks(design §4.3)。画面解析(ApprovalDetector)は承認の選択肢作成と保険。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  NotifyKind,
  ReleaseMode,
  SessionInfo,
  SessionMode,
  SessionStatus,
  StartSessionRequest,
} from '@cc-hub/shared';
import { bus } from '../bus';
import { emitNotify } from '../notify/emit';
import { dataDir, type HubConfig } from '../config';

// 終了したセッションの最後の画面(デーモン再起動後も「どう終わったか」を見られるように保存する)
const SCREEN_MAX_BYTES = 512 * 1024;
function screenFile(id: string): string {
  return path.join(dataDir(), 'screens', `${id.replace(/[^0-9a-zA-Z-]/g, '')}.ans`);
}
function saveScreen(id: string, data: string): void {
  try {
    const f = screenFile(id);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data.length > SCREEN_MAX_BYTES ? data.slice(-SCREEN_MAX_BYTES) : data);
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}
function loadScreen(id: string): string | null {
  try {
    return fs.readFileSync(screenFile(id), 'utf8');
  } catch {
    return null;
  }
}
import type { Store, SessionRow } from '../store/db';
import type { AgentTree } from '../agents/tree';
import type { UsageTracker } from '../usage';
import { findTranscript } from '../history';
import { HttpError, activeBackgroundTasks, clampInt, taskText, toolTarget } from '../util';
import { TranscriptTail, combineTokens } from './tokens';
import { PtyHost } from './pty-host';
import { approvalKeys, detectApproval, type DetectedApproval } from './approval';
import { buildTerminalArgv, launchTerminal, terminalEnv, type TerminalSpec } from './terminal';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** バックグラウンド待機にしたまま何も起きなければ「入力待ち」に戻すまでの時間 */
const BG_SETTLE_MS = 20000;

interface Entry {
  info: SessionInfo;
  host: PtyHost | null;
  /** 画面解析で検出した承認(numbered 等の内部情報付き) */
  detected: DetectedApproval | null;
  /** 承認待ちになる直前の状態(承認が消えたら戻す) */
  statusBeforeApproval: SessionStatus | null;
  endedAt: number | null;
  userStopped: boolean;
  restartPending: boolean;
  detectTimer: NodeJS.Timeout | null;
  lastNotify: Map<NotifyKind, number>;
  /** /clear・compact などで変わった claude 側の session_id(--resume に使う)。null = info.id と同じ */
  claudeId: string | null;
  /** フェーズ 2: worktree の割当・ブランチ作成中(まだ PTY を起動していない) */
  preparing: boolean;
  /** 信頼ダイアログに自動で答えた(起動ごとに 1 回だけ) */
  trustAnswered: boolean;
  /** PowerShell へ移している最中(PTY の停止 → ウィンドウ起動) */
  handingOff: boolean;
  /** PowerShell に移した時刻(止めた PTY の遅れて届く SessionEnd を無視するため) */
  handoffAt: number | null;
  /** PTY の終了を待っている処理 */
  exitWaiters: (() => void)[];
  /** トークン集計: statusLine の累計(メイン会話)。届いていなければ null */
  slTokens: { input: number; output: number } | null;
  /** トークン集計: transcript の追記読み(必要になったら作る) */
  tail: TranscriptTail | null;
  /** これまでに使われた claude 側の session_id(/clear 前の transcript も集計に含める) */
  claudeIds: Set<string>;
  tokenTimer: NodeJS.Timeout | null;
  tokenLastAt: number;
  tokenRunning: boolean;
}

/** トークン使用量の更新(transcript の読み込み + 配信)の最短間隔 */
const TOKEN_INTERVAL_MS = 2000;

/** PowerShell に移したセッションが、まだ向こうで動いているとみなす状態 */
const HANDED_OFF_LIVE: SessionStatus[] = ['starting', 'running', 'awaiting_approval', 'awaiting_input', 'idle'];

/** リポジトリ / worktree プール側への問い合わせ(RepoManager が実装する) */
export interface RepoHooks {
  /** cwd が「信頼済みリポジトリ」のプール worktree か(信頼ダイアログの自動応答に使う) */
  isTrustedPath(cwd: string): boolean;
  /** そのセッションがまだ worktree を確保しているか(解放済みなら false) */
  holdsWorktree(info: SessionInfo): boolean;
}

export interface PendingStart {
  name: string;
  mode: SessionMode;
  repoId: string;
  /** 最初の指示(SessionInfo.task 用) */
  task?: string;
  /** 仮の cwd(worktree が決まるまではリポジトリの baseDir) */
  cwd: string;
}

export class SessionManager {
  private readonly sessions = new Map<string, Entry>();
  /** claude 側の session_id → ハブのセッション ID(/clear 後の新しい session_id の hooks を同じセッションに紐付ける) */
  private readonly aliases = new Map<string, string>();
  private shuttingDown = false;
  private repoHooks: RepoHooks | null = null;
  /** プロジェクトの共通の指示ファイル(--append-system-prompt-file に渡す)。無ければ null */
  private instructionsFor: ((info: SessionInfo) => string | null) | null = null;
  /** cwd → 登録リポジトリ(linkedDirs の中なら)。RepoManager が設定する */
  private repoForCwd: ((cwd: string) => string | null) | null = null;

  constructor(
    private readonly cfg: HubConfig,
    private readonly store: Store,
    private readonly agents: AgentTree,
    private readonly usage: UsageTracker,
  ) {}

  setRepoHooks(h: RepoHooks): void {
    this.repoHooks = h;
  }

  setInstructionsResolver(fn: (info: SessionInfo) => string | null): void {
    this.instructionsFor = fn;
  }

  setRepoResolver(fn: (cwd: string) => string | null): void {
    this.repoForCwd = fn;
  }

  private resolveRepo(cwd: string): string | null {
    if (!cwd || !this.repoForCwd) return null;
    try {
      return this.repoForCwd(cwd);
    } catch {
      return null;
    }
  }

  /** 既存のセッションを登録リポジトリに紐付ける(再スキャン)。紐付けたら true */
  linkRepo(id: string, repoId: string, branch: string | null): boolean {
    const e = this.sessions.get(id);
    if (!e || e.info.repoId) return false;
    e.info.repoId = repoId;
    if (!e.info.branch && branch) e.info.branch = branch;
    this.touch(e);
    return true;
  }

  /** プロジェクトの共通の指示を渡す引数(指示が無ければ空) */
  private instructionArgs(info: SessionInfo): string[] {
    let f: string | null = null;
    try {
      f = this.instructionsFor?.(info) ?? null;
    } catch (err) {
      console.warn(`[session] 共通の指示を探せませんでした: ${(err as Error).message}`);
    }
    return f ? ['--append-system-prompt-file', f] : [];
  }

  // ================================================================ 状態
  all(): Record<string, SessionInfo> {
    const out: Record<string, SessionInfo> = {};
    for (const [id, e] of this.sessions) out[id] = { ...e.info };
    return out;
  }

  get(id: string): Entry | undefined {
    return this.sessions.get(id);
  }

  info(id: string): SessionInfo | undefined {
    const e = this.sessions.get(id);
    return e ? { ...e.info } : undefined;
  }

  /** ハブ ID か claude 側の session_id からセッションを引く */
  private lookup(id: string): Entry | undefined {
    if (!id) return undefined;
    const e = this.sessions.get(id);
    if (e) return e;
    const hub = this.aliases.get(id);
    return hub ? this.sessions.get(hub) : undefined;
  }

  /** PTY が動いている、または起動準備中か(worktree の解放可否の判定に使う) */
  isRunning(id: string): boolean {
    const e = this.sessions.get(id);
    return !!e && (e.preparing || e.handingOff || !!e.host?.alive || this.handedOffLive(e));
  }

  /** PowerShell に移したセッションがまだ向こうで動いているか(SessionEnd が届くまで) */
  private handedOffLive(e: Entry): boolean {
    return !!e.info.handedOff && !e.info.managed && HANDED_OFF_LIVE.includes(e.info.status);
  }

  /** PowerShell に移したまま動いているセッションか(解放できない理由の表示用) */
  isHandedOffLive(id: string): boolean {
    const e = this.sessions.get(id);
    return !!e && this.handedOffLive(e);
  }

  /** --resume に使う claude 側の session_id */
  private resumeId(e: Entry): string {
    // /clear 直後で新しい会話に何も送っていない場合は transcript が無いので、元の ID で再開する
    if (e.claudeId && (findTranscript(e.claudeId) || !findTranscript(e.info.id))) return e.claudeId;
    return e.info.id;
  }

  /** 会話を写して横から質問するときの --resume の ID(会話の記録が無ければ null) */
  resumeIdFor(id: string): string | null {
    const e = this.sessions.get(id);
    if (!e) return null;
    const rid = this.resumeId(e);
    return findTranscript(rid) ? rid : null;
  }

  private require(id: string): Entry {
    const e = this.sessions.get(id);
    if (!e) throw new HttpError(404, 'セッションが見つかりません');
    return e;
  }

  private requireManaged(id: string): Entry {
    const e = this.require(id);
    if (!e.info.managed) throw new HttpError(409, '外部セッションは読み取り専用です');
    return e;
  }

  /** 変更を配信して保存する */
  private touch(e: Entry, persist = true): void {
    if (persist) this.store.saveSession(e.info, e.endedAt, e.claudeId, this.tokensJson(e));
    bus.state({ t: 'session.upsert', session: { ...e.info } });
  }

  private newEntry(info: SessionInfo): Entry {
    return {
      info,
      host: null,
      detected: null,
      statusBeforeApproval: null,
      endedAt: null,
      userStopped: false,
      restartPending: false,
      detectTimer: null,
      lastNotify: new Map(),
      claudeId: null,
      preparing: false,
      trustAnswered: false,
      handingOff: false,
      handoffAt: null,
      exitWaiters: [],
      slTokens: null,
      tail: null,
      claudeIds: new Set([info.id]),
      tokenTimer: null,
      tokenLastAt: 0,
      tokenRunning: false,
    };
  }

  private blankInfo(id: string, name: string, cwd: string, managed: boolean): SessionInfo {
    const now = Date.now();
    return {
      id,
      name,
      cwd,
      mode: 'plain',
      managed,
      status: managed ? 'starting' : 'running',
      createdAt: now,
      lastEventAt: now,
      currentTool: null,
      lastMessage: null,
      contextPct: null,
      costUsd: null,
      model: null,
      permissionMode: null,
      approval: null,
      cols: managed ? DEFAULT_COLS : 0,
      rows: managed ? DEFAULT_ROWS : 0,
      exitCode: null,
      repoId: this.resolveRepo(cwd),
      worktreeId: null,
      branch: null,
      handedOff: false,
    };
  }

  // ================================================================ 起動時の復元
  /** SQLite から復元し、前回実行中だった managed セッションを --resume で再開する */
  restore(): void {
    const now = Date.now();
    for (const r of this.store.loadSessions()) {
      const info = this.rowToInfo(r);
      const e = this.newEntry(info);
      e.endedAt = r.ended_at;
      if (r.claude_session_id && r.claude_session_id !== info.id) {
        e.claudeId = r.claude_session_id;
        e.claudeIds.add(e.claudeId);
        this.aliases.set(e.claudeId, info.id);
      }
      if (r.tokens_json) {
        try {
          const j = JSON.parse(r.tokens_json);
          if (j?.tokens && typeof j.tokens === 'object') info.tokens = j.tokens;
          if (j?.sl && Number.isFinite(j.sl.input) && Number.isFinite(j.sl.output)) e.slTokens = { input: j.sl.input, output: j.sl.output };
        } catch {
          /* 壊れていたら無視(次の更新で取り直す) */
        }
      }
      this.sessions.set(info.id, e);
      if (info.managed) {
        if (r.ended_at == null) {
          // デーモン停止で PTY ごと落ちたセッション
          if (this.cfg.autoResume && findTranscript(this.resumeId(e)) && fs.existsSync(info.cwd)) {
            info.status = 'starting';
            info.approval = null;
            info.currentTool = null;
            try {
              this.spawn(e, { resume: true });
              this.touch(e);
              console.log(`[session] 自動再開: ${info.name} (${info.id})`);
            } catch (err) {
              this.markEnded(e, 'error', null);
              console.error(`[session] 自動再開に失敗: ${info.id}`, (err as Error).message);
            }
          } else {
            this.markEnded(e, 'stopped', null);
          }
        }
      } else if (info.status !== 'stopped' && now - info.lastEventAt > 6 * 3600_000) {
        // 長時間イベントの無い外部セッションは終わったものとみなす
        info.status = 'stopped';
        e.endedAt = now;
        this.store.saveSession(info, e.endedAt, e.claudeId);
      }
      // 実行中のまま残ったエージェントは閉じる(PTY が落ちているため)
      if (info.managed || info.status === 'stopped') this.agents.finishSession(info.id);
    }
  }

  private rowToInfo(r: SessionRow): SessionInfo {
    const info = this.blankInfo(r.id, r.name, r.cwd, !!r.managed);
    Object.assign(info, {
      mode: r.mode,
      status: r.status,
      createdAt: r.created_at,
      lastEventAt: r.last_event_at,
      contextPct: r.context_pct,
      costUsd: r.cost_usd,
      model: r.model,
      permissionMode: r.permission_mode,
      lastMessage: r.last_message,
      exitCode: r.exit_code,
      repoId: r.repo_id ?? info.repoId,
      worktreeId: r.worktree_id ?? null,
      branch: r.branch ?? null,
      handedOff: !!r.handed_off && !r.managed,
      task: r.task ?? null,
    });
    return info;
  }

  // ================================================================ 起動
  start(req: StartSessionRequest): SessionInfo {
    const cwd = path.resolve(String(req.cwd || ''));
    if (!req.cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new HttpError(400, `ディレクトリが存在しません: ${req.cwd ?? ''}`);
    }
    const mode = req.mode === 'commander' ? 'commander' : 'plain';
    const name = String(req.name || '').trim() || path.basename(cwd) || cwd;
    if (req.resume) {
      if (!UUID_RE.test(req.resume)) throw new HttpError(400, 'resume には session_id(UUID)を指定してください');
      const existing = this.lookup(req.resume);
      if (existing && this.isRunning(existing.info.id)) throw new HttpError(409, 'そのセッションは既に実行中です');
      if (existing && existing.info.worktreeId && this.repoHooks && !this.repoHooks.holdsWorktree(existing.info)) {
        throw new HttpError(409, 'このセッションの worktree は解放済みです');
      }
      const info = existing?.info ?? this.blankInfo(req.resume, name, cwd, true);
      const e = existing ?? this.newEntry(info);
      // worktree のセッションは cwd を変えない
      const keepCwd = !!existing?.info.worktreeId;
      Object.assign(info, { managed: true, handedOff: false, cwd: keepCwd ? info.cwd : cwd, mode, status: 'starting', exitCode: null, approval: null, currentTool: null });
      if (req.name) info.name = name;
      if (!info.task) info.task = taskText(req.instruction);
      e.endedAt = null;
      e.userStopped = false;
      this.sessions.set(info.id, e);
      this.spawn(e, { resume: true, prompt: this.buildPrompt(mode, cwd, req.instruction) });
      this.touch(e);
      return { ...info };
    }
    const id = crypto.randomUUID();
    const info = this.blankInfo(id, name, cwd, true);
    info.mode = mode;
    info.permissionMode = this.cfg.permissionMode;
    // commander でも保存するのは指示の本文だけ(/commander は付けない)
    info.task = taskText(req.instruction);
    const e = this.newEntry(info);
    this.sessions.set(id, e);
    try {
      this.spawn(e, { resume: false, prompt: this.buildPrompt(mode, cwd, req.instruction) });
    } catch (err) {
      this.sessions.delete(id);
      throw new HttpError(500, `claude の起動に失敗しました: ${(err as Error).message}`);
    }
    this.touch(e);
    return { ...info };
  }

  // ================================================================ フェーズ 2: worktree での起動
  /** worktree の割当前にセッションだけ作る(状態 starting。ターミナルには準備の進捗を出す) */
  createPending(o: PendingStart): SessionInfo {
    const id = crypto.randomUUID();
    const info = this.blankInfo(id, o.name, o.cwd, true);
    info.mode = o.mode;
    info.repoId = o.repoId;
    info.permissionMode = this.cfg.permissionMode;
    info.task = taskText(o.task);
    const e = this.newEntry(info);
    e.preparing = true;
    e.host = new PtyHost(DEFAULT_COLS, DEFAULT_ROWS);
    this.sessions.set(id, e);
    this.touch(e);
    return { ...info };
  }

  /** 準備中の進捗をターミナルに出す */
  progress(id: string, text: string): void {
    const e = this.sessions.get(id);
    if (!e?.host) return;
    const msg = `\x1b[36m[CC Hub] ${text}\x1b[0m\r\n`;
    e.host.writeLocal(msg);
    bus.term(id, { t: 'term.data', sid: id, data: msg });
  }

  /** 準備中のセッション名を変える(slug が決まったとき) */
  setPendingName(id: string, name: string): void {
    const e = this.sessions.get(id);
    if (!e || !name) return;
    e.info.name = name.slice(0, 100);
    this.touch(e);
  }

  /** worktree が決まったので claude を起動する */
  launchPending(id: string, o: { cwd: string; worktreeId: string; branch: string | null; instruction?: string }): void {
    const e = this.sessions.get(id);
    if (!e) throw new Error('セッションが見つかりません');
    const info = e.info;
    info.cwd = o.cwd;
    info.worktreeId = o.worktreeId;
    info.branch = o.branch;
    if (!info.task) info.task = taskText(o.instruction);
    e.preparing = false;
    this.progress(id, `${o.cwd} で claude を起動します(${o.branch ?? 'detached'})`);
    try {
      this.spawn(e, { resume: false, prompt: this.buildPrompt(info.mode, o.cwd, o.instruction) });
    } catch (err) {
      info.lastMessage = `claude の起動に失敗しました: ${(err as Error).message}`.slice(0, 200);
      this.markEnded(e, 'error', null);
      return;
    }
    this.touch(e);
  }

  /** worktree が決まった(起動前)ことを記録する。起動に失敗しても解放できるように */
  bindWorktree(id: string, worktreeId: string, cwd: string, branch: string | null): void {
    const e = this.sessions.get(id);
    if (!e) return;
    Object.assign(e.info, { worktreeId, cwd, branch });
    this.touch(e);
  }

  /** 準備に失敗した */
  failPending(id: string, message: string): void {
    const e = this.sessions.get(id);
    if (!e) return;
    e.preparing = false;
    this.progress(id, `\x1b[31m準備に失敗しました: ${message}`);
    e.info.lastMessage = message.slice(0, 200);
    this.markEnded(e, 'error', null);
    this.notify(e, 'error', 'エラー', message);
  }

  /** worktree を解放した後の SessionInfo 更新(worktreeId は履歴として残す) */
  markReleased(id: string, mode: ReleaseMode): void {
    const e = this.sessions.get(id);
    if (!e) return;
    if (mode === 'discard') e.info.branch = null;
    this.touch(e);
  }

  // ================================================================ フェーズ 3: 指示の送信(PR 作成 / 修正)
  /** PTY が動いていて入力を受けられる(準備中ではない)か */
  isLive(id: string): boolean {
    const e = this.sessions.get(id);
    return !!e && !e.preparing && !!e.host?.alive && e.info.managed;
  }

  /** モードに合わせた指示文(commander なら /commander か /hub-commander を前に付ける) */
  promptFor(id: string, text: string): string {
    const e = this.require(id);
    return this.buildPrompt(e.info.mode, e.info.cwd, text) ?? '';
  }

  /**
   * 指示を送って Enter で確定する。起動直後(starting)や承認待ちの間は送らずに待つ(承認に答えてしまわないため)。
   * 実行中(running)なら送る(Claude Code が次の入力として預かる)。timeoutMs 以内に送れなければ例外。
   */
  async sendInstruction(id: string, text: string, timeoutMs = 120_000): Promise<void> {
    const t0 = Date.now();
    let readySince = 0;
    for (;;) {
      const e = this.sessions.get(id);
      if (!e || !e.info.managed) throw new Error('セッションが見つかりません');
      const st = e.info.status;
      const alive = !e.preparing && !!e.host?.alive;
      if (!alive && !e.preparing && st !== 'starting') throw new Error('セッションが起動していません');
      const ready = alive && (st === 'awaiting_input' || st === 'idle' || st === 'running') && !e.detected;
      if (ready) {
        // 入力欄の描画が落ち着くまで少し待つ
        if (!readySince) readySince = Date.now();
        if (Date.now() - readySince >= 1200) {
          const host = e.host!;
          const line = text.replace(/\r?\n/g, ' ');
          console.log(`[session] 指示を送信: ${e.info.name} (${line.length} 文字) ${line.slice(0, 100)}`);
          host.write(line);
          // 長い文字列は貼り付けとして処理されるので、Enter は少し遅らせる
          const delay = Math.min(2000, 150 + Math.floor(line.length / 10));
          await new Promise((r) => setTimeout(r, delay));
          if (host.alive) host.write('\r');
          return;
        }
      } else readySince = 0;
      if (Date.now() - t0 > timeoutMs) throw new Error(`セッションが入力を受け付けられる状態になりません(${st})`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** commander: リポジトリに .claude/skills/commander があれば /commander、無ければ /hub-commander */
  private buildPrompt(mode: string, cwd: string, instruction?: string): string | undefined {
    const text = String(instruction ?? '').trim();
    if (mode === 'commander') {
      const skill = fs.existsSync(path.join(cwd, '.claude', 'skills', 'commander', 'SKILL.md')) ? '/commander' : '/hub-commander';
      return text ? `${skill} ${text}` : skill;
    }
    return text || undefined;
  }

  /** claude を PTY で起動する。CLAUDE* 環境変数は全部取り除く(検証 X2) */
  private spawn(e: Entry, o: { resume: boolean; prompt?: string }): void {
    const info = e.info;
    const args = o.resume ? ['--resume', this.resumeId(e)] : ['--session-id', info.id];
    args.push('--permission-mode', this.cfg.permissionMode, '-n', info.name, ...this.instructionArgs(info), ...this.cfg.claudeArgs);
    if (o.prompt) args.push(o.prompt);
    const fi = args.indexOf('--append-system-prompt-file');
    if (fi >= 0) console.log(`[session] 共通の指示を渡します: ${info.name} --append-system-prompt-file ${args[fi + 1]}`);
    const env = terminalEnv(info.id);
    if (!e.host) e.host = new PtyHost(info.cols || DEFAULT_COLS, info.rows || DEFAULT_ROWS);
    const host = e.host;
    host.onData = (data) => {
      bus.term(info.id, { t: 'term.data', sid: info.id, data });
      this.scheduleDetect(e, 180);
    };
    host.onExit = (code) => this.onExit(e, code);
    host.spawn({ file: this.cfg.claudePath, args, cwd: info.cwd, env });
    info.cols = host.cols;
    info.rows = host.rows;
    info.exitCode = null;
    e.endedAt = null;
    e.trustAnswered = false;
  }

  private onExit(e: Entry, code: number): void {
    const info = e.info;
    if (e.detectTimer) clearTimeout(e.detectTimer);
    const msg = `\r\n\x1b[33m[claude が終了しました (code ${code})]\x1b[0m\r\n`;
    e.host?.writeLocal(msg);
    bus.term(info.id, { t: 'term.data', sid: info.id, data: msg });
    for (const w of e.exitWaiters.splice(0)) w();
    if (this.shuttingDown) return; // デーモン終了時は状態を残す(次回起動時に自動再開)
    if (e.restartPending) {
      e.restartPending = false;
      setTimeout(() => {
        try {
          info.status = 'starting';
          this.spawn(e, { resume: !!findTranscript(this.resumeId(e)) });
          this.touch(e);
        } catch (err) {
          this.markEnded(e, 'error', null);
          console.error('[session] 再起動に失敗', (err as Error).message);
        }
      }, 300);
      return;
    }
    const status: SessionStatus = e.userStopped || code === 0 ? 'stopped' : 'error';
    this.markEnded(e, status, code);
    if (status === 'error') this.notify(e, 'error', 'エラー', `claude が異常終了しました (code ${code})`);
  }

  private markEnded(e: Entry, status: SessionStatus, code: number | null): void {
    const info = e.info;
    info.status = status;
    info.exitCode = code;
    info.approval = null;
    info.currentTool = null;
    e.detected = null;
    e.statusBeforeApproval = null;
    e.endedAt = Date.now();
    info.lastEventAt = e.endedAt;
    this.agents.finishSession(info.id);
    this.touch(e);
  }

  // ================================================================ 操作
  input(id: string, data: unknown, submit: unknown): void {
    const e = this.requireManaged(id);
    const host = e.host;
    if (!host?.alive) throw new HttpError(409, 'セッションが起動していません');
    const text = String(data ?? '');
    if (submit) {
      // テキスト入力→少し待って Enter(貼り付け直後の \r 取りこぼし対策)
      if (text) host.write(text.replace(/\r?\n/g, ' '));
      setTimeout(() => host.alive && host.write('\r'), 60);
    } else if (text) {
      host.write(text);
    }
  }

  /** リサイズは「最後に呼んだクライアント」が勝つ */
  resize(id: string, cols: unknown, rows: unknown): { cols: number; rows: number } {
    const e = this.requireManaged(id);
    const c = clampInt(cols, 20, 300);
    const r = clampInt(rows, 5, 100);
    if (!e.host) e.host = new PtyHost(c, r);
    if (c !== e.info.cols || r !== e.info.rows) {
      e.host.resize(c, r);
      e.info.cols = c;
      e.info.rows = r;
      bus.term(id, { t: 'term.resize', sid: id, cols: c, rows: r });
      this.touch(e, false);
      this.scheduleDetect(e, 300);
    }
    return { cols: c, rows: r };
  }

  control(id: string, action: string): void {
    const e = this.require(id);
    if (e.preparing) throw new HttpError(409, 'worktree を準備中です。完了してから操作してください');
    if (action === 'remove') {
      if ((e.info.managed || e.info.handedOff) && e.info.worktreeId && this.repoHooks?.holdsWorktree(e.info)) {
        throw new HttpError(409, 'worktree を使用中のセッションです。先に停止して解放(release)してください');
      }
      if (e.host?.alive) {
        e.userStopped = true;
        e.host.kill();
      }
      if (e.detectTimer) clearTimeout(e.detectTimer);
      if (e.tokenTimer) clearTimeout(e.tokenTimer);
      e.host?.dispose();
      this.sessions.delete(id);
      this.store.deleteSession(id);
      this.agents.removeSession(id);
      fs.rm(screenFile(id), { force: true }, () => {});
      bus.state({ t: 'session.remove', id });
      return;
    }
    if (!e.info.managed) throw new HttpError(409, '外部セッションは読み取り専用です');
    if (action === 'stop') {
      if (!e.host?.alive) throw new HttpError(409, 'セッションが起動していません');
      e.userStopped = true;
      e.host.kill();
      return;
    }
    if (action === 'restart' || action === 'resume') {
      e.userStopped = false;
      if (e.info.worktreeId && this.repoHooks && !this.repoHooks.holdsWorktree(e.info)) {
        throw new HttpError(409, 'このセッションの worktree は解放済みです');
      }
      if (e.host?.alive) {
        e.restartPending = true;
        e.host.kill();
        return;
      }
      if (!fs.existsSync(e.info.cwd)) throw new HttpError(400, `ディレクトリが存在しません: ${e.info.cwd}`);
      e.info.status = 'starting';
      const msg = '\r\n\x1b[36m[再開します]\x1b[0m\r\n';
      e.host?.writeLocal(msg);
      bus.term(id, { t: 'term.data', sid: id, data: msg });
      this.spawn(e, { resume: !!findTranscript(this.resumeId(e)) });
      this.touch(e);
      return;
    }
    throw new HttpError(400, 'unknown action');
  }

  rename(id: string, name: unknown): void {
    const e = this.require(id);
    const n = String(name ?? '').trim().slice(0, 100);
    if (!n) throw new HttpError(400, 'name が空です');
    e.info.name = n;
    this.touch(e);
  }

  /**
   * 承認に答える。option = 選択肢の n(番号なし形式では 1 始まりの位置)/ 'y' / 'n'。
   * 送るキーは approval.ts の approvalKeys を参照。
   */
  approve(id: string, option: unknown): void {
    const e = this.requireManaged(id);
    const host = e.host;
    if (!host?.alive) throw new HttpError(409, 'セッションが起動していません');
    // 直前の画面で再判定してから答える
    this.runDetect(e);
    const a = e.detected;
    const opt = String(option ?? '');
    let keys: string[] | null;
    if (a) {
      keys = approvalKeys(a, opt);
      if (!keys) throw new HttpError(400, `選択肢が見つかりません: ${opt}`);
    } else if (/^[0-9]$/.test(opt) || /^[yn]$/i.test(opt)) {
      // 画面解析で拾えていない場合(hooks だけで承認待ちになった場合)はそのまま送る
      keys = [opt];
    } else {
      throw new HttpError(409, '承認待ちではありません');
    }
    // 信頼ダイアログで「No, exit」を選んだ場合は終了するので、ユーザー操作による停止として扱う
    if (a && !a.numbered && /信頼/.test(a.question)) {
      const chosen = a.options.find((o) => o.n === opt) ?? (/^n/i.test(opt) ? a.options.find((o) => /^no/i.test(o.label)) : undefined);
      if (chosen && /^no/i.test(chosen.label)) e.userStopped = true;
    }
    keys.forEach((k, i) => setTimeout(() => host.alive && host.write(k), i * 40));
    setTimeout(() => this.runDetect(e), keys.length * 40 + 400);
  }

  // ================================================================ PowerShell へ移す / CC Hub に戻す
  /**
   * 「PowerShell で開く」: CC Hub の PTY を止め、新しい PowerShell ウィンドウで claude --resume して続ける。
   * 以後は managed=false / handedOff=true。状態は hooks(ヘッダー X-CC-Hub-Session = CC_HUB_SESSION)で追う。
   * worktree は割り当てたまま(SessionEnd で stopped になってから解放できる)
   */
  async openTerminal(id: string): Promise<SessionInfo> {
    const e = this.require(id);
    const info = e.info;
    if (info.handedOff && !info.managed) throw new HttpError(409, '既に PowerShell に移しています');
    if (!info.managed) throw new HttpError(409, '外部セッションは PowerShell に移せません');
    if (e.preparing) throw new HttpError(409, 'worktree を準備中です。完了してから操作してください');
    if (e.handingOff) throw new HttpError(409, 'PowerShell に移している途中です');
    if (info.worktreeId && this.repoHooks && !this.repoHooks.holdsWorktree(info)) {
      throw new HttpError(409, 'このセッションの worktree は解放済みです');
    }
    const resumeId = this.resumeId(e);
    if (!findTranscript(resumeId)) throw new HttpError(409, 'まだ再開できる会話がありません(最初の指示を送ってから移してください)');
    if (!fs.existsSync(info.cwd)) throw new HttpError(400, `ディレクトリが存在しません: ${info.cwd}`);
    const spec: TerminalSpec = {
      name: info.name,
      cwd: info.cwd,
      claudePath: this.cfg.claudePath,
      resumeId,
      extraArgs: ['--permission-mode', this.cfg.permissionMode, ...this.instructionArgs(info), ...this.cfg.claudeArgs],
    };
    // 引用できないパスなどは PTY を止める前に弾く
    buildTerminalArgv(spec);
    e.handingOff = true;
    try {
      if (e.host?.alive) {
        // 画面を保存してから止める(CC Hub 側では「移す前の最後の画面」を見せる)
        const host = e.host;
        await new Promise<void>((r) => host.snapshot((d) => (saveScreen(info.id, d), r())));
        await this.stopPty(e);
      }
      const msg = '\r\n\x1b[36m[CC Hub] PowerShell のウィンドウで続きを開きます\x1b[0m\r\n';
      e.host?.writeLocal(msg);
      bus.term(id, { t: 'term.data', sid: id, data: msg });
      let launched: { file: string; args: string[] };
      try {
        launched = await launchTerminal(this.cfg.terminalLauncher, spec, info.id);
      } catch (err) {
        // ウィンドウを開けなかった: CC Hub のセッション(停止済み)のまま残す
        info.lastMessage = `PowerShell を開けませんでした: ${(err as Error).message}`.slice(0, 200);
        this.touch(e);
        throw new HttpError(500, info.lastMessage);
      }
      console.log(`[session] PowerShell に移しました: ${info.name} (${info.id}) ${launched.file} ${launched.args.join(' ').slice(0, 300)}`);
      const now = Date.now();
      Object.assign(info, { managed: false, handedOff: true, status: 'starting' as SessionStatus, exitCode: null, approval: null, currentTool: null, lastEventAt: now });
      e.endedAt = null;
      e.handoffAt = now;
      e.detected = null;
      e.statusBeforeApproval = null;
      this.touch(e);
      return { ...info };
    } finally {
      e.handingOff = false;
    }
  }

  /** PTY を止めて終了を待つ(Ctrl+C を 2 回 → 4 秒で終わらなければ kill。最大 10 秒) */
  private stopPty(e: Entry): Promise<void> {
    const host = e.host;
    if (!host?.alive) return Promise.resolve();
    e.userStopped = true;
    e.restartPending = false;
    return new Promise<void>((resolve) => {
      let done = false;
      const timers: NodeJS.Timeout[] = [];
      const finish = () => {
        if (done) return;
        done = true;
        timers.forEach(clearTimeout);
        resolve();
      };
      e.exitWaiters.push(finish);
      host.write('\x03');
      timers.push(setTimeout(() => host.alive && host.write('\x03'), 250));
      timers.push(setTimeout(() => host.alive && host.kill(), 4000));
      timers.push(setTimeout(finish, 10_000));
    });
  }

  /**
   * 「CC Hub に戻す」: 外部セッション / PowerShell に移したセッションを、CC Hub の PTY で --resume して引き取る。
   * 相手が実行中(running / awaiting_approval)なら force なしは 409。外部セッションは同じ ID のまま managed に変える
   */
  takeover(id: string, force: boolean): SessionInfo {
    const e = this.require(id);
    const info = e.info;
    if (info.managed) throw new HttpError(409, '既に CC Hub で動いています');
    if (e.handingOff) throw new HttpError(409, 'PowerShell に移している途中です');
    if ((info.status === 'running' || info.status === 'awaiting_approval') && !force) {
      throw new HttpError(409, '元のウィンドウで動作中です。止めてから引き取るか、強制してください');
    }
    if (info.worktreeId && this.repoHooks && !this.repoHooks.holdsWorktree(info)) {
      throw new HttpError(409, 'このセッションの worktree は解放済みです');
    }
    const resumeId = this.resumeId(e);
    if (!findTranscript(resumeId)) throw new HttpError(409, '再開できる会話(transcript)が見つかりません');
    let isDir = false;
    try {
      isDir = !!info.cwd && fs.statSync(info.cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new HttpError(400, `ディレクトリが存在しません: ${info.cwd || '(不明)'}`);
    const wasExternal = !info.handedOff;
    const before = { ...info };
    Object.assign(info, {
      managed: true,
      handedOff: false,
      mode: wasExternal ? 'plain' : info.mode,
      status: 'starting' as SessionStatus,
      exitCode: null,
      approval: null,
      currentTool: null,
      cols: info.cols || DEFAULT_COLS,
      rows: info.rows || DEFAULT_ROWS,
    });
    e.endedAt = null;
    e.userStopped = false;
    e.handoffAt = null;
    e.detected = null;
    e.statusBeforeApproval = null;
    // 外部セッションの claude 側 ID は info.id そのもの。以後 /clear などで変われば trackClaudeId が追う
    const msg = `\r\n\x1b[36m[CC Hub] ${wasExternal ? '外部セッション' : 'PowerShell のセッション'}を引き取って再開します${force ? '(強制)' : ''}\x1b[0m\r\n`;
    e.host?.writeLocal(msg);
    try {
      this.spawn(e, { resume: true });
    } catch (err) {
      Object.assign(info, before);
      throw new HttpError(500, `claude の起動に失敗しました: ${(err as Error).message}`);
    }
    bus.term(id, { t: 'term.data', sid: id, data: msg });
    console.log(`[session] 引き取りました: ${info.name} (${info.id}) resume=${resumeId}${force ? ' force' : ''}`);
    this.touch(e);
    return { ...info };
  }

  // ================================================================ 履歴から開く
  /** claude 側の session_id に対応する CC Hub のセッション ID(ハブの ID / /clear 後の ID のどちらでも) */
  hubIdFor(claudeId: string): string | null {
    return this.lookup(claudeId)?.info.id ?? null;
  }

  /**
   * 履歴(~/.claude/projects の transcript)の会話を開く。
   * hub: 既に CC Hub にあれば 実行中 → そのまま / 停止中 → 再開 / 外部・PowerShell → 引き取り。無ければ新しい managed セッションで --resume。
   * terminal: 新しい PowerShell で --resume(handedOff のセッションとして一覧に載る)。CC Hub で動いていれば PowerShell に移す。
   */
  async openHistory(claudeId: string, target: 'hub' | 'terminal', h: { cwd: string; title: string }): Promise<SessionInfo> {
    if (!UUID_RE.test(claudeId)) throw new HttpError(400, 'session_id が不正です');
    const existing = this.lookup(claudeId);
    if (existing) {
      const info = existing.info;
      const running = info.managed && this.isRunning(info.id);
      if (!running && !existing.preparing && !(info.cwd && fs.existsSync(info.cwd))) {
        throw new HttpError(409, `フォルダがありません: ${info.cwd || '(不明)'}`);
      }
      if (target === 'hub') {
        if (info.managed) {
          if (this.isRunning(info.id)) return { ...info };
          this.control(info.id, 'restart');
          return { ...existing.info };
        }
        return this.takeover(info.id, false);
      }
      if (info.managed) return this.openTerminal(info.id);
      if (this.handedOffLive(existing) || (!info.handedOff && info.status !== 'stopped')) {
        throw new HttpError(409, info.handedOff ? '既に PowerShell で開いています' : '元のウィンドウで動作中です');
      }
      return this.launchHandoff(existing);
    }
    const cwd = h.cwd ? path.resolve(h.cwd) : '';
    let ok = false;
    try {
      ok = !!cwd && fs.statSync(cwd).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) throw new HttpError(409, `フォルダがありません: ${h.cwd || '(不明)'}`);
    const title = String(h.title || '').replace(/\s+/g, ' ').trim();
    const name = (title && !title.startsWith('(') ? title.slice(0, 40) : '') || path.basename(cwd) || cwd;
    if (target === 'hub') return this.start({ cwd, name, resume: claudeId, mode: 'plain' });
    const info = this.blankInfo(claudeId.toLowerCase(), name, cwd, false);
    info.status = 'stopped';
    return this.launchHandoff(this.newEntry(info));
  }

  /** 停止中の(または新しい)非 managed のセッションを PowerShell で --resume して handedOff にする */
  private async launchHandoff(e: Entry): Promise<SessionInfo> {
    const info = e.info;
    if (info.worktreeId && this.repoHooks && !this.repoHooks.holdsWorktree(info)) {
      throw new HttpError(409, 'このセッションの worktree は解放済みです');
    }
    const resumeId = this.resumeId(e);
    if (!findTranscript(resumeId)) throw new HttpError(409, '再開できる会話(transcript)が見つかりません');
    if (!fs.existsSync(info.cwd)) throw new HttpError(409, `フォルダがありません: ${info.cwd}`);
    const spec: TerminalSpec = {
      name: info.name,
      cwd: info.cwd,
      claudePath: this.cfg.claudePath,
      resumeId,
      extraArgs: ['--permission-mode', this.cfg.permissionMode, ...this.instructionArgs(info), ...this.cfg.claudeArgs],
    };
    let launched: { file: string; args: string[] };
    try {
      launched = await launchTerminal(this.cfg.terminalLauncher, spec, info.id);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(500, `PowerShell を開けませんでした: ${(err as Error).message}`.slice(0, 200));
    }
    console.log(`[session] 履歴を PowerShell で開きました: ${info.name} (${info.id}) ${launched.file} ${launched.args.join(' ').slice(0, 300)}`);
    const now = Date.now();
    Object.assign(info, { managed: false, handedOff: true, status: 'starting' as SessionStatus, exitCode: null, approval: null, currentTool: null, lastEventAt: now });
    e.endedAt = null;
    e.handoffAt = now;
    e.detected = null;
    e.statusBeforeApproval = null;
    this.sessions.set(info.id, e);
    this.touch(e);
    return { ...info };
  }

  // ================================================================ 画面解析
  private scheduleDetect(e: Entry, ms: number): void {
    if (e.detectTimer) clearTimeout(e.detectTimer);
    e.detectTimer = setTimeout(() => {
      e.detectTimer = null;
      this.runDetect(e);
    }, ms);
  }

  private runDetect(e: Entry): void {
    if (!e.host?.alive) return;
    // 画面全体を見る(行数の多い画面では、ダイアログが末尾 25 行より上に描かれることがある)
    const next = detectApproval(e.host.tailLines(Math.max(25, e.host.rows)), e.info.cwd);
    if (next && this.autoTrust(e, next)) return;
    const prevJson = JSON.stringify(e.detected);
    if (JSON.stringify(next) === prevJson) return;
    e.detected = next;
    const info = e.info;
    info.approval = next ? { type: next.type, question: next.question, options: next.options } : null;
    if (next) {
      if (info.status !== 'awaiting_approval') this.setStatus(e, 'awaiting_approval');
    } else if (info.status === 'awaiting_approval') {
      // 承認が画面から消えた = 回答された
      const back = e.statusBeforeApproval === 'starting' ? 'starting' : 'running';
      this.setStatus(e, back);
    }
    this.touch(e, false);
  }

  /**
   * 信頼ダイアログ(検証 X1)の自動応答: 信頼済みリポジトリの worktree なら「Yes」を選ぶ(起動ごとに 1 回)。
   * それ以外のセッションは従来どおり承認キューに出す。
   */
  private autoTrust(e: Entry, a: DetectedApproval): boolean {
    if (e.trustAnswered || !e.host?.alive) return false;
    const isTrust = /信頼/.test(a.question) && a.options.some((o) => /trust|^yes/i.test(o.label));
    if (!isTrust || !this.repoHooks?.isTrustedPath(e.info.cwd)) return false;
    const keys = approvalKeys(a, 'y');
    if (!keys) return false;
    e.trustAnswered = true;
    const host = e.host;
    console.log(`[session] 信頼ダイアログに自動で「Yes」と答えます: ${e.info.name} (${e.info.cwd})`);
    keys.forEach((k, i) => setTimeout(() => host.alive && host.write(k), 150 + i * 40));
    this.scheduleDetect(e, 150 + keys.length * 40 + 500);
    return true;
  }

  // ================================================================ 状態遷移
  /** quiet = 通知を出さない(起動直後に入力待ちになった時など) */
  private setStatus(e: Entry, status: SessionStatus, quiet = false): void {
    const info = e.info;
    if (info.status === status) return;
    if (status === 'awaiting_approval') e.statusBeforeApproval = info.status;
    else e.statusBeforeApproval = null;
    info.status = status;
    // 区切りのよいところで画面を保存しておく(終了時は Claude がフルスクリーン表示を抜けて画面が空になるため、
    // 終了後に見せる「最後の画面」はここで保存したものを使う)。描画が落ち着くまで少し待つ
    if (e.host?.alive && (status === 'awaiting_input' || status === 'awaiting_approval' || status === 'idle')) {
      const host = e.host;
      setTimeout(() => host.alive && host.snapshot((d) => saveScreen(info.id, d)), 800);
    }
    if (quiet) return;
    if (status === 'awaiting_approval') {
      const q = info.approval?.question || (info.currentTool ? `${info.currentTool.name}: ${info.currentTool.target}` : '承認が必要です');
      const opts = info.approval?.options.map((o) => `${o.n}. ${o.label}`) ?? [];
      this.notify(e, 'approval', '承認待ち', [q, ...opts].join('\n'));
    } else if (status === 'awaiting_input') {
      this.notify(e, 'input', '入力待ち', info.lastMessage || '');
    } else if (status === 'error') {
      this.notify(e, 'error', 'エラー', info.lastMessage || '');
    }
  }

  /** バックグラウンド待機のまま ms のあいだ hooks が来なければ「入力待ち」にする */
  private settleWaiting(e: Entry, ms: number): void {
    const info = e.info;
    const mark = info.lastEventAt;
    setTimeout(() => {
      if (this.sessions.get(info.id) !== e) return;
      if (info.lastEventAt !== mark || info.status !== 'running' || info.currentTool?.name !== '待機') return;
      if (this.agents.runningCount(info.id) > 0) return;
      info.currentTool = null;
      this.setStatus(e, 'awaiting_input');
      this.touch(e, false);
    }, ms);
  }

  private notify(e: Entry, kind: NotifyKind, title: string, body: string): void {
    const now = Date.now();
    const last = e.lastNotify.get(kind) ?? 0;
    // hooks と画面解析の二重通知を抑える(承認は 5 秒、それ以外は 1 秒)
    if (now - last < (kind === 'approval' ? 5000 : 1000)) return;
    e.lastNotify.set(kind, now);
    emitNotify({ kind, sessionId: e.info.id, title: `${title}: ${e.info.name}`, body, ts: now });
  }

  /** hooks を受けた時のセッション特定。無ければ外部セッションとして登録する */
  private resolveHookSession(b: any, hubHeader: string | undefined): Entry | null {
    const h = hubHeader && !hubHeader.startsWith('$') ? hubHeader.trim() : '';
    if (h && this.sessions.has(h)) return this.sessions.get(h)!;
    const sid = typeof b.session_id === 'string' ? b.session_id : '';
    const known = this.lookup(sid);
    if (known) return known;
    if (!sid || b.hook_event_name === 'SessionEnd') return null;
    const cwd = typeof b.cwd === 'string' ? b.cwd : '';
    const info = this.blankInfo(sid, path.basename(cwd) || sid.slice(0, 8), cwd, false);
    info.status = 'awaiting_input';
    const e = this.newEntry(info);
    this.sessions.set(sid, e);
    console.log(`[session] 外部セッションを検出: ${info.name} (${sid})`);
    return e;
  }

  handleHook(b: any, hubHeader: string | undefined): void {
    if (!b || typeof b !== 'object') return;
    const e = this.resolveHookSession(b, hubHeader);
    if (!e) return;
    const info = e.info;
    const ev = String(b.hook_event_name || '');
    const now = Date.now();
    info.lastEventAt = now;
    if (typeof b.permission_mode === 'string') info.permissionMode = b.permission_mode;
    // 外部セッションは hooks の cwd を使う(PowerShell に移した worktree のセッションは cwd を変えない)
    if (!info.managed && !info.worktreeId && typeof b.cwd === 'string' && b.cwd) info.cwd = b.cwd;

    this.agents.handleHook(info.id, b);

    // バックグラウンド待機中に最後のエージェントが終わったら、少し待っても再開しなければ「入力待ち」にする
    if (ev === 'SubagentStop' && info.currentTool?.name === '待機' && this.agents.runningCount(info.id) === 0) {
      this.settleWaiting(e, BG_SETTLE_MS);
    }

    // managed で PTY が無い(終了済み)なら状態は PTY 側の判定を優先する
    const dead = info.managed && !e.host?.alive;
    const fromSubagent = typeof b.agent_id === 'string' && !!b.agent_id;

    if (!dead) {
      switch (ev) {
        case 'SessionStart':
          // ※ SessionStart は http hook では発火しないので、integrations/hooks/relay.js(command 型)経由で届く
          this.trackClaudeId(e, b);
          if (['starting', 'stopped', 'error', 'idle'].includes(info.status)) this.setStatus(e, 'awaiting_input', true);
          if (typeof b.model === 'string') info.model = b.model;
          break;
        case 'UserPromptSubmit':
          this.setStatus(e, 'running');
          // CC Hub 以外から始めたセッションは最初のプロンプトを「何の作業か」にする
          if (!info.task && !fromSubagent) info.task = taskText(b.prompt);
          break;
        case 'PreToolUse':
          if (info.status !== 'awaiting_approval') this.setStatus(e, 'running');
          if (!fromSubagent) {
            info.currentTool = { name: String(b.tool_name || ''), target: toolTarget(b.tool_name, b.tool_input), since: now };
          }
          break;
        case 'PostToolUse':
        case 'PostToolUseFailure':
          // ツール失敗(コマンドの非 0 終了など)は通常の流れなので error にはしない
          if (!fromSubagent) info.currentTool = null;
          if (info.status === 'awaiting_approval' && !e.detected) this.setStatus(e, 'running');
          else if (info.status !== 'awaiting_approval') this.setStatus(e, 'running');
          break;
        case 'Notification': {
          const nt = String(b.notification_type || '');
          if (nt === 'permission_prompt') {
            this.setStatus(e, 'awaiting_approval');
            if (e.host?.alive) {
              this.runDetect(e);
              this.scheduleDetect(e, 400);
            }
          } else if (nt === 'idle_prompt') {
            if (info.status === 'awaiting_input' || info.status === 'starting') this.setStatus(e, 'idle');
          }
          break;
        }
        case 'Stop':
          if (fromSubagent) break;
          info.currentTool = null;
          if (typeof b.last_assistant_message === 'string') info.lastMessage = b.last_assistant_message.slice(0, 200);
          {
            // バックグラウンドのサブエージェントが動いている間は、ターンが終わっても「入力待ち」にしない
            // (Claude はエージェントの完了通知で自動的に再開するため、ここで通知するとユーザーを早く呼びすぎる)
            // background_tasks には終わったばかりのタスクが残っていることがあるので、終了済みの状態のものは数えない
            const bg = activeBackgroundTasks(b.background_tasks);
            const tracked = this.agents.runningCount(info.id);
            const running = Math.max(bg, tracked);
            if (running > 0) {
              info.currentTool = { name: '待機', target: `バックグラウンドのエージェント ${running} 件`, since: now };
              this.setStatus(e, 'running');
              // 追跡中のエージェントが無い = SubagentStop はもう来ないので、何も起きなければ入力待ちに戻す
              if (tracked === 0) this.settleWaiting(e, BG_SETTLE_MS);
              break;
            }
          }
          this.setStatus(e, 'awaiting_input');
          break;
        case 'StopFailure':
          info.currentTool = null;
          if (typeof b.error === 'string') info.lastMessage = b.error.slice(0, 200);
          this.setStatus(e, 'error');
          break;
        case 'SessionEnd':
          // PowerShell に移す時に止めた PTY の SessionEnd が遅れて届いたものは無視する
          if (info.handedOff && e.handoffAt && now - e.handoffAt < 3000) break;
          if (!info.managed) {
            info.currentTool = null;
            info.approval = null;
            info.status = 'stopped';
            e.endedAt = now;
            this.agents.finishSession(info.id);
          }
          break;
        case 'CwdChanged':
          if (typeof b.new_cwd === 'string' && !(info.handedOff && info.worktreeId)) info.cwd = b.new_cwd;
          break;
      }
    }
    this.touch(e);
    this.scheduleTokens(e);
  }

  /**
   * /clear・compact・resume で claude 側の session_id が変わったら記録する(以後の --resume に使う)。
   * SessionInfo.id(ハブの ID)は変えない。
   */
  private trackClaudeId(e: Entry, b: any): void {
    const sid = typeof b.session_id === 'string' ? b.session_id : '';
    // PowerShell に移したセッションも追跡する(戻すときの --resume に使う)
    if (!(e.info.managed || e.info.handedOff) || !UUID_RE.test(sid)) return;
    const cur = e.claudeId || e.info.id;
    if (sid === cur) return;
    if (e.claudeId) this.aliases.delete(e.claudeId);
    e.claudeId = sid === e.info.id ? null : sid;
    if (e.claudeId) {
      this.aliases.set(e.claudeId, e.info.id);
      e.claudeIds.add(e.claudeId);
    }
    console.log(`[session] claude の session_id が変わりました (${String(b.source || '?')}): ${e.info.name} ${cur} → ${sid}`);
  }

  /** statusLine: セッションごとのコンテキスト使用率・コスト・モデル + 全体の使用率 */
  handleStatusline(hubSession: unknown, data: any): void {
    if (!data || typeof data !== 'object') return;
    this.usage.update(data);
    const h = typeof hubSession === 'string' ? hubSession : '';
    const e = (h && this.sessions.get(h)) || (typeof data.session_id === 'string' ? this.lookup(data.session_id) : undefined);
    if (!e) return;
    const info = e.info;
    const before = JSON.stringify([info.status, info.contextPct, info.costUsd, info.model]);
    // 保険: statusLine が届いた = TUI が起動済み。SessionStart を取りこぼして starting のままなら入力待ちにする
    if (info.status === 'starting' && !e.detected && (!info.managed || e.host?.alive)) this.setStatus(e, 'awaiting_input', true);
    const ctx = Number(data.context_window?.used_percentage);
    if (data.context_window?.used_percentage != null && Number.isFinite(ctx)) info.contextPct = ctx;
    const cost = Number(data.cost?.total_cost_usd);
    if (data.cost?.total_cost_usd != null && Number.isFinite(cost)) info.costUsd = cost;
    if (typeof data.model?.display_name === 'string') info.model = data.model.display_name;
    // トークンの累計(メイン会話)。サブエージェントとキャッシュ分は transcript から足す
    const ti = Number(data.context_window?.total_input_tokens);
    const to = Number(data.context_window?.total_output_tokens);
    if (data.context_window?.total_input_tokens != null && Number.isFinite(ti) && Number.isFinite(to)) {
      e.slTokens = { input: ti, output: to };
    }
    if (JSON.stringify([info.status, info.contextPct, info.costUsd, info.model]) !== before) this.touch(e);
    this.scheduleTokens(e);
  }

  // ================================================================ トークン使用量
  private tokensJson(e: Entry): string | null {
    return e.info.tokens ? JSON.stringify({ tokens: e.info.tokens, sl: e.slTokens }) : null;
  }

  /** トークン使用量の更新を予約する(セッションごとに最短 2 秒間隔) */
  private scheduleTokens(e: Entry): void {
    if (e.tokenTimer || this.shuttingDown) return;
    const wait = Math.max(0, e.tokenLastAt + TOKEN_INTERVAL_MS - Date.now());
    e.tokenTimer = setTimeout(() => {
      e.tokenTimer = null;
      void this.flushTokens(e);
    }, wait);
    e.tokenTimer.unref?.();
  }

  private async flushTokens(e: Entry): Promise<void> {
    if (e.tokenRunning) {
      this.scheduleTokens(e);
      return;
    }
    e.tokenRunning = true;
    e.tokenLastAt = Date.now();
    try {
      if (!e.tail) e.tail = new TranscriptTail();
      await e.tail.poll([...e.claudeIds]);
      if (this.sessions.get(e.info.id) !== e) return; // 削除済み
      // statusLine も transcript も無いうちは何もしない(null のまま)
      if (!e.slTokens && e.tail.tally.size === 0) return;
      const next = combineTokens(e.slTokens, e.tail.tally);
      const cur = e.info.tokens;
      if (
        !cur ||
        cur.input !== next.input ||
        cur.output !== next.output ||
        cur.cacheRead !== next.cacheRead ||
        cur.cacheCreation !== next.cacheCreation
      ) {
        e.info.tokens = next;
        this.touch(e);
      }
    } catch (err) {
      console.warn(`[session] トークン集計に失敗: ${e.info.id} ${(err as Error).message}`);
    } finally {
      e.tokenRunning = false;
      e.tokenLastAt = Date.now();
    }
    // 大きな transcript の読み残し
    if (e.tail?.pending) this.scheduleTokens(e);
  }

  // ================================================================ ターミナル購読
  /** term:<sid> 購読開始時のスナップショット */
  snapshot(id: string, cb: (data: string, cols: number, rows: number) => void): void {
    const e = this.sessions.get(id);
    if (!e) return cb('\x1b[31m[セッションが見つかりません]\x1b[0m\r\n', DEFAULT_COLS, DEFAULT_ROWS);
    if (!e.host || !e.host.alive) {
      if (e.info.handedOff && !e.info.managed) {
        const saved = loadScreen(id);
        const note = '\x1b[90m[PowerShell のウィンドウに移しました。「CC Hub に戻す」でここに引き取れます]\x1b[0m';
        return cb(saved ? `${saved}\x1b[999;1H\r\n${note}` : `${note}\r\n`, e.host?.cols || DEFAULT_COLS, e.host?.rows || DEFAULT_ROWS);
      }
      if (!e.info.managed) return cb('\x1b[90m[外部セッション: ターミナルは表示できません]\x1b[0m\r\n', DEFAULT_COLS, DEFAULT_ROWS);
      // 生きている PTY が無い: 区切りごとに保存しておいた最後の画面を出す
      const saved = loadScreen(id);
      // 終了コードはユーザー操作以外で止まった(エラー)ときだけ出す。停止ボタンでも kill により 1 になるため
      const exit = e.info.status === 'error' && e.info.exitCode != null ? `終了コード ${e.info.exitCode}。` : '';
      // 保存画面のカーソル位置(入力欄の途中)に書くと重なるので、最下行へ移動して改行してから出す
      const note = saved
        ? `\x1b[999;1H\r\n\x1b[90m[停止前の最後の画面です。${exit}「再起動」で会話の続きから再開できます]\x1b[0m`
        : `\x1b[90m[このセッションの画面は残っていません。${exit}「再起動」で会話の続きから再開できます]\x1b[0m\r\n`;
      const cols = e.host?.cols || e.info.cols || DEFAULT_COLS;
      const rows = e.host?.rows || e.info.rows || DEFAULT_ROWS;
      return cb((saved ?? '') + note, cols, rows);
    }
    const host = e.host;
    host.snapshot((data) => cb(data, host.cols, host.rows));
  }

  // ================================================================ 終了
  /** デーモン終了: PTY を閉じるが状態は「実行中」のまま残す(次回 --resume で再開) */
  shutdown(): void {
    this.shuttingDown = true;
    for (const e of this.sessions.values()) {
      if (e.host?.alive) {
        this.store.saveSession(e.info, null, e.claudeId);
        e.host.kill();
      }
    }
  }
}
