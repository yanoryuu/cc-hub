// CC Hub のデーモンとのやり取り(設定の読み込み・API・イベントの送信)と、mod の判定(純粋関数)
import type { EngineInterface } from 'claude-code'

import type { HubSession } from '../types'

export type Hub = {
  base: string
  /** /api 用(%APPDATA%\cc-hub\local-token) */
  apiToken: string
  /** /ingest 用(ingest-token) */
  ingestToken: string
  /** CC Hub が起動したセッションならそのハブ ID(環境変数 CC_HUB_SESSION) */
  hubSession: string | null
  /** ~/.claude/settings.json に、同じ CC Hub(ポート)へ送る今までの hooks が入っている。入っていれば mod はイベントを送らない(二重にしない) */
  hasLegacyHooks: boolean
}

const DEFAULT_PORT = 7861

async function readText($: EngineInterface, p: string): Promise<string | null> {
  try {
    return await $.fs.read(p)
  } catch {
    return null
  }
}

/** CC Hub のデータフォルダの設定とトークンを読む。CC Hub が入っていなければ null */
export async function loadHub($: EngineInterface): Promise<Hub | null> {
  const custom = await $.env.get('CC_HUB_DATA_DIR')
  const appData = await $.env.get('APPDATA')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const dir = custom || (appData ? `${appData}\\cc-hub` : null)
  if (!dir) return null
  const apiToken = (await readText($, `${dir}\\local-token`))?.trim() ?? ''
  const ingestToken = (await readText($, `${dir}\\ingest-token`))?.trim() ?? ''
  if (!apiToken) return null
  let port = DEFAULT_PORT
  try {
    const cfg = JSON.parse((await readText($, `${dir}\\config.json`)) ?? '{}') as { port?: unknown }
    if (Number(cfg.port)) port = Number(cfg.port)
  } catch {
    /* 既定のポート */
  }
  const settings = home ? await readText($, `${home}\\.claude\\settings.json`) : null
  return {
    base: `http://127.0.0.1:${port}`,
    apiToken,
    ingestToken,
    hubSession: (await $.env.get('CC_HUB_SESSION')) || null,
    hasLegacyHooks: !!settings && settings.includes(`127.0.0.1:${port}/ingest/hook`),
  }
}

/** /api を呼ぶ(失敗は null) */
export async function api<T>($: EngineInterface, hub: Hub, path: string, body?: unknown): Promise<T | null> {
  try {
    const r = await $.http.fetch(`${hub.base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${hub.apiToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!r.ok) return null
    return JSON.parse(r.text) as T
  } catch {
    return null
  }
}

/** /ingest に送る(今までの hooks と同じ形・同じヘッダー) */
export async function ingest($: EngineInterface, hub: Hub, kind: 'hook' | 'statusline', body: unknown): Promise<void> {
  try {
    await $.http.fetch(`${hub.base}/ingest/${kind}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CC-Hub-Token': hub.ingestToken,
        'X-CC-Hub-Session': hub.hubSession ?? '',
      },
      body: JSON.stringify(body),
    })
  } catch {
    /* CC Hub が止まっていても作業は続ける */
  }
}

// ------------------------------------------------------------ 判定(純粋関数。テストする)

/** 今までの hooks と同じく CC Hub に送る classic イベント */
export const FORWARDED = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
] as const

export const STATUS_ICON: Record<string, string> = {
  starting: '…',
  running: '▶',
  awaiting_approval: '⏳',
  awaiting_input: '✓',
  idle: '✓',
  stopped: '■',
  error: '✗',
}

export const STATUS_LABEL: Record<string, string> = {
  starting: '起動中',
  running: '作業中',
  awaiting_approval: '承認待ち',
  awaiting_input: '入力待ち',
  idle: '入力待ち',
  stopped: '停止',
  error: 'エラー',
}

/** 前回からの状態の変化 → 知らせる文(前回に無かったセッションは知らせない) */
export function transitions(prev: Map<string, string>, sessions: readonly HubSession[]): string[] {
  const out: string[] = []
  for (const s of sessions) {
    const before = prev.get(s.id)
    if (before === undefined || before === s.status) continue
    if (s.status === 'awaiting_approval') out.push(`⏳ ${s.name} が承認待ちです`)
    else if ((s.status === 'awaiting_input' || s.status === 'idle') && (before === 'running' || before === 'awaiting_approval')) {
      out.push(`✓ ${s.name} の作業が終わりました`)
    } else if (s.status === 'error') out.push(`✗ ${s.name} がエラーで止まりました`)
  }
  return out
}

