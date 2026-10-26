#!/usr/bin/env node
/*
 * 週報 Excel を解析して dashboard_data.json と validation_report.csv を作る
 *
 *   node scripts/ingest-weekly.js --in <週報フォルダ> [--out data] [--master data/property_master.csv]
 *                                [--mapping data/source_mapping.csv] [--previous <json> | --no-previous] [--period YYYYMMDD]
 *
 * - --in フォルダ直下の .xlsx / .xlsm を読み取り専用で読む（サブフォルダ・一時ファイル ~$ は対象外）
 * - 出力は --out フォルダの dashboard_data.json と validation_report.csv（一時ファイルに書いてから置き換える）
 * - 前回の dashboard_data.json（既定は --out にある既存ファイル）の履歴を引き継ぎ、前週比較に使う
 * - property_master.csv は読むだけで変更しない
 */
'use strict';

var fs = require('fs');
var path = require('path');
var ingest = require('../ingest');
var core = require('../core');
var config = require('../config');

function parseArgs(argv) {
  var root = path.resolve(__dirname, '..');
  var o = { out: path.join(root, 'data'), master: null, mapping: null, previous: null, noPrevious: false, period: null };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--in') o.in = path.resolve(argv[++i]);
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--master') o.master = path.resolve(argv[++i]);
    else if (a === '--mapping') o.mapping = path.resolve(argv[++i]);
    else if (a === '--previous') o.previous = path.resolve(argv[++i]);
    else if (a === '--no-previous') o.noPrevious = true;
    else if (a === '--period') o.period = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
  }
  if (!o.master) o.master = path.join(o.out, 'property_master.csv');
  if (!o.mapping) o.mapping = path.join(o.out, 'source_mapping.csv');
  if (!o.previous && !o.noPrevious) o.previous = path.join(o.out, 'dashboard_data.json');
  return o;
}

function readIf(p) { return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; }

function writeAtomic(p, text) {
  var tmp = p + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

function run(opts) {
  if (!opts.in || !fs.existsSync(opts.in) || !fs.statSync(opts.in).isDirectory()) {
    return Promise.resolve({ exitCode: 2, message: '週報フォルダが見つかりません: ' + opts.in });
  }
  var names = fs.readdirSync(opts.in).filter(function (n) {
    return /\.(xlsx|xlsm)$/i.test(n) && n.indexOf('~$') !== 0 && fs.statSync(path.join(opts.in, n)).isFile();
  }).sort();
  if (!names.length) return Promise.resolve({ exitCode: 2, message: '.xlsx / .xlsm ファイルがありません: ' + opts.in });
  var masterText = readIf(opts.master);
  var previousData = null, previousNote = null;
  if (opts.previous && fs.existsSync(opts.previous)) {
    var p = core.safeParseJSON(fs.readFileSync(opts.previous, 'utf8'));
    if (p.ok) previousData = p.value; else previousNote = '前回の dashboard_data.json を読めないため履歴を引き継ぎません: ' + p.error;
  }
  var periodDay = null;
  if (opts.period) {
    var pd = core.normalizePeriod(opts.period);
    periodDay = pd && /^\d{8}$/.test(pd) ? core.parseDateValue(pd.slice(0, 4) + '-' + pd.slice(4, 6) + '-' + pd.slice(6)).value : null;
    if (periodDay === null) return Promise.resolve({ exitCode: 2, message: '--period は YYYYMMDD で指定してください' });
  }
  return Promise.all(names.map(function (n) {
    return ingest.parseWorkbookFile({ name: n, bytes: fs.readFileSync(path.join(opts.in, n)) }, { config: config });
  })).then(function (results) {
    var built = ingest.buildDashboardData(results, {
      config: config, masterText: masterText, mappingText: readIf(opts.mapping), previousData: previousData,
      periodDay: periodDay === null ? undefined : periodDay
    });
    fs.mkdirSync(opts.out, { recursive: true });
    var json = JSON.stringify(built.data, null, 2) + '\n';
    // 出力が読み直せることを確認してから置き換える
    var check = core.loadAll({ dashboardDataText: json, propertyMasterText: masterText, validationReportText: built.validationCSV }, config);
    if (!check.ok) return { exitCode: 1, message: '生成した JSON を検証できません: ' + check.fatal.message };
    writeAtomic(path.join(opts.out, 'dashboard_data.json'), json);
    writeAtomic(path.join(opts.out, 'validation_report.csv'), built.validationCSV);
    return { exitCode: 0, built: built, model: check, masterFound: masterText !== null, previousNote: previousNote, names: names };
  });
}

function main() {
  var opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.in) {
    console.log('使い方: node scripts/ingest-weekly.js --in <週報フォルダ> [--out data] [--master <csv>] [--mapping <csv>] [--previous <json> | --no-previous] [--period YYYYMMDD]');
    process.exit(opts.help ? 0 : 2);
  }
  run(opts).then(function (r) {
    if (r.exitCode && r.message) { console.error(r.message); process.exit(r.exitCode); }
    var d = r.built.data, files = r.built.files;
    console.log('== 週報の解析: ' + opts.in + '（' + r.names.length + 'ファイル）');
    if (!r.masterFound) console.log('※ 物件マスターがありません（' + opts.master + '）。Project # に紐付けできません。');
    if (r.previousNote) console.log('※ ' + r.previousNote);
    files.forEach(function (f) {
      console.log('  [' + ({ success: '正常', partial: '一部', failed: '失敗' })[f.status] + '] ' + f.file_name +
        (f.format ? ' … 様式' + f.format + '（' + f.role + '）' : '') + (f.project_key ? ' → ' + f.project_key : (f.format && f.format !== 'D' && f.status !== 'failed' ? ' → 未紐付け' : '')) +
        (f.reason ? ' … ' + f.reason : ''));
    });
    console.log('対象週: ' + d.report_metadata.source_period + ' / 物件レコード ' + d.properties.length + '件 / 住戸 ' + d.units.length + '件 / 住戸の動き ' + d.unit_events.length + '件 / 対応事項 ' + d.action_items.length + '件');
    console.log('出力: ' + path.join(opts.out, 'dashboard_data.json') + ' / ' + path.join(opts.out, 'validation_report.csv'));
    console.log('検証: エラー ' + r.model.issues.filter(function (i) { return i.severity === 'error'; }).length + ' / 警告 ' + r.model.issues.filter(function (i) { return i.severity === 'warning'; }).length);
    process.exit(0);
  }).catch(function (e) { console.error(e && e.stack || e); process.exit(1); });
}

if (require.main === module) main();

module.exports = { run: run, parseArgs: parseArgs };
