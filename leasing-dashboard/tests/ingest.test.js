'use strict';
// 週報 Excel の解析・標準化の自動テスト（フィクスチャはすべて架空。make_weekly_xlsx.py で生成）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const X = require('../xlsx');
const I = require('../ingest');
const core = require('../core');
const config = require('../config');

const DIR = path.join(__dirname, 'fixtures', 'weekly');
const MASTER = fs.readFileSync(path.join(__dirname, 'fixtures', 'weekly_master.csv'), 'utf8');
const FILES = {
  A: '【テスト物件A】週報.xlsx', B: 'テスト物件B_営業活動報告.xlsx', C: 'リーシング報告書_(テスト物件C).xlsx', D: 'ActionPoints_test.xlsx',
  unknown: 'unknown_format.xlsx', broken: 'broken.xlsx'
};
const read = (f) => fs.readFileSync(path.join(DIR, f));
const parse = (f, dir) => I.parseWorkbookFile({ name: f, bytes: fs.readFileSync(path.join(dir || DIR, f)) }, { config });
async function buildAll(extra) {
  const results = await Promise.all(Object.values(FILES).map((f) => parse(f)));
  return I.buildDashboardData(results.concat(extra || []), { config, masterText: MASTER });
}
const prop = (d, pn, date) => d.properties.find((p) => p.project_number === pn && p.report_date === date);

test('XLSX: シート名・文字列・数値を読み、計算結果のない数式は null として区別する', async () => {
  const wb = await X.readWorkbook(read(FILES.A));
  assert.deepEqual(wb.sheetNames, ['週報', '基本情報', '業者営業']);
  const w = wb.sheet('週報');
  assert.equal(w.value(15, 2), '現況');
  assert.equal(w.value(16, 3), 101);
  const f = w.cell(5, 4);
  assert.equal(f.f, true);
  assert.equal(f.cached, false);
  assert.equal(f.v, null);
  assert.ok(w.formulasWithoutValue > 0);
  assert.equal(X.serialToDay(46313), core.parseDateValue('2026-10-18').value);
});

test('XLSX: ZIP でないファイルはエラーになる', async () => {
  await assert.rejects(X.readWorkbook(read(FILES.broken)), /ZIP 形式ではありません/);
});

test('様式判定: シート名と見出しから A〜D を判定し、未知の様式は失敗にする', async () => {
  for (const [fmt, f] of Object.entries(FILES).filter(([k]) => k.length === 1)) {
    assert.equal(I.detectFormat(await X.readWorkbook(read(f))), fmt, f);
  }
  const u = await parse(FILES.unknown);
  assert.equal(u.status, 'failed');
  assert.equal(u.confidence, 'low');
  const b = await parse(FILES.broken);
  assert.equal(b.status, 'failed');
});

test('様式A: 住戸明細から As-is 稼働（空室・原復中・申込を空室）を再計算し、週次件数は基準週の列を読む', async () => {
  const d = (await buildAll()).data;
  const p = prop(d, '101', '2026-01-11');
  assert.equal(p.total_units, 9);
  assert.equal(p.vacant_units, 3);
  assert.equal(p.occupied_units, 6);
  assert.equal(p.application_units, 1);
  assert.equal(p.scheduled_termination_units, 1);
  assert.equal(p.scheduled_contract_units, 1);
  assert.deepEqual([p.inquiry_count, p.viewing_count, p.application_count, p.application_cancel_count], [4, 3, 1, 0]);
  assert.equal(p.occupancy_rate_source, null, '元ファイルの稼働率は計算結果がないため null');
  assert.ok(Math.abs(p.occupancy_rate_calculated - 6 / 9) < 1e-6);
  assert.ok(Math.abs(p.occupancy_after_application_calculated - 7 / 9) < 1e-6);
  assert.equal(p.data_confidence, 'medium');
  const u = Object.fromEntries(d.units.filter((x) => x.project_number === '101').map((x) => [x.unit_number, x]));
  assert.equal(u['103'].work_type, 'restoration');
  assert.equal(u['103'].work_end_date, '2026-01-20');
  assert.equal(u['102'].work_completed_date, '2025-10-20');
  assert.equal(u['201'].application_date, '2026-01-08');
  assert.equal(u['202'].move_out_date, '2026-02-28');
  assert.equal(u['203'].leasing_status, 'contracted', '賃料発生日が基準日より後の契約済は入居待ち');
  assert.equal(u['301'].counts_as_vacant, false, '募集止めはシートの定義で空室に数えない');
  assert.equal(u['302'].leasing_status, 'occupied');
});

test('様式A: 現況が空欄の住戸があれば空室戸数は推測せず null にし、警告する', async () => {
  const r = await parse('A_blank_status.xlsx', path.join(__dirname, 'fixtures', 'weekly_variants'));
  assert.equal(r.weeks[0].values.vacant_units, null);
  assert.equal(r.weeks[0].values.occupied_units, null);
  assert.ok(r.warnings.some((w) => /現況が空欄/.test(w)));
});

