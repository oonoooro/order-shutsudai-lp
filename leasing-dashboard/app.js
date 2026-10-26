/*
 * 週次リーシングダッシュボード 画面ロジック
 * データは同一オリジンの data/ から読むか、ユーザーが選択したローカルファイルから読む。
 * 外部への送信は行わない（index.html の CSP でも禁止している）。
 */
(function () {
  'use strict';

  var C = window.LeasingCore;
  var CFG = window.DASHBOARD_CONFIG;
  var CACHE_KEY = 'leasing-dashboard:last-good';
  var THEME_KEY = 'leasing-dashboard:theme';

  var state = {
    model: null, texts: null, loadedAt: null, source: null, stale: null, notes: [],
    tab: 'summary', period: null, filters: {}, selectedKey: null,
    sort: { key: 'key', dir: 1 }, alertCat: null, fileStatus: '', issueSeverity: ''
  };

  // ---------- DOM ヘルパー（文字列は必ず textContent で入れる） ----------

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    applyAttrs(el, attrs);
    append(el, children);
    return el;
  }
  var SVGNS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, children) {
    var el = document.createElementNS(SVGNS, tag);
    applyAttrs(el, attrs);
    append(el, children);
    return el;
  }
  function applyAttrs(el, attrs) {
    if (!attrs) return;
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.setAttribute('class', v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    });
  }
  function append(el, children) {
    if (children === null || children === undefined || children === false) return;
    if (!Array.isArray(children)) children = [children];
    children.forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function $(id) { return document.getElementById(id); }

  function badge(text, cls, tip) { return h('span', { class: 'badge ' + cls, text: text, 'data-tip': tip || null }); }
  function confBadge(c) { return badge(C.confidenceLabel(c), 'conf-' + (c || 'none')); }
  function provisionalBadge(reasons) { return badge(CFG.display.provisionalLabel, 'provisional', reasons && reasons.length ? '暫定の理由:\n・' + reasons.join('\n・') : null); }
  function sevBadge(sev) { return badge(sev === 'error' ? 'エラー' : sev === 'warning' ? '警告' : '情報', 'sev-' + sev); }
  function card(title, body, extraHead) {
    return h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [h('h2', { text: title }), extraHead || null]),
      body
    ]);
  }
  function empty(text) { return h('div', { class: 'empty', text: text }); }
  function numCell(text, isNull) { return h('td', { class: 'num' + (isNull ? ' null' : ''), text: text }); }

  function storageGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function storageSet(k, v) { try { window.localStorage.setItem(k, v); return true; } catch (e) { return false; } }

  // ---------- 読込 ----------

  function fetchText(path) {
    var url = path + (path.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now();
    return fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) return { ok: false, status: res.status };
      return res.text().then(function (t) { return { ok: true, text: t }; });
    }, function (err) { return { ok: false, network: true, error: String(err) }; });
  }

  function loadFromServer() {
    var f = CFG.dataFiles;
    return Promise.all([fetchText(f.dashboardData), fetchText(f.propertyMaster), fetchText(f.validationReport)]).then(function (r) {
      var notes = [];
      if (!r[0].ok) {
        var why = r[0].network ? 'ローカルサーバー経由で開かれていないため読み込めません（file:// で開いた場合は「ファイルを選択」を使ってください）'
          : 'dashboard_data.json が見つかりません（HTTP ' + r[0].status + '）';
        return failLoad(why, true);
      }
      if (!r[1].ok) notes.push('property_master.csv を読み込めませんでした（物件名は表示できません）。');
      if (!r[2].ok) notes.push('validation_report.csv を読み込めませんでした。');
      applyTexts({
        dashboardDataText: r[0].text,
        propertyMasterText: r[1].ok ? r[1].text : null,
        validationReportText: r[2].ok ? r[2].text : null
      }, 'server', notes);
    });
  }

  function failLoad(reason, allowCache) {
    if (state.model) {
      state.stale = { reason: reason, at: new Date() };
      render();
      return;
    }
    if (allowCache) {
      var cached = readCache();
      if (cached) {
        applyTexts(cached.texts, 'cache', []);
        state.stale = { reason: reason, at: new Date(), cachedAt: cached.loadedAt };
        render();
        return;
      }
    }
    state.stale = null;
    renderLoadError(reason);
  }

  function applyTexts(texts, source, notes) {
    var model = C.loadAll(texts, CFG);
    if (!model.ok) {
      // 不正な JSON では更新しない。前回正常に読み込んだデータを保持する。
      failLoad(model.fatal.message, true);
      return false;
    }
    var prevHash = state.texts ? C.hashText(state.texts.dashboardDataText) : null;
    var sameAsBefore = prevHash && prevHash === C.hashText(texts.dashboardDataText);
    state.model = model;
    state.texts = texts;
    state.loadedAt = new Date();
    state.source = source;
    state.stale = null;
    state.notes = (notes || []).slice();
    if (sameAsBefore && source !== 'cache') state.notes.push('dashboard_data.json は前回読込時と同一内容です。');
    if (source !== 'cache') writeCache(texts);
    if (!state.period || model.periods.indexOf(state.period) === -1 || source !== 'cache') state.period = model.period || model.periods[0] || null;
    populateFilters();
    render();
    return true;
  }

  function writeCache(texts) {
    storageSet(CACHE_KEY, JSON.stringify({ texts: texts, loadedAt: new Date().toISOString() }));
  }
  function readCache() {
    var raw = storageGet(CACHE_KEY);
    if (!raw) return null;
    try {
      var o = JSON.parse(raw);
      if (o && o.texts && typeof o.texts.dashboardDataText === 'string' && C.safeParseJSON(o.texts.dashboardDataText).ok) return o;
    } catch (e) { /* 壊れたキャッシュは使わない */ }
    return null;
  }

  // ローカルファイル選択（ブラウザ内で読むだけで送信しない）
  function loadFromFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    Promise.all(files.map(function (f) {
      return f.text().then(function (t) { return { name: f.name, text: t }; });
    })).then(function (list) {
      var d = C.dedupeSourceFiles(list);
      var notes = d.duplicates.map(function (x) { return '同一内容のファイル「' + x.name + '」が二重に選択されたため、1件として扱いました。'; });
      var roles = { dashboardDataText: [], propertyMasterText: [], validationReportText: [] }, unknown = [];
      d.unique.forEach(function (f) {
        var role = classifyFile(f);
        if (role) roles[role].push(f); else unknown.push(f.name);
      });
      unknown.forEach(function (n) { notes.push('「' + n + '」は種類を判別できなかったため読み込みませんでした。'); });
      var multi = Object.keys(roles).filter(function (k) { return roles[k].length > 1; });
      if (multi.length) {
        showTransientError('同じ種類のファイルが複数選択されています: ' + multi.map(function (k) { return roles[k].map(function (f) { return f.name; }).join(' / '); }).join('、') + '。1種類につき1ファイルを選択してください。');
        return;
      }
      if (!roles.dashboardDataText.length) {
        // JSON として読めないファイルが dashboard_data の可能性があれば構文エラーとして扱う
        var jsonLike = d.unique.filter(function (f) { return /\.json$/i.test(f.name); });
        if (jsonLike.length) { failLoad('dashboard_data.json: ' + C.safeParseJSON(jsonLike[0].text).error, true); return; }
        showTransientError('dashboard_data.json が選択されていません。');
        return;
      }
      var cur = state.source === 'files' && state.texts ? state.texts : {};
      applyTexts({
        dashboardDataText: roles.dashboardDataText[0].text,
        propertyMasterText: roles.propertyMasterText.length ? roles.propertyMasterText[0].text : (cur.propertyMasterText || null),
        validationReportText: roles.validationReportText.length ? roles.validationReportText[0].text : (cur.validationReportText || null)
      }, 'files', notes);
    });
  }

  function classifyFile(f) {
    if (/\.json$/i.test(f.name) || /^\s*[{[]/.test(f.text.replace(/^﻿/, ''))) {
      return C.safeParseJSON(f.text).ok ? 'dashboardDataText' : null;
    }
    var headers = C.parseCSV(f.text.split(/\r?\n/).slice(0, 2).join('\n')).headers;
    if (C.mapColumns(headers, CFG.validationReportColumns).map.file_name !== undefined) return 'validationReportText';
    if (C.mapColumns(headers, CFG.masterColumns).map.project_number !== undefined) return 'propertyMasterText';
    return null;
  }

  function showTransientError(msg) {
    state.notes = [msg];
    if (state.model) render(); else renderLoadError(msg);
  }

  // ---------- フィルター ----------

  function setOptions(sel, options, keep) {
    var cur = keep ? sel.value : '';
    clear(sel);
    options.forEach(function (o) { sel.appendChild(h('option', { value: o[0], text: o[1] })); });
    if (options.some(function (o) { return o[0] === cur; })) sel.value = cur;
  }

  function uniqueSorted(list) {
    var seen = {};
    return list.filter(function (v) { if (v === null || v === undefined || v === '' || seen[v]) return false; seen[v] = true; return true; }).sort();
  }

  function populateFilters() {
    var m = state.model;
    setOptions($('f-period'), m.periods.map(function (p) {
      return [p, C.formatPeriod(p) + (p === m.period ? '（対象週）' : '')];
    }), false);
    if (state.period) $('f-period').value = state.period;
    var recs = C.recordsForPeriod(m, state.period);
    var keys = uniqueSorted(recs.map(function (r) { return r.key; }));
    setOptions($('f-project'), [['', 'すべて']].concat(keys.map(function (k) { return [k, k]; })), true);
    ['spc', 'am', 'pm'].forEach(function (f) {
      var vals = uniqueSorted(recs.map(function (r) { return C.displayName(r, f); }));
      setOptions($('f-' + f), [['', 'すべて']].concat(vals.map(function (v) { return [v, v]; })), true);
    });
    setOptions($('f-band'), [['', 'すべて']].concat(CFG.occupancyBands.map(function (b) { return [b.id, b.label]; }), [['none', 'データなし']]), true);
    setOptions($('f-confidence'), [['', 'すべて'], ['high', '高（high）'], ['medium', '中（medium）'], ['low', '低（low）'], ['none', 'データなし']], true);
    setOptions($('f-alert'), [['', 'すべて'], ['yes', 'アラートあり'], ['no', 'アラートなし']], true);
    setOptions($('f-duplicate'), [['', 'すべて'], ['yes', '重複候補のみ'], ['no', '重複なし']], true);
  }

  function readFilters() {
    return {
      projectNumber: $('f-project').value,
      projectName: $('f-project-name').value.trim(),
      propertyNameJa: $('f-name-ja').value.trim(),
      spc: $('f-spc').value, am: $('f-am').value, pm: $('f-pm').value,
      band: $('f-band').value, confidence: $('f-confidence').value,
      alert: $('f-alert').value, duplicate: $('f-duplicate').value
    };
  }

  function filtersActive(f) { return Object.keys(f).some(function (k) { return !!f[k]; }); }

  // ---------- 描画 ----------

  function ctx() {
    var m = state.model;
    var period = state.period;
    var alerts = C.computeAlerts(m, period, CFG);
    var all = C.recordsForPeriod(m, period);
    var f = readFilters();
    var recs = C.filterRecords(all, f, alerts, CFG);
    var prevP = C.previousPeriod(m, period);
    var prevAll = prevP ? C.recordsForPeriod(m, prevP) : [];
    var keys = {};
    recs.forEach(function (r) { keys[r.key] = true; });
    var prevRecs = filtersActive(f) ? prevAll.filter(function (r) { return keys[r.key]; }) : prevAll;
    var prevByKey = {};
    prevAll.forEach(function (r) { if (!r.duplicate) prevByKey[r.key] = r; });
    return { m: m, period: period, prevPeriod: prevP, alerts: alerts, all: all, recs: recs, prevRecs: prevRecs, prevByKey: prevByKey, filters: f, filtered: filtersActive(f) };
  }

  function render() {
    if (!state.model) return;
    var c = ctx();
    c.summary = C.summarize(c.recs, c.prevRecs, c.m, CFG);
    renderHeader(c);
    renderBanners(c);
    renderTabs(c);
    $('filters').hidden = state.tab === 'validation';
    var views = { summary: renderSummary, list: renderList, alerts: renderAlerts, detail: renderDetail, validation: renderValidation };
    Object.keys(views).forEach(function (k) {
      var el = $('view-' + k);
      el.hidden = k !== state.tab;
      if (k === state.tab) { clear(el); views[k](el, c); }
    });
  }

  function renderHeader(c) {
    var m = c.m, meta = m.meta, el = clear($('header-meta'));
    var item = function (label, value) { return h('span', null, [label + ': ', h('strong', { text: value })]); };
    el.appendChild(item('対象週', meta.source_period ? C.formatPeriod(m.period) + '（source_period: ' + meta.source_period + '）' : CFG.display.nullLabel));
    if (c.period !== m.period) el.appendChild(item('表示中の基準週', C.formatPeriod(c.period)));
    el.appendChild(item('レポート日', meta.report_date || CFG.display.nullLabel));
    el.appendChild(item('処理/想定', C.fmtCount(meta.file_count_processed, CFG, meta.file_count_processed_invalid) + ' / ' + C.fmtCount(meta.file_count_expected, CFG, meta.file_count_expected_invalid)));
    el.appendChild(item('失敗', C.fmtCount(meta.file_count_failed, CFG, meta.file_count_failed_invalid)));
    if (c.summary.provisional) el.appendChild(provisionalBadge(c.summary.provisionalReasons));
    if (meta.is_sample) el.appendChild(badge('架空サンプル', 'sample'));
    var src = state.source === 'files' ? 'ローカルファイル' : state.source === 'cache' ? '前回データ（ブラウザ保存）' : 'data/ フォルダ';
    el.appendChild(h('span', { class: 'muted', text: '読込元: ' + src + ' / 読込 ' + fmtTime(state.loadedAt) }));
  }

  function fmtTime(d) {
    if (!d) return '';
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function renderBanners(c) {
    var el = clear($('banners')), m = c.m;
    var add = function (kind, title, text) { el.appendChild(h('div', { class: 'banner banner-' + kind, role: kind === 'error' ? 'alert' : 'status' }, [h('strong', { text: title }), text])); };
    if (state.stale) {
      add('error', '最新データを反映できません', state.stale.reason + ' — 前回正常に読み込んだデータ（' + (state.stale.cachedAt ? state.stale.cachedAt.replace('T', ' ').slice(0, 19) : fmtTime(state.loadedAt)) + ' 読込）を表示しています。');
    }
    if (m.meta.is_sample) add('info', '架空サンプルデータ', 'このデータは動作確認用の架空データです。実在の物件・数値ではありません。');
    if (!m.publishable) {
      add('error', '公開条件を満たしていません', 'JSON構文・ファイル件数の突合・全ファイルの検証行のいずれかに問題があります。「データ検証」を確認してください。');
    }
    if (m.summarySource.status === 'not_calculated') {
      add('warning', 'ポートフォリオ集計は未算出', '元データ側で集計されていません（理由: ' + (m.summarySource.reason_label ? m.summarySource.reason_label + ' / ' : '') + (m.summarySource.reason || '記載なし') + '）。推測による補完は行いません。');
    }
    var failed = m.files.filter(function (f) { return f.result === 'failed'; }).length;
    if (failed) add('warning', '読取失敗ファイル ' + failed + '件', '想定 ' + C.fmtCount(m.meta.file_count_expected, CFG) + 'ファイル中 ' + failed + 'ファイルの内容を取得できていません。該当物件の値は「データなし」です。');
    if (m.meta.contains_personal_data === true) add('warning', '個人情報フラグ', '元データに個人情報が含まれる可能性があります。該当しうる列・文字列は除外・伏字化しています。');
    state.notes.forEach(function (n) { add('info', 'お知らせ', n); });
  }

  function renderTabs(c) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.setAttribute('aria-selected', t.getAttribute('data-tab') === state.tab ? 'true' : 'false');
      var old = t.querySelector('.count');
      if (old) t.removeChild(old);
      if (t.getAttribute('data-tab') === 'alerts') {
        // 同じ物件・ファイルが複数区分に該当しても 1 件と数える
        var targets = {};
        c.alerts.categories.forEach(function (cat) {
          cat.items.forEach(function (i) { if (!i.fromSource) targets[i.project_number ? 'p:' + i.project_number : i.file_name ? 'f:' + i.file_name : 'm:' + i.message] = true; });
        });
        var n = Object.keys(targets).length;
        if (n) t.appendChild(h('span', { class: 'count', text: String(n), 'data-tip': 'アラート対象の物件・ファイル数' }));
      }
    });
  }

  // ---------- 1. ポートフォリオサマリー ----------

  function kpi(label, valueText, isNull, sub, opts) {
    opts = opts || {};
    return h('div', { class: 'kpi' }, [
      h('div', { class: 'kpi-label' }, [label, opts.provisional ? provisionalBadge(opts.reasons) : null]),
      h('div', { class: 'kpi-value' + (isNull ? ' is-null' : ''), text: valueText }),
      sub ? h('div', { class: 'kpi-sub' }, sub) : null,
      opts.note ? h('div', { class: 'kpi-sub muted', text: opts.note }) : null
    ]);
  }

  function deltaSpan(text, d, goodWhenUp) {
    if (d === null || d === undefined) return h('span', { class: 'muted', text: text });
    var cls = d === 0 ? '' : ((d > 0) === goodWhenUp ? 'delta-up' : 'delta-down');
    var arrow = d > 0 ? '▲ ' : d < 0 ? '▼ ' : '± ';
    return h('span', { class: cls, text: arrow + text });
  }

  function renderSummary(el, c) {
    var s = c.summary, d = s.delta;
    var prov = { provisional: s.provisional, reasons: s.provisionalReasons };
    var wow = function (f, unit, goodUp) {
      if (!c.prevPeriod) return '前週比: 前週データなし';
      if (!d || d[f] === null || d[f] === undefined) return '前週比: ' + CFG.display.nullLabel;
      var t = f === 'occupancy' || f === 'afterApplication' ? C.fmtPt(d[f], CFG) : C.fmtDelta(d[f], CFG, unit);
      return ['前週比: ', deltaSpan(t, d[f], goodUp)];
    };
    var missingNote = function (r) {
      var parts = [];
      if (r.missing) parts.push(r.missing + '物件データなし');
      if (r.invalid) parts.push(r.invalid + '物件数値不正');
      return parts.length ? parts.join(' / ') : null;
    };
    if (c.all.length === 0) {
      el.appendChild(h('div', { class: 'banner banner-warning' }, [h('strong', { text: '物件レコード 0件' }),
        '基準週 ' + C.formatPeriod(c.period) + ' の物件データがありません。集計値は 0 ではなく「データなし」と表示します。']));
    }
    var grid = h('div', { class: 'kpis' });
    grid.appendChild(kpi('対象物件数', C.fmtCount(s.propertyCount.value, CFG), false, wow('propertyCount', '件', true), {
      note: s.excluded ? '集計除外 ' + s.excluded + '件（重複・未紐付け）' : (c.all.length === 0 ? '物件レコードなし' : null)
    }));
    [['total_units', '総戸数', true], ['occupied_units', '稼働戸数', true], ['vacant_units', '空室戸数', false], ['application_units', '申込戸数', true],
      ['scheduled_contract_units', '契約予定戸数', true], ['scheduled_termination_units', '解約予定戸数', false]].forEach(function (x) {
      var r = s[x[0]];
      grid.appendChild(kpi(x[1], r.value === null ? CFG.display.nullLabel : C.fmtCount(r.value, CFG) + '戸', r.value === null, wow(x[0], '戸', x[2]),
        Object.assign({ note: missingNote(r) }, r.value !== null ? prov : {})));
    });
    grid.appendChild(kpi('ポートフォリオ稼働率', C.fmtRate(s.occupancy.value, CFG), s.occupancy.value === null, wow('occupancy', '', true),
      Object.assign({ note: s.occupancy.value === null ? '算出対象なし' : '稼働 ÷ 総戸数（' + s.occupancy.count + '物件）' + (s.occupancy.missing ? ' / ' + s.occupancy.missing + '物件データなし' : '') }, s.occupancy.value !== null ? prov : {})));
    grid.appendChild(kpi('申込反映後稼働率', C.fmtRate(s.afterApplication.value, CFG), s.afterApplication.value === null, wow('afterApplication', '', true),
      Object.assign({ note: s.afterApplication.value === null ? '算出対象なし（3値が揃い元データが算出を許容した物件のみ）' : '(稼働＋申込) ÷ 総戸数（' + s.afterApplication.count + '物件）' }, s.afterApplication.value !== null ? prov : {})));
    el.appendChild(grid);

    // 前週比
    var wowBody;
    if (!c.prevPeriod) wowBody = h('p', { class: 'note', text: '比較できる前週のデータがありません（' + CFG.display.notJudgedLabel + '）。' });
    else {
      wowBody = h('dl', { class: 'kv' }, [
        h('dt', { text: '比較週' }), h('dd', { text: C.formatPeriod(c.prevPeriod) + ' → ' + C.formatPeriod(c.period) }),
        h('dt', { text: '比較対象' }), h('dd', { text: '両週とも値がある物件のみ（稼働率: ' + (d ? d.occupancy_matched : 0) + '物件）' + (d && d.partial ? '。物件構成または欠損が異なるため参考値です。' : '') }),
        h('dt', { text: '稼働率の差' }), h('dd', null, d && d.occupancy !== null ? deltaSpan(C.fmtPt(d.occupancy, CFG), d.occupancy, true) : CFG.display.nullLabel),
        h('dt', { text: '前週の稼働率（全体）' }), h('dd', { text: s.prev ? C.fmtRate(s.prev.occupancy.value, CFG) : CFG.display.nullLabel })
      ]);
    }
    var head = s.provisional ? provisionalBadge(s.provisionalReasons) : null;
    var top = h('div', { class: 'grid-2' }, [
      card('前週比', wowBody),
      card('集計の状態', h('div', null, [
        s.provisional ? h('p', null, [provisionalBadge(s.provisionalReasons), ' 次の理由により暫定集計です。']) : h('p', { text: '確定集計です。' }),
        s.provisionalReasons.length ? h('ul', { class: 'change-list' }, s.provisionalReasons.map(function (r) { return h('li', { text: r }); })) : null,
        c.filtered ? h('p', { class: 'note', text: 'フィルター適用中: 表示中の物件のみで集計しています。' }) : null
      ]), head)
    ]);
    el.appendChild(top);

    var eligible = c.recs.filter(function (r) { return r.key && !r.duplicate; });
    // チャート
    var occRows = eligible.map(function (r) {
      return { label: rowLabel(r), value: r.occupancy, tip: rowLabel(r) + '\n稼働率 ' + C.fmtRate(r.occupancy, CFG) + '\n稼働 ' + C.fmtCount(r.values.occupied_units, CFG) + ' / 総戸数 ' + C.fmtCount(r.values.total_units, CFG) };
    }).sort(function (a, b) { return nullLast(a.value, b.value, 1); });
    var chartsTop = h('div', { class: 'grid-2' }, [
      card('物件別稼働率', barChart(occRows, { max: 1, fmt: function (v) { return C.fmtRate(v, CFG); }, cls: 's1' })),
      card('空室・申込・解約予定（戸）', groupedBarChart(eligible.map(function (r) {
        return { label: rowLabel(r), values: [r.values.vacant_units, r.values.application_units, r.values.scheduled_termination_units], invalid: [r.invalid.vacant_units, r.invalid.application_units, r.invalid.scheduled_termination_units] };
      }), [{ name: '空室戸数', cls: 's1' }, { name: '申込戸数', cls: 's2' }, { name: '解約予定戸数', cls: 's3' }]),
      h('span', { class: 'note', text: '各値は重なりうるため積み上げず並べて表示' }))
    ]);
    el.appendChild(chartsTop);
    var longRows = eligible.filter(function (r) { return C.isNum(r.values.maximum_vacancy_days); }).map(function (r) {
      return { label: rowLabel(r), value: r.values.maximum_vacancy_days, tip: rowLabel(r) + '\n最大空室日数 ' + r.values.maximum_vacancy_days + '日\n長期空室 ' + C.fmtCount(r.values.long_vacancy_units, CFG) + '戸\n平均空室日数 ' + C.fmtCount(r.values.average_vacancy_days, CFG) + '日' };
    }).sort(function (a, b) { return b.value - a.value; }).slice(0, 10);
    var noDays = eligible.length - longRows.length;
    el.appendChild(h('div', { class: 'grid-2' }, [
      card('長期空室ランキング（最大空室日数）', h('div', null, [
        barChart(longRows, { fmt: function (v) { return Math.round(v) + '日'; }, cls: 's2', threshold: CFG.alerts.longVacancyDays, thresholdLabel: '基準 ' + CFG.alerts.longVacancyDays + '日' }),
        noDays > 0 && longRows.length ? h('p', { class: 'note', text: noDays + '物件は空室日数データなし' }) : null
      ])),
      card('リーシングファネル（反響→申込）', funnel([
        ['反響', s.inquiry_count], ['内見', s.viewing_count], ['申込', s.application_count], ['契約', s.contract_count]
      ]), s.provisional && s.inquiry_count.value !== null ? provisionalBadge(s.provisionalReasons) : null)
    ]));
    // 前週からの主要変化
    var changes = c.recs.filter(function (r) { return r.text.major_change_from_previous_week; });
    el.appendChild(card('前週からの主要変化', changes.length ? h('ul', { class: 'change-list' }, changes.map(function (r) {
      return h('li', null, [h('button', { type: 'button', class: 'linklike', text: rowLabel(r), onclick: function () { openDetail(r.key); } }), '：', r.text.major_change_from_previous_week]);
    })) : empty(c.recs.length ? '主要変化の記載はありません' : CFG.display.nullLabel)));
  }

  function rowLabel(r) {
    var n = C.displayName(r, 'property_name_ja') || C.displayName(r, 'project_name');
    return (r.key || '（Project # なし）') + (n ? ' ' + n : '');
  }

  function nullLast(a, b, dir) {
    var an = a === null || a === undefined, bn = b === null || b === undefined;
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    if (typeof a === 'string' || typeof b === 'string') return String(a).localeCompare(String(b), 'ja') * dir;
    return (a - b) * dir;
  }

  // ---------- チャート（インライン SVG、外部ライブラリなし） ----------

  function barChart(rows, opts) {
    if (!rows.length) return empty(CFG.display.nullLabel);
    var W = 640, labelW = 190, valueW = 70, rowH = 24, top = 8, H = top + rows.length * rowH + 20;
    var plotW = W - labelW - valueW;
    var max = opts.max || Math.max.apply(null, rows.map(function (r) { return C.isNum(r.value) ? r.value : 0; }).concat([opts.threshold || 0, 1]));
    var svgEl = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': '棒グラフ' });
    [0, 0.25, 0.5, 0.75, 1].forEach(function (t) {
      var x = labelW + plotW * t;
      svgEl.appendChild(s('line', { x1: x, x2: x, y1: top, y2: H - 18, class: 'grid-line' }));
      svgEl.appendChild(s('text', { x: x, y: H - 4, 'text-anchor': 'middle', text: opts.fmt(max * t) }));
    });
    if (opts.threshold) {
      var tx = labelW + plotW * Math.min(1, opts.threshold / max);
      svgEl.appendChild(s('line', { x1: tx, x2: tx, y1: top, y2: H - 18, class: 'axis-line', 'stroke-dasharray': '4 3' }));
    }
    rows.forEach(function (r, i) {
      var y = top + i * rowH;
      svgEl.appendChild(s('text', { x: labelW - 8, y: y + 16, 'text-anchor': 'end', class: 'label-strong', text: truncate(r.label, 24) }));
      if (C.isNum(r.value)) {
        var w = Math.max(2, plotW * Math.min(1, r.value / max));
        svgEl.appendChild(s('rect', { x: labelW, y: y + 6, width: w, height: 12, rx: 3, class: 'bar ' + opts.cls }));
        svgEl.appendChild(s('text', { x: labelW + w + 6, y: y + 16, text: opts.fmt(r.value) }));
      } else {
        svgEl.appendChild(s('text', { x: labelW + 4, y: y + 16, text: CFG.display.nullLabel }));
      }
      svgEl.appendChild(s('rect', { x: 0, y: y, width: W, height: rowH, class: 'hit', 'data-tip': r.tip || (r.label + '\n' + (C.isNum(r.value) ? opts.fmt(r.value) : CFG.display.nullLabel)) }));
    });
    return h('div', { class: 'chart' }, [opts.thresholdLabel ? h('div', { class: 'legend' }, [h('span', { text: '破線: ' + opts.thresholdLabel })]) : null, svgEl]);
  }

  function groupedBarChart(rows, series) {
    if (!rows.length) return empty(CFG.display.nullLabel);
    var W = 640, labelW = 190, valueW = 40, barH = 7, gap = 2, rowH = series.length * (barH + gap) + 10, top = 6;
    var H = top + rows.length * rowH + 20, plotW = W - labelW - valueW;
    var max = 1;
    rows.forEach(function (r) { r.values.forEach(function (v) { if (C.isNum(v) && v > max) max = v; }); });
    var svgEl = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': '空室・申込・解約予定の棒グラフ' });
    [0, 0.5, 1].forEach(function (t) {
      var x = labelW + plotW * t;
      svgEl.appendChild(s('line', { x1: x, x2: x, y1: top, y2: H - 18, class: 'grid-line' }));
      svgEl.appendChild(s('text', { x: x, y: H - 4, 'text-anchor': 'middle', text: String(Math.round(max * t)) }));
    });
    rows.forEach(function (r, i) {
      var y = top + i * rowH;
      svgEl.appendChild(s('text', { x: labelW - 8, y: y + rowH / 2 + 3, 'text-anchor': 'end', class: 'label-strong', text: truncate(r.label, 24) }));
      var tip = [r.label];
      series.forEach(function (se, j) {
        var v = r.values[j], by = y + 4 + j * (barH + gap);
        tip.push(se.name + ' ' + (r.invalid && r.invalid[j] ? CFG.display.invalidLabel : C.isNum(v) ? v + '戸' : CFG.display.nullLabel));
        if (C.isNum(v)) {
          var w = v === 0 ? 0 : Math.max(2, plotW * v / max);
          if (w) svgEl.appendChild(s('rect', { x: labelW, y: by, width: w, height: barH, rx: 2, class: 'bar ' + se.cls }));
          svgEl.appendChild(s('text', { x: labelW + w + 4, y: by + barH - 0.5, text: String(v) }));
        } else {
          svgEl.appendChild(s('text', { x: labelW + 4, y: by + barH - 0.5, text: '—' }));
        }
      });
      svgEl.appendChild(s('rect', { x: 0, y: y, width: W, height: rowH, class: 'hit', 'data-tip': tip.join('\n') }));
    });
    return h('div', { class: 'chart' }, [legend(series), svgEl, h('p', { class: 'note', text: '「—」はデータなし' })]);
  }

  function legend(series) {
    return h('div', { class: 'legend' }, series.map(function (se) { return h('span', null, [h('i', { class: se.legendCls || se.cls }), se.name]); }));
  }

  function funnel(stages, width) {
    var vals = stages.map(function (x) { return x[1] && x[1].value !== undefined ? x[1].value : x[1]; });
    if (vals.every(function (v) { return v === null || v === undefined; })) return empty(CFG.display.nullLabel);
    var max = Math.max.apply(null, vals.map(function (v) { return C.isNum(v) ? v : 0; }).concat([1]));
    var W = width || 640, labelW = 70, rowH = 34, H = stages.length * rowH + 6, plotW = W - labelW - 190;
    var svgEl = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'リーシングファネル' });
    stages.forEach(function (st, i) {
      var v = vals[i], y = 4 + i * rowH;
      svgEl.appendChild(s('text', { x: labelW - 8, y: y + 19, 'text-anchor': 'end', class: 'label-strong', text: st[0] }));
      var conv = i > 0 && C.isNum(v) && C.isNum(vals[i - 1]) && vals[i - 1] > 0 ? '（前段比 ' + C.fmtRate(v / vals[i - 1], CFG) + '）' : '';
      if (C.isNum(v)) {
        var w = v === 0 ? 0 : Math.max(2, plotW * v / max);
        if (w) svgEl.appendChild(s('rect', { x: labelW, y: y + 6, width: w, height: 18, rx: 3, class: 'bar f' + (i + 1) }));
        svgEl.appendChild(s('text', { x: labelW + w + 6, y: y + 19, text: C.fmtCount(v, CFG) + '件' + conv }));
      } else svgEl.appendChild(s('text', { x: labelW + 4, y: y + 19, text: CFG.display.nullLabel }));
      var partial = stages[i][1] && stages[i][1].missing ? '\n' + stages[i][1].missing + '物件データなし' : '';
      svgEl.appendChild(s('rect', { x: 0, y: y, width: W, height: rowH, class: 'hit', 'data-tip': st[0] + ' ' + (C.isNum(v) ? C.fmtCount(v, CFG) + '件' : CFG.display.nullLabel) + conv + partial }));
    });
    return h('div', { class: 'chart' }, [svgEl]);
  }

  function lineChart(periods, series, fmt) {
    var hasAny = series.some(function (se) { return se.values.some(C.isNum); });
    if (!hasAny) return empty(CFG.display.nullLabel);
    var W = 640, H = 220, L = 50, R = 20, T = 14, B = 30;
    var all = [];
    series.forEach(function (se) { se.values.forEach(function (v) { if (C.isNum(v)) all.push(v); }); });
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    var pad = Math.max(0.01, (hi - lo) * 0.2);
    lo = Math.max(0, lo - pad); hi = Math.min(1, hi + pad);
    if (hi - lo < 0.02) { lo = Math.max(0, lo - 0.01); hi = Math.min(1, hi + 0.01); }
    var x = function (i) { return periods.length === 1 ? L + (W - L - R) / 2 : L + (W - L - R) * i / (periods.length - 1); };
    var y = function (v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo)); };
    var svgEl = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': '週次推移の折れ線グラフ' });
    for (var g = 0; g <= 4; g++) {
      var v = lo + (hi - lo) * g / 4;
      svgEl.appendChild(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid-line' }));
      svgEl.appendChild(s('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end', text: fmt(v) }));
    }
    periods.forEach(function (p, i) { svgEl.appendChild(s('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', text: C.formatPeriod(p) })); });
    series.forEach(function (se, si) {
      // null は線を途切れさせる（0 として描かない）
      var d = '', pen = false;
      se.values.forEach(function (v, i) {
        if (!C.isNum(v)) { pen = false; return; }
        d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' ';
        pen = true;
      });
      if (d) svgEl.appendChild(s('path', { d: d, class: 'line-' + (si + 1) }));
      se.values.forEach(function (v, i) {
        if (C.isNum(v)) svgEl.appendChild(s('circle', { cx: x(i), cy: y(v), r: 4.5, class: 'dot-' + (si + 1) }));
      });
    });
    periods.forEach(function (p, i) {
      var tip = [C.formatPeriod(p)].concat(series.map(function (se) { return se.name + ' ' + (C.isNum(se.values[i]) ? fmt(se.values[i]) : CFG.display.nullLabel); }));
      var w = periods.length === 1 ? W - L - R : (W - L - R) / (periods.length - 1);
      svgEl.appendChild(s('rect', { x: x(i) - w / 2, y: T, width: w, height: H - T - B, class: 'hit', 'data-tip': tip.join('\n') }));
    });
    return h('div', { class: 'chart chart-line' }, [legend(series.map(function (se, i) { return { name: se.name, legendCls: 'l' + (i + 1) }; })), svgEl]);
  }

  function truncate(t, n) { t = String(t); return t.length > n ? t.slice(0, n - 1) + '…' : t; }

  // ---------- 2. 物件一覧 ----------

  var LIST_COLUMNS = [
    { key: 'key', label: 'Project #', get: function (r) { return r.key; } },
    { key: 'project_name', label: 'Project Name', get: function (r) { return C.displayName(r, 'project_name'); } },
    { key: 'property_name_ja', label: '日本語物件名', get: function (r) { return C.displayName(r, 'property_name_ja'); } },
    { key: 'spc', label: 'SPC', get: function (r) { return C.displayName(r, 'spc'); } },
    { key: 'am', label: 'AM', get: function (r) { return C.displayName(r, 'am'); } },
    { key: 'pm', label: 'PM', get: function (r) { return C.displayName(r, 'pm'); } },
    { key: 'total_units', label: '総戸数', num: true },
    { key: 'vacant_units', label: '空室戸数', num: true },
    { key: 'occupancy', label: '稼働率', num: true, rate: true, get: function (r) { return r.occupancy; } },
    { key: 'application_count', label: '申込件数', num: true },
    { key: 'scheduled_termination_units', label: '解約予定戸数', num: true },
    { key: 'major_change', label: '前週からの主要変化', get: function (r) { return r.text.major_change_from_previous_week; } },
    { key: 'confidence', label: 'データ確度', get: function (r) { return { high: 3, medium: 2, low: 1 }[r.confidence] || null; } }
  ];

  function colValue(col, r) { return col.get ? col.get(r) : (r.invalid[col.key] ? null : r.values[col.key]); }

  function renderList(el, c) {
    var col = LIST_COLUMNS.filter(function (x) { return x.key === state.sort.key; })[0] || LIST_COLUMNS[0];
    var rows = c.recs.slice().sort(function (a, b) { return nullLast(colValue(col, a), colValue(col, b), state.sort.dir); });
    var exportBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-small', text: 'CSV出力（個人情報を含まない列のみ）', onclick: function () { exportCSV(rows, c.period); } });
    if (!rows.length) {
      el.appendChild(card('物件一覧', empty(c.all.length ? '条件に一致する物件はありません' : '物件レコードがありません（' + CFG.display.nullLabel + '）')));
      return;
    }
    var thead = h('tr', null, LIST_COLUMNS.map(function (x) {
      return h('th', {
        class: 'sortable' + (x.num ? ' num' : ''), scope: 'col', tabindex: '0',
        'aria-sort': x.key === state.sort.key ? (state.sort.dir === 1 ? 'ascending' : 'descending') : null,
        onclick: function () { sortBy(x.key); }, onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sortBy(x.key); } }
      }, x.label + (x.key === 'occupancy' ? '' : ''));
    }).concat([h('th', { text: '検証' })]));
    var tbody = h('tbody', null, rows.map(function (r) {
      var cells = LIST_COLUMNS.map(function (x) {
        if (x.key === 'confidence') return h('td', null, confBadge(r.confidence));
        if (x.key === 'key') return h('td', null, h('button', { type: 'button', class: 'linklike', text: r.key || '（なし）', onclick: function (e) { e.stopPropagation(); openDetail(r.key); } }));
        if (x.rate) return numCell(C.fmtRate(r.occupancy, CFG), r.occupancy === null);
        if (x.num) return numCell(C.fmtCount(r.values[x.key], CFG, r.invalid[x.key]), r.values[x.key] === null);
        var v = colValue(x, r);
        if ((x.key === 'project_name' || x.key === 'property_name_ja') && !r.linked) {
          return h('td', null, [r.names[x.key + '_unlinked'] || CFG.display.nullLabel, ' ', badge('マスター未登録', 'sev-error')]);
        }
        var cls = (v === null || v === undefined ? 'null ' : '') + (x.key === 'major_change' ? 'cell-wrap' : 'nowrap');
        return h('td', { class: cls, text: v === null || v === undefined ? CFG.display.nullLabel : v });
      });
      cells.push(h('td', null, validationBadges(r, c)));
      return h('tr', { class: 'row-link', onclick: function () { openDetail(r.key); } }, cells);
    }));
    var unit = h('span', { class: 'note', text: '戸数は戸、稼働率は % 表示。物件名・SPC・AM・PM は property_master.csv を正としています。' });
    el.appendChild(card('物件一覧（' + rows.length + '件 / 基準週 ' + C.formatPeriod(c.period) + '）', h('div', null, [unit, h('div', { class: 'table-wrap' }, h('table', null, [h('thead', null, thead), tbody]))]), exportBtn));
  }

  function validationBadges(r, c) {
    var out = [];
    if (r.duplicate) out.push(badge('重複候補', 'sev-error'));
    if (!r.linked) out.push(badge('未紐付け', 'sev-error'));
    if (r.hasInvalid) out.push(badge('数値不正', 'sev-error'));
    var mis = r.checks.filter(function (x) { return /mismatch/.test(x.type); });
    if (mis.length) out.push(badge('不一致 ' + mis.length, 'sev-warning', mis.map(function (x) { return x.message; }).join('\n')));
    var al = c.alerts.byProject[r.key];
    if (al && al.length) out.push(badge('アラート ' + al.length, 'sev-warning', uniqueSorted(al).join('\n')));
    if (c.summary.provisional && r.confidence !== 'high') out.push(badge(CFG.display.provisionalLabel, 'provisional'));
    return out.length ? out : [h('span', { class: 'muted', text: '—' })];
  }

  function sortBy(key) {
    if (state.sort.key === key) state.sort.dir *= -1;
    else state.sort = { key: key, dir: 1 };
    render();
  }

  function exportCSV(rows, period) {
    var blob = new Blob([C.exportRecordsCSV(rows)], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: 'leasing_properties_' + (period || 'unknown') + '.csv' });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------- 3. アラート ----------

  function renderAlerts(el, c) {
    var keys = {};
    c.recs.forEach(function (r) { keys[r.key] = true; });
    var visible = function (it) { return !it.project_number || !c.filtered || keys[it.project_number]; };
    var cards = h('div', { class: 'alert-cards' });
    c.alerts.categories.forEach(function (cat) {
      var items = cat.items.filter(visible);
      var own = items.filter(function (i) { return !i.fromSource; });
      var src = items.length - own.length;
      var countText = !cat.judgeable && !items.length ? CFG.display.notJudgedLabel : String(cat.key === 'read_failure' ? own.filter(function (i) { return i.file_name; }).length : own.length);
      cards.appendChild(h('button', {
        type: 'button', class: 'alert-card' + (own.length || src ? ' has-items' : '') + (!cat.judgeable && !items.length ? ' not-judged' : ''),
        'aria-pressed': state.alertCat === cat.key ? 'true' : 'false',
        onclick: function () { state.alertCat = state.alertCat === cat.key ? null : cat.key; render(); }
      }, [
        h('div', { class: 'kpi-label', text: cat.label }),
        h('div', { class: 'alert-count' + (countText === CFG.display.notJudgedLabel ? ' is-null' : ''), text: countText }),
        src ? h('div', { class: 'kpi-sub', text: '＋元データ通知 ' + src + '件' }) : null,
        cat.note ? h('div', { class: 'kpi-sub muted', text: cat.note }) : null,
        cat.notJudged && cat.judgeable ? h('div', { class: 'kpi-sub muted', text: cat.notJudged + '物件は判定不可' }) : null
      ]));
    });
    el.appendChild(h('p', { class: 'note', text: '基準週 ' + C.formatPeriod(c.period) + (c.alerts.prevPeriod ? '（比較週 ' + C.formatPeriod(c.alerts.prevPeriod) + '）' : '（比較できる前週なし）') + '。カードを押すと区分で絞り込みます。「判定不可」は判定に必要なデータがないことを示し、0件とは区別しています。' }));
    el.appendChild(cards);

    // 区分を選んでいない場合は区分ごとに先頭 PREVIEW 件だけ表示する
    var PREVIEW = 5;
    var rows = [], total = 0;
    c.alerts.categories.forEach(function (cat) {
      if (state.alertCat && state.alertCat !== cat.key) return;
      var items = cat.items.filter(visible);
      total += items.length;
      var shown = state.alertCat ? items : items.slice(0, PREVIEW);
      shown.forEach(function (it) { rows.push({ cat: cat, it: it }); });
      if (shown.length < items.length) rows.push({ cat: cat, more: items.length - shown.length });
    });
    var recByKey = {};
    c.all.forEach(function (r) { recByKey[r.key] = r; });
    var body = rows.length ? h('div', { class: 'table-wrap' }, h('table', null, [
      h('thead', null, h('tr', null, ['区分', 'Project #', '物件名', '内容', 'ファイル'].map(function (t) { return h('th', { text: t }); }))),
      h('tbody', null, rows.map(function (x) {
        if (x.more) {
          return h('tr', null, h('td', { colspan: '5' }, h('button', { type: 'button', class: 'linklike', text: x.cat.label + ' の残り ' + x.more + '件をすべて表示',
            onclick: function () { state.alertCat = x.cat.key; render(); } })));
        }
        var r = x.it.project_number ? recByKey[x.it.project_number] : null;
        return h('tr', null, [
          h('td', null, [x.cat.label, x.it.fromSource ? h('span', { class: 'muted', text: '（元データ通知）' }) : null]),
          h('td', null, x.it.project_number ? h('button', { type: 'button', class: 'linklike', text: x.it.project_number, onclick: function () { openDetail(x.it.project_number); } }) : '—'),
          h('td', { text: r ? (C.displayName(r, 'property_name_ja') || C.displayName(r, 'project_name') || CFG.display.nullLabel) : '—' }),
          h('td', { class: 'cell-wrap', text: x.it.message }),
          h('td', { class: 'cell-wrap', text: x.it.file_name || '—' })
        ]);
      }))
    ])) : empty(state.alertCat ? 'この区分のアラートはありません' : 'アラートはありません');
    el.appendChild(card('アラート一覧（' + total + '件）', h('div', null, [
      c.filtered ? h('p', { class: 'note', text: 'フィルター適用中: 物件に紐づく項目は表示中の物件のみ。ファイル単位の項目は常に表示します。' }) : null, body
    ])));
    if (c.alerts.other.length) {
      el.appendChild(card('その他の元データ通知', h('ul', { class: 'change-list' }, c.alerts.other.map(function (a) {
        return h('li', null, [sevBadge(a.severity), ' ', (a.code || '') + ': ' + (a.message || '')]);
      }))));
    }
  }

  // ---------- 4. 物件詳細 ----------

  function openDetail(key) {
    state.selectedKey = key;
    switchTab('detail');
  }

  function renderDetail(el, c) {
    var m = c.m;
    var keys = uniqueSorted(m.records.map(function (r) { return r.key; }));
    if (!keys.length) {
      el.appendChild(card('物件詳細', empty('物件レコードがありません（' + CFG.display.nullLabel + '）')));
      return;
    }
    var filteredKeys = uniqueSorted(c.recs.map(function (r) { return r.key; }));
    var choices = filteredKeys.length ? filteredKeys : keys;
    if (!state.selectedKey || keys.indexOf(state.selectedKey) === -1) state.selectedKey = choices[0];
    var key = state.selectedKey;
    var history = m.records.filter(function (r) { return r.key === key; }).sort(function (a, b) { return a.period < b.period ? -1 : 1; });
    var cur = history.filter(function (r) { return r.period === c.period; });
    var r = cur[0] || null;
    var any = r || history[history.length - 1];
    var sel = h('select', { 'aria-label': '物件を選択', onchange: function (e) { state.selectedKey = e.target.value; render(); } },
      keys.map(function (k) {
        var rr = m.records.filter(function (x) { return x.key === k; })[0];
        return h('option', { value: k, text: rowLabel(rr) });
      }));
    sel.value = key;
    el.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [h('h2', { text: rowLabel(any) }), h('label', { class: 'note' }, ['物件を選択 ', sel])]),
      h('dl', { class: 'kv' }, [
        h('dt', { text: 'Project #' }), h('dd', { text: key }),
        h('dt', { text: 'Project Name' }), h('dd', { text: C.displayName(any, 'project_name') || CFG.display.nullLabel }),
        h('dt', { text: '日本語物件名' }), h('dd', { text: C.displayName(any, 'property_name_ja') || CFG.display.nullLabel }),
        h('dt', { text: 'SPC / AM / PM' }), h('dd', { text: [C.displayName(any, 'spc'), C.displayName(any, 'am'), C.displayName(any, 'pm')].map(function (v) { return v || CFG.display.nullLabel; }).join(' / ') }),
        h('dt', { text: 'マスター紐付け' }), h('dd', null, any.linked ? '紐付け済み（property_master.csv を正として表示）' : badge('マスター未登録', 'sev-error')),
        h('dt', { text: '基準週のデータ' }), h('dd', null, r ? [C.formatPeriod(c.period), ' ', confBadge(r.confidence), cur.length > 1 ? badge('重複候補 ' + cur.length + '件', 'sev-error') : null] : C.formatPeriod(c.period) + ' のレコードなし（' + CFG.display.nullLabel + '）')
      ])
    ]));

    // 週次推移
    var periods = history.map(function (x) { return x.period; });
    var trendTable = h('div', { class: 'table-wrap' }, h('table', null, [
      h('thead', null, h('tr', null, ['基準週', '総戸数', '稼働戸数', '空室戸数', '申込戸数', '契約予定', '解約予定', '稼働率', '申込反映後', '確度'].map(function (t, i) { return h('th', { class: i && i < 9 ? 'num' : null, text: t }); }))),
      h('tbody', null, history.map(function (x) {
        return h('tr', null, [h('td', { text: C.formatPeriod(x.period) + (x.duplicate ? '（重複）' : '') })].concat(
          ['total_units', 'occupied_units', 'vacant_units', 'application_units', 'scheduled_contract_units', 'scheduled_termination_units'].map(function (f) {
            return numCell(C.fmtCount(x.values[f], CFG, x.invalid[f]), x.values[f] === null);
          }), [numCell(C.fmtRate(x.occupancy, CFG), x.occupancy === null), numCell(C.fmtRate(x.afterApplication, CFG), x.afterApplication === null), h('td', null, confBadge(x.confidence))]));
      }))
    ]));
    el.appendChild(card('週次推移', h('div', null, [
      lineChart(periods, [
        { name: '稼働率', values: history.map(function (x) { return x.occupancy; }) },
        { name: '申込反映後稼働率', values: history.map(function (x) { return x.afterApplication; }) }
      ], function (v) { return C.fmtRate(v, CFG); }),
      trendTable
    ])));

    if (!r) {
      el.appendChild(card('基準週の詳細', empty('基準週 ' + C.formatPeriod(c.period) + ' のレコードがありません')));
      return;
    }
    var v = r.values;
    var kvRow = function (label, val) { return [h('dt', { text: label }), h('dd', { text: val })]; };
    var cnt = function (f, unit) { return v[f] === null && !r.invalid[f] ? CFG.display.nullLabel : C.fmtCount(v[f], CFG, r.invalid[f]) + (r.invalid[f] ? '' : unit); };
    el.appendChild(h('div', { class: 'grid-2' }, [
      card('空室一覧の集計', h('dl', { class: 'kv' }, [].concat(
        kvRow('空室戸数', cnt('vacant_units', '戸')), kvRow('募集中戸数', cnt('leasing_units', '戸')), kvRow('新規募集戸数', cnt('new_leasing_units', '戸')),
        kvRow('長期空室戸数', cnt('long_vacancy_units', '戸')), kvRow('平均空室日数', cnt('average_vacancy_days', '日')), kvRow('最大空室日数', cnt('maximum_vacancy_days', '日'))
      ))),
      card('リーシングファネル', funnel([['反響', v.inquiry_count], ['内見', v.viewing_count], ['申込', v.application_count], ['契約', v.contract_count]], 460))
    ]));
    el.appendChild(card('賃料変化（' + C.moneyUnitLabel(CFG) + '）', rentTable(history)));
    var text = function (t) { return t ? h('div', { class: 'comment', text: t }) : h('p', { class: 'muted', text: CFG.display.nullLabel }); };
    el.appendChild(h('div', { class: 'grid-2' }, [
      card('PMコメント', h('div', null, [text(r.text.pm_comment), h('h3', { text: 'リーシング課題' }), text(r.text.leasing_issue), h('h3', { text: '前週からの主要変化' }), text(r.text.major_change_from_previous_week)])),
      card('AM確認事項', text(r.text.am_review_item))
    ]));
    var rep = m.files.filter(function (f) { return r.text.source_file_name && f.file_name === r.text.source_file_name; })[0];
    el.appendChild(card('元データの確度', h('div', null, [
      h('dl', { class: 'kv' }, [].concat(
        [h('dt', { text: 'データ確度' }), h('dd', null, confBadge(r.confidence))],
        kvRow('元ファイル', r.text.source_file_name || CFG.display.nullLabel),
        kvRow('シート', r.text.source_sheet_name || CFG.display.nullLabel),
        kvRow('ファイル処理結果', rep ? resultLabel(rep.result) : CFG.display.nullLabel),
        kvRow('稼働率（再計算）', C.fmtRate(r.occupancy, CFG) + (r.occupancy !== null ? '（' + v.occupied_units + ' ÷ ' + v.total_units + '）' : '')),
        kvRow('稼働率（元データ）', C.fmtRate(v.occupancy_rate_source, CFG, r.invalid.occupancy_rate_source)),
        kvRow('計算式（元データ）', r.text.occupancy_calculation_formula || CFG.display.nullLabel),
        kvRow('エラー詳細', r.text.error_detail || CFG.display.nullLabel)
      )),
      r.checks.length ? h('div', null, [h('h3', { text: '検証結果' }), h('ul', { class: 'change-list' }, r.checks.map(function (x) { return h('li', null, [sevBadge(x.severity), ' ', x.message]); }))]) : h('p', { class: 'note', text: 'このレコードの検証エラーはありません。' })
    ])));
  }

  function rentTable(history) {
    var rows = history.map(function (x) {
      return h('tr', null, [h('td', { text: C.formatPeriod(x.period) })].concat(
        ['current_rent', 'asking_rent', 'rent_revision_amount'].map(function (f) {
          return numCell(C.fmtMoney(x.values[f], CFG, f === 'rent_revision_amount', x.invalid[f]).replace(/万円$|円$/, ''), x.values[f] === null);
        }),
        ['ad', 'fr'].map(function (f) { return numCell(C.fmtCount(x.values[f], CFG, x.invalid[f]), x.values[f] === null); })
      ));
    });
    var u = C.moneyUnitLabel(CFG);
    return h('div', null, [h('div', { class: 'table-wrap' }, h('table', null, [
      h('thead', null, h('tr', null, [h('th', { text: '基準週' }), h('th', { class: 'num', text: '現行賃料(' + u + ')' }), h('th', { class: 'num', text: '募集賃料(' + u + ')' }), h('th', { class: 'num', text: '改定額(' + u + ')' }), h('th', { class: 'num', text: 'AD' }), h('th', { class: 'num', text: 'FR' })])),
      h('tbody', null, rows)
    ])), h('p', { class: 'note', text: 'AD・FR は' + CFG.display.adFrUnitNote + 'のまま表示（単位は仕様で未定義）。' })]);
  }

  function resultLabel(r) { return { success: '正常', partial: '一部読取', failed: '読取失敗', unknown: '不明' }[r] || r; }

  // ---------- 5. データ検証 ----------

  function renderValidation(el, c) {
    var m = c.m, vs = m.validationSummary, files = m.files;
    var byType = function (types) { return m.issues.filter(function (i) { return types.indexOf(i.type) !== -1; }); };
    var cntResult = function (r) { return files.filter(function (f) { return f.result === r; }).length; };
    var repYes = function (f) { return m.report.rows.filter(function (r) { return r[f] === 'yes'; }).length; };
    var repUnd = function (f) { return m.report.rows.filter(function (r) { return r[f] === 'undetermined'; }).length; };
    var numMis = byType(['unit_sum_mismatch', 'rate_mismatch', 'after_app_mismatch', 'summary_mismatch']).length;
    var dupIssues = byType(['duplicate_record', 'duplicate_file', 'duplicate_project_master']).length;
    var unlinkedRecs = m.records.filter(function (r) { return r.key && !r.linked; }).length;
    var unlinkedFiles = m.report.rows.filter(function (r) { return !r.target_property; }).length;
    var src = function (v) { return v === null || v === undefined ? CFG.display.nullLabel : C.fmtCount(v, CFG); };
    var grid = h('div', { class: 'kpis' }, [
      kpi('処理対象ファイル数', src(m.meta.file_count_expected), m.meta.file_count_expected === null, 'ファイル一覧 ' + files.filter(function (f) { return f.inventory_status; }).length + '件 / 検証行 ' + m.report.rows.length + '行'),
      kpi('正常処理数', src(vs.success), vs.success === null, '実数 ' + cntResult('success') + '件' + (cntResult('partial') ? ' / 一部読取 ' + cntResult('partial') + '件' : '') + '（validation_summary との照合）'),
      kpi('失敗数', src(vs.failed !== null ? vs.failed : m.meta.file_count_failed), vs.failed === null && m.meta.file_count_failed === null, '実数 ' + cntResult('failed') + '件'),
      kpi('数値不一致', String(repYes('numeric_mismatch_flag') + numMis), false, '検証レポート ' + repYes('numeric_mismatch_flag') + '件 + 再計算 ' + numMis + '件', { note: repUnd('numeric_mismatch_flag') ? '未判定 ' + repUnd('numeric_mismatch_flag') + '件（0件とは別扱い）' : null }),
      kpi('重複候補', String((vs.duplicate_candidates || 0) + repYes('duplicate_flag') + dupIssues), false, 'validation_summary ' + src(vs.duplicate_candidates) + ' / 検証レポート ' + repYes('duplicate_flag') + ' / 再検出 ' + dupIssues, { note: repUnd('duplicate_flag') ? '未判定 ' + repUnd('duplicate_flag') + '件' : null }),
      kpi('未紐付けデータ', String(unlinkedRecs + unlinkedFiles), false, '物件レコード ' + unlinkedRecs + '件 / 対象物件が空欄の検証行 ' + unlinkedFiles + '件', { note: 'validation_summary.property_linked: ' + src(vs.property_linked) }),
      kpi('低確度データ', src(vs.low_confidence_records), vs.low_confidence_records === null, '検証レポートの low ' + m.report.rows.filter(function (r) { return r.confidence === 'low'; }).length + '件')
    ]);
    el.appendChild(grid);

    // 公開判定
    var jsonOk = true;
    var checks = [
      ['JSON構文', jsonOk, 'dashboard_data.json を解析できました'],
      ['ファイル件数の突合', m.countsReconciled, m.countsReconciled ? '想定・処理・失敗・一覧・検証行の件数が一致' : '件数の不整合があります'],
      ['全ファイルに検証行', byType(['missing_validation_row']).length === 0, byType(['missing_validation_row']).length ? byType(['missing_validation_row']).length + 'ファイルに検証行がありません' : 'すべてのファイルに検証行があります'],
      ['（参考）物件マスター', m.master.entries.length > 0, m.master.loaded ? m.master.entries.length + '件' : '未読込'],
      ['（参考）Project # 重複（マスター）', m.master.duplicateKeys.length === 0, m.master.duplicateKeys.length ? m.master.duplicateKeys.join(', ') : 'なし']
    ];
    el.appendChild(card('公開判定: ' + (m.publishable ? '公開条件を満たしています' : '公開条件を満たしていません'), h('ul', { class: 'change-list' }, checks.map(function (x) {
      return h('li', null, [badge(x[1] ? 'OK' : 'NG', x[1] ? 'conf-high' : 'conf-low'), ' ', x[0] + ': ' + x[2]]);
    }))));

    // ファイル一覧
    var stSel = h('select', { 'aria-label': '処理状況で絞り込み', onchange: function (e) { state.fileStatus = e.target.value; render(); } },
      [['', 'すべての処理状況'], ['success', '正常'], ['partial', '一部読取'], ['failed', '読取失敗'], ['unknown', '不明']].map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
    stSel.value = state.fileStatus;
    var shown = files.filter(function (f) { return !state.fileStatus || f.result === state.fileStatus; });
    var flagLabel = function (v) { return v === 'yes' ? 'あり' : v === 'no' ? 'なし' : '未判定'; };
    el.appendChild(card('処理対象ファイル（' + shown.length + ' / ' + files.length + '件）', shown.length ? h('div', { class: 'table-wrap' }, h('table', null, [
      h('thead', null, h('tr', null, ['ファイル名', '処理結果', '対象物件', '抽出項目数', '読取不能項目', '重複の可能性', '数値不一致', '物件名不一致', 'データ確度', '要確認理由'].map(function (t) { return h('th', { text: t }); }))),
      h('tbody', null, shown.map(function (f) {
        var r = f.report;
        return h('tr', null, [
          h('td', { class: 'cell-wrap', text: f.file_name }),
          h('td', null, badge(resultLabel(f.result), f.result === 'success' ? 'conf-high' : f.result === 'partial' ? 'conf-medium' : f.result === 'failed' ? 'conf-low' : 'conf-none')),
          h('td', { text: r && r.target_property ? r.target_property : '未紐付け' }),
          numCell(r ? C.fmtCount(r.extracted_count, CFG, r.extracted_count_invalid) : CFG.display.nullLabel, !r || r.extracted_count === null),
          h('td', { text: r && r.unreadable_items ? r.unreadable_items : '—' }),
          h('td', { text: r ? flagLabel(r.duplicate_flag) : CFG.display.nullLabel }),
          h('td', { text: r ? flagLabel(r.numeric_mismatch_flag) : CFG.display.nullLabel }),
          h('td', { text: r ? flagLabel(r.name_mismatch_flag) : CFG.display.nullLabel }),
          h('td', null, confBadge(r ? r.confidence : null)),
          h('td', { class: 'cell-wrap', text: r && r.reason ? r.reason : (r ? '—' : '検証行なし') })
        ]);
      }))
    ])) : empty('該当するファイルはありません'), stSel));

    // 検証結果一覧
    var sevSel = h('select', { 'aria-label': '重要度で絞り込み', onchange: function (e) { state.issueSeverity = e.target.value; render(); } },
      [['', 'すべての重要度'], ['error', 'エラー'], ['warning', '警告'], ['info', '情報']].map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
    sevSel.value = state.issueSeverity;
    var issues = m.issues.filter(function (i) { return !state.issueSeverity || i.severity === state.issueSeverity; });
    var counts = { error: 0, warning: 0, info: 0 };
    m.issues.forEach(function (i) { counts[i.severity]++; });
    // 同じ重要度・区分の項目はまとめ、詳細は折りたたむ
    var groups = [], byGroup = {};
    issues.forEach(function (i) {
      var g = i.severity + '|' + i.type;
      if (!byGroup[g]) { byGroup[g] = { severity: i.severity, label: i.label, items: [] }; groups.push(byGroup[g]); }
      byGroup[g].items.push(i);
    });
    el.appendChild(card('検証結果（エラー ' + counts.error + ' / 警告 ' + counts.warning + ' / 情報 ' + counts.info + '）', groups.length ? h('div', { class: 'table-wrap' }, h('table', null, [
      h('thead', null, h('tr', null, [h('th', { text: '重要度' }), h('th', { text: '区分' }), h('th', { class: 'num', text: '件数' }), h('th', { text: '内容' })])),
      h('tbody', null, groups.map(function (g) {
        var detail = g.items.length === 1 ? h('span', { text: g.items[0].message }) : h('details', null, [
          h('summary', { text: g.items[0].message + '（他 ' + (g.items.length - 1) + '件）' }),
          h('ul', { class: 'change-list' }, g.items.map(function (i) { return h('li', { text: (i.project_number ? i.project_number + ': ' : '') + i.message }); }))
        ]);
        return h('tr', null, [h('td', null, sevBadge(g.severity)), h('td', { text: g.label }), numCell(String(g.items.length)), h('td', { class: 'cell-wrap-wide' }, detail)]);
      }))
    ])) : empty('該当する検証結果はありません'), sevSel));
  }

  // ---------- 起動エラー表示 ----------

  function renderLoadError(reason) {
    clear($('header-meta'));
    var el = clear($('banners'));
    el.appendChild(h('div', { class: 'banner banner-error', role: 'alert' }, [h('strong', { text: 'データを読み込めません' }), reason]));
    $('filters').hidden = true;
    ['summary', 'list', 'alerts', 'detail', 'validation'].forEach(function (k) { $('view-' + k).hidden = k !== 'summary'; });
    var v = clear($('view-summary'));
    v.appendChild(card('データの読み込み方法', h('div', null, [
      h('p', { text: '方法1: 起動スクリプト（start.sh / start.bat）でローカルサーバーを起動し、表示された URL を開く。' }),
      h('p', { text: '方法2: 右上の「ファイルを選択」から dashboard_data.json・property_master.csv・validation_report.csv を選ぶ（ブラウザ内で読み込むだけで送信しません）。' }),
      h('p', { class: 'note drop-hint', text: 'この画面にファイルをドラッグ＆ドロップしても読み込めます。' })
    ])));
  }

  // ---------- イベント ----------

  function switchTab(tab) {
    state.tab = tab;
    render();
    window.scrollTo(0, 0);
  }

  function bind() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () { if (state.model) switchTab(t.getAttribute('data-tab')); });
    });
    $('f-period').addEventListener('change', function (e) { state.period = e.target.value; populateFilters(); render(); });
    ['f-project', 'f-spc', 'f-am', 'f-pm', 'f-band', 'f-confidence', 'f-alert', 'f-duplicate'].forEach(function (id) {
      $(id).addEventListener('change', render);
    });
    ['f-project-name', 'f-name-ja'].forEach(function (id) { $(id).addEventListener('input', debounce(render, 200)); });
    $('btn-clear').addEventListener('click', function () {
      ['f-project', 'f-spc', 'f-am', 'f-pm', 'f-band', 'f-confidence', 'f-alert', 'f-duplicate'].forEach(function (id) { $(id).value = ''; });
      $('f-project-name').value = ''; $('f-name-ja').value = '';
      if (state.model) { state.period = state.model.period || state.model.periods[0]; populateFilters(); }
      render();
    });
    $('btn-reload').addEventListener('click', function () { state.notes = []; loadFromServer(); });
    $('file-input').addEventListener('change', function (e) { loadFromFiles(e.target.files); e.target.value = ''; });
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) loadFromFiles(e.dataTransfer.files); });
    $('btn-theme').addEventListener('click', function () {
      var root = document.documentElement;
      var dark = root.getAttribute('data-theme') ? root.getAttribute('data-theme') === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', dark ? 'light' : 'dark');
      storageSet(THEME_KEY, dark ? 'light' : 'dark');
    });
    // ツールチップ
    var tip = $('tooltip');
    document.addEventListener('mouseover', function (e) {
      var t = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!t) { tip.hidden = true; return; }
      tip.textContent = t.getAttribute('data-tip');
      tip.hidden = false;
    });
    document.addEventListener('mousemove', function (e) {
      if (tip.hidden) return;
      var x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
      var y = e.clientY + 14 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 14;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    });
  }

  function debounce(fn, ms) {
    var t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  function init() {
    var theme = storageGet(THEME_KEY);
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
    bind();
    loadFromServer();
  }

  if (!C || !CFG) {
    document.body.textContent = 'config.js または core.js を読み込めませんでした。';
    return;
  }
  init();
})();
