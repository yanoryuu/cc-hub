// mod「cc-hub」: Claude Code のセッションの中から CC Hub とつなぐ。
// - イベントの送信: classic イベントと使用量(session.measure)を CC Hub に送る(settings.json の hooks / relay.js / statusline の置き換え)。
//   今までの hooks が settings.json に入っていれば送らない(二重にしない)
// - ほかのセッションの状況: 入力欄の上の帯(承認待ち・同じ作業ツリーを使うセッション)、パネル(/hub pane。承認にボタンで答える)、
//   ステータスライン、トースト(承認待ち・終わった・エラー)
// - /hub コマンド: 状況 / パネル / new <指示>(新しいセッション)
// - 見張り: CC Hub の作業ツリーで既定のブランチへの切り替え・作業ツリーの削除・ほかの作業ツリーの編集を止め、直接のデプロイを承認に回す
// - 共通の指示: CC Hub が起動していないセッションにも、プロジェクトの共通の指示をシステムプロンプトに足す
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HubOverview } from '../types'
import {
  FORWARDED,
  HUB_HELP,
  STATUS_ICON,
  STATUS_LABEL,
  type Hub,
  api,
  crossWorktreeWrite,
  deployGuard,
  ingest,
  loadHub,
  parseHubArgs,
  statusText,
  summaryText,
  transitions,
  worktreeBashGuard,
} from './hub'

const PANE = 'cc-hub'
const POLL_MS = 4000
const overview = atom({ plugin: 'cc-hub', key: 'overview' } as const, null)
const isOnline = atom({ plugin: 'cc-hub', key: 'isOnline' } as const, false)
const bandHidden = atom({ plugin: 'cc-hub', key: 'bandHidden' } as const, null)

type Options = { guardWorktree?: boolean; guardDeploy?: boolean; toasts?: boolean }

/** 帯に出す文(無ければ null) */
function bandLines(o: HubOverview | null): string[] {
  if (!o) return []
  const lines: string[] = []
  const waiting = o.sessions.filter((s) => s.status === 'awaiting_approval')
  if (waiting.length) lines.push(`⏳ 承認待ち ${waiting.length} 件: ${waiting.map((s) => s.name).join('、')}`)
  const occ = o.me?.worktree?.occupants ?? []
  if (occ.length) lines.push(`⚠ この作業ツリー(${o.me!.worktree!.name})では別のセッションも動いています: ${occ.join('、')}`)
  return lines
}

/** モジュールの間だけ持つもの(再読み込みで初めから) */
const ctx = {
  opt: {} as Options,
  hub: null as Hub | null,
  cwd: '',
  sessionId: '',
  /** 前回のほかのセッションの状態(トースト用) */
  prev: new Map<string, string>(),
  firstPoll: true,
}

async function ensureHub($: EngineInterface): Promise<Hub | null> {
  if (!ctx.hub) ctx.hub = await loadHub($)
  return ctx.hub
}

/** CC Hub の状況を取り直し、ステータスとトーストを出す */
async function poll($: EngineInterface): Promise<void> {
  const hb = await ensureHub($)
  if (!hb) return
  const q = `session=${encodeURIComponent(hb.hubSession ?? ctx.sessionId)}&cwd=${encodeURIComponent(ctx.cwd)}`
  const r = await api<{ overview: HubOverview }>($, hb, `/api/mod/overview?${q}`)
  await update($, isOnline, () => !!r)
  if (!r) {
    $.ui.status(undefined)
    return
  }
  const o = r.overview
  await update($, overview, () => o)
  $.ui.status(statusText(o.sessions, o.approvals))
  if (ctx.opt.toasts !== false && !ctx.firstPoll) for (const t of transitions(ctx.prev, o.sessions)) $.ui.toast(t, { timeoutMs: 6000 })
  ctx.firstPoll = false
  ctx.prev.clear()
  for (const s of o.sessions) ctx.prev.set(s.id, s.status)
}

/** 見張りが使う今の状況(定期の取得をしていない -p などでは、その場で取りに行く) */
async function current($: EngineInterface): Promise<{ o: HubOverview | null; online: boolean }> {
  if (!(await read($, isOnline)) && (await ensureHub($))) await poll($)
  return { o: await read($, overview), online: await read($, isOnline) }
}

