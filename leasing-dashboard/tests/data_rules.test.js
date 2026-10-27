'use strict';
// 要件のデータルールに関する自動テスト（データはすべて架空）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const { core, config, rec, dataset, build, masterCSV, reportCSV, issuesOf } = H;

// ---------------------------------------------------------------- 1. JSON 構文
test('JSON構文: 不正な JSON は位置付きのエラーになり、モデルを作らない', () => {
  const t = H.readFixture('invalid_json');
  const r = core.safeParseJSON(t.dashboardDataText);
  assert.equal(r.ok, false);
  assert.match(r.error, /JSON構文エラー/);
  const m = core.loadAll({ dashboardDataText: t.dashboardDataText, propertyMasterText: null, validationReportText: null }, config);
  assert.equal(m.ok, false);
  assert.equal(m.fatal.type, 'json_syntax');
});

test('JSON構文: BOM 付き JSON は正しく読める', () => {
  const r = core.safeParseJSON('\ufeff{"a":1}');
  assert.equal(r.ok, true);
  assert.equal(r.value.a, 1);
});

test('JSON構文: 同梱の JSON（サンプル・スキーマ・フィクスチャ）はすべて構文が正しい', () => {
  const root = path.join(__dirname, '..');
  const files = ['sample_data/dashboard_data.json', 'sample_data_schema.json', 'package.json',
    'tests/fixtures/minimal/dashboard_data.json', 'tests/fixtures/all_failed/dashboard_data.json'];
  files.forEach((f) => {
    const r = core.safeParseJSON(fs.readFileSync(path.join(root, f), 'utf8'));
    assert.equal(r.ok, true, f + ': ' + r.error);
  });
});

test('JSON構文: 最上位が配列・properties が配列でない場合は構造エラー', () => {
  assert.ok(issuesOf(build([]), 'invalid_structure').length > 0);
  const m = build(dataset({ not: 'array' }));
  assert.ok(issuesOf(m, 'invalid_structure').some((i) => /配列ではありません/.test(i.message)));
  assert.equal(m.records.length, 0);
});

// ---------------------------------------------------------------- 2. Project # の重複
test('Project #の重複: 物件マスター内の重複を検出し、先頭行を正とする', () => {
  const master = H.MASTER_HEADER + '\nT-001,First,最初,First,S,A,P,x\nT-001,Second,二番目,Second,S,A,P,x\n';
  const m = build(dataset([rec()]), master);
  const d = issuesOf(m, 'duplicate_project_master');
  assert.equal(d.length, 1);
  assert.equal(d[0].severity, 'error');
  assert.equal(m.records[0].names.property_name_ja, '最初');
});

test('Project #の重複: 全角・前後空白の違いも同一キーとして重複検出する（NFKC 正規化）', () => {
  const master = H.MASTER_HEADER + '\nT-001,A,あ,A,S,A,P,x\n Ｔ－００１ ,B,い,B,S,A,P,x\n';
  assert.equal(issuesOf(build(dataset([rec()]), master), 'duplicate_project_master').length, 1);
});

test('Project #の重複: 同一週の物件レコード重複は重複候補とし、集計から除外する', () => {
  const m = build(dataset([rec(), rec({ occupied_units: 8, vacant_units: 2, occupancy_rate_source: 0.8, occupancy_rate_calculated: 0.8, occupancy_after_application_calculated: 0.9 })]));
  assert.equal(issuesOf(m, 'duplicate_record').length, 2);
  assert.ok(m.records.every((r) => r.duplicate));
  const s = core.summarize(core.recordsForPeriod(m, m.period), [], m, config);
  assert.equal(s.propertyCount.value, 0);
  assert.equal(s.total_units.value, null);
  assert.equal(s.provisional, true);
});

test('Project #の重複: 別の週なら同じ Project # でも重複ではない', () => {
  const m = build(dataset([rec(), rec({ report_date: '2026-01-05' })]));
  assert.equal(issuesOf(m, 'duplicate_record').length, 0);
});

