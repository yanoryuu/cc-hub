// mod「cc-hub」のテスト: claude plugin test integrations/mod/cc-hub
// CC Hub(env / fs / http)は下に置いたフックが答える。本物の CC Hub には繋がない
import { expect, test } from 'claude-code/testing'

import type { HubOverview } from '../types'
import { crossWorktreeWrite, deployGuard, parseHubArgs, statusText, transitions, worktreeBashGuard } from '../hooks/hub'

const OVERVIEW: HubOverview = {
  me: { id: 'me', name: 'ui-fix', repoId: 'o/r', branch: 'feat/ui', worktree: { name: 'wt-02', occupants: ['もう一つ'] } },
  sessions: [
    { id: 'a', name: 'api-fix', status: 'awaiting_approval', managed: true, repoId: 'o/r', branch: 'feat/api', lastMessage: null, lastEventAt: 2, approval: { type: 'options', question: 'ファイルを消しますか?', options: [{ n: '1', label: 'はい', selected: true }, { n: '2', label: 'いいえ', selected: false }] }, pr: null },
    { id: 'b', name: 'docs', status: 'running', managed: false, repoId: null, branch: null, lastMessage: '書いています', lastEventAt: 1, approval: null, pr: { number: 7, url: 'u', state: 'OPEN', checks: 'SUCCESS' } },
  ],
  approvals: 1,
  now: 3,
}

test('見張り: 作業ツリーで既定のブランチへの切り替えと作業ツリーの削除を止める', () => {
  expect(worktreeBashGuard('git checkout main')).not.toBeNull()
  expect(worktreeBashGuard('git switch  origin/master && ls')).not.toBeNull()
  expect(worktreeBashGuard('git worktree remove ../wt-03')).not.toBeNull()
  expect(worktreeBashGuard('git checkout -b feat/x')).toBeNull()
  expect(worktreeBashGuard('git checkout feat/main-menu')).toBeNull()
  expect(worktreeBashGuard('git checkout -- src/a.ts')).toBeNull()
})

test('見張り: ほかの作業ツリーのファイルは書き換えない', () => {
  const cwd = 'D:\\WorkTree\\P\\wt-02'
  expect(crossWorktreeWrite(cwd, 'D:\\WorkTree\\P\\wt-02\\src\\a.ts')).toBeNull()
  expect(crossWorktreeWrite(cwd, 'd:/worktree/p/wt-03/src/a.ts')).not.toBeNull()
  expect(crossWorktreeWrite(cwd, 'D:\\WorkTree\\P\\.base\\a.ts')).not.toBeNull()
  expect(crossWorktreeWrite(cwd, 'C:\\Users\\me\\notes.md')).toBeNull()
  expect(crossWorktreeWrite('C:\\proj', 'D:\\WorkTree\\P\\wt-03\\a.ts')).toBeNull()
})

test('見張り: 直接のデプロイは承認に回す', () => {
  expect(deployGuard('npx firebase deploy --only hosting')).not.toBeNull()
  expect(deployGuard('scp dist/* user@host:/var/www')).not.toBeNull()
  expect(deployGuard('rsync -av dist/ me@example.com:/srv/')).not.toBeNull()
  expect(deployGuard('npm run build && git push')).toBeNull()
  expect(deployGuard('firebase emulators:start')).toBeNull()
})

test('トースト: 状態が変わったときだけ、初めて見たセッションは知らせない', () => {
  const prev = new Map([['a', 'running'], ['b', 'running'], ['c', 'running']])
  const now = [
    { ...OVERVIEW.sessions[0]!, status: 'awaiting_approval' },
    { ...OVERVIEW.sessions[1]!, status: 'awaiting_input' },
    { ...OVERVIEW.sessions[1]!, id: 'c', name: 'c', status: 'error' },
    { ...OVERVIEW.sessions[1]!, id: 'new', name: 'new', status: 'error' },
  ]
  expect(transitions(prev, now)).toEqual(['⏳ api-fix が承認待ちです', '✓ docs の作業が終わりました', '✗ c がエラーで止まりました'])
  expect(statusText(OVERVIEW.sessions, 1)).toBe('Hub: 作業中 1 / 承認待ち 1')
})

test('/hub の引数', () => {
  expect(parseHubArgs('')).toEqual({ kind: 'summary' })
  expect(parseHubArgs('pane')).toEqual({ kind: 'pane' })
  expect(parseHubArgs('new  ログイン画面を直す')).toEqual({ kind: 'new', instruction: 'ログイン画面を直す' })
  expect(parseHubArgs('new')).toEqual({ kind: 'help' })
})

