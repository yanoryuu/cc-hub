// インストール版の初回設定: Claude Code に CC Hub をつなぐ(hooks・MCP・スキル)。
// バージョンが変わったら(同梱ファイルの場所や中身が変わりうるので)やり直す。結果は <dataDir>\setup.log
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SetupPaths {
  /** resources/hub */
  hubRoot: string;
  /** 同梱の node(cc-hub-node.exe) */
  node: string;
  dataDir: string;
  version: string;
}

export interface SetupResult {
  /** 足りない前提(Claude Code / Git)。空なら OK */
  missing: { name: string; how: string; url: string }[];
  /** 失敗した手順の説明 */
  errors: string[];
}

/** Claude Code の設定(~/.claude)のあるホーム。CC_HUB_HOME は検証用(本物の設定を書き換えないため。子プロセスの USERPROFILE も差し替える) */
const HOME = process.env.CC_HUB_HOME || process.env.USERPROFILE || os.homedir();

function stateFile(p: SetupPaths): string {
  return path.join(p.dataDir, 'setup.json');
}

/** このバージョンで設定済みか */
export function setupDone(p: SetupPaths): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(p), 'utf8')) as { version?: string; complete?: boolean };
    return s.version === p.version && s.complete === true;
  } catch {
    return false;
  }
}

/** PATH から実行ファイルを探す(where) */
function which(cmd: string): string | null {
  const r = spawnSync('where', [cmd], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? null;
}

/** Claude Code の場所(デーモンの config.json の claudePath → ~/.local/bin/claude.exe → PATH) */
export function findClaude(dataDir: string): string | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')) as { claudePath?: string };
    if (cfg.claudePath && path.isAbsolute(cfg.claudePath) && fs.existsSync(cfg.claudePath)) return cfg.claudePath;
  } catch {
    /* 次へ */
  }
  const local = path.join(HOME, '.local', 'bin', 'claude.exe');
  if (fs.existsSync(local)) return local;
  return which('claude');
}

export function missingPrereqs(dataDir: string): SetupResult['missing'] {
  const out: SetupResult['missing'] = [];
  if (!findClaude(dataDir)) {
    out.push({
      name: 'Claude Code',
      how: 'PowerShell で次を実行してください:\nirm https://claude.ai/install.ps1 | iex\n実行後、一度 claude を起動してログインしてください。',
      url: 'https://docs.claude.com/en/docs/claude-code/setup',
    });
  }
  if (!which('git')) {
    out.push({ name: 'Git', how: 'Git for Windows をインストールしてください(設定はすべて既定のままで構いません)。', url: 'https://git-scm.com/download/win' });
  }
  return out;
}

/** 同梱の node でスクリプトを実行する(Claude Code の中から呼ばれても会話ログが壊れないよう CLAUDE* を外す) */
function runNode(p: SetupPaths, args: string[], log: (s: string) => void): boolean {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/i.test(k)));
  if (process.env.CC_HUB_HOME) env.USERPROFILE = process.env.CC_HUB_HOME;
  const r = spawnSync(p.node, args, { encoding: 'utf8', windowsHide: true, env, timeout: 120_000 });
  log(`$ ${path.basename(args[0])} ${args.slice(1).join(' ')}\n${(r.stdout || '').trim()}\n${(r.stderr || '').trim()}`.trim());
  return r.status === 0;
}

/**
 * 設定する:
 * - mod「cc-hub」(claude plugin install。イベントの送信・帯・パネル・/hub・見張り・共通の指示)。
 *   入ったら、今までの hooks と statusLine は外す(mod が送るので二重にしない。settings.json はバックアップを作る)
 * - mod を入れられなかったときは今までどおり hooks(~/.claude/settings.json)と statusLine(未設定のときだけ)
 * - MCP「cc-hub」(claude mcp add --scope user)、スキル hub-commander(~/.claude/skills)
 */
export function runSetup(p: SetupPaths): SetupResult {
  const lines: string[] = [`==== ${new Date().toISOString()} CC Hub ${p.version} の初回設定`];
  const log = (s: string) => lines.push(s);
  const result: SetupResult = { missing: missingPrereqs(p.dataDir), errors: [] };
  const integ = path.join(p.hubRoot, 'integrations');
  const claude = findClaude(p.dataDir);
  const hooks = path.join(integ, 'hooks', 'install.js');

  const modOk = !!claude && runNode(p, [path.join(integ, 'mod', 'install.js'), '--apply', '--claude', claude], log);
  if (modOk) {
    if (!runNode(p, [hooks, '--uninstall', '--apply'], log)) log('今までの hooks を外せませんでした(mod は同じ CC Hub への hooks があればイベントを送らないので、動作は変わりません)');
  } else {
    log('mod を入れられなかったので、今までの hooks でつなぎます');
    if (!runNode(p, [hooks, '--apply', '--node', p.node, '--statusline-if-empty'], log)) {
      result.errors.push('Claude Code の hooks の登録に失敗しました');
    }
  }

  try {
    const dst = path.join(HOME, '.claude', 'skills', 'hub-commander');
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(path.join(integ, 'skills', 'hub-commander'), dst, { recursive: true });
    log(`スキルを配置: ${dst}`);
  } catch (e) {
    result.errors.push(`スキル hub-commander の配置に失敗しました: ${(e as Error).message}`);
  }

  if (claude) {
    if (!runNode(p, [path.join(integ, 'mcp', 'install.js'), '--apply', '--claude', claude], log)) {
      result.errors.push('Claude Code への MCP「cc-hub」の登録に失敗しました');
    }
  } else {
    log('Claude Code が見つからないので MCP の登録は次回に回します');
  }

  const complete = !result.missing.length && !result.errors.length;
  try {
    fs.mkdirSync(p.dataDir, { recursive: true });
    fs.appendFileSync(path.join(p.dataDir, 'setup.log'), lines.join('\n') + '\n');
    fs.writeFileSync(stateFile(p), JSON.stringify({ version: p.version, complete, at: Date.now() }, null, 2));
  } catch {
    /* 記録できなくても続ける */
  }
  return result;
}