test('様式B: 日別件数を合計し、募集中・解約予定住戸と条件変更（今週分）を読む', async () => {
  const d = (await buildAll()).data;
  const p = prop(d, '102', '2026-01-11');
  assert.deepEqual([p.total_units, p.vacant_units, p.occupied_units, p.application_units, p.scheduled_termination_units], [20, 2, 18, 1, 1]);
  assert.deepEqual([p.viewing_count, p.application_count, p.contract_count, p.inquiry_count], [4, 1, 0, null]);
  const u = d.units.find((x) => x.project_number === '102' && x.unit_number === '302');
  assert.equal(u.application_date, '2026-01-06');
  const ev = d.unit_events.filter((e) => e.project_number === '102');
  assert.deepEqual(ev.map((e) => [e.type, e.unit_number, e.date]), [['condition_change', '501', '2026-01-07']]);
});

test('様式C: 期間別シートごとに週次の集計を作り、累積再掲は前週シートとの差分で新規だけを拾う', async () => {
  const d = (await buildAll()).data;
  assert.ok(prop(d, '103', '2026-01-04'));
  const p = prop(d, '103', '2026-01-11');
  assert.deepEqual([p.total_units, p.vacant_units, p.occupied_units, p.application_units, p.inquiry_count, p.viewing_count, p.application_cancel_count],
    [10, 3, 7, 1, 4, 2, 1]);
  assert.equal(p.contract_count, null, '数式の計算結果がない契約数は null');
  const ev = d.unit_events.filter((e) => e.project_number === '103').map((e) => [e.type, e.unit_number, e.date, e.move_out_date || null]);
  assert.deepEqual(ev, [['application', '103', '2026-01-08', null], ['application_cancel', '104', '2026-01-09', null], ['notice', '201', null, '2026-02-28']]);
  assert.ok(!ev.some((e) => e[1] === '105' || e[1] === '102'), '前週から再掲された行は新規にしない');
  const units = d.units.filter((x) => x.project_number === '103').map((x) => x.unit_number).sort();
  assert.deepEqual(units, ['102', '103', '201', '202'], '現況が空欄の住戸（104）は推測せず除外');
});

test('様式D: 対応事項として取り込み、数値には合算しない。メモ欄は読まない', async () => {
  const d = (await buildAll()).data;
  assert.deepEqual(d.action_items.map((a) => [a.project_number, a.status]), [['101', '未完了'], ['103', '完了（報告済）'], [null, '未完了']]);
  assert.ok(!d.properties.some((p) => /ActionPoints/.test(p.source_file_name)));
});

test('個人情報: 申込者・契約者・保証会社・年収・勤務先・メモを出力しない', async () => {
  const { data, validationCSV } = await buildAll();
  const out = JSON.stringify(data) + validationCSV;
  ['架空太郎', '架空勤務先', '架空保証', '架空商事', '年収', '架空法人申込', '会社員', '架空担当メモ', '架空メモ', '架空の理由'].forEach((s) => assert.equal(out.indexOf(s), -1, s));
});

test('読取失敗・未知の様式も件数から消さず、検証行を残す', async () => {
  const { data, validationRows } = await buildAll();
  assert.equal(data.report_metadata.file_count_expected, 6);
  assert.equal(data.report_metadata.file_count_failed, 2);
  assert.equal(validationRows.length, 6);
  assert.equal(validationRows.find((r) => r['ファイル名'] === 'broken.xlsx')['処理結果'], '読取失敗');
  const m = core.loadAll({ dashboardDataText: JSON.stringify(data), propertyMasterText: MASTER, validationReportText: I.buildDashboardData([], { config }).validationCSV }, config);
  assert.equal(m.ok, true);
});

test('同一ファイルの二重読込は 2 件目を重複として扱い、合算しない', async () => {
  const a = await parse(FILES.A);
  const b = Object.assign({}, await parse(FILES.A), { file_name: 'コピー_' + FILES.A });
  const { data, validationRows } = I.buildDashboardData([a, b], { config, masterText: MASTER });
  assert.equal(data.properties.length, 1);
  assert.equal(validationRows[1]['重複の可能性'], 'あり');
  assert.equal(data.report_metadata.file_count_failed, 1);
});

test('同じ物件・週の別様式は合算せず優先順位で 1 つ採用し、重複候補として記録する', async () => {
  const a = await parse(FILES.A);
  const b = Object.assign({}, await parse(FILES.B), { file_name: '【テスト物件A】営業活動.xlsx' });
  const { data, validationRows } = I.buildDashboardData([a, b], { config, masterText: MASTER });
  const ps = data.properties.filter((p) => p.project_number === '101');
  assert.equal(ps.length, 1);
  assert.equal(ps[0].total_units, 9, '週報型を採用（営業活動週報型の 20 戸と合算しない）');
  assert.ok(validationRows.every((r) => r['重複の可能性'] === 'あり'));
  assert.ok(data.alerts.some((x) => x.code === 'DUPLICATE_SOURCE'));
});

