// CC Hub の MCP サーバーのツール定義(説明文・入力スキーマ・入力の検証・処理)。
// 呼び出し元の claude は自分が誰かを名乗らないため、セッション / プロジェクトは引数の cwd(作業フォルダ)から推定する。
// (ヘッダー X-CC-Hub-Session が展開済みで届いた場合はそれを優先する)
import path from 'node:path';
import type { DeployJob, ServerInfo, SessionInfo } from '@cc-hub/shared';
import type { DeployService } from '../deploy/service';
import type { FirebaseInfoService } from '../firebase/info';
import { infoSummary } from '../firebase/info';
import { FIREBASE_TARGETS } from '../firebase/config';
import type { InstructionsService, ProjectKey } from '../project/instructions';
import { HttpError } from '../util';

export class ToolInputError extends Error {}

type PropSpec =
  | { type: 'string'; description: string; maxLength?: number }
  | { type: 'boolean'; description: string }
  | { type: 'array'; description: string; items: string[] };

export interface ToolDef {
  name: string;
  description: string;
  props: Record<string, PropSpec>;
  required: string[];
  /** 読み取りのみのツールか(MCP の annotations) */
  readOnly: boolean;
}

const CWD_PROP: PropSpec = {
  type: 'string',
  description: 'あなた(Claude)の現在の作業ディレクトリの絶対パス。CC Hub はこれでセッションとプロジェクトを特定します。必ず渡してください。',
  maxLength: 1000,
};

