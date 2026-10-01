'use strict';
/* Chattering Anywhere between computers (design/90): this install holds an
   encrypted link to another Chattering and shows it here, at a local address
   of its own (http://localhost:<port>), so a browser on this computer opens
   the other one as if it were local: its pages, its live updates, its
   WebSockets, from anywhere, with no Tailscale.

   It is the phone's link (design/85), carried by this install instead of a
   page from the relay: this computer pairs with the other one exactly as a
   phone does (the code, the handshake, a credential of the person who
   showed the code), and keeps its key in its own data folder.

   Who may use a link: only the person who made it, signed in to this
   Chattering (its sign-in cookie reaches every localhost port), or this
   machine's console. The port listens on 127.0.0.1 only; requests from
   other sites, and for other host names, are refused.

   File (0600): <dataDir>/anywhere-links.json — per link: the other
   computer's id, its relay, the name it gave, this install's key for it,
   the device id it knows this install by, the local port, and who made it. */
const fs = require('fs');
const { readPrivateFileSync, writePrivateFileSync } = require('./private-file');
const path = require('path');
const http = require('http');
const P = require('./anywhere/protocol.js');
const Client = require('./anywhere/client.js');
const { acceptWebSocket, refuseUpgrade } = require('./wsserver.js');

const PORT_BASE = 7461;
const MAX_BODY = 64 * 1024 * 1024;
// Hop-by-hop, or this install's to decide: never sent through.
const DROP_IN = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'cookie', 'authorization', 'content-length']);
const DROP_OUT = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length']);

