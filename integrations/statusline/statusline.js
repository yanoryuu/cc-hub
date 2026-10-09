#!/usr/bin/env node
// CC Hub statusLine スクリプト(claude-statusline.ps1 の置き換え。依存なしの CommonJS)
//  1. stdin の JSON を読み、今までと同じ表示(`Session: X% | Context: Y%`)を出力する
//  2. 受け取った JSON を CC Hub デーモンの /ingest/statusline に転送する(300ms で打ち切り、失敗は無視)
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

function dataDir() {
  if (process.env.CC_HUB_DATA_DIR) return path.resolve(process.env.CC_HUB_DATA_DIR);
  const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'cc-hub');
}

// 小数点以下を切り捨てた整数(%)。値が無ければ null
function pct(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

function render(data) {
  const contextPct = pct(data && data.context_window && data.context_window.used_percentage);
  const ratePct = pct(data && data.rate_limits && data.rate_limits.five_hour && data.rate_limits.five_hour.used_percentage);
  if (ratePct !== null && contextPct !== null) return `Session: ${ratePct}% | Context: ${contextPct}%`;
  if (contextPct !== null) return `Context: ${contextPct}%`;
  return 'Context: -';
}

function forward(data) {
  let port = 7861;
  let token = '';
  try {
    const dir = dataDir();
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
      if (cfg && Number(cfg.port)) port = Number(cfg.port);
    } catch (_) {
      /* 既定ポート */
    }
    token = fs.readFileSync(path.join(dir, 'ingest-token'), 'utf8').trim();
  } catch (_) {
    return; // トークンが無ければデーモン未導入とみなして何もしない
  }
  if (!token) return;
  const body = JSON.stringify({ hub_session: process.env.CC_HUB_SESSION || null, data });
  try {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/ingest/statusline',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-CC-Hub-Token': token,
        },
        timeout: 300,
      },
      (res) => {
        res.resume();
        res.on('end', () => process.exit(0));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => process.exit(0));
    req.end(body);
    // 何があっても 300ms で終わる
    setTimeout(() => process.exit(0), 300).unref();
  } catch (_) {
    /* 無視 */
  }
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks).toString('utf8');
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    data = null;
  }
  // 表示を先に出す(転送で遅らせない)
  // (書き込み完了を待ってから転送する。転送側は process.exit で終わるため)
  process.stdout.write((data ? render(data) : 'Context: -') + '\n', () => {
    if (data) forward(data);
  });
});
