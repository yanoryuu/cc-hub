// アップロード(レンタルサーバーへの公開): ダイアログ(差分の確認 → アップロード → 結果)/ 進み具合 / 履歴 /
// Claude からの申請カード(承認キュー)/ 管理画面の「公開」タブ / サーバーのカード
import { useEffect, useMemo, useState } from 'react';
import type { DeployJob, DeployPlan, ServerInfo } from '@cc-hub/shared';
import { useHub } from '../store';
import { errText } from '../api';
import {
  DEPLOY_STATE_ICON,
  DEPLOY_STATE_LABEL,
  PROTOCOL_LABEL,
  deployApi,
  isDeployActive,
  isInside,
  serverWhere,
  takeDeploy,
  useDeployHistory,
  useServerList,
} from '../ops';
import { fmtSize } from '../project';
import { fmtAgo, fmtDate, useNow } from '../util';
import { ConfirmModal, Spinner } from './RepoCommon';
import { FolderInput } from './FolderPicker';

// ---------------------------------------------------------------- 小さな部品

export function DeployBadge({ d }: { d: Pick<DeployJob, 'state'> }) {
  const busy = d.state === 'planning' || d.state === 'uploading';
  return (
    <span className={`dbadge ds-${d.state}`}>
      {busy ? <Spinner /> : <span aria-hidden="true">{DEPLOY_STATE_ICON[d.state]}</span>}
      {DEPLOY_STATE_LABEL[d.state]}
    </span>
  );
}

export function ProtocolBadge({ p }: { p: ServerInfo['protocol'] }) {
  return <span className={`proto-tag p-${p}`}>{PROTOCOL_LABEL[p]}</span>;
}

/** 申請者の表示: あなた / Claude(セッション名) */
function Requester({ d }: { d: DeployJob }) {
  const open = useHub((s) => s.open);
  const sessions = useHub((s) => s.sessions);
  if (d.requestedBy.kind === 'user') return <span>あなた</span>;
  const sid = d.requestedBy.sessionId;
  const name = d.requestedBy.sessionName ?? (sid ? sessions[sid]?.name : null) ?? 'セッション不明';
  return (
    <span>
      Claude(
      {sid && sessions[sid] ? (
        <button className="link" onClick={() => open(sid)} title="申請したセッションを開く">
          {name}
        </button>
      ) : (
        name
      )}
      )
    </span>
  );
}