function createAnywhereLinks(opts) {
  const {
    dataDir,
    rtc,                                   // { RTCPeerConnection, error }
    iceForNode = x => x,
    authorize,                             // (req, link) → true when this person may use this link
    deviceName = () => require('os').hostname() + ' · Chattering',
    onChange = () => {},
    log = () => {},
    host = '127.0.0.1',
    portBase = PORT_BASE,
  } = opts;
  const file = path.join(dataDir, 'anywhere-links.json');
  const state = load();
  const live = new Map(); // link id → { server, tunnel, connecting, lastError, retry }
  let stopped = false;

  function load() {
    const bytes = readPrivateFileSync(file);
    if (bytes === null) return { links: [] }; // only initial-open absence resets
    const raw = JSON.parse(bytes);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.links) ||
        raw.links.some(link => !link || typeof link !== 'object' || Array.isArray(link)))
      throw new Error('Corrupt Anywhere link store');
    return { links: raw.links };
  }
  function save() {
    writePrivateFileSync(file, JSON.stringify(state, null, 1) + '\n');
  }
  const changed = () => { try { onChange(); } catch {} };

  async function keyOf(link) {
    const privateKey = await P.subtle().importKey('jwk', link.key.jwk, P.ECDSA, false, ['sign']);
    return { id: link.deviceId, privateKey, spki: P.unb64u(link.key.spki) };
  }
  function freePort() {
    const used = new Set(state.links.map(l => l.port));
    let p = portBase;
    while (used.has(p)) p++;
    return p;
  }

  /* ---- pairing: this install becomes a device of the other one ---- */
  async function add(pairingUrl, { by } = {}) {
    if (rtc.error) throw new Error(rtc.error);
    let u;
    try { u = new URL(String(pairingUrl).trim()); } catch { throw Object.assign(new Error('That is not a pairing link.'), { status: 400 }); }
    const code = P.readPairingLink(u.hash);
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (!code || !(u.protocol === 'https:' || (u.protocol === 'http:' && local))) throw Object.assign(new Error('That is not a pairing link.'), { status: 400 });
    if (code.expires && code.expires < Date.now()) throw Object.assign(new Error('This code has expired: show a new one on the other computer.'), { status: 400 });
    const relay = u.origin;
    const pair = await P.subtle().generateKey(P.ECDSA, true, ['sign', 'verify']);
    const spki = new Uint8Array(await P.subtle().exportKey('spki', pair.publicKey));
    const jwk = await P.subtle().exportKey('jwk', pair.privateKey);
    let tunnel;
    try {
      tunnel = await Client.connect({ relay, homeId: code.homeId, name: deviceName(), device: { privateKey: pair.privateKey, spki },
        pairing: { id: code.id, secret: code.secret }, RTCPeerConnection: rtc.RTCPeerConnection, WebSocket, mapIceServers: iceForNode, wait: false, timeoutMs: 30000 });
    } catch (e) {
      const why = e.code === 'refused' ? 'The other computer refused this code (used already, or expired): show a new one there.'
        : e.code === 'offline' ? 'The other computer is not connected right now.' : e.message;
      throw Object.assign(new Error(why), { status: 400 });
    }
    const existing = state.links.find(l => l.homeId === code.homeId);
    const link = {
      id: existing ? existing.id : 'l' + P.b64u(P.random(6)),
      homeId: code.homeId, relay, name: (tunnel.home && tunnel.home.name) || code.name || 'Computer',
      deviceId: tunnel.device, key: { jwk, spki: P.b64u(spki) },
      user: tunnel.user || null, by: by || null,
      port: existing ? existing.port : freePort(), pairedAt: new Date().toISOString(),
    };
    state.links = state.links.filter(l => l.homeId !== code.homeId).concat(link);
    save();
    const l = live.get(link.id);
    if (l && l.tunnel) { try { l.tunnel.close(); } catch {} }
    await serve(link);
    adopt(link, tunnel);
    changed();
    return publicLink(link);
  }

  /* ---- the tunnel, kept open while wanted, rebuilt when lost ---- */
  function entry(link) {
    let e = live.get(link.id);
    if (!e) { e = { server: null, tunnel: null, connecting: null, lastError: '', retry: 0, waiters: [] }; live.set(link.id, e); }
    return e;
  }
  function adopt(link, tunnel) {
    const e = entry(link);
    e.tunnel = tunnel; e.lastError = ''; e.retry = 0;
    tunnel.onLost(why => {
      if (e.tunnel !== tunnel) return;
      e.tunnel = null;
      e.lastError = why;
      changed();
      if (/removed/.test(why)) { e.lastError = 'This computer was removed there: pair it again.'; e.removed = true; }
    });
    for (const w of e.waiters.splice(0)) w.resolve(tunnel);
    changed();
  }
  function tunnelFor(link) {
    const e = entry(link);
    if (e.tunnel) return Promise.resolve(e.tunnel);
    if (e.removed) return Promise.reject(new Error(e.lastError));
    if (!e.connecting) {
      e.connecting = (async () => {
        const device = await keyOf(link);
        const t = await Client.connect({ relay: link.relay, homeId: link.homeId, name: deviceName(), device,
          RTCPeerConnection: rtc.RTCPeerConnection, WebSocket, mapIceServers: iceForNode, wait: false, timeoutMs: 20000 });
        adopt(link, t);
        return t;
      })().catch(err => {
        e.lastError = err.code === 'offline' ? 'not connected right now' : err.code === 'refused' ? 'This computer was removed there: pair it again.' : err.message;
        if (err.code === 'refused') e.removed = true;
        changed();
        throw err;
      }).finally(() => { e.connecting = null; });
    }
    return e.connecting;
  }

  /* ---- the local address ---- */
  const refuse = (res, status, text) => { try { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(text + '\n'); } catch {} };
  function allowedHost(req, link) {
    const h = String(req.headers.host || '').toLowerCase();
    return h === `localhost:${link.port}` || h === `127.0.0.1:${link.port}`;
  }
  const crossSite = req => ['cross-site', 'same-site'].includes(String(req.headers['sec-fetch-site'] || ''));
  function forwardHeaders(req) {
    const out = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const n = k.toLowerCase();
      if (!DROP_IN.has(n) && !n.startsWith('sec-websocket')) out[n] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    return out;
  }
  const notHere = (link, why) => `<!doctype html><meta charset="utf-8"><title>${link.name}</title><body style="font:16px/1.5 system-ui;padding:3em;max-width:40em;margin:auto">
<h1 style="font-size:1.3em">${link.name.replace(/[<>&]/g, '')} cannot be reached right now</h1><p>${String(why || '').replace(/[<>&]/g, '')}</p>
<p>It may be asleep, turned off, or without internet. <a href="">Try again</a></p>`;

  async function serve(link) {
    const e = entry(link);
    if (e.server) return;
    const server = http.createServer(async (req, res) => {
      if (!allowedHost(req, link)) return refuse(res, 421, 'This address answers to localhost only.');
      if (crossSite(req)) return refuse(res, 403, 'Requests from other sites are refused.');
      let ok = false;
      try { ok = await authorize(req, link); } catch {}
      if (!ok) return refuse(res, 401, `Sign in to Chattering on this computer as the person who linked ${link.name}, then reload.`);
      let body = null;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const parts = []; let size = 0;
        try { for await (const c of req) { size += c.length; if (size > MAX_BODY) return refuse(res, 413, 'Too large.'); parts.push(c); } } catch { return; }
        body = Buffer.concat(parts);
      }
      let tunnel;
      try { tunnel = await tunnelFor(link); }
      catch (err) {
        const html = /text\/html/.test(String(req.headers.accept || ''));
        res.writeHead(503, { 'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store' });
        return res.end(html ? notHere(link, entry(link).lastError || err.message) : JSON.stringify({ error: `${link.name}: ${entry(link).lastError || err.message}` }));
      }
      let ended = false;
      const h = tunnel.request({ method: req.method, path: req.url, headers: forwardHeaders(req), body }, {
        onHead: head => {
          const headers = {};
          for (const [k, v] of Object.entries(head.headers || {})) if (!DROP_OUT.has(k.toLowerCase())) headers[k] = v;
          try { res.writeHead(head.status, headers); } catch { h.cancel(); }
        },
        onChunk: bytes => {
          const ok = res.write(Buffer.from(bytes));
          if (ok) h.consumed(bytes.length);
          else res.once('drain', () => h.consumed(bytes.length));
        },
        onEnd: () => { ended = true; res.end(); },
        onError: err => { ended = true; if (!res.headersSent) refuse(res, 502, `${link.name}: ${err.message}`); else res.destroy(); },
      });
      res.on('close', () => { if (!ended) h.cancel(); });
    });
    server.on('upgrade', async (req, socket, head) => {
      if (!allowedHost(req, link) || crossSite(req)) return refuseUpgrade(socket, 403, 'Forbidden');
      let ok = false;
      try { ok = await authorize(req, link); } catch {}
      if (!ok) return refuseUpgrade(socket, 401, 'Unauthorized');
      let tunnel;
      try { tunnel = await tunnelFor(link); } catch { return refuseUpgrade(socket, 503, 'Service Unavailable'); }
      const conn = acceptWebSocket(req, socket, head, { protocol: false });
      if (!conn) return;
      const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim()).filter(Boolean);
      const pending = [];
      let open = false;
      const remote = tunnel.socket(req.url, protocols, {
        onOpen: () => { open = true; for (const f of pending.splice(0)) f(); },
        onText: t => conn.send(t),
        onBinary: b => conn.send(Buffer.from(b)),
        onClose: (code, reason) => { try { conn.close(code === 1006 ? 1011 : code, reason); } catch {} },
      });
      conn.on('message', (m, binary) => { const f = () => (binary ? remote.sendBinary(m) : remote.sendText(m)); if (open) f(); else pending.push(f); });
      conn.on('close', () => { try { remote.close(1000, ''); } catch {} });
      conn.on('error', () => {});
    });
    server.on('clientError', (err, socket) => { try { socket.destroy(); } catch {} });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(link.port, host, () => { server.off('error', reject); resolve(); });
    }).catch(err => { log(`anywhere link ${link.name}: port ${link.port}: ${err.message}`); throw err; });
    e.server = server;
  }

  function publicLink(link) {
    const e = live.get(link.id) || {};
    return { id: link.id, name: link.name, url: `http://localhost:${link.port}/`, port: link.port, relay: link.relay,
      homeId: link.homeId, user: link.user, by: link.by, pairedAt: link.pairedAt,
      connected: !!e.tunnel, removed: !!e.removed, why: e.tunnel ? '' : (e.lastError || '') };
  }

  async function remove(id) {
    const link = state.links.find(l => l.id === id);
    if (!link) return null;
    state.links = state.links.filter(l => l !== link);
    save();
    const e = live.get(id);
    if (e) {
      if (e.tunnel) { try { e.tunnel.close(); } catch {} }
      if (e.server) await new Promise(r => e.server.close(() => r()));
      live.delete(id);
    }
    changed();
    return publicLink(link);
  }
  async function start() {
    if (rtc.error) return;
    for (const link of state.links) { try { await serve(link); } catch {} }
  }
  function stop() {
    stopped = true;
    for (const e of live.values()) {
      if (e.tunnel) { try { e.tunnel.close(); } catch {} }
      if (e.server) { try { e.server.close(); } catch {} }
    }
    live.clear();
  }
  return {
    add, remove, start, stop,
    list: () => state.links.map(publicLink),
    find: id => state.links.find(l => l.id === id) || null,
    // Open now (a switcher about to go there): connected, or why not.
    async check(id) {
      const link = state.links.find(l => l.id === id);
      if (!link) return { ok: false, why: 'no such link' };
      try { await tunnelFor(link); return { ok: true }; } catch (err) { return { ok: false, why: entry(link).lastError || err.message }; }
    },
    get stopped() { return stopped; },
  };
}

module.exports = { createAnywhereLinks, PORT_BASE };
