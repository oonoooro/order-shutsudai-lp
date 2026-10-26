/*
 * 週次リーシングダッシュボード コアロジック
 *
 * 読込・正規化・検証・集計・書式化を DOM に依存せず実装する。
 * ブラウザでは window.LeasingCore、Node では require('./core') で使う。
 * 入力オブジェクト・入力テキストは変更しない（読み取り専用で扱う）。
 */
(function (root, factory) {
  var core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.LeasingCore = core;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // dashboard_spec.md 3章のフィールド定義
  var NUMERIC_FIELDS = [
    'total_units', 'occupied_units', 'vacant_units', 'application_units',
    'scheduled_contract_units', 'scheduled_termination_units',
    'occupancy_rate_source', 'occupancy_rate_calculated',
    'occupancy_calculation_numerator', 'occupancy_calculation_denominator',
    'occupancy_after_application_source', 'occupancy_after_application_calculated',
    'leasing_units', 'new_leasing_units', 'long_vacancy_units',
    'average_vacancy_days', 'maximum_vacancy_days',
    'current_rent', 'asking_rent', 'rent_revision_amount', 'ad', 'fr',
    'viewing_count', 'inquiry_count', 'application_count', 'contract_count'
  ];
  var TEXT_FIELDS = [
    'report_date', 'project_number', 'project_name', 'property_name_ja', 'property_name_en',
    'spc', 'am', 'pm', 'occupancy_calculation_formula', 'major_change_from_previous_week',
    'leasing_issue', 'pm_comment', 'am_review_item', 'source_file_name', 'source_sheet_name',
    'data_confidence', 'error_detail'
  ];
  // 仕様外だが値があれば利用する任意フィールド（後方互換のため未知列扱いにしない）
  var OPTIONAL_NUMERIC_FIELDS = ['application_cancel_count'];
  // 0 以上でなければならない数値
  var NON_NEGATIVE_FIELDS = NUMERIC_FIELDS.filter(function (f) { return f !== 'rent_revision_amount'; });
  var RATE_FIELDS = [
    'occupancy_rate_source', 'occupancy_rate_calculated',
    'occupancy_after_application_source', 'occupancy_after_application_calculated'
  ];
  var NAME_FIELDS = ['project_name', 'property_name_ja', 'property_name_en', 'spc', 'am', 'pm'];
  var MONEY_FIELDS = ['current_rent', 'asking_rent', 'rent_revision_amount'];
  var KNOWN_ROOT_KEYS = ['schema_version', 'report_metadata', 'portfolio_summary', 'properties', 'units', 'alerts', 'validation_summary', 'file_inventory'];
  var KNOWN_META_KEYS = ['report_date', 'source_period', 'file_count_expected', 'file_count_processed', 'file_count_failed', 'generated_by', 'contains_personal_data', 'is_sample', 'is_provisional'];
  var META_NUMERIC = ['file_count_expected', 'file_count_processed', 'file_count_failed'];
  var VALIDATION_SUMMARY_NUMERIC = ['success', 'partial', 'failed', 'property_linked', 'duplicate_candidates', 'low_confidence_records'];
  var SUMMARY_NUMERIC = ['property_count', 'total_units', 'occupied_units', 'vacant_units', 'application_units',
    'scheduled_contract_units', 'scheduled_termination_units', 'occupancy_rate', 'occupancy_after_application'];

  // 住戸明細（units）。dashboard_spec.md にはない拡張で、ない場合も動作する
  var UNIT_NUMERIC_FIELDS = ['floor_area_sqm', 'vacancy_days', 'current_rent', 'asking_rent', 'common_fee', 'ad', 'fr', 'deposit_months', 'key_money_months'];
  var UNIT_DATE_FIELDS = ['vacancy_start_date', 'move_out_date', 'notice_date', 'application_date', 'application_cancel_date',
    'work_start_date', 'work_end_date', 'work_completed_date'];
  var UNIT_TEXT_FIELDS = ['report_date', 'project_number', 'unit_number', 'layout', 'leasing_status', 'work_type', 'unit_note', 'data_confidence', 'source_file_name'];
  // 賃料条件として前週と比較する項目
  var UNIT_CONDITION_FIELDS = [
    { key: 'asking_rent', label: '募集賃料', money: true },
    { key: 'common_fee', label: '共益費', money: true },
    { key: 'ad', label: 'AD' },
    { key: 'fr', label: 'FR' },
    { key: 'deposit_months', label: '敷金（ヶ月）' },
    { key: 'key_money_months', label: '礼金（ヶ月）' }
  ];
  var UNIT_STATUS_LABELS = { vacant: '空室（募集中）', application: '申込あり', contracted: '契約済（入居待ち）', occupied: '入居中', notice: '解約予定' };
  var WORK_TYPE_LABELS = { renovation: 'リノベーション', restoration: '原状回復' };

  var SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

  var ISSUE_LABELS = {
    json_syntax: 'JSON構文エラー',
    invalid_structure: 'データ構造不正',
    missing_source_period: '対象週（source_period）なし',
    missing_project_number: 'Project # なし',
    duplicate_project_master: '物件マスターの Project # 重複',
    duplicate_record: '物件レコードの重複',
    unknown_project: '物件マスター未登録の Project #',
    numeric_type: '数値列への文字混入',
    negative_value: '負の値',
    rate_out_of_range: '比率の範囲外',
    unit_sum_mismatch: '稼働＋空室と総戸数の不一致',
    rate_mismatch: '稼働率の計算不一致',
    after_app_mismatch: '申込反映後稼働率の不一致',
    after_app_operands_missing: '申込反映後稼働率の根拠不足',
    name_mismatch: '物件名等のマスター不一致',
    summary_mismatch: 'ポートフォリオ集計の不一致',
    count_reconcile: 'ファイル件数の不整合',
    missing_validation_row: '検証行のないファイル',
    orphan_validation_row: 'ファイル一覧にない検証行',
    duplicate_file: '同一ファイルの重複',
    read_failure: '読取失敗ファイル',
    partial_read: '一部読取',
    low_confidence: '低確度データ',
    unknown_confidence: 'データ確度の値が不明',
    unknown_column: '未知の列（無視）',
    privacy_stripped: '個人情報の可能性がある列を除外',
    privacy_masked: '個人情報の可能性がある文字列を伏字化',
    master_missing: '物件マスターなし',
    master_empty: '物件マスターが0件',
    report_missing: '検証レポートなし',
    missing_column: '必須列なし',
    missing_period_in_record: 'report_date なし',
    summary_not_calculated: 'ポートフォリオ集計未算出',
    personal_data_flag: '個人情報フラグ',
    date_format: '日付の形式不正',
    missing_unit_number: '住戸番号なし',
    duplicate_unit: '住戸レコードの重複',
    unit_unknown_project: '物件マスター未登録の住戸',
    unit_status_unknown: '住戸ステータス・工事種別の値が不明',
    vacancy_days_mismatch: '空室日数の不一致',
    unit_count_mismatch: '住戸明細と物件の空室戸数の不一致',
    unit_date_inconsistent: '住戸の日付の矛盾'
  };

  var KNOWN_REASONS = {
    source_workbook_content_unavailable: '元ブックの内容を取得できなかったため'
  };

  // ---------- 汎用 ----------

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function nfkc(s) {
    s = String(s);
    return typeof s.normalize === 'function' ? s.normalize('NFKC') : s;
  }

  // Project # の結合キー: NFKC・前後空白除去・大文字化
  function normalizeKey(v) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    var s = nfkc(v).trim().toUpperCase();
    return s === '' ? null : s;
  }

  function headerKey(s) { return nfkc(s).replace(/\s+/g, '').toLowerCase(); }

  function normText(s) { return s === null || s === undefined ? '' : nfkc(s).replace(/\s+/g, ' ').trim(); }

  // 対象週のキー: YYYYMMDD に揃える。解釈できない形式はそのまま（例: 2026-W43）
  function normalizePeriod(v) {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    var s = nfkc(v).trim();
    if (s === '') return null;
    var m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (m) return m[1] + pad2(m[2]) + pad2(m[3]);
    if (/^\d{8}$/.test(s)) return s;
    return s;
  }
  function pad2(x) { x = String(x); return x.length < 2 ? '0' + x : x; }

  function formatPeriod(key) {
    if (key === null || key === undefined || key === '') return null;
    var s = String(key);
    if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
    return s;
  }

  // 同一ファイル判定用の軽量ハッシュ（FNV-1a 32bit + 文字数）
  function hashText(text) {
    var h = 0x811c9dc5;
    var s = String(text);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8) + '-' + s.length;
  }

  function issue(type, severity, message, extra) {
    var o = { type: type, severity: severity, label: ISSUE_LABELS[type] || type, message: message };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
    return o;
  }

  function sortIssues(list) {
    return list.slice().sort(function (a, b) {
      return (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || String(a.type).localeCompare(String(b.type));
    });
  }

  // ---------- JSON / CSV ----------

  function safeParseJSON(text) {
    if (typeof text !== 'string') return { ok: false, error: '入力が文字列ではありません' };
    var s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    try {
      return { ok: true, value: JSON.parse(s) };
    } catch (e) {
      var msg = String(e && e.message || e);
      var pos = msg.match(/position (\d+)/);
      var where = '';
      if (pos) {
        var p = Number(pos[1]);
        var before = s.slice(0, p).split('\n');
        where = '（' + before.length + '行目 ' + (before[before.length - 1].length + 1) + '文字目付近）';
      }
      return { ok: false, error: 'JSON構文エラー' + where + ': ' + msg };
    }
  }

  // RFC 4180 準拠の CSV パーサー（BOM・CRLF・引用符・空行に対応）
  function parseCSV(text) {
    var s = String(text || '');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    var rows = [], row = [], field = '', inQuotes = false, i = 0, errors = [];
    while (i < s.length) {
      var c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') {
        if (field === '') { inQuotes = true; i++; continue; }
        field += c; i++; continue;
      }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (inQuotes) errors.push('引用符が閉じられていません');
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    rows = rows.filter(function (r) { return !(r.length === 1 && r[0].trim() === ''); });
    var headers = rows.length ? rows[0].map(function (h) { return h.trim(); }) : [];
    return { headers: headers, rows: rows.slice(1), errors: errors };
  }

  // 列名の別名定義から 正規名 → 列番号 を求める
  function mapColumns(headers, aliases) {
    var map = {}, used = {};
    Object.keys(aliases).forEach(function (canon) {
      var names = aliases[canon].map(headerKey);
      for (var i = 0; i < headers.length; i++) {
        if (used[i]) continue;
        if (names.indexOf(headerKey(headers[i])) !== -1) { map[canon] = i; used[i] = true; break; }
      }
    });
    var unknown = headers.filter(function (h, i) { return !used[i] && h !== ''; });
    return { map: map, unknown: unknown };
  }

  // CSV の数値セル: 空欄は null（0 にしない）。桁区切りカンマのみ許容。
  function parseNumberCell(raw) {
    var s = raw === null || raw === undefined ? '' : String(raw).trim();
    if (s === '') return { value: null, invalid: false };
    if (/^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(s)) return { value: Number(s.replace(/,/g, '')), invalid: false };
    return { value: null, invalid: true, raw: s };
  }

  // ---------- プライバシー ----------

  function isDeniedField(name, config) {
    var key = String(name).toLowerCase();
    var tokens = key.split(/[^a-z0-9]+/);
    var pats = (config && config.privacy && config.privacy.deniedFieldPatterns) || [];
    for (var i = 0; i < pats.length; i++) {
      var p = String(pats[i]).toLowerCase();
      if (/^[a-z0-9]+$/.test(p)) { if (tokens.indexOf(p) !== -1) return true; }
      else if (key.indexOf(p) !== -1) return true;
    }
    return false;
  }

  var PII_PATTERNS = [
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,                 // メールアドレス
    /https?:\/\/[^\s"'<>]+/gi,                                          // URL（SharePoint 等）
    /[A-Za-z0-9.-]+\.sharepoint\.com[^\s"'<>]*/gi,
    /\\\\[^\s\\]+\\[^\s"'<>]*/g,                                         // UNC パス
    /[A-Za-z]:\\[^\s"'<>]*/g,                                           // Windows パス
    /\/(?:sites|teams|personal|Users|home)\/[^\s"'<>]*/g,               // サイト・ユーザーパス
    /\+81[-\s]?\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/g,                    // 電話番号（国番号）
    /(?:^|(?<=[^\d-]))0\d{1,4}-\d{1,4}-\d{3,4}(?![\d-])/g,              // 電話番号（ハイフン）
    /(?:^|(?<=\D))0[5789]0\d{8}(?!\d)/g,                                // 携帯番号
    /[０-９]{2,5}[－ー‐][０-９]{1,4}[－ー‐][０-９]{3,4}/g                 // 全角の電話番号
  ];

  function sanitizeText(v, config) {
    if (v === null || v === undefined) return { value: null, masked: false };
    var s = typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));
    var label = (config && config.privacy && config.privacy.maskLabel) || '［非表示］';
    var out = s;
    PII_PATTERNS.forEach(function (re) { out = out.replace(re, label); });
    return { value: out, masked: out !== s };
  }

  // フォルダパスを表示しないため、ファイル名だけを残す
  function baseName(name) {
    if (name === null || name === undefined) return null;
    var s = String(name);
    var parts = s.split(/[\\/]/);
    return parts[parts.length - 1];
  }

  // ---------- 物件マスター ----------

  function loadMaster(text, config) {
    var res = { loaded: text !== null && text !== undefined, entries: [], byKey: {}, duplicateKeys: [], issues: [], unknownColumns: [] };
    if (!res.loaded) {
      res.issues.push(issue('master_missing', 'warning', 'property_master.csv が読み込まれていません。物件名は表示できず、全物件が未紐付けになります。'));
      return res;
    }
    var csv = parseCSV(text);
    csv.errors.forEach(function (e) { res.issues.push(issue('invalid_structure', 'error', 'property_master.csv: ' + e)); });
    var cols = mapColumns(csv.headers, config.masterColumns);
    if (cols.map.project_number === undefined) {
      res.issues.push(issue('missing_column', 'error', 'property_master.csv に Project # 列（project_number）がありません。'));
      return res;
    }
    cols.unknown.forEach(function (h) {
      if (isDeniedField(h, config)) res.issues.push(issue('privacy_stripped', 'warning', 'property_master.csv の列「' + h + '」は個人情報の可能性があるため読み込みません。', { field: h }));
      else res.unknownColumns.push(h);
    });
    if (res.unknownColumns.length) {
      res.issues.push(issue('unknown_column', 'info', 'property_master.csv の未知の列を無視しました: ' + res.unknownColumns.join(', '), { columns: res.unknownColumns.slice() }));
    }
    var seen = {};
    csv.rows.forEach(function (r, idx) {
      var get = function (c) {
        var i = cols.map[c];
        if (i === undefined || r[i] === undefined) return null;
        var v = r[i].trim();
        return v === '' ? null : sanitizeText(v, config).value;
      };
      var key = normalizeKey(get('project_number'));
      if (!key) {
        res.issues.push(issue('missing_project_number', 'warning', 'property_master.csv ' + (idx + 2) + '行目: Project # が空のため無視しました。', { row: idx + 2 }));
        return;
      }
      var entry = { key: key, project_number: get('project_number'), row: idx + 2 };
      Object.keys(config.masterColumns).forEach(function (c) { if (c !== 'project_number') entry[c] = get(c); });
      if (seen[key]) {
        if (res.duplicateKeys.indexOf(key) === -1) res.duplicateKeys.push(key);
        res.issues.push(issue('duplicate_project_master', 'error',
          'property_master.csv で Project # 「' + key + '」が重複しています（' + seen[key].row + '行目と' + entry.row + '行目）。先に出現した行を正として扱います。',
          { project_number: key }));
        return;
      }
      seen[key] = entry;
      res.byKey[key] = entry;
      res.entries.push(entry);
    });
    if (res.entries.length === 0) {
      res.issues.push(issue('master_empty', 'warning', 'property_master.csv に物件が1件もありません（ヘッダーのみ）。物件名・SPC・AM・PM は表示できません。'));
    }
    return res;
  }

  // ---------- 検証レポート ----------

  function classifyValue(v, list) {
    var k = headerKey(v === null || v === undefined ? '' : v);
    for (var i = 0; i < list.length; i++) if (headerKey(list[i]) === k) return true;
    return false;
  }

  function loadValidationReport(text, config) {
    var res = { loaded: text !== null && text !== undefined, rows: [], issues: [], unknownColumns: [] };
    if (!res.loaded) {
      res.issues.push(issue('report_missing', 'warning', 'validation_report.csv が読み込まれていません。'));
      return res;
    }
    var csv = parseCSV(text);
    csv.errors.forEach(function (e) { res.issues.push(issue('invalid_structure', 'error', 'validation_report.csv: ' + e)); });
    var cols = mapColumns(csv.headers, config.validationReportColumns);
    if (cols.map.file_name === undefined) {
      res.issues.push(issue('missing_column', 'error', 'validation_report.csv に「ファイル名」列がありません。'));
      return res;
    }
    res.unknownColumns = cols.unknown.slice();
    if (res.unknownColumns.length) {
      res.issues.push(issue('unknown_column', 'info', 'validation_report.csv の未知の列を無視しました: ' + res.unknownColumns.join(', '), { columns: res.unknownColumns.slice() }));
    }
    var V = config.validationReportValues;
    var flag = function (v) {
      if (v === null) return 'undetermined';
      if (classifyValue(v, V.yes)) return 'yes';
      if (classifyValue(v, V.no)) return 'no';
      return 'undetermined';
    };
    csv.rows.forEach(function (r, idx) {
      var get = function (c) {
        var i = cols.map[c];
        if (i === undefined || r[i] === undefined) return null;
        var v = r[i].trim();
        return v === '' ? null : v;
      };
      var fileName = sanitizeText(baseName(get('file_name')), config).value;
      if (!fileName) return;
      var resultRaw = get('result');
      var result = 'unknown';
      if (classifyValue(resultRaw, V.failed)) result = 'failed';
      else if (classifyValue(resultRaw, V.partial)) result = 'partial';
      else if (classifyValue(resultRaw, V.success)) result = 'success';
      var cnt = parseNumberCell(get('extracted_count'));
      if (cnt.invalid) {
        res.issues.push(issue('numeric_type', 'error', 'validation_report.csv ' + (idx + 2) + '行目「抽出項目数」に数値以外の文字が含まれています: ' + cnt.raw, { file_name: fileName, field: '抽出項目数' }));
      }
      res.rows.push({
        row: idx + 2,
        file_name: fileName,
        target_property: normalizeKey(get('target_property')),
        result: result,
        result_raw: resultRaw,
        extracted_count: cnt.value,
        extracted_count_invalid: cnt.invalid,
        unreadable_items: sanitizeText(get('unreadable_items'), config).value,
        duplicate_flag: flag(get('duplicate_flag')),
        numeric_mismatch_flag: flag(get('numeric_mismatch_flag')),
        name_mismatch_flag: flag(get('name_mismatch_flag')),
        confidence: normalizeConfidence(get('confidence')),
        reason: sanitizeText(get('reason'), config).value
      });
    });
    return res;
  }

  function normalizeConfidence(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim().toLowerCase();
    return s === 'high' || s === 'medium' || s === 'low' ? s : null;
  }

  // ---------- dashboard_data.json ----------

  function readNumber(obj, field, ctx, issues) {
    if (!obj || !Object.prototype.hasOwnProperty.call(obj, field)) return { value: null, invalid: false, present: false };
    var v = obj[field];
    if (v === null) return { value: null, invalid: false, present: true };
    if (isNum(v)) return { value: v, invalid: false, present: true };
    var shown = sanitizeText(v, null).value;
    issues.push(issue('numeric_type', 'error',
      ctx + ' の数値列「' + field + '」に数値以外の値があります: ' + JSON.stringify(shown) + '（推測で変換せず「数値不正」として扱います）',
      { field: field, raw: shown }));
    return { value: null, invalid: true, present: true };
  }

  function normalizeDataset(json, config) {
    var issues = [];
    var ds = {
      meta: {}, summary: { present: false, status: null, is_provisional: false, reason: null, reason_label: null, values: {} },
      properties: [], units: [], alerts: [], validationSummary: { present: false }, fileInventory: [],
      unknownColumns: { root: [], meta: [], property: [] }, issues: issues
    };
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      issues.push(issue('invalid_structure', 'error', 'dashboard_data.json の最上位がオブジェクトではありません。'));
      return ds;
    }
    Object.keys(json).forEach(function (k) {
      if (KNOWN_ROOT_KEYS.indexOf(k) === -1) ds.unknownColumns.root.push(k);
    });

    // report_metadata
    var meta = json.report_metadata && typeof json.report_metadata === 'object' ? json.report_metadata : {};
    if (!json.report_metadata) issues.push(issue('invalid_structure', 'error', 'report_metadata がありません。'));
    Object.keys(meta).forEach(function (k) { if (KNOWN_META_KEYS.indexOf(k) === -1) ds.unknownColumns.meta.push(k); });
    ds.meta = {
      report_date: sanitizeText(meta.report_date, config).value,
      source_period: sanitizeText(meta.source_period, config).value,
      period: normalizePeriod(meta.source_period),
      generated_by: sanitizeText(meta.generated_by, config).value,
      contains_personal_data: meta.contains_personal_data === true ? true : (meta.contains_personal_data === false ? false : null),
      is_sample: meta.is_sample === true,
      is_provisional: meta.is_provisional === true
    };
    META_NUMERIC.forEach(function (f) {
      var r = readNumber(meta, f, 'report_metadata', issues);
      ds.meta[f] = r.value;
      ds.meta[f + '_invalid'] = r.invalid;
    });
    if (!ds.meta.period) issues.push(issue('missing_source_period', 'error', 'report_metadata.source_period がありません。対象週を特定できません。'));
    if (ds.meta.contains_personal_data === true) {
      issues.push(issue('personal_data_flag', 'warning', 'report_metadata.contains_personal_data が true です。個人情報の可能性がある列・文字列は除外・伏字化して表示します。'));
    }

    // portfolio_summary
    var ps = json.portfolio_summary && typeof json.portfolio_summary === 'object' ? json.portfolio_summary : {};
    ds.summary = {
      present: !!json.portfolio_summary,
      status: sanitizeText(ps.status, config).value,
      is_provisional: ps.is_provisional === true,
      reason: sanitizeText(ps.reason, config).value,
      reason_label: ps.reason && KNOWN_REASONS[ps.reason] ? KNOWN_REASONS[ps.reason] : null,
      values: {}
    };
    SUMMARY_NUMERIC.forEach(function (f) {
      var r = readNumber(ps, f, 'portfolio_summary', issues);
      if (r.present) ds.summary.values[f] = r.value;
    });
    if (ds.summary.status === 'not_calculated') {
      issues.push(issue('summary_not_calculated', 'warning', 'ポートフォリオ集計は元データ側で未算出です（理由: ' +
        (ds.summary.reason_label ? ds.summary.reason_label + ' / ' : '') + (ds.summary.reason || '記載なし') + '）。'));
    }

    // properties
    var props = json.properties;
    if (props === undefined || props === null) {
      issues.push(issue('invalid_structure', 'error', 'properties がありません。'));
      props = [];
    } else if (!Array.isArray(props)) {
      issues.push(issue('invalid_structure', 'error', 'properties が配列ではありません。'));
      props = [];
    }
    var knownProp = NUMERIC_FIELDS.concat(TEXT_FIELDS, OPTIONAL_NUMERIC_FIELDS);
    var deniedSeen = {}, unknownSeen = {}, maskedCount = 0;
    props.forEach(function (raw, idx) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push(issue('invalid_structure', 'error', 'properties[' + idx + '] がオブジェクトではありません。'));
        return;
      }
      var rec = { index: idx, values: {}, invalid: {}, present: {}, text: {} };
      Object.keys(raw).forEach(function (k) {
        if (knownProp.indexOf(k) !== -1) return;
        if (isDeniedField(k, config)) { deniedSeen[k] = true; return; }
        unknownSeen[k] = true;
      });
      TEXT_FIELDS.forEach(function (f) {
        if (isDeniedField(f, config)) return;
        // ファイル名はフォルダ部分を除いてから伏字判定する
        var s = sanitizeText(f === 'source_file_name' ? baseName(raw[f]) : raw[f], config);
        if (s.masked) maskedCount++;
        rec.text[f] = s.value === null || s.value === '' ? null : s.value;
      });
      rec.project_number = rec.text.project_number;
      rec.key = normalizeKey(raw.project_number);
      var ctx = 'properties[' + idx + ']' + (rec.key ? '（Project # ' + rec.key + '）' : '');
      NUMERIC_FIELDS.concat(OPTIONAL_NUMERIC_FIELDS).forEach(function (f) {
        var r = readNumber(raw, f, ctx, issues);
        if (r.invalid) issues[issues.length - 1].project_number = rec.key;
        rec.values[f] = r.value;
        rec.invalid[f] = r.invalid;
        rec.present[f] = r.present;
        if (isNum(r.value) && r.value < 0 && NON_NEGATIVE_FIELDS.indexOf(f) !== -1) {
          issues.push(issue('negative_value', 'error', ctx + ' の「' + f + '」が負の値です: ' + r.value, { project_number: rec.key, field: f }));
        }
        if (isNum(r.value) && RATE_FIELDS.indexOf(f) !== -1 && (r.value < 0 || r.value > 1)) {
          issues.push(issue('rate_out_of_range', 'error', ctx + ' の「' + f + '」が 0〜1 の範囲外です: ' + r.value + '（比率は小数で記録する仕様です）', { project_number: rec.key, field: f }));
        }
      });
      rec.confidence = normalizeConfidence(raw.data_confidence);
      if (raw.data_confidence !== undefined && raw.data_confidence !== null && rec.confidence === null) {
        issues.push(issue('unknown_confidence', 'warning', ctx + ' の data_confidence が high / medium / low 以外です。', { project_number: rec.key }));
      }
      if (!rec.key) {
        issues.push(issue('missing_project_number', 'error', ctx + ' に project_number がありません。集計から除外します。'));
      }
      rec.period = normalizePeriod(raw.report_date);
      if (!rec.period) {
        rec.period = ds.meta.period;
        issues.push(issue('missing_period_in_record', 'warning', ctx + ' に report_date がないため、source_period の週として扱います。', { project_number: rec.key }));
      }
      ds.properties.push(rec);
    });
    var denied = Object.keys(deniedSeen), unknown = Object.keys(unknownSeen);
    ds.unknownColumns.property = unknown;
    if (denied.length) issues.push(issue('privacy_stripped', 'warning', '個人情報の可能性がある列を読み込みませんでした: ' + denied.join(', '), { columns: denied }));
    if (maskedCount) issues.push(issue('privacy_masked', 'warning', maskedCount + '件の文字列でメールアドレス・電話番号・URL・パスの可能性がある部分を伏字にしました。'));
    var unk = [];
    if (ds.unknownColumns.root.length) unk.push('最上位: ' + ds.unknownColumns.root.join(', '));
    if (ds.unknownColumns.meta.length) unk.push('report_metadata: ' + ds.unknownColumns.meta.join(', '));
    if (unknown.length) unk.push('properties: ' + unknown.join(', '));
    if (unk.length) issues.push(issue('unknown_column', 'info', 'dashboard_data.json の未知の列を無視しました（' + unk.join(' / ') + '）'));

    // alerts
    (Array.isArray(json.alerts) ? json.alerts : []).forEach(function (a) {
      if (!a || typeof a !== 'object') return;
      ds.alerts.push({
        severity: ['error', 'warning', 'info'].indexOf(a.severity) !== -1 ? a.severity : 'warning',
        code: sanitizeText(a.code, config).value,
        message: sanitizeText(a.message, config).value,
        project_number: normalizeKey(a.project_number)
      });
    });

    // validation_summary
    var vs = json.validation_summary && typeof json.validation_summary === 'object' ? json.validation_summary : {};
    ds.validationSummary.present = !!json.validation_summary;
    VALIDATION_SUMMARY_NUMERIC.forEach(function (f) {
      ds.validationSummary[f] = readNumber(vs, f, 'validation_summary', issues).value;
    });

    // file_inventory
    (Array.isArray(json.file_inventory) ? json.file_inventory : []).forEach(function (f, idx) {
      if (!f || typeof f !== 'object') return;
      var name = sanitizeText(baseName(f.file_name), config).value;
      if (!name) {
        issues.push(issue('invalid_structure', 'warning', 'file_inventory[' + idx + '] に file_name がありません。'));
        return;
      }
      var st = String(f.status || '').toLowerCase();
      ds.fileInventory.push({ file_name: name, status: ['success', 'partial', 'failed'].indexOf(st) !== -1 ? st : 'unknown', status_raw: sanitizeText(f.status, config).value });
    });
    ds.units = normalizeUnits(json.units, ds.meta.period, config, issues);
    return ds;
  }

  // ---------- 統合・検証 ----------

  function fileKey(name) { return normText(name); }

  // 同じ内容のファイルを二重に読み込んだ場合に 1 件として扱う
  function dedupeSourceFiles(files) {
    var seen = {}, unique = [], duplicates = [];
    (files || []).forEach(function (f) {
      var h = hashText(f.text);
      if (seen[h]) { duplicates.push({ name: f.name, duplicateOf: seen[h].name, hash: h }); return; }
      seen[h] = f;
      unique.push({ name: f.name, text: f.text, hash: h });
    });
    return { unique: unique, duplicates: duplicates };
  }

  function mergeFiles(ds, report, issues) {
    var files = [], byKey = {};
    var invCount = {}, repCount = {};
    ds.fileInventory.forEach(function (f) {
      var k = fileKey(f.file_name);
      invCount[k] = (invCount[k] || 0) + 1;
      if (!byKey[k]) { byKey[k] = { file_name: f.file_name, inventory_status: f.status, report: null }; files.push(byKey[k]); }
    });
    report.rows.forEach(function (r) {
      var k = fileKey(r.file_name);
      repCount[k] = (repCount[k] || 0) + 1;
      if (!byKey[k]) { byKey[k] = { file_name: r.file_name, inventory_status: null, report: r }; files.push(byKey[k]); }
      else if (!byKey[k].report) byKey[k].report = r;
    });
    Object.keys(invCount).forEach(function (k) {
      if (invCount[k] > 1) issues.push(issue('duplicate_file', 'error', 'file_inventory に同じファイルが' + invCount[k] + '回登録されています（二重読込の可能性）: ' + byKey[k].file_name, { file_name: byKey[k].file_name }));
    });
    Object.keys(repCount).forEach(function (k) {
      if (repCount[k] > 1) issues.push(issue('duplicate_file', 'error', 'validation_report.csv に同じファイルの行が' + repCount[k] + '行あります（二重読込の可能性）: ' + byKey[k].file_name, { file_name: byKey[k].file_name }));
    });
    files.forEach(function (f) {
      var r = f.report;
      f.result = f.inventory_status && f.inventory_status !== 'unknown' ? f.inventory_status : (r ? r.result : 'unknown');
      if (r && f.inventory_status && f.inventory_status !== 'unknown' && r.result !== 'unknown' && r.result !== f.inventory_status) {
        issues.push(issue('count_reconcile', 'error', 'ファイル「' + f.file_name + '」の処理結果が dashboard_data.json（' + f.inventory_status + '）と validation_report.csv（' + r.result + '）で一致しません。', { file_name: f.file_name }));
      }
      if (ds.fileInventory.length && report.loaded && f.inventory_status !== null && !r) {
        issues.push(issue('missing_validation_row', 'error', 'ファイル「' + f.file_name + '」に validation_report.csv の検証行がありません。', { file_name: f.file_name }));
      }
      if (ds.fileInventory.length && f.inventory_status === null && r) {
        issues.push(issue('orphan_validation_row', 'warning', 'validation_report.csv のファイル「' + f.file_name + '」が file_inventory にありません。', { file_name: f.file_name }));
      }
    });
    return files;
  }

  function reconcileCounts(ds, report, files, issues) {
    var m = ds.meta, vs = ds.validationSummary;
    var expected = m.file_count_expected;
    var checks = [];
    if (isNum(expected)) {
      if (isNum(m.file_count_processed) && isNum(m.file_count_failed) && m.file_count_processed + m.file_count_failed !== expected) {
        checks.push('処理数(' + m.file_count_processed + ')＋失敗数(' + m.file_count_failed + ') ≠ 想定ファイル数(' + expected + ')');
      }
      if (ds.fileInventory.length && ds.fileInventory.length !== expected) checks.push('file_inventory の件数(' + ds.fileInventory.length + ') ≠ 想定ファイル数(' + expected + ')');
      if (report.loaded && report.rows.length !== expected) checks.push('validation_report.csv の行数(' + report.rows.length + ') ≠ 想定ファイル数(' + expected + ')');
      if (vs.present && isNum(vs.success) && isNum(vs.partial) && isNum(vs.failed) && vs.success + vs.partial + vs.failed !== expected) {
        checks.push('validation_summary の 正常＋一部＋失敗(' + (vs.success + vs.partial + vs.failed) + ') ≠ 想定ファイル数(' + expected + ')');
      }
    }
    if (isNum(m.file_count_failed) && vs.present && isNum(vs.failed) && m.file_count_failed !== vs.failed) {
      checks.push('report_metadata.file_count_failed(' + m.file_count_failed + ') ≠ validation_summary.failed(' + vs.failed + ')');
    }
    var failedFiles = files.filter(function (f) { return f.result === 'failed'; }).length;
    if (isNum(m.file_count_failed) && files.length && failedFiles !== m.file_count_failed) {
      checks.push('失敗ファイルの実数(' + failedFiles + ') ≠ file_count_failed(' + m.file_count_failed + ')');
    }
    checks.forEach(function (c) { issues.push(issue('count_reconcile', 'error', c)); });
    return checks.length === 0;
  }

  function enrichRecords(ds, master, config, issues) {
    var tol = config.calc.rateTolerance;
    var groups = {};
    ds.properties.forEach(function (rec) {
      if (!rec.key) return;
      var g = rec.key + '|' + rec.period;
      (groups[g] = groups[g] || []).push(rec);
    });
    var records = ds.properties.map(function (src) {
      var r = {
        key: src.key, period: src.period, index: src.index,
        values: src.values, invalid: src.invalid, present: src.present, text: src.text,
        confidence: src.confidence, checks: []
      };
      var add = function (type, severity, message, extra) {
        var it = issue(type, severity, message, Object.assign({ project_number: r.key, period: r.period }, extra || {}));
        issues.push(it); r.checks.push(it);
      };
      var who = 'Project # ' + (r.key || '（なし）') + '（' + formatPeriod(r.period) + '）';
      var m = r.key ? master.byKey[r.key] : null;
      r.master = m || null;
      r.linked = !!m;
      // 物件名等は property_master.csv を正とする
      r.names = {};
      r.nameMismatch = [];
      NAME_FIELDS.forEach(function (f) {
        var mv = m ? m[f] : null, dv = r.text[f];
        r.names[f] = m ? mv : null;
        r.names[f + '_unlinked'] = m ? null : dv;
        if (m && mv !== null && dv !== null && normText(mv) !== normText(dv)) r.nameMismatch.push(f);
      });
      if (r.key && !m && master.loaded) add('unknown_project', 'error', who + ' は property_master.csv に存在しません。ポートフォリオ集計から除外します。');
      if (r.nameMismatch.length) add('name_mismatch', 'warning', who + ' の ' + r.nameMismatch.join(', ') + ' が property_master.csv と異なります。マスターの値を表示します。', { fields: r.nameMismatch.slice() });
      if (r.key && groups[r.key + '|' + r.period].length > 1) {
        r.duplicate = true;
        add('duplicate_record', 'error', who + ' のレコードが' + groups[r.key + '|' + r.period].length + '件あります（重複候補）。どれが正か判断できないため集計から除外します。');
      } else r.duplicate = false;

      var v = r.values;
      var occ = v.occupied_units, vac = v.vacant_units, tot = v.total_units, app = v.application_units;
      if (isNum(occ) && isNum(vac) && isNum(tot) && occ + vac !== tot) {
        add('unit_sum_mismatch', 'error', who + ': 稼働戸数(' + occ + ')＋空室戸数(' + vac + ')＝' + (occ + vac) + ' が総戸数(' + tot + ')と一致しません。',
          { numerator: occ + vac, denominator: tot });
      }
      // 稼働率 = occupied / total（いずれか null または分母 0 なら null）
      var calc = isNum(occ) && isNum(tot) && tot > 0 ? occ / tot : null;
      r.occupancy = calc;
      ['occupancy_rate_source', 'occupancy_rate_calculated'].forEach(function (f) {
        var sv = v[f];
        if (calc !== null && isNum(sv) && Math.abs(sv - calc) > tol) {
          add('rate_mismatch', 'error', who + ': ' + f + '(' + sv + ') と再計算値 ' + occ + '/' + tot + '=' + round6(calc) + ' の差 ' + round6(sv - calc) + ' が許容差 ' + tol + ' を超えています。',
            { field: f, numerator: occ, denominator: tot, source_value: sv, calculated_value: round6(calc), difference: round6(sv - calc) });
        }
      });
      if (isNum(v.occupancy_rate_source) && isNum(v.occupancy_rate_calculated) && Math.abs(v.occupancy_rate_source - v.occupancy_rate_calculated) > tol) {
        add('rate_mismatch', 'warning', who + ': 元データ稼働率(' + v.occupancy_rate_source + ') と元データ計算稼働率(' + v.occupancy_rate_calculated + ') の差が許容差を超えています。',
          { field: 'occupancy_rate_source', numerator: occ, denominator: tot, source_value: v.occupancy_rate_source, calculated_value: v.occupancy_rate_calculated, difference: round6(v.occupancy_rate_source - v.occupancy_rate_calculated) });
      }
      if (isNum(v.occupancy_calculation_numerator) && isNum(occ) && v.occupancy_calculation_numerator !== occ) {
        add('rate_mismatch', 'error', who + ': 稼働率の分子(' + v.occupancy_calculation_numerator + ') が稼働戸数(' + occ + ') と異なります。', { field: 'occupancy_calculation_numerator' });
      }
      if (isNum(v.occupancy_calculation_denominator) && isNum(tot) && v.occupancy_calculation_denominator !== tot) {
        add('rate_mismatch', 'error', who + ': 稼働率の分母(' + v.occupancy_calculation_denominator + ') が総戸数(' + tot + ') と異なります。', { field: 'occupancy_calculation_denominator' });
      }
      // 申込反映後稼働率: 元データが算出を許容した（calculated に値がある）場合のみ、3値から再計算して使う
      r.afterApplication = null;
      var aac = v.occupancy_after_application_calculated;
      if (isNum(aac)) {
        if (isNum(occ) && isNum(app) && isNum(tot) && tot > 0) {
          var ac = (occ + app) / tot;
          r.afterApplication = ac;
          if (Math.abs(aac - ac) > tol) {
            add('after_app_mismatch', 'error', who + ': 申込反映後稼働率(' + aac + ') と再計算値 (' + occ + '+' + app + ')/' + tot + '=' + round6(ac) + ' の差が許容差を超えています。',
              { numerator: occ + app, denominator: tot, source_value: aac, calculated_value: round6(ac), difference: round6(aac - ac) });
          }
        } else {
          add('after_app_operands_missing', 'warning', who + ': 申込反映後稼働率に値がありますが、稼働戸数・申込戸数・総戸数のいずれかが特定できないため採用しません。');
        }
      }
      if (isNum(v.occupancy_after_application_source) && r.afterApplication !== null && Math.abs(v.occupancy_after_application_source - r.afterApplication) > tol) {
        add('after_app_mismatch', 'warning', who + ': 元データの申込反映後稼働率(' + v.occupancy_after_application_source + ') と再計算値(' + round6(r.afterApplication) + ') の差が許容差を超えています。',
          { source_value: v.occupancy_after_application_source, calculated_value: round6(r.afterApplication), difference: round6(v.occupancy_after_application_source - r.afterApplication) });
      }
      if (r.confidence === 'low') add('low_confidence', 'warning', who + ' のデータ確度は low です。');
      r.hasInvalid = NUMERIC_FIELDS.some(function (f) { return r.invalid[f]; });
      if (r.hasInvalid) {
        issues.filter(function (i) { return i.type === 'numeric_type' && i.project_number === r.key && i.message.indexOf('properties[' + r.index + ']') === 0; })
          .forEach(function (i) { i.period = r.period; r.checks.push(i); });
      }
      return r;
    });
    return records;
  }

  function round6(x) { return Math.round(x * 1e6) / 1e6; }

  // ---------- 住戸明細 ----------

  // 日付は YYYY-MM-DD（/ . 区切りも可）のみ受け付け、通算日（UTC）に変換する
  function parseDateValue(v) {
    if (v === null || v === undefined) return { value: null, invalid: false };
    if (typeof v !== 'string') return { value: null, invalid: true };
    var s = nfkc(v).trim();
    if (s === '') return { value: null, invalid: false };
    var m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
    if (!m) return { value: null, invalid: true };
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    var t = Date.UTC(y, mo - 1, d);
    var dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { value: null, invalid: true };
    return { value: Math.round(t / 86400000), text: y + '-' + pad2(mo) + '-' + pad2(d), invalid: false };
  }

  function periodDay(period) {
    if (!period || !/^\d{8}$/.test(period)) return null;
    return parseDateValue(period.slice(0, 4) + '-' + period.slice(4, 6) + '-' + period.slice(6, 8)).value;
  }

  function dayText(day) {
    if (day === null || day === undefined) return null;
    var d = new Date(day * 86400000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function aliasValue(v, aliases) {
    if (v === null || v === undefined || v === '') return null;
    var k = headerKey(v);
    for (var canon in aliases) {
      if (!Object.prototype.hasOwnProperty.call(aliases, canon)) continue;
      if (aliases[canon].map(headerKey).indexOf(k) !== -1) return canon;
    }
    return undefined;
  }

  function normalizeUnits(units, metaPeriod, config, issues) {
    var out = [];
    if (units === undefined || units === null) return out;
    if (!Array.isArray(units)) {
      issues.push(issue('invalid_structure', 'error', 'units が配列ではありません。'));
      return out;
    }
    var U = config.units;
    var known = UNIT_NUMERIC_FIELDS.concat(UNIT_DATE_FIELDS, UNIT_TEXT_FIELDS);
    var unknownSeen = {}, deniedSeen = {};
    units.forEach(function (raw, idx) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push(issue('invalid_structure', 'error', 'units[' + idx + '] がオブジェクトではありません。'));
        return;
      }
      Object.keys(raw).forEach(function (k) {
        if (known.indexOf(k) !== -1) return;
        if (isDeniedField(k, config)) deniedSeen[k] = true; else unknownSeen[k] = true;
      });
      var u = { index: idx, values: {}, invalid: {}, dates: {}, dateText: {}, text: {}, checks: [] };
      u.project_key = normalizeKey(raw.project_number);
      u.unit_number = raw.unit_number === null || raw.unit_number === undefined ? null : normText(sanitizeText(raw.unit_number, config).value) || null;
      var ctx = 'units[' + idx + ']（' + (u.project_key || 'Project # なし') + ' ' + (u.unit_number || '住戸番号なし') + '）';
      UNIT_NUMERIC_FIELDS.forEach(function (f) {
        var r = readNumber(raw, f, ctx, issues);
        if (r.invalid) issues[issues.length - 1].project_number = u.project_key;
        u.values[f] = r.value;
        u.invalid[f] = r.invalid;
        if (isNum(r.value) && r.value < 0) issues.push(issue('negative_value', 'error', ctx + ' の「' + f + '」が負の値です: ' + r.value, { project_number: u.project_key, field: f }));
      });
      UNIT_DATE_FIELDS.forEach(function (f) {
        var d = parseDateValue(raw[f]);
        if (d.invalid) {
          issues.push(issue('date_format', 'error', ctx + ' の「' + f + '」が日付（YYYY-MM-DD）として読めません: ' + JSON.stringify(sanitizeText(raw[f], config).value), { project_number: u.project_key, field: f }));
          u.invalid[f] = true;
        }
        u.dates[f] = d.value;
        u.dateText[f] = d.text || null;
      });
      ['layout', 'unit_note', 'source_file_name'].forEach(function (f) {
        var s = sanitizeText(f === 'source_file_name' ? baseName(raw[f]) : raw[f], config).value;
        u.text[f] = s === null || s === '' ? null : s;
      });
      u.status = aliasValue(raw.leasing_status, U.statusAliases);
      u.status_raw = sanitizeText(raw.leasing_status, config).value;
      if (u.status === undefined) {
        issues.push(issue('unit_status_unknown', 'warning', ctx + ' の leasing_status「' + u.status_raw + '」を解釈できません。', { project_number: u.project_key }));
        u.status = null;
      }
      u.work_type = aliasValue(raw.work_type, U.workTypeAliases);
      if (u.work_type === undefined) {
        issues.push(issue('unit_status_unknown', 'warning', ctx + ' の work_type「' + sanitizeText(raw.work_type, config).value + '」を解釈できません。', { project_number: u.project_key }));
        u.work_type = null;
      }
      u.confidence = normalizeConfidence(raw.data_confidence);
      u.period = normalizePeriod(raw.report_date) || metaPeriod;
      if (!u.project_key) issues.push(issue('missing_project_number', 'error', ctx + ' に project_number がありません。'));
      if (!u.unit_number) issues.push(issue('missing_unit_number', 'error', ctx + ' に unit_number（住戸番号）がありません。', { project_number: u.project_key }));
      u.ctx = ctx;
      out.push(u);
    });
    var denied = Object.keys(deniedSeen), unknown = Object.keys(unknownSeen);
    if (denied.length) issues.push(issue('privacy_stripped', 'warning', '住戸明細の個人情報の可能性がある列を読み込みませんでした: ' + denied.join(', '), { columns: denied }));
    if (unknown.length) issues.push(issue('unknown_column', 'info', 'units の未知の列を無視しました: ' + unknown.join(', '), { columns: unknown }));
    return out;
  }

  function enrichUnits(units, master, records, config, issues) {
    var groups = {}, recByKey = {};
    records.forEach(function (r) { if (r.key && !r.duplicate) recByKey[r.key + '|' + r.period] = r; });
    units.forEach(function (u) {
      if (!u.project_key || !u.unit_number) return;
      u.key = u.project_key + '|' + normText(u.unit_number).toUpperCase();
      var g = u.key + '|' + u.period;
      (groups[g] = groups[g] || []).push(u);
    });
    units.forEach(function (u) {
      var add = function (type, severity, message, extra) {
        var it = issue(type, severity, message, Object.assign({ project_number: u.project_key, period: u.period, unit_number: u.unit_number }, extra || {}));
        issues.push(it); u.checks.push(it);
      };
      u.linked = !!(u.project_key && master.byKey[u.project_key]);
      u.property = u.project_key ? recByKey[u.project_key + '|' + u.period] || null : null;
      if (u.project_key && master.loaded && !u.linked) add('unit_unknown_project', 'error', u.ctx + ' の Project # は property_master.csv に存在しません。');
      u.duplicate = !!(u.key && groups[u.key + '|' + u.period].length > 1);
      if (u.duplicate) add('duplicate_unit', 'error', u.ctx + ' のレコードが同じ週に' + groups[u.key + '|' + u.period].length + '件あります（重複候補）。');
      // 空室日数: 空室開始日があれば基準日との差、なければ元データの空室日数
      var pd = periodDay(u.period);
      u.vacancyDays = null;
      u.vacancyBasis = null;
      if (u.dates.vacancy_start_date !== null && pd !== null) {
        var dd = pd - u.dates.vacancy_start_date;
        if (dd < 0) add('unit_date_inconsistent', 'warning', u.ctx + ' の空室開始日（' + u.dateText.vacancy_start_date + '）が基準日より後です。');
        else { u.vacancyDays = dd; u.vacancyBasis = 'date'; }
      }
      if (u.vacancyDays === null && isNum(u.values.vacancy_days)) { u.vacancyDays = u.values.vacancy_days; u.vacancyBasis = 'source'; }
      if (u.vacancyBasis === 'date' && isNum(u.values.vacancy_days) && Math.abs(u.values.vacancy_days - u.vacancyDays) > 1) {
        add('vacancy_days_mismatch', 'warning', u.ctx + ': 元データの空室日数（' + u.values.vacancy_days + '日）と空室開始日からの日数（' + u.vacancyDays + '日）が異なります。開始日からの日数を表示します。');
      }
      if (u.dates.work_start_date !== null && u.dates.work_end_date !== null && u.dates.work_end_date < u.dates.work_start_date) {
        add('unit_date_inconsistent', 'warning', u.ctx + ' の工事完了予定日が工事開始日より前です。');
      }
    });
    // 住戸明細の未入居住戸数と、物件レコードの空室戸数を突合する（住戸明細がある物件のみ）
    var counts = {};
    units.forEach(function (u) {
      if (!u.key || u.duplicate) return;
      var k = u.project_key + '|' + u.period;
      counts[k] = counts[k] || { n: 0, unknown: 0 };
      if (u.status === null) counts[k].unknown++;
      else if (config.units.vacantStatuses.indexOf(u.status) !== -1) counts[k].n++;
    });
    Object.keys(counts).forEach(function (k) {
      var r = recByKey[k];
      if (!r || !isNum(r.values.vacant_units) || counts[k].unknown) return;
      if (counts[k].n !== r.values.vacant_units) {
        issues.push(issue('unit_count_mismatch', 'warning', 'Project # ' + r.key + '（' + formatPeriod(r.period) + '）: 住戸明細の未入居住戸 ' + counts[k].n + '戸と物件の空室戸数 ' + r.values.vacant_units + '戸が一致しません。',
          { project_number: r.key, period: r.period }));
      }
    });
    return units;
  }

  function unitsForPeriod(model, period) {
    return model.units.filter(function (u) { return u.period === period; });
  }

  // 基準週の住戸の動き（長期空室・新規申込・申込取消・新規解約・条件変更・工事）
  function computeUnitActivity(model, period, config) {
    var U = config.units;
    var cur = unitsForPeriod(model, period).filter(function (u) { return u.key && !u.duplicate; });
    var prevP = previousPeriod(model, period);
    var prevMap = {}, hasPrev = false;
    if (prevP) unitsForPeriod(model, prevP).forEach(function (u) { if (u.key && !u.duplicate) { prevMap[u.key] = u; hasPrev = true; } });
    var pd = periodDay(period);
    var windowStart = prevP && periodDay(prevP) !== null ? periodDay(prevP) : (pd !== null ? pd - U.weekWindowDays : null);
    var inWindow = function (d) { return d !== null && pd !== null && windowStart !== null && d > windowStart && d <= pd; };
    var res = {
      available: model.units.length > 0, period: period, prevPeriod: prevP, hasPrev: hasPrev,
      windowText: windowStart !== null ? dayText(windowStart + 1) + ' 〜 ' + dayText(pd) : null,
      unitCount: cur.length, longVacancy: [], vacancyList: [], newApplications: [], cancellations: [], newNotices: [],
      conditionChanges: [], works: [], notJudged: { events: 0, conditions: 0 }
    };
    cur.forEach(function (u) {
      var prev = prevMap[u.key] || null;
      var base = { unit: u, project_number: u.project_key, unit_number: u.unit_number };
      if (u.status !== 'occupied' && u.status !== 'notice' && u.vacancyDays !== null) {
        res.vacancyList.push(Object.assign({ days: u.vacancyDays, basis: u.vacancyBasis }, base));
        if (u.vacancyDays >= config.alerts.longVacancyDays) res.longVacancy.push(Object.assign({ days: u.vacancyDays, basis: u.vacancyBasis }, base));
      }
      // 新規申込
      if (u.dates.application_date !== null) {
        if (inWindow(u.dates.application_date)) res.newApplications.push(Object.assign({ date: u.dateText.application_date, basis: 'date' }, base));
      } else if (u.status === 'application') {
        if (prev && (prev.status === 'vacant' || prev.status === 'notice')) res.newApplications.push(Object.assign({ date: null, basis: 'status', from: prev.status }, base));
        else if (!prev) res.notJudged.events++;
      }
      // 申込取消
      if (u.dates.application_cancel_date !== null) {
        if (inWindow(u.dates.application_cancel_date)) res.cancellations.push(Object.assign({ date: u.dateText.application_cancel_date, basis: 'date' }, base));
      } else if (prev && prev.status === 'application' && u.status === 'vacant') {
        res.cancellations.push(Object.assign({ date: null, basis: 'status', from: prev.status }, base));
      }
      // 新規解約（解約通知）
      if (u.dates.notice_date !== null) {
        if (inWindow(u.dates.notice_date)) res.newNotices.push(Object.assign({ date: u.dateText.notice_date, moveOut: u.dateText.move_out_date, basis: 'date' }, base));
      } else if (u.status === 'notice') {
        if (prev && prev.status === 'occupied') res.newNotices.push(Object.assign({ date: null, moveOut: u.dateText.move_out_date, basis: 'status', from: prev.status }, base));
        else if (!prev) res.notJudged.events++;
      }
      // 賃料条件の変更（前週の同じ住戸と比較）
      var hasCond = UNIT_CONDITION_FIELDS.some(function (c) { return isNum(u.values[c.key]); });
      if (prev) {
        var changes = [];
        UNIT_CONDITION_FIELDS.forEach(function (c) {
          var a = u.values[c.key], b = prev.values[c.key];
          if (isNum(a) && isNum(b) && a !== b) changes.push({ key: c.key, label: c.label, money: !!c.money, from: b, to: a });
        });
        if (changes.length) res.conditionChanges.push(Object.assign({ changes: changes }, base));
      } else if (hasCond) res.notJudged.conditions++;
      // 工事（リノベ・原状回復）
      if (u.work_type) {
        var done = u.dates.work_completed_date;
        if (done === null || inWindow(done)) {
          var left = u.dates.work_end_date !== null && pd !== null ? u.dates.work_end_date - pd : null;
          res.works.push(Object.assign({
            type: u.work_type, start: u.dateText.work_start_date, end: u.dateText.work_end_date, completed: u.dateText.work_completed_date,
            daysLeft: done === null ? left : null, overdue: done === null && left !== null && left < 0
          }, base));
        }
      }
    });
    res.vacancyList.sort(function (a, b) { return b.days - a.days; });
    res.longVacancy.sort(function (a, b) { return b.days - a.days; });
    res.works.sort(function (a, b) {
      var x = a.completed ? 1e9 : (a.daysLeft === null ? 1e8 : a.daysLeft), y = b.completed ? 1e9 : (b.daysLeft === null ? 1e8 : b.daysLeft);
      return x - y;
    });
    return res;
  }

  // 物件別の空室率（空室戸数 ÷ 総戸数）と前週差
  function vacancyRanking(model, period, records) {
    var prevP = previousPeriod(model, period);
    var prev = {};
    if (prevP) recordsForPeriod(model, prevP).forEach(function (r) { if (r.key && !r.duplicate) prev[r.key] = r; });
    var rate = function (r) { return r && isNum(r.values.vacant_units) && isNum(r.values.total_units) && r.values.total_units > 0 ? r.values.vacant_units / r.values.total_units : null; };
    return records.filter(function (r) { return r.key && !r.duplicate; }).map(function (r) {
      var cur = rate(r), p = rate(prev[r.key]);
      return { record: r, project_number: r.key, rate: cur, prevRate: p, delta: diff(cur, p) };
    }).sort(function (a, b) {
      if (a.rate === null && b.rate === null) return 0;
      if (a.rate === null) return 1;
      if (b.rate === null) return -1;
      return b.rate - a.rate;
    });
  }

  function loadAll(texts, config) {
    var parsed = safeParseJSON(texts.dashboardDataText);
    if (!parsed.ok) {
      return { ok: false, fatal: issue('json_syntax', 'error', 'dashboard_data.json: ' + parsed.error), issues: [] };
    }
    return buildModel(parsed.value, texts.propertyMasterText, texts.validationReportText, config);
  }

  function buildModel(json, masterText, reportText, config) {
    var ds = normalizeDataset(json, config);
    var master = loadMaster(masterText, config);
    var report = loadValidationReport(reportText, config);
    var issues = [].concat(ds.issues, master.issues, report.issues);
    var files = mergeFiles(ds, report, issues);
    var countsOk = reconcileCounts(ds, report, files, issues);
    var records = enrichRecords(ds, master, config, issues);
    var units = enrichUnits(ds.units, master, records, config, issues);
    files.forEach(function (f) {
      if (f.result === 'failed') issues.push(issue('read_failure', 'warning', 'ファイル「' + f.file_name + '」は読取失敗です' + (f.report && f.report.reason ? '（' + f.report.reason + '）' : '') + '。', { file_name: f.file_name }));
      if (f.result === 'partial') issues.push(issue('partial_read', 'warning', 'ファイル「' + f.file_name + '」は一部のみ読み取れています。', { file_name: f.file_name }));
    });
    var periodSet = {};
    records.forEach(function (r) { if (r.period) periodSet[r.period] = true; });
    units.forEach(function (u) { if (u.period) periodSet[u.period] = true; });
    if (ds.meta.period) periodSet[ds.meta.period] = true;
    var periods = Object.keys(periodSet).sort().reverse();
    var model = {
      ok: true,
      meta: ds.meta, summarySource: ds.summary, validationSummary: ds.validationSummary,
      jsonAlerts: ds.alerts, files: files, countsReconciled: countsOk,
      master: master, report: report, records: records, units: units, periods: periods,
      period: ds.meta.period, periodLabel: formatPeriod(ds.meta.period),
      unknownColumns: { json: ds.unknownColumns, master: master.unknownColumns, report: report.unknownColumns },
      issues: sortIssues(issues)
    };
    reconcileSummary(model, config);
    model.issues = sortIssues(model.issues);
    model.publishable = isPublishable(model);
    return model;
  }

  // 元データの portfolio_summary に数値がある場合、再計算値と突合する
  function reconcileSummary(model, config) {
    var vals = model.summarySource.values;
    if (!Object.keys(vals).length || !model.period) return;
    var s = summarize(recordsForPeriod(model, model.period), [], model, config);
    var pairs = {
      property_count: s.propertyCount.value, total_units: s.total_units.value, occupied_units: s.occupied_units.value,
      vacant_units: s.vacant_units.value, application_units: s.application_units.value,
      scheduled_contract_units: s.scheduled_contract_units.value, scheduled_termination_units: s.scheduled_termination_units.value,
      occupancy_rate: s.occupancy.value, occupancy_after_application: s.afterApplication.value
    };
    Object.keys(vals).forEach(function (f) {
      var src = vals[f], calc = pairs[f];
      if (!isNum(src) || calc === null || calc === undefined) return;
      var tol = /rate|after/.test(f) ? config.calc.rateTolerance : 0;
      if (Math.abs(src - calc) > tol) {
        model.issues.push(issue('summary_mismatch', 'error', 'portfolio_summary.' + f + '(' + src + ') が物件明細からの再計算値(' + round6(calc) + ') と一致しません。',
          { field: f, source_value: src, calculated_value: round6(calc), difference: round6(src - calc) }));
      }
    });
  }

  var BLOCKING_TYPES = ['json_syntax', 'invalid_structure', 'missing_source_period', 'count_reconcile', 'missing_validation_row', 'missing_column'];
  function isPublishable(model) {
    return !model.issues.some(function (i) { return i.severity === 'error' && BLOCKING_TYPES.indexOf(i.type) !== -1; });
  }

  // ---------- 集計 ----------

  function recordsForPeriod(model, period) {
    return model.records.filter(function (r) { return r.period === period; });
  }

  function previousPeriod(model, period) {
    var list = model.periods.filter(function (p) { return p < period; });
    return list.length ? list[0] : null;
  }

  function isEligible(r, config) {
    return !!r.key && !r.duplicate && (r.linked || config.calc.includeUnlinkedInPortfolio);
  }

  function sumField(records, f) {
    var vals = [], missing = 0, invalid = 0;
    records.forEach(function (r) {
      if (r.invalid[f]) invalid++;
      else if (isNum(r.values[f])) vals.push(r.values[f]);
      else missing++;
    });
    var value = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) : null;
    return { value: value, count: vals.length, missing: missing, invalid: invalid, partial: vals.length > 0 && (missing + invalid) > 0 };
  }

  function summarize(records, prevRecords, model, config) {
    var eligible = records.filter(function (r) { return isEligible(r, config); });
    var out = { recordCount: records.length, eligibleCount: eligible.length, excluded: records.length - eligible.length };
    out.propertyCount = { value: eligible.length };
    ['total_units', 'occupied_units', 'vacant_units', 'application_units', 'scheduled_contract_units', 'scheduled_termination_units',
      'inquiry_count', 'viewing_count', 'application_count', 'contract_count'].forEach(function (f) { out[f] = sumField(eligible, f); });
    out.occupancy = weightedRate(eligible, false);
    out.afterApplication = weightedRate(eligible, true);

    var reasons = [];
    if (eligible.some(function (r) { return r.confidence === 'low'; })) reasons.push('低確度（low）のデータを含む');
    if (eligible.some(function (r) { return r.confidence === null; })) reasons.push('データ確度が不明なレコードを含む');
    if (eligible.some(function (r) { return r.hasInvalid; })) reasons.push('数値不正のレコードを含む');
    if (['total_units', 'occupied_units', 'vacant_units', 'application_units'].some(function (f) { return out[f].partial; })) reasons.push('一部の物件で値が欠損');
    if (out.excluded > 0) reasons.push('重複・未紐付け等の ' + out.excluded + ' 件を除外');
    if (model && config.calc.provisionalWhenFilesFailed && model.files.some(function (f) { return f.result === 'failed' || f.result === 'partial'; })) {
      reasons.push('読取失敗・一部読取のファイルあり');
    }
    if (model && (model.summarySource.is_provisional || model.meta.is_provisional)) reasons.push('元データで暫定と指定');
    out.provisional = reasons.length > 0;
    out.provisionalReasons = reasons;

    if (prevRecords && prevRecords.length) {
      var prevEligible = prevRecords.filter(function (r) { return isEligible(r, config); });
      var prev = summarize(prevRecords, null, null, config);
      out.prev = prev;
      // 前週比は「両週とも値がある物件」同士で比較する（欠損を 0 とみなさない）
      var prevByKey = {};
      prevEligible.forEach(function (r) { prevByKey[r.key] = r; });
      var pairs = eligible.filter(function (r) { return prevByKey[r.key]; }).map(function (r) { return [r, prevByKey[r.key]]; });
      out.delta = { matchedProperties: pairs.length };
      ['total_units', 'occupied_units', 'vacant_units', 'application_units', 'scheduled_contract_units', 'scheduled_termination_units'].forEach(function (f) {
        var both = pairs.filter(function (p) { return isNum(p[0].values[f]) && isNum(p[1].values[f]); });
        out.delta[f] = both.length ? both.reduce(function (s, p) { return s + p[0].values[f] - p[1].values[f]; }, 0) : null;
        out.delta[f + '_matched'] = both.length;
      });
      out.delta.propertyCount = diff(out.propertyCount.value, prev.propertyCount.value);
      [['occupancy', false], ['afterApplication', true]].forEach(function (d) {
        var both = pairs.filter(function (p) {
          return d[1] ? p[0].afterApplication !== null && p[1].afterApplication !== null : p[0].occupancy !== null && p[1].occupancy !== null;
        });
        var cur = weightedRate(both.map(function (p) { return p[0]; }), d[1]).value;
        var old = weightedRate(both.map(function (p) { return p[1]; }), d[1]).value;
        out.delta[d[0]] = diff(cur, old);
        out.delta[d[0] + '_matched'] = both.length;
      });
      var a = eligible.map(function (r) { return r.key; }).sort().join('|');
      var b = prevEligible.map(function (r) { return r.key; }).sort().join('|');
      out.compositionChanged = a !== b;
      out.delta.partial = ['occupied_units', 'occupancy'].some(function (f) { return out.delta[f + '_matched'] < pairs.length; }) || out.compositionChanged;
    } else {
      out.prev = null;
      out.delta = null;
    }
    return out;
  }

  function diff(a, b) { return isNum(a) && isNum(b) ? a - b : null; }

  // 加重稼働率 = sum(稼働) / sum(総戸数)。対象レコードがなければ null。
  function weightedRate(records, afterApp) {
    var num = 0, den = 0, n = 0;
    records.forEach(function (r) {
      var v = r.values;
      if (afterApp) {
        if (r.afterApplication === null) return;
        num += v.occupied_units + v.application_units; den += v.total_units; n++;
      } else {
        if (r.occupancy === null) return;
        num += v.occupied_units; den += v.total_units; n++;
      }
    });
    return { value: n && den > 0 ? num / den : null, count: n, missing: records.length - n, partial: n > 0 && n < records.length };
  }

  // ---------- アラート ----------

  var ALERT_CATEGORIES = [
    { key: 'occupancy_drop', label: '稼働率低下' },
    { key: 'long_vacancy', label: '長期空室' },
    { key: 'termination_increase', label: '解約増加' },
    { key: 'application_cancel', label: '申込取消' },
    { key: 'asking_rent_change', label: '募集賃料変更' },
    { key: 'ad_fr_change', label: 'ADまたはFR変更' },
    { key: 'source_mismatch', label: '元データ不一致' },
    { key: 'low_confidence', label: '低確度データ' },
    { key: 'read_failure', label: '読取失敗ファイル' }
  ];

  function codeCategory(code, config) {
    var pats = config.alerts.codePatterns;
    var c = String(code || '');
    for (var k in pats) if (Object.prototype.hasOwnProperty.call(pats, k) && new RegExp(pats[k], 'i').test(c)) return k;
    return null;
  }

  function computeAlerts(model, period, config) {
    var A = config.alerts;
    var recs = recordsForPeriod(model, period);
    var prevP = previousPeriod(model, period);
    var prevMap = {};
    if (prevP) recordsForPeriod(model, prevP).forEach(function (r) { if (r.key && !r.duplicate) prevMap[r.key] = r; });
    var cats = {};
    ALERT_CATEGORIES.forEach(function (c) { cats[c.key] = { key: c.key, label: c.label, items: [], judgeable: true, note: null, notJudged: 0 }; });
    var push = function (cat, item) { cats[cat].items.push(item); };
    var noRecords = recs.length === 0;
    var naNoRecords = '物件データなし';
    var naNoPrev = '前週データなし';

    // 前週比が必要なカテゴリ
    function compare(catKey, test) {
      var cat = cats[catKey];
      if (noRecords) { cat.judgeable = false; cat.note = naNoRecords; return; }
      if (!prevP) { cat.judgeable = false; cat.note = naNoPrev; return; }
      var judged = 0;
      recs.forEach(function (r) {
        var p = r.key ? prevMap[r.key] : null;
        if (!p) { cat.notJudged++; return; }
        var res = test(r, p);
        if (res === null) { cat.notJudged++; return; }
        judged++;
        if (res) push(catKey, Object.assign({ project_number: r.key, period: r.period }, res));
      });
      if (judged === 0) { cat.judgeable = false; cat.note = '比較可能な値なし'; }
    }

    compare('occupancy_drop', function (r, p) {
      if (r.occupancy === null || p.occupancy === null) return null;
      var d = r.occupancy - p.occupancy;
      return d <= -A.occupancyDropThreshold - 1e-12 ? { message: '稼働率 ' + fmtRate(p.occupancy, config) + ' → ' + fmtRate(r.occupancy, config) + '（' + fmtPt(d, config) + '）', value: d } : false;
    });
    compare('termination_increase', function (r, p) {
      var a = r.values.scheduled_termination_units, b = p.values.scheduled_termination_units;
      if (!isNum(a) || !isNum(b)) return null;
      return a > b ? { message: '解約予定 ' + b + '戸 → ' + a + '戸（+' + (a - b) + '）', value: a - b } : false;
    });
    compare('ad_fr_change', function (r, p) {
      var msgs = [], judged = false;
      ['ad', 'fr'].forEach(function (f) {
        var a = r.values[f], b = p.values[f];
        if (!isNum(a) || !isNum(b)) return;
        judged = true;
        if (a !== b) msgs.push(f.toUpperCase() + ' ' + fmtNum(b) + ' → ' + fmtNum(a));
      });
      if (!judged) return null;
      return msgs.length ? { message: msgs.join(' / ') + '（' + config.display.adFrUnitNote + '）' } : false;
    });

    // 長期空室
    (function () {
      var cat = cats.long_vacancy;
      if (noRecords) { cat.judgeable = false; cat.note = naNoRecords; return; }
      var judged = 0;
      recs.forEach(function (r) {
        var lu = r.values.long_vacancy_units, md = r.values.maximum_vacancy_days;
        if (!isNum(lu) && !isNum(md)) { cat.notJudged++; return; }
        judged++;
        var msgs = [];
        if (isNum(lu) && lu > 0) msgs.push('長期空室 ' + lu + '戸');
        if (isNum(md) && md >= A.longVacancyDays) msgs.push('最大空室日数 ' + md + '日（基準 ' + A.longVacancyDays + '日以上）');
        if (msgs.length) push('long_vacancy', { project_number: r.key, period: r.period, message: msgs.join(' / '), value: isNum(md) ? md : lu });
      });
      if (!judged) { cat.judgeable = false; cat.note = '長期空室・空室日数の値なし'; }
    })();

    // 申込取消（専用列が仕様にないため、任意列・コメント語句・元データのアラートで検出）
    (function () {
      var cat = cats.application_cancel;
      recs.forEach(function (r) {
        var c = r.values.application_cancel_count;
        if (isNum(c) && c > 0) { push('application_cancel', { project_number: r.key, period: r.period, message: '申込取消 ' + c + '件' }); return; }
        var texts = [r.text.major_change_from_previous_week, r.text.pm_comment, r.text.leasing_issue].filter(Boolean).join(' ');
        var hit = A.cancellationKeywords.filter(function (k) { return texts.indexOf(k) !== -1; });
        if (hit.length) push('application_cancel', { project_number: r.key, period: r.period, message: 'コメントに「' + hit[0] + '」の記載あり（要確認）' });
      });
      if (noRecords) { cat.judgeable = false; cat.note = naNoRecords; }
      else cat.note = '専用列がないため、コメント中の語句で検出';
    })();

    // 募集賃料変更
    (function () {
      var cat = cats.asking_rent_change;
      if (noRecords) { cat.judgeable = false; cat.note = naNoRecords; return; }
      var judged = 0;
      recs.forEach(function (r) {
        var rev = r.values.rent_revision_amount, p = r.key ? prevMap[r.key] : null;
        var a = r.values.asking_rent, b = p ? p.values.asking_rent : null;
        var can = isNum(rev) || (isNum(a) && isNum(b));
        if (!can) { cat.notJudged++; return; }
        judged++;
        var msgs = [];
        if (isNum(rev) && rev !== 0) msgs.push('賃料改定額 ' + fmtMoney(rev, config, true));
        if (isNum(a) && isNum(b) && a !== b) msgs.push('募集賃料 ' + fmtMoney(b, config) + ' → ' + fmtMoney(a, config));
        if (msgs.length) push('asking_rent_change', { project_number: r.key, period: r.period, message: msgs.join(' / ') });
      });
      if (!judged) { cat.judgeable = false; cat.note = prevP ? '比較可能な値なし' : naNoPrev; }
    })();

    // 元データ不一致・低確度（レコード起因）
    var mismatchTypes = ['unit_sum_mismatch', 'rate_mismatch', 'after_app_mismatch', 'name_mismatch'];
    recs.forEach(function (r) {
      r.checks.forEach(function (c) {
        if (mismatchTypes.indexOf(c.type) !== -1) push('source_mismatch', { project_number: r.key, period: r.period, message: c.message, type: c.type });
      });
      if (r.confidence === 'low') push('low_confidence', { project_number: r.key, period: r.period, message: 'データ確度 low' });
    });
    if (period === model.period) {
      model.issues.forEach(function (i) {
        if (i.type === 'summary_mismatch' || i.type === 'count_reconcile') push('source_mismatch', { message: i.message, type: i.type, file_name: i.file_name || null });
      });
      // ファイル起因（検証レポート・ファイル一覧は source_period の週のもの）
      var undetermined = 0;
      model.files.forEach(function (f) {
        var r = f.report;
        if (f.result === 'failed') push('read_failure', { file_name: f.file_name, message: r && r.reason ? r.reason : '読取失敗' });
        if (r) {
          if (r.numeric_mismatch_flag === 'yes') push('source_mismatch', { file_name: f.file_name, project_number: r.target_property, message: '検証レポート: 数値不一致あり' });
          if (r.name_mismatch_flag === 'yes') push('source_mismatch', { file_name: f.file_name, project_number: r.target_property, message: '検証レポート: 物件名不一致あり' });
          if (r.numeric_mismatch_flag === 'undetermined' || r.name_mismatch_flag === 'undetermined') undetermined++;
          if (r.confidence === 'low') push('low_confidence', { file_name: f.file_name, project_number: r.target_property, message: '検証レポート: データ確度 low' });
        }
      });
      if (undetermined) cats.source_mismatch.note = '検証レポート上で不一致が未判定のファイル ' + undetermined + '件';
      model.jsonAlerts.forEach(function (a) {
        var cat = codeCategory(a.code, config);
        var key = cat === 'mismatch' ? 'source_mismatch' : cat === 'cancellation' ? 'application_cancel' : cat === 'low_confidence' ? 'low_confidence' : cat === 'read_failure' ? 'read_failure' : null;
        if (key) push(key, { project_number: a.project_number, message: '元データのアラート ' + (a.code || '') + ': ' + (a.message || ''), fromSource: true, severity: a.severity });
      });
    }
    // 住戸明細がある場合は住戸単位の項目も加える
    var ua = computeUnitActivity(model, period, config);
    if (ua.unitCount) {
      var unitLabel = function (x) { return '住戸 ' + x.unit_number + ': '; };
      ua.longVacancy.forEach(function (x) { push('long_vacancy', { project_number: x.project_number, unit_number: x.unit_number, period: period, message: unitLabel(x) + '空室 ' + x.days + '日（基準 ' + A.longVacancyDays + '日以上）', value: x.days }); });
      ua.cancellations.forEach(function (x) { push('application_cancel', { project_number: x.project_number, unit_number: x.unit_number, period: period, message: unitLabel(x) + '申込取消' + (x.date ? '（' + x.date + '）' : '（前週は申込あり、今週は空室）') }); });
      ua.conditionChanges.forEach(function (x) {
        var rent = x.changes.filter(function (c) { return c.key === 'asking_rent' || c.key === 'common_fee'; });
        var adfr = x.changes.filter(function (c) { return c.key === 'ad' || c.key === 'fr'; });
        var fmt = function (c) { return c.label + ' ' + (c.money ? fmtMoney(c.from, config) : fmtNum(c.from)) + ' → ' + (c.money ? fmtMoney(c.to, config) : fmtNum(c.to)); };
        if (rent.length) push('asking_rent_change', { project_number: x.project_number, unit_number: x.unit_number, period: period, message: unitLabel(x) + rent.map(fmt).join(' / ') });
        if (adfr.length) push('ad_fr_change', { project_number: x.project_number, unit_number: x.unit_number, period: period, message: unitLabel(x) + adfr.map(fmt).join(' / ') });
      });
      ['long_vacancy', 'application_cancel', 'asking_rent_change', 'ad_fr_change'].forEach(function (k) {
        if (cats[k].items.some(function (i) { return i.unit_number; })) { cats[k].judgeable = true; cats[k].note = cats[k].note === naNoRecords || cats[k].note === naNoPrev ? '住戸明細から判定' : cats[k].note; }
      });
    }
    var other = period === model.period ? model.jsonAlerts.filter(function (a) {
      var c = codeCategory(a.code, config);
      return c === null || c === 'duplicate';
    }) : [];

    var byProject = {};
    ALERT_CATEGORIES.forEach(function (c) {
      cats[c.key].items.forEach(function (it) {
        if (it.project_number) (byProject[it.project_number] = byProject[it.project_number] || []).push(c.label);
      });
    });
    return { period: period, prevPeriod: prevP, categories: ALERT_CATEGORIES.map(function (c) { return cats[c.key]; }), byProject: byProject, other: other };
  }

  // ---------- フィルター ----------

  function rateBand(rate, config) {
    if (!isNum(rate)) return 'none';
    var bands = config.occupancyBands;
    for (var i = 0; i < bands.length; i++) {
      var b = bands[i];
      if (rate >= b.min && (b.max === null || rate < b.max)) return b.id;
    }
    return 'none';
  }

  function includesText(hay, needle) {
    if (!needle) return true;
    return normText(hay).toLowerCase().indexOf(normText(needle).toLowerCase()) !== -1;
  }

  function displayName(r, f) { return r.names[f] !== null && r.names[f] !== undefined ? r.names[f] : r.names[f + '_unlinked']; }

  function filterRecords(records, f, alerts, config) {
    f = f || {};
    return records.filter(function (r) {
      if (f.projectNumber && r.key !== normalizeKey(f.projectNumber)) return false;
      if (f.projectName && !includesText(displayName(r, 'project_name'), f.projectName)) return false;
      if (f.propertyNameJa && !includesText(displayName(r, 'property_name_ja'), f.propertyNameJa)) return false;
      if (f.spc && displayName(r, 'spc') !== f.spc) return false;
      if (f.am && displayName(r, 'am') !== f.am) return false;
      if (f.pm && displayName(r, 'pm') !== f.pm) return false;
      if (f.band && rateBand(r.occupancy, config) !== f.band) return false;
      if (f.confidence && (r.confidence || 'none') !== f.confidence) return false;
      if (f.alert) {
        var has = !!(alerts && alerts.byProject[r.key] && alerts.byProject[r.key].length);
        if (f.alert === 'yes' && !has) return false;
        if (f.alert === 'no' && has) return false;
      }
      if (f.duplicate === 'yes' && !r.duplicate) return false;
      if (f.duplicate === 'no' && r.duplicate) return false;
      return true;
    });
  }

  // ---------- 書式 ----------

  function nullLabel(config) { return (config && config.display && config.display.nullLabel) || 'データなし'; }

  function fmtNum(v, config, opts) {
    if (v === null || v === undefined) return nullLabel(config);
    if (!isNum(v)) return (config && config.display.invalidLabel) || '数値不正';
    return v.toLocaleString('ja-JP', { maximumFractionDigits: (opts && opts.maxDigits !== undefined) ? opts.maxDigits : 2 });
  }

  function fmtCount(v, config, invalid) {
    if (invalid) return (config && config.display.invalidLabel) || '数値不正';
    return fmtNum(v, config, { maxDigits: 2 });
  }

  function fixed(x, d) {
    var s = x.toFixed(d);
    return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
  }

  function fmtRate(v, config, invalid) {
    if (invalid) return (config && config.display.invalidLabel) || '数値不正';
    if (v === null || v === undefined) return nullLabel(config);
    if (!isNum(v)) return (config && config.display.invalidLabel) || '数値不正';
    var d = config ? config.display.rateDecimals : 1;
    return fixed(v * 100, d) + '%';
  }

  function fmtPt(d, config) {
    if (d === null || d === undefined || !isNum(d)) return nullLabel(config);
    var dec = config ? config.display.rateDecimals : 1;
    var s = fixed(d * 100, dec);
    return (Number(s) > 0 ? '+' : '') + s + 'pt';
  }

  function fmtDelta(d, config, unit) {
    if (d === null || d === undefined || !isNum(d)) return nullLabel(config);
    return (d > 0 ? '+' : '') + d.toLocaleString('ja-JP') + (unit || '');
  }

  function moneyUnitLabel(config) { return config && config.display.moneyUnit === 'yen' ? '円' : '万円'; }

  function fmtMoney(yen, config, signed, invalid) {
    if (invalid) return (config && config.display.invalidLabel) || '数値不正';
    if (yen === null || yen === undefined) return nullLabel(config);
    if (!isNum(yen)) return (config && config.display.invalidLabel) || '数値不正';
    var sign = signed && yen > 0 ? '+' : '';
    if (config && config.display.moneyUnit === 'yen') return sign + Math.round(yen).toLocaleString('ja-JP') + '円';
    var man = yen / 10000;
    var s = Number(fixed(man, 1)).toLocaleString('ja-JP', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return sign + s + '万円';
  }

  function confidenceLabel(c) {
    return c === 'high' ? '高（high）' : c === 'medium' ? '中（medium）' : c === 'low' ? '低（low）' : 'データなし';
  }

  // ---------- CSV 出力（個人情報を含まない列のみ） ----------

  var EXPORT_COLUMNS = [
    ['project_number', 'Project #'], ['project_name', 'Project Name'], ['property_name_ja', '日本語物件名'],
    ['spc', 'SPC'], ['am', 'AM'], ['pm', 'PM'], ['period', '基準週'], ['total_units', '総戸数'],
    ['occupied_units', '稼働戸数'], ['vacant_units', '空室戸数'], ['occupancy', '稼働率'],
    ['application_count', '申込件数'], ['application_units', '申込戸数'], ['scheduled_termination_units', '解約予定戸数'],
    ['data_confidence', 'データ確度']
  ];

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // 数式インジェクション対策
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportRecordsCSV(records) {
    var lines = [EXPORT_COLUMNS.map(function (c) { return csvCell(c[1]); }).join(',')];
    records.forEach(function (r) {
      lines.push(EXPORT_COLUMNS.map(function (c) {
        var k = c[0];
        if (k === 'project_number') return csvCell(r.key);
        if (NAME_FIELDS.indexOf(k) !== -1) return csvCell(displayName(r, k));
        if (k === 'period') return csvCell(formatPeriod(r.period));
        if (k === 'occupancy') return csvCell(r.occupancy === null ? null : round6(r.occupancy));
        if (k === 'data_confidence') return csvCell(r.confidence);
        return csvCell(r.invalid[k] ? null : r.values[k]);
      }).join(','));
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  return {
    NUMERIC_FIELDS: NUMERIC_FIELDS, TEXT_FIELDS: TEXT_FIELDS, MONEY_FIELDS: MONEY_FIELDS, NAME_FIELDS: NAME_FIELDS,
    ALERT_CATEGORIES: ALERT_CATEGORIES, ISSUE_LABELS: ISSUE_LABELS, EXPORT_COLUMNS: EXPORT_COLUMNS,
    isNum: isNum, normalizeKey: normalizeKey, normalizePeriod: normalizePeriod, formatPeriod: formatPeriod,
    hashText: hashText, safeParseJSON: safeParseJSON, parseCSV: parseCSV, parseNumberCell: parseNumberCell,
    mapColumns: mapColumns, sanitizeText: sanitizeText, isDeniedField: isDeniedField, baseName: baseName,
    loadMaster: loadMaster, loadValidationReport: loadValidationReport, normalizeDataset: normalizeDataset,
    dedupeSourceFiles: dedupeSourceFiles, loadAll: loadAll, buildModel: buildModel,
    recordsForPeriod: recordsForPeriod, previousPeriod: previousPeriod, summarize: summarize, sumField: sumField,
    UNIT_CONDITION_FIELDS: UNIT_CONDITION_FIELDS, UNIT_STATUS_LABELS: UNIT_STATUS_LABELS, WORK_TYPE_LABELS: WORK_TYPE_LABELS,
    parseDateValue: parseDateValue, unitsForPeriod: unitsForPeriod, computeUnitActivity: computeUnitActivity, vacancyRanking: vacancyRanking,
    computeAlerts: computeAlerts, rateBand: rateBand, filterRecords: filterRecords, displayName: displayName,
    fmtNum: fmtNum, fmtCount: fmtCount, fmtRate: fmtRate, fmtPt: fmtPt, fmtDelta: fmtDelta, fmtMoney: fmtMoney,
    moneyUnitLabel: moneyUnitLabel, confidenceLabel: confidenceLabel, exportRecordsCSV: exportRecordsCSV, csvCell: csvCell
  };
});
