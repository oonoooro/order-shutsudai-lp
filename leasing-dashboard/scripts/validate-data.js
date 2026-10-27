#!/usr/bin/env node
/*
 * データ検証スクリプト（入力ファイルは読み取りのみ。書き換えない）
 *
 *   node scripts/validate-data.js [--data ./data] [--json] [--strict]
 *
 * 終了コード:
 *   0 … 公開条件（JSON構文・件数突合・全ファイルの検証行）を満たし、整合性エラーなし
 *   1 … エラーあり（--strict 指定時は警告も 1 とする）
 *   2 … ファイルが読めない等で検証できない
 */
'use strict';

var fs = require('fs');
var path = require('path');
var core = require('../core');
var config = require('../config');

var FILES = {
  dashboardDataText: 'dashboard_data.json',
  propertyMasterText: 'property_master.csv',
  validationReportText: 'validation_report.csv'
};

function parseArgs(argv) {
  var o = { data: path.resolve(__dirname, '..', 'data'), json: false, strict: false };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') o.data = path.resolve(process.cwd(), argv[++i]);
    else if (argv[i] === '--json') o.json = true;
    else if (argv[i] === '--strict') o.strict = true;
  }
  return o;
}

function readTexts(dir) {
  var texts = {}, missing = [];
  Object.keys(FILES).forEach(function (k) {
    var p = path.join(dir, FILES[k]);
    if (fs.existsSync(p)) texts[k] = fs.readFileSync(p, 'utf8');
    else { texts[k] = null; missing.push(FILES[k]); }
  });
  return { texts: texts, missing: missing };
}

function validate(dir) {
  var r = readTexts(dir);
  if (r.texts.dashboardDataText === null) {
    return { exitCode: 2, fatal: 'dashboard_data.json が見つかりません: ' + path.join(dir, FILES.dashboardDataText), missing: r.missing };
  }
  var model = core.loadAll(r.texts, config);
  if (!model.ok) return { exitCode: 1, fatal: model.fatal.message, missing: r.missing, issues: [model.fatal] };
  var counts = { error: 0, warning: 0, info: 0 };
  model.issues.forEach(function (i) { counts[i.severity]++; });
  var summary = core.summarize(core.recordsForPeriod(model, model.period),
    model.periods.length > 1 ? core.recordsForPeriod(model, core.previousPeriod(model, model.period)) : [], model, config);
  return {
    exitCode: counts.error > 0 ? 1 : 0,
    model: model, counts: counts, summary: summary, missing: r.missing,
    stats: {
      source_period: model.meta.source_period,
      periods: model.periods,
      property_records: model.records.length,
      unit_records: model.units.length,
      master_entries: model.master.entries.length,
      files: model.files.length,
      files_success: model.files.filter(function (f) { return f.result === 'success'; }).length,
      files_partial: model.files.filter(function (f) { return f.result === 'partial'; }).length,
      files_failed: model.files.filter(function (f) { return f.result === 'failed'; }).length,
      validation_rows: model.report.rows.length,
      counts_reconciled: model.countsReconciled,
      publishable: model.publishable
    }
  };
}

function main() {
  var opts = parseArgs(process.argv.slice(2));
  var res = validate(opts.data);
  var code = res.exitCode;
  if (code === 0 && opts.strict && res.counts.warning > 0) code = 1;
  if (opts.json) {
    console.log(JSON.stringify({
      exitCode: code, fatal: res.fatal || null, missing: res.missing, stats: res.stats || null, counts: res.counts || null,
      issues: res.model ? res.model.issues : (res.issues || [])
    }, null, 2));
    process.exit(code);
  }
  console.log('== データ検証: ' + opts.data);
  if (res.missing.length) console.log('未配置: ' + res.missing.join(', '));
  if (res.fatal) {
    console.log('[致命的] ' + res.fatal);
    process.exit(code);
  }
  var s = res.stats, sm = res.summary;
  var f = function (v) { return core.fmtCount(v, config); };
  console.log('対象週 (source_period): ' + s.source_period + ' / 基準週一覧: ' + s.periods.join(', '));
  console.log('物件レコード: ' + s.property_records + '件 / 住戸明細: ' + (s.unit_records ? s.unit_records + '件' : 'なし') + ' / 物件マスター: ' + s.master_entries + '件');
  console.log('ファイル: ' + s.files + '件（正常 ' + s.files_success + ' / 一部 ' + s.files_partial + ' / 失敗 ' + s.files_failed + '） / 検証行: ' + s.validation_rows + '行');
  console.log('件数突合: ' + (s.counts_reconciled ? 'OK' : 'NG') + ' / 公開条件: ' + (s.publishable ? '満たす' : '満たさない'));
  console.log('集計（対象週）: 物件 ' + f(sm.propertyCount.value) + ' / 総戸数 ' + f(sm.total_units.value) + ' / 稼働 ' + f(sm.occupied_units.value) +
    ' / 空室 ' + f(sm.vacant_units.value) + ' / 申込 ' + f(sm.application_units.value) + ' / 稼働率 ' + core.fmtRate(sm.occupancy.value, config) +
    ' / 申込反映後 ' + core.fmtRate(sm.afterApplication.value, config) + (sm.provisional ? ' [暫定: ' + sm.provisionalReasons.join('、') + ']' : ''));
  console.log('検証結果: エラー ' + res.counts.error + ' / 警告 ' + res.counts.warning + ' / 情報 ' + res.counts.info);
  // 同種の項目はまとめて表示する
  var groups = {};
  res.model.issues.forEach(function (i) {
    var g = i.severity + '|' + i.label;
    (groups[g] = groups[g] || []).push(i);
  });
  Object.keys(groups).forEach(function (g) {
    var list = groups[g], parts = g.split('|');
    var tag = parts[0] === 'error' ? '[エラー]' : parts[0] === 'warning' ? '[警告]' : '[情報]';
    console.log(tag + ' ' + parts[1] + ': ' + list.length + '件');
    list.slice(0, 5).forEach(function (i) { console.log('    - ' + i.message); });
    if (list.length > 5) console.log('    …他 ' + (list.length - 5) + '件');
  });
  console.log(code === 0 ? '結果: OK' : '結果: NG（終了コード ' + code + '）');
  process.exit(code);
}

if (require.main === module) main();

module.exports = { validate: validate, readTexts: readTexts };
