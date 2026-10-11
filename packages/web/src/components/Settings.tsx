// 設定画面: 通知(Windows / Discord)・アップロード先のサーバー・Claude との連携(CC Hub の MCP)
// デスクトップは中央の表示(上部バーの ⚙)、モバイルは「その他 → 設定」
import { useEffect, useMemo, useState } from 'react';
import type { DiscordBotSettings, DiscordBotStatus, DiscordTarget, NotifySettings, NotifyTopic, RestartStatus, ServerInfo, ServerProtocol } from '@cc-hub/shared';
import { type SettingsTab, useHub } from '../store';
import { api, errText, pick } from '../api';
import {
  DEFAULT_PORT,
  type DiscordTargetEdit,
  PROTOCOL_LABEL,
  type ServerEdit,
  type ServerTestResult,
  TOPIC_LABEL,
  TOPIC_ORDER,
  isDiscordWebhook,
  notifyApi,
  serverApi,
  useServerList,
} from '../ops';
import { useMcp } from '../ext';
import { useRepoList } from '../repo';
import { fmtDate } from '../util';
import { ConfirmModal, Spinner } from './RepoCommon';
import { FolderInput } from './FolderPicker';
import { DeployHistory, ServerCard } from './Deploy';
import { FirebaseMcpSection } from './Firebase';

const SECTIONS: { id: SettingsTab; label: string }[] = [
  { id: 'notify', label: '通知' },
  { id: 'servers', label: 'アップロード先のサーバー' },
  { id: 'mcp', label: 'Claude との連携(MCP)' },
  { id: 'hub', label: 'CC Hub' },
];

