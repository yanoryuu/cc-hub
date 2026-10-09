import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// ダブルタップ拡大の保険(touch-action が効かない古いブラウザ向け)
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