// ---------------------------------------------------------------- 3. マスターにない Project #
test('物件マスターにないProject #: 未登録として検出し、ポートフォリオ集計から除外する', () => {
  const m = build(dataset([rec(), rec({ project_number: 'X-999', project_name: 'Unknown' })]));
  const u = issuesOf(m, 'unknown_project');
  assert.equal(u.length, 1);
  assert.equal(u[0].project_number, 'X-999');
  const r = m.records.find((x) => x.key === 'X-999');
  assert.equal(r.linked, false);
  assert.equal(r.names.project_name, null);
  assert.equal(r.names.project_name_unlinked, 'Unknown');
  const s = core.summarize(core.recordsForPeriod(m, m.period), [], m, config);
  assert.equal(s.propertyCount.value, 1);
  assert.equal(s.total_units.value, 10);
});

test('物件名は property_master.csv を正とし、JSON 側の名称違いは警告する', () => {
  const m = build(dataset([rec({ property_name_ja: '別名' })]));
  assert.equal(m.records[0].names.property_name_ja, 'テスト物件0');
  assert.equal(issuesOf(m, 'name_mismatch').length, 1);
});

// ---------------------------------------------------------------- 4. 数値列への文字混入
test('数値列への文字混入: 文字列は推測で変換せず「数値不正」として扱う', () => {
  const m = build(dataset([rec({ total_units: '10戸', occupied_units: '9', vacant_units: 'abc' })]));
  const n = issuesOf(m, 'numeric_type');
  assert.deepEqual(n.map((i) => i.field).sort(), ['occupied_units', 'total_units', 'vacant_units']);
  const r = m.records[0];
  assert.equal(r.values.total_units, null);
  assert.equal(r.invalid.total_units, true);
  assert.equal(r.occupancy, null);
  assert.equal(core.fmtCount(r.values.total_units, config, r.invalid.total_units), '数値不正');
  const s = core.summarize([r], [], m, config);
  assert.equal(s.total_units.value, null);
  assert.equal(s.total_units.invalid, 1);
  assert.ok(s.provisionalReasons.some((x) => /数値不正/.test(x)));
});

test('数値列への文字混入: boolean・オブジェクト・NaN 相当も不正として検出する', () => {
  const m = build(dataset([rec({ application_units: true, asking_rent: { v: 1 } })]));
  assert.equal(issuesOf(m, 'numeric_type').length, 2);
});

test('数値列への文字混入: CSV の数値列（抽出項目数）に文字があれば検出する', () => {
  const rep = reportCSV([{ file: 'test_T-001.xlsx', project: 'T-001', count: '12件' }]);
  const m = build(dataset([rec()], { files: ['test_T-001.xlsx'] }), undefined, rep);
  assert.equal(issuesOf(m, 'numeric_type').length, 1);
  assert.equal(m.report.rows[0].extracted_count, null);
});

test('数値列への文字混入: CSV の桁区切りカンマ付き数値は数値として読む', () => {
  assert.deepEqual(core.parseNumberCell('1,234'), { value: 1234, invalid: false });
  assert.equal(core.parseNumberCell('1,23').invalid, true);
  assert.equal(core.parseNumberCell('１２').invalid, true);
});

test('比率が 0〜1 の範囲外（例: 95 と % で記録）なら検出する', () => {
  const m = build(dataset([rec({ occupancy_rate_source: 90 })]));
  assert.equal(issuesOf(m, 'rate_out_of_range').length, 1);
});

// ---------------------------------------------------------------- 5. 稼働＋空室と総戸数
test('稼働戸数＋空室戸数と総戸数の不整合を検出する', () => {
  const m = build(dataset([rec({ occupied_units: 9, vacant_units: 2, total_units: 10 })]));
  const u = issuesOf(m, 'unit_sum_mismatch');
  assert.equal(u.length, 1);
  assert.equal(u[0].numerator, 11);
  assert.equal(u[0].denominator, 10);
});

