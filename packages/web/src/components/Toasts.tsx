// アプリ内トースト(notify イベント)
import { useHub } from '../store';
import { resolveNotifyPr } from '../pr';

const KIND_LABEL = { approval: '承認待ち', input: '入力待ち', done: '完了', error: 'エラー', pr: 'PR', deploy: 'アップロード' } as const;

export function Toasts() {
  const toasts = useHub((s) => s.toasts);
  const dismiss = useHub((s) => s.dismissToast);
  const open = useHub((s) => s.open);
  const openPr = useHub((s) => s.openPr);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast k-${t.event.kind}`}>
          <button
            className="toast-main"
            onClick={() => {
              const st = useHub.getState();
              if (t.event.kind === 'deploy') {
                // アップロード: 申請があれば承認キュー、なければ最新のアップロードの詳細
                const list = Object.values(st.deploys).sort((a, b) => b.createdAt - a.createdAt);
                if (list.some((d) => d.state === 'pending_approval')) st.openApprovals();
                else if (list[0]) st.openDeployDialog({ deployId: list[0].id });
                else st.openSettings('servers');
              } else if (t.event.kind === 'pr') {
                // PR の通知は PR を開く(見つからなければ一覧)
                openPr(resolveNotifyPr(t.event, st.prs, st.sessions));
              } else if (st.sessions[t.event.sessionId]) open(t.event.sessionId);
              dismiss(t.id);
            }}
          >
            <span className="toast-kind">{KIND_LABEL[t.event.kind] ?? t.event.kind}</span>
            <span className="toast-title">{t.event.title}</span>
            {t.event.body && <span className="toast-body">{t.event.body}</span>}
          </button>
          <button className="icon-btn toast-x" onClick={() => dismiss(t.id)} aria-label="閉じる">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
