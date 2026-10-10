// Firebase: 管理画面の「Firebase」タブ / デプロイのダイアログ(プレビュー → 本番に反映)/
// Claude からの申請カード(承認キュー)/ プレビュー確認待ちのカード / ホームのカードの小さな表示 / 設定の MCP 説明
import { useEffect, useMemo, useState } from 'react';
import type { DeployJob, FirebaseInfo, FirebaseTarget } from '@cc-hub/shared';
import { useHub } from '../store';
import { errText } from '../api';
import { deployApi, takeDeploy } from '../ops';
import {
  TARGET_DESC,
  TARGET_LABEL,
  TARGET_ORDER,
  deployInProject,
  firebaseApi,
  fmtExpiresIn,
  hasFirebase,
  shortUrl,
  targetConfigured,
  useFirebaseInfo,
  useVisible,
} from '../firebase';
import { useMcp } from '../ext';
import { fmtAgo, fmtDate, useNow } from '../util';
import { ConfirmModal, Spinner } from './RepoCommon';
import { DeployBadge, DeployDialog, DeployProgress, DeployRequestButtons, LogTail, Requester } from './Deploy';

const DOCS_URL = 'https://firebase.google.com/docs/cli?hl=ja';

// ---------------------------------------------------------------- 小さな部品

function FireIcon({ className = '' }: { className?: string }) {
  return (
    <span className={`fb-ico ${className}`} aria-hidden="true">
      🔥
    </span>
  );
}

function TargetChips({ targets }: { targets: FirebaseTarget[] }) {
  return (
    <span className="fb-targets">
      {targets.map((t) => (
        <span key={t} className="fb-target">
          {TARGET_LABEL[t]}
        </span>
      ))}
    </span>
  );
}

/** info.error の表示(ログインが必要なときは実行するコマンドも) */
function InfoError({ error }: { error: string }) {
  const login = /login|ログイン|認証|auth|credential/i.test(error);
  return (
    <div className="rp-alert error fb-err" role="alert">
      <span className="rp-alert-ico" aria-hidden="true">
        !
      </span>
      <span className="fb-err-main">
        <b>{login ? 'firebase login が必要です' : 'Firebase の情報を取得できませんでした'}</b>
        <span className="dres-err">{error}</span>
        {login && (
          <>
            <span className="small">CC Hub を動かしている PC の PowerShell で次を実行し、ブラウザでログインしてから「再読み込み」を押してください。</span>
            <pre className="mcp-cmd mono">firebase login</pre>
          </>
        )}
      </span>
    </div>
  );
}

/** 本番サイトの URL(info の sites → デプロイの url → <projectId>.web.app) */
function liveUrls(d: DeployJob, info: FirebaseInfo | null): string[] {
  if (info?.sites.length) return info.sites.map((s) => s.url);
  if (d.url && d.url !== d.firebase?.previewUrl) return [d.url];
  return d.firebase ? [`https://${d.firebase.projectId}.web.app`] : [];
}

// ---------------------------------------------------------------- プレビュー確認待ち(本番に反映 / 破棄)

