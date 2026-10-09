// PIN ログイン画面
import { useState } from 'react';
import { login, resolveAuthWaiters, api, pickState } from '../api';
import { useHub } from '../store';
import { startWs } from '../ws';

export function PinScreen() {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin.trim() || busy) return;
    setBusy(true);
    setErr('');
    try {
      const r = await login(pin.trim());
      if (!r.ok) {
        setErr(r.error || 'PIN が違います');
        return;
      }
      setPin('');
      const st = useHub.getState();
      st.setAuth('ok');
      resolveAuthWaiters();
      // 最新状態を取り直して WS を開始
      api('/api/state', undefined, { noRetry: true })
        .then((res) => {
          const s = pickState(res);
          if (s) useHub.getState().applyFull(s);
        })
        .catch(() => {});
      startWs();
    } catch {
      setErr('接続できません');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pin-screen">
      <form className="pin-box" onSubmit={submit}>
        <div className="pin-logo">CC Hub</div>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          placeholder="PIN"
          aria-label="PIN"
          value={pin}
          autoFocus
          onChange={(e) => setPin(e.target.value)}
        />
        <button className="btn primary" type="submit" disabled={busy || !pin.trim()}>
          ログイン
        </button>
        <div className="form-error" role="alert">
          {err}
        </div>
      </form>
    </div>
  );
}
