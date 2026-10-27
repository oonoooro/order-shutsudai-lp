#!/usr/bin/env node
/*
 * SharePoint に置く一式（ZIP）を作る
 *
 *   node scripts/build-package.js [--out output/leasing-dashboard-sharepoint.zip]
 *
 * - 中身は、ダッシュボードの実行に必要なファイル・手順書・Copilot 用の指示文・架空データの見本 Excel だけ
 * - data/ の実データ（dashboard_data.json・property_master.csv など）は入れない
 * - ZIP 内のファイル名は英数字だけにする（Windows の「すべて展開」で文字化けしないように）
 * - 元のファイルは読むだけで変更しない
 */
'use strict';

var fs = require('fs');
var path = require('path');
var core = require('../core');
var config = require('../config');
var report = require('../report-xlsx');
var W = require('../xlsx-writer');

var ROOT = path.resolve(__dirname, '..');
var TOP = 'leasing-dashboard-sharepoint/';

// 2_dashboard に入れるファイル（Node.js なしで動かすのに必要なものと手順書）
var DASHBOARD_FILES = [
  'index.html', 'styles.css', 'config.js', 'core.js', 'xlsx.js', 'ingest.js', 'xlsx-writer.js', 'report-xlsx.js', 'app.js',
  'selftest.html', 'tests/browser/selftest.js', 'tests/browser/selftest_fixtures.js',
  'README.md', 'AGENTS.md', 'COPILOT_GUIDE.md', 'SHAREPOINT_GUIDE.md', 'sample_data_schema.json',
  'copilot/agent_instructions.txt', 'copilot/knowledge_AGENTS.txt', 'copilot/sharepoint_agent_instructions.txt',
  'sample_data/dashboard_data.json', 'sample_data/property_master.csv', 'sample_data/validation_report.csv',
  'data/README.md'
];
// 3_copilot に入れるファイル（Copilot に貼る・添付する用。エージェントの知識に .md を追加できない場合があるため .txt にする）
var COPILOT_FILES = [
  ['copilot/sharepoint_agent_instructions.txt', 'sharepoint_agent_instructions.txt'],
  ['copilot/agent_instructions.txt', 'agent_instructions.txt'],
  ['copilot/knowledge_AGENTS.txt', 'knowledge_AGENTS.txt'],
  ['SHAREPOINT_GUIDE.md', 'SHAREPOINT_GUIDE.txt'],
  ['COPILOT_GUIDE.md', 'COPILOT_GUIDE.txt']
];
var SAMPLE_NAME = 'SAMPLE_' + (config.excelReportFileName || 'leasing_dashboard.xlsx');

function readme(reportName) {
  return [
    '週次リーシングダッシュボード SharePoint 用パッケージ',
    '==================================================',
    '',
    'このパッケージには実データは入っていません。見本の数値・物件はすべて架空です。',
    '詳しい手順は 2_dashboard/SHAREPOINT_GUIDE.md（または 3_copilot/SHAREPOINT_GUIDE.txt）を見てください。',
    '',
    '■ フォルダの中身',
    '  1_sharepoint/' + SAMPLE_NAME,
    '      SharePoint に置く Excel の見本（架空データ）。表示の確認用です。',
    '      実際に置くのは、2_dashboard で毎週書き出す ' + reportName + ' です。',
    '  2_dashboard/',
    '      ダッシュボード本体。更新担当者の PC で index.html を開いて使います。',
    '      selftest.html … 動作確認（自己診断）',
    '      sample_data/ … 架空のサンプルデータ',
    '  3_copilot/',
    '      sharepoint_agent_instructions.txt … SharePoint のエージェントの指示欄に貼る文',
    '      agent_instructions.txt / knowledge_AGENTS.txt … ダッシュボードを Copilot で編集するエージェント用',
    '      SHAREPOINT_GUIDE.txt / COPILOT_GUIDE.txt … 手順書（Copilot に添付する場合はこちら）',
    '',
    '社内ファイル（週報・物件マスター・履歴・書き出した Excel）は、すべて SharePoint のフォルダに置きます。',
    'PC の「ダウンロード」フォルダやブラウザ内には残しません。',
    '',
    '■ SharePoint のフォルダ構成（例）',
    '  リーシングダッシュボード/',
    '    公開/       ' + reportName + '（閲覧者は「表示」）',
    '    作業/       更新担当者だけ',
    '      ツール/   2_dashboard の中身（index.html など）',
    '      週報/     その週の週報 Excel',
    '      マスター/ property_master.csv',
    '      履歴/     dashboard_data.json（前週比較に使う）',
    '',
    '■ 最初の 1 回',
    '  1. SharePoint に上のフォルダを作り、作業フォルダは更新担当者だけが見られる権限にします。',
    '  2. この ZIP を「すべて展開」し、2_dashboard の中身を「作業/ツール」にアップロードします',
    '     （アップロード →「フォルダー」）。その後、PC の ZIP と展開したフォルダは削除します。',
    '  3. 「リーシングダッシュボード」フォルダを「OneDrive へのショートカットの追加」（または「同期」）で',
    '     エクスプローラーに表示します。SharePoint 上で index.html をクリックしても画面は開きません。',
    '  4. エクスプローラーから 作業/ツール/selftest.html を Edge で開き、「すべて OK」を確認します。',
    '  5. 作業/ツール/index.html を Edge で開き、週報 Excel と property_master.csv をドロップします。',
    '  6. 「SharePoint用Excelを保存」→ 保存先に「公開」を選びます。',
    '     「履歴を保存」→ 保存先に「作業/履歴」を選びます。',
    '  7. SharePoint で 公開/' + reportName + ' のリンクをコピーし、閲覧者に共有します。',
    '  8. （任意）SharePoint ページに「ファイルとメディア」Web パーツ（この Excel）と「ボタン」Web パーツ（7. のリンク）を置きます。',
    '  9. （任意）' + reportName + ' からエージェントを作成し、3_copilot/sharepoint_agent_instructions.txt を指示欄に貼ります。',
    '',
    '■ 毎週',
    '  1. 週報を「作業/週報」に入れます。',
    '  2. 作業/ツール/index.html を Edge で開き、週報 Excel・property_master.csv・作業/履歴/dashboard_data.json を',
    '     まとめてドロップします（dashboard_data.json があると前週比較ができます）。',
    '  3. 「データ検証」タブで読取失敗・未紐付けがないか確認します。',
    '  4. 「SharePoint用Excelを保存」→「公開」に上書き保存。「履歴を保存」→「作業/履歴」に上書き保存。',
    '     名前を変えずに置き換えると、閲覧者の URL は変わりません。',
    '  5. ブラウザを閉じます（取込結果はブラウザに残りません）。',
    '',
    '■ 画面が反応しないとき',
    '  ・「画面のプログラムを読み込めていません」と出る、または何も反応しない',
    '    → index.html と同じ場所に app.js などがありません。2_dashboard の中身をまとめてアップロードしてください。',
    '  ・「まだ表示できるデータがありません」と出る',
    '    → 週報 Excel（.xlsx / .xlsm）をドロップしてください。物件マスターだけ先にドロップしても構いません。',
    '',
    '■ 守ること',
    '  ・週報の原本や dashboard_data.json を「公開」フォルダに置かない。',
    '  ・' + reportName + ' を直接編集しない（翌週の置換で上書きされます）。',
    '  ・「データなし」は 0 ではありません。',
    ''
  ].join('\r\n');
}

