#!/usr/bin/env node
/*
 * 自己診断ページ（selftest.html）用に、架空の週報 Excel を JavaScript に埋め込む
 *
 *   node scripts/build-selftest-fixtures.js
 *
 * file:// で開いたページはファイルを fetch できないため、Base64 で埋め込む。
 * tests/fixtures/weekly と weekly_master.csv を変えたら実行する（tests が同期を確認する）。
 */
'use strict';
var fs = require('fs');
var path = require('path');
var ROOT = path.resolve(__dirname, '..');
var DIR = path.join(ROOT, 'tests', 'fixtures', 'weekly');
var OUT = path.join(ROOT, 'tests', 'browser', 'selftest_fixtures.js');

function build() {
  var files = fs.readdirSync(DIR).sort().map(function (n) {
    return { name: n, base64: fs.readFileSync(path.join(DIR, n)).toString('base64') };
  });
  var master = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'weekly_master.csv'), 'utf8');
  return '/* 自動生成（scripts/build-selftest-fixtures.js）。架空の週報 Excel と物件マスター。編集しないこと */\n' +
    'window.SELFTEST_FIXTURES = ' + JSON.stringify({ files: files, master: master }, null, 1) + ';\n';
}

if (require.main === module) {
  fs.writeFileSync(OUT, build());
  console.log('written ' + path.relative(ROOT, OUT));
}
module.exports = { build: build, OUT: OUT };
