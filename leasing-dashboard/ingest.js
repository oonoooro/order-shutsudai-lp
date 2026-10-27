/*
 * 週報 Excel の解析・標準化
 *
 * PM ごとに異なる週報（様式 A〜D）を、見出しの文字で項目を特定して読み取り、
 * dashboard_data.json と validation_report.csv の形に揃える。
 *  - 行列位置を固定しない（見出し・ラベルを探す）
 *  - 空欄・0・未記載・不明を区別し、不明は null
 *  - 数式の計算結果がファイルにない場合は、生データから再計算し「再計算」と記録する
 *  - 週報・仲介営業・Action Points を無条件に合算しない
 *  - 期間別シートに再掲される履歴は前週シートとの差分で新規を判定する
 *  - 入居者・申込者・契約者・保証会社・仲介担当・年収等は出力しない
 *  - 元ファイルは読み取りのみ
 * ブラウザでは window.LeasingIngest、Node では require('./ingest') で使う。
 */
(function (root, factory) {
  var mod = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.LeasingIngest = mod;
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var X = typeof module === 'object' && module.exports ? require('./xlsx') : root.LeasingXlsx;
  var C = typeof module === 'object' && module.exports ? require('./core') : root.LeasingCore;

  var FORMAT_ROLES = { A: '週報型', B: '営業活動週報型', C: 'リーシング報告書型', D: 'Action Points型' };

  // ---------- 汎用 ----------

  function norm(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (typeof s.normalize === 'function') s = s.normalize('NFKC');
    return s.replace(/[\s　]+/g, '').toLowerCase();
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dayText(d) {
    if (d === null || d === undefined) return null;
    var dt = new Date(d * 86400000);
    return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
  }
  function dayKey(d) { return d === null ? null : dayText(d).replace(/-/g, ''); }
  function ymdToDay(y, m, d) {
    var t = Date.UTC(y, m - 1, d), dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return Math.round(t / 86400000);
  }
  // 日曜日を週末とする（0 = 日曜）。その日以前で直近の週末
  function weekEndOnOrBefore(day, weekEndDay) {
    var wd = ((day + 4) % 7 + 7) % 7;
    return day - ((wd - weekEndDay + 7) % 7);
  }

  // セル値 → 通算日。数値はシリアル値、文字列は 年/月/日 のみ（年のない「9/23」は推測しないため null）
  function toDay(v, date1904) {
    if (v === null || v === undefined || v === '') return { day: null };
    if (isNum(v)) {
      if (v < 20000 || v > 80000) return { day: null, invalid: true, raw: v };
      return { day: X.serialToDay(v, date1904) };
    }
    var s = norm(v);
    var m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(s);
    if (m) {
      var d = ymdToDay(Number(m[1]), Number(m[2]), Number(m[3]));
      return d === null ? { day: null, invalid: true, raw: v } : { day: d };
    }
    return { day: null, invalid: true, raw: v };
  }

  // セル値 → 数値。「-」「未定」等の文字は推測せず null（不正として記録）
  function toNumber(v) {
    if (v === null || v === undefined || v === '') return { value: null };
    if (isNum(v)) return { value: v };
    if (typeof v === 'boolean') return { value: null, invalid: true, raw: v };
    var s = String(v).trim();
    if (/^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(s)) return { value: Number(s.replace(/,/g, '')) };
    return { value: null, invalid: true, raw: v };
  }

  function roomNo(v) {
    if (v === null || v === undefined) return null;
    var s = norm(v).replace(/号室$/, '');
    if (isNum(v)) s = String(v);
    return /^[0-9a-z-]{1,8}$/.test(s) ? s.toUpperCase() : null;
  }

  function text(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    return s === '' ? null : s;
  }

  // シート内で正規化後の文字列が一致するセルを探す
  function findCells(sheet, label, opts) {
    opts = opts || {};
    var want = norm(label), out = [];
    var rows = Object.keys(sheet.rows).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (opts.minRow && r < opts.minRow) continue;
      if (opts.maxRow && r > opts.maxRow) break;
      var cols = Object.keys(sheet.rows[r]).map(Number).sort(function (a, b) { return a - b; });
      for (var j = 0; j < cols.length; j++) {
        var v = sheet.rows[r][cols[j]].v;
        if (typeof v !== 'string') continue;
        var n = norm(v);
        if (opts.startsWith ? n.indexOf(want) === 0 : n === want) out.push({ row: r, col: cols[j] });
      }
    }
    return out;
  }
  function findCell(sheet, label, opts) { return findCells(sheet, label, opts)[0] || null; }

  // ラベルの右にある最初の値
  function valueRightOf(sheet, pos, maxCols) {
    if (!pos) return { value: null };
    for (var c = pos.col + 1; c <= pos.col + (maxCols || 8); c++) {
      var cell = sheet.cell(pos.row, c);
      if (cell && (cell.v !== null || cell.f)) return { value: cell.v, col: c, formulaNoCache: cell.f && !cell.cached };
    }
    return { value: null };
  }

  // 見出し行を探す。defs: { key: [見出し候補...] }、required: 必須キー
  function findHeader(sheet, defs, required, opts) {
    opts = opts || {};
    var rows = Object.keys(sheet.rows).map(Number).sort(function (a, b) { return a - b; });
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (opts.minRow && r < opts.minRow) continue;
      if (opts.maxRow && r > opts.maxRow) break;
      var cells = sheet.rows[r], cols = Object.keys(cells).map(Number).sort(function (a, b) { return a - b; });
      var map = {};
      Object.keys(defs).forEach(function (key) {
        var names = defs[key].map(norm);
        for (var j = 0; j < cols.length; j++) {
          if (opts.minCol && cols[j] < opts.minCol) continue;
          if (opts.maxCol && cols[j] > opts.maxCol) continue;
          if (names.indexOf(norm(cells[cols[j]].v)) !== -1) { map[key] = cols[j]; break; }
        }
      });
      if (required.every(function (k) { return map[k] !== undefined; })) return { row: r, cols: map };
    }
    return null;
  }

  // 見出しの下のデータ行（キー列が空の行が gap 行続いたら終了）
  function dataRows(sheet, header, keyCol, opts) {
    opts = opts || {};
    var out = [], blank = 0, gap = opts.gap || 2;
    for (var r = header.row + 1; r <= sheet.maxRow; r++) {
      if (opts.stop && opts.stop(r)) break;
      var v = sheet.value(r, keyCol);
      if (v === null || v === '') { blank++; if (blank >= gap) break; continue; }
      blank = 0;
      out.push(r);
    }
    return out;
  }

  function cellOf(sheet, r, c) { return c === undefined ? null : sheet.cell(r, c); }

  // ---------- 様式判定 ----------

  var WEEK_SHEET_RE = /^(\d{4})\.(\d{1,2})\.(\d{1,2})-(\d{4})\.(\d{1,2})\.(\d{1,2})$/;

  function detectFormat(wb) {
    var names = wb.sheetNames.map(norm);
    var has = function (n) { return names.indexOf(norm(n)) !== -1; };
    if (has('list') && wb.sheet('List') && findCell(wb.sheet('List'), 'Target Due Date', { maxRow: 20 })) return 'D';
    var weekSheets = wb.sheetNames.filter(function (n) { return WEEK_SHEET_RE.test(norm(n)); });
    if (weekSheets.length && has('現募集中')) return 'C';
    var w = wb.sheet('週報');
    if (w) {
      if (findCell(w, '営業活動報告書', { maxRow: 10 }) || findCell(w, '【募集中・解約予定住戸】')) return 'B';
      if (findHeader(w, { st: ['現況'], room: ['部屋番号'] }, ['st', 'room'], { maxRow: 60 })) return 'A';
    }
    return null;
  }

  // ---------- 共通の出力部品 ----------

  function newResult(fileName, format) {
    return {
      file_name: fileName, format: format, role: format ? FORMAT_ROLES[format] : null,
      status: 'success', reason: null, warnings: [], unreadable: [], extracted: 0,
      property_label: null, weeks: [], units: [], unit_events: [], action_items: [], activity: [],
      confidence: 'high', include_in_numeric: format !== 'D'
    };
  }

  function unitBase(o) {
    var u = {
      unit_number: null, layout: null, floor_area_sqm: null, leasing_status: null,
      vacancy_start_date: null, application_date: null, application_cancel_date: null, notice_date: null, move_out_date: null,
      current_rent: null, asking_rent: null, common_fee: null, ad: null, fr: null, deposit_months: null, key_money_months: null,
      work_type: null, work_start_date: null, work_end_date: null, work_completed_date: null, unit_note: null, counts_as_vacant: null
    };
    Object.keys(o).forEach(function (k) { u[k] = o[k]; });
    return u;
  }

  function addNumber(res, label, cell, target, key) {
    if (!cell) { target[key] = null; return; }
    if (cell.f && !cell.cached) { target[key] = null; res.unreadable.push(label + '（数式の計算結果なし）'); return; }
    var n = toNumber(cell.v);
    if (n.invalid) res.warnings.push(label + 'に数値以外の値: ' + String(n.raw).slice(0, 20));
    target[key] = n.value;
    if (n.value !== null) res.extracted++;
  }

  function finishUnits(res, units) {
    units.forEach(function (u) { if (u.leasing_status !== null || u.vacancy_start_date !== null) res.extracted++; });
    res.units = units;
  }

  // 現況の件数から物件の戸数を組み立てる
  function countStatuses(units) {
    var c = { vacant: 0, application: 0, contracted: 0, occupied: 0, notice: 0, unknown: 0 };
    units.forEach(function (u) { if (u.leasing_status && c[u.leasing_status] !== undefined) c[u.leasing_status]++; else c.unknown++; });
    return c;
  }

  // ---------- 様式 A（週報型） ----------

  var A_STATUS = {
    '空室': { s: 'vacant' }, '原復中': { s: 'vacant', work: 'restoration' }, '申込': { s: 'application' },
    '解約予定': { s: 'notice' }, '契約済': { s: 'contract' }, '募集止め': { s: 'vacant', note: '募集止め' }, 'fr': { s: 'occupied', note: 'フリーレント期間中' }
  };

  function parseA(wb, res, opt) {
    var w = wb.sheet('週報');
    var base = findCell(w, '基準日', { maxRow: 20 });
    var bv = valueRightOf(w, base, 4);
    var rd = toDay(bv.value, wb.date1904);
    if (rd.day === null) { res.status = 'failed'; res.reason = '基準日を読み取れません'; return; }
    var reportDay = rd.day, weekEnd = weekEndOnOrBefore(reportDay, opt.weekEndDay);
    var info = wb.sheet('基本情報');
    if (info) {
      var nm = findCell(info, '物件名', { maxRow: 10 });
      res.property_label = text(valueRightOf(info, nm, 4).value);
    }

    var hdr = findHeader(w, {
      status: ['現況'], room: ['部屋番号'], layout: ['間取り'], area_sqm: ['貸室面積(㎡)'], cancel: ['解約日'], moveout: ['退去日'],
      restored: ['原復完了'], prev_rent: ['従前賃料(共込)', '従前賃料'], asking: ['募集賃料'], fee: ['管理費'], deposit: ['敷金'], key: ['礼金'],
      fr: ['FR'], ad: ['AD'], app_date: ['申込日'], rent_start: ['賃料発生日'], rent: ['賃料']
    }, ['status', 'room'], { maxRow: 80 });
    if (!hdr) { res.status = 'failed'; res.reason = '住戸明細の見出し（現況・部屋番号）が見つかりません'; return; }
    var H = hdr.cols;
    var rows = dataRows(w, hdr, H.room, { gap: 2 });
    var units = [], unknownStatus = 0;
    rows.forEach(function (r) {
      var get = function (k) { return H[k] === undefined ? null : w.value(r, H[k]); };
      var dt = function (k) { var d = toDay(get(k), wb.date1904); if (d.invalid) res.warnings.push('週報 ' + r + '行目「' + k + '」が日付として読めません'); return d.day; };
      var num = function (k) { var n = toNumber(get(k)); if (n.invalid) res.warnings.push('週報 ' + r + '行目の数値列に文字: ' + String(n.raw).slice(0, 20)); return n.value; };
      var no = roomNo(get('room'));
      if (!no) return;
      var label = norm(get('status'));
      var st = A_STATUS[label];
      var u = unitBase({ unit_number: no, floor_area_sqm: num('area_sqm') });
      var cancel = dt('cancel'), moveout = dt('moveout'), restored = dt('restored'), appd = dt('app_date'), rentStart = dt('rent_start');
      if (!st) {
        if (text(get('status'))) res.warnings.push('週報 ' + r + '行目の現況「' + text(get('status')) + '」は未定義の区分です');
        unknownStatus++;
      } else {
        var s = st.s;
        // シートの As-is 稼働率で空室に数える区分（空室・原復中・申込）
        u.counts_as_vacant = ['空室', '原復中', '申込'].indexOf(label) !== -1;
        // 契約済は賃料発生日が基準日より後なら入居待ち、それ以外は入居中
        if (s === 'contract') s = rentStart !== null && rentStart > reportDay ? 'contracted' : 'occupied';
        u.leasing_status = s;
        if (st.note) u.unit_note = st.note;
        if (st.work) { u.work_type = st.work; u.work_end_date = dayText(restored); }
      }
      if (u.leasing_status === 'vacant' || u.leasing_status === 'application' || u.leasing_status === 'contracted') {
        // シートの空室日数の数式（基準日 − 解約日）に合わせ、解約日を空室開始日とする。なければ退去日
        u.vacancy_start_date = dayText(cancel !== null ? cancel : moveout);
        if (!u.work_type && restored !== null) {
          u.work_type = 'restoration';
          if (restored <= reportDay) u.work_completed_date = dayText(restored); else u.work_end_date = dayText(restored);
        }
      }
      if (u.leasing_status === 'notice') u.move_out_date = dayText(moveout !== null ? moveout : cancel);
      if (u.leasing_status === 'application' || u.leasing_status === 'contracted') u.application_date = dayText(appd);
      u.asking_rent = num('asking'); u.common_fee = num('fee'); u.deposit_months = num('deposit'); u.key_money_months = num('key');
      u.fr = num('fr'); u.ad = num('ad');
      if (u.leasing_status === 'occupied' || u.leasing_status === 'contracted') u.current_rent = num('rent');
      units.push(u);
    });
    if (unknownStatus) res.warnings.push('現況が空欄・未定義の住戸 ' + unknownStatus + '件（集計対象外）');

    // 間取り・面積は基本情報の部屋一覧から補う
    var rooms = null;
    if (info) {
      var ih = findHeader(info, { room: ['部屋番号'], use: ['用途'], layout: ['間取り'], sqm: ['貸室面積(㎡)'] }, ['room'], { maxRow: 30 });
      if (ih) {
        rooms = {};
        dataRows(info, ih, ih.cols.room, { gap: 3 }).forEach(function (r) {
          var no = roomNo(info.value(r, ih.cols.room));
          if (!no) return;
          rooms[no] = { layout: text(info.value(r, ih.cols.layout)), sqm: toNumber(info.value(r, ih.cols.sqm)).value, use: text(info.value(r, ih.cols.use)) };
        });
      }
    }
    units.forEach(function (u) {
      var rm = rooms && rooms[u.unit_number];
      if (rm) { if (!u.layout) u.layout = rm.layout; if (u.floor_area_sqm === null) u.floor_area_sqm = rm.sqm; }
    });

    // 戸数: 基本情報の部屋数（シートの Unit 数 = COUNT(部屋番号) と同じ定義）
    var c = countStatuses(units);
    var total = rooms ? Object.keys(rooms).length : null;
    if (total === null) { total = units.length; res.unreadable.push('基本情報（総戸数を住戸明細の行数で代用）'); }
    else if (total !== units.length) res.warnings.push('基本情報の部屋数（' + total + '）と週報の住戸明細の行数（' + units.length + '）が一致しません');
    var asIsVacant = units.filter(function (u) { return u.counts_as_vacant === true; }).length;
    var vals = {
      total_units: total,
      // シートの As-is 稼働率の定義: 1 − (空室 + 原復中 + 申込) / 総数（募集止め・契約済・FR は空室に数えない）
      vacant_units: c.unknown ? null : asIsVacant,
      application_units: c.application,
      scheduled_termination_units: c.notice,
      scheduled_contract_units: c.contracted
    };
    vals.occupied_units = vals.vacant_units === null ? null : total - vals.vacant_units;
    addCounts(res, w, wb, reportDay, opt, vals);
    pushWeek(res, weekEnd, reportDay, vals, {
      formula: '稼働 = 総戸数 − (空室 + 原復中 + 申込)（週報シートの As-is 稼働率の定義。数式の計算結果がファイルにないため住戸明細から再計算）',
      afterApplicationPermitted: true, sheet: '週報'
    });
    res.unreadable.push('稼働率・集計欄（数式の計算結果なし。住戸明細から再計算）');
    res.confidence = 'medium';
    finishUnits(res, units.map(function (u) { u.report_date = dayText(weekEnd); return u; }));

    // リーシング活動・条件変更（今週分）
    var act = findHeader(w, { date: ['実施日'], body: ['変更内容等'] }, ['date', 'body']);
    if (act) {
      dataRows(w, act, act.cols.date, { gap: 3 }).forEach(function (r) {
        var d = toDay(w.value(r, act.cols.date), wb.date1904).day;
        if (d !== null && d > weekEnd - 7 && d <= weekEnd) res.activity.push({ date: dayText(d), text: text(w.value(r, act.cols.body)) });
      });
    }
  }

  // 週次の件数（問合せ・案内・申込・キャンセル）。日付列から基準週の列を選ぶ
  function addCounts(res, w, wb, reportDay, opt, vals) {
    var labels = { inquiry_count: '問合せ', viewing_count: '案内', application_count: '申込', application_cancel_count: 'キャンセル' };
    var acc = findCell(w, '累計');
    Object.keys(labels).forEach(function (k) { vals[k] = null; });
    if (!acc) { res.unreadable.push('週次件数（累計の見出しなし）'); return; }
    var weekEnd = weekEndOnOrBefore(reportDay, opt.weekEndDay), col = null;
    for (var cc = acc.col + 1; cc <= w.maxCol; cc++) {
      var d = toDay(w.value(acc.row, cc), wb.date1904).day;
      if (d !== null && d > weekEnd - 7 && d <= weekEnd) col = cc;
    }
    if (col === null) { res.unreadable.push('週次件数（基準週の列なし）'); return; }
    Object.keys(labels).forEach(function (k) {
      var pos = findCell(w, labels[k], { minRow: acc.row + 1, maxRow: acc.row + 8 });
      if (pos) addNumber(res, labels[k] + '件数', w.cell(pos.row, col), vals, k);
    });
  }

  function pushWeek(res, weekEnd, reportDay, vals, meta) {
    res.weeks.push({ week_end: weekEnd, report_day: reportDay, values: vals, formula: meta.formula, afterApplicationPermitted: !!meta.afterApplicationPermitted, sheet: meta.sheet });
  }

  // ---------- 様式 B（営業活動週報型） ----------

  var B_STATUS = { '空室': 'vacant', '募集中': 'vacant', '申込': 'application', '申込中': 'application', '審査中': 'application', '審査ok': 'application', '契約済': 'contracted', '解約予定': 'notice' };

  function parseB(wb, res, opt) {
    var w = wb.sheet('週報');
    var dh = findHeader(w, { date: ['日付'], dow: ['曜日'], view: ['案内件数'], app: ['申込件数'], con: ['契約件数'] }, ['date', 'view'], { maxRow: 30 });
    if (!dh) { res.status = 'failed'; res.reason = '案内状況の見出し（日付・案内件数）が見つかりません'; return; }
    var start = toDay(w.value(dh.row + 1, dh.cols.date), wb.date1904).day;
    if (start === null) { res.status = 'failed'; res.reason = '対象期間の開始日を読み取れません'; return; }
    var weekEnd = start + 6, reportDay = weekEnd;
    if (weekEndOnOrBefore(weekEnd, opt.weekEndDay) !== weekEnd) res.warnings.push('対象期間が月〜日ではありません（' + dayText(start) + '〜）');
    var vals = {};
    var tpos = findCell(w, '総戸数', { maxRow: 15 });
    var tv = valueRightOf(w, tpos, 4);
    addNumber(res, '総戸数', tv.col ? w.cell(tpos.row, tv.col) : null, vals, 'total_units');
    // 物件名は「総戸数」と同じ行の左側にある文字列
    if (tpos) for (var lc = 1; lc < tpos.col; lc++) { var lv = text(w.value(tpos.row, lc)); if (lv) { res.property_label = lv; break; } }
    // 日別の件数を合計（週間合計の数式は計算結果がないため）
    var sums = { viewing_count: 'view', application_count: 'app', contract_count: 'con' };
    Object.keys(sums).forEach(function (k) {
      var col = dh.cols[sums[k]];
      if (col === undefined) { vals[k] = null; return; }
      var total = 0, seen = 0;
      for (var r = dh.row + 1; r <= dh.row + 7; r++) {
        var n = toNumber(w.value(r, col));
        if (n.value !== null) { total += n.value; seen++; }
      }
      vals[k] = seen ? total : null;
      if (seen) res.extracted++;
    });
    vals.inquiry_count = null;

    var uh = findHeader(w, { room: ['号室'], status: ['状況'], reno: ['リノベ'], sqm: ['㎡数'], cancel: ['解約日'], prev: ['前回賃料'], asking: ['募集賃料'] }, ['room', 'status'], { maxCol: 12 });
    var units = [];
    if (!uh) res.unreadable.push('募集中・解約予定住戸（見出しなし）');
    else {
      var stopAt = findCell(w, '【条件変更等】');
      dataRows(w, uh, uh.cols.room, { gap: 1, stop: function (r) { return stopAt && r >= stopAt.row; } }).forEach(function (r) {
        var no = roomNo(w.value(r, uh.cols.room));
        if (!no) return;
        var s = B_STATUS[norm(w.value(r, uh.cols.status))];
        if (!s && text(w.value(r, uh.cols.status))) res.warnings.push('週報 ' + r + '行目の状況「' + text(w.value(r, uh.cols.status)) + '」は未定義の区分です');
        var cancel = toDay(w.value(r, uh.cols.cancel), wb.date1904).day;
        var reno = norm(w.value(r, uh.cols.reno));
        var u = unitBase({
          unit_number: no, leasing_status: s || null, floor_area_sqm: toNumber(w.value(r, uh.cols.sqm)).value,
          current_rent: toNumber(w.value(r, uh.cols.prev)).value, asking_rent: toNumber(w.value(r, uh.cols.asking)).value,
          unit_note: ['賃料は管理費込', reno === '済' ? 'リノベ済' : null].filter(Boolean).join(' / '),
          counts_as_vacant: s === 'vacant' || s === 'application'
        });
        if (s === 'notice') u.move_out_date = dayText(cancel);
        else u.vacancy_start_date = dayText(cancel);
        if (reno && reno !== '済' && /中|予定/.test(reno)) u.work_type = 'renovation';
        units.push(u);
      });
    }
    // 進捗状況から申込日を補う（同じ住戸の最新の申込中・審査中）
    var ph = findHeader(w, { date: ['申込日'], room: ['住戸'], prog: ['進捗状況'] }, ['date', 'room', 'prog']);
    if (ph) {
      dataRows(w, ph, ph.cols.date, { gap: 2 }).forEach(function (r) {
        var no = roomNo(w.value(r, ph.cols.room)), prog = norm(w.value(r, ph.cols.prog));
        var d = toDay(w.value(r, ph.cols.date), wb.date1904).day;
        units.forEach(function (u) {
          if (u.unit_number === no && u.leasing_status === 'application' && /申込中|審査中|審査ok|申込/.test(prog) && d !== null) {
            if (!u.application_date || u.application_date < dayText(d)) u.application_date = dayText(d);
          }
        });
      });
    }
    var c = countStatuses(units);
    // シートの定義: 空室 = 状況「空室」+「申込」
    vals.vacant_units = c.vacant + c.application;
    vals.application_units = c.application;
    vals.scheduled_termination_units = c.notice;
    vals.scheduled_contract_units = null;
    vals.occupied_units = isNum(vals.total_units) ? vals.total_units - vals.vacant_units : null;
    pushWeek(res, weekEnd, reportDay, vals, { formula: '稼働 = 総戸数 − (空室 + 申込)（募集中・解約予定住戸の状況から再計算）', sheet: '週報' });
    res.unreadable.push('戸数稼働率・週間合計（数式の計算結果なし。再計算）');
    res.confidence = 'medium';
    finishUnits(res, units.map(function (u) { u.report_date = dayText(weekEnd); return u; }));

    // 条件変更等（今週分）は住戸番号を拾って記録する
    var ch = findHeader(w, { date: ['実施日'], body: ['変更内容等'] }, ['date', 'body']);
    if (ch) {
      dataRows(w, ch, ch.cols.date, { gap: 2 }).forEach(function (r) {
        var d = toDay(w.value(r, ch.cols.date), wb.date1904).day;
        if (d === null || d <= weekEnd - 7 || d > weekEnd) return;
        var body = text(w.value(r, ch.cols.body)) || '';
        res.activity.push({ date: dayText(d), text: body });
        var nos = (norm(body).match(/(\d{3,4}(?:\/\d{3,4})*)号室/g) || []).join('/').replace(/号室/g, '').split('/').filter(Boolean);
        nos.forEach(function (no) { res.unit_events.push({ type: 'condition_change', unit_number: no, date: dayText(d), detail: body, basis: 'source' }); });
      });
    }
  }

  // ---------- 様式 C（リーシング報告書型） ----------

  var C_STATUS = { '空室': 'vacant', '申込': 'application', '契約中': 'occupied', '契約済': 'contracted', '退去予定': 'notice', '解約予定': 'notice' };

  function parseWeekSheetName(name) {
    var m = WEEK_SHEET_RE.exec(norm(name));
    if (!m) return null;
    var s = ymdToDay(+m[1], +m[2], +m[3]), e = ymdToDay(+m[4], +m[5], +m[6]);
    return s === null || e === null ? null : { start: s, end: e };
  }

  // 節の見出し（＜申込＞・【その他】等）の行か
  function isSectionLabel(v) { return typeof v === 'string' && /^[<＜【\[]/.test(norm(v)); }

  // 期間別シートの節（＜申込＞ 等）の行を読む。見出し行がない節は fallbackHeader の列を使う
  function sectionRows(sheet, label, defs, required, keyField, date1904, fallbackHeader) {
    var pos = findCell(sheet, label, { startsWith: true });
    if (!pos) return null;
    var hdr = findHeader(sheet, defs, required, { minRow: pos.row, maxRow: pos.row + 3 });
    if (!hdr && fallbackHeader) hdr = { row: pos.row, cols: fallbackHeader.cols };
    if (!hdr) return null;
    var out = [];
    out.header = hdr;
    dataRows(sheet, hdr, hdr.cols[keyField], { gap: 2, stop: function (r) { return isSectionLabel(sheet.value(r, hdr.cols[keyField])); } }).forEach(function (r) {
      var o = { row: r };
      Object.keys(hdr.cols).forEach(function (k) { o[k] = sheet.value(r, hdr.cols[k]); });
      o.room = roomNo(o.room);
      if (o.date !== undefined) o.day = toDay(o.date, date1904).day;
      if (o.room) out.push(o);
    });
    return out;
  }

  function cSections(sheet, date1904) {
    var notices = sectionRows(sheet, '＜解約予告＞', { room: ['号室'], date: ['解約日'] }, ['room', 'date'], 'room', date1904);
    return {
      apps: sectionRows(sheet, '＜申込＞', { room: ['号室'], date: ['申込日'] }, ['room', 'date'], 'room', date1904),
      notices: notices,
      // キャンセル欄は独自の見出し行がなく、直前の解約予告欄と同じ列構成（日付列 = キャンセルの日付）
      cancels: sectionRows(sheet, '【その他】ｷｬﾝｾﾙ', { room: ['号室'], date: ['キャンセル日', '日付'] }, ['room', 'date'], 'room', date1904, notices && notices.header)
    };
  }

  function parseC(wb, res, opt) {
    var weekly = wb.sheetNames.map(function (n) { return { name: n, range: parseWeekSheetName(n) }; })
      .filter(function (x) { return x.range; })
      .sort(function (a, b) { return a.range.end - b.range.end; });
    if (!weekly.length) { res.status = 'failed'; res.reason = '期間別シートがありません'; return; }
    // 物件名は最新の期間別シートの先頭行の文字列
    var title = wb.sheet(weekly[weekly.length - 1].name);
    for (var tc = 1; tc <= title.maxCol && !res.property_label; tc++) { var tv0 = title.value(1, tc); if (typeof tv0 === 'string') res.property_label = text(tv0); }
    // 総戸数: 部屋概要の部屋一覧の件数
    var rooms = {}, total = null, ov = wb.sheet('部屋概要');
    if (ov) {
      var oh = findHeader(ov, { room: ['号室'], sqm: ['面積'], layout: ['間取り'] }, ['room'], { maxRow: 10 });
      if (oh) {
        // 見出しの下の段（㎡・坪・タイプ）は部屋番号がないため数えない。面積は「面積」見出しの列（㎡）
        dataRows(ov, oh, oh.cols.room, { gap: 3 }).forEach(function (r) {
          var no = roomNo(ov.value(r, oh.cols.room));
          if (no && /\d/.test(no)) rooms[no] = { sqm: toNumber(ov.value(r, oh.cols.sqm)).value, layout: oh.cols.layout === undefined ? null : text(ov.value(r, oh.cols.layout)) };
        });
        total = Object.keys(rooms).length || null;
      }
    }
    if (total === null) res.unreadable.push('総戸数（部屋概要の部屋一覧なし）');

    var summaryDefs = { report: ['報告日'], vacant: ['空室数'], listing: ['募集戸数'], inquiry: ['反響数'], viewing: ['内見数'], newapp: ['新規申込'], pending: ['申込中契約予定'], cancel: ['申込キャンセル数'], contract: ['契約数'] };
    weekly.forEach(function (ws) {
      var sh = wb.sheet(ws.name);
      var hdr = findHeader(sh, summaryDefs, ['report', 'vacant'], { maxRow: 15 });
      if (!hdr) { res.warnings.push('シート「' + ws.name + '」に集計欄がありません'); return; }
      var r = hdr.row + 1, vals = {};
      var rep = toDay(sh.value(r, hdr.cols.report), wb.date1904).day;
      addNumber(res, ws.name + ' 空室数', sh.cell(r, hdr.cols.vacant), vals, 'vacant_units');
      addNumber(res, ws.name + ' 反響数', cellOf(sh, r, hdr.cols.inquiry), vals, 'inquiry_count');
      addNumber(res, ws.name + ' 内見数', cellOf(sh, r, hdr.cols.viewing), vals, 'viewing_count');
      addNumber(res, ws.name + ' 新規申込', cellOf(sh, r, hdr.cols.newapp), vals, 'application_count');
      addNumber(res, ws.name + ' 申込中・契約予定', cellOf(sh, r, hdr.cols.pending), vals, 'application_units');
      addNumber(res, ws.name + ' 申込キャンセル数', cellOf(sh, r, hdr.cols.cancel), vals, 'application_cancel_count');
      addNumber(res, ws.name + ' 契約数', cellOf(sh, r, hdr.cols.contract), vals, 'contract_count');
      vals.total_units = total;
      vals.occupied_units = isNum(total) && isNum(vals.vacant_units) ? total - vals.vacant_units : null;
      vals.scheduled_termination_units = null;
      vals.scheduled_contract_units = null;
      pushWeek(res, weekEndOnOrBefore(ws.range.end, opt.weekEndDay), rep !== null ? rep : ws.range.end, vals, {
        formula: '稼働 = 総戸数（部屋概要の部屋数）− 空室数（期間別シートの集計欄）', sheet: ws.name
      });
    });
    var latest = weekly[weekly.length - 1], prev = weekly.length > 1 ? weekly[weekly.length - 2] : null;
    var weekEnd = weekEndOnOrBefore(latest.range.end, opt.weekEndDay);
    var lastWeek = res.weeks[res.weeks.length - 1];
    var cur = cSections(wb.sheet(latest.name), wb.date1904);
    var before = prev ? cSections(wb.sheet(prev.name), wb.date1904) : null;

    // 現募集中（明示された現況がある住戸のみ）
    var units = [], noStatus = 0, cs = wb.sheet('現募集中');
    if (!cs) res.unreadable.push('現募集中シートなし');
    else {
      var h = findHeader(cs, {
        room: ['号室'], rent: ['賃料'], fee: ['共益費'], ad: ['AD'], deposit: ['敷金'], key: ['礼金'], fr: ['フリーレント'],
        asking: ['募集賃料'], cancel: ['解約日'], restored: ['原状回復完了日'], listed: ['募集開始日']
      }, ['room'], { maxRow: 10 });
      if (h) {
        dataRows(cs, h, h.cols.room, { gap: 3 }).forEach(function (r) {
          var no = roomNo(cs.value(r, h.cols.room));
          if (!no || !/\d/.test(no)) return;
          // 現況は見出しのない「号室」の左隣の列
          var stText = text(cs.value(r, h.cols.room - 1));
          var s = stText ? C_STATUS[norm(stText)] : null;
          var activity = ['cancel', 'restored', 'listed', 'ad'].some(function (k) { return h.cols[k] !== undefined && cs.value(r, h.cols[k]) !== null; });
          if (!s) { if (activity || stText) noStatus++; return; }
          var g = function (k) { return h.cols[k] === undefined ? null : cs.value(r, h.cols[k]); };
          var cancel = toDay(g('cancel'), wb.date1904).day, restored = toDay(g('restored'), wb.date1904).day;
          var asking = toNumber(g('asking')).value;
          var u = unitBase({
            unit_number: no, leasing_status: s, layout: rooms[no] ? rooms[no].layout : null, floor_area_sqm: rooms[no] ? rooms[no].sqm : null,
            asking_rent: asking !== null ? asking : toNumber(g('rent')).value, common_fee: toNumber(g('fee')).value,
            ad: toNumber(g('ad')).value, deposit_months: toNumber(g('deposit')).value, key_money_months: toNumber(g('key')).value, fr: toNumber(g('fr')).value
          });
          if (s === 'occupied') { u.current_rent = toNumber(g('rent')).value; u.asking_rent = null; }
          if (s === 'vacant' || s === 'application' || s === 'contracted') {
            u.vacancy_start_date = dayText(cancel);
            if (restored !== null) {
              u.work_type = 'restoration';
              if (restored <= lastWeek.report_day) u.work_completed_date = dayText(restored); else u.work_end_date = dayText(restored);
            }
          }
          if (s === 'notice') {
            var n = (cur.notices || []).filter(function (x) { return x.room === no && x.day !== null; }).sort(function (a, b) { return b.day - a.day; })[0];
            u.move_out_date = dayText(n ? n.day : cancel);
          }
          if (s === 'application' || s === 'contracted') {
            var a = (cur.apps || []).filter(function (x) { return x.room === no && x.day !== null; }).sort(function (a2, b2) { return b2.day - a2.day; })[0];
            if (a) u.application_date = dayText(a.day);
          }
          u.report_date = dayText(weekEnd);
          units.push(u);
        });
      } else res.unreadable.push('現募集中（見出しなし）');
    }
    if (noStatus) res.warnings.push('現募集中に現況が空欄の住戸 ' + noStatus + '件（推測せず住戸明細から除外）');
    var cnt = countStatuses(units);
    lastWeek.values.scheduled_termination_units = cs ? cnt.notice : null;
    finishUnits(res, units);

    // 前週シートとの差分で今週の新規を判定（期間別シートは累積で再掲されるため）
    var keyOf = function (x) { return x.room + '|' + (x.day === null ? String(x.date) : x.day); };
    res.duplicate_rows_removed = 0;
    var diff = function (curList, prevList, type, detail) {
      if (!curList) return;
      if (!prevList) { res.warnings.push('前週の期間別シートがないため、' + detail + 'の新規判定はしていません'); return; }
      var seen = {};
      prevList.forEach(function (x) { seen[keyOf(x)] = true; });
      curList.forEach(function (x) {
        if (seen[keyOf(x)]) { res.duplicate_rows_removed++; return; }
        var ev = { type: type, unit_number: x.room, date: type === 'notice' ? null : dayText(x.day), basis: 'diff', detail: detail };
        if (type === 'notice') ev.move_out_date = dayText(x.day);
        res.unit_events.push(ev);
      });
    };
    diff(cur.apps, before && before.apps, 'application', '申込');
    diff(cur.cancels, before && before.cancels, 'application_cancel', 'キャンセル');
    diff(cur.notices, before && before.notices, 'notice', '解約予告');
  }

  // ---------- 様式 D（Action Points型） ----------

  function parseD(wb, res) {
    var s = wb.sheet('List');
    var h1 = findHeader(s, { no: ['No.'], prop: ['Property name'], due: ['Target Due Date'], priority: ['Priority'], status: ['Status'] }, ['prop', 'due'], { maxRow: 20 });
    if (!h1) { res.status = 'failed'; res.reason = 'Action Points の見出しが見つかりません'; return; }
    // 2 段目の見出し（Category・Action・Latest Updated）。メモ欄は個人名や居住者情報を含みうるため読まない
    var h2 = findHeader(s, { category: ['Category'], action: ['Action'], updated: ['Latest Updated'] }, ['category'], { minRow: h1.row, maxRow: h1.row + 2 });
    var cols = Object.assign({}, h1.cols, h2 ? h2.cols : {});
    dataRows(s, h2 || h1, cols.prop, { gap: 3 }).forEach(function (r) {
      var g = function (k) { return cols[k] === undefined ? null : s.value(r, cols[k]); };
      var due = toDay(g('due'), wb.date1904);
      res.action_items.push({
        property_label: text(g('prop')), due_date: dayText(due.day), priority: text(g('priority')), status: text(g('status')),
        category: text(g('category')), action: text(g('action')), latest_update: text(g('updated'))
      });
      res.extracted++;
    });
    res.include_in_numeric = false;
    // Dropdown シートの PJ No. と物件名の対応（あれば）
    var dd = wb.sheet('Dropdown');
    res.pj_map = {};
    if (dd) {
      var dh = findHeader(dd, { pj: ['PJ No.'], name: ['Property Name'] }, ['pj', 'name'], { maxRow: 10 });
      if (dh) dataRows(dd, dh, dh.cols.pj, { gap: 3 }).forEach(function (r) {
        var nm = text(dd.value(r, dh.cols.name)), pj = dd.value(r, dh.cols.pj);
        if (nm && pj !== null) (res.pj_map[norm(nm)] = res.pj_map[norm(nm)] || []).push(String(pj));
      });
    }
  }

  // ---------- 1 ファイルの解析 ----------

  function parseWorkbookFile(file, options) {
    options = options || {};
    var cfg = options.config || {};
    var opt = { weekEndDay: cfg.ingest && cfg.ingest.weekEndDay !== undefined ? cfg.ingest.weekEndDay : 0 };
    var name = C.baseName(file.name);
    var bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes);
    return X.readWorkbook(bytes, options.xlsx).then(function (wb) {
      var fmt = detectFormat(wb);
      var res = newResult(name, fmt);
      res.hash = hashBytes(bytes);
      if (!fmt) { res.status = 'failed'; res.confidence = 'low'; res.reason = '様式を判定できません（シート名・見出しが既知の様式と一致しません）'; return res; }
      try {
        ({ A: parseA, B: parseB, C: parseC, D: parseD })[fmt](wb, res, opt);
      } catch (e) {
        res.status = 'failed';
        res.reason = '解析中にエラー: ' + (e && e.message ? e.message : String(e));
      }
      if (res.status !== 'failed' && (res.unreadable.length || res.warnings.length)) res.status = res.weeks.length || res.action_items.length ? 'partial' : 'failed';
      if (res.status === 'failed') res.confidence = 'low';
      var formulas = 0;
      Object.keys(wb.sheets).forEach(function (k) { formulas += wb.sheets[k].formulasWithoutValue; });
      res.formulas_without_value = formulas;
      return res;
    }, function (err) {
      var res = newResult(name, null);
      res.status = 'failed';
      res.reason = 'ファイルを開けません: ' + (err && err.message ? err.message : String(err));
      res.confidence = 'low';
      return res;
    });
  }

  function hashBytes(bytes) {
    var h = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8) + '-' + bytes.length;
  }

  // ---------- 物件の特定 ----------

  // 物件名の多くに共通する接頭語（シリーズ名など）をマスターから見つける。ブランド名をコードに持たないため
  function detectPrefixes(master) {
    var names = master.entries.map(function (e) { return norm(e.property_name_ja); }).filter(function (n) { return n.length >= 4; });
    var need = Math.max(3, Math.ceil(names.length * 0.2)), out = {};
    names.forEach(function (n) {
      for (var L = n.length - 1; L >= 3; L--) {
        var p = n.slice(0, L);
        if (names.filter(function (m) { return m.indexOf(p) === 0; }).length >= need) { out[p] = true; break; }
      }
    });
    // より長い接頭語の一部でしかないもの（途中で切れたもの）は除く
    var list = Object.keys(out);
    return list.filter(function (p) { return !list.some(function (q) { return q !== p && q.indexOf(p) === 0; }); });
  }

  // ファイル名を照合用に正規化する。空白は取り除くが、その位置を区切りとして覚えておく
  function fileNameForMatch(name) {
    var s = String(name || '');
    if (typeof s.normalize === 'function') s = s.normalize('NFKC');
    s = s.toLowerCase().replace(/\.(xlsx|xlsm|xls|csv)$/, '');
    var text = '', boundary = [];
    var pendingSpace = false;
    for (var i = 0; i < s.length; i++) {
      if (/[\s　]/.test(s[i])) { pendingSpace = true; continue; }
      boundary.push(pendingSpace);
      text += s[i];
      pendingSpace = false;
    }
    boundary.push(true);
    return { text: text, boundaryBefore: boundary };
  }

  var BOUNDARY_CHAR = /[()\[\]【】「」『』<>＜＞_\-・,.、。:;!?/\\0-9★☆]/;
  var NAME_FOLLOWERS = ['週報', '仲介', '営業', '報告', 'リーシング'];

  // 候補名がファイル名の中で区切られた位置に現れるか（「大岡山」が「大岡山II」や「南大岡山」に一致しないように）
  function boundedMatch(f, cand) {
    var idx = f.text.indexOf(cand), reasons = [];
    while (idx !== -1) {
      var end = idx + cand.length;
      var prevOk = idx === 0 || f.boundaryBefore[idx] || BOUNDARY_CHAR.test(f.text[idx - 1]);
      var rest = f.text.slice(end);
      var nextOk = end === f.text.length || f.boundaryBefore[end] || BOUNDARY_CHAR.test(f.text[end]) ||
        NAME_FOLLOWERS.some(function (w) { return rest.indexOf(w) === 0; });
      if (prevOk && nextOk) return { ok: true };
      reasons.push(!nextOk ? '直後に「' + rest.slice(0, 6) + '」が続く' : '直前に「' + f.text.slice(Math.max(0, idx - 3), idx) + '」がある');
      idx = f.text.indexOf(cand, idx + 1);
    }
    return { ok: false, reasons: reasons };
  }

  // 1) 対応表（ファイル名に含まれる文字 → Project #）
  // 2) ファイル名に区切られて現れる物件名（共通の接頭語を除いた名前も可。最長一致、同じ長さで複数なら未紐付け）
  // 3) ファイル内の物件名（完全一致）
  function resolveProject(res, master, mapping, cfg) {
    var fname = norm(res.file_name);
    var best = null;
    (mapping || []).forEach(function (m) {
      var p = norm(m.pattern);
      if (p && fname.indexOf(p) !== -1 && (!best || p.length > best.len)) best = { key: C.normalizeKey(m.project_number), len: p.length, by: '対応表' };
    });
    if (best) return best;
    var f = fileNameForMatch(res.file_name);
    var prefixes = detectPrefixes(master).concat(((cfg.ingest && cfg.ingest.stripNamePrefixes) || []).map(norm));
    var hits = [], rejected = [];
    master.entries.forEach(function (e) {
      var cands = {};
      ['property_name_ja', 'project_name'].forEach(function (fld) {
        var n = norm(e[fld]);
        if (n.length >= 2) cands[n] = true;
        prefixes.forEach(function (p) { if (p && n.indexOf(p) === 0 && n.length - p.length >= 2) cands[n.slice(p.length)] = true; });
      });
      Object.keys(cands).forEach(function (cand) {
        if (f.text.indexOf(cand) === -1) return;
        var m = boundedMatch(f, cand);
        if (m.ok) hits.push({ key: e.key, len: cand.length, name: cand });
        else rejected.push(cand + '（' + m.reasons[0] + '）');
      });
    });
    if (hits.length) {
      var maxLen = Math.max.apply(null, hits.map(function (h) { return h.len; }));
      var top = hits.filter(function (h) { return h.len === maxLen; });
      var keys = top.map(function (h) { return h.key; }).filter(function (k, i, a) { return a.indexOf(k) === i; });
      if (keys.length === 1) return { key: keys[0], len: maxLen, by: 'ファイル名の物件名「' + top[0].name + '」' };
      res.warnings.push('ファイル名が複数の物件（' + keys.join(', ') + '）に同じ程度一致するため紐付けませんでした');
      return null;
    }
    var label = norm(res.property_label);
    if (label) master.entries.forEach(function (e) {
      ['property_name_ja', 'project_name', 'property_name_en'].forEach(function (fld) {
        if (!best && e[fld] && norm(e[fld]) === label) best = { key: e.key, len: label.length, by: 'ファイル内の物件名' };
      });
    });
    if (!best && rejected.length) res.warnings.push('物件名の候補 ' + rejected.slice(0, 3).join('、') + ' は別の物件の可能性があるため紐付けませんでした（対応表で指定できます）');
    return best;
  }

  // ファイル名だけで紐付け結果を確認する（対応表を作るときの確認用）
  function previewMapping(fileNames, masterText, mappingText, cfg) {
    var master = C.loadMaster(masterText, cfg), mapping = parseMappingCSV(mappingText);
    return fileNames.map(function (n) {
      var res = { file_name: n, property_label: null, warnings: [] };
      var p = resolveProject(res, master, mapping, cfg);
      return { file_name: n, project_number: p ? p.key : null, by: p ? p.by : null, note: res.warnings.join(' / ') || null };
    });
  }

  function parseMappingCSV(textIn) {
    if (!textIn) return [];
    var csv = C.parseCSV(textIn);
    var cols = C.mapColumns(csv.headers, { pattern: ['file_name_pattern', 'ファイル名に含まれる文字', 'pattern'], project_number: ['project_number', 'Project #'] });
    if (cols.map.pattern === undefined || cols.map.project_number === undefined) return [];
    return csv.rows.map(function (r) { return { pattern: (r[cols.map.pattern] || '').trim(), project_number: (r[cols.map.project_number] || '').trim() }; })
      .filter(function (m) { return m.pattern && m.project_number; });
  }

  // ---------- dashboard_data.json の組み立て ----------

  var ROLE_PRIORITY = ['リーシング報告書型', '週報型', '営業活動週報型'];

  function round6(x) { return Math.round(x * 1e6) / 1e6; }

  function buildDashboardData(results, options) {
    options = options || {};
    var cfg = options.config;
    var master = C.loadMaster(options.masterText === undefined ? null : options.masterText, cfg);
    var mapping = parseMappingCSV(options.mappingText);
    var historyWeeks = (cfg.ingest && cfg.ingest.historyWeeks) || 12;
    var dupHash = {};
    var files = results.map(function (r) {
      var f = Object.assign({}, r);
      if (dupHash[r.hash]) { f.duplicateOf = dupHash[r.hash]; f.status = 'failed'; f.reason = '同一内容のファイル「' + dupHash[r.hash] + '」と重複（二重読込）'; }
      else dupHash[r.hash] = r.file_name;
      var p = f.status === 'failed' ? null : resolveProject(f, master, mapping, cfg);
      f.project_key = p ? p.key : null;
      f.project_by = p ? p.by : null;
      return f;
    });

    // 物件 × 週ごとに採用するファイルを 1 つ選ぶ（合算しない）
    var chosen = {}, dupNote = {};
    files.forEach(function (f) {
      if (f.status === 'failed' || !f.include_in_numeric || !f.project_key) return;
      f.weeks.forEach(function (w) {
        var k = f.project_key + '|' + w.week_end;
        var cur = chosen[k];
        if (!cur) { chosen[k] = { file: f, week: w }; return; }
        var a = ROLE_PRIORITY.indexOf(f.role), b = ROLE_PRIORITY.indexOf(cur.file.role);
        dupNote[f.file_name] = dupNote[cur.file.file_name] = true;
        if (a < b) chosen[k] = { file: f, week: w };
      });
    });
    // 対象週は、物件に紐付いたかどうかに関係なく読み取れた週報の日付から決める
    var allWeeks = [];
    files.forEach(function (f) { if (f.status !== 'failed' && f.include_in_numeric) f.weeks.forEach(function (w) { allWeeks.push(w.week_end); }); });
    var periodDay = options.periodDay !== undefined ? options.periodDay : (allWeeks.length ? Math.max.apply(null, allWeeks) : null);
    var minDay = periodDay === null ? null : periodDay - 7 * (historyWeeks - 1);
    var unitWeeks = (cfg.ingest && cfg.ingest.unitHistoryWeeks) || 2;
    var unitMinDay = periodDay === null ? Infinity : periodDay - 7 * (unitWeeks - 1);

    var properties = [];
    Object.keys(chosen).forEach(function (k) {
      var ch = chosen[k], v = ch.week.values, f = ch.file;
      if (minDay !== null && (ch.week.week_end < minDay || ch.week.week_end > periodDay)) return;
      var occ = v.occupied_units, tot = v.total_units, app = v.application_units;
      var rate = isNum(occ) && isNum(tot) && tot > 0 ? round6(occ / tot) : null;
      var latest = ch.week.week_end === Math.max.apply(null, f.weeks.map(function (w) { return w.week_end; }));
      var rec = {
        report_date: dayText(ch.week.week_end), project_number: f.project_key,
        total_units: v.total_units, occupied_units: occ, vacant_units: v.vacant_units, application_units: v.application_units,
        scheduled_contract_units: v.scheduled_contract_units, scheduled_termination_units: v.scheduled_termination_units,
        occupancy_rate_source: null, occupancy_rate_calculated: rate,
        occupancy_calculation_numerator: isNum(occ) ? occ : null, occupancy_calculation_denominator: isNum(tot) ? tot : null,
        occupancy_calculation_formula: ch.week.formula,
        occupancy_after_application_source: null,
        occupancy_after_application_calculated: ch.week.afterApplicationPermitted && isNum(occ) && isNum(app) && isNum(tot) && tot > 0 ? round6((occ + app) / tot) : null,
        inquiry_count: v.inquiry_count === undefined ? null : v.inquiry_count, viewing_count: v.viewing_count === undefined ? null : v.viewing_count,
        application_count: v.application_count === undefined ? null : v.application_count, contract_count: v.contract_count === undefined ? null : v.contract_count,
        application_cancel_count: v.application_cancel_count === undefined ? null : v.application_cancel_count,
        major_change_from_previous_week: null, pm_comment: null,
        source_file_name: f.file_name, source_sheet_name: ch.week.sheet,
        data_confidence: f.confidence, error_detail: f.unreadable.length ? f.unreadable.slice(0, 3).join(' / ') : null
      };
      if (latest && f.activity.length) rec.pm_comment = f.activity.map(function (a) { return a.date + ' ' + a.text; }).join('\n');
      // 住戸明細から空室日数の平均・最大（住戸明細がある週のみ）
      if (latest && f.units.length) {
        var days = f.units.filter(function (u) { return u.vacancy_start_date && u.leasing_status !== 'occupied' && u.leasing_status !== 'notice'; })
          .map(function (u) { return ch.week.week_end - C.parseDateValue(u.vacancy_start_date).value; }).filter(function (d) { return d >= 0; });
        if (days.length) {
          rec.average_vacancy_days = Math.round(days.reduce(function (a, b) { return a + b; }, 0) / days.length);
          rec.maximum_vacancy_days = Math.max.apply(null, days);
        }
      }
      properties.push(rec);
    });

    // 住戸明細・住戸イベントは採用したファイルの最新週分のみ
    var units = [], events = [];
    files.forEach(function (f) {
      if (f.status === 'failed' || !f.project_key || !f.include_in_numeric) return;
      var lastWeek = f.weeks.length ? Math.max.apply(null, f.weeks.map(function (w) { return w.week_end; })) : null;
      var ch = chosen[f.project_key + '|' + lastWeek];
      if (!ch || ch.file !== f) return;
      f.units.forEach(function (u) { units.push(Object.assign({ project_number: f.project_key, data_confidence: f.confidence, source_file_name: f.file_name }, u)); });
      f.unit_events.forEach(function (e) { events.push(Object.assign({ report_date: dayText(lastWeek), project_number: f.project_key, source_file_name: f.file_name }, e)); });
    });

    // Action Points（数値には合算しない）
    var actions = [];
    files.forEach(function (f) {
      if (f.status === 'failed' || f.format !== 'D') return;
      f.action_items.forEach(function (a) {
        var key = null, ln = norm(a.property_label);
        master.entries.forEach(function (e) {
          ['property_name_ja', 'project_name', 'property_name_en'].forEach(function (fld) { if (!key && e[fld] && norm(e[fld]) === ln) key = e.key; });
        });
        if (!key && f.pj_map && f.pj_map[ln] && f.pj_map[ln].length === 1 && master.byKey[C.normalizeKey(f.pj_map[ln][0])]) key = C.normalizeKey(f.pj_map[ln][0]);
        actions.push(Object.assign({ project_number: key, source_file_name: f.file_name }, a));
      });
    });

    // 前回の dashboard_data.json の履歴を引き継ぐ（同じ物件・週は新しい解析結果を優先）
    var prev = options.previousData;
    if (prev && typeof prev === 'object') {
      var have = {};
      properties.forEach(function (p) { have[C.normalizeKey(p.project_number) + '|' + C.normalizePeriod(p.report_date)] = true; });
      (Array.isArray(prev.properties) ? prev.properties : []).forEach(function (p) {
        var per = C.normalizePeriod(p.report_date), k = C.normalizeKey(p.project_number) + '|' + per;
        var d = per && /^\d{8}$/.test(per) ? C.parseDateValue(per.slice(0, 4) + '-' + per.slice(4, 6) + '-' + per.slice(6)).value : null;
        if (!have[k] && d !== null && (minDay === null || (d >= minDay && d < periodDay))) { properties.push(p); have[k] = true; }
      });
      var haveU = {};
      units.forEach(function (u) { haveU[C.normalizeKey(u.project_number) + '|' + C.normalizePeriod(u.report_date)] = true; });
      (Array.isArray(prev.units) ? prev.units : []).forEach(function (u) {
        var per = C.normalizePeriod(u.report_date);
        var d = per && /^\d{8}$/.test(per) ? C.parseDateValue(per.slice(0, 4) + '-' + per.slice(4, 6) + '-' + per.slice(6)).value : null;
        // 住戸明細は前週比較に使う直近の週だけ残す（ブラウザ内の保存容量を抑えるため）
        if (!haveU[C.normalizeKey(u.project_number) + '|' + per] && d !== null && d >= unitMinDay && d < periodDay) units.push(u);
      });
    }

    var processed = files.filter(function (f) { return f.status !== 'failed'; }).length;
    var failed = files.length - processed;
    var alerts = [];
    files.forEach(function (f) {
      if (f.status === 'failed') alerts.push({ severity: 'error', code: 'SOURCE_READ_FAILED', message: f.file_name + ': ' + f.reason });
      else if (!f.project_key && f.format !== 'D') alerts.push({ severity: 'warning', code: 'SOURCE_UNLINKED', message: f.file_name + ': 物件マスターの Project # に紐付けできません（対応表に追加してください）' });
    });
    Object.keys(dupNote).forEach(function (n) { alerts.push({ severity: 'warning', code: 'DUPLICATE_SOURCE', message: n + ': 同じ物件・週の別ファイルがあり、合算せず 1 ファイルを採用しました' }); });

    var data = {
      report_metadata: {
        report_date: periodDay === null ? null : dayText(periodDay), source_period: periodDay === null ? null : dayKey(periodDay),
        file_count_expected: files.length, file_count_processed: processed, file_count_failed: failed,
        generated_by: '週報Excel解析（leasing-dashboard ingest）', contains_personal_data: false
      },
      portfolio_summary: properties.length ? { status: 'calculated', is_provisional: failed > 0 || files.some(function (f) { return f.status === 'partial'; }) }
        : { status: 'not_calculated', is_provisional: false, reason: 'no_property_records' },
      properties: properties,
      units: units,
      unit_events: events,
      action_items: actions,
      alerts: alerts,
      validation_summary: {
        success: files.filter(function (f) { return f.status === 'success'; }).length,
        partial: files.filter(function (f) { return f.status === 'partial'; }).length,
        failed: failed,
        property_linked: files.filter(function (f) { return f.project_key; }).length,
        duplicate_candidates: Object.keys(dupNote).length + files.filter(function (f) { return f.duplicateOf; }).length,
        low_confidence_records: properties.filter(function (p) { return p.data_confidence === 'low'; }).length
      },
      file_inventory: files.map(function (f) { return { file_name: f.file_name, status: f.status }; })
    };
    var rows = files.map(function (f) {
      var reasons = [].concat(f.reason ? [f.reason] : [], f.warnings.slice(0, 5));
      if (!f.project_key && f.status !== 'failed' && f.format !== 'D') reasons.push('Project # 未紐付け');
      if (f.project_key) reasons.push('紐付け: ' + f.project_by);
      if (f.format) reasons.unshift('様式 ' + f.format + '（' + f.role + '）');
      if (f.formulas_without_value) reasons.push('数式の計算結果なし ' + f.formulas_without_value + '件');
      return {
        'ファイル名': f.file_name, '対象物件': f.project_key || '',
        '処理結果': f.status === 'success' ? '正常' : f.status === 'partial' ? '一部' : '読取失敗',
        '抽出項目数': f.status === 'failed' ? 0 : f.extracted,
        '読取不能項目': f.status === 'failed' ? '全項目' : f.unreadable.join(' / '),
        '重複の可能性': f.duplicateOf || dupNote[f.file_name] ? 'あり' : (f.status === 'failed' ? '未判定' : 'なし'),
        '数値不一致': f.status === 'failed' ? '未判定' : (f.warnings.some(function (w) { return /一致しません/.test(w); }) ? 'あり' : 'なし'),
        '物件名不一致': '未判定',
        'データ確度': f.confidence,
        '要確認理由': reasons.join(' / ')
      };
    });
    return { data: data, validationRows: rows, validationCSV: toCSV(rows), files: files };
  }

  function toCSV(rows) {
    var head = ['ファイル名', '対象物件', '処理結果', '抽出項目数', '読取不能項目', '重複の可能性', '数値不一致', '物件名不一致', 'データ確度', '要確認理由'];
    var lines = [head.map(C.csvCell).join(',')];
    rows.forEach(function (r) { lines.push(head.map(function (h) { return C.csvCell(r[h]); }).join(',')); });
    return '﻿' + lines.join('\n') + '\n';
  }

  return {
    FORMAT_ROLES: FORMAT_ROLES, detectFormat: detectFormat, parseWorkbookFile: parseWorkbookFile,
    buildDashboardData: buildDashboardData, parseMappingCSV: parseMappingCSV, weekEndOnOrBefore: weekEndOnOrBefore, toDay: toDay,
    previewMapping: previewMapping, detectPrefixes: detectPrefixes
  };
});
