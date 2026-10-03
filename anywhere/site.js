'use strict';
/* Public addresses for shared links (design/92): <name>.<domain> reaches one
   person's own computer, through this relay, which forwards encrypted bytes
   it cannot read.

   How a visitor arrives:
     visitor ──TLS (ends on the home)──▶ :443 (HAProxy: SNI ends in .<domain>)
       ──▶ this module's TCP port (PROXY v2 header, then the raw TLS bytes)
       ──▶ reads only the name in the TLS hello, asks that home to open a
           tunnel (a WebSocket back to /site/tunnel), and pipes the bytes.
   The certificate and its key live on the home (it gets them from Let's
   Encrypt by HTTP-01: the challenge answers pass through here, below). So
   this relay can neither read nor change what is said; like any domain's
   owner, Rockfrog could ask for a certificate of its own for the name, and
   every certificate is written to public logs (Certificate Transparency),
   which the homes watch.

   What it keeps: names → home ids (one small file), so a name stays its
   owner's. Which homes may take a name is a list kept by whoever runs the
   relay (invitation only, until there is a way to handle abuse). Nothing
   about visitors: their address is used for limits, in memory, and passed
   to the home, which needs it for its own limits.

   Wire, home ⇄ relay (JSON text on /site):
     home → {t:'home', id, key}        relay → {t:'challenge', nonce}
     home → {t:'proof', sig}           relay → {t:'welcome', domain, name?}
     home → {t:'claim', name}          relay → {t:'claimed', name} | {t:'refused', why, message}
     home → {t:'acme', token, keyAuth} (the answer to one HTTP-01 check)
     relay → {t:'open', cid, ip}       home opens /site/tunnel?cid=…
     ping/pong both ways. */
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const P = require('./protocol.js');

const CONTEXT = 'chattering-site-relay/1\n';
const LIMITS = {
  message: 16 * 1024,
  tunnelFrame: 1024 * 1024,
  tunnelsPerHome: 512,
  pendingPerHome: 64,
  perVisitor: 64,              // open connections from one address
  openWaitMs: 10000,           // a home has this long to open its tunnel
  helloMax: 16 * 1024 + 5,     // a TLS hello this large at most
  helloWaitMs: 10000,
  acmePerHome: 20,
  acmeMs: 10 * 60 * 1000,
  idleMs: 90 * 1000,
  highWater: 1024 * 1024,
};
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const RESERVED = new Set(['www', 'api', 'app', 'admin', 'root', 'mail', 'smtp', 'imap', 'pop', 'ftp', 'ns', 'ns1', 'ns2', 'dns', 'relay', 'site', 'sites',
  'rockfrog', 'chattering', 'support', 'help', 'status', 'security', 'abuse', 'postmaster', 'hostmaster', 'webmaster', 'login', 'signin', 'account',
  'accounts', 'billing', 'pay', 'docs', 'blog', 'static', 'cdn', 'assets', 'test', 'dev', 'staging', 'acme', 'autoconfig', 'autodiscover', 'wpad', 'localhost']);

function validName(name) { return NAME_RE.test(name) && !RESERVED.has(name) && !name.startsWith('xn--') && !name.includes('--'); }