test('稼働＋空室＝総戸数なら不整合なし。いずれかが null なら判定しない', () => {
  assert.equal(issuesOf(build(dataset([rec()])), 'unit_sum_mismatch').length, 0);
  assert.equal(issuesOf(build(dataset([rec({ vacant_units: null })])), 'unit_sum_mismatch').length, 0);
});

// ---------------------------------------------------------------- 6. 稼働率計算の不一致
test('稼働率計算の不一致: 許容差 0.0001 超で分子・分母・元値・計算値・差を記録する', () => {
  const m = build(dataset([rec({ occupancy_rate_source: 0.92 })]));
  const r = issuesOf(m, 'rate_mismatch').find((i) => i.field === 'occupancy_rate_source' && i.severity === 'error');
  assert.ok(r);
  assert.equal(r.numerator, 9);
  assert.equal(r.denominator, 10);
  assert.equal(r.source_value, 0.92);
  assert.equal(r.calculated_value, 0.9);
  assert.equal(r.difference, 0.02);
});

test('稼働率計算の不一致: 許容差以内（0.00005）は不一致としない', () => {
  assert.equal(issuesOf(build(dataset([rec({ occupancy_rate_source: 0.90005 })])), 'rate_mismatch').length, 0);
});

test('稼働率は occupied/total。分母 0 や null なら null', () => {
  assert.equal(build(dataset([rec()])).records[0].occupancy, 0.9);
  assert.equal(build(dataset([rec({ total_units: 0, occupied_units: 0, vacant_units: 0 })])).records[0].occupancy, null);
  assert.equal(build(dataset([rec({ occupied_units: null })])).records[0].occupancy, null);
});

test('申込反映後稼働率: 元データが算出を許容し 3 値が揃う場合のみ算出、不一致は検出', () => {
  assert.equal(build(dataset([rec()])).records[0].afterApplication, 1);
  assert.equal(build(dataset([rec({ occupancy_after_application_calculated: null })])).records[0].afterApplication, null);
  const m = build(dataset([rec({ occupancy_after_application_calculated: 0.95 })]));
  assert.equal(issuesOf(m, 'after_app_mismatch').length, 1);
  const m2 = build(dataset([rec({ application_units: null })]));
  assert.equal(m2.records[0].afterApplication, null);
  assert.equal(issuesOf(m2, 'after_app_operands_missing').length, 1);
});

test('分子・分母の記載が稼働戸数・総戸数と異なれば検出する', () => {
  const m = build(dataset([rec({ occupancy_calculation_numerator: 8, occupancy_calculation_denominator: 10 })]));
  assert.ok(issuesOf(m, 'rate_mismatch').some((i) => i.field === 'occupancy_calculation_numerator'));
});

test('ポートフォリオ稼働率は sum(稼働)/sum(総戸数) の加重平均', () => {
  const t = H.readFixture('minimal');
  const m = core.loadAll(t, config);
  const s = core.summarize(core.recordsForPeriod(m, m.period), core.recordsForPeriod(m, core.previousPeriod(m, m.period)), m, config);
  assert.equal(s.total_units.value, 30);
  assert.equal(s.occupied_units.value, 27);
  assert.equal(s.occupancy.value, 0.9);
  assert.equal(core.fmtRate(s.occupancy.value, config), '90.0%');
  assert.equal(s.afterApplication.value, 28 / 30);
  // 前週比は両週に値がある T-001 のみで比較: 10/10 → 9/10
  assert.equal(s.delta.occupancy_matched, 1);
  assert.ok(Math.abs(s.delta.occupancy - -0.1) < 1e-12);
  assert.equal(s.delta.occupied_units, -1);
  assert.equal(issuesOf(m, 'summary_mismatch').length, 0, 'portfolio_summary と再計算値が一致する');
});

