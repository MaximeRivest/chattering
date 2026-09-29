'use strict';
/* Chattering Anywhere, the home's end (design/85).

   This computer keeps one WebSocket open to the relay, only while a phone
   is paired or a pairing code is showing. A phone that calls through the
   relay gets a WebRTC data channel straight to this process (or through
   the relay's TURN server when no direct path exists; the relay then
   carries bytes it cannot read). After the handshake proves both ends, each
   request that arrives on the channel is replayed against this Chattering's
   own HTTP port, as the person who paired the phone, and the answer goes
   back the same way. WebSockets (collaboration, voice) likewise.

   What the phone carries is a credential of that person (users.js, kind
   invite, labelled "phone · anywhere"): the People panel lists it and can
   revoke it, and revoking cuts the phone at its next request. Requests are
   marked forwarded, so they never count as this machine's own console.

   Files (0600): <dataDir>/anywhere.json — this home's key, and per phone
   its public key, its person, its credential. Pairing codes live in memory
   only; a restart ends any that were showing. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const P = require('./anywhere/protocol.js');
const { T } = P;

const DEFAULT_RELAY = 'https://anywhere.rockfrog.ai';
const PAIRING_MS = 10 * 60 * 1000;
const MAX_PEERS = 32;
const AUTH_MS = 20000;

// node-datachannel is a native module: the downloads carry it in runtime/,
// a checkout gets it from `npm ci --prefix runtime`. Missing, the feature
// explains itself instead of taking the server down.
let rtcLoad = null;
function loadRtc(appDir) {
  if (rtcLoad) return rtcLoad;
  const dirs = [path.join(appDir, 'runtime', 'node_modules', 'node-datachannel'), 'node-datachannel'];
  let why = '';
  for (const d of dirs) {
    try {
      const poly = require(d === 'node-datachannel' ? 'node-datachannel/polyfill' : path.join(d, 'dist', 'cjs', 'polyfill', 'index.cjs'));
      const main = require(d === 'node-datachannel' ? d : path.join(d, 'dist', 'cjs', 'index.cjs'));
      // cleanup(): the native threads keep a process alive until it is
      // called (process.exit ends it regardless).
      if (poly && poly.RTCPeerConnection) return (rtcLoad = { RTCPeerConnection: poly.RTCPeerConnection, cleanup: () => { try { main.cleanup(); } catch {} } });
    } catch (e) { why = e.message.split('\n')[0]; }
  }
  return (rtcLoad = { error: 'The connection component (node-datachannel) is not installed here. In the Chattering folder: npm ci --prefix runtime. (' + why + ')' });
}

// node-datachannel writes a TURN server as turn:<user>:<password>@host and
// reads the two back percent-decoded; the relay's credentials hold ':' '/'
// '+' '=', which must be encoded or the address means something else.
// (Browsers take the fields as they are: only this side needs it.)
function iceForNode(servers) {
  return (servers || []).map(s => s && s.username != null ? { ...s, username: encodeURIComponent(s.username), credential: encodeURIComponent(s.credential || '') } : s);
}

// Headers a phone may not choose: who it is, where it comes from, how the
// connection is framed. The home sets its own.
const DROP_IN = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
  'cookie', 'authorization', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'origin', 'referer', 'accept-encoding', 'content-length']);
const DROP_OUT = new Set(['connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'strict-transport-security', 'content-length', 'upgrade']);
const isDroppedIn = k => DROP_IN.has(k) || k.startsWith('sec-') || k.startsWith('tailscale-') || k.startsWith('x-chattering-');
// Text worth compressing for the trip (the phone may be on mobile data).
// A live event stream is left alone: each event must arrive when written.
const COMPRESSIBLE = /^(text\/(?!event-stream)|application\/(json|javascript|xml|manifest\+json|x-ndjson)|image\/svg)/i;

function createAnywhereHome(opts) {
  const {
    dataDir, appDir,
    relayUrl = () => DEFAULT_RELAY,        // current relay address
    enabled = () => true,                  // the owner's switch
    homeName = () => require('os').hostname(),
    localTarget,                           // () => { host, port }
    issueCredential,                       // (userId, label) → { secret, credentialId }
    credentialAlive,                       // (userId, credentialId) → bool
    revokeCredential = () => {},           // (userId, credentialId)
    userOf = () => null,                   // userId → { id, name } | null
    onChange = () => {},
    WebSocketImpl = globalThis.WebSocket,
    relayOnly = false,                     // tests: through the TURN server only
    log = () => {},
  } = opts;
  const file = path.join(dataDir, 'anywhere.json');
  const state = load();
  const pairings = new Map();              // id → { id, secret, userId, expiresAt, pairedDevice }
  const peers = new Map();                 // relay session id → Peer
  let key = null;                          // { privateKey, spki, homeId }
  let ws = null, relayState = 'off', relayError = '', retry = 0, retryTimer = null, stopped = false, iceServers = [];

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { key: raw.key || null, devices: Array.isArray(raw.devices) ? raw.devices : [] };
    } catch { return { key: null, devices: [] }; }
  }
  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  async function ensureKey() {
    if (key) return key;
    const subtle = P.subtle();
    if (!state.key) {
      const pair = await subtle.generateKey(P.ECDSA, true, ['sign', 'verify']);
      state.key = { jwk: await subtle.exportKey('jwk', pair.privateKey), spki: P.b64u(new Uint8Array(await subtle.exportKey('spki', pair.publicKey))) };
      save();
    }
    const privateKey = await subtle.importKey('jwk', state.key.jwk, P.ECDSA, false, ['sign']);
    const spki = P.unb64u(state.key.spki);
    key = { privateKey, spki, homeId: await P.homeIdOf(spki) };
    return key;
  }
  const rtc = () => loadRtc(appDir || __dirname);
  const wanted = () => !stopped && enabled() && !rtc().error && (state.devices.length > 0 || [...pairings.values()].some(p => !p.pairedDevice && p.expiresAt > Date.now()));
  const changed = () => { try { onChange(); } catch {} };

  /* ---- the relay: registration, signalling ---- */
  function sync() {
    if (wanted()) { if (!ws && !retryTimer) openRelay(); }
    else closeRelay('off');
  }
  function closeRelay(to) {
    clearTimeout(retryTimer); retryTimer = null;
    if (ws) { const w = ws; ws = null; try { w.close(); } catch {} }
    if (relayState !== to) { relayState = to; changed(); }
  }
  async function openRelay() {
    const k = await ensureKey();
    if (!wanted() || ws) return;
    const url = String(relayUrl() || DEFAULT_RELAY).replace(/\/+$/, '').replace(/^http/, 'ws') + '/signal';
    relayState = 'connecting'; changed();
    let sock;
    try { sock = new WebSocketImpl(url); } catch (e) { return relayFailed(e.message); }
    ws = sock;
    const send = m => { try { if (ws === sock) sock.send(JSON.stringify(m)); } catch {} };
    sock.onopen = () => send({ t: 'home', id: k.homeId, key: P.b64u(k.spki), v: P.VERSION });
    sock.onerror = () => {};
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      relayFailed(relayState === 'ready' ? 'the relay closed the connection' : relayError || 'could not reach the relay at ' + String(relayUrl() || DEFAULT_RELAY));
    };
    sock.onmessage = async ev => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
      if (m.t === 'challenge') return send({ t: 'proof', sig: P.b64u(await P.sign(k.privateKey, P.toBytes('chattering-anywhere-relay/' + P.VERSION + '\n' + m.nonce))) });
      if (m.t === 'welcome') { iceServers = Array.isArray(m.servers) ? m.servers : []; retry = 0; relayError = ''; relayState = 'ready'; changed(); return; }
      if (m.t === 'error') { relayError = String(m.why || 'the relay refused this computer'); return; }
      if (m.t === 'signal' && m.from) return onSignal(String(m.from), m.data || {}, send);
      if (m.t === 'gone' && m.from) { const p = peers.get(String(m.from)); if (p && !p.authed) p.close('the phone left'); }
    };
  }
  function relayFailed(why) {
    relayError = why;
    relayState = 'error';
    changed();
    if (!wanted()) return closeRelay('off');
    // 1 s, 2 s, 4 s … up to a minute, with jitter: a relay back from a
    // restart is not met by every home at the same instant.
    const delay = Math.min(60000, 1000 * 2 ** Math.min(retry++, 6)) * (0.7 + Math.random() * 0.6);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; if (wanted()) openRelay(); }, delay);
    if (retryTimer.unref) retryTimer.unref();
  }

  async function onSignal(from, data, send) {
    let peer = peers.get(from);
    if (!peer) {
      if (!data.sdp || data.sdp.type !== 'offer') return;
      // Full: make room by dropping the oldest connection that has not
      // proven itself yet. A proven phone is never pushed out by strangers
      // who know this computer's id; if all are proven, the newcomer waits.
      if (peers.size >= MAX_PEERS) {
        const oldest = [...peers.values()].filter(p => !p.authed).sort((a, b) => a.at - b.at)[0];
        if (!oldest) return;
        oldest.close();
      }
      peer = createPeer(from, send);
    }
    try {
      if (data.sdp) {
        await peer.pc.setRemoteDescription(data.sdp);
        for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        send({ t: 'signal', to: from, data: { sdp: { type: peer.pc.localDescription.type, sdp: peer.pc.localDescription.sdp } } });
      } else if (data.candidate) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.pending.push(data.candidate);
      }
    } catch (e) { log('anywhere: signalling failed: ' + e.message); peer.close('signalling failed'); }
  }

  /* ---- one phone's connection ---- */
  function createPeer(sid, send) {
    const { RTCPeerConnection } = rtc();
    const pc = new RTCPeerConnection({ iceServers: iceForNode(iceServers), ...(relayOnly ? { iceTransportPolicy: 'relay' } : {}) });
    const peer = { sid, pc, pending: [], at: Date.now(), authed: false, device: null, mux: null, streams: new Map(), closed: false, path: null };
    peers.set(sid, peer);
    peer.close = why => {
      if (peer.closed) return;
      peer.closed = true;
      peers.delete(sid);
      clearTimeout(peer.authTimer);
      for (const s of peer.streams.values()) { try { s.abort(); } catch {} }
      peer.streams.clear();
      if (peer.mux && why) { try { peer.mux.send(T.CTRL, 0, { t: 'bye', message: why }); peer.mux.pump(); } catch {} }
      if (peer.mux) peer.mux.close();
      setTimeout(() => { try { pc.close(); } catch {} }, 50);
      if (peer.device) changed();
    };
    peer.authTimer = setTimeout(() => { if (!peer.authed) peer.close(); }, AUTH_MS);
    // node-datachannel writes candidates as SDP lines (a=candidate:…); a
    // browser's addIceCandidate wants them without the a=.
    pc.onicecandidate = e => { if (e.candidate) send({ t: 'signal', to: sid, data: { candidate: { candidate: String(e.candidate.candidate).replace(/^a=/, ''), sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } } }); };
    pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) peer.close(); };
    pc.ondatachannel = e => {
      const dc = e.channel;
      if (dc.label !== 'tunnel' || peer.mux) return;
      dc.binaryType = 'arraybuffer';
      const start = () => {
        if (peer.mux) return;
        peer.mux = new P.Mux(dc, (t, s, b) => onFrame(peer, t, s, b));
        dc.onmessage = ev => peer.mux.receive(ev.data);
        peer.mux.onDrain(() => { for (const s of peer.streams.values()) if (s.resume) s.resume(); });
        hello(peer);
      };
      dc.onclose = () => peer.close();
      if (dc.readyState === 'open') start(); else dc.onopen = start;
    };
    return peer;
  }

  async function hello(peer) {
    const k = await ensureKey();
    peer.nonce = P.b64u(P.random(16));
    peer.mux.send(T.CTRL, 0, { t: 'hello', v: P.VERSION, key: P.b64u(k.spki), nonce: peer.nonce, name: homeName() });
  }
  function transcriptOf(peer, phoneNonce) {
    return P.transcript({ homeId: key.homeId, homeFp: P.fingerprint(peer.pc.localDescription && peer.pc.localDescription.sdp), phoneFp: P.fingerprint(peer.pc.remoteDescription && peer.pc.remoteDescription.sdp), homeNonce: peer.nonce, phoneNonce });
  }
  const refuse = (peer, why, message) => { peer.mux.send(T.CTRL, 0, { t: 'refused', why, message }); setTimeout(() => peer.close(), 200); };

  async function control(peer, m) {
    if (m.t === 'ping') return peer.mux.send(T.CTRL, 0, { t: 'pong', n: m.n });
    if (m.t === 'pong') return;
    if (m.t === 'path') { if (peer.authed && ['direct', 'relay'].includes(m.path) && peer.path !== m.path) { peer.path = m.path; changed(); } return; }
    if (m.t === 'hello' && !peer.phoneNonce) {
      peer.phoneNonce = String(m.nonce || '');
      await ensureKey();
      peer.transcript = transcriptOf(peer, peer.phoneNonce);
      return peer.mux.send(T.CTRL, 0, { t: 'proof', sig: P.b64u(await P.sign(key.privateKey, peer.transcript)) });
    }
    if (m.t !== 'auth' || peer.authed || !peer.transcript) return;
    const sig = P.unb64u(m.sig || '');
    if (m.pair) {
      const pairing = pairings.get(String(m.pair));
      if (!pairing || pairing.expiresAt < Date.now() || pairing.pairedDevice) return refuse(peer, 'pairing-expired', 'This code was already used or has expired. Show a new one on your computer.');
      const spki = P.unb64u(m.key || '');
      let pub;
      try { pub = await P.importPublic(spki); } catch { return refuse(peer, 'bad-key', 'This phone sent a key that cannot be read.'); }
      const mac = await P.hmac(P.unb64u(pairing.secret), peer.transcript);
      if (!P.sameBytes(mac, P.unb64u(m.mac || '')) || !(await P.verify(pub, sig, peer.transcript))) return refuse(peer, 'bad-code', 'The code did not match. Show a new one on your computer.');
      const name = String(m.name || 'Phone').slice(0, 60);
      let cred;
      try { cred = issueCredential(pairing.userId, name + ' · anywhere'); } catch (e) { return refuse(peer, 'no-person', e.message); }
      const device = { id: 'd' + P.b64u(P.random(9)), name, userId: pairing.userId, credentialId: cred.credentialId, secret: cred.secret, publicKey: P.b64u(spki), pairedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
      state.devices.push(device);
      pairing.pairedDevice = device.id;
      save();
      return welcome(peer, device, pub);
    }
    const device = state.devices.find(d => d.id === String(m.device || ''));
    if (!device) return refuse(peer, 'unknown', 'This phone is no longer paired with this computer.');
    if (!credentialAlive(device.userId, device.credentialId)) {
      state.devices = state.devices.filter(d => d !== device); save(); changed();
      return refuse(peer, 'removed', 'This phone was removed from this computer.');
    }
    const pub = await P.importPublic(P.unb64u(device.publicKey));
    if (!(await P.verify(pub, sig, peer.transcript))) return refuse(peer, 'bad-signature', 'This phone could not prove who it is.');
    return welcome(peer, device, pub);
  }
  async function welcome(peer, device) {
    peer.authed = true;
    peer.device = device;
    clearTimeout(peer.authTimer);
    device.lastSeenAt = new Date().toISOString();
    save();
    const u = userOf(device.userId);
    peer.mux.send(T.CTRL, 0, { t: 'welcome', device: device.id, user: u ? { id: u.id, name: u.name } : null, home: { name: homeName(), id: key.homeId } });
    // How the phone is connected (direct or through the relay) comes from
    // the phone: node-datachannel's statistics call a relayed path "srflx".
    changed();
  }

  /* ---- requests and sockets from an authenticated phone ---- */
  function onFrame(peer, type, id, bytes) {
    if (id === 0) { let m; try { m = P.json(bytes); } catch { return; } control(peer, m).catch(e => log('anywhere: ' + e.message)); return; }
    if (!peer.authed) return;
    if (type === T.REQ) return startRequest(peer, id, P.json(bytes));
    if (type === T.WS_OPEN) return startSocket(peer, id, P.json(bytes));
    const s = peer.streams.get(id);
    if (!s) return;
    if (type === T.REQ_BODY) s.write && s.write(bytes);
    else if (type === T.REQ_END) s.finish && s.finish();
    else if (type === T.CREDIT) s.credit && s.credit(P.readU32(bytes));
    else if (type === T.ABORT) { peer.streams.delete(id); s.abort(); }
    else if (type === T.WS_TEXT) s.text && s.text(P.text(bytes));
    else if (type === T.WS_BINARY) s.binary && s.binary(bytes);
    else if (type === T.WS_CLOSE) { peer.streams.delete(id); const m = P.json(bytes); s.close(m.code, m.reason); }
  }
  function forwardHeaders(peer, headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
      const n = String(k).toLowerCase();
      if (!isDroppedIn(n) && /^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(n)) out[n] = String(v).replace(/[\r\n]/g, ' ');
    }
    const t = localTarget();
    out.host = t.host + ':' + t.port;
    out.authorization = 'Bearer ' + peer.device.secret;
    // Forwarded, so the server never takes the phone for this machine's
    // own console; the address names the door it came through.
    out['x-forwarded-for'] = 'anywhere';
    out['x-forwarded-proto'] = 'https';
    return out;
  }
  function startRequest(peer, id, req) {
    const first = String(req.p || '/');
    if (!first.startsWith('/') || first.startsWith('//')) { peer.mux.send(T.ABORT, id, { why: 'bad path' }); return; }
    const headers = forwardHeaders(peer, req.h);
    headers['accept-encoding'] = 'gzip';
    let res = null, out = null, allowance = P.WINDOW, ended = false;
    const s = {
      write: b => out && out.write(Buffer.from(b)),
      finish: () => out && out.end(),
      credit: n => { allowance += n; s.resume(); },
      resume: () => { if (res && res.isPaused() && allowance > 0 && peer.mux.waiting(id) < 256 * 1024) res.resume(); },
      abort: () => { ended = true; try { out && out.destroy(); } catch {} try { res && res.destroy(); } catch {} peer.mux.drop(id); },
    };
    peer.streams.set(id, s);
    const failed = e => { if (ended) return; ended = true; peer.streams.delete(id); peer.mux.send(T.ABORT, id, { why: e.message }); };
    // fetch() follows redirects by itself (redirect: 'follow'); a page
    // navigation gets them to follow in the browser.
    const send = (method, p, hops, withBody) => {
      const t = localTarget();
      const h = { ...headers };
      if (!withBody) { delete h['content-type']; }
      out = http.request({ host: t.host, port: t.port, method, path: p, headers: h });
      if (!withBody) out.end();
      out.on('error', failed);
      out.on('response', r => {
        const loc = r.headers.location ? String(r.headers.location).replace(/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/i, '') : '';
        if (req.r === 'follow' && [301, 302, 303, 307, 308].includes(r.statusCode) && loc.startsWith('/') && !loc.startsWith('//') && hops < 5 && !(req.b && r.statusCode >= 307)) {
          r.resume();
          const keep = r.statusCode >= 307 || method === 'HEAD';
          return send(keep ? method : 'GET', loc, hops + 1, false);
        }
        respond(r, loc, method);
      });
    };
    const respond = (r, loc, method) => {
      const h = {};
      for (const [k, v] of Object.entries(r.headers)) if (!DROP_OUT.has(k)) h[k] = Array.isArray(v) ? v.join(', ') : v;
      if (loc) h.location = loc;
      let body = r;
      const type = String(h['content-type'] || '');
      if (!h['content-encoding'] && COMPRESSIBLE.test(type) && r.statusCode !== 204 && r.statusCode !== 304 && method !== 'HEAD') {
        body = r.pipe(zlib.createGzip({ level: 5 }));
        h['content-encoding'] = 'gzip';
      }
      res = body;
      peer.mux.send(T.RES, id, { s: r.statusCode, h });
      body.on('data', chunk => {
        if (ended) return;
        peer.mux.send(T.RES_BODY, id, chunk);
        allowance -= chunk.length;
        if (allowance <= 0 || peer.mux.waiting(id) > 512 * 1024) body.pause();
      });
      body.on('end', () => { if (ended) return; ended = true; peer.streams.delete(id); peer.mux.send(T.RES_END, id, null); });
      body.on('error', failed);
    };
    send(String(req.m || 'GET').toUpperCase(), first, 0, !!req.b);
  }
  function startSocket(peer, id, req) {
    const t = localTarget();
    const p = String(req.p || '/');
    if (!p.startsWith('/') || p.startsWith('//')) { peer.mux.send(T.WS_CLOSE, id, { code: 1008, reason: 'bad path' }); return; }
    const headers = forwardHeaders(peer, {});
    delete headers.host;
    let sock, closed = false;
    const protocols = (Array.isArray(req.protocols) ? req.protocols : []).map(String).filter(x => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(x));
    try { sock = new WebSocketImpl('ws://' + t.host + ':' + t.port + p, { protocols, headers }); }
    catch (e) { peer.mux.send(T.WS_CLOSE, id, { code: 1011, reason: e.message }); return; }
    sock.binaryType = 'arraybuffer';
    const queue = [];
    const s = {
      text: x => sock.readyState === 1 ? sock.send(x) : queue.push(x),
      binary: b => { const buf = Buffer.from(b); sock.readyState === 1 ? sock.send(buf) : queue.push(buf); },
      close: (code, reason) => { closed = true; try { sock.close(code >= 3000 && code < 5000 || code === 1000 ? code : 1000, String(reason || '').slice(0, 100)); } catch {} },
      abort: () => { closed = true; try { sock.close(); } catch {} },
    };
    peer.streams.set(id, s);
    sock.onopen = () => { peer.mux.send(T.WS_OPENED, id, { protocol: sock.protocol || '' }); for (const x of queue.splice(0)) sock.send(x); };
    sock.onmessage = e => { if (typeof e.data === 'string') peer.mux.send(T.WS_TEXT, id, e.data); else peer.mux.send(T.WS_BINARY, id, new Uint8Array(e.data)); };
    sock.onerror = () => {};
    sock.onclose = e => { peer.streams.delete(id); if (!closed) peer.mux.send(T.WS_CLOSE, id, { code: e.code === 1005 || e.code === 1006 ? 1011 : e.code, reason: e.reason || '' }); };
  }

  /* ---- what the settings page drives ---- */
  async function pair(userId) {
    const k = await ensureKey();
    for (const [id, p] of pairings) if (p.userId === userId || p.expiresAt < Date.now()) pairings.delete(id);
    const pairing = { id: P.b64u(P.random(9)), secret: P.b64u(P.random(16)), userId, expiresAt: Date.now() + PAIRING_MS, pairedDevice: null };
    pairings.set(pairing.id, pairing);
    const t = setTimeout(() => { if (pairings.get(pairing.id) === pairing) { pairings.delete(pairing.id); sync(); changed(); } }, PAIRING_MS + 1000);
    if (t.unref) t.unref();
    sync();
    changed();
    return { id: pairing.id, expiresAt: pairing.expiresAt, url: P.pairingLink(String(relayUrl() || DEFAULT_RELAY), { homeId: k.homeId, id: pairing.id, secret: pairing.secret, name: homeName() }) };
  }
  function pairingState(id) {
    const p = pairings.get(String(id));
    if (!p) return null;
    const d = p.pairedDevice && state.devices.find(x => x.id === p.pairedDevice);
    return { id: p.id, userId: p.userId, expiresAt: p.expiresAt, paired: d ? publicDevice(d) : null };
  }
  function cancelPairing(id, userId) {
    const p = pairings.get(String(id));
    if (p && (!userId || p.userId === userId)) pairings.delete(p.id);
    sync(); changed();
  }
  function forget(deviceId) {
    const d = state.devices.find(x => x.id === deviceId);
    if (!d) return null;
    state.devices = state.devices.filter(x => x !== d);
    save();
    try { revokeCredential(d.userId, d.credentialId); } catch {}
    for (const p of [...peers.values()]) if (p.device && p.device.id === d.id) p.close('This phone was removed from ' + homeName() + '.');
    sync(); changed();
    return d;
  }
  // A person was removed or a credential revoked elsewhere (People panel):
  // phones holding it go at once, not at their next request.
  function prune() {
    const before = state.devices.length;
    state.devices = state.devices.filter(d => credentialAlive(d.userId, d.credentialId));
    if (state.devices.length !== before) {
      save();
      const ids = new Set(state.devices.map(d => d.id));
      for (const p of [...peers.values()]) if (p.device && !ids.has(p.device.id)) p.close('This phone was removed from ' + homeName() + '.');
      sync(); changed();
    }
  }
  function publicDevice(d) {
    const live = [...peers.values()].filter(p => p.authed && p.device && p.device.id === d.id);
    const u = userOf(d.userId);
    return { id: d.id, name: d.name, user: u ? { id: u.id, name: u.name } : { id: d.userId, name: '' }, pairedAt: d.pairedAt, lastSeenAt: live.length ? new Date().toISOString() : d.lastSeenAt,
      online: live.length > 0, path: live.map(p => p.path).find(Boolean) || null };
  }
  function status() {
    const r = rtc();
    return {
      available: !r.error, why: r.error || '',
      enabled: enabled(), relay: String(relayUrl() || DEFAULT_RELAY), defaultRelay: DEFAULT_RELAY,
      relayState, relayError: relayState === 'error' ? relayError : '',
      homeId: key ? key.homeId : null,
      devices: state.devices.map(publicDevice),
      connected: [...peers.values()].filter(p => p.authed).length,
    };
  }
  function stop() {
    stopped = true;
    for (const p of [...peers.values()]) p.close();
    closeRelay('off');
  }
  // Settings changed (relay address, switch): reconnect as they now say.
  function refresh() {
    if (!enabled()) for (const p of [...peers.values()]) p.close('Anywhere was turned off on ' + homeName() + '.');
    closeRelay('off');
    retry = 0;
    sync();
  }

  ensureKey().then(() => sync()).catch(e => log('anywhere: ' + e.message));
  return { status, pair, pairingState, cancelPairing, forget, prune, refresh, stop, sync, homeId: async () => (await ensureKey()).homeId, devicesOf: userId => state.devices.filter(d => d.userId === userId).map(publicDevice), _peers: peers };
}

// The pairing link as a QR code, black on white with its quiet zone.
function qrSvg(text) {
  const qrcode = require('./vendor/qrcode-generator/qrcode.js');
  const q = qrcode(0, 'M');
  q.addData(String(text));
  q.make();
  const n = q.getModuleCount(), m = 4;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + (c + m) + ' ' + (r + m) + 'h1v1h-1z';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + (n + 2 * m) + ' ' + (n + 2 * m) + '" shape-rendering="crispEdges" role="img" aria-label="Pairing code"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}

module.exports = { createAnywhereHome, DEFAULT_RELAY, loadRtc, qrSvg, iceForNode };
