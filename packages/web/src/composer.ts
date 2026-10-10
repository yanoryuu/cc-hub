// 指示の入力欄(Composer)の状態: セッションごとの下書き・送信履歴・添付、外からの挿入、引き継ぎ後の送信待ち。
// コンポーネントはセッションを切り替えるたびに作り直されるので、状態はここ(モジュール)に持つ。
import { useEffect, useState } from 'react';
import { sessionApi } from './api';
import { readLocal, writeLocal } from './util';

export interface Attachment {
  /** 一時 ID(アップロード中の行を特定する) */
  id: number;
  name: string;
  mime: string;
  /** 画像のプレビュー(object URL) */
  preview: string | null;
  /** アップロード後のパス(cwd からの相対)。アップロード中は null */
  path: string | null;
  error: string | null;
}

export interface Draft {
  text: string;
  attachments: Attachment[];
}

const drafts = new Map<string, Draft>();
const subs = new Map<string, Set<() => void>>();
/** 次にマウントされた入力欄でフォーカスする */
const focusWanted = new Set<string>();

export function getDraft(sid: string): Draft {
  return drafts.get(sid) ?? { text: '', attachments: [] };
}

export function setDraft(sid: string, d: Draft, notify = false): void {
  drafts.set(sid, d);
  if (notify) subs.get(sid)?.forEach((f) => f());
}

/** 入力欄に外から文字を入れる(スキル一覧のクリックなど)。先頭の "/xxx " は置き換える */
export function insertIntoComposer(sid: string, text: string): void {
  const d = getDraft(sid);
  const rest = d.text.replace(/^\/\S*\s?/, '');
  const next = text.startsWith('/') ? text + rest : d.text + (d.text && !/\s$/.test(d.text) ? ' ' : '') + text;
  focusWanted.add(sid);
  setDraft(sid, { ...d, text: next }, true);
}

/** 外からの変更を受け取る */
export function useDraftSubscription(sid: string, onChange: () => void): void {
  useEffect(() => {
    let set = subs.get(sid);
    if (!set) subs.set(sid, (set = new Set()));
    const s = set;
    s.add(onChange);
    return () => {
      s.delete(onChange);
    };
  }, [sid, onChange]);
}

export function takeFocusWanted(sid: string): boolean {
  return focusWanted.delete(sid);
}

// ---------------------------------------------------------------- 送信履歴(localStorage、セッションごと)

const HIST_MAX = 50;
const histKey = (sid: string) => `cchub_hist:${sid}`;

export function readHistory(sid: string): string[] {
  try {
    const v = JSON.parse(readLocal(histKey(sid), '[]'));
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function pushHistory(sid: string, text: string): void {
  const h = readHistory(sid).filter((x) => x !== text);
  h.push(text);
  writeLocal(histKey(sid), JSON.stringify(h.slice(-HIST_MAX)));
}

// ---------------------------------------------------------------- 引き継いでから送信

/** 引き継ぎ後、入力待ちになったら送る指示(セッション ID → 本文) */
const pendingSends = new Map<string, string>();
const pendingSubs = new Set<() => void>();

export function queueSendAfterTakeover(sid: string, text: string): void {
  pendingSends.set(sid, text);
  pendingSubs.forEach((f) => f());
}

/** 送信待ちを取りやめる(本文は下書きに戻す) */
export function cancelPendingSend(sid: string): void {
  const text = pendingSends.get(sid);
  if (text == null) return;
  pendingSends.delete(sid);
  pendingSubs.forEach((f) => f());
  const d = getDraft(sid);
  if (!d.text) setDraft(sid, { ...d, text }, true);
}

export function usePendingSend(sid: string): string | null {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    pendingSubs.add(f);
    return () => {
      pendingSubs.delete(f);
    };
  }, []);
  return pendingSends.get(sid) ?? null;
}

/** 送信待ちの指示を送る(呼び出し側で「CC Hub 管理下で入力待ち」を確認してから) */
export async function flushPendingSend(sid: string): Promise<void> {
  const text = pendingSends.get(sid);
  if (text == null) return;
  pendingSends.delete(sid);
  pendingSubs.forEach((f) => f());
  try {
    await sessionApi.input(sid, text, true);
    pushHistory(sid, text);
  } catch {
    // 失敗したら下書きに戻す(消えないように)
    const d = getDraft(sid);
    if (!d.text) setDraft(sid, { ...d, text }, true);
  }
}

// ---------------------------------------------------------------- スラッシュコマンド(組み込み)

export interface BuiltinCommand {
  name: string;
  description: string;
}

/** Claude Code の組み込みコマンド(補完に出す主なもの) */
export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: 'compact', description: '会話を要約してコンテキストを空ける(後ろに要約の指示を書ける)' },
  { name: 'clear', description: '会話をリセットして新しく始める' },
  { name: 'model', description: '使うモデルを切り替える' },
  { name: 'context', description: 'コンテキストの使用状況を表示' },
  { name: 'cost', description: 'このセッションのコストとトークン数を表示' },
  { name: 'help', description: 'コマンドの一覧とヘルプ' },
  { name: 'resume', description: '過去の会話を選んで再開' },
  { name: 'review', description: 'プルリクエストをレビューする' },
  { name: 'init', description: 'CLAUDE.md を作ってプロジェクトの説明を書く' },
  { name: 'memory', description: 'CLAUDE.md(メモリ)を編集' },
  { name: 'permissions', description: 'ツールの許可ルールを表示・編集' },
  { name: 'agents', description: 'サブエージェントの管理' },
  { name: 'mcp', description: 'MCP サーバーの接続状況と認証' },
  { name: 'status', description: 'バージョン・モデル・アカウントなどを表示' },
  { name: 'config', description: '設定を開く' },
  { name: 'export', description: '会話をファイルやクリップボードに書き出す' },
  { name: 'rewind', description: '会話やコードを前の時点に戻す' },
  { name: 'todos', description: '現在の TODO リストを表示' },
  { name: 'usage', description: 'プランの使用量と制限を表示' },
];

/** ファイルを base64 に(data URL の先頭を除く) */
export function fileToBase64(f: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error ?? new Error('読み込みに失敗しました'));
    r.readAsDataURL(f);
  });
}
