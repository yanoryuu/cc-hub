// 「PowerShell で開く」: CC Hub の PTY で動いていたセッションを、新しい PowerShell ウィンドウで claude --resume して続ける。
// 既定は cmd.exe /c start "<タイトル>" powershell.exe -NoExit -Command "<コマンド>"。
// 設定 terminalLauncher で別のランチャーに差し替えられる(検証では引数を記録するだけの偽ランチャーを使い、ウィンドウを開かない)。
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HttpError } from '../util';

/** PowerShell の単一引用符リテラルにする('' でエスケープ。$ や ` は展開されない) */
export function psQuote(s: string): string {
  return `'${String(s).replace(/['‘’‚‛]/g, (c) => c + c)}'`;
}

/**
 * PowerShell に渡す引数。英数字と一部の記号だけならそのまま、それ以外は単一引用符で囲む
 * (--model や UUID はそのままの方がコマンドが読みやすい)
 */
export function psArg(s: string): string {
  // , は配列演算子、@ は splatting になるので引用する
  return /^[A-Za-z0-9_\-.:=/]+$/.test(s) ? s : psQuote(s);
}

/**
 * cmd.exe の行に入れられない文字のチェック。" は引用を壊し、% は環境変数として展開されてしまう
 * (cmd.exe /c の行では % をエスケープできない)
 */
function checkCmdSafe(label: string, s: string): void {
  if (/["\r\n\0]/.test(s) || /%[^%]*%/.test(s)) {
    throw new HttpError(400, `${label}に使えない文字(" や %…%)が含まれているため PowerShell で開けません`);
  }
}

/** ウィンドウのタイトル(cmd.exe の start に渡す)。cmd の特殊文字は落とす */
export function windowTitle(name: string): string {
  const t = `CC Hub: ${String(name).replace(/["%^&|<>\r\n\t\0]/g, ' ').replace(/\s+/g, ' ').trim()}`.slice(0, 100).replace(/\\+$/, '');
  return t.trim() || 'CC Hub';
}

export interface TerminalSpec {
  /** 表示名(ウィンドウのタイトル) */
  name: string;
  cwd: string;
  claudePath: string;
  /** claude --resume に渡す claude 側の session_id */
  resumeId: string;
  /** --resume の後に付ける引数(--permission-mode など + config の claudeArgs) */
  extraArgs: string[];
}

/** PowerShell で実行するコマンド(Set-Location してから claude --resume) */
export function buildPsCommand(o: Pick<TerminalSpec, 'cwd' | 'claudePath' | 'resumeId' | 'extraArgs'>): string {
  const args = ['--resume', o.resumeId, ...o.extraArgs].map(psArg).join(' ');
  return `Set-Location -LiteralPath ${psQuote(o.cwd)}; & ${psQuote(o.claudePath)} ${args}`;
}

/** 既定のランチャーで実行するコマンド(argv)。cmd.exe /c start "<タイトル>" powershell.exe -NoExit -Command "<コマンド>" */
export function buildTerminalArgv(o: TerminalSpec): string[] {
  checkCmdSafe('作業フォルダ', o.cwd);
  checkCmdSafe('claude のパス', o.claudePath);
  for (const a of o.extraArgs) checkCmdSafe('claude の引数', a);
  return ['cmd.exe', '/c', 'start', windowTitle(o.name), 'powershell.exe', '-NoExit', '-Command', buildPsCommand(o)];
}

/**
 * 起動する環境変数: CLAUDE* / CLAUDECODE と色を消す指定(NO_COLOR。Claude Code のシェルから再起動すると引き継がれる)を除き、
 * CC_HUB_SESSION(hooks のヘッダーでハブのセッションに紐付く)を付ける
 */
export function terminalEnv(hubSessionId: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v == null || /^CLAUDE/i.test(k) || /^NO_COLOR$/i.test(k)) continue;
    env[k] = v;
  }
  env.CC_HUB_SESSION = hubSessionId;
  return env;
}

/** ランチャーの実行内容(file + args)。launcher = config の terminalLauncher('' = 既定) */
export function launcherCommand(launcher: string, argv: string[]): { file: string; args: string[] } {
  if (!launcher) return { file: argv[0], args: argv.slice(1) };
  if (/\.(c?js|mjs)$/i.test(launcher)) return { file: process.execPath, args: [launcher, ...argv] };
  return { file: launcher, args: argv };
}

/** 新しいウィンドウを開く(切り離して起動し、終了は待たない)。起動自体に失敗したら例外 */
export function launchTerminal(launcher: string, spec: TerminalSpec, hubSessionId: string): Promise<{ file: string; args: string[] }> {
  const cmd = launcherCommand(launcher, buildTerminalArgv(spec));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd.file, cmd.args, {
        cwd: path.resolve(spec.cwd),
        env: terminalEnv(hubSessionId),
        detached: true,
        windowsHide: false,
        stdio: 'ignore',
      });
    } catch (e) {
      reject(e);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(cmd);
    });
  });
}
