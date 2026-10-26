'use strict';
// 住戸明細（units）の自動テスト（データはすべて架空）
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const { core, config, rec, dataset, build, masterCSV, issuesOf } = H;

// 基準日 2026-01-12、前週 2026-01-05
function unit(o) {
  return Object.assign({ report_date: '2026-01-12', project_number: 'T-001', unit_number: '101', layout: '1K', leasing_status: 'vacant' }, o || {});
}
function withUnits(units, props) {
  const json = dataset(props || [rec({ report_date: '2026-01-05' }), rec()]);
  json.units = units;
  return build(json);
}
function activity(m) { return core.computeUnitActivity(m, m.period, config); }

test('日付: YYYY-MM-DD と / 区切りを読み、存在しない日付・数値は不正', () => {
  assert.equal(core.parseDateValue('2026-01-12').text, '2026-01-12');
  assert.equal(core.parseDateValue('2026/1/5').text, '2026-01-05');
  assert.equal(core.parseDateValue('2026-02-30').invalid, true);
  assert.equal(core.parseDateValue(20260112).invalid, true);
  assert.deepEqual(core.parseDateValue(null), { value: null, invalid: false });
  assert.deepEqual(core.parseDateValue(''), { value: null, invalid: false });
  const m = withUnits([unit({ notice_date: '12/31' })]);
  assert.equal(issuesOf(m, 'date_format').length, 1);
});

test('空室日数: 空室開始日から基準日までの日数を計算する', () => {
  const m = withUnits([unit({ vacancy_start_date: '2025-10-14' })]);
  assert.equal(m.units[0].vacancyDays, 90);
  assert.equal(m.units[0].vacancyBasis, 'date');
  const a = activity(m);
  assert.equal(a.longVacancy.length, 1, '基準 90日以上は長期空室');
  assert.equal(a.vacancyList[0].days, 90);
});

test('空室日数: 開始日がなければ元データの空室日数を使い、両方あって食い違えば警告', () => {
  assert.equal(withUnits([unit({ vacancy_days: 30 })]).units[0].vacancyDays, 30);
  const m = withUnits([unit({ vacancy_start_date: '2026-01-02', vacancy_days: 30 })]);
  assert.equal(m.units[0].vacancyDays, 10);
  assert.equal(issuesOf(m, 'vacancy_days_mismatch').length, 1);
  const m2 = withUnits([unit({ vacancy_start_date: '2026-02-01' })]);
  assert.equal(m2.units[0].vacancyDays, null, '基準日より後の開始日は日数にしない');
  assert.equal(issuesOf(m2, 'unit_date_inconsistent').length, 1);
});

test('空室日数: 値がなければ null（0 にしない）、入居中・解約予定は空室一覧に含めない', () => {
  const m = withUnits([unit(), unit({ unit_number: '102', leasing_status: 'occupied', vacancy_days: 5 }), unit({ unit_number: '103', leasing_status: 'notice', vacancy_days: 5 })]);
  assert.equal(m.units[0].vacancyDays, null);
  assert.equal(activity(m).vacancyList.length, 0);
});

test('新規申込: 申込日が今週（前回基準日の翌日〜基準日）なら新規、それより前は対象外', () => {
  const m = withUnits([
    unit({ unit_number: '101', leasing_status: 'application', application_date: '2026-01-06' }),
    unit({ unit_number: '102', leasing_status: 'application', application_date: '2026-01-05' }),
    unit({ unit_number: '103', leasing_status: 'application', application_date: '2026-01-12' })
  ]);
  const a = activity(m);
  assert.deepEqual(a.newApplications.map((x) => x.unit_number).sort(), ['101', '103']);
  assert.equal(a.windowText, '2026-01-06 〜 2026-01-12');
});

test('新規申込: 申込日がなくても前週「空室」→今週「申込あり」なら状態変化で判定', () => {
  const m = withUnits([
    unit({ report_date: '2026-01-05', leasing_status: '空室' }),
    unit({ leasing_status: '申込あり' }),
    unit({ unit_number: '999', leasing_status: 'application' })
  ]);
  const a = activity(m);
  assert.equal(a.newApplications.length, 1);
  assert.equal(a.newApplications[0].basis, 'status');
  assert.equal(a.notJudged.events, 1, '日付も前週明細もない住戸は判定不可として数える');
});

