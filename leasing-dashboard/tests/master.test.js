'use strict';
// 物件マスターの追加列・絞り込み・ファイル名との照合の自動テスト（物件名はすべて架空）
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../ingest');
const core = require('../core');
const config = require('../config');
const H = require('./helpers');

const MASTER = [
  'project_number,project_name,property_name_ja,property_name_en,TMK,担当者',
  '201,Alpha,サンプルレジデンス北町,Sample Kitamachi,架空TMK1,架空担当A',
  '202,Bravo,サンプルレジデンス北町II,,架空TMK1,架空担当B',
  '203,Charlie,サンプルレジデンス南,,架空TMK2,架空担当A',
  '204,Delta,サンプルレジデンス駅前,,,',
  '205,Echo,サンプルレジデンス東,,架空TMK2,'
].join('\n') + '\n';

test('物件マスター: 既知の列以外（TMK など）を絞り込み項目として読み込む', () => {
  const m = core.loadMaster(MASTER, config);
  assert.deepEqual(m.extraColumns, ['TMK', '担当者']);
  assert.equal(m.byKey['201'].extra.TMK, '架空TMK1');
  assert.equal(m.byKey['204'].extra.TMK, null, '空欄は null');
});

test('物件マスター: 個人名の可能性がある列は許可した列（担当者＝イニシャル運用）だけ読み、それ以外は読まない', () => {
  const deny = Object.assign({}, config, { privacy: Object.assign({}, config.privacy, { allowedMasterColumns: [] }) });
  const m = core.loadMaster(MASTER, deny);
  assert.ok(m.issues.some((i) => i.type === 'privacy_stripped' && /担当者/.test(i.message)));
  assert.equal(JSON.stringify(m.entries).indexOf('架空担当'), -1);
  assert.deepEqual(config.privacy.allowedMasterColumns, ['担当者']);
  const m2 = core.loadMaster(MASTER, config);
  assert.deepEqual(m2.extraColumns, ['TMK', '担当者']);
  assert.equal(m2.byKey['203'].extra['担当者'], '架空担当A');
  // 許可していない個人情報らしい列（連絡先など）は従来どおり読まない
  const m4 = core.loadMaster('project_number,property_name_ja,連絡先\n1,架空,03-0000-0000\n', config);
  assert.deepEqual(m4.extraColumns, []);
});

test('絞り込み: 物件マスターの追加列の値・「データなし」で物件を絞り込める', () => {
  const props = ['201', '202', '203', '204'].map((k) => H.rec({ project_number: k }));
  const m = core.buildModel(H.dataset(props), MASTER, null, config);
  const recs = core.recordsForPeriod(m, m.period);
  assert.deepEqual(core.filterRecords(recs, { master: { TMK: '架空TMK1' } }, null, config).map((r) => r.key), ['201', '202']);
  assert.deepEqual(core.filterRecords(recs, { master: { TMK: '__none__' } }, null, config).map((r) => r.key), ['204']);
  assert.equal(core.filterRecords(recs, { master: { TMK: '' } }, null, config).length, 4);
});

test('データのない物件: マスターにあって基準週のレコードがない物件を列挙する', () => {
  const m = core.buildModel(H.dataset([H.rec({ project_number: '201' })]), MASTER, null, config);
  assert.deepEqual(core.missingProperties(m, m.period).map((e) => e.key), ['202', '203', '204', '205']);
});

test('照合: 多くの物件名に共通する接頭語をマスターから自動で見つける（ブランド名をコードに持たない）', () => {
  assert.deepEqual(I.detectPrefixes(core.loadMaster(MASTER, config)), ['サンプルレジデンス']);
});

test('照合: ファイル名の物件名は区切られた位置だけ一致とし、最長一致で決める', () => {
  const r = I.previewMapping([
    '【サンプルレジデンス北町】週報_260111.xlsm',
    '★【サンプルレジデンス北町Ⅱ】週報_20260111.xlsx',
    'リーシング報告書 _(北町)2026.1.11.xlsx',
    'リーシング報告書 南 20260111.xlsx',
    'リーシング報告書_2026.1.11(駅前).xlsx',
    'リーシング報告書 _(北町ガーデン)2026.1.11.xlsx',
    '【週報】サンプルレジデンス駅前ステーション20260111.xlsx',
    '報告_西南_20260111.xlsx'
  ], MASTER, null, config);
  // 接頭語を除くと 1 文字になる名前（南）は「南馬込」などへの誤一致を避けるため照合に使わない
  assert.deepEqual(r.map((x) => x.project_number), ['201', '202', '201', null, '204', null, null, null]);
  assert.match(r[5].note, /北町（直後に「ガーデン/);
  assert.match(r[6].note, /ステーション/);
});

test('照合: 対応表はファイル名の照合より優先する', () => {
  const r = I.previewMapping(['リーシング報告書 _(北町ガーデン)2026.1.11.xlsx'], MASTER, 'file_name_pattern,project_number\n北町ガーデン,205\n', config);
  assert.equal(r[0].project_number, '205');
  assert.equal(r[0].by, '対応表');
});

test('履歴の引継ぎ: 住戸明細は直近の週（既定 2 週）だけ残し、物件の集計は 12 週残す', () => {
  const prev = {
    properties: ['2025-12-21', '2025-12-28', '2026-01-04'].map((d) => ({ report_date: d, project_number: '201', total_units: 10 })),
    units: ['2025-12-28', '2026-01-04'].map((d) => ({ report_date: d, project_number: '201', unit_number: '101', leasing_status: 'vacant' }))
  };
  const res = { file_name: 'x.xlsx', format: 'A', role: '週報型', status: 'success', hash: 'h', include_in_numeric: true, warnings: [], unreadable: [],
    weeks: [{ week_end: core.parseDateValue('2026-01-11').value, report_day: core.parseDateValue('2026-01-11').value, values: { total_units: 10 } }],
    units: [], unit_events: [], action_items: [], activity: [], confidence: 'high', extracted: 1 };
  const built = I.buildDashboardData([res], { config, masterText: MASTER, mappingText: 'file_name_pattern,project_number\nx,201\n', previousData: prev });
  assert.deepEqual(built.data.properties.map((p) => p.report_date).sort(), ['2025-12-21', '2025-12-28', '2026-01-04', '2026-01-11']);
  assert.deepEqual(built.data.units.map((u) => u.report_date), ['2026-01-04']);
});
