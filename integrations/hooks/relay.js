#!/usr/bin/env node
// CC Hub hooks 中継スクリプト(command 型 hook 用。依存なしの CommonJS)
// SessionStart は http 型 hook が発火しない(検証で確認)ため、command 型 + async でこのスクリプトを呼び、
// stdin の JSON をデーモンの /ingest/hook にそのまま転送する。
// 何も出力しない(SessionStart の stdout は会話のコンテキストに追加されてしまうため)。失敗はすべて無視。
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

function dataDir() {
  if (process.env.CC_HUB_DATA_DIR) return path.resolve(process.env.CC_HUB_DATA_DIR);
  const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'cc-hub');
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
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
    process.exit(0);
  }
  const body = Buffer.concat(chunks);
  try {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/ingest/hook',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'X-CC-Hub-Token': token,
          'X-CC-Hub-Session': process.env.CC_HUB_SESSION || '',
        },
        timeout: 1000,
      },
      (res) => {
        res.resume();
        res.on('end', () => process.exit(0));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => process.exit(0));
    req.end(body);
  } catch (_) {
    process.exit(0);
  }
  setTimeout(() => process.exit(0), 1000).unref();
});