/* ---- reading what arrives on the TCP port ---- */
const PROXY_SIG = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
// PROXY protocol v2 (HAProxy's): the visitor's address. null: need more
// bytes; false: not a PROXY header.
function readProxyV2(buf) {
  if (buf.length < 16) return null;
  if (!buf.subarray(0, 12).equals(PROXY_SIG)) return false;
  const len = buf.readUInt16BE(14);
  if (buf.length < 16 + len) return null;
  const fam = buf[13] >> 4, body = buf.subarray(16, 16 + len);
  let ip = '';
  if (fam === 1 && len >= 12) ip = [...body.subarray(0, 4)].join('.');
  else if (fam === 2 && len >= 36) ip = [...Array(8)].map((_, i) => body.readUInt16BE(i * 2).toString(16)).join(':').replace(/(^|:)0(:0)+(:|$)/, '::');
  return { ip: ip.replace(/^::ffff:/, ''), size: 16 + len };
}
// The name a TLS ClientHello asks for (server_name). null: need more bytes;
// false: not a hello, or no name.
function readSni(buf) {
  // Handshake bytes, joined across records.
  let off = 0, hs = Buffer.alloc(0);
  while (true) {
    if (buf.length < off + 5) return null;
    if (buf[off] !== 0x16) return false;
    const len = buf.readUInt16BE(off + 3);
    if (buf.length < off + 5 + len) return null;
    hs = Buffer.concat([hs, buf.subarray(off + 5, off + 5 + len)]);
    off += 5 + len;
    if (hs.length >= 4) {
      if (hs[0] !== 0x01) return false;
      const need = 4 + hs.readUIntBE(1, 3);
      if (hs.length >= need) { hs = hs.subarray(0, need); break; }
    }
    if (off > LIMITS.helloMax) return false;
  }
  try {
    let p = 4 + 2 + 32;
    p += 1 + hs[p];                         // session id
    p += 2 + hs.readUInt16BE(p);            // cipher suites
    p += 1 + hs[p];                         // compression methods
    const end = p + 2 + hs.readUInt16BE(p);
    p += 2;
    while (p + 4 <= end) {
      const type = hs.readUInt16BE(p), len = hs.readUInt16BE(p + 2);
      p += 4;
      if (type === 0) {
        let q = p + 2;
        while (q + 3 <= p + len) {
          const nt = hs[q], nl = hs.readUInt16BE(q + 1);
          if (nt === 0) return hs.subarray(q + 3, q + 3 + nl).toString('ascii').toLowerCase();
          q += 3 + nl;
        }
      }
      p += len;
    }
  } catch {}
  return false;
}

