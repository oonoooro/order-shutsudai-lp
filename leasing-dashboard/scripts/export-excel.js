#!/usr/bin/env node
/*
 * SharePoint で共有する Excel レポートを作る
 *
 *   node scripts/export-excel.js [--data data] [--out output/leasing_dashboard.xlsx] [--period YYYYMMDD]
 *
 * - --data フォルダの dashboard_data.json・property_master.csv・validation_report.csv を読むだけで変更しない
 * - 基準週は --period、なければ report_metadata.source_period（ダッシュボードと同じ）
 * - 出力ファイル名は config.js の excelReportFileName。毎週同じ名前で SharePoint に上書きすると URL が変わらない
 */
'use strict';

var fs = require('fs');
var path = require('path');
var core = require('../core');
var config = require('../config');
var report = require('../report-xlsx');

function parseArgs(argv) {
  var root = path.resolve(__dirname, '..');
  var o = { data: path.join(root, 'data'), out: null, period: null };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--data') o.data = path.resolve(argv[++i]);
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--period') o.period = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
  }
  if (!o.out) o.out = path.join(root, 'output', config.excelReportFileName || 'leasing_dashboard.xlsx');
  return o;
}

function readIf(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; }

function run(opts, now) {
  var dataPath = path.join(opts.data, 'dashboard_data.json');
  if (!fs.existsSync(dataPath)) return { exitCode: 2, message: 'dashboard_data.json が見つかりません: ' + dataPath };
  var model = core.loadAll({
    dashboardDataText: fs.readFileSync(dataPath, 'utf8'),
    propertyMasterText: readIf(path.join(opts.data, 'property_master.csv')),
    validationReportText: readIf(path.join(opts.data, 'validation_report.csv'))
  }, config);
  if (!model.ok) return { exitCode: 1, message: 'データを読み込めません: ' + (model.fatal && model.fatal.message || '') };
  var period = model.period;
  if (opts.period) {
    period = model.periods.filter(function (p) { return p.replace(/-/g, '') === String(opts.period).replace(/-/g, ''); })[0];
    if (!period) return { exitCode: 2, message: '指定の基準週のデータがありません: ' + opts.period + '（あるのは ' + model.periods.join(', ') + '）' };
  }
  var r = report.buildReport(model, period, config, { generatedAt: now || new Date() });
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  var tmp = opts.out + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, r.bytes);
  fs.renameSync(tmp, opts.out);
  return { exitCode: 0, message: '書き出しました: ' + opts.out + '（基準週 ' + core.formatPeriod(period) + '、' + r.book.sheets.length + 'シート）', out: opts.out, book: r.book };
}

if (require.main === module) {
  var opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('使い方: node scripts/export-excel.js [--data data] [--out output/' + (config.excelReportFileName || 'leasing_dashboard.xlsx') + '] [--period YYYYMMDD]');
    process.exit(0);
  }
  var res = run(opts);
  (res.exitCode ? console.error : console.log)(res.message);
  process.exit(res.exitCode);
}

module.exports = { run: run, parseArgs: parseArgs };