test('申込取消: 取消日が今週、または前週「申込あり」→今週「空室」', () => {
  const m = withUnits([
    unit({ unit_number: '101', application_cancel_date: '2026-01-10' }),
    unit({ report_date: '2026-01-05', unit_number: '102', leasing_status: 'application' }),
    unit({ unit_number: '102', leasing_status: 'vacant' })
  ]);
  const a = activity(m);
  assert.deepEqual(a.cancellations.map((x) => x.unit_number + ':' + x.basis).sort(), ['101:date', '102:status']);
  const al = core.computeAlerts(m, m.period, config);
  assert.equal(al.categories.find((c) => c.key === 'application_cancel').items.filter((i) => i.unit_number).length, 2);
});

test('新規解約: 解約通知日が今週、または前週「入居中」→今週「解約予定」。退去予定日を表示', () => {
  const m = withUnits([
    unit({ unit_number: '201', leasing_status: 'notice', notice_date: '2026-01-08', move_out_date: '2026-02-28' }),
    unit({ unit_number: '202', leasing_status: 'notice', notice_date: '2025-12-20', move_out_date: '2026-01-31' }),
    unit({ report_date: '2026-01-05', unit_number: '203', leasing_status: 'occupied' }),
    unit({ unit_number: '203', leasing_status: '解約予定' })
  ]);
  const a = activity(m);
  assert.deepEqual(a.newNotices.map((x) => x.unit_number).sort(), ['201', '203']);
  assert.equal(a.newNotices.find((x) => x.unit_number === '201').moveOut, '2026-02-28');
});

test('賃料条件の変更: 前週の同じ住戸と比較し、変わった項目と前後の値を出す', () => {
  const m = withUnits([
    unit({ report_date: '2026-01-05', asking_rent: 100000, ad: 1, fr: 0, key_money_months: 1 }),
    unit({ asking_rent: 98000, ad: 2, fr: 0, key_money_months: null })
  ]);
  const a = activity(m);
  assert.equal(a.conditionChanges.length, 1);
  assert.deepEqual(a.conditionChanges[0].changes.map((c) => [c.key, c.from, c.to]), [['asking_rent', 100000, 98000], ['ad', 1, 2]]);
  const al = core.computeAlerts(m, m.period, config);
  assert.equal(al.categories.find((c) => c.key === 'asking_rent_change').items.length, 1);
  assert.equal(al.categories.find((c) => c.key === 'ad_fr_change').items.length, 1);
});

test('賃料条件の変更: null と値の比較は変更にしない。前週明細がなければ判定不可', () => {
  const m = withUnits([unit({ report_date: '2026-01-05', asking_rent: null }), unit({ asking_rent: 98000 })]);
  assert.equal(activity(m).conditionChanges.length, 0);
  const m2 = withUnits([unit({ asking_rent: 98000 })]);
  const a2 = activity(m2);
  assert.equal(a2.hasPrev, false);
  assert.equal(a2.notJudged.conditions, 1);
});

test('工事: 残り日数・完了予定超過・今週完了・完了予定日なしを区別する', () => {
  const m = withUnits([
    unit({ unit_number: '301', work_type: 'リノベ', work_start_date: '2025-12-01', work_end_date: '2026-01-20' }),
    unit({ unit_number: '302', work_type: '原状回復', work_start_date: '2025-12-20', work_end_date: '2026-01-10' }),
    unit({ unit_number: '303', work_type: 'restoration', work_end_date: '2026-01-09', work_completed_date: '2026-01-09' }),
    unit({ unit_number: '304', work_type: 'restoration', work_completed_date: '2025-12-28' }),
    unit({ unit_number: '305', work_type: 'renovation' })
  ]);
  const w = Object.fromEntries(activity(m).works.map((x) => [x.unit_number, x]));
  assert.equal(w['301'].type, 'renovation');
  assert.equal(w['301'].daysLeft, 8);
  assert.equal(w['301'].overdue, false);
  assert.equal(w['302'].overdue, true);
  assert.equal(w['302'].daysLeft, -2);
  assert.equal(w['303'].completed, '2026-01-09');
  assert.equal(w['304'], undefined, '先週以前に完了した工事は出さない');
  assert.equal(w['305'].daysLeft, null);
});

