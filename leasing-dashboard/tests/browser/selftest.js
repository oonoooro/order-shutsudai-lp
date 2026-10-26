/*
 * 自己診断（ブラウザで実行するテスト）
 *
 * Node.js がない PC でも、selftest.html をブラウザで開くだけで主要なルールを確認できる。
 * Copilot でコードを変更したあとに開き、すべて OK になることを確認する。データはすべて架空。
 */
(function () {
  'use strict';

  var C = window.LeasingCore, CFG = window.DASHBOARD_CONFIG, I = window.LeasingIngest, F = window.SELFTEST_FIXTURES;
  var X = window.LeasingXlsx, REP = window.LeasingReport;
  var checks = [];
  function check(group, name, fn) { checks.push({ group: group, name: name, fn: fn }); }
  function eq(a, b, msg) {
    var sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) throw new Error((msg ? msg + ': ' : '') + '期待 ' + sb + ' / 実際 ' + sa);
  }
  function ok(v, msg) { if (!v) throw new Error(msg || '条件を満たしません'); }
  function near(a, b, msg) { if (typeof a !== 'number' || Math.abs(a - b) > 1e-9) throw new Error((msg || '') + ' 期待 ' + b + ' / 実際 ' + a); }

  // 架空データの部品
  var MASTER = 'project_number,project_name,property_name_ja,property_name_en,spc,am,pm,master_source\nT-001,Test,テスト物件0,Test,S,A,P,x\nT-002,Test2,テスト物件1,Test2,S,A,P,x\n';
  function rec(o) {
    var r = { report_date: '2026-01-12', project_number: 'T-001', total_units: 10, occupied_units: 9, vacant_units: 1, application_units: 1,
      occupancy_rate_source: 0.9, occupancy_rate_calculated: 0.9, occupancy_after_application_calculated: 1, data_confidence: 'high' };
    Object.keys(o || {}).forEach(function (k) { r[k] = o[k]; });
    return r;
  }
  function data(props, extra) {
    var d = { report_metadata: { report_date: '2026-01-12', source_period: '20260112' }, portfolio_summary: { status: 'calculated' }, properties: props };
    Object.keys(extra || {}).forEach(function (k) { d[k] = extra[k]; });
    return d;
  }
  function build(d, master) { return C.buildModel(d, master === undefined ? MASTER : master, null, CFG); }
  function issues(m, type) { return m.issues.filter(function (i) { return i.type === type; }); }

  // ---------- 表示ルール ----------
  check('表示', 'null は「データなし」、0 は「0」', function () {
    eq(C.fmtCount(null, CFG), 'データなし'); eq(C.fmtCount(0, CFG), '0');
    eq(C.fmtRate(null, CFG), 'データなし'); eq(C.fmtRate(0, CFG), '0.0%');
  });
  check('表示', '比率は小数第1位、金額は単位付き', function () {
    eq(C.fmtRate(0.91584, CFG), '91.6%');
    ok(/(万円|円)$/.test(C.fmtMoney(128000, CFG)), '金額に単位がありません');
  });

  // ---------- 検証 ----------
  check('検証', 'JSON構文エラーを検出する', function () {
    eq(C.loadAll({ dashboardDataText: '{ "a": ', propertyMasterText: null, validationReportText: null }, CFG).ok, false);
  });
  check('検証', 'Project # の重複を検出する', function () {
    eq(issues(build(data([rec(), rec()])), 'duplicate_record').length, 2);
  });
  check('検証', '物件マスターにない Project # を検出する', function () {
    eq(issues(build(data([rec({ project_number: 'X-9' })])), 'unknown_project').length, 1);
  });
  check('検証', '数値列への文字混入を検出し、値を使わない', function () {
    var m = build(data([rec({ total_units: '10戸' })]));
    eq(issues(m, 'numeric_type').length, 1);
    eq(m.records[0].values.total_units, null);
  });
  check('検証', '稼働＋空室と総戸数の不一致を検出する', function () {
    eq(issues(build(data([rec({ vacant_units: 2 })])), 'unit_sum_mismatch').length, 1);
  });
  check('検証', '稼働率の計算不一致（許容差 0.0001 超）を検出する', function () {
    ok(issues(build(data([rec({ occupancy_rate_source: 0.92 })])), 'rate_mismatch').length >= 1);
    eq(issues(build(data([rec({ occupancy_rate_source: 0.90005 })])), 'rate_mismatch').length, 0);
  });
  check('検証', '未知の列があっても読める（後方互換）', function () {
    var m = build(data([rec({ new_field_x: 1 })], { new_root_x: 1 }));
    eq(m.ok, true); eq(m.records[0].values.total_units, 10);
  });
  check('検証', '欠損を 0 にしない（全件 null の合計は null）', function () {
    var m = build(data([rec(), rec({ project_number: 'T-002' })]));
    eq(C.summarize(C.recordsForPeriod(m, m.period), [], m, CFG).scheduled_contract_units.value, null);
  });

  // ---------- 集計・住戸・マスター ----------
  check('集計', 'ポートフォリオ稼働率 = 稼働の合計 ÷ 総戸数の合計', function () {
    var m = build(data([rec(), rec({ project_number: 'T-002', total_units: 20, occupied_units: 16, vacant_units: 4, occupancy_rate_source: 0.8, occupancy_rate_calculated: 0.8, occupancy_after_application_calculated: 0.85 })]));
    near(C.summarize(C.recordsForPeriod(m, m.period), [], m, CFG).occupancy.value, 25 / 30);
  });
  check('住戸', '前週「空室」→今週「申込あり」を新規申込として判定する', function () {
    var d = data([rec({ report_date: '2026-01-05' }), rec()], {
      units: [{ report_date: '2026-01-05', project_number: 'T-001', unit_number: '101', leasing_status: 'vacant' },
        { report_date: '2026-01-12', project_number: 'T-001', unit_number: '101', leasing_status: 'application' }]
    });
    var m = build(d);
    eq(C.computeUnitActivity(m, m.period, CFG).newApplications.length, 1);
  });
  check('マスター', 'マスターの追加列（TMK）で絞り込める', function () {
    var master = 'project_number,property_name_ja,TMK\nT-001,テスト物件0,架空1\nT-002,テスト物件1,架空2\n';
    var m = build(data([rec(), rec({ project_number: 'T-002' })]), master);
    eq(C.filterRecords(C.recordsForPeriod(m, m.period), { master: { TMK: '架空2' } }, null, CFG).map(function (r) { return r.key; }), ['T-002']);
  });
  check('マスター', '個人情報らしい列（連絡先）は読み込まない', function () {
    eq(C.loadMaster('project_number,property_name_ja,連絡先\n1,架空,03-0000-0000\n', CFG).extraColumns, []);
  });

  // ---------- 週報 Excel の解析 ----------
  function bytesOf(name) {
    var f = F.files.filter(function (x) { return x.name === name; })[0];
    var bin = atob(f.base64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  var builtPromise = null;
  function builtAll() {
    if (!builtPromise) {
      builtPromise = Promise.all(F.files.map(function (f) { return I.parseWorkbookFile({ name: f.name, bytes: bytesOf(f.name) }, { config: CFG }); }))
        .then(function (rs) { return I.buildDashboardData(rs, { config: CFG, masterText: F.master }); });
    }
    return builtPromise;
  }
  function prop(d, pn, date) { return d.properties.filter(function (p) { return p.project_number === pn && p.report_date === date; })[0]; }

  check('週報Excel', 'このブラウザで Excel を展開できる（DecompressionStream）', function () { ok(typeof DecompressionStream !== 'undefined', 'このブラウザは週報 Excel の読込に対応していません。最新の Edge または Chrome を使ってください'); });
  check('週報Excel', '様式A: 稼働・空室・週次件数を読み取る', function () {
    return builtAll().then(function (b) {
      var p = prop(b.data, '101', '2026-01-11');
      eq([p.total_units, p.vacant_units, p.occupied_units, p.inquiry_count, p.viewing_count], [9, 3, 6, 4, 3]);
    });
  });
  check('週報Excel', '様式B: 総戸数・案内件数・条件変更を読み取る', function () {
    return builtAll().then(function (b) {
      var p = prop(b.data, '102', '2026-01-11');
      eq([p.total_units, p.vacant_units, p.viewing_count], [20, 2, 4]);
      ok(b.data.unit_events.some(function (e) { return e.type === 'condition_change' && e.unit_number === '501'; }), '条件変更がありません');
    });
  });
  check('週報Excel', '様式C: 前週シートとの差分で今週の新規だけを拾う', function () {
    return builtAll().then(function (b) {
      var ev = b.data.unit_events.filter(function (e) { return e.project_number === '103'; }).map(function (e) { return e.type + ':' + e.unit_number; });
      eq(ev, ['application:103', 'application_cancel:104', 'notice:201']);
    });
  });
  check('週報Excel', '様式D: 対応事項として取り込み、数値に合算しない', function () {
    return builtAll().then(function (b) { eq(b.data.action_items.length, 3); });
  });
  check('週報Excel', '壊れたファイル・未知の様式は読取失敗として件数に残す', function () {
    return builtAll().then(function (b) { eq(b.data.report_metadata.file_count_failed, 2); eq(b.validationRows.length, 6); });
  });
  check('週報Excel', '申込者・契約者・保証会社・年収・メモを出力しない', function () {
    return builtAll().then(function (b) {
      var out = JSON.stringify(b.data) + b.validationCSV;
      ['架空太郎', '架空勤務先', '架空保証', '架空商事', '年収', '架空担当メモ'].forEach(function (s) { ok(out.indexOf(s) === -1, '「' + s + '」が出力に含まれています'); });
    });
  });
  check('週報Excel', 'ファイル名の物件名は区切られた位置だけで照合する', function () {
    var master = 'project_number,property_name_ja\n1,サンプル北町\n2,サンプル北町II\n3,サンプル駅前\n';
    var r = I.previewMapping(['【サンプル北町Ⅱ】週報.xlsx', 'リーシング報告書_(北町ガーデン).xlsx', '報告書_(サンプル駅前).xlsx'], master, null, CFG);
    eq(r.map(function (x) { return x.project_number; }), ['2', null, '3']);
  });

  // ---------- SharePoint 用 Excel ----------
  check('Excel出力', 'Excel レポートを書き出し、読み直すと値が一致する（TMK 列・データなし）', function () {
    var master = 'project_number,property_name_ja,TMK\nT-001,テスト物件0,架空1\nT-002,テスト物件1,架空2\n';
    var m = build(data([rec()]), master);
    var r = REP.buildReport(m, m.period, CFG, { generatedAt: new Date() });
    return X.readWorkbook(r.bytes).then(function (wb) {
      var sh = wb.sheet('物件一覧'), head = [], find = function (key) { for (var i = 2; i <= sh.maxRow; i++) if (sh.value(i, 1) === key) return i; return -1; };
      for (var c = 1; c <= sh.maxCol; c++) head.push(sh.value(1, c));
      eq(head.slice(0, 3), ['Project #', '日本語物件名', 'TMK']);
      eq(sh.value(find('T-001'), head.indexOf('総戸数') + 1), 10);
      eq(sh.value(find('T-001'), head.indexOf('TMK') + 1), '架空1');
      eq(sh.value(find('T-002'), head.indexOf('総戸数') + 1), CFG.display.nullLabel, 'データのない物件は 0 ではなく「データなし」');
    });
  });

  // ---------- 環境 ----------
  check('環境', 'ブラウザ内の保存（IndexedDB）が使える', function () {
    return new Promise(function (resolve, reject) {
      try {
        var req = indexedDB.open('leasing-dashboard-selftest', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
        req.onsuccess = function () { req.result.close(); resolve(); };
        req.onerror = function () { reject(new Error('IndexedDB を開けません（取込結果を保存できません）')); };
      } catch (e) { reject(new Error('IndexedDB が使えません（取込結果を保存できません）')); }
    });
  });

  // ---------- 実行と表示 ----------
  function run() {
    var tbody = document.getElementById('results'), summary = document.getElementById('summary');
    var pass = 0, fail = 0;
    var seq = Promise.resolve();
    checks.forEach(function (c) {
      seq = seq.then(function () {
        var tr = document.createElement('tr');
        [c.group, c.name, '実行中'].forEach(function (t) { var td = document.createElement('td'); td.textContent = t; tr.appendChild(td); });
        tbody.appendChild(tr);
        var cell = tr.lastChild;
        return Promise.resolve().then(c.fn).then(function () {
          pass++; cell.textContent = 'OK'; tr.className = 'ok';
        }, function (e) {
          fail++; cell.textContent = 'NG: ' + (e && e.message ? e.message : e); tr.className = 'ng';
        });
      });
    });
    seq.then(function () {
      summary.textContent = fail ? 'NG: ' + fail + '件の確認に失敗しました（全 ' + checks.length + '件）。失敗した内容を Copilot に伝えて修正してください。' : 'すべて OK（' + pass + '件）';
      summary.className = fail ? 'ng' : 'ok';
      document.body.setAttribute('data-result', fail ? 'ng' : 'ok');
    });
  }

  if (!C || !CFG || !I || !F || !X || !REP) {
    document.getElementById('summary').textContent = 'NG: 必要なファイル（config.js・core.js・xlsx.js・ingest.js・xlsx-writer.js・report-xlsx.js・tests/browser/selftest_fixtures.js）を読み込めませんでした。';
    document.body.setAttribute('data-result', 'ng');
    return;
  }
  run();
})();