/** プレビュー URL を大きく出し、「本番に反映」/「破棄」を押せるパネル */
export function FirebasePreviewPanel({ d }: { d: DeployJob }) {
  const fb = d.firebase!;
  const { info } = useFirebaseInfo(fb.projectDir);
  const now = useNow(60_000);
  const [ask, setAsk] = useState<'promote' | 'discard' | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const live = liveUrls(d, info);
  const others = fb.targets.filter((t) => t !== 'hosting');
  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setErr(null);
    try {
      takeDeploy(await fn());
      setAsk(null);
    } catch (e) {
      setErr(errText(e, fallback));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fb-preview" role="region" aria-label="プレビューの確認">
      <div className="fb-preview-head">
        <span className="fb-preview-ico" aria-hidden="true">
          ◎
        </span>
        <b>プレビュー URL に公開しました。表示を確認してください</b>
      </div>
      {fb.previewUrl ? (
        <a className="fb-preview-url" href={fb.previewUrl} target="_blank" rel="noreferrer">
          <span className="mono">{shortUrl(fb.previewUrl)}</span>
          <span className="fb-preview-open">開く ↗</span>
        </a>
      ) : (
        <div className="muted small">プレビュー URL を取得できませんでした(ログを確認してください)</div>
      )}
      <div className="fb-preview-meta small">
        {fb.channel && (
          <span>
            チャンネル <span className="mono">{fb.channel}</span>
          </span>
        )}
        <span title={fb.previewExpiresAt ? fmtDate(fb.previewExpiresAt) : undefined}>
          期限 <b>{fmtExpiresIn(fb.previewExpiresAt, now)}</b>
          {fb.previewExpiresAt ? `(${fmtDate(fb.previewExpiresAt)})` : ''}
        </span>
      </div>
      <p className="small fb-preview-p">
        問題なければ「本番に反映」を押すと、このプレビューがそのまま本番サイトに出ます(再ビルドしません)。
        {others.length > 0 && <> 同じデプロイの {others.map((t) => TARGET_LABEL[t]).join(' / ')} もこのときに本番へ反映されます。</>}
      </p>
      {err && <div className="form-error">{err}</div>}
      <div className="fb-preview-btns">
        <button className="btn" disabled={busy} onClick={() => setAsk('discard')}>
          破棄
        </button>
        <span className="spacer" />
        <button className="btn primary" disabled={busy} onClick={() => setAsk('promote')}>
          本番に反映
        </button>
      </div>
      {ask === 'promote' && (
        <ConfirmModal
          title="本番に反映しますか?"
          confirmLabel="本番に反映する"
          busy={busy}
          error={err}
          onClose={() => setAsk(null)}
          onConfirm={() => void run(() => deployApi.promote(d.id), '本番に反映できませんでした')}
        >
          <p>
            Firebase プロジェクト「<b className="mono">{fb.projectId}</b>」の本番サイトを、いま確認したプレビューの内容に置き換えます。
          </p>
          <ul className="fb-confirm-urls">
            {live.map((u) => (
              <li key={u}>
                本番: <span className="mono">{u}</span>
              </li>
            ))}
          </ul>
          {others.length > 0 && (
            <div className="warn-box">
              同じデプロイの <b>{others.map((t) => TARGET_LABEL[t]).join(' / ')}</b> も、この時点で本番にデプロイされます。
            </div>
          )}
        </ConfirmModal>
      )}
      {ask === 'discard' && (
        <ConfirmModal
          title="このデプロイを破棄しますか?"
          confirmLabel="破棄する"
          danger
          busy={busy}
          error={err}
          onClose={() => setAsk(null)}
          onConfirm={() => void run(() => deployApi.cancel(d.id), '破棄できませんでした')}
        >
          <p>本番には反映しません。プレビュー URL は期限まで見られる場合があります。</p>
          {others.length > 0 && <p className="small muted">{others.map((t) => TARGET_LABEL[t]).join(' / ')} もデプロイしません。</p>}
        </ConfirmModal>
      )}
    </div>
  );
}

