// Firebase: 設定ファイル(firebase.json / .firebaserc)と firebase CLI の --json 出力の読み取り(副作用なし。テスト対象)。
// - firebase.json: hosting はオブジェクトでも配列でもよい(site / target で公開先を指定)。functions / firestore / storage の有無
// - .firebaserc: projects(default と別名)と targets(デプロイターゲット → サイト名)
// - CLI の --json 出力は {status: 'success'|'error', result | error} の形
import fs from 'node:fs';
import path from 'node:path';
import type { FirebaseInfo, FirebaseTarget } from '@cc-hub/shared';

export const FIREBASE_TARGETS: FirebaseTarget[] = ['hosting', 'functions', 'firestore:rules', 'firestore:indexes', 'storage'];

/** プロジェクト ID(英小文字・数字・ハイフン) */
export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;
/** Hosting のサイト名 */
export const SITE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** プレビューチャンネル名('live' は本番なので不可) */
export const CHANNEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export interface HostingEntry {
  site: string | null;
  target: string | null;
  public: string | null;
  predeploy: string[];
}

export interface FirebaseJson {
  hosting: HostingEntry[];
  functions: boolean;
  firestore: { rules: boolean; indexes: boolean } | null;
  storage: boolean;
}

export interface FirebaseRc {
  default: string | null;
  aliases: Record<string, string>;
  /** targets[projectId].hosting[target] = サイト名の一覧 */
  hostingTargets: Record<string, Record<string, string[]>>;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** cwd から上に辿って最初に firebase.json があるフォルダ(無ければ null) */
export function findProjectDir(cwd: string): string | null {
  let d = path.resolve(cwd);
  for (let i = 0; i < 64; i++) {
    if (isFile(path.join(d, 'firebase.json'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

/** JSON(BOM 付きも可)。壊れていれば Error(日本語) */
export function parseJsonText(text: string, what: string): any {
  try {
    return JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`${what} を読めません(JSON の形式が不正です): ${(e as Error).message}`);
  }
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);

export function parseFirebaseJson(text: string): FirebaseJson {
  const j = parseJsonText(text, 'firebase.json');
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('firebase.json の形式が不正です');
  const hostRaw = j.hosting == null ? [] : Array.isArray(j.hosting) ? j.hosting : [j.hosting];
  const hosting: HostingEntry[] = hostRaw
    .filter((h: unknown) => h && typeof h === 'object')
    .map((h: any) => ({ site: strOrNull(h.site), target: strOrNull(h.target), public: strOrNull(h.public), predeploy: strList(h.predeploy) }));
  const fsRaw = j.firestore;
  const fsList = fsRaw == null ? [] : Array.isArray(fsRaw) ? fsRaw : [fsRaw];
  const firestore = fsList.length
    ? { rules: fsList.some((f: any) => !!f?.rules), indexes: fsList.some((f: any) => !!f?.indexes) }
    : null;
  return {
    hosting,
    functions: j.functions != null && j.functions !== false,
    firestore,
    storage: j.storage != null && j.storage !== false,
  };
}

export function parseFirebaseRc(text: string | null): FirebaseRc {
  const out: FirebaseRc = { default: null, aliases: {}, hostingTargets: {} };
  if (text == null || !text.trim()) return out;
  const j = parseJsonText(text, '.firebaserc');
  const projects = j?.projects && typeof j.projects === 'object' ? j.projects : {};
  for (const [k, v] of Object.entries(projects)) {
    const id = strOrNull(v);
    if (!id) continue;
    if (k === 'default') out.default = id;
    else out.aliases[k] = id;
  }
  const targets = j?.targets && typeof j.targets === 'object' ? j.targets : {};
  for (const [pid, t] of Object.entries(targets as Record<string, any>)) {
    const h = t?.hosting;
    if (!h || typeof h !== 'object') continue;
    out.hostingTargets[pid] = {};
    for (const [name, sites] of Object.entries(h)) out.hostingTargets[pid][name] = strList(sites);
  }
  return out;
}

/** firebase.json と .firebaserc を読む(firebase.json が無ければ Error) */
export function readProjectConfig(projectDir: string): { json: FirebaseJson; rc: FirebaseRc } {
  const json = parseFirebaseJson(fs.readFileSync(path.join(projectDir, 'firebase.json'), 'utf8'));
  let rcText: string | null = null;
  try {
    rcText = fs.readFileSync(path.join(projectDir, '.firebaserc'), 'utf8');
  } catch {
    rcText = null;
  }
  return { json, rc: parseFirebaseRc(rcText) };
}

/**
 * Hosting の公開先サイト名。site 指定 → そのまま / target 指定 → .firebaserc の targets から /
 * どちらも無い → defaultSite(プロジェクトの既定サイト)
 */
export function hostingSites(json: FirebaseJson, rc: FirebaseRc, projectId: string, defaultSite: string): string[] {
  const out: string[] = [];
  for (const h of json.hosting) {
    if (h.site) out.push(h.site);
    else if (h.target) out.push(...(rc.hostingTargets[projectId]?.[h.target] ?? []));
    else out.push(defaultSite);
  }
  return [...new Set(out.filter((s) => SITE_RE.test(s)))];
}

export function configuredOf(json: FirebaseJson): FirebaseInfo['configured'] {
  return { hosting: json.hosting.length > 0, functions: json.functions, firestore: !!json.firestore, storage: json.storage };
}

/** 対象が firebase.json に設定されているか */
export function targetConfigured(json: FirebaseJson, t: FirebaseTarget): boolean {
  switch (t) {
    case 'hosting':
      return json.hosting.length > 0;
    case 'functions':
      return json.functions;
    case 'firestore:rules':
      return !!json.firestore?.rules;
    case 'firestore:indexes':
      return !!json.firestore?.indexes;
    case 'storage':
      return json.storage;
  }
}

/** 入力の対象を検証して、決まった順に並べる(重複は除く) */
export function normalizeTargets(v: unknown): FirebaseTarget[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const set = new Set<FirebaseTarget>();
  for (const x of list) {
    const t = String(x ?? '').trim();
    if (!t) continue;
    if (!(FIREBASE_TARGETS as string[]).includes(t)) throw new Error(`不明な対象です: ${t}(使えるもの: ${FIREBASE_TARGETS.join(', ')})`);
    set.add(t as FirebaseTarget);
  }
  if (!set.size) throw new Error(`targets を指定してください(${FIREBASE_TARGETS.join(', ')})`);
  return FIREBASE_TARGETS.filter((t) => set.has(t));
}

/** 対象 → firebase deploy --only に渡す名前 */
export function cliOnly(targets: FirebaseTarget[]): string {
  const map: Record<FirebaseTarget, string> = {
    hosting: 'hosting',
    functions: 'functions',
    'firestore:rules': 'firestore:rules',
    'firestore:indexes': 'firestore:indexes',
    storage: 'storage',
  };
  return FIREBASE_TARGETS.filter((t) => targets.includes(t)).map((t) => map[t]).join(',');
}

/** 既定のプレビューチャンネル名: cchub-<yyyymmdd>-<hhmm>(ローカル時刻) */
export function defaultChannelName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `cchub-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function checkChannel(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!CHANNEL_RE.test(s) || s.toLowerCase() === 'live') throw new Error(`チャンネル名が不正です: ${s}(英数字・_・- で 40 文字まで。live は不可)`);
  return s;
}

// ------------------------------------------------------------ CLI の --json 出力
/** 標準出力から JSON を取り出す(前後に余計な行があっても、最初の { から最後の } まで) */
export function extractJson(stdout: string): any | null {
  const s = String(stdout ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  try {
    return JSON.parse(s);
  } catch {
    /* 下で探す */
  }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** {status:'success', result} の result。error なら Error(error の文) */
export function cliResult(stdout: string): any {
  const j = extractJson(stdout);
  if (!j || typeof j !== 'object') throw new Error('firebase CLI の出力を読めませんでした');
  if (j.status === 'error') throw new Error(String(j.error ?? 'firebase CLI がエラーを返しました'));
  return j.result;
}

const time = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** hosting:channel:deploy --json → サイトごとの URL と期限 */
export function parseChannelDeploy(stdout: string): { key: string; site: string; url: string; expireAt: number | null }[] {
  const r = cliResult(stdout);
  if (!r || typeof r !== 'object') throw new Error('プレビューの URL を取得できませんでした');
  const out: { key: string; site: string; url: string; expireAt: number | null }[] = [];
  for (const [key, v] of Object.entries(r as Record<string, any>)) {
    if (!v || typeof v !== 'object' || typeof v.url !== 'string' || !v.url) continue;
    out.push({ key, site: String(v.site || key), url: v.url, expireAt: time(v.expireTime) });
  }
  if (!out.length) throw new Error('プレビューの URL を取得できませんでした');
  return out;
}

/** hosting:channel:list --json → チャンネル一覧 */
export function parseChannelList(stdout: string, siteHint: string): FirebaseInfo['channels'] {
  const r = cliResult(stdout);
  const list: any[] = Array.isArray(r?.channels) ? r.channels : [];
  return list.map((c) => {
    const parts = String(c.name ?? '').split('/');
    const si = parts.indexOf('sites');
    return {
      site: si >= 0 && parts[si + 1] ? parts[si + 1] : siteHint,
      channel: parts[parts.length - 1] || '',
      url: String(c.url ?? ''),
      expireAt: time(c.expireTime),
      updatedAt: time(c.updateTime),
    };
  });
}

/** hosting:sites:list --json → サイト一覧 */
export function parseSitesList(stdout: string): FirebaseInfo['sites'] {
  const r = cliResult(stdout);
  const list: any[] = Array.isArray(r?.sites) ? r.sites : [];
  return list
    .map((s) => {
      const site = String(s.name ?? '').split('/').pop() || '';
      return { site, url: String(s.defaultUrl || `https://${site}.web.app`), isDefault: s.type === 'DEFAULT_SITE' };
    })
    .filter((s) => !!s.site)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map(({ site, url }) => ({ site, url }));
}

/** projects:list --json → プロジェクト一覧 */
export function parseProjectsList(stdout: string): (FirebaseInfo['projects'][number] & { hostingSite: string | null })[] {
  const r = cliResult(stdout);
  const list: any[] = Array.isArray(r) ? r : [];
  return list
    .filter((p) => typeof p?.projectId === 'string')
    .map((p) => ({ projectId: p.projectId, displayName: strOrNull(p.displayName), hostingSite: strOrNull(p.resources?.hostingSite) }));
}

/** functions:list --json → 関数一覧 */
export function parseFunctionsList(stdout: string): FirebaseInfo['functions'] {
  const r = cliResult(stdout);
  const list: any[] = Array.isArray(r) ? r : [];
  const trig = (e: any): string | null => {
    if (e.httpsTrigger) return 'https';
    if (e.callableTrigger) return 'callable';
    if (e.scheduleTrigger) return 'schedule';
    if (e.taskQueueTrigger) return 'taskQueue';
    if (e.blockingTrigger) return `blocking${e.blockingTrigger.eventType ? `: ${e.blockingTrigger.eventType}` : ''}`;
    if (e.eventTrigger) return String(e.eventTrigger.eventType ?? 'event');
    return null;
  };
  return list
    .filter((e) => e && typeof e.id === 'string')
    .map((e) => ({ name: e.id, region: String(e.region ?? ''), runtime: strOrNull(e.runtime), state: strOrNull(e.state), trigger: trig(e) }));
}

/** login:list の出力 → アカウント(未ログインなら null) */
export function parseLoginList(out: string): string | null {
  const m = /Logged in as\s+(\S+@\S+)/.exec(String(out ?? '').replace(/\x1b\[[0-9;]*m/g, ''));
  return m ? m[1] : null;
}

/** CLI のエラー出力を日本語の短い説明にする */
export function explainFirebaseError(text: string): string {
  const s = String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  const low = s.toLowerCase();
  if (/enoent|not recognized as an internal|is not recognized|見つかりません: firebase/.test(low)) return 'firebase CLI が見つかりません(npm i -g firebase-tools でインストールしてください)';
  if (/firebase login|not logged in|no authorized accounts|authentication error|credentials|reauth/.test(low)) return 'firebase login が必要です';
  if (/permission denied|403|does not have permission|caller does not have/.test(low)) return 'このアカウントではプロジェクトにアクセスできません(権限を確認してください)';
  if (/not found|404/.test(low) && /project/.test(low)) return 'プロジェクトが見つかりません(.firebaserc の default を確認してください)';
  if (/econnrefused|enotfound|etimedout|network|socket hang up/.test(low)) return 'Firebase に接続できません(ネットワークを確認してください)';
  const j = extractJson(s);
  if (j && j.status === 'error' && j.error) return String(j.error).slice(0, 300);
  const line = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).find((l) => /error/i.test(l)) ?? s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  return (line || 'firebase CLI がエラーになりました').slice(0, 300);
}
