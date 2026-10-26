#!/usr/bin/env node
/*
 * ブラウザでの起動確認（任意。Playwright がある環境で実行）
 *
 *   node tests/browser_smoke.js [--data ./data] [--screenshots ./out]
 *
 * ローカルサーバーを起動し、全タブを表示して次を確認する:
 *   - コンソールエラー・CSP 違反がない
 *   - 外部ホストへのリクエストがない
 *   - 対象週（source_period）が表示される
 *   - 不正な JSON に差し替えた場合、前回データを保持して警告を出す
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createServer } = require('../scripts/serve');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  console.log('SKIP: playwright が見つからないため、ブラウザ確認をスキップしました。');
  process.exit(0);
}

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i === -1 ? def : path.resolve(args[i + 1]); };
const DATA = opt('--data', path.join(__dirname, '..', 'data'));
const SHOTS = opt('--screenshots', null);

async function main() {
  // 不正 JSON の差し替えを試すため、データを一時フォルダへコピーして使う（元データは変更しない）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leasing-smoke-'));
  ['dashboard_data.json', 'property_master.csv', 'validation_report.csv'].forEach((f) => {
    if (fs.existsSync(path.join(DATA, f))) fs.copyFileSync(path.join(DATA, f), path.join(tmp, f));
  });
  const sourcePeriod = String(JSON.parse(fs.readFileSync(path.join(tmp, 'dashboard_data.json'), 'utf8')).report_metadata.source_period);

  const server = createServer({ data: tmp });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [], external = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url()); });

  const fail = [];
  const check = (cond, msg) => { if (!cond) fail.push(msg); console.log((cond ? '  OK  ' : '  NG  ') + msg); };

  await page.goto(base);
  await page.waitForSelector('#header-meta strong');
  const header = await page.textContent('#header-meta');
  check(header.includes(sourcePeriod), '対象週 source_period（' + sourcePeriod + '）がヘッダーに表示される');

  for (const tab of ['summary', 'units', 'list', 'alerts', 'detail', 'validation']) {
    await page.click('.tab[data-tab="' + tab + '"]');
    const visible = await page.isVisible('#view-' + tab);
    const text = await page.textContent('#view-' + tab);
    check(visible && text.trim().length > 0, 'タブ「' + tab + '」が描画される');
    check(!/undefined|NaN|\[object Object\]/.test(text), 'タブ「' + tab + '」に undefined / NaN が表示されない');
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, tab + '.png'), fullPage: true });
    }
  }

  // フィルター操作
  await page.click('.tab[data-tab="list"]');
  await page.selectOption('#f-confidence', 'low');
  await page.selectOption('#f-confidence', '');
  check(true, 'フィルター操作でエラーが出ない');

  // 不正な JSON に差し替えて再読込 → 前回データを保持して警告
  const before = await page.textContent('#header-meta');
  fs.writeFileSync(path.join(tmp, 'dashboard_data.json'), '{ "broken": ');
  await page.click('#btn-reload');
  await page.waitForSelector('.banner-error');
  const banner = await page.textContent('#banners');
  check(/最新データを反映できません/.test(banner) && /JSON構文エラー/.test(banner), '不正な JSON では更新せず警告バナーを表示する');
  const after = await page.textContent('#header-meta');
  check(after.includes(sourcePeriod) && before.split('読込元')[0] === after.split('読込元')[0], '前回正常に読み込んだデータを保持する');

  // ページを開き直しても、ブラウザに保存した前回データで表示できる
  await page.reload();
  await page.waitForSelector('.banner-error');
  check(/前回正常に読み込んだデータ/.test(await page.textContent('#banners')), '再起動後も前回データ＋警告で表示する');

  check(errors.filter((e) => !/Failed to load resource/.test(e)).length === 0, 'コンソールエラー・CSP 違反なし' + (errors.length ? ': ' + errors.join(' | ') : ''));
  check(external.length === 0, '外部ホストへの通信なし' + (external.length ? ': ' + external.join(', ') : ''));

  // file:// で開いてローカルファイル選択で読み込めること（同一ファイルの二重選択を含む）
  const fpage = await browser.newPage();
  const ferrors = [];
  fpage.on('pageerror', (e) => ferrors.push(String(e)));
  fpage.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|file:/.test(m.text())) ferrors.push(m.text()); });
  await fpage.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await fpage.waitForSelector('.banner-error');
  const files = ['dashboard_data.json', 'property_master.csv', 'validation_report.csv'].map((f) => path.join(DATA, f)).filter(fs.existsSync);
  await fpage.setInputFiles('#file-input', files.concat([files[0]]));
  await fpage.waitForSelector('#header-meta strong');
  check((await fpage.textContent('#header-meta')).includes(sourcePeriod), 'file:// でもファイル選択で読み込める');
  check(/二重に選択/.test(await fpage.textContent('#banners')), '同一ファイルの二重選択を 1 件として扱い通知する');
  check(ferrors.length === 0, 'file:// でスクリプトエラーなし' + (ferrors.length ? ': ' + ferrors.join(' | ') : ''));

  await browser.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fail.length ? 'ブラウザ確認: NG (' + fail.length + '件)' : 'ブラウザ確認: すべて OK');
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
