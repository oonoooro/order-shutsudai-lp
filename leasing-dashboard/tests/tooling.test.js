'use strict';
// 静的構成・検証スクリプト・ローカルサーバーのテスト
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { createServer } = require('../scripts/serve');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('外部 CDN・外部スクリプト・解析 SDK を使っていない', () => {
  const html = read('index.html');
  const srcs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  srcs.forEach((s) => assert.doesNotMatch(s, /^(https?:)?\/\//, 'external reference: ' + s));
  ['app.js', 'core.js', 'config.js', 'styles.css', 'index.html', 'xlsx.js', 'ingest.js', 'xlsx-writer.js', 'report-xlsx.js'].forEach((f) => {
    const t = read(f);
    assert.doesNotMatch(t, /googletagmanager|google-analytics|gtag\(|analytics\.js|cdn\.|unpkg|jsdelivr|sendBeacon|XMLHttpRequest|WebSocket|@import/i, f);
  });
  // fetch は同一オリジンの設定済みパスのみ
  const app = read('app.js');
  const fetchCalls = [...app.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(fetchCalls, ['url']);
  assert.match(app, /credentials: 'same-origin'/);
});

test('CSP で外部への接続を禁止している', () => {
  const html = read('index.html');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'self'/);
  assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
});

test('画面ロジックは innerHTML 等で文字列を HTML として挿入しない（XSS 対策）', () => {
  ['app.js', 'core.js', 'xlsx.js', 'ingest.js', 'xlsx-writer.js', 'report-xlsx.js'].forEach((f) => assert.doesNotMatch(read(f), /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, f));
});

test('設定のデータファイル名に特定週の日付を含めない', () => {
  const cfg = require('../config');
  assert.deepEqual(Object.values(cfg.dataFiles), ['data/dashboard_data.json', 'data/property_master.csv', 'data/validation_report.csv']);
  ['app.js', 'core.js', 'config.js', 'index.html', 'xlsx.js', 'ingest.js', 'scripts/serve.js', 'scripts/validate-data.js', 'scripts/ingest-weekly.js',
    'xlsx-writer.js', 'report-xlsx.js', 'scripts/export-excel.js'].forEach((f) => {
    assert.doesNotMatch(read(f), /20\d{2}[-/]?\d{2}[-/]?\d{2}/, f + ' に日付がハードコードされている');
  });
});

test('実データフォルダは .gitignore で除外されている', () => {
  const gi = read('.gitignore');
  assert.match(gi, /^data\/\*$/m);
  assert.match(gi, /^output\/$/m, '書き出した Excel（実データを含む）も除外する');
});

test('sample_data_schema.json は仕様の全フィールドを定義している', () => {
  const core = require('../core');
  const schema = JSON.parse(read('sample_data_schema.json'));
  const props = schema.properties.properties.items.properties;
  core.NUMERIC_FIELDS.concat(core.TEXT_FIELDS).forEach((f) => assert.ok(props[f], f));
  assert.equal(schema.properties.properties.items.additionalProperties, true, '未知の列を許容する');
  assert.deepEqual(schema.properties.report_metadata.required, ['source_period']);
});

function runValidate(args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts/validate-data.js')].concat(args), { encoding: 'utf8' });
}

test('検証スクリプト: 正常なデータは終了コード 0', () => {
  const r = runValidate(['--data', path.join(__dirname, 'fixtures/minimal')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /件数突合: OK/);
  assert.match(r.stdout, /稼働率 90\.0%/);
});

test('検証スクリプト: 不正な JSON は終了コード 1、ファイルなしは 2', () => {
  const bad = runValidate(['--data', path.join(__dirname, 'fixtures/invalid_json')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /JSON構文エラー/);
  const none = runValidate(['--data', path.join(__dirname, 'fixtures/does_not_exist')]);
  assert.equal(none.status, 2);
});

test('検証スクリプト: 全ファイル失敗のデータは「データなし」で集計し、公開条件は満たす', () => {
  const r = runValidate(['--data', path.join(__dirname, 'fixtures/all_failed'), '--json']);
  const o = JSON.parse(r.stdout);
  assert.equal(o.exitCode, 0);
  assert.equal(o.stats.files_failed, 3);
  assert.equal(o.stats.property_records, 0);
  assert.equal(o.stats.publishable, true);
  assert.equal(runValidate(['--data', path.join(__dirname, 'fixtures/all_failed'), '--strict']).status, 1, '--strict では警告も NG');
});

test('検証スクリプトは入力ファイルを書き換えない', () => {
  const dir = path.join(__dirname, 'fixtures/minimal');
  const before = fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8'), fs.statSync(path.join(dir, f)).mtimeMs]);
  runValidate(['--data', dir]);
  const after = fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8'), fs.statSync(path.join(dir, f)).mtimeMs]);
  assert.deepEqual(after, before);
});

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

test('ローカルサーバー: 本体とデータのみ配信し、それ以外・パス遡りは 404', async () => {
  const server = createServer({ data: path.join(__dirname, 'fixtures/minimal') });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const idx = await get(port, '/');
    assert.equal(idx.status, 200);
    assert.match(idx.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(idx.headers['cache-control'], 'no-store');
    const data = await get(port, '/data/dashboard_data.json');
    assert.equal(data.status, 200);
    assert.equal(JSON.parse(data.body).report_metadata.source_period, '20260112');
    for (const p of ['/data/..%2fconfig.js', '/data/..%5c..%5cindex.html', '/%2e%2e/%2e%2e/etc/passwd', '/scripts/serve.js', '/tests/helpers.js', '/data/other.json', '/package.json', '/.gitignore']) {
      assert.equal((await get(port, p)).status, 404, p);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('sample_data_schema.json は住戸明細（units）の項目を定義している', () => {
  const schema = JSON.parse(read('sample_data_schema.json'));
  const props = schema.properties.units.items.properties;
  ['project_number', 'unit_number', 'leasing_status', 'vacancy_start_date', 'application_date', 'application_cancel_date',
    'notice_date', 'move_out_date', 'asking_rent', 'ad', 'fr', 'work_type', 'work_end_date', 'work_completed_date'].forEach((f) => assert.ok(props[f], f));
  assert.deepEqual(schema.properties.units.items.required, ['project_number', 'unit_number']);
});

test('sample_data_schema.json は解析結果の拡張（unit_events・action_items・対応表）を定義している', () => {
  const schema = JSON.parse(read('sample_data_schema.json'));
  assert.deepEqual(schema.properties.unit_events.items.properties.type.enum, ['application', 'application_cancel', 'notice', 'condition_change']);
  assert.ok(schema.properties.action_items.items.properties.due_date);
  assert.ok(schema['x-csv-schemas']['source_mapping.csv']);
});

test('AGENTS.md（Copilot 向けガイド）に書いた関数名・設定名がコードに実在する', () => {
  const guide = read('AGENTS.md') + read('COPILOT_GUIDE.md');
  const code = { 'app.js': read('app.js'), 'core.js': read('core.js'), 'ingest.js': read('ingest.js'), 'config.js': read('config.js') };
  const names = {
    'app.js': ['LIST_COLUMNS', 'renderSummary', 'renderUnits', 'renderList', 'renderAlerts', 'renderDetail', 'renderValidation', 'function h('],
    'core.js': ['ALERT_CATEGORIES', 'function computeAlerts'],
    'ingest.js': ['function detectFormat', 'function parseA', 'function parseB', 'function parseC', 'function parseD', 'function findHeader'],
    'config.js': ['occupancyBands', 'allowedMasterColumns', 'moneyUnit', 'longVacancyDays']
  };
  Object.keys(names).forEach((f) => names[f].forEach((n) => {
    assert.ok(code[f].includes(n), f + ' に ' + n + ' がない');
    const bare = n.replace(/^function /, '').replace(/\($/, '');
    assert.ok(guide.includes(bare), 'ガイドに ' + bare + ' の記載がない');
  }));
  assert.ok(fs.existsSync(path.join(ROOT, 'tests', 'fixtures', 'make_weekly_xlsx.py')));
});

test('Microsoft 365 Copilot 用: エージェントの指示は 8,000 文字以内、知識の .txt は AGENTS.md と同じ内容', () => {
  const instr = read('copilot/agent_instructions.txt');
  assert.ok([...instr].length <= 8000, '指示が ' + [...instr].length + ' 文字');
  assert.equal(read('copilot/knowledge_AGENTS.txt'), read('AGENTS.md'), 'AGENTS.md を変えたら copilot/knowledge_AGENTS.txt にもコピーする');
  ['config.js', 'app.js', 'core.js', 'ingest.js', 'selftest.html', 'LIST_COLUMNS', 'renderSummary', 'computeUnitActivity', 'ALERT_CATEGORIES', 'allowedMasterColumns', 'occupancyBands'].forEach((n) => {
    assert.ok(instr.includes(n), '指示に ' + n + ' の記載がない');
  });
  ['renderUnits', 'computeUnitActivity'].forEach((n) => assert.ok((read('app.js') + read('core.js')).includes(n)));
});

test('自己診断ページ: 埋め込んだ架空の週報 Excel がフィクスチャと一致する', () => {
  const { build, OUT } = require('../scripts/build-selftest-fixtures');
  assert.equal(fs.readFileSync(OUT, 'utf8'), build(), 'node scripts/build-selftest-fixtures.js を実行して更新する');
  const html = read('selftest.html');
  ['config.js', 'core.js', 'xlsx.js', 'ingest.js', 'xlsx-writer.js', 'report-xlsx.js', 'tests/browser/selftest_fixtures.js', 'tests/browser/selftest.js'].forEach((s) => assert.ok(html.includes('src="' + s + '"'), s));
  assert.doesNotMatch(read('tests/browser/selftest.js'), /innerHTML|eval\(/);
});