/** CC Hub の代わり: 設定ファイルと /api/mod/overview に答える */
function fakeHub(on: Parameters<Parameters<typeof test>[1]>[1], posts: string[], settings = '{}') {
  on('env.get', (_, e) => ({ value: e.name === 'APPDATA' ? 'C:\\AppData' : e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('local-token')) return { value: 'tok' }
    if (e.path.endsWith('ingest-token')) return { value: 'itok' }
    if (e.path.endsWith('config.json')) return { value: '{"port":7860}' }
    if (e.path.endsWith('settings.json')) return { value: settings }
    throw new Error('not found')
  })
  on('http.fetch', (_, e) => {
    posts.push(`${e.init?.method ?? 'GET'} ${e.url}`)
    const text = e.url.includes('/api/mod/overview') ? JSON.stringify({ ok: true, overview: OVERVIEW }) : '{"ok":true}'
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('command.register', () => ({ value: { command: 'hub' } }))
  on('clock.every', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'me' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('classic.SessionStart', () => ({}))
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const BAND = {
  plugin: 'cc-hub',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: 'cc-hub',
  component: 'Pane',
  requestId: 'cc-hub',
  props: { title: 'CC Hub', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

test('帯とパネル: 承認待ちと同じ作業ツリーのセッションを出し、ボタンで承認する', async ($, on) => {
  const posts: string[] = []
  fakeHub(on, posts)
  await $.session.start({ cwd: 'D:\\WorkTree\\P\\wt-02', surface: 'terminal', isInteractive: true })
  // 最初の取得(session.start が投げる)を待つ
  for (let i = 0; i < 20 && !posts.some((p) => p.includes('/api/mod/overview')); i++) await wait(5)
  await wait(20)

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /承認待ち 1 件: api-fix/ }))?.text).toBeDefined()
    expect((await band.find({ type: 'Text', text: /wt-02.*もう一つ/ }))?.text).toBeDefined()
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect((await pane.find({ type: 'Text', text: /ファイルを消しますか/ }))?.text).toBeDefined()
    expect((await pane.find({ type: 'Text', text: /docs — 作業中.*PR #7/ }))?.text).toBeDefined()
    await pane.press({ key: 'a:1' })
    expect(posts.some((p) => p === 'POST http://127.0.0.1:7860/api/sessions/a/approve')).toBe(true)
    await pane.unmount()
  }
})

test('/hub: 状況を文で返し、new で新しいセッションを起こす', async ($, on) => {
  const posts: string[] = []
  fakeHub(on, posts)
  await $.session.start({ cwd: 'D:\\WorkTree\\P\\wt-02', surface: 'terminal', isInteractive: false })
  const r = await $.command.run({ command: 'hub', args: '' })
  expect(JSON.stringify(r)).toContain('api-fix')
  await $.command.run({ command: 'hub', args: 'new 直して' })
  expect(posts).toContain('POST http://127.0.0.1:7860/api/sessions')
})

test('見張り: 作業ツリーの中では main への切り替えを止める(CC Hub につながっているとき)', async ($, on) => {
  const posts: string[] = []
  fakeHub(on, posts)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: 'D:\\WorkTree\\P\\wt-02', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 20 && !posts.some((p) => p.includes('/api/mod/overview')); i++) await wait(5)
  await wait(20)
  const r = await $.tool.call({ tool: 'Bash', command: 'git checkout main' })
  expect(JSON.stringify(r)).toContain('作業用のブランチ')
  const ok = await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(JSON.stringify(ok)).not.toContain('CC Hub')
})

test('イベントの送信: 今までの hooks が無ければ CC Hub に送り、あれば送らない(二重にしない)', async ($, on) => {
  const posts: string[] = []
  fakeHub(on, posts)
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: 'C:\proj', surface: null, isInteractive: false })
  await $.classic.SessionStart({ source: 'startup' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(posts.filter((p) => p === 'POST http://127.0.0.1:7860/ingest/hook').length).toBeGreaterThanOrEqual(2)
})

test('イベントの送信: settings.json に同じ CC Hub への hooks があれば送らない', async ($, on) => {
  const posts: string[] = []
  fakeHub(on, posts, '{"hooks":{"Stop":[{"hooks":[{"type":"http","url":"http://127.0.0.1:7860/ingest/hook"}]}]}}')
  await $.session.start({ cwd: 'C:\proj', surface: null, isInteractive: false })
  await $.classic.SessionStart({ source: 'startup' })
  expect(posts.filter((p) => p.includes('/ingest/')).length).toBe(0)
})
