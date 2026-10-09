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
      <Toasts />
    </>
  );
}
