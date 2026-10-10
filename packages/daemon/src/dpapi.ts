// 秘密情報(サーバーのパスワード / Discord の Webhook URL)の暗号化。Windows DPAPI(CurrentUser)を PowerShell で呼ぶ。
// - 秘密はコマンドラインに載せない: 平文 / 暗号文とも base64 にして標準入力で渡し、結果を標準出力で受け取る
// - ログに中身を出さない(エラー時も PowerShell の出力は要約だけ)
// - 復号した値は呼び出し側で使い終わったら捨てること(長く保持しない)
import { spawn } from 'node:child_process';

const PS_TIMEOUT_MS = 20_000;

// 標準入力の base64 を読み、DPAPI で Protect / Unprotect して base64 で出力する
const SCRIPT = (op: 'Protect' | 'Unprotect') =>
  [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$in = [Console]::In.ReadToEnd().Trim()',
    '$b = [Convert]::FromBase64String($in)',
    `$o = [System.Security.Cryptography.ProtectedData]::${op}($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($o))',
  ].join('; ');

/** 暗号化・復号の実装(テストでは差し替える) */
export interface SecretBox {
  protect(plain: string): Promise<string>;
  unprotect(blob: string): Promise<string>;
}

function runPs(op: 'Protect' | 'Unprotect', inputB64: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let done = false;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT(op)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      reject(new Error(`DPAPI(${op})がタイムアウトしました`));
    }, PS_TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 4000) err += c.toString('utf8');
    });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`PowerShell を起動できません: ${e.message}`));
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const s = out.trim();
      if (code === 0 && /^[A-Za-z0-9+/=]+$/.test(s)) resolve(s);
      // 入力は秘密なのでエラーメッセージには含めない(PowerShell の例外の 1 行目だけ)
      else reject(new Error(`DPAPI(${op})に失敗しました (code ${code}): ${err.split(/\r?\n/)[0]?.slice(0, 200) ?? ''}`));
    });
    child.stdin.on('error', () => {
      /* 先に終了した場合。結果は close で判定する */
    });
    child.stdin.end(inputB64 + '\n', 'utf8');
  });
}

/** Windows DPAPI(CurrentUser スコープ)。暗号文は base64 */
export const dpapi: SecretBox = {
  async protect(plain: string): Promise<string> {
    return runPs('Protect', Buffer.from(String(plain), 'utf8').toString('base64'));
  },
  async unprotect(blob: string): Promise<string> {
    const b64 = await runPs('Unprotect', String(blob));
    return Buffer.from(b64, 'base64').toString('utf8');
  },
};
