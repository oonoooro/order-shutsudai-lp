/*
 * SharePoint で共有する Excel レポートの作成
 *
 * ダッシュボードと同じ集計・判定（core.js）の結果を、シートごとの表にして Excel ブックにする。
 * SharePoint に同じファイル名で上書き保存すれば、URL を変えずに毎週更新できる。
 * 閲覧者は Excel for the web の見出しの ▼ で絞り込める（TMK・担当者など物件マスターの列も各表に入れる）。
 * ブラウザでは window.LeasingReport、Node では require('./report-xlsx') で使う。
 */
(function (root, factory) {
  var mod = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.LeasingReport = mod;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var node = typeof module === 'object' && module.exports;
  var C = node ? require('./core') : root.LeasingCore;
  var W = node ? require('./xlsx-writer') : root.LeasingXlsxWriter;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function stamp(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

  function buildReport(model, period, config, opts) {
    opts = opts || {};
    var cfg = config, nl = cfg.display.nullLabel;
    var generatedAt = opts.generatedAt || new Date();
    period = period || model.period;
    var man = cfg.display.moneyUnit !== 'yen';
    var moneyUnit = man ? '万円' : '円';

    // ---------- セルの部品 ----------
    var none = function (label) { return { v: label || nl, s: 'muted' }; };
    var num = function (v, invalid, style) {
      if (invalid) return { v: cfg.display.invalidLabel, s: 'critical' };
      if (v === null || v === undefined) return none();
      return { v: v, s: style || 'int' };
    };
    var rate = function (v) { return v === null || v === undefined ? none() : { v: Math.round(v * 10000) / 10000, s: 'pct' }; };
    var pt = function (d, label) { return d === null || d === undefined ? none(label) : { v: Math.round(d * 1000) / 10, s: 'pt' }; };
    var money = function (yen, invalid) {
      if (invalid) return { v: cfg.display.invalidLabel, s: 'critical' };
      if (yen === null || yen === undefined) return none();
      return man ? { v: Math.round(yen / 1000) / 10, s: 'dec1' } : { v: yen, s: 'int' };
    };
    var text = function (v) { return v === null || v === undefined || v === '' ? none() : v; };
    var conf = function (c) {
      return c === 'high' ? { v: '高（high）', s: 'good' } : c === 'medium' ? { v: '中（medium）', s: 'warning' } : c === 'low' ? { v: '低（low）', s: 'critical' } : none();
    };
    var head = function (cols) { return cols.map(function (c) { return { v: c, s: 'header' }; }); };

    // 物件の名称と、物件マスターの追加列（TMK・担当者など）
    var extraCols = model.master.extraColumns || [];
    var masterOf = function (key) { return key ? model.master.byKey[key] || null : null; };
    var recOf = {};
    C.recordsForPeriod(model, period).forEach(function (r) { if (r.key && !recOf[r.key]) recOf[r.key] = r; });
    var nameOf = function (key) {
      var m = masterOf(key), r = recOf[key];
      return (m && (m.property_name_ja || m.project_name)) || (r && (C.displayName(r, 'property_name_ja') || C.displayName(r, 'project_name'))) || nl;
    };
    var extraOf = function (key) { var m = masterOf(key); return extraCols.map(function (c) { return text(m ? m.extra[c] : null); }); };
    var propCols = ['Project #', '日本語物件名'].concat(extraCols);
    var propCells = function (key) { return [text(key), nameOf(key)].concat(extraOf(key)); };

    var all = C.recordsForPeriod(model, period);
    var prevP = C.previousPeriod(model, period);
    var prevAll = prevP ? C.recordsForPeriod(model, prevP) : [];
    var s = C.summarize(all, prevAll, model, cfg);
    var alerts = C.computeAlerts(model, period, cfg);
    var ua = C.computeUnitActivity(model, period, cfg);
    var pd = C.parseDateValue(C.formatPeriod(period) || '').value;
    var sheets = [];

    function table(name, cols, rows, widths, extra) {
      var sh = { name: name, rows: [head(cols)].concat(rows.length ? rows : [[none('該当なし')]]), widths: widths, freezeRows: 1 };
      sh.autoFilter = 'A1:' + W.colName(cols.length) + Math.max(2, rows.length + 1);
      Object.keys(extra || {}).forEach(function (k) { sh[k] = extra[k]; });
      sheets.push(sh);
      return sh;
    }
    var widthsFor = function (n, base) { var w = []; for (var i = 0; i < n; i++) w.push(base[i] || 14); return w; };
    var propW = [12, 28].concat(extraCols.map(function () { return 14; }));

    // ---------- サマリー ----------
    var d = s.delta;
    var wow = function (f, isRate) {
      if (!prevP) return none('前週データなし');
      if (!d || d[f] === null || d[f] === undefined) return none();
      return isRate ? pt(d[f]) : { v: d[f], s: 'int' };
    };
    var units = function (r) { return r.value === null ? none() : { v: r.value, s: 'int' }; };
    var missing = C.missingProperties(model, period);
    var meta = model.meta;
    var sum = [
      [{ v: '週次リーシングダッシュボード', s: 'title' }],
      [{ v: '対象週', s: 'bold' }, C.formatPeriod(period) + (meta.source_period ? '（source_period: ' + meta.source_period + '）' : '')],
      [{ v: 'レポート日', s: 'bold' }, text(meta.report_date)],
      [{ v: '作成日時', s: 'bold' }, stamp(generatedAt)],
      [{ v: 'ファイル（処理 / 想定 / 失敗）', s: 'bold' }, C.fmtCount(meta.file_count_processed, cfg) + ' / ' + C.fmtCount(meta.file_count_expected, cfg) + ' / ' + C.fmtCount(meta.file_count_failed, cfg)],
      [{ v: '集計の状態', s: 'bold' }, s.provisional ? { v: '暫定（' + s.provisionalReasons.join('、') + '）', s: 'warning' } : { v: '確定', s: 'good' }],
      [],
      head(['項目', '値', '前週比', '注記']),
      ['対象物件数', { v: s.propertyCount.value, s: 'int' }, wow('propertyCount'), model.master.entries.length ? 'マスター ' + model.master.entries.length + '物件中 ' + missing.length + '物件はデータなし' : ''],
      ['総戸数（戸）', units(s.total_units), wow('total_units'), s.total_units.missing ? s.total_units.missing + '物件データなし' : ''],
      ['稼働戸数（戸）', units(s.occupied_units), wow('occupied_units'), s.occupied_units.missing ? s.occupied_units.missing + '物件データなし' : ''],
      ['空室戸数（戸）', units(s.vacant_units), wow('vacant_units'), s.vacant_units.missing ? s.vacant_units.missing + '物件データなし' : ''],
      ['申込戸数（戸）', units(s.application_units), wow('application_units'), ''],
      ['契約予定戸数（戸）', units(s.scheduled_contract_units), wow('scheduled_contract_units'), ''],
      ['解約予定戸数（戸）', units(s.scheduled_termination_units), wow('scheduled_termination_units'), ''],
      ['ポートフォリオ稼働率', rate(s.occupancy.value), wow('occupancy', true), s.occupancy.value === null ? '算出対象なし' : '稼働 ÷ 総戸数（' + s.occupancy.count + '物件）'],
      ['申込反映後稼働率', rate(s.afterApplication.value), wow('afterApplication', true), s.afterApplication.value === null ? '算出対象なし' : '(稼働＋申込) ÷ 総戸数（' + s.afterApplication.count + '物件）' + (s.afterApplication.count !== s.occupancy.count ? '。稼働率とは対象物件が異なります' : '')],
      [],
      head(['今週の住戸の動き', '件数', ua.windowText || '', '']),
      ['長期空室の住戸（' + cfg.alerts.longVacancyDays + '日以上）', ua.unitCount ? { v: ua.longVacancy.length, s: 'int' } : none(), '', '「長期空室」シート'],
      ['新規申込', ua.unitCount ? { v: ua.newApplications.length, s: 'int' } : none(), '', '「申込・解約」シート'],
      ['申込取消', ua.unitCount ? { v: ua.cancellations.length, s: 'int' } : none(), '', '「申込・解約」シート'],
      ['新規解約', ua.unitCount ? { v: ua.newNotices.length, s: 'int' } : none(), '', '「申込・解約」シート'],
      ['賃料条件の変更', ua.unitCount ? { v: ua.conditionChanges.length, s: 'int' } : none(), '', '「条件変更」シート'],
      ['リノベ・原状回復中', ua.unitCount ? { v: ua.works.filter(function (w) { return !w.completed; }).length, s: 'int' } : none(), '', '「工事」シート'],
      [],
      [{ v: 'このファイルは週報から自動で作成しています。直接編集しても、翌週の取込で上書きされます。', s: 'note' }],
      [{ v: '「' + nl + '」は値が取得できなかったものです（0 ではありません）。比率は小数第1位、金額は' + moneyUnit + '。', s: 'note' }],
      [{ v: '各シートの見出しの ▼ で絞り込みできます（' + (['Project #'].concat(extraCols).join('・')) + ' など）。', s: 'note' }]
    ];
    sheets.push({ name: 'サマリー', rows: sum, widths: [34, 30, 14, 60] });

    // ---------- 物件一覧（マスターにあってデータのない物件も含める） ----------
    var vr = {};
    C.vacancyRanking(model, period, all).forEach(function (x) { vr[x.project_number] = x; });
    var listCols = propCols.concat(['Project Name', 'SPC', 'AM', 'PM', '総戸数', '稼働戸数', '空室戸数', '稼働率', '空室率', '空室率 前週差', '申込戸数', '申込件数', '解約予定戸数', '前週からの主要変化', 'データ確度', 'アラート', '検証']);
    var listRows = all.slice().sort(function (a, b) { return String(a.key).localeCompare(String(b.key), 'ja', { numeric: true }); }).map(function (r) {
      var v = r.values, inv = r.invalid, x = vr[r.key] || {};
      var checks = [];
      if (r.duplicate) checks.push('重複候補');
      if (!r.linked) checks.push('マスター未登録');
      if (r.hasInvalid) checks.push('数値不正');
      if (r.checks.some(function (c) { return /mismatch/.test(c.type); })) checks.push('不一致');
      var al = alerts.byProject[r.key] || [];
      return propCells(r.key).concat([
        text(C.displayName(r, 'project_name')), text(C.displayName(r, 'spc')), text(C.displayName(r, 'am')), text(C.displayName(r, 'pm')),
        num(v.total_units, inv.total_units), num(v.occupied_units, inv.occupied_units), num(v.vacant_units, inv.vacant_units),
        rate(r.occupancy), rate(x.rate === undefined ? null : x.rate), pt(x.delta === undefined ? null : x.delta, prevP ? nl : '前週データなし'),
        num(v.application_units, inv.application_units), num(v.application_count, inv.application_count), num(v.scheduled_termination_units, inv.scheduled_termination_units),
        { v: r.text.major_change_from_previous_week || '', s: 'wrap' }, conf(r.confidence),
        al.length ? { v: al.filter(function (a, i) { return al.indexOf(a) === i; }).join('・'), s: 'warning' } : '',
        checks.length ? { v: checks.join('・'), s: 'critical' } : ''
      ]);
    });
    missing.forEach(function (e) {
      var row = propCells(e.key).concat([text(e.project_name), text(e.spc), text(e.am), text(e.pm)]);
      for (var i = 0; i < 9; i++) row.push(none());
      row.push('', none(), '', { v: 'この週のデータなし', s: 'warning' });
      listRows.push(row);
    });
    var occCol = W.colName(propCols.length + 8);
    table('物件一覧', listCols, listRows, widthsFor(listCols.length, propW.concat([14, 12, 12, 12, 9, 9, 9, 10, 10, 12, 9, 9, 11, 36, 12, 24, 18])),
      { dataBars: listRows.length ? [{ ref: occCol + '2:' + occCol + (listRows.length + 1), min: 0, max: 1, color: 'FF2A78D6' }] : [] });

    // ---------- 空室率 ----------
    var vrRows = C.vacancyRanking(model, period, all).map(function (x) {
      var r = x.record;
      return propCells(x.project_number).concat([rate(x.rate), rate(x.prevRate), pt(x.delta, prevP ? nl : '前週データなし'),
        x.delta !== null && x.delta > 0 ? { v: '上昇', s: 'critical' } : '', num(r.values.vacant_units, r.invalid.vacant_units), num(r.values.total_units, r.invalid.total_units)]);
    });
    var vrCol = W.colName(propCols.length + 1);
    table('空室率', propCols.concat(['空室率', '前週', '前週差', '上昇', '空室戸数', '総戸数']), vrRows, widthsFor(propCols.length + 6, propW.concat([10, 10, 10, 8, 10, 10])),
      { dataBars: vrRows.length ? [{ ref: vrCol + '2:' + vrCol + (vrRows.length + 1), min: 0, color: 'FFEB6834' }] : [] });

    // ---------- 住戸の動き ----------
    var unitInfo = function (u) { return [text(u.unit_number), text(u.text && u.text.layout), text(u.status ? C.UNIT_STATUS_LABELS[u.status] : null)]; };
    var workText = function (u) {
      if (!u.work_type) return '';
      return C.WORK_TYPE_LABELS[u.work_type] + (u.dateText.work_completed_date ? '（完了 ' + u.dateText.work_completed_date + '）' : u.dateText.work_end_date ? '（完了予定 ' + u.dateText.work_end_date + '）' : '（完了予定日データなし）');
    };
    var lvRows = ua.vacancyList.map(function (x) {
      var u = x.unit;
      return propCells(x.project_number).concat(unitInfo(u), [{ v: x.days, s: 'int' }, x.days >= cfg.alerts.longVacancyDays ? { v: '長期', s: 'critical' } : '',
        text(u.dateText.vacancy_start_date || (x.basis === 'source' ? '元データの日数' : null)), money(u.values.asking_rent, u.invalid.asking_rent), workText(u)]);
    });
    var dayCol = W.colName(propCols.length + 4);
    table('長期空室', propCols.concat(['住戸', '間取り', '状態', '空室日数', '長期', '空室開始日', '募集賃料（' + moneyUnit + '）', '工事']), lvRows,
      widthsFor(propCols.length + 8, propW.concat([8, 8, 16, 10, 7, 12, 14, 34])),
      { dataBars: lvRows.length ? [{ ref: dayCol + '2:' + dayCol + (lvRows.length + 1), min: 0, color: 'FFEB6834' }] : [] });

    var basis = function (b) { return b === 'status' ? '前週からの状態変化' : b === 'diff' ? '前週シートとの差分' : b === 'source' ? '週報の記載' : '日付'; };
    var evRows = [];
    var pushEv = function (kind, style, list, withMove) {
      list.forEach(function (x) {
        evRows.push([{ v: kind, s: style }].concat(propCells(x.project_number), [text(x.unit_number), text(x.unit && x.unit.text && x.unit.text.layout),
          text(x.date), withMove ? text(x.moveOut) : '', basis(x.basis), x.unit && x.unit.text && x.unit.text.unit_note ? x.unit.text.unit_note : '']));
      });
    };
    pushEv('新規申込', 'good', ua.newApplications, false);
    pushEv('申込取消', 'critical', ua.cancellations, false);
    pushEv('新規解約', 'warning', ua.newNotices, true);
    table('申込・解約', ['種別'].concat(propCols, ['住戸', '間取り', '日付', '退去予定日', '判定根拠', '備考']), evRows,
      widthsFor(propCols.length + 7, [10].concat(propW, [8, 8, 12, 12, 18, 30])));

    var chRows = [];
    ua.conditionChanges.forEach(function (x) {
      x.changes.forEach(function (c) {
        if (c.text !== undefined) {
          chRows.push(propCells(x.project_number).concat([text(x.unit_number), c.label, '', { v: c.text || nl, s: 'wrap' }, '', basis(x.basis)]));
          return;
        }
        var fmt = function (v) { return c.money ? money(v) : num(v, false, 'dec1'); };
        chRows.push(propCells(x.project_number).concat([text(x.unit_number), c.label + (c.money ? '（' + moneyUnit + '）' : ''), fmt(c.from), fmt(c.to),
          c.money ? money(c.to - c.from) : '', '前週の住戸明細との比較']));
      });
    });
    table('条件変更', propCols.concat(['住戸', '項目', '変更前', '変更後', '差', '判定根拠']), chRows, widthsFor(propCols.length + 6, propW.concat([8, 22, 12, 30, 10, 22])));

    var wkRows = ua.works.map(function (x) {
      var st = x.completed ? { v: '完了', s: 'good' } : x.overdue ? { v: '完了予定超過', s: 'critical' } : x.daysLeft === null ? none('完了予定日データなし') : '工事中';
      return propCells(x.project_number).concat([text(x.unit_number), text(x.unit.text.layout), C.WORK_TYPE_LABELS[x.type], text(x.start), text(x.end), text(x.completed),
        x.daysLeft === null ? none() : { v: x.daysLeft, s: 'int' }, st, text(x.unit.status ? C.UNIT_STATUS_LABELS[x.unit.status] : null)]);
    });
    table('工事', propCols.concat(['住戸', '間取り', '工事', '開始', '完了予定', '完了日', '残り日数', '状況', '募集状況']), wkRows,
      widthsFor(propCols.length + 9, propW.concat([8, 8, 14, 12, 12, 12, 10, 14, 16])));

    // ---------- アラート・対応事項 ----------
    var alRows = [];
    alerts.categories.forEach(function (cat) {
      cat.items.forEach(function (it) {
        alRows.push([cat.label].concat(it.project_number ? propCells(it.project_number) : [none('—'), none('—')].concat(extraCols.map(function () { return ''; })),
          [text(it.unit_number || ''), { v: it.message || '', s: 'wrap' }, it.file_name || '', it.fromSource ? '元データの通知' : '']));
      });
      if (!cat.items.length && !cat.judgeable) alRows.push([cat.label].concat([none('—'), none('—')], extraCols.map(function () { return ''; }), ['', none(cfg.display.notJudgedLabel + '（' + (cat.note || '') + '）'), '', '']));
    });
    table('アラート', ['区分'].concat(propCols, ['住戸', '内容', 'ファイル', '備考']), alRows, widthsFor(propCols.length + 5, [16].concat(propW, [8, 60, 30, 14])));

    var acts = model.actionItems || [];
    if (acts.length) {
      var acRows = acts.map(function (a) {
        var overdue = !a.done && a.due_day !== null && pd !== null && a.due_day < pd;
        return (a.project_key ? propCells(a.project_key) : [none('未紐付け'), text(a.property_label)].concat(extraCols.map(function () { return ''; }))).concat([
          text(a.category), text(a.due_date), overdue ? { v: '期限超過', s: 'critical' } : '', text(a.priority),
          a.done ? { v: a.status, s: 'good' } : { v: a.status || nl, s: 'warning' }, { v: a.action || '', s: 'wrap' }, { v: a.latest_update || '', s: 'wrap' }]);
      });
      table('対応事項', propCols.concat(['対応事項', '期日', '期限超過', '優先度', '状況', '対応内容', '最新状況']), acRows, widthsFor(propCols.length + 7, propW.concat([28, 12, 10, 8, 14, 36, 36])));
    }

    // ---------- データ検証 ----------
    var flag = function (v) { return v === 'yes' ? 'あり' : v === 'no' ? 'なし' : '未判定'; };
    var res = { success: '正常', partial: '一部読取', failed: '読取失敗', unknown: '不明' };
    var fRows = model.files.map(function (f) {
      var r = f.report;
      return [f.file_name, { v: res[f.result] || f.result, s: f.result === 'success' ? 'good' : f.result === 'failed' ? 'critical' : 'warning' },
        r && r.target_property ? r.target_property : none('未紐付け'), r ? num(r.extracted_count, r.extracted_count_invalid) : none(),
        r && r.unreadable_items ? { v: r.unreadable_items, s: 'wrap' } : '', r ? flag(r.duplicate_flag) : none(), r ? flag(r.numeric_mismatch_flag) : none(),
        conf(r ? r.confidence : null), r && r.reason ? { v: r.reason, s: 'wrap' } : ''];
    });
    table('データ検証', ['ファイル名', '処理結果', '対象物件', '抽出項目数', '読取不能項目', '重複の可能性', '数値不一致', 'データ確度', '要確認理由'], fRows,
      [44, 10, 10, 10, 36, 10, 10, 12, 60]);
    if (missing.length) {
      table('データのない物件', ['Project #', '日本語物件名', 'Project Name'].concat(extraCols), missing.map(function (e) {
        return [e.key, text(e.property_name_ja), text(e.project_name)].concat(extraCols.map(function (c) { return text(e.extra[c]); }));
      }), [12, 28, 16].concat(extraCols.map(function () { return 14; })));
    }

    var book = { title: '週次リーシングダッシュボード ' + C.formatPeriod(period), sheets: sheets };
    return { book: book, bytes: W.writeWorkbook(book, generatedAt), fileName: cfg.excelReportFileName || 'leasing_dashboard.xlsx' };
  }

  return { buildReport: buildReport };
});
