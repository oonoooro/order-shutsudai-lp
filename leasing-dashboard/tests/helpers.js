'use strict';
// テスト共通ヘルパー（データはすべて架空）
const fs = require('fs');
const path = require('path');
const core = require('../core');
const config = require('../config');

const MASTER_HEADER = 'project_number,project_name,property_name_ja,property_name_en,spc,am,pm,master_source';
const REPORT_HEADER = 'ファイル名,対象物件,処理結果,抽出項目数,読取不能項目,重複の可能性,数値不一致,物件名不一致,データ確度,要確認理由';

function masterCSV(keys, header) {
  return '﻿' + (header || MASTER_HEADER) + '\r\n' + keys.map(function (k, i) {
    return [k, 'Test Property ' + i, 'テスト物件' + i, 'Test ' + i, 'テストSPC', 'テストAM社', 'テストPM社', 'test'].join(',');
  }).join('\r\n') + '\r\n';
}

function reportCSV(rows) {
  return '﻿' + REPORT_HEADER + '\n' + rows.map(function (r) {
    return [r.file, r.project || '', r.result || '正常', r.count === undefined ? 10 : r.count, '', 'なし', r.mismatch || 'なし', 'なし', r.conf || 'high', ''].join(',');
  }).join('\n') + '\n';
}

function rec(o) {
  return Object.assign({
    report_date: '2026-01-12', project_number: 'T-001', total_units: 10, occupied_units: 9, vacant_units: 1,
    application_units: 1, occupancy_rate_source: 0.9, occupancy_rate_calculated: 0.9,
    occupancy_after_application_calculated: 1, data_confidence: 'high', source_file_name: 'test_T-001.xlsx'
  }, o || {});
}

function dataset(props, extra) {
  const files = (extra && extra.files) || [];
  return Object.assign({
    report_metadata: {
      report_date: '2026-01-12', source_period: '20260112',
      file_count_expected: files.length, file_count_processed: files.length, file_count_failed: 0,
      generated_by: 'test', contains_personal_data: false
    },
    portfolio_summary: { status: 'calculated', is_provisional: false },
    properties: props,
    alerts: [],
    validation_summary: { success: files.length, partial: 0, failed: 0, property_linked: files.length, duplicate_candidates: 0, low_confidence_records: 0 },
    file_inventory: files.map(function (f) { return { file_name: f, status: 'success' }; })
  }, extra && extra.override ? extra.override : {});
}

function build(json, masterText, reportText) {
  return core.buildModel(json, masterText === undefined ? masterCSV(['T-001']) : masterText, reportText === undefined ? null : reportText, config);
}

function issuesOf(model, type) { return model.issues.filter(function (i) { return i.type === type; }); }

function readFixture(name) {
  const dir = path.join(__dirname, 'fixtures', name);
  const read = function (f) { const p = path.join(dir, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
  return {
    dir: dir,
    dashboardDataText: read('dashboard_data.json'),
    propertyMasterText: read('property_master.csv'),
    validationReportText: read('validation_report.csv')
  };
}

module.exports = { core, config, MASTER_HEADER, REPORT_HEADER, masterCSV, reportCSV, rec, dataset, build, issuesOf, readFixture };
