import { useEffect } from 'react';
import { useHub } from './store';
import { setNeedAuthHandler } from './api';
import { bootstrap, kickWs } from './ws';
import { useMediaQuery } from './util';
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
    // Electron: トースト通知クリックでセッションを開く
    window.ccHub?.onSelectSession((sid) => {
      const st = useHub.getState();
      if (st.sessions[sid]) st.open(sid);
    });
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

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
