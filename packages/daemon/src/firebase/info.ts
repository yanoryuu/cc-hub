// Firebase の状況(GET /api/firebase と MCP firebase_status)。
// - cwd から上に firebase.json を探し、.firebaserc の default / 別名を読む
// - アカウント(login:list)とプロジェクト一覧(projects:list --json)は全体で 10 分キャッシュ
// - そのプロジェクトの Hosting サイト(hosting:sites:list)・チャンネル(hosting:channel:list、サイトごと)・
//   Functions(functions:list。API が無効などのエラーは無視)を並列に取る
// - 結果は cwd ごとに 60 秒キャッシュ(refresh で取り直す)。失敗は info.error に日本語で入れる(HTTP エラーにはしない)
// - 読み取りのコマンドだけを使う(デプロイ系は deploy/service.ts)
import path from 'node:path';
import type { FirebaseInfo } from '@cc-hub/shared';
import type { FirebaseRunner } from './cli';
import {
  PROJECT_ID_RE,
  configuredOf,
  explainFirebaseError,
  findProjectDir,
  hostingSites,
  parseChannelList,
  parseFunctionsList,
  parseLoginList,
  parseProjectsList,
  parseSitesList,
  readProjectConfig,
} from './config';

const INFO_TTL_MS = 60_000;
const GLOBAL_TTL_MS = 10 * 60_000;
const READ_TIMEOUT_MS = 90_000;

type Project = ReturnType<typeof parseProjectsList>[number];

export class FirebaseInfoService {
  private readonly cache = new Map<string, { at: number; p: Promise<FirebaseInfo> }>();
  private global: { at: number; p: Promise<{ account: string | null; projects: Project[]; error: string | null }> } | null = null;

  constructor(private readonly run: FirebaseRunner) {}

  /** 読み取りのコマンドを実行して標準出力を返す(失敗は Error(日本語)) */
  private async read(args: string[], cwd: string): Promise<string> {
    const r = await this.run(args, { cwd, timeoutMs: READ_TIMEOUT_MS }).done;
    if (r.timedOut) throw new Error(`firebase ${args[0]} がタイムアウトしました`);
    if (r.code !== 0) throw new Error(explainFirebaseError(`${r.stdout}\n${r.stderr}`));
    return r.stdout;
  }

  /** アカウントとプロジェクト一覧(10 分キャッシュ) */
  private globalInfo(refresh: boolean, cwd: string) {
    if (!refresh && this.global && Date.now() - this.global.at < GLOBAL_TTL_MS) return this.global.p;
    const p = (async () => {
      let account: string | null = null;
      try {
        account = parseLoginList(await this.read(['login:list'], cwd));
      } catch (e) {
        return { account: null, projects: [], error: (e as Error).message };
      }
      if (!account) return { account: null, projects: [], error: 'firebase login が必要です(コマンドプロンプトで firebase login を実行してください)' };
      try {
        const projects = parseProjectsList(await this.read(['projects:list', '--json'], cwd));
        return { account, projects, error: null };
      } catch (e) {
        return { account, projects: [], error: (e as Error).message };
      }
    })();
    const entry = { at: Date.now(), p };
    this.global = entry;
    // 失敗はキャッシュしない
    void p.then((g) => {
      if (g.error && this.global === entry) this.global = null;
    });
    return p;
  }

  /** プロジェクトの既定の Hosting サイト名(projects:list の resources.hostingSite → projectId) */
  async defaultSite(projectId: string, cwd: string): Promise<string> {
    const g = await this.globalInfo(false, cwd);
    return g.projects.find((p) => p.projectId === projectId)?.hostingSite ?? projectId;
  }