function sampleReport(now) {
  var dir = path.join(ROOT, 'sample_data');
  var model = core.loadAll({
    dashboardDataText: fs.readFileSync(path.join(dir, 'dashboard_data.json'), 'utf8'),
    propertyMasterText: fs.readFileSync(path.join(dir, 'property_master.csv'), 'utf8'),
    validationReportText: fs.readFileSync(path.join(dir, 'validation_report.csv'), 'utf8')
  }, config);
  if (!model.ok) throw new Error('sample_data を読み込めません');
  return report.buildReport(model, model.period, config, { generatedAt: now }).bytes;
}

function build(now) {
  now = now || new Date();
  var bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  var text = function (s) { var b = Buffer.from(s, 'utf8'); var out = new Uint8Array(bom.length + b.length); out.set(bom); out.set(b, bom.length); return out; };
  var file = function (rel) { return new Uint8Array(fs.readFileSync(path.join(ROOT, rel))); };
  var reportName = config.excelReportFileName || 'leasing_dashboard.xlsx';
  var files = [{ name: TOP + 'README_FIRST.txt', data: text(readme(reportName)) },
    { name: TOP + '1_sharepoint/' + SAMPLE_NAME, data: sampleReport(now) }];
  DASHBOARD_FILES.forEach(function (rel) { files.push({ name: TOP + '2_dashboard/' + rel, data: file(rel) }); });
  COPILOT_FILES.forEach(function (p) { files.push({ name: TOP + '3_copilot/' + p[1], data: file(p[0]) }); });
  files.forEach(function (f) { if (/[^\x20-\x7e]/.test(f.name)) throw new Error('ZIP 内のファイル名は英数字にしてください: ' + f.name); });
  return { bytes: W.zip(files, now), names: files.map(function (f) { return f.name; }) };
}

function run(opts, now) {
  var res = build(now);
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  var tmp = opts.out + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, res.bytes);
  fs.renameSync(tmp, opts.out);
  return { exitCode: 0, message: '作成しました: ' + opts.out + '（' + res.names.length + 'ファイル）', out: opts.out, names: res.names };
}

if (require.main === module) {
  var argv = process.argv.slice(2), i = argv.indexOf('--out');
  if (argv.indexOf('--help') !== -1 || argv.indexOf('-h') !== -1) {
    console.log('使い方: node scripts/build-package.js [--out output/leasing-dashboard-sharepoint.zip]');
    process.exit(0);
  }
  var out = i === -1 ? path.join(ROOT, 'output', 'leasing-dashboard-sharepoint.zip') : path.resolve(argv[i + 1]);
  var r = run({ out: out });
  console.log(r.message);
}

module.exports = { build: build, run: run, DASHBOARD_FILES: DASHBOARD_FILES };
