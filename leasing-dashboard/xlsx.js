/*
 * 最小限の XLSX リーダー（外部依存なし）
 *
 * ZIP を展開し、ブック・シート・共有文字列・結合セルを読む。数式は計算せず、
 * ファイルに保存されている計算結果（キャッシュ値）だけを使う。キャッシュ値がない数式は null。
 * ブラウザでは DecompressionStream('deflate-raw')、Node では zlib を使う。
 * 入力のバイト列は変更しない。
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.LeasingXlsx = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMITS = { maxEntries: 5000, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 };

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216; }

  var utf8 = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;
  function decodeUtf8(bytes) {
    if (utf8) return utf8.decode(bytes);
    return Buffer.from(bytes).toString('utf8');
  }

  // 既定の deflate-raw 展開関数
  function defaultInflateRaw(bytes) {
    if (typeof DecompressionStream !== 'undefined' && typeof Response !== 'undefined') {
      var ds = new DecompressionStream('deflate-raw');
      var stream = new Blob([bytes]).stream().pipeThrough(ds);
      return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
    }
    if (typeof require === 'function') {
      var zlib = require('zlib');
      return Promise.resolve(new Uint8Array(zlib.inflateRawSync(bytes)));
    }
    return Promise.reject(new Error('この環境では ZIP を展開できません'));
  }

  // ZIP の中央ディレクトリを読む（ZIP64 は非対応）
  function listZip(bytes) {
    var min = Math.max(0, bytes.length - 65557);
    var eocd = -1;
    for (var i = bytes.length - 22; i >= min; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP 形式ではありません（.xlsx ではない可能性があります）');
    var count = u16(bytes, eocd + 10);
    var off = u32(bytes, eocd + 16);
    if (count > LIMITS.maxEntries) throw new Error('ZIP のエントリ数が多すぎます');
    var entries = {};
    for (var n = 0; n < count; n++) {
      if (u32(bytes, off) !== 0x02014b50) throw new Error('ZIP の中央ディレクトリが壊れています');
      var method = u16(bytes, off + 10), csize = u32(bytes, off + 20), usize = u32(bytes, off + 24);
      var nlen = u16(bytes, off + 28), xlen = u16(bytes, off + 30), clen = u16(bytes, off + 32), lho = u32(bytes, off + 42);
      var name = decodeUtf8(bytes.subarray(off + 46, off + 46 + nlen));
      entries[name] = { name: name, method: method, csize: csize, usize: usize, lho: lho };
      off += 46 + nlen + xlen + clen;
    }
    return entries;
  }

  function readEntry(bytes, e, inflateRaw) {
    if (e.usize > LIMITS.maxEntryBytes) return Promise.reject(new Error('展開後のサイズが大きすぎます: ' + e.name));
    if (u32(bytes, e.lho) !== 0x04034b50) return Promise.reject(new Error('ZIP のローカルヘッダが壊れています: ' + e.name));
    var start = e.lho + 30 + u16(bytes, e.lho + 26) + u16(bytes, e.lho + 28);
    var data = bytes.subarray(start, start + e.csize);
    if (e.method === 0) return Promise.resolve(data);
    if (e.method === 8) return inflateRaw(data);
    return Promise.reject(new Error('未対応の圧縮方式です: ' + e.method));
  }

  // ---------- XML ----------

  function decodeXml(s) {
    if (s.indexOf('&') === -1) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, function (m, g) {
      if (g === 'amp') return '&';
      if (g === 'lt') return '<';
      if (g === 'gt') return '>';
      if (g === 'quot') return '"';
      if (g === 'apos') return "'";
      var code = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return String.fromCodePoint(code);
    });
  }

  function attrs(s) {
    var o = {}, re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, m;
    while ((m = re.exec(s))) o[m[1]] = decodeXml(m[3] !== undefined ? m[3] : m[4]);
    return o;
  }

  // 文字列項目のテキスト（ふりがな rPh は除く）
  function textOf(xml) {
    xml = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').replace(/<phoneticPr\b[^>]*\/>/g, '');
    var out = '', re = /<t\b[^>]*>([\s\S]*?)<\/t>/g, m;
    while ((m = re.exec(xml))) out += decodeXml(m[1]);
    return out;
  }

  function colToNum(col) {
    var n = 0;
    for (var i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64);
    return n;
  }
  function numToCol(n) {
    var s = '';
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function parseRef(ref) {
    var m = /^([A-Z]+)(\d+)$/.exec(ref);
    return m ? { col: colToNum(m[1]), row: Number(m[2]) } : null;
  }

  function parseSheet(xml, sst) {
    var rows = {}, maxRow = 0, maxCol = 0, merges = [], formulasWithoutValue = 0;
    var rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, rm, autoRow = 0;
    while ((rm = rowRe.exec(xml))) {
      var ra = attrs(rm[1]);
      var r = ra.r ? Number(ra.r) : autoRow + 1;
      autoRow = r;
      if (!rm[2]) continue;
      var cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cm, autoCol = 0;
      while ((cm = cellRe.exec(rm[2]))) {
        var ca = attrs(cm[1]);
        var pos = ca.r ? parseRef(ca.r) : { row: r, col: autoCol + 1 };
        if (!pos) continue;
        autoCol = pos.col;
        var inner = cm[2] || '';
        var hasF = /<f\b/.test(inner);
        var vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        var t = ca.t || 'n', v = null, err = null;
        if (t === 'inlineStr') {
          var im = /<is>([\s\S]*?)<\/is>/.exec(inner);
          v = im ? textOf(im[1]) : null;
        } else if (vm) {
          var raw = decodeXml(vm[1]);
          if (t === 's') v = sst[Number(raw)] !== undefined ? sst[Number(raw)] : null;
          else if (t === 'str' || t === 'd') v = raw;
          else if (t === 'b') v = raw === '1';
          else if (t === 'e') { err = raw; v = null; }
          else v = raw === '' ? null : Number(raw);
        }
        // 数式で計算結果が保存されていない（<v> がない、または空）セル
        var noCache = hasF && t !== 'inlineStr' && (!vm || vm[1] === '');
        if (noCache) formulasWithoutValue++;
        if (v === null && !hasF && err === null) continue;
        (rows[pos.row] = rows[pos.row] || {})[pos.col] = { v: v, f: hasF, err: err, cached: !noCache };
        if (pos.row > maxRow) maxRow = pos.row;
        if (pos.col > maxCol) maxCol = pos.col;
      }
    }
    var mm, mre = /<mergeCell\b[^>]*ref="([A-Z]+\d+):([A-Z]+\d+)"/g;
    while ((mm = mre.exec(xml))) merges.push({ from: parseRef(mm[1]), to: parseRef(mm[2]) });
    return { rows: rows, maxRow: maxRow, maxCol: maxCol, merges: merges, formulasWithoutValue: formulasWithoutValue };
  }

  function makeSheet(name, parsed) {
    var s = { name: name, rows: parsed.rows, maxRow: parsed.maxRow, maxCol: parsed.maxCol, merges: parsed.merges, formulasWithoutValue: parsed.formulasWithoutValue };
    s.cell = function (r, c) { return (parsed.rows[r] && parsed.rows[r][c]) || null; };
    s.value = function (r, c) { var x = s.cell(r, c); return x ? x.v : null; };
    return s;
  }

  // bytes: Uint8Array（Node の Buffer 可）。戻り値は Promise<workbook>
  function readWorkbook(bytes, options) {
    options = options || {};
    var inflateRaw = options.inflateRaw || defaultInflateRaw;
    var entries;
    try { entries = listZip(bytes); } catch (e) { return Promise.reject(e); }
    var total = 0;
    Object.keys(entries).forEach(function (k) { total += entries[k].usize; });
    if (total > LIMITS.maxTotalBytes) return Promise.reject(new Error('展開後の合計サイズが大きすぎます'));
    var get = function (name) {
      var e = entries[name];
      if (!e) return Promise.resolve(null);
      return readEntry(bytes, e, inflateRaw).then(decodeUtf8);
    };
    if (!entries['xl/workbook.xml']) return Promise.reject(new Error('Excel ブック（xl/workbook.xml）が見つかりません'));
    return Promise.all([get('xl/workbook.xml'), get('xl/_rels/workbook.xml.rels'), get('xl/sharedStrings.xml')]).then(function (r) {
      var wbXml = r[0], relsXml = r[1] || '', sstXml = r[2] || '';
      var date1904 = /<workbookPr\b[^>]*date1904="(1|true)"/.test(wbXml);
      var rels = {}, m, re = /<Relationship\b([^>]*)\/?>/g;
      while ((m = re.exec(relsXml))) { var a = attrs(m[1]); rels[a.Id] = a.Target; }
      var sst = [], sm, sre = /<si>([\s\S]*?)<\/si>/g;
      while ((sm = sre.exec(sstXml))) sst.push(textOf(sm[1]));
      var sheets = [], shre = /<sheet\b([^>]*)\/?>/g;
      while ((m = shre.exec(wbXml))) {
        var sa = attrs(m[1]);
        var target = rels[sa['r:id']];
        if (!target) continue;
        var path = target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
        sheets.push({ name: sa.name, path: path, hidden: sa.state === 'hidden' || sa.state === 'veryHidden' });
      }
      var wanted = options.sheets ? sheets.filter(function (s) { return options.sheets(s.name); }) : sheets;
      return Promise.all(wanted.map(function (s) { return get(s.path); })).then(function (xmls) {
        var map = {};
        wanted.forEach(function (s, i) { if (xmls[i] !== null) map[s.name] = makeSheet(s.name, parseSheet(xmls[i], sst)); });
        return {
          sheetNames: sheets.map(function (s) { return s.name; }),
          hiddenSheets: sheets.filter(function (s) { return s.hidden; }).map(function (s) { return s.name; }),
          date1904: date1904,
          sheet: function (name) { return map[name] || null; },
          sheets: map
        };
      });
    });
  }

  // Excel のシリアル値 → UTC 通算日（1970-01-01 = 0）
  function serialToDay(serial, date1904) {
    if (typeof serial !== 'number' || !isFinite(serial)) return null;
    var whole = Math.floor(serial);
    return date1904 ? whole + 1462 - 25569 : whole - 25569;
  }

  return { readWorkbook: readWorkbook, serialToDay: serialToDay, colToNum: colToNum, numToCol: numToCol, parseRef: parseRef, LIMITS: LIMITS };
});