  async get(cwd: string, refresh = false): Promise<FirebaseInfo> {
    const key = path.resolve(cwd).toLowerCase();
    const c = this.cache.get(key);
    if (!refresh && c && Date.now() - c.at < INFO_TTL_MS) return c.p;
    const p = this.load(path.resolve(cwd), refresh);
    this.cache.set(key, { at: Date.now(), p });
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value as string);
    return p;
  }

  /** デプロイの後などにキャッシュを捨てる */
  invalidate(projectDir?: string): void {
    if (!projectDir) return this.cache.clear();
    const k = path.resolve(projectDir).toLowerCase();
    for (const key of [...this.cache.keys()]) if (key === k || key.startsWith(k + path.sep)) this.cache.delete(key);
  }

  private async load(cwd: string, refresh: boolean): Promise<FirebaseInfo> {
    const info: FirebaseInfo = {
      projectDir: null,
      projectId: null,
      aliases: {},
      configured: { hosting: false, functions: false, firestore: false, storage: false },
      sites: [],
      channels: [],
      functions: [],
      account: null,
      projects: [],
      checkedAt: Date.now(),
      error: null,
    };
    const projectDir = findProjectDir(cwd);
    info.projectDir = projectDir;
    let cfg: ReturnType<typeof readProjectConfig> | null = null;
    if (projectDir) {
      try {
        cfg = readProjectConfig(projectDir);
        info.projectId = cfg.rc.default;
        info.aliases = cfg.rc.aliases;
        info.configured = configuredOf(cfg.json);
      } catch (e) {
        info.error = (e as Error).message;
      }
    }
    const runCwd = projectDir ?? cwd;
    const g = await this.globalInfo(refresh, runCwd);
    info.account = g.account;
    info.projects = g.projects.map((p) => ({ projectId: p.projectId, displayName: p.displayName }));
    info.checkedAt = Date.now();
    if (info.error) return info;
    if (g.error) {
      info.error = g.error;
      return info;
    }
    if (!projectDir) {
      info.error = 'firebase.json が見つかりません(このフォルダは Firebase のプロジェクトではありません。firebase init が必要です)';
      return info;
    }
    if (!info.projectId) {
      info.error = '.firebaserc に default のプロジェクトがありません(firebase use --add で設定してください)';
      return info;
    }
    if (!PROJECT_ID_RE.test(info.projectId)) {
      info.error = `.firebaserc のプロジェクト ID が不正です: ${info.projectId}`;
      return info;
    }
    const pid = info.projectId;
    if (g.projects.length && !g.projects.some((p) => p.projectId === pid)) {
      info.error = `プロジェクト ${pid} はログイン中のアカウント(${g.account})から見えません`;
      return info;
    }
    const json = cfg!.json;
    const errors: string[] = [];
    const tasks: Promise<void>[] = [];
    if (json.hosting.length) {
      tasks.push(
        (async () => {
          const fallback = g.projects.find((p) => p.projectId === pid)?.hostingSite ?? pid;
          let all: FirebaseInfo['sites'] = [];
          try {
            all = parseSitesList(await this.read(['hosting:sites:list', '--project', pid, '--json'], runCwd));
          } catch {
            all = [];
          }
          const defaultSite = all[0]?.site ?? fallback;
          const used = hostingSites(json, cfg!.rc, pid, defaultSite);
          info.sites = used.map((s) => all.find((x) => x.site === s) ?? { site: s, url: `https://${s}.web.app` });
          const lists = await Promise.all(
            info.sites.map(async (s) => {
              try {
                return parseChannelList(await this.read(['hosting:channel:list', '--project', pid, '--site', s.site, '--json'], runCwd), s.site);
              } catch (e) {
                errors.push(`チャンネル一覧(${s.site}): ${(e as Error).message}`);
                return [];
              }
            }),
          );
          info.channels = lists.flat().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        })(),
      );
    }
    if (json.functions) {
      tasks.push(
        (async () => {
          try {
            info.functions = parseFunctionsList(await this.read(['functions:list', '--project', pid, '--json'], runCwd));
          } catch {
            // Functions の API が無効(Spark プランなど)だと失敗する。一覧は空のままにする
            info.functions = [];
          }
        })(),
      );
    }
    await Promise.all(tasks);
    // チャンネル一覧の失敗は致命的ではないが、ログインが切れていたなどは伝える
    if (errors.length && errors.some((e) => /login|アクセスできません/.test(e))) info.error = errors[0];
    info.checkedAt = Date.now();
    return info;
  }
}

/** MCP firebase_status 用の簡潔な要約 */
export function infoSummary(i: FirebaseInfo) {
  const now = Date.now();
  return {
    projectDir: i.projectDir,
    projectId: i.projectId,
    aliases: Object.keys(i.aliases).length ? i.aliases : undefined,
    account: i.account,
    configured: Object.entries(i.configured)
      .filter(([, v]) => v)
      .map(([k]) => k),
    liveUrls: i.sites.map((s) => s.url),
    previewChannels: i.channels
      .filter((c) => c.channel !== 'live' && (c.expireAt == null || c.expireAt > now))
      .slice(0, 10)
      .map((c) => ({ site: c.site, channel: c.channel, url: c.url, expiresAt: c.expireAt ? new Date(c.expireAt).toISOString() : null })),
    functions: i.functions.slice(0, 50).map((f) => `${f.name} (${f.region}${f.trigger ? `, ${f.trigger}` : ''})`),
    error: i.error,
    deployableTargets: deployable(i),
  };
}

function deployable(i: FirebaseInfo): string[] {
  const out: string[] = [];
  if (i.configured.hosting) out.push('hosting');
  if (i.configured.functions) out.push('functions');
  if (i.configured.firestore) out.push('firestore:rules', 'firestore:indexes');
  if (i.configured.storage) out.push('storage');
  return out;
}