export const TOOLS: ToolDef[] = [
  {
    name: 'list_servers',
    description:
      'CC Hub に登録されているアップロード先のサーバー(レンタルサーバーなどの FTP / FTPS / SFTP)の一覧を返します。' +
      '名前・公開 URL・アップロード先フォルダ・既定のアップロード元フォルダ・ビルドコマンドを含みます(パスワードなどの秘密は含みません)。' +
      'request_deploy の前に、送り先の名前と既定のフォルダを確認するのに使ってください。',
    props: {},
    required: [],
    readOnly: true,
  },
  {
    name: 'request_deploy',
    description:
      'サーバーへのアップロード(デプロイ)を申請します。このツールはすぐには送信しません。' +
      'CC Hub の承認キューに申請が入り、ユーザーが CC Hub の画面で承認するとビルド → 差分計算 → 送信が自動で行われます。' +
      '呼び出した後は「CC Hub で承認してください」とユーザーに伝え、必要なら get_deploy_status で結果を確認してください。' +
      '同じ内容の申請を何度も出さないでください。localDir を省略するとサーバーの既定のフォルダを使います(相対パスは cwd 基準)。' +
      'note には何を・なぜ公開するのかを日本語で 1〜3 文で書いてください(ユーザーが承認の判断に使います)。',
    props: {
      server: { type: 'string', description: 'サーバーの名前または ID(list_servers で確認)', maxLength: 200 },
      localDir: { type: 'string', description: 'アップロード元のフォルダ(省略時はサーバーの既定)。ビルド出力ならその出力フォルダ', maxLength: 1000 },
      note: { type: 'string', description: '申請理由(必須)。例: 「トップページの文言修正を公開します」', maxLength: 2000 },
      cwd: CWD_PROP,
    },
    required: ['server', 'note'],
    readOnly: false,
  },
  {
    name: 'get_deploy_status',
    description:
      'request_deploy / request_firebase_deploy で出したデプロイの状態を返します。state: pending_approval(承認待ち)/ planning(ビルド・差分計算中)/ ' +
      'uploading / preview_ready(Firebase: プレビュー URL に公開済み。ユーザーが本番に反映するのを待っています)/ done(完了。url が公開 URL)/ ' +
      'failed(error に理由)/ rejected(却下)/ cancelled。' +
      '承認待ちのあいだ短い間隔で何度も呼ばないでください。',
    props: { deployId: { type: 'string', description: 'request_deploy / request_firebase_deploy が返した deployId', maxLength: 100 } },
    required: ['deployId'],
    readOnly: true,
  },
  {
    name: 'list_sessions',
    description:
      'CC Hub が把握している Claude Code のセッションの一覧(名前・作業フォルダ・状態・ブランチ・作業内容の要約)を返します。読み取りのみです。',
    props: {},
    required: [],
    readOnly: true,
  },
  {
    name: 'get_session',
    description: 'CC Hub のセッション 1 件の詳細(状態・作業フォルダ・ブランチ・直近の発言の要約など)を返します。読み取りのみです。',
    props: { id: { type: 'string', description: 'セッション ID(list_sessions の id)', maxLength: 100 } },
    required: ['id'],
    readOnly: true,
  },
  {
    name: 'firebase_status',
    description:
      'cwd のフォルダ(または上位)にある Firebase のプロジェクトの状況を返します: プロジェクト ID(.firebaserc の default)・ログイン中のアカウント・' +
      'firebase.json に設定のあるサービス(デプロイできる対象)・Hosting の本番 URL・公開中のプレビューチャンネルの URL・Functions の一覧。読み取りのみです。' +
      'request_firebase_deploy の前に、対象とプロジェクトを確認するのに使ってください。error があればその内容をユーザーに伝えてください(例: firebase login が必要)。',
    props: { cwd: CWD_PROP },
    required: ['cwd'],
    readOnly: true,
  },
  {
    name: 'request_firebase_deploy',
    description:
      'Firebase へのデプロイを申請します(承認制)。このツールはすぐにはデプロイしません。CC Hub の承認キューに申請が入り、ユーザーが承認すると実行されます。\n' +
      '- Hosting は、承認後まずプレビューチャンネル(7 日で消える一時的な URL)に公開されます。本番(live)への反映は、ユーザーがプレビューを確認してから CC Hub で行います\n' +
      '- Hosting と functions などを一緒に申請した場合、functions などは本番に反映するときにまとめてデプロイされます\n' +
      '- Hosting 以外だけ(functions / firestore:rules / firestore:indexes / storage)の申請や preview: false は、承認後すぐ本番にデプロイされます\n' +
      '呼び出した後は「CC Hub で承認してください」とユーザーに伝え、必要なら get_deploy_status で状態(preview_ready ならプレビュー URL)を確認してください。' +
      'ビルドが必要なら申請の前に自分でビルドしておいてください(firebase.json の predeploy は CLI が実行します)。同じ内容の申請を何度も出さないでください。' +
      'note には何を・なぜデプロイするのかを日本語で 1〜3 文で書いてください。',
    props: {
      cwd: CWD_PROP,
      targets: { type: 'array', items: [...FIREBASE_TARGETS], description: `デプロイする対象(1 つ以上): ${FIREBASE_TARGETS.join(' / ')}。firebase.json に設定のあるものだけ` },
      note: { type: 'string', description: '申請理由(必須)。例: 「お知らせページを追加したので公開します」', maxLength: 2000 },
      preview: { type: 'boolean', description: 'Hosting をまずプレビューに出すか(既定 true。false は本番へ直接。特に理由が無ければ省略してください)' },
    },
    required: ['cwd', 'targets', 'note'],
    readOnly: false,
  },
  {
    name: 'get_project_instructions',
    description:
      'このプロジェクトの「共通の指示」を返します。共通の指示は、CC Hub がこのプロジェクトで起動するすべてのセッションに自動で渡すルール集です' +
      '(このセッションにも既に渡されている場合があります)。update_project_instructions で書き換える前に必ず現在の内容を読んでください。',
    props: { cwd: CWD_PROP },
    required: [],
    readOnly: true,
  },
  {
    name: 'update_project_instructions',
    description:
      'このプロジェクトの「共通の指示」を全文置き換えます。ユーザーに頼まれたときだけ使ってください。書き方のルール:\n' +
      '- 先に get_project_instructions で現在の内容を読み、頼まれていない既存の内容は残す(消す・書き換えるのは依頼された部分だけ)\n' +
      '- 200 行以内(できるだけ短く)。1 行 1 ルールの簡潔な箇条書き(「- 」)で、必要なら短い見出しで分ける\n' +
      '- 日本語・命令形で書く。説明や経緯は書かない。重複や矛盾はまとめる\n' +
      '- パスワード・トークン・個人情報などの秘密は書かない\n' +
      '200 行を超えても保存されますが warning が返るので、その場合は要点を絞って書き直してください。' +
      '変更は次に起動するセッションから反映されます。',
    props: {
      content: { type: 'string', description: '新しい指示の全文(Markdown)', maxLength: 200_000 },
      cwd: CWD_PROP,
    },
    required: ['content'],
    readOnly: false,
  },
];

/** MCP の tools/list に返す形 */
export function listToolsResult(): { tools: unknown[] } {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(t.props).map(([k, p]) => {
            if (p.type === 'array') return [k, { type: 'array', description: p.description, items: { type: 'string', enum: p.items }, minItems: 1, uniqueItems: true }];
            if (p.type === 'boolean') return [k, { type: 'boolean', description: p.description }];
            return [k, { type: p.type, description: p.description, ...(p.maxLength ? { maxLength: p.maxLength } : {}) }];
          }),
        ),
        required: t.required,
        additionalProperties: false,
      },
      annotations: { readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false },
    })),
  };
}

/** 検証済みの引数(文字列 / 真偽値 / 文字列の配列) */
export type ToolArgs = Record<string, any>;

