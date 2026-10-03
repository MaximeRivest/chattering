'use strict';
/* This computer's public address (design/92): https://<name>.<domain>, for
   shared links that open from anywhere. The home's end of anywhere/site.js.

   - One WebSocket to the relay (/site), proved with this computer's key
     (the same as the phone link's), claims the name.
   - The certificate for <name>.<domain> comes from Let's Encrypt (acme.js);
     its key is made here and never leaves. Renewed 30 days before it ends.
   - A visitor's connection arrives as a tunnel (one WebSocket per visitor
     connection) carrying their TLS bytes; TLS ends here, in this process,
     and the requests go to the handler given (the shared-links gate only:
     nothing else of Chattering answers on this address).
   - Once a day, the public certificate logs are read for this name: a
     certificate this computer did not ask for is reported, so the relay's
     operator could not get one silently.

   File (0600): <dataDir>/site.json — the name, the ACME account key, the
   certificate and its key, the serials of certificates asked for here. */
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const http = require('http');
const crypto = require('crypto');
const { Duplex } = require('stream');
const acmeLib = require('./acme.js');
const P = require('./anywhere/protocol.js');

const CONTEXT = 'chattering-site-relay/1\n';
const RENEW_MS = 30 * 24 * 3600e3;
const MAX_TUNNELS = 256;
const HIGH = 1024 * 1024, LOW = 256 * 1024;

// A WebSocket (the platform's) as a byte stream, with backpressure on send.
function wsDuplex(ws) {
  let waiter = null;
  const d = new Duplex({
    read() {},
    write(chunk, enc, cb) {
      if (ws.readyState !== 1) return cb(new Error('tunnel closed'));
      // TLS hands over what it encrypted in one piece (a whole response);
      // the relay takes messages of 1 MB at most.
      for (let i = 0; i < chunk.length; i += 64 * 1024) ws.send(chunk.subarray(i, i + 64 * 1024));
      if (ws.bufferedAmount < HIGH) return cb();
      waiter = setInterval(() => {
        if (ws.readyState !== 1) { clearInterval(waiter); waiter = null; cb(new Error('tunnel closed')); }
        else if (ws.bufferedAmount < LOW) { clearInterval(waiter); waiter = null; cb(); }
      }, 15);
    },
    final(cb) { try { ws.close(); } catch {} cb(); },
    destroy(err, cb) { if (waiter) clearInterval(waiter); try { ws.close(); } catch {} cb(err); },
  });
  ws.binaryType = 'arraybuffer';
  ws.onmessage = e => { if (typeof e.data !== 'string') d.push(Buffer.from(e.data)); };
  ws.onclose = () => { d.push(null); setTimeout(() => d.destroy(), 0); };
  ws.onerror = () => {};
  return d;
}