test('portfolio_summary の数値が明細の再計算値と異なれば検出する', () => {
  const m = build(dataset([rec()], { override: { portfolio_summary: { status: 'calculated', total_units: 11 } } }));
  assert.equal(issuesOf(m, 'summary_mismatch').length, 1);
});

// ---------------------------------------------------------------- 7. null と 0 の混同
test('nullと0の混同: 表示は null→「データなし」、0→「0」', () => {
  assert.equal(core.fmtCount(null, config), 'データなし');
  assert.equal(core.fmtCount(undefined, config), 'データなし');
  assert.equal(core.fmtCount(0, config), '0');
  assert.equal(core.fmtRate(null, config), 'データなし');
  assert.equal(core.fmtRate(0, config), '0.0%');
  assert.equal(core.fmtMoney(null, config), 'データなし');
  assert.equal(core.fmtMoney(0, config), '0.0万円');
  assert.equal(core.fmtPt(null, config), 'データなし');
  assert.equal(core.fmtPt(0, config), '0.0pt');
});

test('nullと0の混同: 欠損キーは null、明示的な 0 は 0 として保持する', () => {
  const m = build(dataset([rec({ scheduled_termination_units: 0 })]));
  const r = m.records[0];
  assert.equal(r.values.scheduled_termination_units, 0);
  assert.equal(r.values.long_vacancy_units, null);
  assert.equal(r.present.long_vacancy_units, false);
});

test('nullと0の混同: 全件 null の合計は 0 ではなく null、0 を含む合計は 0', () => {
  const m = build(dataset([rec(), rec({ project_number: 'T-002' })]), masterCSV(['T-001', 'T-002']));
  const s = core.summarize(core.recordsForPeriod(m, m.period), [], m, config);
  assert.equal(s.scheduled_contract_units.value, null);
  const m2 = build(dataset([rec({ scheduled_contract_units: 0 }), rec({ project_number: 'T-002', scheduled_contract_units: 0 })]), masterCSV(['T-001', 'T-002']));
  assert.equal(core.summarize(core.recordsForPeriod(m2, m2.period), [], m2, config).scheduled_contract_units.value, 0);
});

test('nullと0の混同: 一部が null の合計は欠損件数を記録し暫定とする', () => {
  const m = build(dataset([rec(), rec({ project_number: 'T-002', occupied_units: null, vacant_units: null })]), masterCSV(['T-001', 'T-002']));
  const s = core.summarize(core.recordsForPeriod(m, m.period), [], m, config);
  assert.equal(s.occupied_units.value, 9);
  assert.equal(s.occupied_units.missing, 1);
  assert.equal(s.occupied_units.partial, true);
  assert.equal(s.occupancy.value, 0.9, '稼働率は両方の値がある物件のみで算出（null を 0 とみなさない）');
  assert.equal(s.provisional, true);
});

test('nullと0の混同: CSV の空欄は 0 ではなく null', () => {
  assert.deepEqual(core.parseNumberCell(''), { value: null, invalid: false });
  assert.deepEqual(core.parseNumberCell('0'), { value: 0, invalid: false });
});

test('nullと0の混同: 物件 0 件の週は集計値がすべて null（データなし）', () => {
  const m = core.loadAll(H.readFixture('all_failed'), config);
  const s = core.summarize(core.recordsForPeriod(m, m.period), [], m, config);
  assert.equal(s.propertyCount.value, 0);
  ['total_units', 'occupied_units', 'vacant_units', 'application_units'].forEach((f) => assert.equal(s[f].value, null, f));
  assert.equal(s.occupancy.value, null);
  assert.equal(s.afterApplication.value, null);
  const a = core.computeAlerts(m, m.period, config);
  const byKey = Object.fromEntries(a.categories.map((c) => [c.key, c]));
  assert.equal(byKey.occupancy_drop.judgeable, false, '物件データがないアラートは 0 件ではなく判定不可');
  assert.equal(byKey.read_failure.items.filter((i) => i.file_name).length, 3);
});

