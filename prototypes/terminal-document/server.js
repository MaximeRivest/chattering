'use strict';
// The prototype page server: one real CLI, read into an interaction
// document (hub.js), streamed to every page that watches it.
//   node server.js [--port 7480] [--cwd DIR] [--profile claude|generic] -- claude [args…]
// Binds to 127.0.0.1. With `auth`, every request needs a credential (the
// encrypted link adds one per paired device; see anywhere.js).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { TerminalHost } = require('./host');
const { CLAUDE, GENERIC } = require('./reader');
const { ClaudeJournal } = require('./journal');
const { createHub, diff, encodeParts } = require('./hub');

function parseArgs(argv) {
  const o = { port: 7480, cwd: process.cwd(), profile: 'claude', command: ['claude'], cols: 100, rows: 34, record: null };
  const sep = argv.indexOf('--');
  const own = sep < 0 ? argv : argv.slice(0, sep);
  if (sep >= 0) o.command = argv.slice(sep + 1);
  for (let i = 0; i < own.length; i += 2) {
    const k = own[i].replace(/^--/, ''), v = own[i + 1];
    if (k === 'port' || k === 'cols' || k === 'rows') o[k] = Number(v); else o[k] = v;
  }
  return o;
}

function start(opts) {
  const profile = opts.profile === 'generic' ? GENERIC : CLAUDE;
  const host = new TerminalHost({ command: opts.command[0], args: opts.command.slice(1), cwd: opts.cwd, cols: opts.cols, rows: opts.rows, record: opts.record });
  const journal = profile === CLAUDE ? new ClaudeJournal(opts.cwd) : null;
  const hub = createHub({ host, profile, journal, events: opts.events || null });
  const authorized = req => !opts.auth || opts.auth(req);
  const server = http.createServer((req, res) => {
    if (!authorized(req)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('Not paired.'); }
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ host: host.stats, server: hub.stats })); }
    const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  const wss = new WebSocketServer({ server, verifyClient: info => authorized(info.req) });
  wss.on('connection', ws => hub.attach(ws));
  return new Promise(resolve => server.listen(opts.port, '127.0.0.1', () => resolve({
    server, host, journal, hub, stats: hub.stats, port: server.address().port, url: 'http://127.0.0.1:' + server.address().port + '/',
    close: () => { hub.close(); host.kill(); if (journal) journal.close(); wss.close(); server.close(); },
  })));
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  start(opts).then(s => {
    console.log('Terminal document prototype: ' + s.url + '  (' + opts.command.join(' ') + ' in ' + opts.cwd + ')');
    s.host.on('exit', () => { console.log('the program exited'); });
    process.on('SIGINT', () => { s.close(); process.exit(0); });
  });
}
module.exports = { start, parseArgs, diff, encodeParts };
