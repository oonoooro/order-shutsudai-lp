'use strict';
// data/ に配置された提供データ（週ごとに差し替え）に対する検証。
// data/ はリポジトリに含めないため、ファイルがない環境ではスキップする。
// 特定週の値は前提にせず、どの週のデータでも成り立つ整合性だけを確認する。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const core = require('../core');
const config = require('../config');

const DIR = path.join(__dirname, '..', 'data');
const has = fs.existsSync(path.join(DIR, 'dashboard_data.json'));
const read = (f) => { const p = path.join(DIR, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };

test('提供データ: JSON 構文が正しく、source_period がある', { skip: !has && 'data/dashboard_data.json がありません' }, () => {
  const r = core.safeParseJSON(read('dashboard_data.json'));
  assert.equal(r.ok, true, r.error);
  assert.ok(r.value.report_metadata && r.value.report_metadata.source_period, 'source_period');
});

test('提供データ: 公開条件（件数突合・全ファイルの検証行）を満たす', { skip: !has && 'data/ なし' }, () => {
  const m = core.loadAll({ dashboardDataText: read('dashboard_data.json'), propertyMasterText: read('property_master.csv'), validationReportText: read('validation_report.csv') }, config);
  assert.equal(m.ok, true);
  const blocking = m.issues.filter((i) => i.severity === 'error');
  assert.deepEqual(blocking.map((i) => i.message), []);
  assert.equal(m.publishable, true);
  assert.equal(m.period, core.normalizePeriod(JSON.parse(read('dashboard_data.json')).report_metadata.source_period));
});

test('提供データ: 失敗ファイルが件数から消えず、集計は欠損を 0 にしない', { skip: !has && 'data/ なし' }, () => {
  const json = JSON.parse(read('dashboard_data.json'));
  const m = core.loadAll({ dashboardDataText: read('dashboard_data.json'), propertyMasterText: read('property_master.csv'), validationReportText: read('validation_report.csv') }, config);
  const failed = m.files.filter((f) => f.result === 'failed').length;
  if (typeof json.report_metadata.file_count_failed === 'number') assert.equal(failed, json.report_metadata.file_count_failed);
  const s = core.summarize(core.recordsForPeriod(m, m.period), [], m, config);
  const recs = core.recordsForPeriod(m, m.period).filter((r) => r.linked && !r.duplicate);
  ['total_units', 'occupied_units', 'vacant_units', 'application_units'].forEach((f) => {
    const vals = recs.map((r) => r.values[f]).filter((v) => typeof v === 'number');
    assert.equal(s[f].value, vals.length ? vals.reduce((a, b) => a + b, 0) : null, f);
  });
  if (failed > 0) assert.equal(s.provisional, true, '読取失敗があれば暫定');
});

test('提供データ: 入力ファイルを書き換えない（読込前後で内容が同一）', { skip: !has && 'data/ なし' }, () => {
  const files = ['dashboard_data.json', 'property_master.csv', 'validation_report.csv'].filter((f) => fs.existsSync(path.join(DIR, f)));
  const before = files.map((f) => core.hashText(read(f)));
  core.loadAll({ dashboardDataText: read('dashboard_data.json'), propertyMasterText: read('property_master.csv'), validationReportText: read('validation_report.csv') }, config);
  assert.deepEqual(files.map((f) => core.hashText(read(f))), before);
});
