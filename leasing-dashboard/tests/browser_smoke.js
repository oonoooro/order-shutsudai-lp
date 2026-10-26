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

  // 週報 Excel（架空のフィクスチャ）をブラウザ内で解析して表示できること
  const xdir = path.join(__dirname, 'fixtures', 'weekly');
  fs.copyFileSync(path.join(DATA, 'dashboard_data.json'), path.join(tmp, 'dashboard_data.json'));
  const xpage = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const xerrors = [], xexternal = [];
  xpage.on('pageerror', (e) => xerrors.push(String(e)));
  xpage.on('request', (r) => { if (!r.url().startsWith(base) && !/^(data|blob|file):/.test(r.url())) xexternal.push(r.url()); });
  await xpage.goto(base);
  await xpage.waitForSelector('#header-meta strong');
  // 日本語のファイル名はパス指定だと渡らないことがあるため、名前と中身を直接渡す
  const payload = (p) => ({ name: path.basename(p), mimeType: 'application/octet-stream', buffer: fs.readFileSync(p) });
  await xpage.setInputFiles('#file-input', fs.readdirSync(xdir).map((f) => payload(path.join(xdir, f))).concat([payload(path.join(__dirname, 'fixtures', 'weekly_master.csv'))]));
  await xpage.waitForFunction(() => /20260111/.test(document.getElementById('header-meta').textContent), null, { timeout: 15000 });
  check(/ブラウザ内で解析/.test(await xpage.textContent('#banners')), '週報 Excel をブラウザ内で解析して表示できる');
  await xpage.click('.tab[data-tab="units"]');
  const unitsText = await xpage.textContent('#view-units');
  check(/前週シートとの差分で判定/.test(unitsText) && /501号室：礼金0ヶ月/.test(unitsText), '解析した住戸の動き（差分・条件変更の記載）を表示する');
  await xpage.click('.tab[data-tab="summary"]');
  check(/対応事項（Action Points/.test(await xpage.textContent('#view-summary')), '対応事項（Action Points）を表示する');
  if (SHOTS) {
    await xpage.screenshot({ path: path.join(SHOTS, 'excel_summary.png'), fullPage: true });
    await xpage.click('.tab[data-tab="units"]');
    await xpage.screenshot({ path: path.join(SHOTS, 'excel_units.png'), fullPage: true });
  }
  check(xerrors.length === 0, '週報 Excel の解析でスクリプトエラーなし' + (xerrors.length ? ': ' + xerrors.join(' | ') : ''));
  check(xexternal.length === 0, '週報 Excel の解析で外部通信なし' + (xexternal.length ? ': ' + xexternal.join(', ') : ''));

  // ドラッグ＆ドロップの流れ: 週報だけ → マスターだけ（再紐付け）→ 開き直しても残る → マスターの列で絞り込み
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const dpage = await ctx.newPage();
  const derrors = [];
  dpage.on('pageerror', (e) => derrors.push(String(e)));
  await dpage.goto(base);
  await dpage.waitForSelector('#header-meta strong');
  check(await dpage.isVisible('#dropzone'), 'ドラッグ＆ドロップの受付エリアを表示する');
  const xlsx = fs.readdirSync(xdir).filter((f) => /\.xlsx$/.test(f)).map((f) => payload(path.join(xdir, f)));
  await dpage.setInputFiles('#file-input', xlsx);
  await dpage.waitForFunction(() => /20260111/.test(document.getElementById('header-meta').textContent), null, { timeout: 15000 });
  const masterCsv = fs.readFileSync(path.join(__dirname, 'fixtures', 'weekly_master.csv'), 'utf8').trim().split('\n')
    .map((l, i) => l + ',' + (i === 0 ? 'TMK' : i === 3 ? '架空TMK2' : '架空TMK1')).join('\n') + '\n';
  await dpage.setInputFiles('#file-input', [{ name: 'property_master.csv', mimeType: 'text/csv', buffer: Buffer.from(masterCsv) }]);
  await dpage.waitForFunction(() => /紐付けし直しました/.test(document.getElementById('banners').textContent), null, { timeout: 15000 });
  await dpage.click('.tab[data-tab="list"]');
  check((await dpage.locator('#view-list tbody tr').count()) === 3, 'マスターだけをドロップすると、直前の週報を新しいマスターで紐付けし直す');
  check(await dpage.isVisible('#f-master select'), 'マスターの追加列（TMK）の絞り込みを表示する');
  await dpage.selectOption('#f-master select', '架空TMK2');
  check((await dpage.locator('#view-list tbody tr').count()) === 1, 'マスターの追加列（TMK）で物件を絞り込める');
  // SharePoint 用 Excel: 画面の絞り込みに関係なく全物件を書き出し、TMK 列を含む
  const [dl] = await Promise.all([dpage.waitForEvent('download'), dpage.click('#btn-excel')]);
  const cfgName = require('../config').excelReportFileName;
  check(dl.suggestedFilename() === cfgName, 'Excel を固定のファイル名（' + cfgName + '）で保存する');
  const wb = await require('../xlsx').readWorkbook(new Uint8Array(fs.readFileSync(await dl.path())), { inflateRaw: (b) => require('zlib').inflateRawSync(b) });
  const ls = wb.sheet('物件一覧');
  const heads = []; for (let c = 1; c <= ls.maxCol; c++) heads.push(ls.value(1, c));
  check(heads.includes('TMK') && ls.maxRow - 1 === 3, 'Excel の物件一覧に全物件（3件）と TMK 列が入る');
  // data/ に dashboard_data.json がない状態で開き直すと、ブラウザに保存した取込結果を表示する
  await dpage.waitForSelector('body[data-saved]', { timeout: 15000 });
  fs.renameSync(path.join(tmp, 'dashboard_data.json'), path.join(tmp, 'dashboard_data.json.bak'));
  await dpage.reload();
  await dpage.waitForFunction(() => /20260111/.test(document.getElementById('header-meta').textContent), null, { timeout: 15000 });
  check(/ブラウザに保存した取込結果/.test(await dpage.textContent('#banners')), '開き直しても、ブラウザに保存した取込結果を表示する');
  fs.renameSync(path.join(tmp, 'dashboard_data.json.bak'), path.join(tmp, 'dashboard_data.json'));
  check(derrors.length === 0, 'ドラッグ＆ドロップの流れでスクリプトエラーなし' + (derrors.length ? ': ' + derrors.join(' | ') : ''));
  if (SHOTS) await dpage.screenshot({ path: path.join(SHOTS, 'dragdrop.png'), fullPage: false });
  await ctx.close();

  // Node.js のない PC の使い方: index.html を直接開いて週報をドロップ → 開き直しても残る
  const fctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const fp = await fctx.newPage();
  const ferr = [];
  fp.on('pageerror', (e) => ferr.push(String(e)));
  await fp.goto('file://' + path.join(__dirname, '..', 'index.html'));
  await fp.waitForSelector('#dropzone');
  await fp.setInputFiles('#file-input', fs.readdirSync(xdir).map((f) => payload(path.join(xdir, f))).concat([payload(path.join(__dirname, 'fixtures', 'weekly_master.csv'))]));
  await fp.waitForFunction(() => /20260111/.test(document.getElementById('header-meta').textContent), null, { timeout: 15000 });
  await fp.waitForSelector('body[data-saved]', { timeout: 15000 });
  await fp.reload();
  await fp.waitForFunction(() => /20260111/.test(document.getElementById('header-meta').textContent), null, { timeout: 15000 });
  check(/ブラウザに保存した取込結果/.test(await fp.textContent('#banners')), 'index.html を直接開いた場合も、ドロップした取込結果が開き直したあとに残る');
  check(ferr.length === 0, 'index.html を直接開いた場合にスクリプトエラーなし' + (ferr.length ? ': ' + ferr.join(' | ') : ''));
  // 自己診断ページ（Node.js なしでの確認用）
  const sp = await fctx.newPage();
  await sp.goto('file://' + path.join(__dirname, '..', 'selftest.html'));
  await sp.waitForSelector('body[data-result]', { timeout: 30000 });
  check((await sp.getAttribute('body', 'data-result')) === 'ok', '自己診断ページ（selftest.html）がすべて OK: ' + (await sp.textContent('#summary')));
  await fctx.close();

  await browser.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fail.length ? 'ブラウザ確認: NG (' + fail.length + '件)' : 'ブラウザ確認: すべて OK');
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