/** 入力の検証。未知の引数・型違い・必須の欠け・長すぎる値・選べない値はエラー */
export function validateArgs(name: string, args: unknown): ToolArgs {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new ToolInputError(`不明なツールです: ${name}`);
  const a = args == null ? {} : args;
  if (typeof a !== 'object' || Array.isArray(a)) throw new ToolInputError('引数はオブジェクトで指定してください');
  const out: ToolArgs = {};
  for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
    const p = t.props[k];
    if (!p) throw new ToolInputError(`不明な引数です: ${k}(使える引数: ${Object.keys(t.props).join(', ') || 'なし'})`);
    if (v == null) continue;
    if (p.type === 'boolean') {
      if (typeof v !== 'boolean') throw new ToolInputError(`${k} は true / false で指定してください`);
      out[k] = v;
      continue;
    }
    if (p.type === 'array') {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ToolInputError(`${k} は文字列の配列で指定してください(例: ["hosting"])`);
      const bad = v.find((x) => !p.items.includes(x));
      if (bad !== undefined) throw new ToolInputError(`${k} に使えない値です: ${bad}(使えるもの: ${p.items.join(', ')})`);
      out[k] = [...new Set(v as string[])];
      continue;
    }
    if (typeof v !== 'string') throw new ToolInputError(`${k} は文字列で指定してください`);
    if (p.maxLength && v.length > p.maxLength) throw new ToolInputError(`${k} が長すぎます(${p.maxLength} 文字まで)`);
    out[k] = v;
  }
  for (const k of t.required) {
    const v = out[k];
    if (v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length)) throw new ToolInputError(`${k} を指定してください`);
  }
  if (out.cwd != null && !path.isAbsolute(out.cwd)) throw new ToolInputError('cwd は絶対パスで指定してください');
  return out;
}

// ------------------------------------------------------------ 処理
export interface McpDeps {
  deploy: DeployService;
  /** Firebase の状況(無ければ firebase_status はエラー) */
  firebase?: FirebaseInfoService | null;
  sessions: () => Record<string, SessionInfo>;
  instructions: InstructionsService;
  /** cwd がプールのリポジトリ(.base / worktree)なら repoId */
  repoIdForCwd: (cwd: string) => string | null;
}

export interface CallContext {
  /** ヘッダー X-CC-Hub-Session(展開済みで、存在するセッションのときだけ) */
  sessionId: string | null;
}

function serverSummary(s: ServerInfo) {
  return {
    id: s.id,
    name: s.name,
    protocol: s.protocol,
    host: s.host,
    remoteDir: s.remoteDir,
    publicUrl: s.publicUrl,
    defaultLocalDir: s.defaultLocalDir,
    buildCommand: s.buildCommand,
    deleteExtra: s.deleteExtra,
    note: s.note || undefined,
    lastDeployAt: s.lastDeployAt ? new Date(s.lastDeployAt).toISOString() : null,
  };
}

function sessionSummary(s: SessionInfo) {
  return {
    id: s.id,
    name: s.name,
    cwd: s.cwd,
    status: s.status,
    managed: s.managed,
    repoId: s.repoId,
    branch: s.branch,
    task: s.task ?? null,
    lastMessage: s.lastMessage,
    lastEventAt: new Date(s.lastEventAt).toISOString(),
  };
}