// ---------------------------------------------------------------- 8. 同一ファイルの二重読込
test('同一ファイルの二重読込: 同じ内容のファイルを 2 回選んでも 1 件として扱う', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures/minimal/dashboard_data.json'), 'utf8');
  const d = core.dedupeSourceFiles([{ name: 'dashboard_data.json', text }, { name: 'dashboard_data (1).json', text }]);
  assert.equal(d.unique.length, 1);
  assert.equal(d.duplicates.length, 1);
  assert.equal(d.duplicates[0].duplicateOf, 'dashboard_data.json');
});

test('同一ファイルの二重読込: 内容が 1 文字でも違えば別ファイル', () => {
  const d = core.dedupeSourceFiles([{ name: 'a', text: '{"x":1}' }, { name: 'b', text: '{"x":2}' }]);
  assert.equal(d.unique.length, 2);
});

test('同一ファイルの二重読込: file_inventory・validation_report の同一ファイル重複を検出する', () => {
  const json = dataset([rec()], { files: ['test_T-001.xlsx'] });
  json.file_inventory.push({ file_name: 'test_T-001.xlsx', status: 'success' });
  const rep = reportCSV([{ file: 'test_T-001.xlsx', project: 'T-001' }, { file: 'test_T-001.xlsx', project: 'T-001' }]);
  const m = build(json, undefined, rep);
  const d = issuesOf(m, 'duplicate_file');
  assert.equal(d.length, 2);
  assert.equal(m.files.length, 1, '統合後のファイル一覧では 1 件');
});

test('件数突合: 想定ファイル数と処理・失敗数・検証行数が合わなければ公開不可', () => {
  const json = dataset([rec()], { files: ['test_T-001.xlsx'] });
  json.report_metadata.file_count_expected = 2;
  const m = build(json, undefined, reportCSV([{ file: 'test_T-001.xlsx', project: 'T-001' }]));
  assert.ok(issuesOf(m, 'count_reconcile').length >= 1);
  assert.equal(m.publishable, false);
});

test('全ファイルに検証行が必要: 検証行がないファイルは公開不可', () => {
  const json = dataset([rec()], { files: ['test_T-001.xlsx', 'test_T-002.xlsx'] });
  const m = build(json, undefined, reportCSV([{ file: 'test_T-001.xlsx', project: 'T-001' }]));
  assert.equal(issuesOf(m, 'missing_validation_row').length, 1);
  assert.equal(m.publishable, false);
});

// ---------------------------------------------------------------- 9. 未知の列（後方互換）
test('未知の列: JSON の未知キー（最上位・メタ・物件）を無視し、既知の値は読める', () => {
  const json = dataset([rec({ new_kpi_2027: 123, nested: { a: 1 } })], { override: { schema_version_next: 'x' } });
  json.report_metadata.new_meta = 'x';
  const m = build(json);
  const u = issuesOf(m, 'unknown_column');
  assert.equal(u.length, 1);
  assert.equal(u[0].severity, 'info');
  assert.match(u[0].message, /new_kpi_2027/);
  assert.match(u[0].message, /schema_version_next/);
  assert.match(u[0].message, /new_meta/);
  assert.equal(m.records[0].values.total_units, 10);
  assert.equal(m.records[0].values.new_kpi_2027, undefined);
  assert.equal(m.publishable, true);
});

test('未知の列: CSV に列が追加・並び替えされても列名で読める', () => {
  const master = 'extra_col,pm,property_name_ja,Project #,am,spc,project_name,added_2027\nX,PM社,テスト名,T-001,AM社,SPC1,Test,Y\n';
  const m = build(dataset([rec()]), master);
  assert.equal(m.records[0].linked, true);
  assert.equal(m.records[0].names.property_name_ja, 'テスト名');
  assert.equal(m.records[0].names.pm, 'PM社');
  assert.deepEqual(m.master.unknownColumns, ['extra_col', 'added_2027']);
  const rep = H.REPORT_HEADER + ',新しい列\ntest_T-001.xlsx,T-001,正常,1,,なし,なし,なし,high,,値\n';
  const m2 = build(dataset([rec()], { files: ['test_T-001.xlsx'] }), undefined, rep);
  assert.deepEqual(m2.report.unknownColumns, ['新しい列']);
  assert.equal(m2.files[0].result, 'success');
});