function createSite(opts = {}) {
  const env = opts.env || process.env;
  const domain = String(opts.domain || env.SITE_DOMAIN || '').toLowerCase().replace(/^\.+|\.+$/g, '');
  const namesFile = opts.namesFile || String(env.SITE_NAMES_FILE || '');
  const homesFile = opts.homesFile || String(env.SITE_HOMES_FILE || '');
  const now = opts.now || (() => Date.now());
  const enabled = !!domain;
  const names = new Map();     // name → homeId
  const homes = new Map();     // homeId → { conn, tunnels:Set, pending:Map }
  const pending = new Map();   // cid → { homeId, socket, buffered, timer }
  const acme = new Map();      // name → Map(token → { keyAuth, at })
  const perVisitor = new Map();

  function loadNames() {
    if (!namesFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(namesFile, 'utf8'));
      for (const [n, id] of Object.entries(raw && raw.names || {})) if (validName(n) && /^[A-Za-z0-9_-]{22}$/.test(id)) names.set(n, id);
    } catch {}
  }
  function saveNames() {
    if (!namesFile) return;
    const tmp = namesFile + '.tmp';
    fs.mkdirSync(path.dirname(namesFile), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, names: Object.fromEntries(names) }, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, namesFile);
  }
  // Who may take a name: one home id per line, read each time (so adding
  // someone needs no restart). No file: nobody.
  function invited(homeId) {
    if (opts.invited) return opts.invited(homeId);
    if (!homesFile) return false;
    try { return fs.readFileSync(homesFile, 'utf8').split('\n').map(l => l.replace(/#.*/, '').trim()).includes(homeId); } catch { return false; }
  }
  const nameOf = homeId => { for (const [n, id] of names) if (id === homeId) return n; return null; };
  loadNames();

  // Which name a host is for: <name>.<domain>, or <anything>.<name>.<domain>
  // (each artifact its own site, later). The domain itself is not a home.
  function nameOfHost(host) {
    const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    if (!enabled || !h.endsWith('.' + domain)) return null;
    const labels = h.slice(0, -domain.length - 1).split('.');
    return labels[labels.length - 1] || null;
  }

  /* ---- a home's control connection ---- */
  function control(conn, req) {
    conn.alive = now();
    conn.on('pong', () => { conn.alive = now(); });
    const send = m => { try { conn.send(JSON.stringify(m)); } catch {} };
    const unregistered = setTimeout(() => { if (conn.role !== 'home') conn.close(1008, 'say who you are'); }, 20000);
    let tokens = 80, last = now();
    conn.on('message', async (raw, binary) => {
      conn.alive = now();
      const t = now(); tokens = Math.min(80, tokens + (t - last) / 1000 * 40); last = t;
      if (--tokens < 0) return conn.close(1008, 'too fast');
      if (binary) return;
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'ping') return send({ t: 'pong' });
      if (m.t === 'home' && !conn.role) {
        const id = String(m.id || '');
        let spki; try { spki = P.unb64u(String(m.key || '')); } catch { return conn.close(1008, 'bad key'); }
        if (!/^[A-Za-z0-9_-]{22}$/.test(id) || (await P.homeIdOf(spki)) !== id) return conn.close(1008, 'the id is not the key');
        try { conn.key = await P.importPublic(spki); } catch { return conn.close(1008, 'bad key'); }
        conn.role = 'pending'; conn.homeId = id; conn.nonce = crypto.randomBytes(18).toString('base64url');
        return send({ t: 'challenge', nonce: conn.nonce });
      }
      if (m.t === 'proof' && conn.role === 'pending') {
        let sig; try { sig = P.unb64u(String(m.sig || '')); } catch { return conn.close(1008, 'proof failed'); }
        if (!(await P.verify(conn.key, sig, P.toBytes(CONTEXT + conn.nonce)))) return conn.close(1008, 'proof failed');
        clearTimeout(unregistered);
        const prev = homes.get(conn.homeId);
        if (prev && prev.conn !== conn) { try { prev.conn.close(1000, 'replaced by a newer connection'); } catch {} }
        homes.set(conn.homeId, { conn, tunnels: prev ? prev.tunnels : new Set(), pending: new Set() });
        conn.role = 'home';
        return send({ t: 'welcome', domain, name: nameOf(conn.homeId), invited: invited(conn.homeId) });
      }
      if (conn.role !== 'home') return;
      if (m.t === 'claim') {
        const name = String(m.name || '').toLowerCase();
        if (!validName(name)) return send({ t: 'refused', why: 'bad-name', message: 'A name is 3 to 30 letters, digits or dashes, and some names are kept for Rockfrog.' });
        if (!invited(conn.homeId)) return send({ t: 'refused', why: 'not-invited', message: 'Public addresses are by invitation for now. Ask Rockfrog to add this computer (its id: ' + conn.homeId + ').' });
        const owner = names.get(name);
        if (owner && owner !== conn.homeId) return send({ t: 'refused', why: 'taken', message: name + '.' + domain + ' is taken. Choose another name.' });
        const old = nameOf(conn.homeId);
        if (old && old !== name) names.delete(old);
        names.set(name, conn.homeId);
        saveNames();
        return send({ t: 'claimed', name });
      }
      if (m.t === 'release') {
        const old = nameOf(conn.homeId);
        if (old) { names.delete(old); saveNames(); }
        return send({ t: 'released' });
      }
      if (m.t === 'acme') {
        const name = nameOf(conn.homeId);
        const token = String(m.token || ''), keyAuth = String(m.keyAuth || '');
        if (!name || !/^[A-Za-z0-9_-]{16,128}$/.test(token) || !keyAuth.startsWith(token + '.') || keyAuth.length > 300) return;
        const box = acme.get(name) || new Map();
        for (const [k, v] of box) if (now() - v.at > LIMITS.acmeMs) box.delete(k);
        if (box.size >= LIMITS.acmePerHome) box.delete(box.keys().next().value);
        box.set(token, { keyAuth, at: now() });
        acme.set(name, box);
      }
    });
    conn.on('close', () => {
      clearTimeout(unregistered);
      const e = conn.homeId && homes.get(conn.homeId);
      if (e && e.conn === conn) {
        homes.delete(conn.homeId);
        for (const cid of e.pending) dropPending(cid);
        for (const t of e.tunnels) { try { t.close(1001, 'home left'); } catch {} }
      }
    });
    conn.on('error', () => {});
  }

  /* ---- tunnels ---- */
  function dropPending(cid) {
    const p = pending.get(cid);
    if (!p) return;
    pending.delete(cid);
    clearTimeout(p.timer);
    const e = homes.get(p.homeId);
    if (e) e.pending.delete(cid);
    try { p.socket.destroy(); } catch {}
  }
  function tunnel(conn, cid) {
    const p = pending.get(cid);
    if (!p) return conn.close(1008, 'unknown tunnel');
    pending.delete(cid);
    clearTimeout(p.timer);
    const e = homes.get(p.homeId);
    if (!e) { try { p.socket.destroy(); } catch {} return conn.close(1001, 'home left'); }
    e.pending.delete(cid);
    if (e.tunnels.size >= LIMITS.tunnelsPerHome) { try { p.socket.destroy(); } catch {} return conn.close(1013, 'too many'); }
    e.tunnels.add(conn);
    const v = p.socket;
    const end = () => { e.tunnels.delete(conn); try { v.destroy(); } catch {} try { conn.close(1000); } catch {} };
    conn.on('close', end);
    conn.on('error', () => {});
    v.on('close', end);
    v.on('error', () => {});
    // Visitor → home, held back while the home's side is full.
    const toHome = chunk => {
      conn.send(chunk);
      if (conn.socket.writableLength > LIMITS.highWater) v.pause();
    };
    conn.socket.on('drain', () => v.resume());
    if (p.buffered.length) toHome(p.buffered);
    v.on('data', toHome);
    // Home → visitor, the same the other way.
    conn.on('message', (data, binary) => {
      if (!binary) return;
      if (!v.write(data)) conn.socket.pause();
    });
    v.on('drain', () => conn.socket.resume());
    v.resume();
  }

  /* ---- the TCP port behind HAProxy ---- */
  function onVisitor(socket) {
    socket.on('error', () => {});
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0), ip = null, skip = 0;
    const timer = setTimeout(() => socket.destroy(), LIMITS.helloWaitMs);
    const onData = chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (ip === null) {
        const pr = readProxyV2(buf);
        if (pr === null) return;
        if (pr === false) { ip = String(socket.remoteAddress || '').replace(/^::ffff:/, ''); skip = 0; }
        else { ip = pr.ip; skip = pr.size; }
        buf = buf.subarray(skip);
      }
      const sni = readSni(buf);
      if (sni === null) { if (buf.length > LIMITS.helloMax * 2) socket.destroy(); return; }
      socket.off('data', onData);
      socket.pause();
      clearTimeout(timer);
      const name = sni === false ? null : nameOfHost(sni);
      const homeId = name && names.get(name);
      const e = homeId && homes.get(homeId);
      if (!e || e.pending.size >= LIMITS.pendingPerHome) return socket.destroy();
      const open = (perVisitor.get(ip) || 0) + 1;
      if (open > LIMITS.perVisitor) return socket.destroy();
      perVisitor.set(ip, open);
      socket.once('close', () => { const n = (perVisitor.get(ip) || 1) - 1; if (n <= 0) perVisitor.delete(ip); else perVisitor.set(ip, n); });
      const cid = crypto.randomBytes(18).toString('base64url');
      pending.set(cid, { homeId, socket, buffered: buf, timer: setTimeout(() => dropPending(cid), LIMITS.openWaitMs) });
      e.pending.add(cid);
      try { e.conn.send(JSON.stringify({ t: 'open', cid, ip })); } catch { dropPending(cid); }
    };
    socket.on('data', onData);
    socket.on('close', () => clearTimeout(timer));
  }
  const tcp = net.createServer({ pauseOnConnect: false }, onVisitor);
  tcp.on('error', () => {});

  /* ---- plain http for <name>.<domain>: certificate checks, else to https ---- */
  function http(req, res, u) {
    const name = nameOfHost(req.headers.host);
    if (!name) return false;
    const m = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]{16,128})$/.exec(u.pathname);
    if (m) {
      const hit = acme.get(name) && acme.get(name).get(m[1]);
      if (hit && now() - hit.at < LIMITS.acmeMs) { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(hit.keyAuth); return true; }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found\n'); return true;
    }
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    res.writeHead(308, { Location: 'https://' + host + u.pathname + u.search, 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  function upgrade(req, socket, head, u, acceptWebSocket, refuseUpgrade) {
    if (!enabled) return false;
    if (u.pathname === '/site') {
      const conn = acceptWebSocket(req, socket, head, { maxPayload: LIMITS.message });
      if (conn) control(conn, req);
      return true;
    }
    if (u.pathname === '/site/tunnel') {
      const cid = String(u.searchParams.get('cid') || '');
      if (!pending.has(cid)) { refuseUpgrade(socket, 404, 'Not Found'); return true; }
      const conn = acceptWebSocket(req, socket, head, { maxPayload: LIMITS.tunnelFrame });
      if (conn) tunnel(conn, cid);
      return true;
    }
    return false;
  }

  const sweeper = setInterval(() => {
    for (const e of homes.values()) {
      const c = e.conn;
      if (now() - c.alive > LIMITS.idleMs) { try { c.socket.destroy(); } catch {} continue; }
      try { c.ping(); } catch {}
    }
  }, 25000);
  sweeper.unref();

  return { enabled, domain, tcp, http, upgrade, names, homes, nameOfHost, close: () => { clearInterval(sweeper); tcp.close(); } };
}

module.exports = { createSite, readSni, readProxyV2, validName, CONTEXT, LIMITS };
