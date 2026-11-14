import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './hig.css';

// ダブルタップ拡大の保険(touch-action が効かない古いブラウザ向け)
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

// iOS のホーム画面アプリ(standalone + black-translucent)では、height: 100% や position: fixed の高さが
// ステータスバーの分だけ短くなり、タブバーの下に隙間ができる(iOS 26 の WebKit の不具合)。
// 100vh はその分を含むので、standalone のときは 100vh と innerHeight の大きい方を画面の高さにする。
function fitStandaloneHeight(): void {
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  if (!standalone) return;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;top:0;left:0;width:0;height:100vh;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const set = () => {
    const h = Math.max(probe.getBoundingClientRect().height, window.innerHeight);
    document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
  };
  set();
  window.addEventListener('resize', set);
  window.addEventListener('orientationchange', () => setTimeout(set, 300));
}
fitStandaloneHeight();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
