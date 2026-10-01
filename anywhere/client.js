/* Chattering Anywhere, the phone's end (design/85): find the home through
   the relay, open a WebRTC data channel to it, prove who both ends are, and
   carry requests and WebSockets over it. The page (public/shell.js) uses it
   in the browser; the tests use the same code in Node with node-datachannel.

   connect(options) → Promise<Tunnel>
     relay           the relay's address (https://…)
     homeId          the home to reach (from the QR code)
     device          { id?, privateKey, spki }: this phone's key; id once paired
     pairing         { id, secret } the first time, from the QR code
     name            how the home should call this phone
     RTCPeerConnection, WebSocket   the platform's (the browser's by default)
     onStatus(state, detail)        'relay' 'waiting' 'connecting' 'securing'
     mapIceServers(list)            adapts the relay's STUN/TURN list (node-datachannel)
     relayOnly       through the TURN server only (tests)
     signal          an AbortSignal
   A failure rejects with an Error whose .code is one of: relay (the relay
   cannot be reached), offline (the home is not there and wait is false),
   refused (the home said no: .why), forged (the other end is not the home
   in the QR code), failed (no network path), aborted. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./protocol.js'));
  else root.AnywhereClient = factory(root.AnywhereProtocol);
})(typeof self !== 'undefined' ? self : this, function (P) {
  'use strict';
  const { T } = P;

  const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
  const signalUrl = relay => String(relay).replace(/\/+$/, '').replace(/^http/, 'ws') + '/signal';

  function connect(opts) {
    const RTC = opts.RTCPeerConnection || (typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : null);
    const WS = opts.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    const status = opts.onStatus || (() => {});
    const wait = opts.wait !== false;
    const timeoutMs = opts.timeoutMs || 30000;
    return new Promise((resolve, reject) => {
      let ws = null, pc = null, dc = null, mux = null, done = false, timer = null;
      let homeHello = null, proof = null, phoneNonce = P.b64u(P.random(16));
      const pendingCandidates = [], localCandidates = [];
      let remoteReady = false, offerSent = false, signals = Promise.resolve();
      const finish = (err, tunnel) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
        // The relay's part ends once the tunnel stands: nothing more to pass.
        try { ws && ws.close(); } catch {}
        if (err) { try { mux && mux.close(); } catch {} try { pc && pc.close(); } catch {} reject(err); }
        else resolve(tunnel);
      };
      const onAbort = () => finish(fail('aborted', 'stopped'));
      if (opts.signal) { if (opts.signal.aborted) return onAbort(); opts.signal.addEventListener('abort', onAbort); }
      const arm = () => { clearTimeout(timer); timer = setTimeout(() => finish(fail(pc ? 'failed' : 'relay', pc ? 'no network path to your computer' : 'the relay did not answer')), timeoutMs); };
      arm();
      const send = m => { try { ws.send(JSON.stringify(m)); } catch {} };

      status('relay');
      try { ws = new WS(signalUrl(opts.relay)); } catch (e) { return finish(fail('relay', e.message)); }
      ws.onerror = () => { if (!pc) finish(fail('relay', 'could not reach the relay')); };
      ws.onclose = () => { if (!mux) finish(fail(pc ? 'failed' : 'relay', pc ? 'the relay closed before your computer answered' : 'the relay closed the connection')); };
      ws.onopen = () => send({ t: 'call', to: opts.homeId, v: P.VERSION });
      ws.onmessage = async ev => {
        if (done) return;
        let m;
        try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : P.text(P.toBytes(ev.data))); } catch { return; }
        if (m.t === 'offline') {
          if (!wait) return finish(fail('offline', 'your computer is not connected right now'));
          clearTimeout(timer); // waiting has no end: the page shows it
          return status('waiting');
        }
        if (m.t === 'online') { arm(); return send({ t: 'call', to: opts.homeId, v: P.VERSION }); }
        if (m.t === 'error') return finish(fail('relay', m.why || 'the relay refused'));
        if (m.t === 'ice') return start(m.servers || []);
        if (m.t === 'gone') return pc && !mux && finish(fail('failed', 'your computer left before the connection was made'));
        if (m.t === 'signal' && pc && m.data) {
          // WebSocket callbacks do not await each other. In particular the
          // native polyfill returns an empty *object* before remote SDP exists.
          // Apply signals serially and mark readiness only after SDP succeeds.
          signals = signals.then(async () => {
            if (done) return;
            if (m.data.sdp) {
              await pc.setRemoteDescription(m.data.sdp);
              if (done) return;
              remoteReady = true;
              for (const c of pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => {});
            } else if (m.data.candidate) {
              if (remoteReady) await pc.addIceCandidate(m.data.candidate).catch(() => {});
              else pendingCandidates.push(m.data.candidate);
            }
          }).catch(e => finish(fail('failed', e.message)));
        }
      };

      async function start(servers) {
        if (pc) return;
        status('connecting');
        arm();
        // relayOnly: through the TURN server even when a direct path exists
        // (the tests prove the relayed path; a person never needs it).
        pc = new RTC({ iceServers: opts.mapIceServers ? opts.mapIceServers(servers) : servers, ...(opts.relayOnly ? { iceTransportPolicy: 'relay' } : {}) });
        dc = pc.createDataChannel('tunnel', { ordered: true });
        dc.binaryType = 'arraybuffer';
        pc.onicecandidate = e => {
          if (!e.candidate || done) return;
          const m = { t: 'signal', data: { candidate: { candidate: String(e.candidate.candidate).replace(/^a=/, ''), sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } } };
          // Native gathering can run before createOffer() resolves. The home
          // needs the offer to create its peer before it can take candidates.
          if (offerSent) send(m); else localCandidates.push(m);
        };
        pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') finish(fail('failed', 'no network path to your computer')); };
        dc.onopen = () => {
          status('securing');
          mux = new P.Mux(dc, onFrame);
          dc.onmessage = e => mux.receive(e.data);
          mux.send(T.CTRL, 0, { t: 'hello', v: P.VERSION, nonce: phoneNonce });
        };
        dc.onclose = () => finish(fail('failed', 'the connection closed while starting'));
        try {
          const offer = await pc.createOffer();
          if (done) return;
          await pc.setLocalDescription(offer);
          if (done) return;
          send({ t: 'signal', data: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } } });
          offerSent = true;
          for (const m of localCandidates.splice(0)) send(m);
        } catch (e) { finish(fail('failed', e.message)); }
      }

      async function onFrame(type, stream, bytes) {
        if (type !== T.CTRL || stream !== 0) return;
        let m;
        try { m = P.json(bytes); } catch { return; }
        try {
          if (m.t === 'hello') {
            const key = P.unb64u(m.key || '');
            if ((await P.homeIdOf(key)) !== opts.homeId) return finish(fail('forged', 'the computer that answered is not the one you paired with'));
            homeHello = { key: await P.importPublic(key), nonce: String(m.nonce || ''), name: String(m.name || '').slice(0, 60) };
          } else if (m.t === 'proof') proof = m;
          else if (m.t === 'welcome') {
            const tunnel = new Tunnel(pc, dc, mux, { homeId: opts.homeId, home: m.home || { name: homeHello && homeHello.name }, user: m.user || null, device: m.device || null });
            mux.onMessage = (t, s, b) => tunnel._frame(t, s, b);
            return finish(null, tunnel);
          } else if (m.t === 'refused') return finish(fail('refused', m.message || 'your computer refused this phone', { why: m.why || 'refused' }));
          if (homeHello && proof && !proof.used) {
            proof.used = true;
            const tr = P.transcript({ homeId: opts.homeId, homeFp: P.fingerprint(pc.remoteDescription && pc.remoteDescription.sdp), phoneFp: P.fingerprint(pc.localDescription && pc.localDescription.sdp), homeNonce: homeHello.nonce, phoneNonce });
            if (!(await P.verify(homeHello.key, P.unb64u(proof.sig || ''), tr))) return finish(fail('forged', 'the connection could not be proven to reach your computer'));
            const sig = P.b64u(await P.sign(opts.device.privateKey, tr));
            const auth = { t: 'auth', sig, name: opts.name || '' };
            if (opts.pairing) Object.assign(auth, { pair: opts.pairing.id, key: P.b64u(opts.device.spki), mac: P.b64u(await P.hmac(P.unb64u(opts.pairing.secret), tr)) });
            else auth.device = opts.device.id;
            mux.send(T.CTRL, 0, auth);
          }
        } catch (e) { finish(fail('failed', e.message)); }
      }
    });
  }

  /* The tunnel once it stands. Requests: request(). WebSockets: socket().
     Lost when the channel closes, the connection fails, or pings go
     unanswered: every open stream then errors, and onLost callbacks run. */
  class Tunnel {
    constructor(pc, dc, mux, info) {
      Object.assign(this, info);
      this.pc = pc; this.dc = dc; this.mux = mux;
      this.next = 1;
      this.streams = new Map();
      this.lostHooks = new Set();
      this.lost = false;
      this.rtt = null;
      this.lastPong = Date.now();
      this.pings = new Map();
      dc.onclose = () => this._lose('the connection closed');
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'failed' || s === 'closed') this._lose('the connection failed');
        else if (s === 'disconnected') { clearTimeout(this.dropTimer); this.dropTimer = setTimeout(() => { if (pc.connectionState !== 'connected') this._lose('the connection dropped'); }, 8000); }
        else if (s === 'connected') clearTimeout(this.dropTimer);
      };
      this.beat = setInterval(() => {
        if (Date.now() - this.lastPong > 25000) return this._lose('your computer stopped answering');
        this.ping().catch(() => {});
        this._tellPath();
      }, 10000);
      // The computer shows how each phone is connected; it asks nobody, the
      // phone's own statistics say it.
      for (const ms of [300, 1500, 4000]) { const t = setTimeout(() => this._tellPath(), ms); if (t.unref) t.unref(); }
      if (this.beat.unref) this.beat.unref();
    }
    onLost(fn) { this.lostHooks.add(fn); if (this.lost) fn(this.lostWhy); return () => this.lostHooks.delete(fn); }
    _lose(why) {
      if (this.lost) return;
      this.lost = true; this.lostWhy = why;
      clearInterval(this.beat); clearTimeout(this.dropTimer);
      for (const [, s] of this.streams) { try { s.error(new Error(why)); } catch {} }
      this.streams.clear();
      for (const [, p] of this.pings) p.reject(new Error(why));
      this.pings.clear();
      this.mux.close();
      try { this.dc.close(); } catch {}
      try { this.pc.close(); } catch {}
      for (const fn of [...this.lostHooks]) { try { fn(why); } catch {} }
    }
    close() { this._lose('closed'); }
    // Round trip to the home, in milliseconds. Rejects after timeoutMs.
    ping(timeoutMs = 20000) {
      if (this.lost) return Promise.reject(new Error(this.lostWhy));
      const n = P.b64u(P.random(6));
      return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const timer = setTimeout(() => { this.pings.delete(n); reject(new Error('no answer')); }, timeoutMs);
        this.pings.set(n, { resolve: () => { clearTimeout(timer); resolve(this.rtt = Date.now() - t0); }, reject: e => { clearTimeout(timer); reject(e); } });
        this.mux.send(T.CTRL, 0, { t: 'ping', n });
      });
    }
    // Direct between the two devices, or through the relay's TURN server?
    async path() {
      try { return P.pathFromStats(await this.pc.getStats()); } catch { return null; }
    }
    async _tellPath() {
      const p = await this.path();
      if (p && p !== this.toldPath && !this.lost) { this.toldPath = p; this.mux.send(T.CTRL, 0, { t: 'path', path: p }); }
    }
    _open(kind, handlers) {
      if (this.lost) throw new Error(this.lostWhy);
      const id = this.next; this.next += 2;
      const s = { id, kind, ...handlers };
      this.streams.set(id, s);
      return s;
    }
    _end(id) { this.streams.delete(id); this.mux.drop(id); }
    /* request({ method, path, headers, body }, { onHead({status, headers}),
       onChunk(bytes), onEnd(), onError(err) }) → { cancel(), consumed(n) }.
       consumed(n) tells the home n bytes of the body were taken, so it may
       send more (the window, protocol.WINDOW). */
    request(req, h) {
      const s = this._open('http', { head: h.onHead, chunk: h.onChunk, end: h.onEnd, error: h.onError || (() => {}) });
      const body = req.body ? P.toBytes(req.body) : null;
      this.mux.send(T.REQ, s.id, { m: req.method || 'GET', p: req.path, h: req.headers || {}, b: !!(body && body.length), r: req.redirect === 'follow' ? 'follow' : undefined });
      if (body && body.length) {
        for (let at = 0; at < body.length; at += 256 * 1024) this.mux.send(T.REQ_BODY, s.id, body.subarray(at, at + 256 * 1024));
        this.mux.send(T.REQ_END, s.id, null);
      }
      let owed = 0;
      return {
        cancel: () => { if (this.streams.has(s.id)) { this.mux.send(T.ABORT, s.id, { why: 'cancelled' }); this._end(s.id); } },
        consumed: n => {
          owed += n;
          if (owed >= 64 * 1024 && this.streams.has(s.id)) { this.mux.send(T.CREDIT, s.id, P.u32(owed)); owed = 0; }
        },
      };
    }
    /* socket(path, protocols, { onOpen(protocol), onText(s), onBinary(bytes),
       onClose(code, reason) }) → { sendText, sendBinary, close }. */
    socket(path, protocols, h) {
      const s = this._open('ws', { open: h.onOpen, text: h.onText, binary: h.onBinary, close: h.onClose, error: e => h.onClose && h.onClose(1006, e.message) });
      this.mux.send(T.WS_OPEN, s.id, { p: path, protocols: protocols || [] });
      return {
        sendText: t => { if (this.streams.has(s.id)) this.mux.send(T.WS_TEXT, s.id, String(t)); },
        sendBinary: b => { if (this.streams.has(s.id)) this.mux.send(T.WS_BINARY, s.id, P.toBytes(b)); },
        close: (code = 1000, reason = '') => { if (this.streams.has(s.id)) { this.mux.send(T.WS_CLOSE, s.id, { code, reason }); this._end(s.id); } },
      };
    }
    _frame(type, id, bytes) {
      if (id === 0) {
        let m; try { m = P.json(bytes); } catch { return; }
        if (m.t === 'pong') { this.lastPong = Date.now(); const p = this.pings.get(m.n); if (p) { this.pings.delete(m.n); p.resolve(); } }
        else if (m.t === 'ping') this.mux.send(T.CTRL, 0, { t: 'pong', n: m.n });
        else if (m.t === 'bye') this._lose(m.message || 'your computer closed the connection');
        return;
      }
      this.lastPong = Date.now(); // any traffic proves the home is there
      const s = this.streams.get(id);
      if (!s) return;
      try {
        if (type === T.RES) { const m = P.json(bytes); s.head && s.head({ status: m.s, headers: m.h || {} }); }
        else if (type === T.RES_BODY) s.chunk && s.chunk(bytes);
        else if (type === T.RES_END) { this._end(id); s.end && s.end(); }
        else if (type === T.ABORT) { this._end(id); const m = P.json(bytes); s.error(new Error(m.why || 'aborted')); }
        else if (type === T.WS_OPENED) s.open && s.open(P.json(bytes).protocol || '');
        else if (type === T.WS_TEXT) s.text && s.text(P.text(bytes));
        else if (type === T.WS_BINARY) s.binary && s.binary(bytes);
        else if (type === T.WS_CLOSE) { this._end(id); const m = P.json(bytes); s.close && s.close(m.code || 1000, m.reason || ''); }
      } catch (e) { try { s.error(e); } catch {} }
    }
  }

  return { connect, Tunnel };
});
