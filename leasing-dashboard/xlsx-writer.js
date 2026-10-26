/*
 * 最小限の XLSX 書き出し（外部依存なし）
 *
 * 表形式のシート（文字列・数値・書式・列幅・見出し固定・オートフィルター・セル結合・データバー）を
 * Excel ブック（.xlsx）のバイト列にする。ZIP は無圧縮（格納）で作る。
 * ブラウザでは window.LeasingXlsxWriter、Node では require('./xlsx-writer') で使う。
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.LeasingXlsxWriter = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // セルの書式（styles.xml の cellXfs の並びと一致させる）
  var STYLE = {
    normal: 0, header: 1, title: 2, note: 3, int: 4, pct: 5, dec1: 6, good: 7, warning: 8, critical: 9, muted: 10, bold: 11, pt: 12, wrap: 13
  };

  var STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="3"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="#,##0.0"/>' +
    '<numFmt numFmtId="166" formatCode="+0.0&quot;pt&quot;;-0.0&quot;pt&quot;;0.0&quot;pt&quot;"/></numFmts>' +
    '<fonts count="6">' +
    '<font><sz val="11"/><color rgb="FF0B0B0B"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FF0B0B0B"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font>' +
    '<font><b/><sz val="14"/><color rgb="FF0B0B0B"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font>' +
    '<font><sz val="10"/><color rgb="FF52514E"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font>' +
    '<font><sz val="11"/><color rgb="FF898781"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFB02A2A"/><name val="游ゴシック"/><family val="3"/><charset val="128"/></font>' +
    '</fonts>' +
    '<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF0EFEC"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE3F4E3"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFDF1D3"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF9E1E1"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left/><right/><top/><bottom style="thin"><color rgb="FFC3C2B7"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="14">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="0" fontId="5" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="標準" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  function esc(s) {
    // XML で使えない制御文字を除き、特殊文字をエスケープする
    return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function colName(n) {
    var s = '';
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  function safeSheetName(name, used) {
    var n = String(name).replace(/[\[\]:*?/\\]/g, '_').slice(0, 31) || 'Sheet';
    var base = n, i = 2;
    while (used[n]) { n = base.slice(0, 28) + '_' + i++; }
    used[n] = true;
    return n;
  }

  // セル: null/undefined は空、数値はそのまま、文字列はインライン文字列。{ v, s } で書式を指定できる
  function cellXml(ref, c) {
    if (c === null || c === undefined) return '';
    var v = c, s = null;
    if (typeof c === 'object' && !(c instanceof Date)) { v = c.v; s = c.s; }
    if (v === null || v === undefined || v === '') return s ? '<c r="' + ref + '" s="' + STYLE[s] + '"/>' : '';
    var sa = s ? ' s="' + STYLE[s] + '"' : '';
    if (typeof v === 'number' && isFinite(v)) return '<c r="' + ref + '"' + sa + '><v>' + v + '</v></c>';
    if (typeof v === 'boolean') return '<c r="' + ref + '"' + sa + ' t="b"><v>' + (v ? 1 : 0) + '</v></c>';
    return '<c r="' + ref + '"' + sa + ' t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
  }

  function sheetXml(sh, index) {
    var rows = sh.rows || [], maxCol = 1;
    rows.forEach(function (r) { if (r && r.length > maxCol) maxCol = r.length; });
    var out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
    out += '<dimension ref="A1:' + colName(maxCol) + Math.max(1, rows.length) + '"/>';
    out += '<sheetViews><sheetView workbookViewId="0"' + (index === 0 ? ' tabSelected="1"' : '') + '>';
    if (sh.freezeRows) out += '<pane ySplit="' + sh.freezeRows + '" topLeftCell="A' + (sh.freezeRows + 1) + '" activePane="bottomLeft" state="frozen"/>';
    out += '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/>';
    if (sh.widths && sh.widths.length) {
      out += '<cols>' + sh.widths.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols>';
    }
    out += '<sheetData>';
    rows.forEach(function (r, ri) {
      if (!r || !r.length) return;
      var cells = r.map(function (c, ci) { return cellXml(colName(ci + 1) + (ri + 1), c); }).join('');
      if (cells) out += '<row r="' + (ri + 1) + '">' + cells + '</row>';
    });
    out += '</sheetData>';
    if (sh.autoFilter) out += '<autoFilter ref="' + sh.autoFilter + '"/>';
    if (sh.merges && sh.merges.length) out += '<mergeCells count="' + sh.merges.length + '">' + sh.merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') + '</mergeCells>';
    (sh.dataBars || []).forEach(function (d, i) {
      out += '<conditionalFormatting sqref="' + d.ref + '"><cfRule type="dataBar" priority="' + (i + 1) + '"><dataBar>' +
        '<cfvo type="' + (d.min === undefined ? 'min' : 'num') + '"' + (d.min === undefined ? '' : ' val="' + d.min + '"') + '/>' +
        '<cfvo type="' + (d.max === undefined ? 'max' : 'num') + '"' + (d.max === undefined ? '' : ' val="' + d.max + '"') + '/>' +
        '<color rgb="' + (d.color || 'FF2A78D6') + '"/></dataBar></cfRule></conditionalFormatting>';
    });
    out += '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/></worksheet>';
    return out;
  }

  // ---------- ZIP（無圧縮） ----------

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    return new Uint8Array(Buffer.from(s, 'utf8'));
  }

  function zip(files, date) {
    var d = date || new Date();
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
    var dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var chunks = [], central = [], offset = 0;
    function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
    function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }
    files.forEach(function (f) {
      var name = utf8(f.name), data = f.data, crc = crc32(data);
      var local = [].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
      chunks.push(new Uint8Array(local), name, data);
      central.push({ name: name, crc: crc, size: data.length, offset: offset });
      offset += local.length + name.length + data.length;
    });
    var cdStart = offset, cdSize = 0;
    central.forEach(function (c) {
      var h = [].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(c.crc), u32(c.size), u32(c.size),
        u16(c.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset));
      chunks.push(new Uint8Array(h), c.name);
      cdSize += h.length + c.name.length;
    });
    chunks.push(new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdSize), u32(cdStart), u16(0))));
    var total = chunks.reduce(function (s, c) { return s + c.length; }, 0), out = new Uint8Array(total), p = 0;
    chunks.forEach(function (c) { out.set(c, p); p += c.length; });
    return out;
  }

  // book: { sheets: [{ name, rows, widths, freezeRows, autoFilter, merges, dataBars }], title }
  function writeWorkbook(book, date) {
    var used = {}, sheets = book.sheets.map(function (s) { return Object.assign({}, s, { name: safeSheetName(s.name, used) }); });
    var files = [];
    var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      sheets.map(function (s, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') +
      '</Types>';
    files.push({ name: '[Content_Types].xml', data: utf8(ct) });
    files.push({ name: '_rels/.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>') });
    var iso = (date || new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
    files.push({ name: 'docProps/core.xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:title>' + esc(book.title || '') + '</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:modified></cp:coreProperties>') });
    var defined = sheets.map(function (s, i) {
      return s.autoFilter ? '<definedName name="_xlnm._FilterDatabase" localSheetId="' + i + '" hidden="1">\'' + s.name.replace(/'/g, "''") + '\'!' +
        s.autoFilter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2') + '</definedName>' : '';
    }).join('');
    files.push({ name: 'xl/workbook.xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
      sheets.map(function (s, i) { return '<sheet name="' + esc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') +
      '</sheets>' + (defined ? '<definedNames>' + defined + '</definedNames>' : '') + '</workbook>') });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') });
    files.push({ name: 'xl/styles.xml', data: utf8(STYLES_XML) });
    sheets.forEach(function (s, i) { files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: utf8(sheetXml(s, i)) }); });
    return zip(files, date);
  }

  return { writeWorkbook: writeWorkbook, colName: colName, crc32: crc32, STYLE: STYLE };
});
