'use strict';
// SharePoint 用 Excel レポートの自動テスト（データはすべて架空）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const X = require('../xlsx');
const W = require('../xlsx-writer');
const R = require('../report-xlsx');
const exporter = require('../scripts/export-excel');
const H = require('./helpers');

const { core, config } = H;
const FIXED = new Date(2026, 0, 13, 9, 0);
const MASTER = 'project_number,project_name,property_name_ja,TMK,担当者\nT-001,Alpha,テスト物件1,架空TMK1,XA\nT-002,Bravo,テスト物件2,架空TMK2,XB\nT-003,Charlie,テスト物件3,架空TMK1,XA\n';

function model(props, extra, master) { return H.build(H.dataset(props, extra), master === undefined ? MASTER : master); }
function read(bytes) { return X.readWorkbook(bytes, { inflateRaw: (b) => zlib.inflateRawSync(b) }); }
function rows(sheet) {
  const out = [];
  for (let r = 1; r <= sheet.maxRow; r++) {
    const row = [];
    for (let c = 1; c <= sheet.maxCol; c++) row.push(sheet.value(r, c));
    out.push(row);
  }
  return out;
}

test('Excel レポート: Excel として読める（ZIP・CRC・シート構成）', async () => {
  const m = model([H.rec(), H.rec({ project_number: 'T-002', total_units: 20, occupied_units: 20, vacant_units: 0, application_units: 0, occupancy_rate_source: 1, occupancy_rate_calculated: 1, occupancy_after_application_calculated: 1 })]);
  const r = R.buildReport(m, m.period, config, { generatedAt: FIXED });
  assert.equal(r.fileName, config.excelReportFileName);
  assert.doesNotMatch(r.fileName, /\d{4}/, 'ファイル名に日付を入れない（毎週同じ URL で上書きするため）');
  const wb = await read(r.bytes);
  assert.deepEqual(wb.sheetNames.slice(0, 3), ['サマリー', '物件一覧', '空室率']);
  for (const name of ['長期空室', '申込・解約', '条件変更', '工事', 'アラート', 'データ検証', 'データのない物件']) assert.ok(wb.sheetNames.includes(name), name);
  // 全エントリの CRC32 がデータと一致する（壊れたファイルにしない）
  const buf = Buffer.from(r.bytes);
  let p = 0, n = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const crc = buf.readUInt32LE(p + 14), size = buf.readUInt32LE(p + 18), nameLen = buf.readUInt16LE(p + 26), extraLen = buf.readUInt16LE(p + 28);
    const data = buf.subarray(p + 30 + nameLen + extraLen, p + 30 + nameLen + extraLen + size);
    assert.equal(W.crc32(data), crc);
    p += 30 + nameLen + extraLen + size; n++;
  }
  assert.ok(n >= 12);
  // 同じ入力・同じ日時なら同じファイルになる
  assert.equal(Buffer.compare(buf, Buffer.from(R.buildReport(m, m.period, config, { generatedAt: FIXED }).bytes)), 0);
});

