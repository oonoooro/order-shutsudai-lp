'use strict';
// SharePoint 用パッケージ（ZIP）の自動テスト
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../xlsx-writer');
const pkg = require('../scripts/build-package');

const ROOT = path.join(__dirname, '..');

// ZIP の中央ディレクトリから「名前 → 中身」を取り出す（無圧縮で格納している前提）
function entries(bytes) {
  const buf = Buffer.from(bytes);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = buf.subarray(start, start + size);
    assert.equal(method, 0);
    assert.equal(W.crc32(data), crc, name + ' の CRC');
    out[name] = data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const built = pkg.build(new Date(2026, 0, 13, 9, 0));
const files = entries(built.bytes);
const names = Object.keys(files);
const TOP = 'leasing-dashboard-sharepoint/';

test('パッケージ: ZIP として正しく、ファイル名は英数字だけ', () => {
  assert.ok(names.length >= 30);
  names.forEach((n) => assert.doesNotMatch(n, /[^\x20-\x7e]/, n));
  assert.ok(names.includes(TOP + 'README_FIRST.txt'));
  assert.ok(names.includes(TOP + '1_sharepoint/SAMPLE_leasing_dashboard.xlsx'));
  assert.ok(names.includes(TOP + '3_copilot/sharepoint_agent_instructions.txt'));
});

test('パッケージ: 実データ（data/ のデータファイル・出力した Excel）を含まない', () => {
  const dataFiles = names.filter((n) => n.indexOf(TOP + '2_dashboard/data/') === 0);
  assert.deepEqual(dataFiles, [TOP + '2_dashboard/data/README.md']);
  assert.ok(!names.some((n) => /source_mapping|output\//.test(n)));
  // 見本 Excel は sample_data（架空）から作る
  const sample = files[TOP + '1_sharepoint/SAMPLE_leasing_dashboard.xlsx'].toString('utf8');
  assert.match(sample, /サンプル物件A/);
});

test('パッケージ: ダッシュボードの画面と自己診断が読み込むファイルがすべて入っている', () => {
  ['index.html', 'selftest.html'].forEach((html) => {
    const srcs = [...fs.readFileSync(path.join(ROOT, html), 'utf8').matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.length > 3);
    srcs.forEach((s) => assert.ok(names.includes(TOP + '2_dashboard/' + s), html + ' が読み込む ' + s));
  });
});

test('パッケージ: 中身は元のファイルと同じ（変更していない）', () => {
  pkg.DASHBOARD_FILES.forEach((rel) => {
    assert.equal(Buffer.compare(files[TOP + '2_dashboard/' + rel], fs.readFileSync(path.join(ROOT, rel))), 0, rel);
  });
  assert.equal(Buffer.compare(files[TOP + '3_copilot/SHAREPOINT_GUIDE.txt'], fs.readFileSync(path.join(ROOT, 'SHAREPOINT_GUIDE.md'))), 0);
  const readme = files[TOP + 'README_FIRST.txt'];
  assert.deepEqual([...readme.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'メモ帳で文字化けしないよう BOM 付き UTF-8');
  assert.match(readme.toString('utf8'), /SharePoint用Excelを保存/);
});

test('パッケージ作成コマンド: 指定の場所に書き出す', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-'));
  try {
    const out = path.join(tmp, 'sub', 'p.zip');
    const r = pkg.run({ out });
    assert.equal(r.exitCode, 0);
    assert.ok(fs.statSync(out).size > 10000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