test('未知の列: 任意フィールドが欠けていても動作する（最小構成）', () => {
  const m = build({ report_metadata: { source_period: '20260112' }, properties: [{ project_number: 'T-001' }] });
  assert.equal(m.ok, true);
  assert.equal(m.records[0].occupancy, null);
  const s = core.summarize(m.records, [], m, config);
  assert.equal(s.total_units.value, null);
});

test('未知の列: 個人情報らしい列名は読み込まず警告する', () => {
  const m = build(dataset([rec({ tenant_name: '架空 太郎', contact_email: 'x@example.com', 入居者名: '架空' })]));
  const p = issuesOf(m, 'privacy_stripped');
  assert.equal(p.length, 1);
  assert.match(p[0].message, /tenant_name/);
  assert.equal(JSON.stringify(m.records).indexOf('架空 太郎'), -1);
});

// ---------------------------------------------------------------- 対象週・プライバシー
test('対象週は report_metadata.source_period を使う（日付のハードコードなし）', () => {
  const m = build(dataset([rec({ report_date: '2031-04-07' })], { override: { report_metadata: { source_period: '2031/04/07' } } }));
  assert.equal(m.period, '20310407');
  assert.equal(m.periodLabel, '2031-04-07');
  assert.deepEqual(m.periods, ['20310407']);
  Object.values(config.dataFiles).forEach((f) => assert.doesNotMatch(f, /\d{6,8}/));
});

test('プライバシー: メール・電話・URL・パスを伏字にし、ファイル名からフォルダを除く', () => {
  const s = core.sanitizeText('連絡 a.b@example.co.jp / 03-1234-5678 / 09012345678 / https://contoso.sharepoint.com/sites/x C:\\Users\\x\\a.xlsx', config).value;
  assert.doesNotMatch(s, /@|03-1234|0901234|sharepoint|Users/);
  assert.equal(core.sanitizeText('2026-10-19 稼働 95.0%', config).value, '2026-10-19 稼働 95.0%', '日付や数値は伏字にしない');
  assert.equal(core.baseName('\\\\server\\share\\週報.xlsx'), '週報.xlsx');
  const m = build(dataset([rec({ pm_comment: '担当 test@example.com まで', source_file_name: '/sites/abc/週報.xlsx' })]));
  assert.doesNotMatch(m.records[0].text.pm_comment, /example/);
  assert.equal(m.records[0].text.source_file_name, '週報.xlsx');
  assert.equal(issuesOf(m, 'privacy_masked').length, 1);
});

test('CSV 出力は個人情報を含まない列のみで、数式インジェクションを防ぐ', () => {
  const m = build(dataset([rec({ pm_comment: '秘密のコメント' })]), H.MASTER_HEADER + '\nT-001,=HYPERLINK("x"),名前,E,S,A,P,x\n');
  const csv = core.exportRecordsCSV(m.records);
  assert.doesNotMatch(csv, /秘密のコメント/);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /^\ufeffProject #,/);
});

test('表示: 金額は万円（既定）で単位付き、比率は小数第1位', () => {
  assert.equal(core.fmtMoney(128000, config), '12.8万円');
  assert.equal(core.fmtMoney(-3000, config, true), '-0.3万円');
  assert.equal(core.fmtMoney(1234567, Object.assign({}, config, { display: Object.assign({}, config.display, { moneyUnit: 'yen' }) })), '1,234,567円');
  assert.equal(core.fmtRate(0.91584, config), '91.6%');
  assert.equal(core.fmtPt(-0.014851, config), '-1.5pt');
  assert.equal(core.fmtPt(-0.0004, config), '0.0pt', '-0.0 を出さない');
});