/** 差分の内容: 送るファイル(新規 / 変更)・消すファイル(赤)・変更なしの数・合計サイズ */
export function PlanView({ plan, deleteExtra }: { plan: DeployPlan; deleteExtra: boolean }) {
  const [all, setAll] = useState(false);
  const nNew = plan.upload.filter((u) => u.reason === 'new').length;
  const nChg = plan.upload.length - nNew;
  const LIMIT = 60;
  const ups = all ? plan.upload : plan.upload.slice(0, LIMIT);
  const nothing = plan.upload.length === 0 && plan.delete.length === 0;
  return (
    <div className="plan">
      <div className="plan-sum" role="list" aria-label="差分の要約">
        <span className="gstat" role="listitem">
          新規 <b>{nNew}</b>
        </span>
        <span className="gstat" role="listitem">
          変更 <b>{nChg}</b>
        </span>
        <span className={`gstat ${plan.delete.length ? 'del' : ''}`} role="listitem">
          削除 <b>{plan.delete.length}</b>
        </span>
        <span className="gstat" role="listitem">
          変更なし <b>{plan.unchanged}</b>
        </span>
        <span className="gstat" role="listitem">
          送信量 <b>{fmtSize(plan.totalBytes)}</b>
        </span>
      </div>
      {nothing ? (
        <div className="pj-ok muted">✓ サーバーと同じです。送るファイルはありません</div>
      ) : (
        <>
          {plan.upload.length > 0 && (
            <div className="plan-list" role="list" aria-label="送るファイル">
              {ups.map((u) => (
                <div key={u.path} className="plan-row" role="listitem">
                  <span className={`plan-k ${u.reason}`}>{u.reason === 'new' ? '新規' : '変更'}</span>
                  <span className="plan-path mono">{u.path}</span>
                  <span className="plan-size mono">{fmtSize(u.size)}</span>
                </div>
              ))}
              {plan.upload.length > LIMIT && (
                <button className="link-btn plan-more" onClick={() => setAll((v) => !v)}>
                  {all ? '折りたたむ' : `ほか ${plan.upload.length - LIMIT} 件を表示`}
                </button>
              )}
            </div>
          )}
          {plan.delete.length > 0 && (
            <div className="plan-list del" role="list" aria-label="サーバーから消すファイル">
              <div className="plan-del-head">
                サーバーから消すファイル {plan.delete.length} 件{!deleteExtra && '(設定で無効のため消しません)'}
              </div>
              {plan.delete.slice(0, all ? undefined : LIMIT).map((p) => (
                <div key={p} className="plan-row" role="listitem">
                  <span className="plan-k del">削除</span>
                  <span className="plan-path mono">{p}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 進み具合(ファイル数・バイト数・いまのファイル) */
export function DeployProgress({ d }: { d: DeployJob }) {
  const p = d.progress;
  const total = p?.total || d.plan?.upload.length || 0;
  const done = p?.done ?? 0;
  const bytesTotal = d.plan?.totalBytes ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : d.state === 'done' ? 100 : 0;
  return (
    <div className="dprog">
      <div className="dprog-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="アップロードの進み具合">
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="dprog-nums">
        <span>
          <b>{done}</b> / {total} ファイル
        </span>
        <span className="mono">
          {fmtSize(p?.bytes ?? 0)}
          {bytesTotal > 0 && ` / ${fmtSize(bytesTotal)}`}
        </span>
        <span className="dprog-pct">{pct}%</span>
      </div>
      {p?.current && d.state === 'uploading' && (
        <div className="dprog-cur mono" title={p.current}>
          ↑ {p.current}
        </div>
      )}
    </div>
  );
}

function LogTail({ log, lines = 8 }: { log: string[]; lines?: number }) {
  if (!log.length) return null;
  return (
    <pre className="dlog" aria-label="ログ(末尾)">
      {log.slice(-lines).join('\n')}
    </pre>
  );
}

/** 結果の表示(完了 / 失敗 / 却下 / 中止) */
function DeployResult({ d, server }: { d: DeployJob; server?: ServerInfo }) {
  const url = d.url ?? server?.publicUrl ?? null;
  if (d.state === 'done') {
    return (
      <div className="rp-alert ok" role="status">
        <span className="rp-alert-ico ok" aria-hidden="true">
          ✓
        </span>
        <span className="dres-main">
          <b>アップロードが完了しました</b>
          <span className="small">
            {d.progress ? `${d.progress.done} ファイル · ${fmtSize(d.progress.bytes)}` : ''}
            {d.finishedAt ? ` · ${fmtDate(d.finishedAt)}` : ''}
          </span>
        </span>
        {url && (
          <a className="btn primary sm" href={url} target="_blank" rel="noreferrer">
            サイトを開く ↗
          </a>
        )}
      </div>
    );
  }
  if (d.state === 'failed') {
    return (
      <div className="rp-alert error" role="alert">
        <span className="rp-alert-ico" aria-hidden="true">
          !
        </span>
        <span>
          <b>アップロードに失敗しました</b>
          {d.error && <span className="dres-err">{d.error}</span>}
        </span>
      </div>
    );
  }
  if (d.state === 'rejected' || d.state === 'cancelled') {
    return (
      <div className="rp-alert warn" role="status">
        <span className="rp-alert-ico" aria-hidden="true">
          ⊘
        </span>
        <span>
          {d.state === 'rejected' ? '申請を却下しました' : 'アップロードを中止しました'}
          {d.error && <span className="dres-err">{d.error}</span>}
        </span>
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------- ダイアログ

/** App 直下に置く。ストアの deployDialog があれば開く */
export function DeployDialog() {
  const st = useHub((s) => s.deployDialog);
  if (!st) return null;
  return <DeployDialogInner key={`${st.serverId ?? ''}|${st.deployId ?? ''}|${st.localDir ?? ''}`} />;
}

function DeployDialogInner() {
  const init = useHub((s) => s.deployDialog)!;
  const close = () => useHub.getState().openDeployDialog(null);
  const servers = useServerList();
  const [deployId, setDeployId] = useState<string | null>(init.deployId);
  const deploy = useHub((s) => (deployId ? s.deploys[deployId] : undefined));
  // プロジェクトから開いたときは、そのプロジェクトのフォルダが既定のサーバーを先に
  const candidates = useMemo(() => {
    if (!init.projectPath) return servers;
    const inP = servers.filter((s) => isInside(s.defaultLocalDir, init.projectPath));
    return [...inP, ...servers.filter((s) => !inP.includes(s))];
  }, [servers, init.projectPath]);
  const [serverId, setServerId] = useState<string>(init.serverId ?? deploy?.serverId ?? candidates[0]?.id ?? '');
  const server = useHub((s) => s.servers[deploy?.serverId ?? serverId]);
  const defaultDir = (sv: ServerInfo | undefined) =>
    init.localDir ?? (sv?.defaultLocalDir && (!init.projectPath || isInside(sv.defaultLocalDir, init.projectPath)) ? sv.defaultLocalDir : init.projectPath ?? sv?.defaultLocalDir ?? '');
  const [localDir, setLocalDir] = useState(() => defaultDir(server));
  const [build, setBuild] = useState(server?.buildCommand ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !confirm && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirm]);

  const pickServer = (id: string) => {
    setServerId(id);
    const sv = servers.find((s) => s.id === id);
    setLocalDir(defaultDir(sv));
    setBuild(sv?.buildCommand ?? '');
  };

  const plan = async () => {
    if (!serverId || !localDir.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await deployApi.create({ serverId, localDir: localDir.trim(), buildCommand: build.trim() || undefined, dryRun: true });
      if (r) {
        useHub.getState().upsertDeploy(r);
        setDeployId(r.id);
      } else setErr('アップロードを開始できませんでした');
    } catch (e) {
      setErr(errText(e, '差分の確認を開始できませんでした'));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setErr(null);
    try {
      takeDeploy(await fn());
    } catch (e) {
      setErr(errText(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  const back = () => {
    // 確認待ちのまま戻る場合は、そのジョブを中止しておく
    if (deploy && deploy.state === 'ready') void deployApi.cancel(deploy.id).catch(() => {});
    setDeployId(null);
    setErr(null);
  };

  const state = deploy?.state ?? 'config';
  const title = deploy ? `アップロード — ${deploy.serverName}` : 'アップロード';
  const url = deploy?.url ?? server?.publicUrl ?? null;

  let body: React.ReactNode;
  if (!deploy && deployId) {
    body = <div className="empty">このアップロードは見つかりません(古い履歴は消えます)</div>;
  } else if (!deploy) {
    // 設定 → 差分を確認
    body = servers.length === 0 ? (
      <div className="rp-empty in-modal">
        <p>アップロード先のサーバーがまだありません。</p>
        <button
          className="btn primary"
          onClick={() => {
            close();
            useHub.getState().openSettings('servers');
          }}
        >
          サーバーを追加する
        </button>
      </div>
    ) : (
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void plan();
        }}
      >
        <label className="field">
          <span>アップロード先のサーバー</span>
          <select value={serverId} onChange={(e) => pickServer(e.target.value)}>
            {candidates.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}({PROTOCOL_LABEL[s.protocol]} {serverWhere(s)})
              </option>
            ))}
          </select>
          {server && (
            <span className="hint">
              公開先:{' '}
              {server.publicUrl ? (
                <a className="link" href={server.publicUrl} target="_blank" rel="noreferrer">
                  {server.publicUrl}
                </a>
              ) : (
                '(URL 未設定)'
              )}
            </span>
          )}
        </label>
        <div className="field">
          <span>アップロードするフォルダ(この中身をサーバーに送ります)</span>
          <FolderInput value={localDir} onChange={setLocalDir} label="アップロードするフォルダ" placeholder="D:\WorkTree\shop-web\dist" />
          <span className="hint">ビルドの出力先(dist など)を選びます。.git / node_modules / .cc-hub は常に送りません。</span>
        </div>
        <label className="field">
          <span>先に実行するビルドコマンド(空ならビルドしない)</span>
          <input className="mono" value={build} onChange={(e) => setBuild(e.target.value)} placeholder="npm run build" spellCheck={false} />
          <span className="hint">プロジェクトのフォルダ(アップロードするフォルダの親)で実行します。</span>
        </label>
        {server?.deleteExtra && (
          <div className="warn-box">⚠ このサーバーは「サーバーにだけあるファイルを消す」が有効です。差分の確認で消すファイルを確認してください。</div>
        )}
        {err && <div className="form-error">{err}</div>}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={close}>
            キャンセル
          </button>
          <button type="submit" className="btn primary" disabled={busy || !serverId || !localDir.trim()}>
            {busy ? '開始中…' : '差分を確認'}
          </button>
        </div>
      </form>
    );
  } else {
    body = (
      <div className="form">
        <div className="dmeta">
          <DeployBadge d={deploy} />
          <span className="mono dmeta-dir" title={deploy.localDir}>
            {deploy.localDir}
          </span>
          <span aria-hidden="true">→</span>
          <span className="mono dmeta-dir" title={server ? serverWhere(server) : deploy.serverName}>
            {deploy.serverName}
            {server ? ` (${serverWhere(server)})` : ''}
          </span>
        </div>
        {deploy.requestedBy.kind === 'claude' && (
          <div className="dreq-note">
            申請: <Requester d={deploy} />
            {deploy.note && <span className="dreq-why">「{deploy.note}」</span>}
          </div>
        )}
        {state === 'pending_approval' && (
          <>
            <div className="rp-alert warn">Claude からの申請です。承認すると差分を確認してからアップロードします。</div>
            <DeployRequestButtons d={deploy} />
          </>
        )}
        {state === 'planning' && (
          <div className="rp-alert info" role="status">
            <Spinner /> {deploy.buildCommand ? `ビルド(${deploy.buildCommand})と差分の確認をしています…` : '差分を確認しています…'}
          </div>
        )}
        {deploy.plan && (state === 'ready' || state === 'planning') && <PlanView plan={deploy.plan} deleteExtra={!!server?.deleteExtra} />}
        {(state === 'uploading' || state === 'done' || (state === 'failed' && deploy.progress)) && <DeployProgress d={deploy} />}
        <DeployResult d={deploy} server={server} />
        {deploy.plan && state !== 'ready' && state !== 'planning' && (
          <details className="dplan-fold">
            <summary>差分の内容</summary>
            <PlanView plan={deploy.plan} deleteExtra={!!server?.deleteExtra} />
          </details>
        )}
        <LogTail log={deploy.log} lines={state === 'failed' ? 14 : 6} />
        {err && <div className="form-error">{err}</div>}
        <div className="modal-foot">
          {state === 'ready' && (
            <>
              {deploy.requestedBy.kind === 'user' && (
                <button className="btn" onClick={back} disabled={busy}>
                  ‹ 設定を変える
                </button>
              )}
              <span className="spacer" />
              <button className="btn" onClick={close}>
                閉じる
              </button>
              <button
                className="btn primary"
                disabled={busy || (deploy.plan ? deploy.plan.upload.length + deploy.plan.delete.length === 0 : false)}
                onClick={() => setConfirm(true)}
              >
                アップロード
              </button>
            </>
          )}
          {(state === 'planning' || state === 'uploading') && (
            <>
              <span className="hint dfoot-note">閉じても続きます(履歴から見られます)</span>
              <span className="spacer" />
              <button className="btn danger" disabled={busy} onClick={() => void act(() => deployApi.cancel(deploy.id), '中止できませんでした')}>
                中止
              </button>
              <button className="btn" onClick={close}>
                閉じる
              </button>
            </>
          )}
          {(state === 'done' || state === 'failed' || state === 'rejected' || state === 'cancelled' || state === 'pending_approval') && (
            <>
              {state === 'failed' && deploy.requestedBy.kind === 'user' && (
                <button className="btn" onClick={back}>
                  ‹ もう一度
                </button>
              )}
              <span className="spacer" />
              <button className="btn" onClick={close}>
                閉じる
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !confirm && close()}>
      <div className="modal deploy-modal" role="dialog" aria-modal="true" aria-labelledby="dp-title">
        <div className="modal-head">
          <h2 id="dp-title">{title}</h2>
          <button className="icon-btn" onClick={close} aria-label="閉じる">
            ✕
          </button>
        </div>
        <div className="modal-body">{body}</div>
      </div>
      {confirm && deploy && (
        <ConfirmModal
          title="アップロードしますか?"
          confirmLabel="アップロードする"
          busy={busy}
          onClose={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            void act(() => deployApi.start(deploy.id), 'アップロードを開始できませんでした');
          }}
        >
          <p>
            「<b>{deploy.serverName}</b>」{server ? <span className="mono">({serverWhere(server)})</span> : null}に{' '}
            {deploy.plan ? `${deploy.plan.upload.length} ファイル(${fmtSize(deploy.plan.totalBytes)})` : 'ファイル'}を送ります。
          </p>
          {url && (
            <p>
              公開先: <span className="mono">{url}</span>
            </p>
          )}
          {deploy.plan && deploy.plan.delete.length > 0 && server?.deleteExtra && (
            <div className="warn-box">サーバーから {deploy.plan.delete.length} ファイルを削除します。元に戻せません。</div>
          )}
        </ConfirmModal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Claude からの申請(承認キュー)

function DeployRequestButtons({ d, compact = false }: { d: DeployJob; compact?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const run = async (k: string, fn: () => Promise<unknown>) => {
    setBusy(k);
    setErr(null);
    try {
      takeDeploy(await fn());
    } catch (e) {
      setErr(errText(e, '送信に失敗しました'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {rejecting ? (
        <form
          className="dreq-reject"
          onSubmit={(e) => {
            e.preventDefault();
            void run('reject', () => deployApi.reject(d.id, reason.trim() || undefined));
          }}
        >
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="却下の理由(任意。Claude に伝わります)" aria-label="却下の理由" autoFocus />
          <div className="appr-buttons">
            <button type="submit" className="btn deny" disabled={busy !== null}>
              {busy === 'reject' ? '送信中…' : '却下する'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setRejecting(false)}>
              戻る
            </button>
          </div>
        </form>
      ) : (
        <div className="appr-buttons">
          <button className="btn approve" disabled={busy !== null} onClick={() => void run('approve', () => deployApi.approve(d.id))}>
            {busy === 'approve' ? '承認中…' : '承認してアップロード'}
          </button>
          <button className="btn deny" disabled={busy !== null} onClick={() => setRejecting(true)}>
            却下
          </button>
          {!compact && null}
        </div>
      )}
      {err && <div className="form-error">{err}</div>}
    </>
  );
}

/** 承認キューのカード: 申請中は承認 / 却下、承認後は進み具合をその場で */
export function DeployRequestCard({ d }: { d: DeployJob }) {
  const server = useHub((s) => s.servers[d.serverId]);
  const openDialog = useHub((s) => s.openDeployDialog);
  const now = useNow(30000);
  const pending = d.state === 'pending_approval';
  return (
    <div className={`appr-card deploy-card ${pending ? '' : 'is-running'}`}>
      <div className="dreq-head">
        <span className="dreq-ico" aria-hidden="true">
          ↑
        </span>
        <span className="dreq-title">{pending ? 'Claude がアップロードを申請しています' : 'Claude の申請(承認済み)'}</span>
        <span className="spacer" />
        <span className="muted small" title={fmtDate(d.createdAt)}>
          {fmtAgo(d.createdAt, now)}
        </span>
      </div>
      <dl className="dreq-kv">
        <dt>サーバー</dt>
        <dd>
          <b>{d.serverName}</b>
          {server && (
            <>
              {' '}
              <ProtocolBadge p={server.protocol} /> <span className="mono muted">{serverWhere(server)}</span>
            </>
          )}
        </dd>
        {(d.url ?? server?.publicUrl) && (
          <>
            <dt>公開先</dt>
            <dd className="mono break">{d.url ?? server?.publicUrl}</dd>
          </>
        )}
        <dt>送るフォルダ</dt>
        <dd className="mono break">{d.localDir}</dd>
        {d.buildCommand && (
          <>
            <dt>ビルド</dt>
            <dd className="mono">{d.buildCommand}</dd>
          </>
        )}
        <dt>申請元</dt>
        <dd>
          <Requester d={d} />
        </dd>
      </dl>
      {d.note && <div className="dreq-why-box">{d.note}</div>}
      {pending ? (
        <DeployRequestButtons d={d} />
      ) : (
        <div className="dreq-run">
          <div className="dreq-run-head">
            <DeployBadge d={d} />
            <span className="spacer" />
            <button className="btn sm" onClick={() => openDialog({ deployId: d.id })}>
              詳細
            </button>
          </div>
          {d.state === 'planning' && <div className="muted small">差分を確認しています。終わると自動でアップロードします。</div>}
          {(d.state === 'uploading' || d.state === 'done') && <DeployProgress d={d} />}
          {d.state === 'done' && (d.url ?? server?.publicUrl) && (
            <a className="btn primary sm" href={(d.url ?? server?.publicUrl)!} target="_blank" rel="noreferrer">
              サイトを開く ↗
            </a>
          )}
          {d.state === 'failed' && <div className="form-error">{d.error ?? '失敗しました'}</div>}
        </div>
      )}
    </div>
  );
}

/** 承認後しばらくは承認キューに進み具合を残す(完了・失敗から 2 分まで) */
export function useClaudeDeploysInFlight(): DeployJob[] {
  const deploys = useHub((s) => s.deploys);
  const now = useNow(15000);
  return useMemo(
    () =>
      Object.values(deploys)
        .filter(
          (d) =>
            d.requestedBy.kind === 'claude' &&
            (isDeployActive(d) || ((d.state === 'done' || d.state === 'failed') && d.finishedAt != null && now - d.finishedAt < 120_000)),
        )
        .sort((a, b) => a.createdAt - b.createdAt),
    [deploys, now],
  );
}

// ---------------------------------------------------------------- サーバーのカード / 履歴

export function ServerCard({ s, actions, compact = false }: { s: ServerInfo; actions?: React.ReactNode; compact?: boolean }) {
  const openDialog = useHub((st) => st.openDeployDialog);
  const now = useNow(30000);
  return (
    <article className="srv-card" aria-label={`サーバー ${s.name}`}>
      <header className="srv-head">
        <span className="srv-name">{s.name}</span>
        <ProtocolBadge p={s.protocol} />
        <span className="spacer" />
        {s.lastTest && (
          <span className={`srv-test ${s.lastTest.ok ? 'ok' : 'ng'}`} title={`${s.lastTest.message}\n${fmtDate(s.lastTest.at)}`}>
            {s.lastTest.ok ? '✓ 接続 OK' : '✗ 接続できません'}
          </span>
        )}
      </header>
      <dl className="srv-kv">
        <dt>接続先</dt>
        <dd className="mono break">
          {s.username}@{serverWhere(s)}
        </dd>
        <dt>公開 URL</dt>
        <dd className="break">
          {s.publicUrl ? (
            <a className="link" href={s.publicUrl} target="_blank" rel="noreferrer">
              {s.publicUrl}
            </a>
          ) : (
            <span className="muted">未設定</span>
          )}
        </dd>
        {!compact && (
          <>
            <dt>送るフォルダ</dt>
            <dd className="mono break">{s.defaultLocalDir || <span className="muted">毎回指定</span>}</dd>
            {s.buildCommand && (
              <>
                <dt>ビルド</dt>
                <dd className="mono">{s.buildCommand}</dd>
              </>
            )}
          </>
        )}
      </dl>
      {s.lastTest && !s.lastTest.ok && <div className="srv-test-msg">{s.lastTest.message}</div>}
      <footer className="srv-foot">
        <span className="muted small" title={s.lastDeployAt ? fmtDate(s.lastDeployAt) : undefined}>
          {s.lastDeployAt ? `最終アップロード ${fmtAgo(s.lastDeployAt, now)}` : 'まだアップロードしていません'}
        </span>
        <span className="spacer" />
        {actions}
        <button className="btn sm primary" onClick={() => openDialog({ serverId: s.id })}>
          ↑ アップロード
        </button>
      </footer>
    </article>
  );
}

export function DeployHistory({ filter, empty, limit = 20 }: { filter?: (d: DeployJob) => boolean; empty?: string; limit?: number }) {
  const list = useDeployHistory(filter);
  const openDialog = useHub((s) => s.openDeployDialog);
  const now = useNow(30000);
  if (list.length === 0) return <div className="empty small">{empty ?? 'アップロードの履歴はまだありません'}</div>;
  return (
    <ul className="dhist">
      {list.slice(0, limit).map((d) => (
        <li key={d.id}>
          <button className="dhist-row" onClick={() => openDialog({ deployId: d.id })} title="詳細を開く">
            <DeployBadge d={d} />
            <span className="dhist-main">
              <span className="dhist-srv">{d.serverName}</span>
              <span className="dhist-dir mono">{d.localDir}</span>
            </span>
            <span className="dhist-by">{d.requestedBy.kind === 'claude' ? 'Claude' : 'あなた'}</span>
            <span className="dhist-n mono">{d.progress ? `${d.progress.done} ファイル` : d.plan ? `${d.plan.upload.length} 件` : ''}</span>
            <span className="muted small dhist-at" title={fmtDate(d.createdAt)}>
              {fmtAgo(d.finishedAt ?? d.createdAt, now)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- 管理画面の「公開」タブ

export function PublishTab({ path }: { path: string }) {
  const servers = useServerList();
  const openDialog = useHub((s) => s.openDeployDialog);
  const openSettings = useHub((s) => s.openSettings);
  const mine = servers.filter((s) => isInside(s.defaultLocalDir, path));
  return (
    <div className="publish">
      <div className="publish-head">
        <p className="muted small">
          作ったサイトをレンタルサーバー(FTP / FTPS / SFTP)にアップロードします。送る前に差分を確認できます。Claude からの申請は承認キューに届きます。
        </p>
        <span className="spacer" />
        <button className="btn primary" onClick={() => openDialog({ projectPath: path })} disabled={servers.length === 0}>
          サーバーを選んでアップロード
        </button>
      </div>
      <section className="rp-sec">
        <h3 className="sec-title">
          このプロジェクトのサーバー <span className="count-pill">{mine.length}</span>
        </h3>
        {mine.length === 0 ? (
          <div className="rp-empty in-modal">
            <p>
              {servers.length === 0
                ? 'アップロード先のサーバーがまだ登録されていません。'
                : 'このプロジェクトのフォルダを「送るフォルダ」にしているサーバーはありません。「サーバーを選んでアップロード」から送れます。'}
            </p>
            <button className="btn" onClick={() => openSettings('servers')}>
              サーバーの設定を開く
            </button>
          </div>
        ) : (
          <div className="srv-cards">
            {mine.map((s) => (
              <ServerCard key={s.id} s={s} />
            ))}
          </div>
        )}
      </section>
      <section className="rp-sec">
        <h3 className="sec-title">アップロードの履歴</h3>
        <DeployHistory filter={(d) => isInside(d.localDir, path)} empty="このプロジェクトからのアップロードはまだありません" />
      </section>
    </div>
  );
}
