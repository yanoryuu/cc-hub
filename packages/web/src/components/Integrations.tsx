// 設定 →「外部連携」: ジャービスなど外部のアシスタントが CC Hub にセッション起動を頼むための連携トークン(スコープ付き)
import { useCallback, useEffect, useState } from 'react';
import { api, errText } from '../api';
import { fmtDate } from '../util';
import { ConfirmModal, Spinner } from './RepoCommon';

type Scope = 'sessions:start' | 'state:read';

interface TokenInfo {
  id: string;
  name: string;
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
  webhookUrl: string | null;
  hint: string;
}

const SCOPE_LABEL: Record<Scope, { label: string; desc: string }> = {
  'state:read': { label: '状態を見る', desc: 'セッションの一覧・状態・最後の発言を読む。状態が変わったときの通知を受け取る' },
  'sessions:start': { label: 'セッションを起動', desc: '登録済みのプロジェクトで新しいセッションを始める(10 分に 5 回まで)' },
};

const intApi = {
  list: () => api<{ tokens?: TokenInfo[]; subscribers?: number }>('/api/integrations/tokens'),
  create: (body: { name: string; scopes: Scope[]; webhookUrl?: string }) =>
    api<{ info: TokenInfo; token: string; webhookSecret: string | null }>('/api/integrations/tokens', body),
  revoke: (id: string) => api(`/api/integrations/tokens/${encodeURIComponent(id)}`, undefined, { method: 'DELETE' }),
};

function CopyField({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="int-secret">
      <span className="int-secret-label small">{label}</span>
      <code className="int-secret-val mono">{value}</code>
      <button
        className="btn sm"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
      >
        {done ? 'コピーしました' : 'コピー'}
      </button>
    </div>
  );
}

export function IntegrationsSection() {
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [subs, setSubs] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState('ジャービス');
  const [scopes, setScopes] = useState<Scope[]>(['state:read', 'sessions:start']);
  const [hook, setHook] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string; secret: string | null } | null>(null);
  const [revoke, setRevoke] = useState<TokenInfo | null>(null);
  const [revokeErr, setRevokeErr] = useState<string | null>(null);

  const load = useCallback(() => {
    intApi
      .list()
      .then((r) => {
        setTokens(r.tokens ?? []);
        setSubs(r.subscribers ?? 0);
        setErr(null);
      })
      .catch((e) => setErr(errText(e, '読み込めませんでした')));
  }, []);
  useEffect(load, [load]);

  const toggle = (s: Scope) => setScopes((v) => (v.includes(s) ? v.filter((x) => x !== s) : [...v, s]));

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await intApi.create({ name: name.trim(), scopes, ...(hook.trim() ? { webhookUrl: hook.trim() } : {}) });
      setCreated({ name: r.info.name, token: r.token, secret: r.webhookSecret });
      setHook('');
      load();
    } catch (e) {
      setErr(errText(e, '発行できませんでした'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="set-sec">
      <section className="rp-card set-card" aria-labelledby="int-h">
        <h3 className="set-h" id="int-h">
          外部のアシスタントから CC Hub を使う
        </h3>
        <p className="small set-p">
          ジャービスのような外部のアシスタント(このPCで動くプログラム)に、CC Hub でのセッション起動や状態の確認を許可します。
          トークンごとにできることを絞れます。PIN やローカルトークンと違い、設定の変更・ファイルの閲覧・承認などはできません。
        </p>
        <p className="small muted">
          この API は、このPCの中から(http://127.0.0.1)だけ使えます。使い方: <span className="mono">Authorization: Bearer cch_…</span> を付けて
          <span className="mono"> /api/integration/…</span> を呼びます。
        </p>
        {err && (
          <div className="form-error" role="alert">
            {err}
          </div>
        )}
        {created && (
          <div className="int-created" role="status">
            <p className="small">
              <strong>「{created.name}」のトークンを発行しました。</strong>この画面を閉じると二度と表示できません。今すぐ連携先に設定してください。
            </p>
            <CopyField label="トークン" value={created.token} />
            {created.secret && <CopyField label="Webhook の署名用の秘密鍵" value={created.secret} />}
            <button className="btn sm ghost" onClick={() => setCreated(null)}>
              設定しました(閉じる)
            </button>
          </div>
        )}
        {tokens === null ? (
          <div className="empty small">
            <Spinner /> 読み込み中…
          </div>
        ) : tokens.length === 0 ? (
          <p className="small muted">まだトークンはありません。</p>
        ) : (
          <ul className="int-list">
            {tokens.map((t) => (
              <li key={t.id} className="int-row">
                <div className="int-main">
                  <span className="int-name">{t.name}</span>
                  <span className="mono small muted">cch_{t.hint}_…</span>
                  <span className="int-scopes">
                    {t.scopes.map((s) => (
                      <span key={s} className="tag">
                        {SCOPE_LABEL[s]?.label ?? s}
                      </span>
                    ))}
                  </span>
                  <span className="small muted">
                    発行 {fmtDate(t.createdAt)} · 最終利用 {t.lastUsedAt ? fmtDate(t.lastUsedAt) : 'なし'}
                    {t.webhookUrl && (
                      <>
                        {' '}
                        · Webhook <span className="mono">{t.webhookUrl}</span>
                      </>
                    )}
                  </span>
                </div>
                <button className="btn sm danger" onClick={() => setRevoke(t)}>
                  無効にする
                </button>
              </li>
            ))}
          </ul>
        )}
        {subs > 0 && <p className="hint">状態の通知(SSE)を受信中: {subs} 件</p>}
      </section>

      <section className="rp-card set-card" aria-labelledby="int-new">
        <h3 className="set-h" id="int-new">
          トークンを発行する
        </h3>
        <label className="field">
          <span>名前(どの連携か分かるように)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>
        <fieldset className="int-scope-set">
          <legend className="small">許可すること</legend>
          {(Object.keys(SCOPE_LABEL) as Scope[]).map((s) => (
            <label key={s} className="int-scope">
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
              <span>
                <strong>{SCOPE_LABEL[s].label}</strong>
                <span className="small muted"> {SCOPE_LABEL[s].desc}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>Webhook の URL(任意)— セッションの状態が変わるたびに POST します(「状態を見る」が必要)</span>
          <input value={hook} onChange={(e) => setHook(e.target.value)} placeholder="http://127.0.0.1:8787/cc-hub" spellCheck={false} inputMode="url" />
        </label>
        <div className="int-actions">
          <button className="btn primary" onClick={submit} disabled={busy || !name.trim() || scopes.length === 0}>
            {busy ? '発行中…' : '発行する'}
          </button>
        </div>
      </section>

      {revoke && (
        <ConfirmModal
          title={`「${revoke.name}」のトークンを無効にしますか?`}
          confirmLabel="無効にする"
          danger
          error={revokeErr}
          onConfirm={() => {
            intApi
              .revoke(revoke.id)
              .then(() => {
                setRevoke(null);
                setRevokeErr(null);
                load();
              })
              .catch((e) => setRevokeErr(errText(e, '無効にできませんでした')));
          }}
          onClose={() => {
            setRevoke(null);
            setRevokeErr(null);
          }}
        >
          <p className="small">このトークンを使っている連携先は、すぐに CC Hub を使えなくなります。元には戻せません(必要なら新しく発行してください)。</p>
        </ConfirmModal>
      )}
    </div>
  );
}
