// Firebase: API / 情報のキャッシュ(5 分)/ 表示用ヘルパー
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { DeployJob, DeployState, FirebaseInfo, FirebaseTarget, RepoInfo } from '@cc-hub/shared';
import { api, errText, pick } from './api';
import { normPath } from './project';

const enc = encodeURIComponent;

// ---------------------------------------------------------------- 表示

/** デプロイ対象(この順で並べる) */
export const TARGET_ORDER: FirebaseTarget[] = ['hosting', 'functions', 'firestore:rules', 'firestore:indexes', 'storage'];

export const TARGET_LABEL: Record<FirebaseTarget, string> = {
  hosting: 'Hosting',
  functions: 'Functions',
  'firestore:rules': 'Firestore ルール',
  'firestore:indexes': 'Firestore インデックス',
  storage: 'Storage ルール',
};

export const TARGET_DESC: Record<FirebaseTarget, string> = {
  hosting: 'サイト(静的ファイル)を公開します',
  functions: 'Cloud Functions(サーバー側の処理)を更新します',
  'firestore:rules': 'Firestore のセキュリティルールを更新します',
  'firestore:indexes': 'Firestore の複合インデックスを更新します',
  storage: 'Cloud Storage のセキュリティルールを更新します',
};

/** firebase.json に設定があるか(対象のチェックボックスを有効にするか) */
export function targetConfigured(info: FirebaseInfo | null | undefined, t: FirebaseTarget): boolean {
  if (!info) return false;
  if (t === 'hosting') return info.configured.hosting;
  if (t === 'functions') return info.configured.functions;
  if (t === 'storage') return info.configured.storage;
  return info.configured.firestore;
}

/** Firebase のデプロイの状態ラベル(アップロード用の文言を Firebase 向けに) */
const FB_STATE_LABEL: Partial<Record<DeployState, string>> = {
  pending_approval: '承認待ち',
  planning: 'ビルド・準備中',
  uploading: 'デプロイ中',
  preview_ready: 'プレビュー確認待ち',
  done: '公開済み',
  cancelled: '破棄',
};
export function firebaseStateLabel(s: DeployState): string | undefined {
  return FB_STATE_LABEL[s];
}

/** 期限までの残り: "あと 6 日" / "あと 5 時間" / "期限切れ" */
export function fmtExpiresIn(at: number | null | undefined, now = Date.now()): string {
  if (!at) return '期限なし';
  const ms = at - now;
  if (ms <= 0) return '期限切れ';
  const h = ms / 3_600_000;
  if (h < 1) return `あと ${Math.max(1, Math.round(ms / 60_000))} 分`;
  if (h < 48) return `あと ${Math.round(h)} 時間`;
  return `あと ${Math.round(h / 24)} 日`;
}

/** URL の表示用(https:// を省く) */
export function shortUrl(u: string): string {
  return u.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function isFirebaseDeploy(d: Pick<DeployJob, 'firebase'>): boolean {
  return !!d.firebase;
}

/** このプロジェクト(Firebase の projectId / firebase.json のフォルダ)のデプロイか */
export function deployInProject(d: DeployJob, info: FirebaseInfo | null | undefined): boolean {
  if (!d.firebase || !info) return false;
  if (info.projectId && d.firebase.projectId === info.projectId) return true;
  return !!info.projectDir && normPath(d.firebase.projectDir) === normPath(info.projectDir);
}

/** ホーム / 管理画面で Firebase を調べるフォルダ。リポジトリはベースのクローン(<baseDir>\.base。firebase.json はチェックアウト側にある) */
export function firebaseCwdFor(repo: Pick<RepoInfo, 'baseDir'> | null | undefined, fallback: string): string {
  if (!repo?.baseDir) return fallback;
  return `${repo.baseDir.replace(/[\\/]+$/, '')}\\.base`;
}

// ---------------------------------------------------------------- API

export interface FirebaseDeployBody {
  cwd: string;
  targets: FirebaseTarget[];
  preview?: boolean;
  channel?: string;
  buildCommand?: string;
}

export const firebaseApi = {
  info: async (cwd: string, refresh = false): Promise<FirebaseInfo | null> => {
    const r = await api(`/api/firebase?cwd=${enc(cwd)}${refresh ? '&refresh=1' : ''}`);
    return pick<FirebaseInfo>(r, 'info') ?? null;
  },
  deploy: async (b: FirebaseDeployBody): Promise<DeployJob | undefined> => pick<DeployJob>(await api('/api/firebase/deploy', b), 'deploy'),
};

// ---------------------------------------------------------------- 情報のキャッシュ(フォルダごと 5 分)

const TTL = 5 * 60_000;
interface Entry {
  info: FirebaseInfo | null;
  error: string | null;
  at: number;
}
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<void>>();
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

function load(cwd: string, refresh: boolean): Promise<void> {
  const k = normPath(cwd);
  const cur = inflight.get(k);
  if (cur && !refresh) return cur;
  const p = firebaseApi
    .info(cwd, refresh)
    .then((info) => {
      cache.set(k, { info, error: null, at: Date.now() });
    })
    .catch((e) => {
      // 未対応のデーモン(404)などは「Firebase なし」と同じ扱いにしつつ、管理画面ではエラーを見せる
      const prev = cache.get(k);
      cache.set(k, { info: prev?.info ?? null, error: errText(e, 'Firebase の情報を取得できませんでした'), at: Date.now() });
    })
    .finally(() => {
      inflight.delete(k);
      emit();
    });
  inflight.set(k, p);
  emit();
  return p;
}

/** firebase.json が見つかったか(info があり projectDir がある) */
export function hasFirebase(info: FirebaseInfo | null | undefined): info is FirebaseInfo {
  return !!info && !!info.projectDir;
}

export interface FirebaseInfoState {
  info: FirebaseInfo | null;
  error: string | null;
  loading: boolean;
  /** 一度でも取得できたか */
  loaded: boolean;
  checkedAt: number | null;
  refresh(): void;
}

/**
 * フォルダの Firebase 情報(キャッシュ 5 分)。enabled = false の間は取得しない(ホームのカードは画面に見えてから)。
 */
export function useFirebaseInfo(cwd: string | null | undefined, enabled = true): FirebaseInfoState {
  const k = cwd ? normPath(cwd) : '';
  const snap = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => (k ? cache.get(k) : undefined),
  );
  const loading = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => (k ? inflight.has(k) : false),
  );
  useEffect(() => {
    if (!cwd || !enabled) return;
    const e = cache.get(k);
    if (e && Date.now() - e.at < TTL) return;
    void load(cwd, false);
  }, [k, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = useCallback(() => {
    if (cwd) void load(cwd, true);
  }, [cwd]);
  return {
    info: snap?.info ?? null,
    error: snap?.error ?? null,
    loading,
    loaded: !!snap,
    checkedAt: snap?.info?.checkedAt ?? snap?.at ?? null,
    refresh,
  };
}

/** 要素が画面に入ったら true(一度入ったら true のまま) */
export function useVisible<T extends Element>(): [(el: T | null) => void, boolean] {
  const [el, setEl] = useState<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        setSeen(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [el, seen]);
  return [setEl, seen];
}
