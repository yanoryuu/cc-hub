// メディアビューア(一覧・パス検査・Range 配信)のテスト
// 実行: npm run test -w @cc-hub/daemon
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { listMedia, mediaKind, resolveMediaPath, sendMediaFile } from '../src/media';
import { HttpError } from '../src/util';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}`);
    throw e;
  }
}

const parent = fs.existsSync('D:\\AITEST') ? 'D:\\AITEST' : os.tmpdir();
const tmp = fs.mkdtempSync(path.join(parent, 'cchub-media-'));
const w = (rel: string, data: string | Buffer, mtime?: number) => {
  const f = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  if (mtime) fs.utimesSync(f, mtime / 1000, mtime / 1000);
};
const now = Date.now();
w('shot.png', 'png', now - 3000);
w('Assets/Models/hero.FBX', 'fbx', now - 1000);
w('Assets/Models/scene.gltf', '{}', now - 2000);
w('Assets/Models/scene.bin', 'bin');
w('videos/demo.mp4', Buffer.from('0123456789'), now);
w('node_modules/pkg/logo.png', 'x');
w('Library/cache.png', 'x');
w('.hidden/a.png', 'x');
w('readme.md', 'x');

async function main(): Promise<void> {
  await test('mediaKind は拡張子(大文字も)で種類を返す', () => {
    assert.equal(mediaKind('a.STL'), 'model');
    assert.equal(mediaKind('a.glb'), 'model');
    assert.equal(mediaKind('a.webm'), 'video');
    assert.equal(mediaKind('a.jpeg'), 'image');
    assert.equal(mediaKind('a.txt'), null);
  });

  await test('listMedia は新しい順で、node_modules / Library / 隠しフォルダを見ない', async () => {
    const r = await listMedia(tmp);
    assert.equal(r.truncated, false);
    assert.deepEqual(
      r.items.map((i) => `${i.kind}:${i.path}`),
      ['video:videos/demo.mp4', 'model:Assets/Models/hero.FBX', 'model:Assets/Models/scene.gltf', 'image:shot.png'],
    );
    assert.equal(r.items[0].size, 10);
  });

  await test('resolveMediaPath は外・.git・絶対パスを拒む', async () => {
    assert.equal(await resolveMediaPath(tmp, 'Assets/Models/scene.bin'), path.join(tmp, 'Assets', 'Models', 'scene.bin'));
    for (const bad of ['../x.png', 'a/../../x.png', 'C:/Windows/win.ini', '/etc/passwd', '.git/config', '']) {
      await assert.rejects(resolveMediaPath(tmp, bad), (e) => e instanceof HttpError && e.status === 400, bad);
    }
    await assert.rejects(resolveMediaPath(tmp, 'nothing.png'), (e) => e instanceof HttpError && e.status === 404);
  });

  await test('sendMediaFile は Range で一部を返し、Content-Type と nosniff を付ける', async () => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url ?? '/').slice(1));
      resolveMediaPath(tmp, rel)
        .then((abs) => sendMediaFile(req, res, abs))
        .catch((e) => {
          res.writeHead(e instanceof HttpError ? e.status : 500);
          res.end();
        });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      const full = await fetch(`http://127.0.0.1:${port}/videos/demo.mp4`);
      assert.equal(full.status, 200);
      assert.equal(full.headers.get('content-type'), 'video/mp4');
      assert.equal(full.headers.get('accept-ranges'), 'bytes');
      assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(await full.text(), '0123456789');

      const part = await fetch(`http://127.0.0.1:${port}/videos/demo.mp4`, { headers: { Range: 'bytes=2-5' } });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get('content-range'), 'bytes 2-5/10');
      assert.equal(await part.text(), '2345');

      const tail = await fetch(`http://127.0.0.1:${port}/videos/demo.mp4`, { headers: { Range: 'bytes=-3' } });
      assert.equal(tail.status, 206);
      assert.equal(await tail.text(), '789');

      const bad = await fetch(`http://127.0.0.1:${port}/videos/demo.mp4`, { headers: { Range: 'bytes=20-30' } });
      assert.equal(bad.status, 416);

      const unknown = await fetch(`http://127.0.0.1:${port}/readme.md`);
      assert.equal(unknown.headers.get('content-type'), 'application/octet-stream');
      assert.match(unknown.headers.get('content-security-policy') ?? '', /sandbox/);

      const out = await fetch(`http://127.0.0.1:${port}/..%2Fx.png`);
      assert.equal(out.status, 400);
    } finally {
      srv.close();
    }
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nmedia: ${passed} passed`);
}

main().catch((e) => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
