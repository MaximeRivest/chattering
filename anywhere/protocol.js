/* Chattering Anywhere: the wire between a phone and its home computer
   (design/85). One file for both ends: the home (Node) requires it, the
   phone's page loads it as a script. Nothing here touches the network.

   The tunnel is one WebRTC data channel, ordered and reliable. WebRTC
   already encrypts it end to end (DTLS), whether the packets go straight
   between the two devices or through the relay's TURN server. What WebRTC
   does not know is *who* is at the other end: the fingerprints of the two
   DTLS certificates travel through the relay's signalling, so a dishonest
   relay could hand each side its own. The handshake below closes that: the
   home signs both fingerprints with the key whose hash the phone got from
   the QR code, and the phone signs them with the key the home registered
   at pairing. A relay in the middle would see different fingerprints on
   each side, and the signatures would not match.

   Frames: [flags|type (1 byte)][stream (4 bytes, big endian)][payload].
   The top bit of the first byte says "more of this message follows": a
   message larger than one frame is cut, the receiver joins it back. Many
   requests share the channel; the sender takes turns between streams so a
   large download never holds up a small request behind it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AnywhereProtocol = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;
  const T = {
    REQ: 1,        // phone → home  JSON { m, p, h, b }: method, path, headers, has a body
    REQ_BODY: 2,   // phone → home  bytes
    REQ_END: 3,    // phone → home  (empty)
    RES: 4,        // home → phone  JSON { s, h }: status, headers
    RES_BODY: 5,   // home → phone  bytes
    RES_END: 6,    // home → phone  (empty)
    ABORT: 7,      // either way    JSON { why }: the stream is over, unfinished
    WS_OPEN: 8,    // phone → home  JSON { p, protocols }
    WS_OPENED: 9,  // home → phone  JSON { protocol }
    WS_TEXT: 10,   // either way    UTF-8
    WS_BINARY: 11, // either way    bytes
    WS_CLOSE: 12,  // either way    JSON { code, reason }
    CTRL: 13,      // stream 0      JSON: handshake, ping, pong
    CREDIT: 14,    // phone → home  uint32: bytes of a response body the phone has consumed
  };
  const MORE = 0x80;
  const HEADER = 5;
  // 16 KiB is the message size every WebRTC stack delivers whole; bigger
  // messages are cut here and joined on arrival.
  const FRAME = 16 * 1024;
  const MAX_CHUNK = FRAME - HEADER;
  // A message joined from pieces never grows past this (a response body
  // chunk is at most 64 KiB, a WebSocket message of the app a few MiB).
  const MAX_MESSAGE = 32 * 1024 * 1024;
  // How much of one response body the home sends before the phone says it
  // took it: a slow reader (a video paused) holds the home back instead of
  // filling the phone's memory.
  const WINDOW = 1024 * 1024;
  // The channel's own send buffer: above this the sender waits.
  const HIGH_WATER = 1024 * 1024;
  const LOW_WATER = 256 * 1024;

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function toBytes(payload) {
    if (payload == null) return new Uint8Array(0);
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (ArrayBuffer.isView(payload)) return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    if (typeof payload === 'string') return enc.encode(payload);
    return enc.encode(JSON.stringify(payload));
  }
  function frame(type, stream, bytes, more) {
    const out = new Uint8Array(HEADER + bytes.length);
    out[0] = (more ? MORE : 0) | type;
    out[1] = (stream >>> 24) & 255; out[2] = (stream >>> 16) & 255; out[3] = (stream >>> 8) & 255; out[4] = stream & 255;
    out.set(bytes, HEADER);
    return out;
  }
  function parse(data) {
    const b = toBytes(data);
    if (b.length < HEADER) throw new Error('short frame');
    return { type: b[0] & 0x7f, more: (b[0] & MORE) !== 0, stream: ((b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0, payload: b.subarray(HEADER) };
  }
  const text = bytes => dec.decode(bytes);
  const json = bytes => JSON.parse(dec.decode(bytes));
  const u32 = n => { const b = new Uint8Array(4); b[0] = (n >>> 24) & 255; b[1] = (n >>> 16) & 255; b[2] = (n >>> 8) & 255; b[3] = n & 255; return b; };
  const readU32 = b => ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;

  /* The multiplexer over one data channel. `channel` is an RTCDataChannel
     (the browser's or node-datachannel's). onMessage(type, stream, bytes)
     receives whole messages. Stream 0 (the handshake, pings) always goes
     first; the others take turns, one frame each. */
  class Mux {
    constructor(channel, onMessage) {
      this.ch = channel;
      this.onMessage = onMessage;
      this.urgent = [];
      this.queues = new Map();   // stream → frames waiting
      this.turns = [];           // streams with frames waiting, in turn order
      this.bytes = new Map();    // stream → bytes waiting
      this.parts = new Map();    // stream → pieces of a message being joined
      this.drainHooks = new Set();
      this.closed = false;
      try { channel.binaryType = 'arraybuffer'; } catch {}
      try { channel.bufferedAmountLowThreshold = LOW_WATER; } catch {}
      const pump = () => this.pump();
      if (channel.addEventListener) channel.addEventListener('bufferedamountlow', pump);
      else channel.onbufferedamountlow = pump;
    }
    send(type, stream, payload) {
      if (this.closed) return false;
      const bytes = toBytes(payload);
      const frames = [];
      if (bytes.length <= MAX_CHUNK) frames.push(frame(type, stream, bytes, false));
      else for (let at = 0; at < bytes.length; at += MAX_CHUNK) frames.push(frame(type, stream, bytes.subarray(at, at + MAX_CHUNK), at + MAX_CHUNK < bytes.length));
      if (stream === 0) this.urgent.push(...frames);
      else {
        let q = this.queues.get(stream);
        if (!q) { q = []; this.queues.set(stream, q); }
        if (!q.length) this.turns.push(stream);
        q.push(...frames);
        this.bytes.set(stream, (this.bytes.get(stream) || 0) + bytes.length);
      }
      this.pump();
      return true;
    }
    // Bytes of one stream not yet handed to the channel.
    waiting(stream) { return this.bytes.get(stream) || 0; }
    // Forget what one stream still had to send (it was aborted).
    drop(stream) {
      this.queues.delete(stream);
      this.bytes.delete(stream);
      this.parts.delete(stream);
      this.turns = this.turns.filter(s => s !== stream);
    }
    onDrain(fn) { this.drainHooks.add(fn); return () => this.drainHooks.delete(fn); }
    pump() {
      if (this.closed) return;
      let sent = false;
      try {
        while (this.ch.readyState === 'open' && this.ch.bufferedAmount < HIGH_WATER) {
          let f;
          if (this.urgent.length) f = this.urgent.shift();
          else if (this.turns.length) {
            const s = this.turns.shift();
            const q = this.queues.get(s);
            f = q.shift();
            const left = (this.bytes.get(s) || 0) - (f.length - HEADER);
            if (q.length) { this.turns.push(s); this.bytes.set(s, left); }
            else { this.queues.delete(s); this.bytes.delete(s); }
          } else break;
          this.ch.send(f);
          sent = true;
        }
      } catch (e) { this.close(); return; }
      if (sent || !this.turns.length) for (const fn of [...this.drainHooks]) { try { fn(); } catch {} }
    }
    receive(data) {
      let f;
      try { f = parse(data); } catch { return; }
      if (f.more || this.parts.has(f.stream)) {
        let p = this.parts.get(f.stream);
        if (!p) { p = { type: f.type, list: [], size: 0 }; this.parts.set(f.stream, p); }
        p.list.push(f.payload.slice()); p.size += f.payload.length;
        if (p.size > MAX_MESSAGE) { this.parts.delete(f.stream); return; }
        if (f.more) return;
        this.parts.delete(f.stream);
        const whole = new Uint8Array(p.size);
        let at = 0;
        for (const piece of p.list) { whole.set(piece, at); at += piece.length; }
        this.onMessage(p.type, f.stream, whole);
        return;
      }
      this.onMessage(f.type, f.stream, f.payload);
    }
    close() {
      this.closed = true;
      this.urgent = []; this.queues.clear(); this.turns = []; this.bytes.clear(); this.parts.clear();
    }
  }

  /* ---- identity: keys, fingerprints, the handshake transcript ---- */

  const subtle = () => (typeof crypto !== 'undefined' && crypto.subtle) || require('crypto').webcrypto.subtle;
  const random = n => { const b = new Uint8Array(n); ((typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : require('crypto').webcrypto).getRandomValues(b); return b; };
  function b64u(bytes) {
    const b = toBytes(bytes);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(s) {
    const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(t + '==='.slice((t.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
  const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
  async function sha256(bytes) { return new Uint8Array(await subtle().digest('SHA-256', toBytes(bytes))); }
  // A home's name on the relay and in the QR code: the first 16 bytes of the
  // SHA-256 of its public key. Knowing it is enough to recognise the key,
  // not to forge one.
  async function homeIdOf(spki) { return b64u((await sha256(spki)).subarray(0, 16)); }
  async function importPublic(spki) { return subtle().importKey('spki', toBytes(spki), ECDSA, true, ['verify']); }
  async function sign(privateKey, bytes) { return new Uint8Array(await subtle().sign(SIGN, privateKey, toBytes(bytes))); }
  async function verify(publicKey, signature, bytes) {
    try { return await subtle().verify(SIGN, publicKey, toBytes(signature), toBytes(bytes)); } catch { return false; }
  }
  async function hmac(secret, bytes) {
    const k = await subtle().importKey('raw', toBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await subtle().sign('HMAC', k, toBytes(bytes)));
  }
  function sameBytes(a, b) {
    a = toBytes(a); b = toBytes(b);
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }
  // The DTLS certificate fingerprint a description announces (sha-256,
  // upper case, colons as written). Every WebRTC stack writes one.
  function fingerprint(sdp) {
    const m = /a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/.exec(String(sdp || ''));
    return m ? m[1].toUpperCase() : '';
  }
  // What both sides sign: the protocol, the home, both certificates, both
  // fresh nonces. A signature from another connection matches nothing here.
  function transcript({ homeId, homeFp, phoneFp, homeNonce, phoneNonce }) {
    return enc.encode(['chattering-anywhere/' + VERSION, 'home:' + homeId, 'home-fp:' + homeFp, 'phone-fp:' + phoneFp, 'home-nonce:' + homeNonce, 'phone-nonce:' + phoneNonce].join('\n'));
  }

  /* ---- the pairing link ---- */
  // https://relay/#pair=<homeId>.<pairingId>.<secret>&n=<home name>
  // Everything after # stays in the phone: browsers never send it to a server.
  function pairingLink(relay, { homeId, id, secret, name }) {
    return String(relay).replace(/\/+$/, '') + '/#pair=' + [homeId, id, secret].join('.') + (name ? '&n=' + encodeURIComponent(name) : '');
  }
  function readPairingLink(hash) {
    const q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const parts = String(q.get('pair') || '').split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]{8,64}$/.test(p))) return null;
    return { homeId: parts[0], id: parts[1], secret: parts[2], name: (q.get('n') || '').slice(0, 60) };
  }

  // A few plain words for a device, from its browser's description.
  function deviceLabel(ua) {
    ua = String(ua || '');
    const browser = /EdgA?\//.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
    let device = 'Phone';
    const android = /Android[^;)]*;\s*([^;)]+?)(?:\sBuild|\))/.exec(ua);
    if (/iPhone/.test(ua)) device = 'iPhone';
    else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))) device = 'iPad';
    else if (android) device = android[1].trim() === 'K' ? 'Android' : android[1].trim().slice(0, 30);
    else if (/Android/.test(ua)) device = 'Android';
    else if (/Macintosh/.test(ua)) device = 'Mac';
    else if (/Windows/.test(ua)) device = 'Windows PC';
    else if (/CrOS/.test(ua)) device = 'Chromebook';
    else if (/Linux/.test(ua)) device = 'Linux computer';
    return device + ' · ' + browser;
  }

  // From a connection's statistics: 'direct', 'relay' (through the TURN
  // server), or null while nothing is chosen.
  function pathFromStats(stats) {
    const byId = new Map();
    let pair = null;
    stats.forEach(r => { byId.set(r.id, r); });
    stats.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = byId.get(r.selectedCandidatePairId) || pair; });
    if (!pair) stats.forEach(r => { if (!pair && r.type === 'candidate-pair' && (r.selected || r.nominated) && r.state === 'succeeded') pair = r; });
    if (!pair) return null;
    const local = byId.get(pair.localCandidateId), remote = byId.get(pair.remoteCandidateId);
    if (!local && !remote) return null;
    return (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay') ? 'relay' : 'direct';
  }

  return { VERSION, T, pathFromStats, MORE, HEADER, FRAME, MAX_CHUNK, WINDOW, HIGH_WATER, LOW_WATER,
    toBytes, frame, parse, text, json, u32, readU32, Mux,
    ECDSA, SIGN, subtle, random, b64u, unb64u, sha256, homeIdOf, importPublic, sign, verify, hmac, sameBytes,
    fingerprint, transcript, pairingLink, readPairingLink, deviceLabel };
});
