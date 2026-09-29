/* Chattering Anywhere, inside the app's frame (design/85). The service
   worker puts this first in every page of the app it carries.

   Requests (fetch, pictures, scripts) already reach the home through the
   service worker. Two things cannot: WebSockets (a service worker never
   sees them) and long event streams (a service worker may be stopped while
   one is open). Both are replaced here by versions that talk to the shell
   (the page around this frame) directly, which carries them through the
   tunnel. Addresses on other sites keep the browser's own.

   Also: the app's own service worker is not installed on this site (the
   shell's is the one that must answer), and the app's address and title
   are shown by the shell, so a reload or the home-screen icon comes back
   to the same place. */
(function () {
  'use strict';
  if (window.__anywhereInside) return;
  window.__anywhereInside = true;
  let host = null;
  try { host = window.top && window.top !== window && window.top.__anywhere; } catch {}
  if (!host) return;
  const here = location.origin;
  const sameSite = u => { try { const x = new URL(u, location.href); return x.host === location.host; } catch { return false; } };
  // Bytes made in this frame's own world, so instanceof works for the app.
  const own = b => { const c = new Uint8Array(b.length); c.set(b); return c; };

  /* ---- the app's service worker: not here ---- */
  try {
    if (navigator.serviceWorker) {
      const quiet = { scope: here + '/', active: null, installing: null, waiting: null, update: async () => {}, unregister: async () => true, addEventListener() {}, removeEventListener() {} };
      Object.defineProperty(navigator.serviceWorker, 'register', { value: async () => quiet, configurable: true });
    }
  } catch {}

  /* ---- WebSocket ---- */
  const NativeWebSocket = window.WebSocket;
  class TunnelSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      const u = new URL(url, location.href);
      this.url = u.href;
      this.protocol = '';
      this.extensions = '';
      this.readyState = 0;
      this.bufferedAmount = 0;
      this._binaryType = 'blob';
      this.onopen = this.onmessage = this.onerror = this.onclose = null;
      const list = protocols == null ? [] : Array.isArray(protocols) ? protocols.map(String) : [String(protocols)];
      this._chain = Promise.resolve();
      this._link = host.openSocket(u.pathname + u.search, list, {
        onOpen: protocol => { if (this.readyState !== 0) return; this.readyState = 1; this.protocol = protocol || ''; this._fire(new Event('open')); },
        onText: text => { if (this.readyState === 1) this._fire(new MessageEvent('message', { data: String(text), origin: here })); },
        onBinary: bytes => {
          if (this.readyState !== 1) return;
          const b = own(bytes);
          this._fire(new MessageEvent('message', { data: this._binaryType === 'arraybuffer' ? b.buffer : new Blob([b]), origin: here }));
        },
        onClose: (code, reason) => {
          if (this.readyState === 3) return;
          const failed = this.readyState === 0 || code === 1006;
          this.readyState = 3;
          if (failed) this._fire(new Event('error'));
          this._fire(new CloseEvent('close', { code: code || 1006, reason: reason || '', wasClean: !failed }));
        },
      });
    }
    get binaryType() { return this._binaryType; }
    set binaryType(v) { if (v === 'blob' || v === 'arraybuffer') this._binaryType = v; }
    _fire(ev) {
      const h = this['on' + ev.type];
      if (typeof h === 'function') { try { h.call(this, ev); } catch (e) { setTimeout(() => { throw e; }); } }
      this.dispatchEvent(ev);
    }
    send(data) {
      if (this.readyState === 0) throw new DOMException("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
      if (this.readyState !== 1) return;
      // Blobs are read before sending: keep every message in its order.
      this._chain = this._chain.then(async () => {
        if (typeof data === 'string') return this._link.sendText(data);
        if (data instanceof Blob) return this._link.sendBinary(new Uint8Array(await data.arrayBuffer()));
        if (data instanceof ArrayBuffer || (data && data.constructor && data.constructor.name === 'ArrayBuffer')) return this._link.sendBinary(new Uint8Array(data));
        if (ArrayBuffer.isView(data)) return this._link.sendBinary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
        return this._link.sendText(String(data));
      }).catch(() => {});
    }
    close(code = 1000, reason = '') {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      this._chain.then(() => {
        this._link.close(code, reason);
        this.readyState = 3;
        this._fire(new CloseEvent('close', { code, reason, wasClean: true }));
      });
    }
  }
  for (const [k, v] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) { TunnelSocket[k] = v; TunnelSocket.prototype[k] = v; }
  function WebSocketShim(url, protocols) {
    if (!new.target) throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator.");
    let u;
    try { u = new URL(url, location.href); } catch { throw new DOMException("Failed to construct 'WebSocket': The URL '" + url + "' is invalid.", 'SyntaxError'); }
    if (u.host !== location.host) return new NativeWebSocket(url, protocols);
    return new TunnelSocket(url, protocols);
  }
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) WebSocketShim[k] = TunnelSocket[k];
  WebSocketShim.prototype = TunnelSocket.prototype;
  window.WebSocket = WebSocketShim;

  /* ---- EventSource ---- */
  const NativeEventSource = window.EventSource;
  class TunnelEventSource extends EventTarget {
    constructor(url, init) {
      super();
      this.url = new URL(url, location.href).href;
      this.withCredentials = !!(init && init.withCredentials);
      this.readyState = 0;
      this.onopen = this.onmessage = this.onerror = null;
      this._retry = 3000;
      this._last = '';
      this._connect();
    }
    _fire(ev) {
      const h = this['on' + ev.type];
      if (typeof h === 'function') { try { h.call(this, ev); } catch (e) { setTimeout(() => { throw e; }); } }
      this.dispatchEvent(ev);
    }
    _connect() {
      if (this.readyState === 2) return;
      this.readyState = 0;
      const dec = new TextDecoder();
      let buf = '', data = [], type = '', id = null;
      const headers = { accept: 'text/event-stream', 'cache-control': 'no-store' };
      if (this._last) headers['last-event-id'] = this._last;
      const dispatch = () => {
        if (id !== null) this._last = id;
        if (!data.length) { type = ''; return; }
        const ev = new MessageEvent(type || 'message', { data: data.join('\n'), lastEventId: this._last, origin: here });
        data = []; type = '';
        if (this.readyState === 1) this._fire(ev);
      };
      const line = l => {
        if (l === '') return dispatch();
        if (l[0] === ':') return;
        const at = l.indexOf(':');
        const field = at < 0 ? l : l.slice(0, at);
        let value = at < 0 ? '' : l.slice(at + 1);
        if (value[0] === ' ') value = value.slice(1);
        if (field === 'data') data.push(value);
        else if (field === 'event') type = value;
        else if (field === 'id') { if (!value.includes('\0')) id = value; }
        else if (field === 'retry') { const n = Number(value); if (/^\d+$/.test(value)) this._retry = n; }
      };
      this._stream = host.openStream(new URL(this.url).pathname + new URL(this.url).search, headers, {
        onHead: head => {
          if (this.readyState === 2) return;
          if (head.status !== 200 || !/^text\/event-stream/i.test(head.headers['content-type'] || '')) {
            this.readyState = 2; this._stream && this._stream.cancel(); this._fire(new Event('error')); return;
          }
          this.readyState = 1; this._fire(new Event('open'));
        },
        onChunk: bytes => {
          buf += dec.decode(bytes, { stream: true });
          let i;
          while ((i = buf.search(/\r\n|\r|\n/)) >= 0) {
            const l = buf.slice(0, i);
            buf = buf.slice(i + (buf[i] === '\r' && buf[i + 1] === '\n' ? 2 : 1));
            line(l);
          }
        },
        onEnd: () => this._drop(),
        onError: () => this._drop(),
      });
    }
    _drop() {
      if (this.readyState === 2) return;
      this.readyState = 0;
      this._fire(new Event('error'));
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._connect(), this._retry);
    }
    close() {
      this.readyState = 2;
      clearTimeout(this._timer);
      try { this._stream && this._stream.cancel(); } catch {}
    }
  }
  TunnelEventSource.CONNECTING = TunnelEventSource.prototype.CONNECTING = 0;
  TunnelEventSource.OPEN = TunnelEventSource.prototype.OPEN = 1;
  TunnelEventSource.CLOSED = TunnelEventSource.prototype.CLOSED = 2;
  function EventSourceShim(url, init) {
    if (!new.target) throw new TypeError("Failed to construct 'EventSource': Please use the 'new' operator.");
    if (!sameSite(url)) return new NativeEventSource(url, init);
    return new TunnelEventSource(url, init);
  }
  EventSourceShim.CONNECTING = 0; EventSourceShim.OPEN = 1; EventSourceShim.CLOSED = 2;
  EventSourceShim.prototype = TunnelEventSource.prototype;
  window.EventSource = EventSourceShim;

  /* ---- where the app is: the shell shows it ---- */
  if (window.parent === window.top) {
    const tell = () => { try { host.navigated(location.pathname + location.search + location.hash, document.title); } catch {} };
    for (const k of ['pushState', 'replaceState']) {
      const orig = history[k];
      history[k] = function () { const r = orig.apply(this, arguments); tell(); return r; };
    }
    addEventListener('popstate', tell);
    addEventListener('hashchange', tell);
    const watchTitle = () => {
      tell();
      const t = document.querySelector('title');
      if (t) new MutationObserver(tell).observe(t, { childList: true, characterData: true, subtree: true });
      const m = document.querySelector('meta[name="theme-color"]');
      const color = () => { try { host.themeColor(m ? m.content : getComputedStyle(document.body).backgroundColor); } catch {} };
      if (m) new MutationObserver(color).observe(m, { attributes: true });
      color();
    };
    if (document.readyState === 'loading') addEventListener('DOMContentLoaded', watchTitle); else watchTitle();
  }
})();