/** ステータスラインの一言 */
export function statusText(sessions: readonly HubSession[], approvals: number): string {
  const running = sessions.filter((s) => s.status === 'running' || s.status === 'starting').length
  const parts = [`Hub: 作業中 ${running}`]
  if (approvals) parts.push(`承認待ち ${approvals}`)
  return parts.join(' / ')
}

export type Guard = { deny: string } | null

const DEFAULT_BRANCH = /^(main|master|develop)$/

/** CC Hub の作業ツリーの中で止める Bash(既定のブランチへの切り替え・作業ツリーの削除など) */
export function worktreeBashGuard(command: string): Guard {
  const c = command.replace(/\s+/g, ' ')
  const sw = /\bgit (?:checkout|switch)(?: -[A-Za-z-]+)* ([^\s;&|]+)\s*(?:$|[;&|])/.exec(c)
  if (sw && DEFAULT_BRANCH.test(sw[1]!.replace(/^origin\//, ''))) {
    return { deny: `CC Hub: この作業ツリーは作業用のブランチで使います。${sw[1]} に切り替えないでください(最新の main を見るなら CC Hub の「最新の main を開く」を使ってください)` }
  }
  if (/\bgit worktree (?:remove|prune|move)\b/.test(c)) {
    return { deny: 'CC Hub: 作業ツリーの削除・移動は CC Hub が管理しています。CC Hub の画面から操作してください' }
  }
  return null
}

/** 作業ツリーの中から、同じリポジトリのほかの作業ツリー(兄弟の wt-NN や .base)のファイルを書き換えない */
export function crossWorktreeWrite(cwd: string, filePath: string): Guard {
  const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const m = /^(.*\\)(wt-\d+)(?:\\|$)/i.exec(norm(cwd))
  if (!m) return null
  const root = m[1]!
  const mine = `${root}${m[2]!.toLowerCase()}`
  const f = norm(filePath)
  if (!f.startsWith(root) || f === mine || f.startsWith(`${mine}\\`)) return null
  const other = f.slice(root.length).split('\\')[0]
  if (!other || !/^(wt-\d+|\.base)$/i.test(other)) return null
  return { deny: `CC Hub: ${other} はほかのセッションの作業ツリーです。自分の作業ツリー(${m[2]})の中のファイルを編集してください` }
}

/** 直接のデプロイ(CC Hub の承認に回すもの) */
export function deployGuard(command: string): Guard {
  const c = command.replace(/\s+/g, ' ')
  if (/\bfirebase(?:\.cmd)? deploy\b/.test(c) || /\bfirebase(?:\.cmd)? hosting:channel:deploy\b/.test(c)) {
    return { deny: 'CC Hub: Firebase へのデプロイは承認制です。MCP の firebase_status で確かめてから request_firebase_deploy で申請してください' }
  }
  if (/(?:^|[;&|] ?)(?:scp|sftp|lftp|ftp|winscp(?:\.com)?)\b/.test(c) || /\brsync\b[^;&|]* [^ ]+@?[\w.-]+:[^ ]*/.test(c)) {
    return { deny: 'CC Hub: サーバーへのアップロードは承認制です。MCP の request_deploy で申請してください' }
  }
  return null
}

/** /hub の引数 → 何をするか */
export function parseHubArgs(args: string): { kind: 'summary' } | { kind: 'pane' } | { kind: 'new'; instruction: string } | { kind: 'help' } {
  const a = args.trim()
  if (!a) return { kind: 'summary' }
  const [head, ...rest] = a.split(/\s+/)
  if (head === 'pane' || head === 'panel' || head === 'パネル') return { kind: 'pane' }
  if (head === 'new' || head === '新規') {
    const instruction = rest.join(' ').trim()
    return instruction ? { kind: 'new', instruction } : { kind: 'help' }
  }
  return { kind: 'help' }
}

export const HUB_HELP = [
  '/hub            CC Hub のセッションの状況',
  '/hub pane       状況をパネルで開く(承認待ちにはボタンで答えられる)',
  '/hub new <指示> 同じプロジェクトで新しいセッションを起こす(作業ツリーを使うプロジェクトなら新しい作業ツリーで)',
].join('\n')

/** /hub の要約の文 */
export function summaryText(sessions: readonly HubSession[]): string {
  if (!sessions.length) return 'ほかに動いているセッションはありません。'
  return sessions
    .map((s) => {
      const pr = s.pr ? ` PR #${s.pr.number}(${s.pr.checks})` : ''
      const br = s.branch ? ` [${s.branch}]` : ''
      return `${STATUS_ICON[s.status] ?? '・'} ${s.name}: ${STATUS_LABEL[s.status] ?? s.status}${br}${pr}`
    })
    .join('\n')
}