test('住戸の検証: 重複・住戸番号なし・マスター未登録・不明なステータス・数値への文字混入', () => {
  const m = withUnits([
    unit(), unit(),
    unit({ unit_number: null }),
    unit({ project_number: 'X-999', unit_number: '1' }),
    unit({ unit_number: '2', leasing_status: '謎', work_type: '塗装' }),
    unit({ unit_number: '3', asking_rent: '10万円' })
  ]);
  assert.equal(issuesOf(m, 'duplicate_unit').length, 2);
  assert.equal(issuesOf(m, 'missing_unit_number').length, 1);
  assert.equal(issuesOf(m, 'unit_unknown_project').length, 1);
  assert.equal(issuesOf(m, 'unit_status_unknown').length, 2);
  assert.ok(issuesOf(m, 'numeric_type').some((i) => i.field === 'asking_rent'));
  assert.equal(activity(m).unitCount, 3, '重複・住戸番号なしは除外');
});

test('住戸明細の未入居住戸数と物件の空室戸数が合わなければ警告', () => {
  const ok = withUnits([unit()]);
  assert.equal(issuesOf(ok, 'unit_count_mismatch').length, 0, '空室 1戸 = vacant_units 1');
  const ng = withUnits([unit(), unit({ unit_number: '102', leasing_status: 'application' })]);
  assert.equal(issuesOf(ng, 'unit_count_mismatch').length, 1);
});

test('後方互換: units がなくても動き、住戸の判定は「住戸明細なし」になる', () => {
  const m = build(dataset([rec()]));
  const a = activity(m);
  assert.equal(a.available, false);
  assert.equal(a.unitCount, 0);
  assert.ok(core.computeAlerts(m, m.period, config));
  const bad = build(Object.assign(dataset([rec()]), { units: { a: 1 } }));
  assert.ok(issuesOf(bad, 'invalid_structure').some((i) => /units/.test(i.message)));
});

test('前週がない場合、「今週」は基準日を含む 7 日間', () => {
  const m = withUnits([unit({ leasing_status: 'application', application_date: '2026-01-06' })], [rec()]);
  const a = activity(m);
  assert.equal(a.windowText, '2026-01-06 〜 2026-01-12');
  assert.equal(a.newApplications.length, 1);
});

test('個人情報らしい住戸の列（入居者名・連絡先）は読み込まない', () => {
  const m = withUnits([unit({ tenant_name: '架空 花子', 入居者名: '架空', contact_phone: '03-0000-0000' })]);
  assert.equal(issuesOf(m, 'privacy_stripped').length, 1);
  assert.equal(JSON.stringify(m.units).indexOf('架空'), -1);
});

test('空室率ランキング: 空室戸数 ÷ 総戸数の降順、前週差、欠損は末尾で null', () => {
  const props = [
    rec({ report_date: '2026-01-05' }), rec(),
    rec({ report_date: '2026-01-05', project_number: 'T-002', occupied_units: 9, vacant_units: 1 }),
    rec({ project_number: 'T-002', occupied_units: 7, vacant_units: 3, occupancy_rate_source: 0.7, occupancy_rate_calculated: 0.7, occupancy_after_application_calculated: 0.8 }),
    rec({ project_number: 'T-003', vacant_units: null })
  ];
  const m = build(dataset(props), masterCSV(['T-001', 'T-002', 'T-003']));
  const r = core.vacancyRanking(m, m.period, core.recordsForPeriod(m, m.period));
  assert.deepEqual(r.map((x) => x.project_number), ['T-002', 'T-001', 'T-003']);
  assert.ok(Math.abs(r[0].rate - 0.3) < 1e-12);
  assert.ok(Math.abs(r[0].delta - 0.2) < 1e-12);
  assert.equal(r[1].delta, 0);
  assert.equal(r[2].rate, null);
});
