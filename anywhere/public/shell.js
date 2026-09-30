/* Chattering Anywhere, the phone's page (design/85).

   Pairs this phone with a computer (the code shown in Chattering's
   settings), connects to it through the relay, and runs Chattering from it
   in a frame. Everything the frame asks for comes here (from the service
   worker, or from inside.js for live connections) and goes through the
   encrypted tunnel.

   Kept on this phone (IndexedDB, this site only): per paired computer, its
   id and name, and this phone's key for it — a key the browser created and
   will not let any script read out. Nothing else. */
(function () {
  'use strict';
  const P = window.AnywhereProtocol, C = window.AnywhereClient;
  const RELAY = location.origin;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  // Inside the Android app (it carries this page itself, design/86), or in
  // an Android browser that could have it.
  const APP = !!window.ChatteringApp;
  const ANDROID_WEB = !APP && /Android/.test(navigator.userAgent);
  const APK_URL = 'https://github.com/MaximeRivest/chattering/releases/download/android/Chattering-android.apk';
  const getApp = ANDROID_WEB ? `<p class="hint app-offer">On Android, the Chattering app does this more safely: <a href="${APK_URL}">get the app</a>, then scan the same code.</p>` : '';
  // "Use the Android app": an intent URL that opens the app with this code
  // when it is installed (the app's package, whatever handles links), and
  // downloads it when it is not. The code rides in the path (an intent URL
  // has no room for a # of its own); it goes from Chrome to the app on this
  // phone, never to a server.
  // (Its own scheme: Chrome hands an intent URL to an app for a scheme of
  // its own, not for https.)
  const appIntent = code => `intent://pair/${[code.homeId, code.id, code.secret].join('.')}?${code.name ? 'n=' + encodeURIComponent(code.name) + '&' : ''}r=${encodeURIComponent(location.host)}` +
    `#Intent;scheme=chattering;package=app.rockfrog.chattering;S.browser_fallback_url=${encodeURIComponent(APK_URL)};end`;

  /* ---- storage ---- */
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('chattering-anywhere', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const kv = async (mode, fn) => { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction('kv', mode); const r = fn(tx.objectStore('kv')); tx.oncomplete = () => res(r && r.result); tx.onerror = () => rej(tx.error); }); };
  const kvGet = k => kv('readonly', s => s.get(k));
  const kvSet = (k, v) => kv('readwrite', s => s.put(v, k));

  let homes = [];          // [{ homeId, name, deviceId, key: { privateKey, spki }, user, pairedAt }]
  let active = null;       // homeId
  let tunnel = null;       // the live tunnel, or null
  let connecting = null;   // a connect() in flight
  let ctl = null;          // its AbortController
  let retryTimer = null, backoff = 0;
  let frame = null;        // the app's iframe
  const waiters = new Set();
  const homeOf = id => homes.find(h => h.homeId === id) || null;
  const saveHomes = () => kvSet('homes', homes.map(h => ({ ...h })));

  /* ---- screens ---- */
  const stage = $('stage');
  function show(html, cls = '') {
    stage.className = 'stage ' + cls;
    stage.hidden = false;
    $('card').innerHTML = html;
    document.body.classList.remove('app-open');
  }
  const mark = '<div class="mark" aria-hidden="true"></div>';
  const link = (label, id, primary) => `<button type="button" class="${primary ? 'primary' : 'ghost'}" id="${id}">${label}</button>`;
  const PRIVACY = `<details class="about"><summary>How private is this?</summary>
    <p>Your phone and your computer talk to each other directly, encrypted from end to end. When they cannot reach each other directly, the relay passes the encrypted data along without being able to read it.</p>
    <p>The relay keeps no record of what passes through it. It cannot see your conversations, your files or your keys. It only sees that a phone and a computer are connecting, from which internet addresses, and how much data they exchange.</p>
    <p>This phone keeps one key per computer. The browser created that key and will not let any script read it out, and nothing else is stored here.</p></details>`;

  // The first screen: how to add this device. In the app, the scanner and a
  // code the browser left on the clipboard; anywhere, a box to paste a link.
  const DESKTOP = !APP && !IOS && !/Android/.test(navigator.userAgent);
  function showWelcome() {
    const how = APP
      ? `<button type="button" class="primary big" id="scanCode">Scan the pairing code</button>
         <div id="clipOffer"></div>
         <p class="hint">On your computer: Chattering → <b>Settings → Machines → Add a device</b> shows the code.</p>`
      : DESKTOP
        ? `<ol class="how"><li>On the computer running Chattering: <b>Settings → Machines → Add a device</b>.</li><li>Press <b>Use this browser</b> there if you are looking at it from here, or copy its link.</li><li>Paste the link below.</li></ol>`
        : `<ol class="how"><li>On your computer, open Chattering → <b>Settings → Machines</b>.</li><li>Press <b>Add a device</b>.</li><li>Scan the code with this device's camera.</li></ol>`;
    show(`${mark}<h1>Chattering, anywhere</h1>
      <p class="lead">Use Chattering on this ${DESKTOP ? 'computer' : 'device'}, from anywhere, straight from your own computer.</p>
      ${how}
      ${homes.length ? `<div class="homes">${homes.map(h => `<button type="button" class="home" data-home="${esc(h.homeId)}"><span class="dot"></span>${esc(h.name)}</button>`).join('')}</div>` : ''}
      <form class="paste" id="pasteForm"><label for="pasteLink">${APP ? 'or paste the link shown under the code' : 'paste the link'}</label><div class="row"><input id="pasteLink" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://…#pair=…"><button type="submit" class="${DESKTOP ? 'primary' : ''}">Pair</button></div></form>
      ${APP ? `<button type="button" class="ghost small" id="useServer">Use a server address instead (Tailscale, home network)</button>` : getApp}
      ${PRIVACY}`, 'welcome');
    stage.dataset.screen = 'welcome';
    bindHomes();
    const form = $('pasteForm');
    if (form) form.onsubmit = e => {
      e.preventDefault();
      const v = $('pasteLink').value.trim();
      let u = null;
      try { u = new URL(v); } catch {}
      const code = u && (u.protocol === 'https:' || u.origin === location.origin) && P.readPairingLink(u.hash);
      if (!code) { $('pasteLink').setCustomValidity('This is not a pairing link.'); $('pasteLink').reportValidity(); return; }
      if (APP) return window.ChatteringApp.openLink(u.href);
      if (u.origin !== location.origin) { location.href = u.href; return; }
      history.replaceState(null, '', '/');
      if (ANDROID_WEB) androidChoice(code); else pair(code);
    };
    const pl = $('pasteLink'); if (pl) pl.oninput = () => pl.setCustomValidity('');
    const us = $('useServer'); if (us) us.onclick = () => window.ChatteringApp.useServerAddress();
    const sc = $('scanCode'); if (sc) sc.onclick = () => window.ChatteringApp.scanCode();
    checkClipboard();
  }
  // A code the browser copied before the app was installed: offered here.
  function checkClipboard() {
    const box = $('clipOffer');
    if (!APP || !box || !window.ChatteringApp.clipboardPairingLink) return;
    let link = '';
    try { link = window.ChatteringApp.clipboardPairingLink() || ''; } catch {}
    let code = null;
    try { code = link && P.readPairingLink(new URL(link).hash); } catch {}
    if (!code || (homeOf(code.homeId) && homeOf(code.homeId).deviceId)) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="clip-offer"><p>Pair with <b>${esc(code.name || 'your computer')}</b>? You copied its code a moment ago.</p>
      <div class="row"><button type="button" class="primary" id="clipPair">Pair</button><button type="button" class="ghost" id="clipNo">Not now</button></div></div>`;
    $('clipPair').onclick = () => { try { window.ChatteringApp.clearClipboardLink(); } catch {} window.ChatteringApp.openLink(link); };
    $('clipNo').onclick = () => { try { window.ChatteringApp.clearClipboardLink(); } catch {} box.innerHTML = ''; };
  }
  // The app came to the front (the clipboard is readable only then).
  window.anywhereAppFocus = () => { if (stage.dataset.screen === 'welcome' && !stage.hidden) checkClipboard(); };

  const STEPS = [['relay', 'Finding'], ['connecting', 'Connecting'], ['securing', 'Securing'], ['ready', 'Ready']];
  function showConnecting(name, step, { pairing = false } = {}) {
    const idx = Math.max(0, STEPS.findIndex(s => s[0] === step));
    const html = `<div class="link-art ${esc(step)}" aria-hidden="true"><span class="node phone"></span><span class="wire"><i></i><i></i><i></i></span><span class="node computer"></span><span class="lock"></span></div>
      <h1>${pairing ? 'Pairing with' : 'Connecting to'} <b>${esc(name || 'your computer')}</b></h1>
      <ol class="steps">${STEPS.map(([k, label], i) => `<li class="${i < idx ? 'done' : i === idx ? 'now' : ''}">${label}${k === 'relay' ? ' ' + esc(name || 'it') : ''}</li>`).join('')}</ol>
      ${homes.length > 1 && !pairing ? `<button type="button" class="ghost small" id="switchHome">Another computer…</button>` : ''}`;
    if (stage.dataset.screen === 'connecting' && !stage.hidden && !document.body.classList.contains('app-open')) {
      $('card').innerHTML = html;
    } else show(html, 'connecting');
    stage.dataset.screen = 'connecting';
    const sw = $('switchHome'); if (sw) sw.onclick = openSheet;
  }
  function showWaiting(home) {
    if (frame) return pill(`Waiting for <b>${esc(home.name)}</b> to come online…`, 'wait');
    show(`<div class="link-art waiting" aria-hidden="true"><span class="node phone"></span><span class="wire"><i></i><i></i><i></i></span><span class="node computer asleep"></span></div>
      <h1><b>${esc(home.name)}</b> is not online</h1>
      <p class="lead">It may be asleep, turned off, or without internet. This page connects by itself the moment it is back.</p>
      ${homes.length > 1 ? link('Another computer…', 'switchHome') : ''}`, 'waiting');
    stage.dataset.screen = 'waiting';
    const sw = $('switchHome'); if (sw) sw.onclick = openSheet;
  }
  function showProblem(title, text, actions = [], cls = 'problem') {
    stage.dataset.screen = 'problem';
    show(`${mark}<h1>${title}</h1><p class="lead">${text}</p><div class="actions">${actions.map(a => link(a[0], a[1], a[2])).join('')}</div>`, cls);
    for (const a of actions) { const b = $(a[1]); if (b) b.onclick = a[3]; }
  }

  let pillTimer = null;
  function pill(html, kind = '', ms = 0) {
    const p = $('pill');
    p.innerHTML = '<span class="pill-text">' + html + '</span>';
    p.className = 'pill show ' + kind;
    p.hidden = false;
    clearTimeout(pillTimer);
    if (ms) pillTimer = setTimeout(hidePill, ms);
  }
  function hidePill() { const p = $('pill'); p.classList.remove('show'); clearTimeout(pillTimer); pillTimer = setTimeout(() => { p.hidden = true; }, 400); }

  /* ---- the computers on this phone ---- */
  function openSheet() {
    const s = $('sheet');
    s.innerHTML = `<div class="sheet-card" role="dialog" aria-label="Your computers">
      <h2>Your computers</h2>
      <div class="homes">${homes.map(h => `<div class="home-row"><button type="button" class="home${h.homeId === active ? ' on' : ''}" data-home="${esc(h.homeId)}"><span class="dot"></span>${esc(h.name)}${h.user && h.user.name ? `<small>as ${esc(h.user.name)}</small>` : ''}</button><button type="button" class="ghost small" data-forget="${esc(h.homeId)}" title="Forget it on this phone">Forget</button></div>`).join('')}</div>
      <p class="hint">To add a computer, press <b>Add a device</b> in its Chattering (Settings → Machines) and scan the code.</p>
      ${PRIVACY}
      <button type="button" class="ghost" id="sheetClose">Close</button></div>`;
    s.hidden = false;
    requestAnimationFrame(() => s.classList.add('show'));
    $('sheetClose').onclick = closeSheet;
    s.onclick = e => { if (e.target === s) closeSheet(); };
    bindHomes();
    s.querySelectorAll('[data-forget]').forEach(b => b.onclick = async () => {
      const h = homeOf(b.dataset.forget);
      if (!h || !confirm(`Forget ${h.name} on this phone? To use it again you will scan a new code.`)) return;
      homes = homes.filter(x => x !== h);
      await saveHomes();
      if (active === h.homeId) { closeSheet(); switchTo(homes[0] ? homes[0].homeId : null); }
      else openSheet();
    });
  }
  function closeSheet() { const s = $('sheet'); s.classList.remove('show'); s.style.pointerEvents = 'none'; setTimeout(() => { s.hidden = true; s.style.pointerEvents = ''; }, 250); }
  function bindHomes() {
    document.querySelectorAll('[data-home]').forEach(b => b.onclick = () => { closeSheet(); switchTo(b.dataset.home); });
  }
  async function switchTo(homeId) {
    if (homeId === active && (tunnel || connecting)) return;
    drop();
    active = homeId;
    await kvSet('active', active);
    if (frame) { frame.remove(); frame = null; }
    if (!active) return showWelcome();
    const h = homeOf(active);
    history.replaceState(null, '', '/');
    connect(h);
  }
  function drop() {
    clearTimeout(retryTimer); retryTimer = null;
    if (ctl) ctl.abort();
    if (tunnel) { const t = tunnel; tunnel = null; t.close(); }
  }

  /* ---- connecting ---- */
  async function connect(home) {
    if (connecting) return connecting;
    clearTimeout(retryTimer); retryTimer = null;
    ctl = new AbortController();
    if (!frame) showConnecting(home.name, 'relay');
    else pill(`Reconnecting to <b>${esc(home.name)}</b>…`, 'wait');
    connecting = C.connect({
      relay: RELAY, homeId: home.homeId, name: P.deviceLabel(navigator.userAgent), signal: ctl.signal,
      device: { id: home.deviceId, privateKey: home.key.privateKey, spki: home.key.spki },
      onStatus: s => { if (s === 'waiting') showWaiting(home); else if (!frame) showConnecting(home.name, s); },
    }).then(t => { adopt(t, home); return t; }, e => { failed(e, home); return null; })
      .finally(() => { connecting = null; ctl = null; });
    return connecting;
  }
  function failed(e, home) {
    if (e.code === 'aborted' || home.homeId !== active) return;
    if (e.code === 'refused' && (e.why === 'removed' || e.why === 'unknown')) {
      homes = homes.filter(h => h !== home);
      saveHomes();
      if (frame) { frame.remove(); frame = null; }
      hidePill();
      return showProblem(`This phone was removed from <b>${esc(home.name)}</b>`, 'To use it again, press <b>Add a device</b> in Chattering on that computer (Settings → Machines) and scan the new code.', homes.length ? [['Your other computers', 'others', true, openSheet]] : []);
    }
    if (e.code === 'refused' && e.why === 'bad-signature') {
      if (frame) { frame.remove(); frame = null; }
      hidePill();
      return showProblem(`<b>${esc(home.name)}</b> did not recognise this phone`, 'Its key on this phone no longer matches. Forget the computer here, then press <b>Add a device</b> on it and scan the new code.', [['Your computers', 'others', true, openSheet]], 'problem');
    }
    if (e.code === 'forged') {
      if (frame) { frame.remove(); frame = null; }
      hidePill();
      return showProblem('This connection could not be verified', `Something between this phone and <b>${esc(home.name)}</b> did not prove to be your computer, so nothing was sent. This can happen on a network that tampers with connections. Try again on another network.`, [['Try again', 'retry', true, () => connect(home)]], 'problem danger');
    }
    // Anything else passes: no internet, the relay restarting, no path yet.
    const why = e.code === 'relay' ? (navigator.onLine === false ? 'This phone is offline.' : 'The relay cannot be reached right now.') : e.code === 'refused' ? esc(e.message) : 'No network path to your computer yet.';
    if (frame) pill(`${why} Retrying…`, 'wait');
    else showProblem(`Cannot reach <b>${esc(home.name)}</b> yet`, `${why} This page keeps trying by itself.`, [['Try now', 'retry', true, () => connect(home)]].concat(homes.length > 1 ? [['Another computer…', 'others', false, openSheet]] : []));
    later(home);
  }
  function later(home) {
    if (document.hidden) return; // tried again when the phone shows the page
    backoff = Math.min(backoff ? backoff * 2 : 1000, 15000);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (active === home.homeId && !tunnel) connect(home); }, backoff);
  }
  function adopt(t, home) {
    if (home.homeId !== active) { t.close(); return; }
    tunnel = t;
    backoff = 0;
    let dirty = false;
    if (t.home && t.home.name && t.home.name !== home.name) { home.name = t.home.name; dirty = true; }
    if (t.user && (!home.user || home.user.name !== t.user.name)) { home.user = t.user; dirty = true; }
    if (dirty) saveHomes();
    t.onLost(why => {
      if (tunnel !== t) return;
      tunnel = null;
      if (/removed|turned off/.test(why)) return failed(Object.assign(new Error(why), { code: 'refused', why: /removed/.test(why) ? 'removed' : 'off' }), home);
      if (!document.hidden) connect(home);
    });
    for (const w of [...waiters]) w(t);
    waiters.clear();
    const first = !frame;
    if (first) openApp();
    t.path().then(p => {
      const how = p === 'relay' ? 'through the relay (encrypted)' : p === 'direct' ? 'directly' : '';
      pill(`Connected to <b>${esc(home.name)}</b>${how ? ' · ' + how : ''}${homes.length > 1 ? ' <button type="button" data-switch>switch</button>' : ''}`, 'ok', homes.length > 1 ? 5000 : 2600);
      const sw = document.querySelector('#pill [data-switch]'); if (sw) sw.onclick = () => { hidePill(); openSheet(); };
    });
  }
  // A request waits for the tunnel (a reconnection after the phone slept).
  function ready(ms = 45000) {
    if (tunnel) return Promise.resolve(tunnel);
    const h = homeOf(active);
    if (h && !connecting && !document.hidden) connect(h);
    return new Promise((res, rej) => {
      const w = t => { clearTimeout(timer); res(t); };
      const timer = setTimeout(() => { waiters.delete(w); rej(new Error('not connected to your computer')); }, ms);
      waiters.add(w);
    });
  }

  /* ---- the app ---- */
  function openApp() {
    frame = document.createElement('iframe');
    frame.id = 'app';
    frame.title = 'Chattering';
    frame.allow = 'microphone; camera; clipboard-read; clipboard-write; fullscreen; autoplay; screen-wake-lock; display-capture; web-share';
    frame.setAttribute('allowfullscreen', '');
    const where = location.pathname.startsWith('/_anywhere/') ? '/' : location.pathname + location.search + location.hash;
    frame.src = where || '/';
    frame.addEventListener('load', () => {
      document.body.classList.add('app-open');
      stage.hidden = true;
      stage.dataset.screen = '';
    }, { once: true });
    document.body.appendChild(frame);
  }

  // What the app's frame calls (inside.js): sockets and event streams.
  window.__anywhere = {
    openSocket(path, protocols, h) {
      let link = null, closed = false;
      const queue = [];
      ready().then(t => {
        if (closed) return;
        link = t.socket(path, protocols, h);
        for (const f of queue.splice(0)) f(link);
      }, e => h.onClose(1006, e.message));
      const act = f => (link ? f(link) : queue.push(f));
      return {
        sendText: s => act(l => l.sendText(s)),
        sendBinary: b => act(l => l.sendBinary(b)),
        close: (code, reason) => { closed = true; act(l => l.close(code, reason)); },
      };
    },
    openStream(path, headers, h) {
      let req = null, cancelled = false;
      ready().then(t => {
        if (cancelled) return;
        req = t.request({ method: 'GET', path, headers }, {
          onHead: h.onHead,
          onChunk: b => { req && req.consumed(b.length); h.onChunk(b); },
          onEnd: h.onEnd, onError: h.onError,
        });
      }, e => h.onError(e));
      return { cancel: () => { cancelled = true; if (req) req.cancel(); } };
    },
    navigated(path, title) {
      try { if (path && path !== location.pathname + location.search + location.hash) history.replaceState(null, '', path); } catch {}
      if (title) document.title = title;
    },
    themeColor(c) { const m = document.querySelector('meta[name="theme-color"]'); if (m && c) m.content = c; },
    homes: () => homes.map(h => ({ id: h.homeId, name: h.name, active: h.homeId === active })),
    switchTo, openSheet,
  };
  // Android's back key (the app asks the page first): a sheet closes, else
  // the app inside decides, else history moves.
  window.chatteringBack = () => {
    const sh = $('sheet');
    if (sh && !sh.hidden) { closeSheet(); return true; }
    try { const w = frame && frame.contentWindow; if (w && w.chatteringBack) return !!w.chatteringBack(); } catch {}
    return false;
  };

  /* ---- requests from the service worker ---- */
  const INSIDE = '<script src="/_anywhere/inside.js"></script>';
  const enc = new TextEncoder();
  function inject(html) {
    const m = /<head[^>]*>/i.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + INSIDE + html.slice(m.index + m[0].length);
    const d = /<!doctype[^>]*>/i.exec(html);
    return d ? html.slice(0, d.index + d[0].length) + INSIDE + html.slice(d.index + d[0].length) : INSIDE + html;
  }
  async function onFetch(m, port) {
    const post = (msg, transfer) => { try { port.postMessage(msg, transfer || []); } catch {} };
    let t;
    try { t = await ready(); } catch (e) { return post({ type: 'error', message: e.message }); }
    const headers = { ...(m.headers || {}) };
    const own = Object.keys(headers).some(k => k.toLowerCase() === 'if-none-match');
    const cacheable = m.method === 'GET' && !m.path.startsWith('/api/') && !Object.keys(headers).some(k => k.toLowerCase() === 'range');
    const cache = cacheable && self.caches ? await caches.open('anywhere-app-' + t.homeId).catch(() => null) : null;
    const url = new URL(m.path, location.origin).href;
    const cached = cache ? await cache.match(url).catch(() => null) : null;
    if (cached && !own && cached.headers.get('etag')) headers['if-none-match'] = cached.headers.get('etag');
    const page = m.dest === 'iframe' || m.dest === 'document' || m.dest === 'frame';
    let received = 0, credited = 0, skip = false, writer = null, keep = null, keepSize = 0, keepHeaders = null, html = null, done = false;
    const emit = bytes => {
      // The cache keeps the page as the computer sent it; the frame gets it
      // with inside.js in front.
      if (keep) { keep.push(bytes.slice()); keepSize += bytes.length; if (keepSize > 8 * 1024 * 1024) keep = null; }
      if (html) { html.push(bytes.slice()); return; }
      const c = bytes.slice();
      post({ type: 'chunk', bytes: c.buffer }, [c.buffer]);
    };
    const finish = () => {
      if (done) return;
      done = true;
      if (html) {
        const out = enc.encode(inject(new TextDecoder().decode(concat(html))));
        html = null;
        for (let at = 0; at < out.length; at += 256 * 1024) { const c = out.slice(at, at + 256 * 1024); post({ type: 'chunk', bytes: c.buffer }, [c.buffer]); }
      }
      post({ type: 'end' });
      if (keep && cache) cache.put(url, new Response(new Blob(keep), { status: 200, headers: keepHeaders })).catch(() => {});
    };
    const req = t.request({ method: m.method, path: m.path, headers, body: m.body ? new Uint8Array(m.body) : null, redirect: m.redirect }, {
      onHead: head => {
        if (head.status === 304 && cached && !own) {
          // Unchanged since the last time: the copy on this phone.
          skip = true;
          const h = {};
          cached.headers.forEach((v, k) => { h[k] = v; });
          cached.arrayBuffer().then(b => {
            const bytes = new Uint8Array(b);
            const isHtml = page && /text\/html/i.test(h['content-type'] || '');
            post({ type: 'head', status: 200, headers: h });
            const out = isHtml ? enc.encode(inject(new TextDecoder().decode(bytes))) : bytes;
            for (let at = 0; at < out.length; at += 256 * 1024) { const c = out.slice(at, at + 256 * 1024); post({ type: 'chunk', bytes: c.buffer }, [c.buffer]); }
            post({ type: 'end' });
          });
          return;
        }
        const h = { ...head.headers };
        const gz = /gzip/i.test(h['content-encoding'] || '');
        delete h['content-encoding']; delete h['content-length'];
        if (page && /text\/html/i.test(h['content-type'] || '')) html = [];
        if (cacheable && head.status === 200 && h.etag && !/no-store/i.test(h['cache-control'] || '')) { keep = []; keepHeaders = h; }
        post({ type: 'head', status: head.status, headers: h });
        if (gz && typeof DecompressionStream !== 'undefined') {
          const ds = new DecompressionStream('gzip');
          writer = ds.writable.getWriter();
          (async () => {
            const r = ds.readable.getReader();
            try { for (;;) { const { done: d, value } = await r.read(); if (d) break; emit(value); } finish(); }
            catch { post({ type: 'error', message: 'the answer arrived damaged' }); }
          })();
        }
      },
      onChunk: b => { received += b.length; if (skip) return; if (writer) writer.write(b.slice()).catch(() => {}); else emit(b); },
      onEnd: () => { if (skip) return; if (writer) writer.close().catch(() => {}); else finish(); },
      onError: e => { if (!skip) post({ type: 'error', message: e.message }); },
    });
    port.onmessage = ev => {
      const d = ev.data || {};
      if (d.type === 'pull') { const owe = received - credited; if (owe > 0) { credited += owe; req.consumed(owe); } }
      else if (d.type === 'cancel') req.cancel();
    };
  }
  function concat(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  /* ---- start ---- */
  async function worker() {
    if (!('serviceWorker' in navigator)) throw Object.assign(new Error('This browser cannot run Chattering here (no service workers). Chrome, Safari, Firefox and Edge can.'), { code: 'browser' });
    navigator.serviceWorker.addEventListener('message', ev => { const m = ev.data; if (m && m.type === 'anywhere-fetch') onFetch(m, ev.ports[0]); });
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    if (navigator.serviceWorker.controller) { sessionStorage.removeItem('anywhere-reloads'); return; }
    await new Promise(res => { navigator.serviceWorker.addEventListener('controllerchange', res, { once: true }); setTimeout(res, 5000); });
    if (navigator.serviceWorker.controller) return;
    // A hard reload bypasses the worker for this one page: once more, normally.
    const n = Number(sessionStorage.getItem('anywhere-reloads') || 0);
    if (n < 2) { sessionStorage.setItem('anywhere-reloads', String(n + 1)); location.reload(); return new Promise(() => {}); }
    throw Object.assign(new Error('The page could not start its connection helper. Close this tab and open Chattering again.'), { code: 'browser' });
  }

  // How the computer will list this phone. Chrome on Android hides the model
  // in its user agent ("Android 10; K"), so every Android phone read
  // "Android · Chrome"; it gives the model when asked (User-Agent Client Hints).
  async function deviceName() {
    const base = P.deviceLabel(navigator.userAgent);
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        const v = await navigator.userAgentData.getHighEntropyValues(['model']);
        const model = String(v.model || '').trim().slice(0, 30);
        if (model && /^Android · /.test(base)) return model + base.slice('Android'.length);
      }
    } catch {}
    return base;
  }

  async function pair(code) {
    const known = homeOf(code.homeId);
    showConnecting(code.name || (known && known.name), 'relay', { pairing: true });
    const pairKey = await P.subtle().generateKey(P.ECDSA, false, ['sign', 'verify']);
    const key = { privateKey: pairKey.privateKey, spki: new Uint8Array(await P.subtle().exportKey('spki', pairKey.publicKey)) };
    try {
      const t = await C.connect({
        relay: RELAY, homeId: code.homeId, name: await deviceName(),
        device: key, pairing: { id: code.id, secret: code.secret },
        onStatus: s => { if (s === 'waiting') showWaiting({ name: code.name || 'your computer' }); else showConnecting(code.name, s, { pairing: true }); },
      });
      const home = { homeId: code.homeId, name: (t.home && t.home.name) || code.name || 'Computer', deviceId: t.device, key, user: t.user || null, pairedAt: Date.now() };
      homes = homes.filter(h => h.homeId !== home.homeId).concat(home);
      await saveHomes();
      active = home.homeId;
      await kvSet('active', active);
      history.replaceState(null, '', '/');
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      await celebrate(home);
      adopt(t, home);
      installHint();
    } catch (e) {
      history.replaceState(null, '', '/');
      if (e.code === 'refused') return showProblem('This code does not work any more', 'Codes work once, for ten minutes. On your computer, press <b>Add a device</b> again and scan the new code.', homes.length ? [['Your computers', 'others', true, openSheet]] : []);
      if (e.code === 'forged') return showProblem('This connection could not be verified', 'Something between this phone and the computer that showed the code did not prove to be that computer, so nothing was sent. Try again on another network.', [], 'problem danger');
      showProblem('Pairing did not finish', esc(e.message) + '. Scan the code again, or show a new one.', []);
    }
  }
  function celebrate(home) {
    show(`<div class="link-art ready" aria-hidden="true"><span class="node phone"></span><span class="wire"><i></i><i></i><i></i></span><span class="node computer"></span><span class="lock"></span></div>
      <h1>Paired with <b>${esc(home.name)}</b></h1><p class="lead">${APP ? 'From now on, open this app and Chattering is here, wherever you are.' : 'From now on, open this page (or its icon) and Chattering is here, wherever you are.'}</p>`, 'paired');
    stage.dataset.screen = 'paired';
    return new Promise(r => setTimeout(r, 1400));
  }
  // Once: how to put Chattering on the home screen.
  let installEvent = null;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; });
  function installHint() {
    if (APP || standalone() || localStorage.getItem('anywhere-install-hint')) return;
    localStorage.setItem('anywhere-install-hint', '1');
    setTimeout(() => {
      if (installEvent) {
        pill('Put Chattering on your home screen? <button type="button" id="installNow">Install</button>', 'ok', 12000);
        const b = $('installNow'); if (b) b.onclick = () => { hidePill(); installEvent.prompt(); installEvent = null; };
      } else if (IOS) pill('Tip: tap <b>Share</b> → <b>Add to Home Screen</b> to keep Chattering one tap away.', 'ok', 9000);
    }, 3200);
  }
  // On Android in a browser: the app or here? The app is the better home
  // (it carries this page itself, has the microphone and notifications),
  // so it comes first; one button installs it or opens it.
  function androidChoice(code) {
    const name = esc(code.name || 'your computer');
    stage.dataset.screen = 'choice';
    show(`${mark}<h1>Pair with <b>${name}</b></h1>
      <p class="lead">Chattering works best on Android as an app.</p>
      <a class="primary big" id="useApp" href="${esc(appIntent(code))}">Use the Android app</a>
      <p class="hint steps-app">Not installed yet? This button downloads it (3 MB) and copies this code. Open the downloaded file and install it, then open the app: it offers to pair with ${name}. (Or come back here and tap the button again.)</p>
      <button type="button" class="ghost" id="inBrowser">Continue in the browser</button>
      <p class="hint">This code works for ten minutes, once.</p>`, 'choice');
    $('inBrowser').onclick = () => pair(code);
    // Back from installing: the page is still here, the button still works.
    $('useApp').onclick = () => {
      // The app, opened from the installer, finds the code here and offers it.
      // Copied at once, in step with the tap: the download dialog takes the
      // focus right after, and a page without focus may not write the
      // clipboard (the asynchronous way lost that race).
      const link = P.pairingLink(location.origin, code);
      let copied = false;
      try {
        const ta = document.createElement('textarea');
        ta.value = link; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:-100px;opacity:0';
        document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, link.length);
        copied = document.execCommand('copy');
        ta.remove();
      } catch {}
      if (!copied) { try { navigator.clipboard.writeText(link).catch(() => {}); } catch {} }
      setTimeout(() => { const h = $('useApp'); if (h) h.textContent = 'Open the Android app'; }, 1500);
    };
  }

  // On an iPhone, a home-screen app keeps its own storage, apart from
  // Safari's: pairing in Safari would leave the icon unpaired. So first:
  // where do you want it?
  function iosChoice(code) {
    showProblem(`Pair with <b>${esc(code.name || 'your computer')}</b>`, 'Where do you want Chattering on this iPhone?', [
      ['On the home screen', 'homeScreen', true, () => showProblem('Add it to your home screen', 'Tap <b>Share</b> <span class="share-glyph" aria-hidden="true"></span> then <b>Add to Home Screen</b>. Open Chattering from its new icon: it finishes pairing there.', [['Use Safari instead', 'safari', false, () => pair(code)]], 'ios')],
      ['Here in Safari', 'safari', false, () => pair(code)],
    ], 'ios');
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const h = homeOf(active);
    if (!h) return;
    // Back from the background: is the tunnel still there? A quick ping says.
    if (tunnel) tunnel.ping(4000).catch(() => { if (tunnel) tunnel.close(); });
    else if (!connecting) { backoff = 0; connect(h); }
  });
  addEventListener('online', () => { const h = homeOf(active); if (h && !tunnel && !connecting) { backoff = 0; connect(h); } });

  (async function boot() {
    const code = P.readPairingLink(location.hash);
    try {
      homes = (await kvGet('homes')) || [];
      active = (await kvGet('active')) || null;
      if (!homeOf(active)) active = homes[0] ? homes[0].homeId : null;
      await worker();
    } catch (e) {
      return showProblem('Chattering cannot start here', esc(e.message), [['Reload', 'reload', true, () => location.reload()]]);
    }
    if (code) {
      const known = homeOf(code.homeId);
      if (known && known.deviceId) {
        // An old code (the home-screen icon keeps the address it was added
        // from): already paired, carry on.
        history.replaceState(null, '', '/');
        active = known.homeId; await kvSet('active', active);
      } else if (IOS && !standalone()) return iosChoice(code);
      else if (ANDROID_WEB && !standalone()) return androidChoice(code);
      else return pair(code);
    }
    if (!active) return showWelcome();
    connect(homeOf(active));
  })();
})();
