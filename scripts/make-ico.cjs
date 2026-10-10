// PNG から Windows のショートカット用 .ico を作る(PNG をそのまま埋め込む形式。Vista 以降で表示できる)
// 使い方: node scripts/make-ico.cjs <入力.png> <出力.ico>
const fs = require('fs');
const [, , src, dst] = process.argv;
const png = fs.readFileSync(src);
const w = png.readUInt32BE(16);
const h = png.readUInt32BE(20);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // 予約
header.writeUInt16LE(1, 2); // 種類 = アイコン
header.writeUInt16LE(1, 4); // 画像の数
const entry = Buffer.alloc(16);
entry.writeUInt8(w >= 256 ? 0 : w, 0);
entry.writeUInt8(h >= 256 ? 0 : h, 1);
entry.writeUInt8(0, 2); // パレット数
entry.writeUInt8(0, 3);
entry.writeUInt16LE(1, 4); // カラープレーン
entry.writeUInt16LE(32, 6); // ビット数
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(6 + 16, 12); // 画像データの位置
fs.writeFileSync(dst, Buffer.concat([header, entry, png]));
console.log(`${dst} (${w}x${h})`);
