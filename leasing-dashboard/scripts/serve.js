#!/usr/bin/env node
/*
 * ローカル専用の静的ファイルサーバー（外部依存なし）
 *
 *   node scripts/serve.js [--port 8080] [--host 127.0.0.1] [--data ./data]
 *
 * - 既定で 127.0.0.1 のみで待ち受け、社内ネットワークや外部へは公開しない
 * - 配信するのはダッシュボード本体の 5 ファイルと、--data で指定したフォルダの 3 データファイルのみ
 * - データファイルは読み取りのみ（書き換えない）
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var APP_FILES = {
  '/': 'index.html', '/index.html': 'index.html', '/styles.css': 'styles.css',
  '/app.js': 'app.js', '/core.js': 'core.js', '/config.js': 'config.js', '/xlsx.js': 'xlsx.js', '/ingest.js': 'ingest.js',
  '/selftest.html': 'selftest.html', '/tests/browser/selftest.js': 'tests/browser/selftest.js', '/tests/browser/selftest_fixtures.js': 'tests/browser/selftest_fixtures.js'
};
var DATA_FILES = ['dashboard_data.json', 'property_master.csv', 'validation_report.csv', 'source_mapping.csv'];
var TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8'
};
var CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function parseArgs(argv) {
  var o = { port: 8080, host: '127.0.0.1', data: path.join(ROOT, 'data') };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--host') o.host = argv[++i];
    else if (a === '--data') o.data = path.resolve(process.cwd(), argv[++i]);
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function createServer(opts) {
  var dataDir = path.resolve(opts.data);
  return http.createServer(function (req, res) {
    var send = function (code, body, type, extra) {
      var headers = Object.assign({
        'Content-Type': type || 'text/plain; charset=utf-8',
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store'
      }, extra || {});
      res.writeHead(code, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'Method Not Allowed', null, { Allow: 'GET, HEAD' });
    var pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (e) { return send(400, 'Bad Request'); }
    var file = null;
    if (Object.prototype.hasOwnProperty.call(APP_FILES, pathname)) file = path.join(ROOT, APP_FILES[pathname]);
    else {
      var m = pathname.match(/^\/data\/([^/\\]+)$/);
      if (m && DATA_FILES.indexOf(m[1]) !== -1) file = path.join(dataDir, m[1]);
    }
    if (!file) return send(404, 'Not Found');
    fs.readFile(file, function (err, buf) {
      if (err) return send(404, 'Not Found');
      send(200, buf, TYPES[path.extname(file)] || 'application/octet-stream');
    });
  });
}

if (require.main === module) {
  var opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('使い方: node scripts/serve.js [--port 8080] [--host 127.0.0.1] [--data ./data]');
    process.exit(0);
  }
  var server = createServer(opts);
  server.listen(opts.port, opts.host, function () {
    var addr = server.address();
    console.log('週次リーシングダッシュボード: http://' + (opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host) + ':' + addr.port + '/');
    console.log('データフォルダ: ' + path.resolve(opts.data));
    DATA_FILES.forEach(function (f) {
      console.log('  ' + (fs.existsSync(path.join(opts.data, f)) ? '[あり]' : '[なし]') + ' ' + f);
    });
    console.log('停止するには Ctrl+C を押してください。');
  });
}

module.exports = { createServer: createServer, parseArgs: parseArgs };
