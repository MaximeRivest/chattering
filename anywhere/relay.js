#!/usr/bin/env node
'use strict';
/* Chattering Anywhere relay (design/85): the meeting point between a phone
   and its home computer. Runs on a small rented server; see README.md in
   this folder to deploy it.

   What it does:
   - serves the phone's page (public/: a few small files, the same for
     everyone, cacheable, readable in this repository);
   - introduces a phone to a home: homes keep a WebSocket open here, a phone
     asks for one by its id, and the two exchange WebRTC offers, answers and
     network candidates through it;
   - hands both short-lived TURN credentials, so when no direct path exists
     the relay's TURN server (coturn, beside this) carries the encrypted
     packets.

   What it cannot do: read anything. The tunnel between phone and home is
   end-to-end encrypted by WebRTC (DTLS), and both ends prove who they are
   with keys that never pass through here (design/85, "the handshake").

   What it keeps: no logs, no database of anyone. Homes and calls live in
   memory while their sockets are open; addresses only in the in-memory
   rate limiter, for a minute. The one thing written down is usage totals
   per day and month (usage.js): counts, with no ids, addresses or times.

   Environment:
     PORT                 listen port (8790); behind a TLS proxy (Caddy)
     HOST                 listen address (127.0.0.1)
     TURN_SECRET          coturn's static-auth-secret; empty = no TURN
     TURN_SECRET_FILE     the same, read from a file (preferred)
     TURN_URLS            comma list, e.g. turn:relay.example:3478,turns:relay.example:5349?transport=tcp
     STUN_URLS            comma list; default: stun: on the TURN host(s)
     TURN_TTL             seconds a TURN credential lasts (86400)
     TRUST_PROXY          1 when behind a proxy on this machine: the client
                          address (for rate limits only) is X-Forwarded-For
     USAGE_FILE           where the usage totals are kept (usage.js); empty =
                          memory only. GET /_usage on the relay's own port,
                          from this machine, reads them. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { acceptWebSocket, refuseUpgrade } = require('../wsserver.js');
const P = require('./protocol.js');
const { createUsage } = require('./usage.js');

const LIMITS = {
  message: 16 * 1024,        // one signalling message
  perAddress: 24,            // open sockets from one address
  ratePerSecond: 40,         // messages per socket per second (burst 80)
  homes: 100000,
  callsPerHome: 64,
  waitingPerHome: 16,
  idleMs: 90 * 1000,         // a socket that stops answering pings
  unregisteredMs: 20 * 1000, // a socket that never says what it is
};

function createRelay(opts = {}) {
  const env = opts.env || process.env;
  // The secret from a file (systemd's credentials: never in the environment
  // of the process, where anything running as it could read it), or as is.
  let turnSecret = String(env.TURN_SECRET || '');
  if (env.TURN_SECRET_FILE) turnSecret = fs.readFileSync(env.TURN_SECRET_FILE, 'utf8').trim();
  const turnUrls = String(env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  const stunUrls = String(env.STUN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  const turnTtl = Number(env.TURN_TTL || 86400);
  const trustProxy = env.TRUST_PROXY === '1';
  const publicDir = opts.publicDir || path.join(__dirname, 'public');
  const homes = new Map();     // homeId → { conn, calls: Map<sid, conn>, waiting: Set<conn> }
  // Totals only, per day and month (usage.js): how much, never who.
  const usage = opts.usage || createUsage({ file: String(env.USAGE_FILE || ''), now: opts.now });
  const perAddress = new Map(); // address → open sockets (memory only)

  // TURN credentials the coturn "use-auth-secret" way: the name is when it
  // stops working, the password an HMAC of the name. coturn checks both
  // without asking this process anything.
  function iceServers() {
    const out = [];
    const stun = stunUrls.length ? stunUrls : turnUrls.filter(u => /^turn:/.test(u)).map(u => u.replace(/^turn:/, 'stun:').replace(/\?.*$/, ''));
    if (stun.length) out.push({ urls: [...new Set(stun)] });
    if (turnSecret && turnUrls.length) {
      const username = (Math.floor(Date.now() / 1000) + turnTtl) + ':' + crypto.randomBytes(6).toString('base64url');
      const credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
      out.push({ urls: turnUrls, username, credential });
    }
    return out;
  }

  /* ---- the phone's page ---- */
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const files = new Map();
  function asset(name) {
    if (!/^\/_anywhere\/[a-z0-9-]+\.[a-z]+$/.test(name)) return null;
    if (files.has(name) && !opts.noCache) return files.get(name);
    const full = name === '/_anywhere/protocol.js' ? path.join(__dirname, 'protocol.js')
      : name === '/_anywhere/client.js' ? path.join(__dirname, 'client.js')
      : path.join(publicDir, name.slice('/_anywhere/'.length));
    let body;
    try { body = fs.readFileSync(full); } catch { files.set(name, null); return null; }
    const type = TYPES[path.extname(full)] || 'application/octet-stream';
    const etag = '"' + crypto.createHash('sha256').update(body).digest('base64url').slice(0, 22) + '"';
    const gz = /^(text|application\/(json|manifest)|image\/svg)/.test(type) ? zlib.gzipSync(body, { level: 9 }) : null;
    const f = { body, gz, type, etag };
    files.set(name, f);
    return f;
  }
  // The shell for every page address (the app's routes are the phone's too);
  // everything under /_anywhere/ is a file of the shell.
  const SECURITY = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'interest-cohort=()',
  };
  // The path of a request, whatever it sends: an address like
  // "//%2e%2e%2f.env" (scanners probe with them) is not a valid URL relative
  // to a base, and new URL threw inside the request handler, which ended
  // the process. Read as a path on a fixed origin, it is just a path.
  function pathOf(raw) {
    const s = String(raw || '/');
    try { return new URL('http://relay' + (s.startsWith('/') ? s : '/' + s)); } catch { return null; }
  }
  function serve(req, res) {
    try { serveInner(req, res); }
    catch { try { if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad request\n'); } catch {} }
  }
  function serveInner(req, res) {
    const u = pathOf(req.url);
    if (!u) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('bad request\n'); }
    // The usage totals, for whoever runs this relay, on this machine only:
    // straight to the relay's port, not through the https front (which marks
    // every request it forwards).
    if (u.pathname === '/_usage') {
      const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      if ((ip === '127.0.0.1' || ip === '::1') && !req.headers['x-forwarded-for']) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(usage.snapshot(), null, 1) + '\n');
      }
      res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY }); return res.end('not found\n');
    }
    if (u.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('ok\n'); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    let name = u.pathname;
    // The service worker lives at the root so it may answer for every address.
    if (name === '/sw.js') name = '/_anywhere/sw.js';
    // Android's check that the Chattering app (signed with Rockfrog's release
    // key) may open this site's links: the pairing code then opens the app.
    else if (name === '/.well-known/assetlinks.json') name = '/_anywhere/assetlinks.json';
    else if (!name.startsWith('/_anywhere/')) {
      // A page inside the shell asked before the service worker took over:
      // never the shell inside itself.
      if (req.headers['sec-fetch-dest'] === 'iframe') { res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY }); return res.end('<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:2em">One moment…</body>'); }
      name = '/_anywhere/shell.html';
    }
    const f = asset(name);
    if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY }); return res.end('not found\n'); }
    const headers = { 'Content-Type': f.type, ETag: f.etag, 'Cache-Control': name === '/_anywhere/sw.js' || name === '/_anywhere/shell.html' ? 'no-cache' : 'public, max-age=300', Vary: 'Accept-Encoding', ...SECURITY };
    if (name === '/_anywhere/sw.js') headers['Service-Worker-Allowed'] = '/';
    if (name === '/_anywhere/shell.html') headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
    if (req.headers['if-none-match'] === f.etag) { res.writeHead(304, headers); return res.end(); }
    const gzip = f.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    if (gzip) headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : gzip ? f.gz : f.body);
  }

  /* ---- signalling ---- */
  function addressOf(req) {
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (trustProxy && (ip === '127.0.0.1' || ip === '::1')) return String(req.headers['x-forwarded-for'] || ip).split(',')[0].trim();
    return ip;
  }
  const cleanSignal = d => {
    if (!d || typeof d !== 'object') return null;
    if (d.sdp && typeof d.sdp === 'object' && ['offer', 'answer'].includes(d.sdp.type) && typeof d.sdp.sdp === 'string') return { sdp: { type: d.sdp.type, sdp: d.sdp.sdp } };
    if (d.candidate && typeof d.candidate === 'object' && typeof d.candidate.candidate === 'string')
      return { candidate: { candidate: d.candidate.candidate, sdpMid: d.candidate.sdpMid == null ? null : String(d.candidate.sdpMid), sdpMLineIndex: Number.isInteger(d.candidate.sdpMLineIndex) ? d.candidate.sdpMLineIndex : null } };
    return null;
  };

  function onUpgrade(req, socket, head) {
    try { onUpgradeInner(req, socket, head); } catch { try { socket.destroy(); } catch {} }
  }
  function onUpgradeInner(req, socket, head) {
    const u = pathOf(req.url);
    if (!u || u.pathname !== '/signal') return refuseUpgrade(socket, 404, 'Not Found');
    const addr = addressOf(req);
    if ((perAddress.get(addr) || 0) >= LIMITS.perAddress) return refuseUpgrade(socket, 429, 'Too Many Requests');
    const conn = acceptWebSocket(req, socket, head, { maxPayload: LIMITS.message });
    if (!conn) return;
    perAddress.set(addr, (perAddress.get(addr) || 0) + 1);
    conn.role = null; conn.alive = Date.now();
    let tokens = LIMITS.ratePerSecond * 2, last = Date.now();
    const send = m => { try { conn.send(JSON.stringify(m)); } catch {} };
    const unregistered = setTimeout(() => { if (!conn.role || conn.role === 'pending') conn.close(1008, 'say who you are'); }, LIMITS.unregisteredMs);
    conn.on('pong', () => { conn.alive = Date.now(); });
    conn.on('message', async (raw, binary) => {
      conn.alive = Date.now();
      const now = Date.now();
      tokens = Math.min(LIMITS.ratePerSecond * 2, tokens + (now - last) / 1000 * LIMITS.ratePerSecond); last = now;
      if (--tokens < 0) return conn.close(1008, 'too fast');
      if (binary) return;
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== 'object') return;

      // A home: proves it holds the key its id is the hash of.
      // A home checks that its connection is alive (anywhere-home.js).
      if (m.t === 'ping') return send({ t: 'pong' });
      if (m.t === 'home' && !conn.role) {
        const id = String(m.id || '');
        let spki;
        try { spki = P.unb64u(String(m.key || '')); } catch { return conn.close(1008, 'bad key'); }
        if (!/^[A-Za-z0-9_-]{22}$/.test(id) || (await P.homeIdOf(spki)) !== id) return conn.close(1008, 'the id is not the key');
        conn.role = 'pending'; conn.homeId = id; conn.nonce = crypto.randomBytes(18).toString('base64url');
        try { conn.key = await P.importPublic(spki); } catch { return conn.close(1008, 'bad key'); }
        return send({ t: 'challenge', nonce: conn.nonce });
      }
      if (m.t === 'proof' && conn.role === 'pending') {
        let sig;
        try { sig = P.unb64u(String(m.sig || '')); } catch { return conn.close(1008, 'proof failed'); }
        const ok = await P.verify(conn.key, sig, P.toBytes('chattering-anywhere-relay/' + P.VERSION + '\n' + conn.nonce));
        if (!ok) return conn.close(1008, 'proof failed');
        if (!homes.has(conn.homeId) && homes.size >= LIMITS.homes) return conn.close(1013, 'full');
        const prev = homes.get(conn.homeId);
        const entry = { conn, calls: prev ? prev.calls : new Map(), waiting: prev ? prev.waiting : new Set() };
        if (prev && prev.conn !== conn && prev.conn.close) { prev.conn.replaced = true; if (prev.conn.role === 'home') usage.homeOffline(); prev.conn.close(1000, 'replaced by a newer connection'); }
        homes.set(conn.homeId, entry);
        conn.role = 'home';
        usage.homeOnline(conn.homeId);
        send({ t: 'welcome', servers: iceServers() });
        // Phones that were waiting for this home call again now.
        for (const w of entry.waiting) { try { w.send(JSON.stringify({ t: 'online' })); } catch {} }
        entry.waiting.clear();
        return;
      }
      if (conn.role === 'home' && m.t === 'signal') {
        const entry = homes.get(conn.homeId);
        const phone = entry && entry.calls.get(String(m.to || ''));
        const data = cleanSignal(m.data);
        if (phone && data) { try { phone.send(JSON.stringify({ t: 'signal', data })); } catch {} }
        return;
      }

      // A phone: asks for a home by id.
      if (m.t === 'call' && (!conn.role || conn.role === 'phone')) {
        const id = String(m.to || '');
        if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return conn.close(1008, 'bad id');
        if (conn.role === 'phone' && conn.homeId !== id) return conn.close(1008, 'one home per call');
        conn.role = 'phone'; conn.homeId = id;
        clearTimeout(unregistered);
        const entry = homes.get(id);
        if (!entry || entry.conn.role !== 'home') {
          let w = entry;
          if (!w) { w = { conn: { role: 'none' }, calls: new Map(), waiting: new Set() }; homes.set(id, w); }
          if (w.waiting.size >= LIMITS.waitingPerHome) return conn.close(1013, 'too many waiting');
          w.waiting.add(conn);
          if (!conn.waited) { conn.waited = true; usage.wait(); }
          return send({ t: 'offline' });
        }
        if (!conn.sid) {
          if (entry.calls.size >= LIMITS.callsPerHome) return conn.close(1013, 'too many calls');
          conn.sid = crypto.randomBytes(9).toString('base64url');
          entry.calls.set(conn.sid, conn);
          usage.call();
        }
        return send({ t: 'ice', servers: iceServers() });
      }
      if (conn.role === 'phone' && m.t === 'signal' && conn.sid) {
        const entry = homes.get(conn.homeId);
        const data = cleanSignal(m.data);
        // A phone's offer brings fresh TURN credentials for the home: a home
        // stays registered for weeks, far longer than one credential lasts.
        const extra = data && data.sdp && data.sdp.type === 'offer' ? { servers: iceServers() } : {};
        if (entry && entry.conn.role === 'home' && data) { try { entry.conn.send(JSON.stringify({ t: 'signal', from: conn.sid, data, ...extra })); } catch {} }
      }
    });
    conn.on('close', () => {
      clearTimeout(unregistered);
      const n = (perAddress.get(addr) || 1) - 1;
      if (n <= 0) perAddress.delete(addr); else perAddress.set(addr, n);
      const entry = conn.homeId && homes.get(conn.homeId);
      if (!entry) return;
      if (conn.role === 'home' && entry.conn === conn) {
        usage.homeOffline();
        for (const phone of entry.calls.values()) { try { phone.send(JSON.stringify({ t: 'gone' })); } catch {} }
        entry.calls.clear();
        entry.conn = { role: 'none' };
      }
      if (conn.role === 'phone') {
        entry.waiting.delete(conn);
        if (conn.sid && entry.calls.get(conn.sid) === conn) {
          entry.calls.delete(conn.sid);
          if (entry.conn.role === 'home') { try { entry.conn.send(JSON.stringify({ t: 'gone', from: conn.sid })); } catch {} }
        }
      }
      if (entry.conn.role !== 'home' && !entry.calls.size && !entry.waiting.size) homes.delete(conn.homeId);
    });
    conn.on('error', () => {});
  }

  // Keep NAT mappings open and notice the dead: a ping every 25 seconds.
  const sweeper = setInterval(() => {
    for (const entry of homes.values()) {
      const conns = [entry.conn, ...entry.calls.values(), ...entry.waiting];
      for (const c of conns) {
        if (!c || !c.ping) continue;
        if (Date.now() - c.alive > LIMITS.idleMs) { try { c.socket.destroy(); } catch {} continue; }
        c.ping();
      }
    }
  }, 25000);
  sweeper.unref();

  // The totals reach the disk every five minutes and when the relay stops.
  const saver = setInterval(() => usage.save(), 5 * 60 * 1000);
  saver.unref();
  const server = http.createServer(serve);
  server.on('upgrade', onUpgrade);
  server.on('clientError', (e, socket) => { try { socket.destroy(); } catch {} });
  return { server, homes, iceServers, usage, close: () => { clearInterval(sweeper); clearInterval(saver); usage.save(); server.close(); } };
}

if (require.main === module) {
  const relay = createRelay();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { relay.usage.save(); process.exit(0); });
  const port = Number(process.env.PORT || 8790), host = process.env.HOST || '127.0.0.1';
  relay.server.listen(port, host, () => {
    // The one line this program ever prints: that it started.
    process.stdout.write(`chattering anywhere relay on ${host}:${port}${process.env.TURN_SECRET || process.env.TURN_SECRET_FILE ? ' (TURN credentials on)' : ' (no TURN: phones without a direct path cannot connect)'}\n`);
  });
}

module.exports = { createRelay, LIMITS };
