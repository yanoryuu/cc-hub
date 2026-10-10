// 通知の設定(SQLite の settings に 'notify' として保存)。
// Discord の Webhook URL は DPAPI で暗号化して保存し、API には伏せ字(末尾 6 文字)だけ返す。
import crypto from 'node:crypto';
import type { DiscordTarget, NotifySettings, NotifyTopic } from '@cc-hub/shared';
import { ALL_TOPICS } from './topic';
import { maskWebhook, validateWebhookUrl } from './discord';
import { HttpError } from '../util';

/** 保存形式の Discord 送信先(webhookEnc = DPAPI の暗号文) */
export interface StoredDiscordTarget extends DiscordTarget {
  webhookEnc: string;
}

export interface StoredNotifySettings extends Omit<NotifySettings, 'discord'> {
  discord: StoredDiscordTarget[];
}

export const DEFAULT_WINDOWS_TOPICS: NotifyTopic[] = ['approval', 'input', 'error', 'pr_ci_failed', 'pr_review', 'pr_merged', 'deploy_request', 'deploy_done'];
export const DEFAULT_DISCORD_TOPICS: NotifyTopic[] = ['approval', 'error', 'pr_ci_failed', 'pr_merged', 'deploy_request', 'deploy_done'];

export function defaultSettings(): StoredNotifySettings {
  return {
    windows: { enabled: true, topics: [...DEFAULT_WINDOWS_TOPICS], suppressWhenViewing: true },
    discord: [],
    throttleSeconds: 30,
  };
}

function topics(v: unknown, def: NotifyTopic[]): NotifyTopic[] {
  if (!Array.isArray(v)) return [...def];
  return [...new Set(v.map(String).filter((t): t is NotifyTopic => (ALL_TOPICS as string[]).includes(t)))];
}

/** 保存済みの値を読み込む(壊れた値は既定で補う) */
export function loadStored(raw: unknown): StoredNotifySettings {
  const d = defaultSettings();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<StoredNotifySettings>;
  const w = (r.windows ?? {}) as Partial<NotifySettings['windows']>;
  return {
    windows: {
      enabled: w.enabled !== false,
      topics: topics(w.topics, d.windows.topics),
      suppressWhenViewing: w.suppressWhenViewing !== false,
    },
    discord: Array.isArray(r.discord)
      ? r.discord
          .filter((t) => t && typeof t === 'object' && typeof t.id === 'string' && typeof t.webhookEnc === 'string')
          .map((t) => ({
            id: t.id,
            name: String(t.name ?? ''),
            webhookMasked: String(t.webhookMasked ?? ''),
            webhookEnc: t.webhookEnc,
            repoIds: Array.isArray(t.repoIds) ? t.repoIds.map(String) : [],
            topics: topics(t.topics, DEFAULT_DISCORD_TOPICS),
            enabled: t.enabled !== false,
          }))
      : [],
    throttleSeconds: clampThrottle(r.throttleSeconds, d.throttleSeconds),
  };
}

function clampThrottle(v: unknown, def: number): number {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return def;
  return Math.max(0, Math.min(3600, Math.round(n)));
}

/** API に返す形(暗号文を取り除く) */
export function toPublic(s: StoredNotifySettings): NotifySettings {
  return {
    windows: { ...s.windows, topics: [...s.windows.topics] },
    discord: s.discord.map(({ webhookEnc: _e, ...t }) => ({ ...t, repoIds: [...t.repoIds], topics: [...t.topics] })),
    throttleSeconds: s.throttleSeconds,
  };
}

/**
 * PUT /api/notify/settings の内容を検証して、保存する値を作る。
 * discord[].webhookUrl に新しい URL があるときだけ暗号化して差し替える(空なら同じ id の既存の値を据え置く)
 */
export async function mergeUpdate(
  cur: StoredNotifySettings,
  body: any,
  protect: (plain: string) => Promise<string>,
): Promise<StoredNotifySettings> {
  if (!body || typeof body !== 'object') throw new HttpError(400, '設定の形式が不正です');
  const w = body.windows ?? {};
  const next: StoredNotifySettings = {
    windows: {
      enabled: w.enabled == null ? cur.windows.enabled : w.enabled === true,
      topics: w.topics == null ? cur.windows.topics : topics(w.topics, []),
      suppressWhenViewing: w.suppressWhenViewing == null ? cur.windows.suppressWhenViewing : w.suppressWhenViewing === true,
    },
    discord: [],
    throttleSeconds: body.throttleSeconds == null ? cur.throttleSeconds : clampThrottle(body.throttleSeconds, cur.throttleSeconds),
  };
  const list = body.discord == null ? null : body.discord;
  if (list == null) {
    next.discord = cur.discord;
    return next;
  }
  if (!Array.isArray(list)) throw new HttpError(400, 'discord は配列で指定してください');
  if (list.length > 20) throw new HttpError(400, 'Discord の送信先は 20 件までです');
  const seen = new Set<string>();
  for (const t of list) {
    if (!t || typeof t !== 'object') throw new HttpError(400, 'discord の項目が不正です');
    const id = typeof t.id === 'string' && /^[\w-]{1,64}$/.test(t.id) ? t.id : crypto.randomUUID();
    if (seen.has(id)) throw new HttpError(400, `discord の id が重複しています: ${id}`);
    seen.add(id);
    const old = cur.discord.find((x) => x.id === id);
    const url = typeof t.webhookUrl === 'string' ? t.webhookUrl.trim() : '';
    let webhookEnc = old?.webhookEnc ?? '';
    let webhookMasked = old?.webhookMasked ?? '';
    if (url) {
      const err = validateWebhookUrl(url);
      if (err) throw new HttpError(400, `${String(t.name || '送信先')}: ${err}`);
      webhookEnc = await protect(url);
      webhookMasked = maskWebhook(url);
    }
    if (!webhookEnc) throw new HttpError(400, `${String(t.name || '送信先')}: Webhook URL を入力してください`);
    next.discord.push({
      id,
      name: String(t.name ?? '').trim().slice(0, 50) || 'Discord',
      webhookMasked,
      webhookEnc,
      repoIds: Array.isArray(t.repoIds) ? t.repoIds.map(String).filter(Boolean).slice(0, 100) : [],
      topics: topics(t.topics, DEFAULT_DISCORD_TOPICS),
      enabled: t.enabled !== false,
    });
  }
  return next;
}