/** 完了・失敗・破棄の結果 */
function FirebaseResult({ d }: { d: DeployJob }) {
  const { info } = useFirebaseInfo(d.firebase?.projectDir ?? null);
  if (d.state === 'done') {
    const urls = d.firebase?.targets.includes('hosting') ? liveUrls(d, info) : [];
    return (
      <div className="rp-alert ok" role="status">
        <span className="rp-alert-ico ok" aria-hidden="true">
          ✓
        </span>
        <span className="dres-main">
          <b>{d.firebase?.promoted ? '本番に反映しました' : 'デプロイが完了しました'}</b>
          <span className="small">
            {d.firebase && <TargetChips targets={d.firebase.targets} />}
            {d.finishedAt ? ` ${fmtDate(d.finishedAt)}` : ''}
          </span>
          {urls.map((u) => (
            <a key={u} className="link mono fb-live" href={u} target="_blank" rel="noreferrer">
              {u}
            </a>
          ))}
        </span>
        {urls[0] && (
          <a className="btn primary sm" href={urls[0]} target="_blank" rel="noreferrer">
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
          <b>デプロイに失敗しました</b>
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
          {d.state === 'rejected' ? '申請を却下しました' : 'デプロイを破棄しました(本番には反映していません)'}
          {d.error && <span className="dres-err">{d.error}</span>}
        </span>
      </div>
    );
  }
  return null;
}

/** 進行中の表示(ビルド・デプロイ中) */
function FirebaseRunning({ d }: { d: DeployJob }) {
  const hostingPreview = !!d.firebase?.preview && !!d.firebase?.targets.includes('hosting');
  return (
    <>
      <div className="rp-alert info" role="status">
        <Spinner />{' '}
        {d.state === 'planning'
          ? d.buildCommand
            ? `ビルド(${d.buildCommand})と準備をしています…`
            : '準備をしています…'
          : d.firebase?.promoted
            ? '本番に反映しています…'
            : hostingPreview
              ? 'プレビュー用の URL にデプロイしています…'
              : 'Firebase にデプロイしています…'}
      </div>
      {d.progress && d.progress.total > 0 && <DeployProgress d={d} />}
    </>
  );
}

// ---------------------------------------------------------------- ダイアログ

/** App 直下に置く: アップロードのダイアログと Firebase のダイアログを出し分ける */
export function DeployDialogs() {
  const st = useHub((s) => s.deployDialog);
  const isFb = useHub((s) => (st?.deployId ? !!s.deploys[st.deployId]?.firebase : false));
  if (!st) return null;
  if (st.firebaseCwd || isFb) return <FirebaseDialog key={`${st.firebaseCwd ?? ''}|${st.deployId ?? ''}`} />;
  return <DeployDialog />;
}

function FirebaseDialog() {
  const init = useHub((s) => s.deployDialog)!;
  const close = () => useHub.getState().openDeployDialog(null);
  const [deployId, setDeployId] = useState<string | null>(init.deployId);
  const deploy = useHub((s) => (deployId ? s.deploys[deployId] : undefined));
  const cwd = init.firebaseCwd ?? deploy?.firebase?.projectDir ?? null;
  const fb = useFirebaseInfo(cwd);
  const info = fb.info;
  const [targets, setTargets] = useState<FirebaseTarget[] | null>(null);
  const [preview, setPreview] = useState(true);
  const [build, setBuild] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 既定: Hosting があれば Hosting だけ、なければ設定のあるものすべて
  const chosen: FirebaseTarget[] =
    targets ?? (info ? (info.configured.hosting ? ['hosting'] : TARGET_ORDER.filter((t) => targetConfigured(info, t))) : []);
  const toggle = (t: FirebaseTarget) =>
    setTargets(() => (chosen.includes(t) ? chosen.filter((x) => x !== t) : TARGET_ORDER.filter((x) => x === t || chosen.includes(x))));
  const usePreview = preview && chosen.includes('hosting');
  const others = chosen.filter((t) => t !== 'hosting');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[role=alertdialog]') && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const start = async () => {
    if (!cwd || chosen.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await firebaseApi.deploy({ cwd: info?.projectDir ?? cwd, targets: chosen, preview: usePreview, buildCommand: build.trim() || undefined });
      if (r) {
        useHub.getState().upsertDeploy(r);
        setDeployId(r.id);
      } else setErr('デプロイを開始できませんでした');
    } catch (e) {
      setErr(errText(e, 'デプロイを開始できませんでした'));
    } finally {
      setBusy(false);
    }
  };

  const state = deploy?.state ?? 'config';
  const title = deploy?.firebase ? `Firebase にデプロイ — ${deploy.firebase.projectId}` : `Firebase にデプロイ${info?.projectId ? ` — ${info.projectId}` : ''}`;

  let body: React.ReactNode;
  if (!deploy && deployId) {
    body = <div className="empty">このデプロイは見つかりません(古い履歴は消えます)</div>;
  } else if (!deploy) {
    if (!fb.loaded || (fb.loading && !info)) {
      body = (
        <div className="empty">
          <Spinner /> Firebase の設定を確認しています…
        </div>
      );
    } else if (!hasFirebase(info)) {
      body = (
        <div className="form">
          {fb.error && <InfoError error={fb.error} />}
          <NoFirebase />
          <div className="modal-foot">
            <span className="spacer" />
            <button className="btn" onClick={close}>
              閉じる
            </button>
          </div>
        </div>
      );
    } else {
      body = (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <div className="dmeta">
            <FireIcon />
            <b className="mono">{info.projectId ?? '(projectId 未設定)'}</b>
            <span className="mono muted dmeta-dir" title={info.projectDir ?? ''}>
              {info.projectDir}
            </span>
          </div>
          {info.error && <InfoError error={info.error} />}
          <fieldset className="fb-field">
            <legend>デプロイするもの</legend>
            <div className="fb-checks">
              {TARGET_ORDER.map((t) => {
                const ok = targetConfigured(info, t);
                return (
                  <label key={t} className={`check-field fb-check ${chosen.includes(t) ? 'on' : ''} ${ok ? '' : 'off'}`}>
                    <input type="checkbox" checked={ok && chosen.includes(t)} disabled={!ok} onChange={() => toggle(t)} />
                    <span>
                      {TARGET_LABEL[t]}
                      <span className="hint">{ok ? TARGET_DESC[t] : 'firebase.json に設定がありません'}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          {chosen.includes('hosting') && (
            <label className={`check-field trust ${preview ? 'on' : ''}`}>
              <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
              <span>
                まずプレビュー URL に公開する(推奨)
                <span className="hint">本番とは別の URL(7 日で期限切れ)に出します。表示を確認してから「本番に反映」できます。</span>
              </span>
            </label>
          )}
          <label className="field">
            <span>先に実行するビルドコマンド(空ならビルドしない)</span>
            <input className="mono" value={build} onChange={(e) => setBuild(e.target.value)} placeholder="npm run build" spellCheck={false} />
            <span className="hint">firebase.json のあるフォルダで実行します。firebase.json の predeploy があればそれも実行されます。</span>
          </label>
          <div className="fb-explain" aria-label="これから行うこと">
            <b>これから行うこと</b>
            {chosen.length === 0 ? (
              <p className="small">デプロイするものを選んでください。</p>
            ) : usePreview ? (
              <ol className="small">
                {build.trim() && (
                  <li>
                    <span className="mono">{build.trim()}</span> でビルドします
                  </li>
                )}
                <li>Hosting をプレビュー用の URL に公開します(本番サイトはまだ変わりません)</li>
                <li>あなたがプレビューを確認して「本番に反映」を押すと、本番サイトに出ます</li>
                {others.length > 0 && <li>{others.map((t) => TARGET_LABEL[t]).join(' / ')} は「本番に反映」のときにまとめてデプロイします</li>}
              </ol>
            ) : (
              <>
                <ol className="small">
                  {build.trim() && (
                    <li>
                      <span className="mono">{build.trim()}</span> でビルドします
                    </li>
                  )}
                  <li>{chosen.map((t) => TARGET_LABEL[t]).join(' / ')} を本番にそのままデプロイします</li>
                </ol>
                {chosen.includes('hosting') && <div className="warn-box">⚠ プレビューを使わないため、本番サイトがすぐに置き換わります。</div>}
              </>
            )}
          </div>
          {err && <div className="form-error">{err}</div>}
          <div className="modal-foot">
            <button type="button" className="btn" onClick={close}>
              キャンセル
            </button>
            <button type="submit" className="btn primary" disabled={busy || chosen.length === 0}>
              {busy ? '開始中…' : usePreview ? 'プレビューに公開' : '本番にデプロイ'}
            </button>
          </div>
        </form>
      );
    }
  } else {
    const f = deploy.firebase;
    body = (
      <div className="form">
        <div className="dmeta">
          <DeployBadge d={deploy} />
          <FireIcon />
          <b className="mono">{f?.projectId ?? deploy.serverName}</b>
          {f && <TargetChips targets={f.targets} />}
          {f?.targets.includes('hosting') && <span className="muted small">{f.preview ? 'プレビュー → 本番' : '本番に直接'}</span>}
        </div>
        {deploy.requestedBy.kind === 'claude' && (
          <div className="dreq-note">
            申請: <Requester d={deploy} />
            {deploy.note && <span className="dreq-why">「{deploy.note}」</span>}
          </div>
        )}
        {state === 'pending_approval' && (
          <>
            <div className="rp-alert warn">
              Claude からの申請です。承認すると{f?.preview && f.targets.includes('hosting') ? 'まずプレビュー URL に公開します(本番はあなたが確認してから)' : 'デプロイを始めます'}。
            </div>
            <DeployRequestButtons d={deploy} approveLabel="承認してデプロイ" />
          </>
        )}
        {(state === 'planning' || state === 'uploading') && <FirebaseRunning d={deploy} />}
        {state === 'preview_ready' && <FirebasePreviewPanel d={deploy} />}
        <FirebaseResult d={deploy} />
        <LogTail log={deploy.log} lines={state === 'failed' ? 14 : 6} />
        {err && <div className="form-error">{err}</div>}
        <div className="modal-foot">
          {(state === 'planning' || state === 'uploading') && (
            <>
              <span className="hint dfoot-note">閉じても続きます(Firebase タブ・履歴から見られます)</span>
              <span className="spacer" />
              <button
                className="btn danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    takeDeploy(await deployApi.cancel(deploy.id));
                  } catch (e) {
                    setErr(errText(e, '中止できませんでした'));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                中止
              </button>
            </>
          )}
          {state === 'failed' && deploy.requestedBy.kind === 'user' && init.firebaseCwd && (
            <button className="btn" onClick={() => setDeployId(null)}>
              ‹ もう一度
            </button>
          )}
          {state === 'preview_ready' && <span className="hint dfoot-note">閉じても、あとで承認キュー・Firebase タブから反映できます</span>}
          <span className="spacer" />
          <button className="btn" onClick={close}>
            閉じる
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal deploy-modal fb-modal" role="dialog" aria-modal="true" aria-labelledby="fbd-title">
        <div className="modal-head">
          <h2 id="fbd-title">{title}</h2>
          <button className="icon-btn" onClick={close} aria-label="閉じる">
            ✕
          </button>
        </div>
        <div className="modal-body">{body}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 承認キューのカード

/** Firebase のデプロイのカード: Claude の申請(承認 / 却下)→ 進み具合 → プレビュー確認待ち → 完了 */
export function FirebaseJobCard({ d }: { d: DeployJob }) {
  const f = d.firebase!;
  const openDialog = useHub((s) => s.openDeployDialog);
  const now = useNow(30000);
  const pending = d.state === 'pending_approval';
  const waiting = d.state === 'preview_ready';
  const claude = d.requestedBy.kind === 'claude';
  const title = pending
    ? 'Claude が Firebase へのデプロイを申請しています'
    : waiting
      ? 'プレビューを確認して、本番に反映してください'
      : claude
        ? 'Claude の Firebase デプロイ(承認済み)'
        : 'Firebase デプロイ';
  return (
    <div className={`appr-card deploy-card fb-card ${pending ? '' : waiting ? 'is-waiting' : 'is-running'}`}>
      <div className="dreq-head">
        <span className="dreq-ico fb" aria-hidden="true">
          🔥
        </span>
        <span className="dreq-title">{title}</span>
        <span className="spacer" />
        <span className="muted small" title={fmtDate(d.createdAt)}>
          {fmtAgo(d.createdAt, now)}
        </span>
      </div>
      <dl className="dreq-kv">
        <dt>プロジェクト</dt>
        <dd>
          <b className="mono">{f.projectId}</b>
        </dd>
        <dt>対象</dt>
        <dd>
          <TargetChips targets={f.targets} />
        </dd>
        {f.targets.includes('hosting') && (
          <>
            <dt>Hosting</dt>
            <dd>{f.preview ? 'まずプレビュー URL に公開(本番はあなたが確認してから)' : <span className="fb-direct">本番に直接デプロイ</span>}</dd>
          </>
        )}
        <dt>フォルダ</dt>
        <dd className="mono break">{f.projectDir}</dd>
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
        <DeployRequestButtons d={d} approveLabel={f.preview && f.targets.includes('hosting') ? '承認してプレビューに公開' : '承認してデプロイ'} />
      ) : waiting ? (
        <FirebasePreviewPanel d={d} />
      ) : (
        <div className="dreq-run">
          <div className="dreq-run-head">
            <DeployBadge d={d} />
            <span className="spacer" />
            <button className="btn sm" onClick={() => openDialog({ deployId: d.id })}>
              詳細
            </button>
          </div>
          {(d.state === 'planning' || d.state === 'uploading') && <FirebaseRunning d={d} />}
          <FirebaseResult d={d} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 管理画面の「Firebase」タブ

function NoFirebase() {
  return (
    <div className="rp-empty in-modal fb-none">
      <p>
        <b>このプロジェクトには firebase.json がありません</b>
      </p>
      <p className="small muted">
        Firebase(Hosting / Functions / Firestore など)を使うプロジェクトでは、フォルダで <span className="mono">firebase init</span> を実行すると
        firebase.json ができ、ここからプレビュー付きのデプロイや状況の確認ができるようになります。
      </p>
      <a className="btn" href={DOCS_URL} target="_blank" rel="noreferrer">
        Firebase CLI のドキュメント ↗
      </a>
    </div>
  );
}

const SERVICES: { k: keyof FirebaseInfo['configured']; label: string }[] = [
  { k: 'hosting', label: 'Hosting' },
  { k: 'functions', label: 'Functions' },
  { k: 'firestore', label: 'Firestore' },
  { k: 'storage', label: 'Storage' },
];

export function FirebaseTab({ cwd, mobile = false }: { cwd: string; mobile?: boolean }) {
  const fb = useFirebaseInfo(cwd);
  const info = fb.info;
  const deploysAll = useHub((s) => s.deploys);
  const openDialog = useHub((s) => s.openDeployDialog);
  const now = useNow(30000);
  const mine = useMemo(
    () => Object.values(deploysAll).filter((d) => deployInProject(d, info)).sort((a, b) => b.createdAt - a.createdAt),
    [deploysAll, info],
  );
  const live = mine.filter((d) => d.state === 'pending_approval' || d.state === 'preview_ready' || d.state === 'planning' || d.state === 'uploading');
  const history = mine.filter((d) => !live.includes(d));

  if (!fb.loaded) {
    return (
      <div className="empty">
        <Spinner /> Firebase の設定を確認しています…
      </div>
    );
  }
  if (!hasFirebase(info)) {
    return (
      <div className="fb-tab">
        {fb.error && <InfoError error={fb.error} />}
        <NoFirebase />
      </div>
    );
  }
  const aliases = Object.entries(info.aliases).filter(([a, id]) => a !== 'default' || id !== info.projectId);
  return (
    <div className={`fb-tab ${mobile ? 'is-mobile' : ''}`}>
      <header className="fb-head">
        <FireIcon className="big" />
        <div className="fb-head-main">
          <div className="fb-head-title">
            <span className="fb-pid mono">{info.projectId ?? '(projectId 未設定)'}</span>
            {aliases.map(([a, id]) => (
              <span key={a} className="fb-alias" title={`別名 ${a} → ${id}`}>
                {a}: <span className="mono">{id}</span>
              </span>
            ))}
          </div>
          <div className="fb-head-sub small">
            <span>
              アカウント: {info.account ? <span className="mono">{info.account}</span> : <span className="fb-warn-text">未ログイン</span>}
            </span>
            {fb.checkedAt && <span className="muted">確認 {fmtAgo(fb.checkedAt, now)}</span>}
            <span className="mono muted fb-dir" title={info.projectDir ?? ''}>
              {info.projectDir}
            </span>
          </div>
        </div>
        <div className="fb-head-btns">
          <button className="btn sm" onClick={fb.refresh} disabled={fb.loading}>
            {fb.loading ? (
              <>
                <Spinner /> 確認中…
              </>
            ) : (
              '再読み込み'
            )}
          </button>
          <button className="btn primary sm" onClick={() => openDialog({ firebaseCwd: info.projectDir ?? cwd })}>
            Firebase にデプロイ
          </button>
        </div>
      </header>

      {(info.error || fb.error) && <InfoError error={(info.error ?? fb.error)!} />}

      <div className="fb-svcs" role="list" aria-label="設定のあるサービス">
        {SERVICES.map((s) => (
          <span key={s.k} role="listitem" className={`fb-svc ${info.configured[s.k] ? 'on' : 'off'}`}>
            <span aria-hidden="true">{info.configured[s.k] ? '✓' : '–'}</span> {s.label}
            <span className="sr-only">{info.configured[s.k] ? '(設定あり)' : '(設定なし)'}</span>
          </span>
        ))}
      </div>

      {live.length > 0 && (
        <section className="rp-sec">
          <h3 className="sec-title">
            対応中のデプロイ <span className="count-pill">{live.length}</span>
          </h3>
          <div className="appr-list">
            {live.map((d) => (
              <FirebaseJobCard key={d.id} d={d} />
            ))}
          </div>
        </section>
      )}

      {info.configured.hosting && (
        <section className="rp-sec">
          <h3 className="sec-title">本番サイト(Hosting)</h3>
          {info.sites.length === 0 ? (
            <div className="empty small">サイトの情報を取得できませんでした</div>
          ) : (
            <ul className="fb-sites">
              {info.sites.map((s) => (
                <li key={s.site} className="fb-site">
                  <span className="fb-site-name mono">{s.site}</span>
                  <a className="link mono break" href={s.url} target="_blank" rel="noreferrer">
                    {s.url} ↗
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {info.configured.hosting && (
        <section className="rp-sec">
          <h3 className="sec-title">
            プレビューチャンネル <span className="count-pill">{info.channels.length}</span>
          </h3>
          {info.channels.length === 0 ? (
            <div className="empty small">プレビューチャンネルはありません</div>
          ) : (
            <div className="wt-table-wrap">
              <table className="wt-table fb-table">
                <thead>
                  <tr>
                    <th>チャンネル</th>
                    <th>URL</th>
                    <th>期限</th>
                    <th>更新</th>
                  </tr>
                </thead>
                <tbody>
                  {info.channels.map((c) => (
                    <tr key={`${c.site}/${c.channel}`}>
                      <td className="mono">
                        {c.channel}
                        {info.sites.length > 1 && <span className="muted small"> ({c.site})</span>}
                      </td>
                      <td className="fb-url-cell">
                        <a className="link mono" href={c.url} target="_blank" rel="noreferrer" title={c.url}>
                          {shortUrl(c.url)} ↗
                        </a>
                      </td>
                      <td className={c.expireAt && c.expireAt - now < 24 * 3_600_000 ? 'fb-soon' : ''} title={c.expireAt ? fmtDate(c.expireAt) : undefined}>
                        {fmtExpiresIn(c.expireAt, now)}
                      </td>
                      <td className="muted" title={c.updatedAt ? fmtDate(c.updatedAt) : undefined}>
                        {c.updatedAt ? fmtAgo(c.updatedAt, now) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {info.configured.functions && (
        <section className="rp-sec">
          <h3 className="sec-title">
            Functions <span className="count-pill">{info.functions.length}</span>
          </h3>
          {info.functions.length === 0 ? (
            <div className="empty small">デプロイ済みの関数はありません</div>
          ) : (
            <div className="wt-table-wrap">
              <table className="wt-table fb-table">
                <thead>
                  <tr>
                    <th>名前</th>
                    <th>リージョン</th>
                    <th>ランタイム</th>
                    <th>状態</th>
                    <th>トリガー</th>
                  </tr>
                </thead>
                <tbody>
                  {info.functions.map((f) => (
                    <tr key={`${f.region}/${f.name}`}>
                      <td className="mono">{f.name}</td>
                      <td className="mono muted">{f.region}</td>
                      <td className="mono">{f.runtime ?? '—'}</td>
                      <td>
                        <span className={`fb-fstate ${/active|ready/i.test(f.state ?? '') ? 'ok' : f.state ? 'ng' : ''}`}>{f.state ?? '—'}</span>
                      </td>
                      <td className="small">{f.trigger ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="rp-sec">
        <h3 className="sec-title">最近のデプロイ</h3>
        {history.length === 0 ? (
          <div className="empty small">このプロジェクトの Firebase へのデプロイはまだありません</div>
        ) : (
          <ul className="dhist">
            {history.slice(0, 15).map((d) => {
              const url = d.state === 'done' ? d.url : d.firebase?.previewUrl ?? null;
              return (
                <li key={d.id}>
                  <div className="dhist-row fb-hist-row">
                    <button className="fb-hist-open" onClick={() => openDialog({ deployId: d.id })} title="詳細を開く">
                      <DeployBadge d={d} />
                      <span className="dhist-main">
                        <span className="dhist-srv">{d.firebase && <TargetChips targets={d.firebase.targets} />}</span>
                        {d.error && <span className="dhist-dir">{d.error}</span>}
                      </span>
                      <span className="dhist-by">{d.requestedBy.kind === 'claude' ? 'Claude' : 'あなた'}</span>
                      <span className="muted small dhist-at" title={fmtDate(d.createdAt)}>
                        {fmtAgo(d.finishedAt ?? d.createdAt, now)}
                      </span>
                    </button>
                    {url && (
                      <a className="link small mono fb-hist-url" href={url} target="_blank" rel="noreferrer" title={url}>
                        {shortUrl(url)} ↗
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- ホームのカードの小さな表示

/** firebase.json があるフォルダなら「Firebase」の小さな表示(カードが画面に見えてから取得。5 分キャッシュ) */
export function FirebaseChip({ cwd, onOpen }: { cwd: string; onOpen: () => void }) {
  const [ref, visible] = useVisible<HTMLSpanElement>();
  const { info } = useFirebaseInfo(cwd, visible);
  const waiting = useHub((s) => (info ? Object.values(s.deploys).filter((d) => d.state === 'preview_ready' && deployInProject(d, info)).length : 0));
  if (!hasFirebase(info)) return <span ref={ref} className="fb-chip-slot" aria-hidden="true" />;
  return (
    <button
      className={`fb-chip ${waiting ? 'is-waiting' : ''}`}
      onClick={onOpen}
      title={`Firebase: ${info.projectId ?? ''}${waiting ? `(プレビュー確認待ち ${waiting} 件)` : ''} — Firebase タブを開く`}
    >
      <span aria-hidden="true">🔥</span> Firebase
      {waiting > 0 && <b className="fb-chip-n">{waiting}</b>}
    </button>
  );
}

// ---------------------------------------------------------------- 設定: Claude との連携(MCP)

export function FirebaseMcpSection() {
  const mcp = useMcp(null);
  const entry = useMemo(() => mcp.data?.servers.find((s) => s.name === 'firebase') ?? null, [mcp.data]);
  return (
    <section className="rp-card set-card fb-mcp">
      <h3 className="set-h">
        <FireIcon /> Firebase との連携
      </h3>
      <p className="small set-p">
        Firebase 公式の MCP サーバーを登録すると、セッションの中の Claude が <b>あなたの firebase login の権限で</b> Firestore のデータ、Authentication
        のユーザー、Functions のログ、Hosting やプロジェクトの設定などを調べられるようになります(例:「本番の Firestore で users に入っている件数を見て」「昨日の
        Functions のエラーログを調べて」)。
      </p>
      <div className={`mcp-reg ${entry ? (entry.status === 'connected' ? 'ok' : 'warn') : 'none'}`} role="status">
        {mcp.loading && !mcp.data ? (
          <>
            <Spinner /> 登録状況を確認しています…
          </>
        ) : entry ? (
          entry.status === 'connected' ? (
            <>✓ firebase は登録済みで、接続できています</>
          ) : (
            <>! firebase は登録済みですが、接続できていません({entry.statusText})。firebase login 済みか確認してください</>
          )
        ) : (
          <>firebase はまだ登録されていません(または確認できませんでした)</>
        )}
        <span className="spacer" />
        <button className="btn sm" onClick={mcp.refresh} disabled={mcp.loading}>
          再確認
        </button>
      </div>
      <p className="small muted">
        登録するには PowerShell で次のコマンドを実行してください(先に <span className="mono">firebase login</span> を済ませておきます)。--apply
        なしで実行すると、登録内容の確認だけができます。
      </p>
      <pre className="mcp-cmd mono">{`node C:\\Users\\yanor\\cc-hub\\integrations\\mcp\\install-firebase.js --apply`}</pre>
      <p className="small set-p">
        CC Hub の <span className="mono">cc-hub</span> MCP にも Firebase 用のツールがあります。デプロイは必ず承認制です。
      </p>
      <ul className="mcp-tools">
        <li>
          <span className="mono mcp-tool-name">firebase_status</span>
          <span className="small">フォルダの Firebase プロジェクト・設定・プレビュー URL・Functions を見る</span>
        </li>
        <li>
          <span className="mono mcp-tool-name">request_firebase_deploy</span>
          <span className="small">
            デプロイを申請する(承認キューに届きます。Hosting は承認後まずプレビュー URL に出し、本番への反映はあなたが「本番に反映」を押したときだけ)
          </span>
        </li>
      </ul>
      <p className="small muted">
        公式 MCP は Firestore への書き込みなども行えます。本番のデータを変える操作は、Claude Code の許可の確認で内容を見てから許可してください。
      </p>
    </section>
  );
}
