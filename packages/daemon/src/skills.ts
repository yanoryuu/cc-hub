// スキル / コマンドの一覧(入力欄の "/" 補完用)。
// ユーザー: ~/.claude/skills/*/SKILL.md・~/.claude/commands/**/*.md
// プロジェクト: <cwd> から git のルートまでの各階層の .claude/skills・.claude/commands
// プラグイン: ~/.claude/settings.json の enabledPlugins(true)× ~/.claude/plugins/installed_plugins.json の installPath
//   → <installPath>/skills/*/SKILL.md と commands/*.md。名前は "<plugin>:<name>"
// 同名のものは両方返す(Claude Code ではユーザーがプロジェクトより優先。重複の整理は UI 側で行う)。
import fs from 'node:fs';
import path from 'node:path';
import type { SkillInfo, SkillSource } from '@cc-hub/shared';
import { HOME } from './config';

const CACHE_MS = 30_000;
const DESC_MAX = 300;

/** YAML frontmatter から単純な key: value を取り出す(1 行の値と、> / | の複数行の値。ネストは扱わない) */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const src = String(text ?? '').replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: src };
  const data: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    // 後続のインデントされた行(ブロックスカラー / 折り返されたプレーンスカラー)
    const cont: string[] = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || (lines[i + 1].trim() === '' && i + 2 < lines.length && /^\s+\S/.test(lines[i + 2])))) {
      cont.push(lines[++i]);
    }
    const block = /^([>|])[+-]?\d*\s*(#.*)?$/.exec(val);
    if (block) {
      const indent = Math.min(...cont.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length), Infinity);
      const body = cont.map((l) => (l.trim() ? l.slice(indent === Infinity ? 0 : indent) : ''));
      val = block[1] === '|' ? body.join('\n').trim() : foldLines(body);
    } else {
      if (cont.length) val = [val, ...cont.map((l) => l.trim())].filter(Boolean).join(' ');
      val = unquote(val);
    }
    data[key] = val;
  }
  return { data, body: src.slice(m[0].length) };
}

/** > の折り返し: 空行は改行、それ以外は空白でつなぐ */
function foldLines(lines: string[]): string {
  const out: string[] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (!l.trim()) {
      if (cur.length) out.push(cur.join(' '));
      cur = [];
    } else cur.push(l.trim());
  }
  if (cur.length) out.push(cur.join(' '));
  return out.join('\n').trim();
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** 本文の最初の「見出しでない」行(frontmatter に description が無い場合の説明) */
export function firstTextLine(body: string): string {
  let inCode = false;
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !l || l.startsWith('#') || l.startsWith('<!--') || /^[-*_=]{3,}$/.test(l)) continue;
    return l;
  }
  return '';
}

function readMd(file: string): { data: Record<string, string>; body: string } | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
    return parseFrontmatter(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function describe(md: { data: Record<string, string>; body: string }): string {
  const d = (md.data.description || firstTextLine(md.body)).replace(/\s+/g, ' ').trim();
  return d.length > DESC_MAX ? `${d.slice(0, DESC_MAX - 1)}…` : d;
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** skills/<name>/SKILL.md */
function scanSkills(dir: string, source: SkillSource, plugin?: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const d of listDirs(dir)) {
    const file = path.join(dir, d, 'SKILL.md');
    const md = readMd(file);
    // user-invocable: false のスキルは "/" メニューに出ない(モデルだけが使う)
    if (!md || /^false$/i.test(md.data['user-invocable'] ?? '')) continue;
    const base = (md.data.name || d).trim() || d;
    out.push({ name: plugin ? `${plugin}:${base}` : base, description: describe(md), source, kind: 'skill', ...(plugin ? { plugin } : {}), path: file });
  }
  return out;
}

/** commands/**\/*.md(recursive = サブフォルダも。名前はファイル名) */
function scanCommands(dir: string, source: SkillSource, recursive: boolean, plugin?: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  const walk = (d: string, depth: number) => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith('.')) continue;
      const fp = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (recursive && depth < 4) walk(fp, depth + 1);
        continue;
      }
      if (!/\.md$/i.test(ent.name)) continue;
      const md = readMd(fp);
      if (!md) continue;
      const base = ent.name.replace(/\.md$/i, '');
      out.push({ name: plugin ? `${plugin}:${base}` : base, description: describe(md), source, kind: 'command', ...(plugin ? { plugin } : {}), path: fp });
    }
  };
  walk(dir, 0);
  return out;
}

/** cwd から git のルートまでのディレクトリ(git の外なら cwd だけ)。ホーム(~/.claude はユーザー扱い)は含めない */
export function projectDirs(cwd: string): string[] {
  const start = path.resolve(cwd);
  const chain: string[] = [];
  let dir = start;
  let root: string | null = null;
  for (let i = 0; i < 40; i++) {
    chain.push(dir);
    if (fs.existsSync(path.join(dir, '.git'))) {
      root = dir;
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const dirs = root ? chain : [start];
  const home = path.resolve(HOME).toLowerCase();
  return dirs.filter((d) => d.toLowerCase() !== home);
}

interface InstalledPlugin {
  installPath?: string;
  lastUpdated?: string;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 有効なプラグイン: [{plugin, installPath}] */
export function enabledPlugins(claudeDir = path.join(HOME, '.claude')): { plugin: string; installPath: string }[] {
  const settings = readJson(path.join(claudeDir, 'settings.json'));
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const enabled = settings?.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {};
  const plugins = installed?.plugins && typeof installed.plugins === 'object' ? installed.plugins : {};
  const out: { plugin: string; installPath: string }[] = [];
  for (const [key, on] of Object.entries(enabled)) {
    if (on !== true) continue;
    const entries: InstalledPlugin[] = Array.isArray(plugins[key]) ? plugins[key] : plugins[key] ? [plugins[key]] : [];
    // 複数ある場合は最後に更新されたもの
    const ent = [...entries]
      .filter((x) => x && typeof x.installPath === 'string' && fs.existsSync(x.installPath))
      .sort((a, b) => String(b.lastUpdated ?? '').localeCompare(String(a.lastUpdated ?? '')))[0];
    if (!ent?.installPath) continue;
    out.push({ plugin: key.split('@')[0], installPath: ent.installPath });
  }
  return out;
}

/** 一覧を作る(キャッシュなし) */
export function scanSkillsFor(cwd: string | null): SkillInfo[] {
  const claudeDir = path.join(HOME, '.claude');
  const out: SkillInfo[] = [];
  out.push(...scanSkills(path.join(claudeDir, 'skills'), 'user'));
  out.push(...scanCommands(path.join(claudeDir, 'commands'), 'user', true));
  if (cwd) {
    for (const d of projectDirs(cwd)) {
      out.push(...scanSkills(path.join(d, '.claude', 'skills'), 'project'));
      out.push(...scanCommands(path.join(d, '.claude', 'commands'), 'project', true));
    }
  }
  for (const p of enabledPlugins(claudeDir)) {
    out.push(...scanSkills(path.join(p.installPath, 'skills'), 'plugin', p.plugin));
    out.push(...scanCommands(path.join(p.installPath, 'commands'), 'plugin', false, p.plugin));
  }
  return out;
}

const cache = new Map<string, { at: number; skills: SkillInfo[] }>();

/** cwd ごとに 30 秒キャッシュする */
export function listSkills(cwd: string | null): SkillInfo[] {
  const key = cwd ? path.resolve(cwd).toLowerCase() : '';
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.skills;
  const skills = scanSkillsFor(cwd);
  cache.set(key, { at: now, skills });
  if (cache.size > 100) {
    for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k);
  }
  return skills;
}