export function SettingsScreen({ mobile = false }: { mobile?: boolean }) {
  const tab = useHub((s) => s.settingsTab);
  const setTab = useHub((s) => s.setSettingsTab);
  return (
    <div className={`repo-page settings-page ${mobile ? 'is-mobile' : ''}`}>
      {!mobile && (
        <div className="rp-head">
          <h2 className="rp-title">設定</h2>
        </div>
      )}
      <div className={`pj-tabs ${mobile ? 'is-mobile' : ''}`} role="tablist" aria-label="設定の項目">
        {SECTIONS.map((s) => (
          <button key={s.id} role="tab" aria-selected={tab === s.id} className={`pj-tab ${tab === s.id ? 'on' : ''}`} onClick={() => setTab(s.id)}>
            {s.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'notify' ? <NotifySection mobile={mobile} /> : tab === 'servers' ? <ServersSection /> : tab === 'hub' ? <HubSection /> : <McpSection />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- CC Hub(再起動の予約)

const restartApi = {
  get: async (): Promise<RestartStatus | undefined> => pick<RestartStatus>(await api('/api/restart'), 'restart'),
  request: async (when: 'idle' | 'now', build: boolean): Promise<RestartStatus | undefined> =>
    pick<RestartStatus>(await api('/api/restart', { when, build }), 'restart'),
  cancel: async (): Promise<RestartStatus | undefined> => pick<RestartStatus>(await api('/api/restart/cancel', {}), 'restart'),
};

function HubSection() {
  const [st, setSt] = useState<RestartStatus | null>(null);
  const [build, setBuild] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmNow, setConfirmNow] = useState(false);
  const load = () =>
    restartApi
      .get()
      .then((s) => setSt(s ?? null))
      .catch((e) => setErr(errText(e, '状態を取得できませんでした')));
  useEffect(() => {
    void load();
  }, []);
  // 待っている間 / 再起動中は状態を取り直す(再起動中は接続が切れて失敗するのでそのまま待つ)
  useEffect(() => {
    if (!st || st.state === 'idle') return;
    const t = setInterval(() => void restartApi.get().then((s) => s && setSt(s)).catch(() => undefined), 5000);
    return () => clearInterval(t);
  }, [st?.state]);
  const run = async (fn: () => Promise<RestartStatus | undefined>) => {
    setBusy(true);
    setErr(null);
    try {
      const s = await fn();
      if (s) setSt(s);
    } catch (e) {
      setErr(errText(e, '失敗しました'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="set-sec">
      <section className="rp-card set-card" aria-labelledby="set-restart">
        <div className="set-card-head">
          <h3 id="set-restart" className="set-h">
            CC Hub の再起動
          </h3>
          {st && st.state !== 'idle' && <span className="tag">{st.state === 'waiting' ? '作業が終わるのを待っています' : '再起動しています…'}</span>}
        </div>
        <p className="muted small">
          CC Hub を新しいコードで再起動します。再起動すると CC Hub のセッションは一度止まり、自動で再開します。
          「作業が終わったら再起動」は、実行中・承認待ちのセッションやアップロードが無くなった時点で再起動します。
        </p>
        {err && <div className="rp-alert error">{err}</div>}
        {st?.error && st.state === 'idle' && <div className="rp-alert error">{st.error}</div>}
        {st?.state === 'waiting' && (
          <div className="rp-alert info">
            {st.busy.length ? `待っている作業: ${st.busy.join('、')}` : 'まもなく再起動します'}
            {st.requestedAt ? `(${fmtDate(st.requestedAt)} に予約)` : ''}
          </div>
        )}
        {st?.state === 'restarting' && (
          <div className="rp-alert info">
            <Spinner /> 再起動しています。{st.build ? 'ビルドに 1〜2 分かかります。' : ''}終わったら画面を再読み込みしてください。
          </div>
        )}
        <label className="check-inline set-inline">
          <input type="checkbox" checked={build} onChange={(e) => setBuild(e.target.checked)} disabled={st?.state !== 'idle'} />
          再起動の前にビルドする(コードを変えたあとはオン)
        </label>
        <div className="set-actions">
          {st?.state === 'waiting' ? (
            <button className="btn sm" disabled={busy} onClick={() => void run(restartApi.cancel)}>
              予約を取り消す
            </button>
          ) : (
            <>
              <button className="btn sm danger" disabled={busy || !st || st.state !== 'idle'} onClick={() => setConfirmNow(true)}>
                今すぐ再起動
              </button>
              <span className="spacer" />
              <button className="btn primary sm" disabled={busy || !st || st.state !== 'idle'} onClick={() => void run(() => restartApi.request('idle', build))}>
                作業が終わったら再起動
              </button>
            </>
          )}
        </div>
      </section>
      {confirmNow && (
        <ConfirmModal
          title="今すぐ再起動しますか?"
          confirmLabel="再起動する"
          danger
          onClose={() => setConfirmNow(false)}
          onConfirm={() => {
            setConfirmNow(false);
            void run(() => restartApi.request('now', build));
          }}
        >
          <p>作業中のセッションも止まります(自動で再開しますが、途中の作業は中断されます)。</p>
        </ConfirmModal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 通知

function TopicChecks({ value, onChange, idPrefix }: { value: NotifyTopic[]; onChange: (v: NotifyTopic[]) => void; idPrefix: string }) {
  const toggle = (t: NotifyTopic) => onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t]);
  return (
    <div className="topic-grid" role="group" aria-label="通知する種類">
      {TOPIC_ORDER.map((t) => (
        <label key={t} className={`topic-chip ${value.includes(t) ? 'on' : ''}`} htmlFor={`${idPrefix}-${t}`}>
          <input id={`${idPrefix}-${t}`} type="checkbox" checked={value.includes(t)} onChange={() => toggle(t)} />
          {TOPIC_LABEL[t]}
        </label>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className={`toggle ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="toggle-knob" aria-hidden="true" />
      <span className="toggle-label">{label}</span>
    </button>
  );
}

function NotifySection({ mobile }: { mobile: boolean }) {
  const [saved, setSaved] = useState<NotifySettings | null>(null);
  const [draft, setDraft] = useState<NotifySettings | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [edit, setEdit] = useState<DiscordTarget | 'new' | null>(null);
  const [del, setDel] = useState<DiscordTarget | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const repos = useRepoList();

  const load = () => {
    setLoadErr(null);
    notifyApi
      .get()
      .then((s) => {
        if (!s) throw new Error('設定を取得できませんでした');
        setSaved(s);
        setDraft(s);
      })
      .catch((e) => setLoadErr(errText(e, '設定を取得できませんでした')));
  };
  useEffect(load, []);

  if (loadErr)
    return (
      <div className="rp-alert error" role="alert">
        <span className="rp-alert-ico" aria-hidden="true">
          !
        </span>
        <span>
          {loadErr}{' '}
          <button className="link-btn" onClick={load}>
            再試行
          </button>
        </span>
      </div>
    );
  if (!saved || !draft)
    return (
      <div className="empty">
        <Spinner /> 読み込み中…
      </div>
    );

  const dirty = JSON.stringify({ w: draft.windows, t: draft.throttleSeconds }) !== JSON.stringify({ w: saved.windows, t: saved.throttleSeconds });

  /** 保存(Discord の送信先は discord を差し替えて送る。Windows の編集中の内容は送らない) */
  const put = async (next: Omit<NotifySettings, 'discord'> & { discord: DiscordTargetEdit[] }) => {
    const r = await notifyApi.put(next);
    const s = r ?? (next as NotifySettings);
    setSaved(s);
    return s;
  };

  const saveWindows = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const s = await put({ ...saved, windows: draft.windows, throttleSeconds: draft.throttleSeconds });
      setDraft((d) => (d ? { ...d, windows: s.windows, throttleSeconds: s.throttleSeconds } : d));
      setMsg({ ok: true, text: '保存しました' });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, '保存に失敗しました') });
    } finally {
      setBusy(false);
    }
  };

  const saveDiscord = async (list: DiscordTargetEdit[]) => {
    const s = await put({ ...saved, discord: list });
    setDraft((d) => (d ? { ...d, discord: s.discord } : d));
  };

  const test = async (channel: 'windows' | 'discord', id?: string) => {
    const key = id ?? channel;
    setTesting(key);
    setMsg(null);
    try {
      await notifyApi.test(channel, id);
      setMsg({ ok: true, text: channel === 'windows' ? 'Windows の通知を送りました' : 'Discord にテストを送りました' });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'テスト送信に失敗しました') });
    } finally {
      setTesting(null);
    }
  };

  const repoName = (id: string) => repos.find((r) => r.id === id)?.name ?? id;
  const w = draft.windows;
  const setW = (p: Partial<NotifySettings['windows']>) => setDraft({ ...draft, windows: { ...w, ...p } });

  return (
    <div className="set-sec">
      {msg && (
        <div className={`set-msg ${msg.ok ? 'ok' : 'ng'}`} role="status">
          {msg.ok ? '✓' : '✗'} {msg.text}
        </div>
      )}

      <section className="rp-card set-card" aria-labelledby="set-win">
        <div className="set-card-head">
          <h3 id="set-win" className="set-h">
            Windows の通知
          </h3>
          <span className="spacer" />
          <Toggle checked={w.enabled} onChange={(v) => setW({ enabled: v })} label={w.enabled ? 'オン' : 'オフ'} />
        </div>
        <p className="muted small">PC の右下に通知を出します。デスクトップアプリが起動していればアプリから、なければ CC Hub が直接出します。</p>
        <fieldset className="set-field" disabled={!w.enabled}>
          <legend>通知する種類</legend>
          <TopicChecks idPrefix="win" value={w.topics} onChange={(topics) => setW({ topics })} />
        </fieldset>
        <label className="check-inline set-inline">
          <input type="checkbox" checked={w.suppressWhenViewing} onChange={(e) => setW({ suppressWhenViewing: e.target.checked })} disabled={!w.enabled} />
          表示中のセッションは通知しない(アプリでそのセッションを開いているとき。Discord は 2 分以上操作がなければ送ります)
        </label>
        <label className="field set-throttle">
          <span>同じセッション・同じ種類の通知の間隔(秒)</span>
          <input
            type="number"
            min={0}
            max={3600}
            className="num-input"
            value={draft.throttleSeconds}
            onChange={(e) => setDraft({ ...draft, throttleSeconds: Math.max(0, parseInt(e.target.value || '0', 10) || 0) })}
          />
          <span className="hint">この秒数より短い間隔の通知はまとめます(Windows / Discord 共通)。0 = まとめない</span>
        </label>
        <div className="set-actions">
          <button className="btn sm" onClick={() => void test('windows')} disabled={testing !== null || !saved.windows.enabled}>
            {testing === 'windows' ? '送信中…' : 'テスト送信'}
          </button>
          <span className="spacer" />
          {dirty && <span className="warn-text small">未保存の変更があります</span>}
          {dirty && (
            <button className="btn sm" onClick={() => setDraft({ ...draft, windows: saved.windows, throttleSeconds: saved.throttleSeconds })}>
              元に戻す
            </button>
          )}
          <button className="btn primary sm" disabled={!dirty || busy} onClick={() => void saveWindows()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </section>

      <section className="rp-card set-card" aria-labelledby="set-dc">
        <div className="set-card-head">
          <h3 id="set-dc" className="set-h">
            Discord の通知 <span className="count-pill">{saved.discord.length}</span>
          </h3>
          <span className="spacer" />
          <button className="btn primary sm" onClick={() => setEdit('new')}>
            + 送信先を追加
          </button>
        </div>
        <p className="muted small">
          Discord のチャンネルに通知を送ります。リポジトリごとに別のチャンネルへ送ることもできます(例: 「全体」と「TomsLands」)。
        </p>
        {saved.discord.length === 0 ? (
          <div className="empty small">送信先はまだありません。下の手順で Webhook の URL を用意して追加してください。</div>
        ) : (
          <ul className="dc-list">
            {saved.discord.map((t) => (
              <li key={t.id} className={`dc-row ${t.enabled ? '' : 'off'}`}>
                <div className="dc-main">
                  <div className="dc-top">
                    <span className="dc-name">{t.name}</span>
                    <span className="mono muted small" title="Webhook の URL(末尾だけ表示)">
                      {t.webhookMasked}
                    </span>
                    {!t.enabled && <span className="tag ro">停止中</span>}
                  </div>
                  <div className="dc-sub small">
                    <span className="dc-k">対象</span>
                    {t.repoIds.length === 0 ? 'すべてのプロジェクト' : t.repoIds.map(repoName).join('、')}
                  </div>
                  <div className="dc-sub small">
                    <span className="dc-k">種類</span>
                    {t.topics.length === 0 ? <span className="warn-text">なし(通知しません)</span> : TOPIC_ORDER.filter((x) => t.topics.includes(x)).map((x) => TOPIC_LABEL[x]).join('・')}
                  </div>
                </div>
                <div className="dc-acts">
                  <Toggle
                    checked={t.enabled}
                    label={t.enabled ? 'オン' : 'オフ'}
                    onChange={(v) => void saveDiscord(saved.discord.map((x) => (x.id === t.id ? { ...x, enabled: v } : x))).catch((e) => setMsg({ ok: false, text: errText(e, '保存に失敗しました') }))}
                  />
                  <button className="btn sm" onClick={() => void test('discord', t.id)} disabled={testing !== null || !t.enabled}>
                    {testing === t.id ? '送信中…' : 'テスト送信'}
                  </button>
                  <button className="btn sm" onClick={() => setEdit(t)}>
                    編集
                  </button>
                  <button className="btn sm danger" onClick={() => setDel(t)} aria-label={`${t.name} を削除`}>
                    削除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <details className="set-help" open={saved.discord.length === 0 || undefined}>
          <summary>Discord の Webhook URL の作り方</summary>
          <ol>
            <li>Discord で通知を送りたいチャンネルの「⚙ チャンネルの設定」を開く</li>
            <li>「連携サービス」→「ウェブフック」を開く</li>
            <li>「新しいウェブフック」を押す(名前やアイコンは自由。例: CC Hub)</li>
            <li>「ウェブフック URL をコピー」を押す</li>
            <li>この画面の「+ 送信先を追加」で URL を貼り付けて保存し、「テスト送信」で届くか確認する</li>
          </ol>
          <p className="set-lock">🔒 URL はこの PC の CC Hub にだけ暗号化して保存されます。画面には末尾の数文字しか表示されず、Claude にも渡しません。</p>
        </details>
      </section>

      <BotCard
        bot={saved.bot ?? { enabled: false, allowedUserIds: [], hasToken: false, approvalChannelId: '' }}
        save={async (bot) => {
          const s = await put({ ...saved, bot });
          setDraft((d) => (d ? { ...d, bot: s.bot } : d));
          return s;
        }}
        reload={async () => {
          const s = await notifyApi.get();
          if (s) {
            setSaved(s);
            setDraft((d) => (d ? { ...d, bot: s.bot } : d));
          }
        }}
      />

      {edit && (
        <DiscordModal
          target={edit === 'new' ? null : edit}
          mobile={mobile}
          onClose={() => setEdit(null)}
          onSave={async (t) => {
            const list: DiscordTargetEdit[] = edit === 'new' ? [...saved.discord, t] : saved.discord.map((x) => (x.id === t.id ? t : x));
            await saveDiscord(list);
            setEdit(null);
            setMsg({ ok: true, text: `「${t.name}」を保存しました` });
          }}
        />
      )}
      {del && (
        <ConfirmModal
          title="送信先を削除しますか?"
          confirmLabel="削除する"
          danger
          onClose={() => setDel(null)}
          onConfirm={() => {
            const t = del;
            setDel(null);
            void saveDiscord(saved.discord.filter((x) => x.id !== t.id))
              .then(() => setMsg({ ok: true, text: `「${t.name}」を削除しました` }))
              .catch((e) => setMsg({ ok: false, text: errText(e, '削除に失敗しました') }));
          }}
        >
          <p>
            「<b>{del.name}</b>」への通知を止めて、保存している Webhook URL を削除します。
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}

const BOT_STATE_LABEL: Record<DiscordBotStatus['state'], string> = {
  off: '停止中',
  connecting: '接続中…',
  connected: '接続済み',
  error: 'エラー',
};

/** Discord Bot: 通知への返信をセッションに届ける */
function BotCard({
  bot,
  save,
  reload,
}: {
  bot: DiscordBotSettings;
  save: (b: DiscordBotSettings & { token?: string; clearToken?: boolean }) => Promise<NotifySettings>;
  reload: () => Promise<void>;
}) {
  const [token, setToken] = useState('');
  const [ids, setIds] = useState(bot.allowedUserIds.join(', '));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const st = bot.status ?? { state: 'off' as const, user: null, error: null };
  // 接続中の間は状態を取り直す
  useEffect(() => {
    if (st.state !== 'connecting') return;
    const t = setTimeout(() => void reload().catch(() => undefined), 3000);
    return () => clearTimeout(t);
  }, [st.state, bot, reload]);
  const [approvalCh, setApprovalCh] = useState(bot.approvalChannelId ?? '');
  const idList = ids.split(/[\s,、]+/).map((x) => x.trim()).filter(Boolean);
  const badIds = idList.filter((x) => !/^\d{15,25}$/.test(x));
  const ch = approvalCh.trim();
  const badCh = !!ch && !/^\d{15,25}$/.test(ch);
  const dirty = !!token.trim() || idList.join(',') !== bot.allowedUserIds.join(',') || ch !== (bot.approvalChannelId ?? '');
  const run = async (patch: Partial<DiscordBotSettings> & { token?: string; clearToken?: boolean }, done: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await save({ ...bot, allowedUserIds: idList, approvalChannelId: ch, ...(token.trim() ? { token: token.trim() } : {}), ...patch });
      setToken('');
      setMsg({ ok: true, text: done });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, '保存に失敗しました') });
    } finally {
      setBusy(false);
    }
  };
  const canEnable = bot.hasToken || !!token.trim();
  return (
    <section className="rp-card set-card" aria-labelledby="set-bot">
      <div className="set-card-head">
        <h3 id="set-bot" className="set-h">
          Discord への返信(Bot)
        </h3>
        <span className={`tag bot-st bot-${st.state}`}>
          {BOT_STATE_LABEL[st.state]}
          {st.state === 'connected' && st.user ? `: ${st.user}` : ''}
        </span>
        <span className="spacer" />
        <Toggle
          checked={bot.enabled}
          label={bot.enabled ? 'オン' : 'オフ'}
          onChange={(v) => {
            if (v && !canEnable) {
              setMsg({ ok: false, text: '先にトークンを入力してください' });
              return;
            }
            void run({ enabled: v }, v ? 'Bot を有効にしました' : 'Bot を停止しました');
          }}
        />
      </div>
      <p className="muted small">
        Discord に届いた通知に「返信」すると、その通知にスレッドを作り、そのセッションへの横からの質問(/btw のように)として会話の内容をもとに答えます。
        続けての質問はスレッドに書くだけで、それまでのやり取りも踏まえて答えます。
        セッションには送らないので作業は止まりません。作業の指示やセッション中の承認は CC Hub から行ってください。
        承認用チャンネルを設定すると、アップロード / Firebase デプロイの承認待ちを Bot がボタン付きで投稿し、押すだけで承認・却下できます。
      </p>
      {msg && (
        <div className={`set-msg ${msg.ok ? 'ok' : 'ng'}`} role="status">
          {msg.ok ? '✓' : '✗'} {msg.text}
        </div>
      )}
      {st.error && <div className="rp-alert error">{st.error}</div>}
      <label className="field">
        <span>Bot のトークン{bot.hasToken ? '(保存済み。変えるときだけ入力)' : ''}</span>
        <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={bot.hasToken ? '••••••••(保存済み)' : 'Developer Portal の Bot → Reset Token で表示されるもの'} />
      </label>
      <label className="field">
        <span>返信を受け付けるユーザー ID(カンマ区切り)</span>
        <input value={ids} onChange={(e) => setIds(e.target.value)} placeholder="例: 123456789012345678" />
        {badIds.length > 0 ? (
          <span className="warn-text small">ユーザー ID は数字です: {badIds.join(', ')}</span>
        ) : (
          <span className="hint">ここにあるユーザーの返信と承認ボタンだけを受け付けます。ほかの人が返信すると、その人の ID を案内する返事をします。</span>
        )}
      </label>
      <label className="field">
        <span>承認ボタンを出すチャンネル ID(空 = 出さない)</span>
        <input className="mono" value={approvalCh} onChange={(e) => setApprovalCh(e.target.value)} placeholder="例: 123456789012345678" />
        {badCh ? (
          <span className="warn-text small">チャンネル ID は数字です</span>
        ) : (
          <span className="hint">
            開発者モードでチャンネル名を右クリック →「チャンネル ID をコピー」。ボタン付きのメッセージは Webhook では送れないため、Bot がこのチャンネルに投稿します(Bot にチャンネルの表示・メッセージの送信の権限が必要)。
            同じ申請の通知が二重に届かないよう、Webhook の送信先では「アップロードの申請」のチェックを外してください。
          </span>
        )}
      </label>
      <div className="set-actions">
        {bot.hasToken && (
          <button className="btn sm danger" disabled={busy} onClick={() => void run({ enabled: false, clearToken: true }, 'トークンを削除しました')}>
            トークンを削除
          </button>
        )}
        <button
          className="btn sm"
          disabled={busy || dirty || st.state !== 'connected' || !bot.approvalChannelId}
          title={dirty ? '先に保存してください' : '押しても何も起きない承認ボタンを承認用チャンネルに送ります'}
          onClick={() => {
            setBusy(true);
            setMsg(null);
            notifyApi
              .test('approval')
              .then(() => setMsg({ ok: true, text: '承認用チャンネルにテストの承認ボタンを送りました(押しても何も起きません)' }))
              .catch((e) => setMsg({ ok: false, text: errText(e, 'テスト送信に失敗しました') }))
              .finally(() => setBusy(false));
          }}
        >
          承認ボタンのテスト送信
        </button>
        <span className="spacer" />
        <button className="btn primary sm" disabled={!dirty || busy || badIds.length > 0 || badCh} onClick={() => void run({}, '保存しました')}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
      <details className="set-help" open={!bot.hasToken || undefined}>
        <summary>Bot の作り方(無料)</summary>
        <ol>
          <li>
            <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">
              Discord Developer Portal
            </a>
            で「New Application」を押し、名前(例: CC Hub)を付けて作る
          </li>
          <li>左の「Bot」を開き、「Reset Token」でトークンを表示してコピーし、上の「Bot のトークン」に貼る</li>
          <li>同じ「Bot」の画面の「Privileged Gateway Intents」で「MESSAGE CONTENT INTENT」をオンにして保存する</li>
          <li>
            左の「OAuth2」→「URL Generator」で「bot」にチェックし、Bot Permissions で「View Channels」「Send Messages」「Read Message History」「Create Public Threads」「Send Messages in Threads」にチェックして、下に出た URL を開き、通知を送っているサーバーに招待する(招待済みなら、サーバー設定 → ロールで Bot のロールに後の 2 つを追加する)
          </li>
          <li>
            自分のユーザー ID を調べる: Discord の「ユーザー設定」→「詳細設定」で「開発者モード」をオンにし、自分のアイコンを右クリック →「ユーザー ID をコピー」。上の欄に貼る
          </li>
          <li>保存して右上のスイッチをオンにし、「接続済み」になれば完了。Discord の通知に返信して質問してみてください</li>
        </ol>
        <p className="set-lock">🔒 トークンはこの PC の CC Hub にだけ暗号化して保存され、画面にも Claude にも渡しません。</p>
      </details>
    </section>
  );
}

function DiscordModal({
  target,
  mobile,
  onClose,
  onSave,
}: {
  target: DiscordTarget | null;
  mobile: boolean;
  onClose: () => void;
  onSave: (t: DiscordTargetEdit) => Promise<void>;
}) {
  const repos = useRepoList();
  const [name, setName] = useState(target?.name ?? '');
  const [url, setUrl] = useState('');
  const [show, setShow] = useState(false);
  const [repoIds, setRepoIds] = useState<string[]>(target?.repoIds ?? []);
  const [topics, setTopics] = useState<NotifyTopic[]>(target?.topics ?? ['approval', 'error', 'pr_ci_failed', 'deploy_request', 'deploy_done']);
  const [enabled, setEnabled] = useState(target?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const urlOk = url.trim() === '' ? !!target : isDiscordWebhook(url);
  const can = name.trim() !== '' && urlOk && !busy;
  const toggleRepo = (id: string) => setRepoIds((v) => (v.includes(id) ? v.filter((x) => x !== id) : [...v, id]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!can) return;
    setBusy(true);
    setErr(null);
    try {
      const t: DiscordTargetEdit = {
        id: target?.id ?? `dc-${Date.now().toString(36)}`,
        name: name.trim(),
        webhookMasked: target?.webhookMasked ?? '',
        repoIds,
        topics,
        enabled,
      };
      if (url.trim()) t.webhookUrl = url.trim();
      await onSave(t);
    } catch (e2) {
      setErr(errText(e2, '保存に失敗しました'));
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="dc-title">
        <div className="modal-head">
          <h2 id="dc-title">{target ? `送信先を編集 — ${target.name}` : 'Discord の送信先を追加'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        <form className="modal-body form" onSubmit={submit}>
          <label className="field">
            <span>名前</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例: 全体 / TomsLands" autoFocus={!mobile} />
          </label>
          <div className="field">
            <span id="dc-url-l">Webhook URL</span>
            <div className="secret-input">
              <input
                type={show ? 'text' : 'password'}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={target ? `保存済み(${target.webhookMasked})。変更するときだけ貼り付け` : 'https://discord.com/api/webhooks/…'}
                className="mono"
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                aria-labelledby="dc-url-l"
              />
              <button type="button" className="btn" onClick={() => setShow((v) => !v)} aria-pressed={show}>
                {show ? '隠す' : '表示'}
              </button>
            </div>
            <span className="hint">
              {url.trim() && !isDiscordWebhook(url) ? (
                <span className="warn-text">Discord の Webhook URL(https://discord.com/api/webhooks/…)を貼り付けてください</span>
              ) : target ? (
                '空のままなら今の URL を使い続けます'
              ) : (
                'チャンネルの設定 → 連携サービス → ウェブフック → 新しいウェブフック → URL をコピー'
              )}
            </span>
          </div>
          <fieldset className="set-field">
            <legend>対象のプロジェクト(何も選ばなければ すべて)</legend>
            {repos.length === 0 ? (
              <span className="muted small">登録したリポジトリはありません(すべてのプロジェクトが対象)</span>
            ) : (
              <div className="topic-grid">
                {repos.map((r) => (
                  <label key={r.id} className={`topic-chip ${repoIds.includes(r.id) ? 'on' : ''}`}>
                    <input type="checkbox" checked={repoIds.includes(r.id)} onChange={() => toggleRepo(r.id)} />
                    {r.name}
                  </label>
                ))}
              </div>
            )}
            <span className="hint">{repoIds.length === 0 ? 'すべてのプロジェクトの通知を送ります' : `${repoIds.length} 件のリポジトリの通知だけ送ります`}</span>
          </fieldset>
          <fieldset className="set-field">
            <legend>通知する種類</legend>
            <TopicChecks idPrefix="dc" value={topics} onChange={setTopics} />
          </fieldset>
          <label className="check-inline">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            この送信先を使う
          </label>
          <p className="set-lock small">🔒 URL はこの PC の CC Hub にだけ暗号化して保存されます。</p>
          {err && <div className="form-error">{err}</div>}
          <div className="modal-foot">
            <button type="button" className="btn" onClick={onClose}>
              キャンセル
            </button>
            <button type="submit" className="btn primary" disabled={!can}>
              {busy ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- アップロード先のサーバー

function ServersSection() {
  const servers = useServerList();
  const [edit, setEdit] = useState<ServerInfo | 'new' | null>(null);
  const [del, setDel] = useState<ServerInfo | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, ServerTestResult | 'busy'>>({});

  const runTest = async (id: string) => {
    setTests((t) => ({ ...t, [id]: 'busy' }));
    try {
      const r = await serverApi.test(id);
      setTests((t) => ({ ...t, [id]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [id]: { ok: false, message: errText(e, '接続テストに失敗しました') } }));
    }
  };

  return (
    <div className="set-sec">
      <div className="set-intro">
        <p className="muted small">
          作った Web サイトをレンタルサーバーに FTP / FTPS / SFTP でアップロードします。Claude はサーバーの名前や公開 URL を見てアップロードを<b>申請</b>できますが、送るのはあなたが承認してからです。パスワードは Claude には見えません。
        </p>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setEdit('new')}>
          + サーバーを追加
        </button>
      </div>
      {servers.length === 0 ? (
        <div className="rp-empty in-modal">
          <p>アップロード先のサーバーはまだありません。</p>
          <p className="muted small">レンタルサーバーの管理画面で FTP / SFTP のホスト名・ユーザー名・パスワードを確認して追加してください。</p>
        </div>
      ) : (
        <div className="srv-cards">
          {servers.map((s) => {
            const t = tests[s.id];
            return (
              <div key={s.id} className="srv-wrap">
                <ServerCard
                  s={s}
                  actions={
                    <>
                      <button className="btn sm" onClick={() => void runTest(s.id)} disabled={t === 'busy'}>
                        {t === 'busy' ? '接続中…' : '接続テスト'}
                      </button>
                      <button className="btn sm" onClick={() => setEdit(s)}>
                        編集
                      </button>
                      <button className="btn sm danger" onClick={() => setDel(s)} aria-label={`${s.name} を削除`}>
                        削除
                      </button>
                    </>
                  }
                />
                {t && t !== 'busy' && <TestResult r={t} onClose={() => setTests((x) => ({ ...x, [s.id]: undefined as never }))} />}
              </div>
            );
          })}
        </div>
      )}
      <section className="rp-sec">
        <h3 className="sec-title">アップロードの履歴</h3>
        <DeployHistory />
      </section>
      {edit && <ServerModal server={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {del && (
        <ConfirmModal
          title="サーバーを削除しますか?"
          confirmLabel="削除する"
          danger
          busy={delBusy}
          error={delErr}
          onClose={() => {
            setDel(null);
            setDelErr(null);
          }}
          onConfirm={async () => {
            setDelBusy(true);
            setDelErr(null);
            try {
              await serverApi.remove(del.id);
              useHub.getState().removeServer(del.id);
              setDel(null);
            } catch (e) {
              setDelErr(errText(e, '削除に失敗しました'));
            } finally {
              setDelBusy(false);
            }
          }}
        >
          <p>
            「<b>{del.name}</b>」({del.host})の設定と保存しているパスワードを削除します。サーバー上のファイルは消えません。
          </p>
        </ConfirmModal>
      )}
    </div>
  );
}

function TestResult({ r, onClose }: { r: ServerTestResult; onClose?: () => void }) {
  return (
    <div className={`srv-result ${r.ok ? 'ok' : 'ng'}`} role="status">
      <div className="srv-result-head">
        <b>{r.ok ? '✓ 接続できました' : '✗ 接続できませんでした'}</b>
        <span className="spacer" />
        {onClose && (
          <button className="icon-btn" onClick={onClose} aria-label="結果を閉じる">
            ✕
          </button>
        )}
      </div>
      <div className="srv-result-msg">{r.message}</div>
      {r.entries && r.entries.length > 0 && (
        <>
          <div className="small muted">アップロード先のフォルダの中身({r.entries.length} 件)</div>
          <ul className="srv-entries mono">
            {r.entries.slice(0, 30).map((e) => (
              <li key={e}>{e}</li>
            ))}
            {r.entries.length > 30 && <li className="muted">… ほか {r.entries.length - 30} 件</li>}
          </ul>
        </>
      )}
    </div>
  );
}

interface ServerForm {
  name: string;
  protocol: ServerProtocol;
  host: string;
  port: string;
  username: string;
  authType: 'password' | 'key';
  keyPath: string;
  secret: string;
  remoteDir: string;
  publicUrl: string;
  defaultLocalDir: string;
  buildCommand: string;
  exclude: string;
  deleteExtra: boolean;
  note: string;
}

function formOf(s: ServerInfo | null): ServerForm {
  return {
    name: s?.name ?? '',
    protocol: s?.protocol ?? 'sftp',
    host: s?.host ?? '',
    port: String(s?.port ?? 22),
    username: s?.username ?? '',
    authType: s?.auth.type ?? 'password',
    keyPath: s?.auth.keyPath ?? '',
    secret: '',
    remoteDir: s?.remoteDir ?? '/public_html',
    publicUrl: s?.publicUrl ?? '',
    defaultLocalDir: s?.defaultLocalDir ?? '',
    buildCommand: s?.buildCommand ?? '',
    exclude: (s?.exclude ?? []).join('\n'),
    deleteExtra: s?.deleteExtra ?? false,
    note: s?.note ?? '',
  };
}

function ServerModal({ server, onClose }: { server: ServerInfo | null; onClose: () => void }) {
  const [f, setF] = useState<ServerForm>(() => formOf(server));
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(server?.id ?? null);
  const [result, setResult] = useState<ServerTestResult | null>(null);
  const live = useHub((s) => (savedId ? s.servers[savedId] : undefined));
  const hasSecret = live?.auth.hasSecret ?? server?.auth.hasSecret ?? false;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof ServerForm>(k: K, v: ServerForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const setProto = (p: ServerProtocol) =>
    setF((x) => ({
      ...x,
      protocol: p,
      // ポートが既定値のままなら新しい方式の既定に合わせる
      port: Object.values(DEFAULT_PORT).map(String).includes(x.port) || !x.port ? String(DEFAULT_PORT[p]) : x.port,
      authType: p === 'sftp' ? x.authType : 'password',
    }));
  const port = parseInt(f.port, 10);
  const portOk = Number.isFinite(port) && port > 0 && port < 65536;
  const urlOk = !f.publicUrl.trim() || /^https?:\/\//.test(f.publicUrl.trim());
  const needSecret = !hasSecret && f.authType === 'password' && !f.secret;
  const can = !!f.name.trim() && !!f.host.trim() && !!f.username.trim() && !!f.remoteDir.trim() && portOk && urlOk && !needSecret && busy === null;

  const body = (): ServerEdit => {
    const b: ServerEdit = {
      name: f.name.trim(),
      protocol: f.protocol,
      host: f.host.trim(),
      port,
      username: f.username.trim(),
      auth: f.authType === 'key' ? { type: 'key', keyPath: f.keyPath.trim() } : { type: 'password' },
      remoteDir: f.remoteDir.trim(),
      publicUrl: f.publicUrl.trim() || null,
      defaultLocalDir: f.defaultLocalDir.trim() || null,
      buildCommand: f.buildCommand.trim() || null,
      exclude: f.exclude
        .split(/[\n,]/)
        .map((x) => x.trim())
        .filter(Boolean),
      deleteExtra: f.deleteExtra,
      note: f.note.trim(),
    };
    if (f.secret) b.secret = f.secret;
    return b;
  };

  const save = async (andTest: boolean) => {
    if (!can) return;
    setBusy(andTest ? 'test' : 'save');
    setErr(null);
    setResult(null);
    try {
      const r = savedId ? await serverApi.patch(savedId, body()) : await serverApi.create(body());
      if (r) useHub.getState().upsertServer(r);
      const id = r?.id ?? savedId;
      setSavedId(id);
      setF((x) => ({ ...x, secret: '' }));
      if (!andTest) {
        onClose();
        return;
      }
      if (id) setResult(await serverApi.test(id));
    } catch (e) {
      setErr(errText(e, '保存に失敗しました'));
    } finally {
      setBusy(null);
    }
  };

  const secretLabel = f.authType === 'key' ? '秘密鍵のパスフレーズ' : 'パスワード';
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal srv-modal" role="dialog" aria-modal="true" aria-labelledby="srv-title">
        <div className="modal-head">
          <h2 id="srv-title">{server ? `サーバーを編集 — ${server.name}` : 'アップロード先のサーバーを追加'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="閉じる">
            ✕
          </button>
        </div>
        <form
          className="modal-body form"
          onSubmit={(e) => {
            e.preventDefault();
            void save(false);
          }}
        >
          <label className="field">
            <span>名前</span>
            <input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="例: ポートフォリオ本番" />
          </label>
          <div className="field">
            <span id="srv-proto">接続方式</span>
            <div className="seg-btns" role="radiogroup" aria-labelledby="srv-proto">
              {(['ftp', 'ftps', 'sftp'] as ServerProtocol[]).map((p) => (
                <button key={p} type="button" role="radio" aria-checked={f.protocol === p} className={`btn sm ${f.protocol === p ? 'on' : ''}`} onClick={() => setProto(p)}>
                  {PROTOCOL_LABEL[p]}
                </button>
              ))}
            </div>
            <span className="hint">
              {f.protocol === 'ftp' ? (
                <span className="warn-text">FTP は通信が暗号化されません。サーバーが対応していれば FTPS か SFTP を選んでください。</span>
              ) : f.protocol === 'ftps' ? (
                'FTP over TLS(明示的)。多くのレンタルサーバーで使えます'
              ) : (
                'SSH で接続します(パスワード または 秘密鍵)'
              )}
            </span>
          </div>
          <div className="srv-row">
            <label className="field grow">
              <span>ホスト名</span>
              <input className="mono" value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="sv1234.example.ne.jp" spellCheck={false} autoCapitalize="off" />
            </label>
            <label className="field">
              <span>ポート</span>
              <input className="num-input mono" inputMode="numeric" value={f.port} onChange={(e) => set('port', e.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>ユーザー名</span>
            <input className="mono" value={f.username} onChange={(e) => set('username', e.target.value)} spellCheck={false} autoCapitalize="off" autoComplete="off" />
          </label>
          {f.protocol === 'sftp' && (
            <div className="field">
              <span id="srv-auth">認証</span>
              <div className="seg-btns" role="radiogroup" aria-labelledby="srv-auth">
                <button type="button" role="radio" aria-checked={f.authType === 'password'} className={`btn sm ${f.authType === 'password' ? 'on' : ''}`} onClick={() => set('authType', 'password')}>
                  パスワード
                </button>
                <button type="button" role="radio" aria-checked={f.authType === 'key'} className={`btn sm ${f.authType === 'key' ? 'on' : ''}`} onClick={() => set('authType', 'key')}>
                  秘密鍵
                </button>
              </div>
            </div>
          )}
          {f.authType === 'key' && (
            <label className="field">
              <span>秘密鍵のファイル</span>
              <input className="mono" value={f.keyPath} onChange={(e) => set('keyPath', e.target.value)} placeholder="C:\Users\yanor\.ssh\id_ed25519" spellCheck={false} />
            </label>
          )}
          <div className="field">
            <span id="srv-secret">
              {secretLabel}
              {f.authType === 'key' && '(なければ空)'}
            </span>
            <div className="secret-input">
              <input
                type={show ? 'text' : 'password'}
                value={f.secret}
                onChange={(e) => set('secret', e.target.value)}
                placeholder={hasSecret ? '保存済み。変更するときだけ入力' : ''}
                autoComplete="new-password"
                aria-labelledby="srv-secret"
              />
              <button type="button" className="btn" onClick={() => setShow((v) => !v)} aria-pressed={show}>
                {show ? '隠す' : '表示'}
              </button>
            </div>
            <span className="hint">
              {hasSecret ? <span className="ok-text">✓ 保存済み</span> : null} この PC の CC Hub にだけ暗号化して保存します。画面にも Claude にも表示されません。
            </span>
          </div>
          <label className="field">
            <span>アップロード先のフォルダ(サーバー側)</span>
            <input className="mono" value={f.remoteDir} onChange={(e) => set('remoteDir', e.target.value)} placeholder="/public_html/portfolio" spellCheck={false} />
          </label>
          <label className="field">
            <span>公開 URL(任意)</span>
            <input className="mono" value={f.publicUrl} onChange={(e) => set('publicUrl', e.target.value)} placeholder="https://example.com/portfolio/" inputMode="url" spellCheck={false} />
            {!urlOk && <span className="hint warn-text">https:// から入力してください</span>}
          </label>
          <div className="field">
            <span>送るフォルダ(PC 側の既定。空なら毎回指定)</span>
            <FolderInput value={f.defaultLocalDir} onChange={(v) => set('defaultLocalDir', v)} label="送るフォルダ" placeholder="D:\WorkTree\portfolio\dist" />
            <span className="hint">このフォルダを含むプロジェクトの「公開」タブに、このサーバーが表示されます。</span>
          </div>
          <label className="field">
            <span>先に実行するビルドコマンド(任意)</span>
            <input className="mono" value={f.buildCommand} onChange={(e) => set('buildCommand', e.target.value)} placeholder="npm run build" spellCheck={false} />
          </label>
          <label className="field">
            <span>送らないもの(1 行に 1 つ。* が使えます)</span>
            <textarea className="mono" rows={3} value={f.exclude} onChange={(e) => set('exclude', e.target.value)} placeholder={'*.map\n.env*'} spellCheck={false} />
            <span className="hint">.git / node_modules / .cc-hub は常に送りません。</span>
          </label>
          <label className={`check-field ${f.deleteExtra ? 'danger-on' : ''}`}>
            <input type="checkbox" checked={f.deleteExtra} onChange={(e) => set('deleteExtra', e.target.checked)} />
            <span>
              サーバーにだけあるファイルを削除する
              <span className="hint">
                ⚠ PC のフォルダに無いファイルをサーバーから消して、まったく同じ状態にします。サーバーに手で置いたファイル(.htaccess や画像など)も消えるので、アップロード先のフォルダが正しいか確認してから有効にしてください。消すファイルは差分の確認で赤く表示されます。
              </span>
            </span>
          </label>
          <label className="field">
            <span>メモ(任意。Claude にも見えます)</span>
            <input value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="例: 本番。公開前に必ずローカルで確認" />
          </label>
          {result && <TestResult r={result} />}
          {err && <div className="form-error">{err}</div>}
          {needSecret && <div className="hint right">{secretLabel}を入力してください</div>}
          <div className="modal-foot">
            <button type="button" className="btn" onClick={onClose}>
              {result ? '閉じる' : 'キャンセル'}
            </button>
            <button type="button" className="btn" disabled={!can} onClick={() => void save(true)}>
              {busy === 'test' ? <><Spinner /> 接続中…</> : '保存して接続テスト'}
            </button>
            <button type="submit" className="btn primary" disabled={!can}>
              {busy === 'save' ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Claude との連携(MCP)

const MCP_TOOLS: { name: string; desc: string }[] = [
  { name: 'list_servers', desc: 'アップロード先のサーバーの一覧(名前・公開 URL・既定のフォルダ。パスワードは含みません)' },
  { name: 'request_deploy', desc: 'アップロードを申請する(承認キューに届き、あなたが承認するまで送りません)' },
  { name: 'get_deploy_status', desc: '申請したアップロードの状態・URL・エラーを見る' },
  { name: 'get_project_instructions', desc: 'プロジェクトの共通の指示を読む' },
  { name: 'update_project_instructions', desc: '共通の指示を書き換える(200 行を超えると警告を返します)' },
  { name: 'list_sessions / get_session', desc: 'CC Hub のセッションの状況を見る(読み取りのみ)' },
];

function McpSection() {
  const mcp = useMcp(null);
  const port = useHub((s) => s.daemon?.port ?? 7860);
  const entry = useMemo(() => mcp.data?.servers.find((s) => s.name === 'cc-hub') ?? null, [mcp.data]);
  return (
    <div className="set-sec">
      <section className="rp-card set-card">
        <h3 className="set-h">Claude から CC Hub を使う</h3>
        <p className="small set-p">
          Claude Code に <span className="mono">cc-hub</span> という MCP サーバーを登録すると、セッションの中の Claude が CC Hub の機能を使えるようになります。たとえば「サイトをポートフォリオ本番にアップロードして」と頼むと、Claude がアップロードを申請し、あなたの承認を待ちます。
        </p>
        <div className={`mcp-reg ${entry ? (entry.status === 'connected' ? 'ok' : 'warn') : 'none'}`} role="status">
          {mcp.loading && !mcp.data ? (
            <>
              <Spinner /> 登録状況を確認しています…
            </>
          ) : entry ? (
            entry.status === 'connected' ? (
              <>✓ cc-hub は登録済みで、接続できています</>
            ) : (
              <>! cc-hub は登録済みですが、接続できていません({entry.statusText})。CC Hub が起動しているか確認してください</>
            )
          ) : (
            <>cc-hub はまだ登録されていません(または確認できませんでした)</>
          )}
          <span className="spacer" />
          <button className="btn sm" onClick={mcp.refresh} disabled={mcp.loading}>
            再確認
          </button>
        </div>
        <p className="small muted">
          登録されていないときは、PowerShell で次のコマンドを実行してください。トークンは自動で読み込まれます(%APPDATA%\cc-hub\mcp-token)。
          まず --apply なしで実行すると、登録内容の確認だけができます。
        </p>
        <pre className="mcp-cmd mono">{`node C:\\Users\\yanor\\cc-hub\\integrations\\mcp\\install.js --apply`}</pre>
        {mcp.data?.checkedAt && <p className="hint">確認: {fmtDate(mcp.data.checkedAt)}</p>}
      </section>
      <section className="rp-card set-card">
        <h3 className="set-h">Claude が使えるツール</h3>
        <ul className="mcp-tools">
          {MCP_TOOLS.map((t) => (
            <li key={t.name}>
              <span className="mono mcp-tool-name">{t.name}</span>
              <span className="small">{t.desc}</span>
            </li>
          ))}
        </ul>
        <p className="small muted">
          Claude はサーバーのパスワードや Discord の URL を見ることはできません。アップロードは必ず承認キュー(上部の「承認待ち」/ スマホの「承認」タブ)であなたが承認してから実行されます。
        </p>
      </section>
      <FirebaseMcpSection />
    </div>
  );
}