test('暫定: low confidence を含む集計は暫定になる', () => {
  const m = build(dataset([rec({ data_confidence: 'low' })]));
  const s = core.summarize(m.records, [], m, config);
  assert.equal(s.provisional, true);
  assert.ok(s.provisionalReasons.some((r) => /低確度/.test(r)));
  const ok = build(dataset([rec()]));
  assert.equal(core.summarize(ok.records, [], ok, config).provisional, false);
});

test('フィルター: 稼働率帯・確度・アラート有無・SPC で絞り込める', () => {
  const props = [rec(), rec({ project_number: 'T-002', occupied_units: 7, vacant_units: 3, occupancy_rate_source: 0.7, occupancy_rate_calculated: 0.7, occupancy_after_application_calculated: 0.8, data_confidence: 'low' })];
  const m = build(dataset(props), masterCSV(['T-001', 'T-002']));
  const a = core.computeAlerts(m, m.period, config);
  const recs = core.recordsForPeriod(m, m.period);
  assert.deepEqual(core.filterRecords(recs, { band: 'lt80' }, a, config).map((r) => r.key), ['T-002']);
  assert.deepEqual(core.filterRecords(recs, { band: '90to95' }, a, config).map((r) => r.key), ['T-001']);
  assert.deepEqual(core.filterRecords(recs, { confidence: 'low' }, a, config).map((r) => r.key), ['T-002']);
  assert.deepEqual(core.filterRecords(recs, { alert: 'yes' }, a, config).map((r) => r.key), ['T-002']);
  assert.deepEqual(core.filterRecords(recs, { projectNumber: 't-001' }, a, config).map((r) => r.key), ['T-001']);
  assert.deepEqual(core.filterRecords(recs, { propertyNameJa: '物件1' }, a, config).map((r) => r.key), ['T-002']);
  assert.equal(core.filterRecords(recs, { spc: 'テストSPC' }, a, config).length, 2);
});

test('アラート: 稼働率低下・解約増加・長期空室・AD/FR 変更・賃料変更・申込取消を検出', () => {
  const prev = rec({ report_date: '2026-01-05', scheduled_termination_units: 0, ad: 1, fr: 0, asking_rent: 100000 });
  const cur = rec({ occupied_units: 8, vacant_units: 2, occupancy_rate_source: 0.8, occupancy_rate_calculated: 0.8, occupancy_after_application_calculated: 0.9,
    scheduled_termination_units: 2, ad: 2, fr: 0, asking_rent: 98000, rent_revision_amount: -2000, maximum_vacancy_days: 120, long_vacancy_units: 1,
    pm_comment: '申込取消が1件発生' });
  const m = build(dataset([prev, cur]));
  const a = core.computeAlerts(m, m.period, config);
  const n = Object.fromEntries(a.categories.map((c) => [c.key, c.items.length]));
  assert.equal(n.occupancy_drop, 1);
  assert.equal(n.termination_increase, 1);
  assert.equal(n.long_vacancy, 1);
  assert.equal(n.ad_fr_change, 1);
  assert.equal(n.asking_rent_change, 1);
  assert.equal(n.application_cancel, 1);
  assert.equal(a.prevPeriod, '20260105');
});

test('アラート: 前週データがなければ前週比較系は判定不可（0件と区別）', () => {
  const m = build(dataset([rec()]));
  const a = core.computeAlerts(m, m.period, config);
  const c = Object.fromEntries(a.categories.map((x) => [x.key, x]));
  assert.equal(c.occupancy_drop.judgeable, false);
  assert.equal(c.occupancy_drop.note, '前週データなし');
  assert.equal(c.source_mismatch.judgeable, true);
});