test('物件の紐付け: 対応表 → ファイル名の物件名（最長一致）→ 未紐付け', async () => {
  const a = await parse(FILES.A);
  const mapped = I.buildDashboardData([a], { config, masterText: MASTER, mappingText: 'file_name_pattern,project_number\nテスト物件A】週報,103\n' });
  assert.equal(mapped.data.properties[0].project_number, '103');
  const none = I.buildDashboardData([a], { config, masterText: 'project_number,property_name_ja\n999,別の物件\n' });
  assert.equal(none.data.properties.length, 0);
  assert.ok(none.data.alerts.some((x) => x.code === 'SOURCE_UNLINKED'));
  assert.equal(none.validationRows[0]['対象物件'], '');
});

test('前回の dashboard_data.json の履歴を引き継ぎ、前週比較（状態変化）に使える', async () => {
  const c = await parse(FILES.A);
  const first = I.buildDashboardData([c], { config, masterText: MASTER });
  // 前週分として 1 週前にずらし、201 を空室にしておく
  const prev = JSON.parse(JSON.stringify(first.data));
  prev.properties.forEach((p) => { p.report_date = '2026-01-04'; });
  prev.units.forEach((u) => { u.report_date = '2026-01-04'; if (u.unit_number === '201') { u.leasing_status = 'vacant'; u.application_date = null; } });
  const c2 = await parse(FILES.A);
  c2.units.forEach((u) => { if (u.unit_number === '201') u.application_date = null; });
  const next = I.buildDashboardData([c2], { config, masterText: MASTER, previousData: prev });
  assert.deepEqual(next.data.properties.map((p) => p.report_date).sort(), ['2026-01-04', '2026-01-11']);
  const m = core.buildModel(next.data, MASTER, null, config);
  const ua = core.computeUnitActivity(m, m.period, config);
  assert.deepEqual(ua.newApplications.map((x) => x.unit_number + ':' + x.basis), ['201:status']);
});

test('ダッシュボードは解析結果の住戸イベント（差分・記載）を今週の動きとして表示する', async () => {
  const { data } = await buildAll();
  const m = core.buildModel(data, MASTER, null, config);
  const ua = core.computeUnitActivity(m, m.period, config);
  assert.deepEqual(ua.newApplications.map((x) => x.project_number + '-' + x.unit_number).sort(), ['101-201', '102-302', '103-103']);
  assert.deepEqual(ua.cancellations.map((x) => x.project_number + '-' + x.unit_number), ['103-104']);
  assert.deepEqual(ua.newNotices.map((x) => x.project_number + '-' + x.unit_number), ['103-201']);
  assert.ok(ua.conditionChanges.some((x) => x.unit_number === '501' && x.changes[0].text === '501号室：礼金0ヶ月'));
  assert.equal(m.actionItems.length, 3);
  // 様式A は週報の空室の定義（counts_as_vacant）で突合するため不一致にならない。
  // 様式C は現況が空欄の住戸（104）を推測で補わないため、集計欄の空室数と食い違うことを警告する
  assert.deepEqual(m.issues.filter((i) => i.type === 'unit_count_mismatch').map((i) => i.project_number), ['103']);
});

test('CLI: 週報フォルダを解析して出力し、元ファイルは変更しない', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-'));
  const before = fs.readdirSync(DIR).map((f) => [f, core.hashText(fs.readFileSync(path.join(DIR, f), 'latin1'))]);
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'ingest-weekly.js'), '--in', DIR, '--out', out,
    '--master', path.join(__dirname, 'fixtures', 'weekly_master.csv')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /様式C（リーシング報告書型） → 103/);
  const data = JSON.parse(fs.readFileSync(path.join(out, 'dashboard_data.json'), 'utf8'));
  assert.equal(data.report_metadata.source_period, '20260111');
  assert.ok(fs.readFileSync(path.join(out, 'validation_report.csv'), 'utf8').includes('broken.xlsx'));
  assert.deepEqual(fs.readdirSync(out).sort(), ['dashboard_data.json', 'validation_report.csv'], '一時ファイルを残さない');
  const after = fs.readdirSync(DIR).map((f) => [f, core.hashText(fs.readFileSync(path.join(DIR, f), 'latin1'))]);
  assert.deepEqual(after, before);
  const v = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'validate-data.js'), '--data', out], { encoding: 'utf8' });
  assert.match(v.stdout, /件数突合: OK/);
  fs.rmSync(out, { recursive: true, force: true });
});

test('CLI: フォルダがない・Excel がない場合は終了コード 2', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'ingest-weekly.js'), '--in', path.join(DIR, 'nope')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-empty-'));
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'ingest-weekly.js'), '--in', empty, '--out', empty], { encoding: 'utf8' }).status, 2);
  fs.rmSync(empty, { recursive: true, force: true });
});
