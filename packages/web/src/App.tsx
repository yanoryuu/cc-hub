import { useEffect } from 'react';
import { useHub } from './store';
import { setNeedAuthHandler } from './api';
import { bootstrap, kickWs } from './ws';
import { useMediaQuery } from './util';
import { refreshPrs } from './pr';
import { PinScreen } from './components/PinScreen';
import { DesktopApp } from './components/DesktopApp';
import { MobileApp } from './components/MobileApp';
import { NewSessionDialog } from './components/NewSessionDialog';
import { Toasts } from './components/Toasts';
import { CloneRepoModal } from './components/Home';
import { DeployDialogs } from './components/Firebase';

// 401 を受けたら PIN 画面へ
setNeedAuthHandler(() => useHub.getState().setAuth('need_pin'));

export function App() {
  const auth = useHub((s) => s.auth);
  const desktop = useMediaQuery('(min-width: 900px)');

  useEffect(() => {
    void bootstrap();
    const onVis = () => {
      if (document.visibilityState === 'visible') kickWs();
    };
    document.addEventListener('visibilitychange', onVis);
    // Electron: トースト通知クリックでセッションを開く(PR の通知は PR の id が来ることがある)
    window.ccHub?.onSelectSession((sid) => {
      const st = useHub.getState();
      if (st.sessions[sid]) st.open(sid);
      else if (st.prs[sid]) st.openPr(sid);
    });
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // 表示中のセッションと画面のフォーカスをデーモンに伝える(見ているセッションの Windows / Discord 通知を抑えるため)
  const viewing = useHub((s) => {
    const mobile = !desktop;
    const shown = mobile ? s.mobileTab === 'sessions' && s.mobileDetail : s.deskView === 'session';
    return shown ? s.selectedId : null;
  });
  useEffect(() => {
    if (auth !== 'ok') return;
    let last = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = () => {
      const focused = document.visibilityState === 'visible' && document.hasFocus();
      const body = { sessionId: viewing, focused };
      const key = JSON.stringify(body);
      if (key === last) return;
      last = key;
      void fetch('/api/client/focus', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: key,
      }).catch(() => {});
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(send, 300);
    };
    // 操作したことも 30 秒に 1 回まで伝える(画面を開いたまま席を離れたら Discord は止めないため)
    let lastActive = 0;
    const onActive = () => {
      const now = Date.now();
      if (now - lastActive < 30_000 || !viewing || document.visibilityState !== 'visible') return;
      lastActive = now;
      void fetch('/api/client/focus', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: true }),
      }).catch(() => {});
    };
    const activity = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    send();
    window.addEventListener('focus', schedule);
    window.addEventListener('blur', schedule);
    document.addEventListener('visibilitychange', schedule);
    for (const t of activity) window.addEventListener(t, onActive, { passive: true, capture: true });
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('focus', schedule);
      window.removeEventListener('blur', schedule);
      document.removeEventListener('visibilitychange', schedule);
      for (const t of activity) window.removeEventListener(t, onActive, { capture: true });
    };
  }, [auth, viewing]);

  // PR 一覧: 画面にフォーカスが戻ったら取り直す(30 秒に 1 回まで)
  useEffect(() => {
    if (auth !== 'ok') return;
    void refreshPrs();
    const onFocus = () => {
      if (document.visibilityState === 'visible') void refreshPrs();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [auth]);

  if (auth === 'checking') return <div className="boot" />;
  if (auth === 'need_pin') return <PinScreen />;

  return (
    <>
      {desktop ? <DesktopApp /> : <MobileApp />}
      <NewSessionDialog />
      <CloneRepoModal />
      <DeployDialogs />
      <Toasts />
    </>
  );
}