/** 承認待ちのセッションの選択肢を選ぶ */
async function approve($: EngineInterface, sessionId: string, option: string): Promise<void> {
  const hb = await ensureHub($)
  if (hb) await api($, hb, `/api/sessions/${encodeURIComponent(sessionId)}/approve`, { option })
  await poll($)
}

export const register: Register = (on, options) => {
  ctx.opt = (options ?? {}) as Options
  const opt = ctx.opt

  // ------------------------------------------------------------ 始まり: 設定の読み込み・コマンド・定期の取得
  on('session.start', async ($, e, next) => {
    ctx.cwd = e.cwd
    ctx.sessionId = await $.session.id()
    ctx.hub = await loadHub($)
    const hub = ctx.hub
    await $.command.register({
      name: 'hub',
      description: 'CC Hub: ほかのセッションの状況・パネル・新しいセッション',
      argumentHint: '[pane | new <指示>]',
    })
    if (hub && e.isInteractive) {
      void poll($).catch(() => undefined)
      $.clock.every(POLL_MS, () => void poll($).catch(() => undefined))
    }
    return next(e)
  })

  // ------------------------------------------------------------ イベントの送信(今までの hooks の置き換え)
  on('classic.*', async ($, e, next) => {
    const hb = await ensureHub($)
    if (hb && !hb.hasLegacyHooks) {
      const ev = e as Record<string, unknown>
      let body: Record<string, unknown> | null = null
      if (typeof ev.hook_event_name === 'string') {
        if ((FORWARDED as readonly string[]).includes(ev.hook_event_name)) body = ev
      } else if (typeof ev.tool === 'string') {
        // classic.PreToolUse は tool.call と同じ形で来る: hooks の PreToolUse の形に直す
        const { tool, tool_use_id, agentId, requestMeta: _m, ...input } = ev
        body = {
          hook_event_name: 'PreToolUse',
          session_id: ctx.sessionId || (await $.session.id()),
          cwd: ctx.cwd || (await $.session.cwd()),
          tool_name: tool,
          tool_input: input,
          tool_use_id,
          ...(agentId ? { agent_id: agentId } : {}),
        }
      }
      if (body) await ingest($, hb, 'hook', body)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const hb = await ensureHub($)
    if (hb && !hb.hasLegacyHooks) {
      const five = e.rateLimits.find((r) => r.kind === 'five_hour')
      const seven = e.rateLimits.find((r) => r.kind === 'seven_day')
      await ingest($, hb, 'statusline', {
        hub_session: hb.hubSession,
        data: {
          session_id: ctx.sessionId,
          cwd: ctx.cwd,
          context_window: {
            used_percentage: e.context.percent,
            context_window_size: e.context.window,
            total_input_tokens: e.context.tokens,
          },
          rate_limits: {
            ...(five ? { five_hour: { used_percentage: five.percentUsed, resets_at: five.resetsAt } } : {}),
            ...(seven ? { seven_day: { used_percentage: seven.percentUsed, resets_at: seven.resetsAt } } : {}),
          },
          ...(e.cost ? { cost: { total_cost_usd: e.cost.usd } } : {}),
        },
      })
    }
    return next(e)
  })

  // ------------------------------------------------------------ 帯(入力欄の上)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const lines = bandLines(await read($, overview))
    const key = lines.join('\n')
    if (!lines.length || e.props.hasSurvey || (await read($, bandHidden)) === key) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {lines.map((l) => (
          <Text color="yellow">{l}</Text>
        ))}
        <Box>
          <Button key="open" label="パネルを開く" onPress={() => void $.ui.open({ id: PANE, title: 'CC Hub' })} />
          <Button key="hide" label="閉じる" onPress={() => update($, bandHidden, () => key)} />
        </Box>
      </Box>
    )
  })

  // ------------------------------------------------------------ パネル
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const o = await read($, overview)
    if (!(await read($, isOnline)) || !o) return <Text dimColor>CC Hub につながっていません(CC Hub が起動しているか確かめてください)</Text>
    const hb = ctx.hub
    const me = o.me
    return (
      <Box flexDirection="column">
        {me && (
          <Text dimColor>
            このセッション: {me.name}
            {me.branch ? ` [${me.branch}]` : ''}
            {me.worktree ? ` / ${me.worktree.name}` : ''}
          </Text>
        )}
        {o.sessions.length === 0 && <Text dimColor>ほかに動いているセッションはありません</Text>}
        {o.sessions.map((s) => (
          <Box flexDirection="column">
            <Text color={s.status === 'awaiting_approval' ? 'yellow' : s.status === 'error' ? 'red' : undefined} dimColor={s.status === 'stopped'}>
              {STATUS_ICON[s.status] ?? '・'} {s.name} — {STATUS_LABEL[s.status] ?? s.status}
              {s.branch ? ` [${s.branch}]` : ''}
              {s.pr ? ` PR #${s.pr.number} ${s.pr.checks}` : ''}
            </Text>
            {s.approval && <Text>  {s.approval.question}</Text>}
            {s.approval && hb && (
              <Box>
                {s.approval.options.map((op) => (
                  <Button
                    key={`${s.id}:${op.n}`}
                    label={`${op.n}. ${op.label}`}
                    onPress={() => void approve($, s.id, op.n)}
                  />
                ))}
              </Box>
            )}
            {!s.approval && s.lastMessage && <Text dimColor>  {s.lastMessage}</Text>}
          </Box>
        ))}
      </Box>
    )
  })

  // ------------------------------------------------------------ /hub
  on('command.run', { command: 'hub' }, async ($, e) => {
    const hb = await ensureHub($)
    if (!hb) return { text: 'CC Hub が見つかりません(CC Hub をインストールして起動してください)' }
    const a = parseHubArgs(e.args)
    if (a.kind === 'help') return { text: HUB_HELP }
    if (a.kind === 'pane') {
      await poll($)
      await $.ui.open({ id: PANE, title: 'CC Hub' })
      return { text: 'CC Hub のパネルを開きました' }
    }
    if (a.kind === 'new') {
      const o = await read($, overview)
      const repoId = o?.me?.repoId ?? null
      const body = repoId ? { repoId, mode: 'plain', instruction: a.instruction } : { mode: 'plain', cwd: ctx.cwd, instruction: a.instruction }
      const r = await api<{ session?: { name: string } }>($, hb, '/api/sessions', body)
      return { text: r?.session ? `新しいセッション「${r.session.name}」を起こしました(CC Hub で見られます)` : '新しいセッションを起こせませんでした(CC Hub の画面で確かめてください)' }
    }
    await poll($)
    const o = await read($, overview)
    if (!o) return { text: 'CC Hub につながりません(CC Hub が起動しているか確かめてください)' }
    return { text: `${summaryText(o.sessions)}\n\n/hub pane でパネルを開けます` }
  })

  // ------------------------------------------------------------ 見張り(失敗したら止めずに通す)
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const { o, online } = await current($)
    if (opt.guardWorktree !== false && o?.me?.worktree) {
      const g = worktreeBashGuard(e.command)
      if (g) return g
    }
    if (opt.guardDeploy !== false && online) {
      const g = deployGuard(e.command)
      if (g) return g
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^(Edit|Write|NotebookEdit)$/ }, async ($, e, next) => {
    const { o } = await current($)
    const ev = e as { file_path?: unknown; notebook_path?: unknown }
    const file = String(ev.file_path ?? ev.notebook_path ?? '')
    if (opt.guardWorktree !== false && o?.me?.worktree && file) {
      const g = crossWorktreeWrite(ctx.cwd, file)
      if (g) return g
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ------------------------------------------------------------ 共通の指示(CC Hub が起動したセッションは --append-system-prompt-file で渡しているので足さない)
  let instructions: string | null | undefined
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const hb = await ensureHub($)
    if (!hb || hb.hubSession) return r
    if (instructions === undefined) {
      const got = await api<{ text: string | null }>($, hb, `/api/mod/instructions?cwd=${encodeURIComponent(ctx.cwd || (await $.session.cwd()))}`)
      instructions = got?.text?.trim() || null
    }
    if (!instructions) return r
    return { sections: [...r.sections, { id: 'cc-hub:instructions', text: `# プロジェクトの共通の指示(CC Hub)\n\n${instructions}`, scope: 'session' as const }] }
  })
}