function deploySummary(j: DeployJob) {
  return {
    deployId: j.id,
    server: j.serverName,
    state: j.state,
    localDir: j.localDir,
    url: j.url,
    error: j.error,
    plan: j.plan ? { upload: j.plan.upload.length, delete: j.plan.delete.length, unchanged: j.plan.unchanged, totalBytes: j.plan.totalBytes } : null,
    progress: j.progress,
    logTail: j.log.slice(-10),
    ...(j.firebase
      ? {
          firebase: {
            projectId: j.firebase.projectId,
            targets: j.firebase.targets,
            preview: j.firebase.preview,
            channel: j.firebase.channel,
            previewUrl: j.firebase.previewUrl,
            previewExpiresAt: j.firebase.previewExpiresAt ? new Date(j.firebase.previewExpiresAt).toISOString() : null,
            promoted: j.firebase.promoted,
          },
        }
      : {}),
  };
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** cwd からセッションを推定する(cwd がいちばん近い = 深い、動いているもの優先、新しいもの優先) */
export function sessionForCwd(all: SessionInfo[], cwd: string): SessionInfo | null {
  const cands = all.filter((s) => !!s.cwd && isInside(s.cwd, cwd));
  if (!cands.length) return null;
  const live = (s: SessionInfo) => (s.status === 'stopped' || s.status === 'error' ? 0 : 1);
  cands.sort((a, b) => b.cwd.length - a.cwd.length || live(b) - live(a) || b.lastEventAt - a.lastEventAt);
  return cands[0];
}

export async function callTool(name: string, rawArgs: unknown, d: McpDeps, ctx: CallContext): Promise<unknown> {
  const a = validateArgs(name, rawArgs);
  const all = () => Object.values(d.sessions());
  const caller = (): SessionInfo | null => {
    if (ctx.sessionId) {
      const s = d.sessions()[ctx.sessionId];
      if (s) return s;
    }
    return a.cwd ? sessionForCwd(all(), a.cwd) : null;
  };
  const projectKey = (): ProjectKey => {
    const s = ctx.sessionId ? d.sessions()[ctx.sessionId] : null;
    const cwd = a.cwd ?? s?.cwd ?? null;
    if (!cwd) throw new ToolInputError('cwd(あなたの現在の作業ディレクトリの絶対パス)を指定してください');
    // プールの worktree / .base ならリポジトリの指示
    const repoId = s?.repoId ?? d.repoIdForCwd(cwd);
    if (repoId) return { repoId, cwd: null };
    return d.instructions.keyForCwd(cwd);
  };
  switch (name) {
    case 'list_servers':
      return { servers: d.deploy.serverList().map(serverSummary) };
    case 'request_deploy': {
      const s = caller();
      let localDir = a.localDir ?? null;
      if (localDir && !path.isAbsolute(localDir)) {
        if (!a.cwd) throw new ToolInputError('localDir を相対パスで指定するときは cwd も指定してください');
        localDir = path.resolve(a.cwd, localDir);
      }
      const job = d.deploy.requestFromClaude({ server: a.server, localDir, note: a.note, sessionId: s?.id ?? null });
      return {
        deployId: job.id,
        state: job.state,
        server: job.serverName,
        localDir: job.localDir,
        message:
          'アップロードを申請しました。まだ送信されていません。ユーザーが CC Hub の画面で承認すると、ビルド → 差分計算 → 送信が自動で行われます。' +
          'ユーザーに「CC Hub で承認してください」と伝えてください。結果は get_deploy_status で確認できます。',
      };
    }
    case 'firebase_status': {
      if (!d.firebase) throw new ToolInputError('Firebase の機能は使えません');
      return infoSummary(await d.firebase.get(a.cwd));
    }
    case 'request_firebase_deploy': {
      const s = caller();
      const job = d.deploy.requestFirebaseFromClaude({ cwd: a.cwd, targets: a.targets, note: a.note, preview: a.preview ?? null, sessionId: s?.id ?? null });
      const fb = job.firebase!;
      const previewFirst = fb.preview && fb.targets.includes('hosting');
      return {
        deployId: job.id,
        state: job.state,
        projectId: fb.projectId,
        projectDir: fb.projectDir,
        targets: fb.targets,
        preview: previewFirst,
        message:
          'Firebase へのデプロイを申請しました。まだデプロイされていません。ユーザーに「CC Hub で承認してください」と伝えてください。' +
          (previewFirst
            ? '承認されると Hosting はまずプレビュー URL に公開されます(state: preview_ready)。本番への反映はユーザーがプレビューを確認してから CC Hub で行います' +
              (fb.targets.length > 1 ? '(Hosting 以外の対象もそのときにデプロイされます)。' : '。')
            : '承認されるとすぐ本番にデプロイされます。') +
          '結果は get_deploy_status で確認できます。',
      };
    }
    case 'get_deploy_status': {
      const j = d.deploy.job(a.deployId);
      if (!j) throw new ToolInputError(`アップロードが見つかりません: ${a.deployId}`);
      return deploySummary(j);
    }
    case 'list_sessions':
      return { sessions: all().sort((x, y) => y.lastEventAt - x.lastEventAt).map(sessionSummary) };
    case 'get_session': {
      const s = d.sessions()[a.id];
      if (!s) throw new ToolInputError(`セッションが見つかりません: ${a.id}`);
      return sessionSummary(s);
    }
    case 'get_project_instructions': {
      const k = projectKey();
      const ins = d.instructions.get(k);
      return { project: k.repoId ?? k.cwd, content: ins.content, lineCount: ins.lineCount, limit: ins.limit, warning: ins.warning, updatedAt: ins.updatedAt, updatedBy: ins.updatedBy };
    }
    case 'update_project_instructions': {
      const k = projectKey();
      const ins = d.instructions.put(k, a.content, 'claude');
      return {
        project: k.repoId ?? k.cwd,
        lineCount: ins.lineCount,
        limit: ins.limit,
        ...(ins.warning ? { warning: ins.warning } : {}),
        message: ins.warning ? `保存しました。${ins.warning}` : '保存しました。次に起動するセッションから反映されます。',
      };
    }
  }
  throw new ToolInputError(`不明なツールです: ${name}`);
}

/** 例外をツールのエラー文にする */
export function toolErrorMessage(e: unknown): string {
  if (e instanceof ToolInputError || e instanceof HttpError) return e.message;
  return `内部エラー: ${String((e as Error)?.message ?? e).slice(0, 300)}`;
}