test('Excel レポート: 物件一覧にマスターの列（TMK・担当者）と数値を入れ、見出しに絞り込みを付ける', async () => {
  const m = model([H.rec(), H.rec({ project_number: 'T-002', total_units: 20, occupied_units: 20, vacant_units: 0, application_units: 0, occupancy_rate_source: 1, occupancy_rate_calculated: 1, occupancy_after_application_calculated: 1 })]);
  const r = R.buildReport(m, m.period, config, { generatedAt: FIXED });
  const wb = await read(r.bytes);
  const t = rows(wb.sheet('物件一覧'));
  const head = t[0];
  assert.deepEqual(head.slice(0, 4), ['Project #', '日本語物件名', 'TMK', '担当者']);
  const col = (name) => head.indexOf(name);
  const t1 = t.find((x) => x[0] === 'T-001'), t2 = t.find((x) => x[0] === 'T-002'), t3 = t.find((x) => x[0] === 'T-003');
  assert.equal(t1[col('TMK')], '架空TMK1');
  assert.equal(t1[col('担当者')], 'XA');
  assert.equal(t1[col('総戸数')], 10);
  assert.equal(t1[col('稼働率')], 0.9);
  assert.equal(t2[col('空室戸数')], 0, '0 は 0 のまま');
  assert.equal(t2[col('申込戸数')], 0);
  assert.ok(t3, 'マスターにあってデータのない物件も一覧に残す');
  assert.equal(t3[col('総戸数')], 'データなし', '欠損を 0 にしない');
  assert.equal(t3[col('検証')], 'この週のデータなし');
  const sh = r.book.sheets.find((s) => s.name === '物件一覧');
  assert.equal(sh.autoFilter, 'A1:' + W.colName(head.length) + t.length);
  const xml = Buffer.from(r.bytes).toString('utf8');
  assert.match(xml, /<autoFilter ref="A1:/);
  assert.match(xml, /_xlnm\._FilterDatabase/);
  assert.match(xml, /<pane [^>]*ySplit="1"/, '見出し行を固定する');
});

test('Excel レポート: サマリーの値はダッシュボードと同じ集計（加重平均）', async () => {
  const m = model([H.rec(), H.rec({ project_number: 'T-002', total_units: 20, occupied_units: 16, vacant_units: 4, occupancy_rate_source: 0.8, occupancy_rate_calculated: 0.8, occupancy_after_application_calculated: 0.85 })]);
  const wb = await read(R.buildReport(m, m.period, config, { generatedAt: FIXED }).bytes);
  const t = rows(wb.sheet('サマリー'));
  const find = (label) => t.find((x) => x[0] === label);
  assert.equal(find('総戸数（戸）')[1], 30);
  assert.equal(find('稼働戸数（戸）')[1], 25);
  assert.equal(find('ポートフォリオ稼働率')[1], Math.round(25 / 30 * 10000) / 10000);
  assert.equal(find('ポートフォリオ稼働率')[2], '前週データなし');
  assert.equal(find('作成日時')[1], '2026-01-13 09:00');
  assert.match(String(find('対象週')[1]), /^2026-01-12/);
});

test('Excel レポート: 欠損は「データなし」、数値不正は「数値不正」、暫定を明示する', async () => {
  const m = model([H.rec({ total_units: null, occupied_units: '9戸' })], { override: { portfolio_summary: { status: 'provisional', is_provisional: true } } });
  const wb = await read(R.buildReport(m, m.period, config, { generatedAt: FIXED }).bytes);
  const t = rows(wb.sheet('物件一覧')), head = t[0];
  const t1 = t.find((x) => x[0] === 'T-001');
  assert.equal(t1[head.indexOf('総戸数')], 'データなし');
  assert.equal(t1[head.indexOf('稼働戸数')], '数値不正');
  const s = rows(wb.sheet('サマリー'));
  assert.match(String(s.find((x) => x[0] === '集計の状態')[1]), /^暫定/);
});

test('Excel レポート: 個人情報らしい項目・連絡先を出力しない', () => {
  const m = model([H.rec({ tenant_name: '架空入居者', applicant_email: 'x@example.com', major_change_from_previous_week: '連絡先 03-1234-5678 に確認' })]);
  const r = R.buildReport(m, m.period, config, { generatedAt: FIXED });
  const xml = Buffer.from(r.bytes).toString('utf8'); // 無圧縮で格納しているので本文をそのまま検査できる
  for (const s of ['架空入居者', 'x@example.com', '03-1234-5678']) assert.equal(xml.indexOf(s), -1, s);
});

test('Excel レポート: 物件マスターに追加列がない場合も書き出せる', async () => {
  const m = model([H.rec()], {}, H.masterCSV(['T-001']));
  const wb = await read(R.buildReport(m, m.period, config, { generatedAt: FIXED }).bytes);
  assert.deepEqual(rows(wb.sheet('物件一覧'))[0].slice(0, 3), ['Project #', '日本語物件名', 'Project Name']);
});

test('Excel レポート: 住戸の動き（長期空室・申込・工事）を住戸単位で書き出す（sample_data）', async () => {
  const dir = path.join(__dirname, '..', 'sample_data');
  const m = core.loadAll({
    dashboardDataText: fs.readFileSync(path.join(dir, 'dashboard_data.json'), 'utf8'),
    propertyMasterText: fs.readFileSync(path.join(dir, 'property_master.csv'), 'utf8'),
    validationReportText: fs.readFileSync(path.join(dir, 'validation_report.csv'), 'utf8')
  }, config);
  const ua = core.computeUnitActivity(m, m.period, config);
  const wb = await read(R.buildReport(m, m.period, config, { generatedAt: FIXED }).bytes);
  assert.equal(rows(wb.sheet('長期空室')).length - 1, ua.vacancyList.length);
  const ev = rows(wb.sheet('申込・解約')).slice(1);
  assert.equal(ev.filter((x) => x[0] === '新規申込').length, ua.newApplications.length);
  assert.equal(ev.filter((x) => x[0] === '新規解約').length, ua.newNotices.length);
  assert.equal(rows(wb.sheet('工事')).length - 1, ua.works.length);
});

test('Excel 書き出しコマンド: 入力ファイルを変更せず、指定の場所に書き出す', async () => {
  const src = path.join(__dirname, '..', 'sample_data');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'excel-export-'));
  try {
    const names = ['dashboard_data.json', 'property_master.csv', 'validation_report.csv'];
    names.forEach((n) => fs.copyFileSync(path.join(src, n), path.join(tmp, n)));
    const hash = () => names.map((n) => crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp, n))).digest('hex')).join();
    const before = hash();
    const out = path.join(tmp, 'out', config.excelReportFileName);
    const res = exporter.run({ data: tmp, out, period: null }, FIXED);
    assert.equal(res.exitCode, 0, res.message);
    assert.equal(hash(), before, '入力データを書き換えない');
    const wb = await read(new Uint8Array(fs.readFileSync(out)));
    assert.ok(wb.sheetNames.includes('物件一覧'));
    assert.equal(exporter.run({ data: tmp, out, period: '20990101' }).exitCode, 2, '存在しない基準週はエラー');
    assert.equal(exporter.run({ data: path.join(tmp, 'none'), out, period: null }).exitCode, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