function createSiteHome(opts) {
  const {
    dataDir,
    relayUrl,                       // () => https://relay…
    wanted = () => false,           // () => the owner turned it on
    desiredName = () => '',         // () => the name they chose
    homeKey,                        // async () => { homeId, spki, sign(bytes) }
    handler,                        // (req, res) for visitors
    upgrade = (req, socket) => socket.destroy(),
    acmeDirectory = acmeLib.LETS_ENCRYPT,
    acmeCa,                         // tests: the test authority's TLS root
    ctCheck = true,
    WebSocketImpl = globalThis.WebSocket,
    fetchImpl = globalThis.fetch,
    onChange = () => {},
    log = () => {},
    heartbeatMs = 30000,
  } = opts;
  const file = path.join(dataDir, 'site.json');
  let state = load();
  let ws = null, phase = 'off', error = '', domain = '', invited = null, retry = 0, retryTimer = null, beat = null, lastHeard = 0;
  let certifying = null, secureContext = null, ctWarning = state.ctWarning || null, homeId = null;
  const tunnels = new Set();
  const server = http.createServer(handler);
  server.on('upgrade', upgrade);
  server.on('clientError', (e, socket) => { try { socket.destroy(); } catch {} });
  server.headersTimeout = 20000; server.requestTimeout = 60000; server.keepAliveTimeout = 30000;

  function load() {
    try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
  }
  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  const set = (p, why = '') => { if (phase !== p || error !== why) { phase = p; error = why; try { onChange(); } catch {} } };
  const host = () => state.name && domain ? state.name + '.' + domain : '';
  const certFor = h => state.cert && state.cert.host === h ? state.cert : null;
  function loadContext() {
    const c = certFor(host());
    secureContext = c ? tls.createSecureContext({ key: c.key, cert: c.cert }) : null;
  }

  /* ---- the relay ---- */
  function sync() {
    if (wanted() && desiredName()) { if (!ws && !retryTimer) connect(); else if (ws && phase !== 'connecting' && state.name !== desiredName()) claim(); }
    else disconnect();
  }
  function disconnect() {
    clearTimeout(retryTimer); retryTimer = null;
    clearInterval(beat); beat = null;
    if (ws) { const w = ws; ws = null; try { w.close(); } catch {} }
    for (const t of tunnels) { try { t.destroy(); } catch {} }
    set('off');
  }
  const send = m => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); } catch {} };
  async function connect() {
    let k;
    try { k = await homeKey(); } catch (e) { return failed('this computer has no key yet: ' + e.message); }
    homeId = k.homeId;
    if (ws || !wanted()) return;
    const url = String(relayUrl()).replace(/\/+$/, '').replace(/^http/, 'ws') + '/site';
    set('connecting');
    let sock;
    try { sock = new WebSocketImpl(url); } catch (e) { return failed(e.message); }
    ws = sock;
    lastHeard = Date.now();
    clearInterval(beat);
    beat = setInterval(() => {
      if (ws !== sock) return;
      if (Date.now() - lastHeard > heartbeatMs * 2.5) { ws = null; try { sock.close(); } catch {} return failed('the relay stopped answering'); }
      send({ t: 'ping' });
    }, heartbeatMs);
    if (beat.unref) beat.unref();
    sock.onopen = () => send({ t: 'home', id: k.homeId, key: P.b64u(k.spki) });
    sock.onerror = () => {};
    sock.onclose = () => { if (ws !== sock) return; ws = null; failed(phase === 'ready' ? 'the relay closed the connection' : error || 'could not reach the relay'); };
    sock.onmessage = async ev => {
      if (ws !== sock) return;
      lastHeard = Date.now();
      let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (m.t === 'pong') return;
      if (m.t === 'challenge') return send({ t: 'proof', sig: P.b64u(await k.sign(P.toBytes(CONTEXT + m.nonce))) });
      if (m.t === 'welcome') {
        retry = 0; domain = String(m.domain || ''); invited = !!m.invited;
        if (m.name && m.name === desiredName()) { state.name = m.name; save(); return ready(); }
        return claim();
      }
      if (m.t === 'claimed') { state.name = m.name; save(); return ready(); }
      if (m.t === 'refused') return set('refused', String(m.message || 'the relay refused the name'));
      if (m.t === 'open') return openTunnel(String(m.cid || ''), String(m.ip || ''));
    };
  }
  function claim() { set('claiming'); send({ t: 'claim', name: desiredName() }); }
  function failed(why) {
    clearInterval(beat); beat = null;
    set('error', why);
    if (!wanted()) return disconnect();
    const delay = Math.min(60000, 1000 * 2 ** Math.min(retry++, 6)) * (0.7 + Math.random() * 0.6);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; if (wanted()) connect(); }, delay);
    if (retryTimer.unref) retryTimer.unref();
  }

  /* ---- the certificate ---- */
  async function ready() {
    loadContext();
    const c = certFor(host());
    if (c && c.notAfter - Date.now() > RENEW_MS) { set('ready'); return; }
    if (c) set('ready'); // still valid: serve with it while a new one comes
    await renew();
  }
  async function renew() {
    if (certifying) return certifying;
    const h = host();
    certifying = (async () => {
      if (!certFor(h) || certFor(h).notAfter < Date.now()) set('certifying');
      try {
        if (!state.accountKey) { state.accountKey = acmeLib.newAccountKey(); save(); }
        const client = acmeLib.createClient({ directory: acmeDirectory, accountKey: state.accountKey, ca: acmeCa, log });
        const got = await client.certify([h], { publish: async (token, keyAuth) => { send({ t: 'acme', token, keyAuth }); await new Promise(r => setTimeout(r, 300)); } });
        const serial = new crypto.X509Certificate(got.cert).serialNumber;
        state.cert = { host: h, key: got.key, cert: got.cert, notAfter: got.notAfter, notBefore: got.notBefore, serial };
        state.serials = [...new Set([...(state.serials || []), serial])].slice(-50);
        state.issuedSince = state.issuedSince || Date.now();
        save();
        loadContext();
        if (host() === h && ws) set('ready');
      } catch (e) {
        log('[site] certificate for ' + h + ': ' + e.message);
        if (!certFor(h)) set('error', 'Could not get a certificate for ' + h + ': ' + e.message);
      } finally { certifying = null; }
    })();
    return certifying;
  }
  const renewTimer = setInterval(() => { if (phase === 'ready' && certFor(host()) && certFor(host()).notAfter - Date.now() < RENEW_MS) renew(); }, 12 * 3600e3);
  renewTimer.unref();

  // Certificate Transparency: every certificate for the name, from crt.sh;
  // one issued since we started that we did not ask for is reported.
  async function checkCt() {
    const h = host();
    if (!ctCheck || !h || phase !== 'ready' || !fetchImpl) return;
    try {
      const r = await fetchImpl('https://crt.sh/?q=' + encodeURIComponent(h) + '&output=json&exclude=expired', { signal: AbortSignal.timeout(30000) });
      if (!r.ok) return;
      const rows = await r.json();
      const ours = new Set((state.serials || []).map(s => s.toLowerCase().replace(/^0+/, '')));
      const since = state.issuedSince || Date.now();
      const strange = rows.filter(x => Date.parse(x.not_before + 'Z') >= since - 3600e3 && !ours.has(String(x.serial_number || '').toLowerCase().replace(/^0+/, '')));
      const next = strange.length ? { at: Date.now(), count: strange.length, issuer: strange[0].issuer_name, notBefore: strange[0].not_before, id: strange[0].id } : null;
      if (JSON.stringify(next) !== JSON.stringify(ctWarning)) { ctWarning = next; state.ctWarning = next; save(); try { onChange(); } catch {} }
    } catch {}
  }
  const ctTimer = setInterval(checkCt, 24 * 3600e3);
  ctTimer.unref();
  setTimeout(checkCt, 5 * 60e3).unref();

  /* ---- a visitor ---- */
  function openTunnel(cid, ip) {
    if (!/^[A-Za-z0-9_-]{24}$/.test(cid) || !secureContext || tunnels.size >= MAX_TUNNELS) return;
    const url = String(relayUrl()).replace(/\/+$/, '').replace(/^http/, 'ws') + '/site/tunnel?cid=' + cid;
    let sock;
    try { sock = new WebSocketImpl(url); } catch { return; }
    const duplex = wsDuplex(sock);
    tunnels.add(duplex);
    duplex.on('close', () => tunnels.delete(duplex));
    duplex.on('error', () => {});
    sock.onopen = () => {
      const t = new tls.TLSSocket(duplex, { isServer: true, secureContext, ALPNProtocols: ['http/1.1'] });
      t.visitorIp = ip.slice(0, 64);
      t.on('error', () => { try { duplex.destroy(); } catch {} });
      t.on('close', () => { try { duplex.destroy(); } catch {} });
      server.emit('connection', t);
    };
  }

  function status() {
    const c = certFor(host());
    return { phase, error, name: state.name || '', wantedName: desiredName(), domain, url: host() && phase === 'ready' && c ? 'https://' + host() : '',
      invited, homeId, certificate: c ? { notAfter: c.notAfter, notBefore: c.notBefore } : null, visitors: tunnels.size, ctWarning };
  }
  function stop() { clearInterval(renewTimer); clearInterval(ctTimer); disconnect(); }
  loadContext();
  return { sync, status, stop, renew, checkCt, _server: server };
}

module.exports = { createSiteHome, wsDuplex };
