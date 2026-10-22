/* Notifications on this device (design/100).

   - Settings → notifications: turn them on here (one tap, the browser's or
     Android's own question), choose what buzzes, send a test, see the
     person's other devices and why a recent event did or did not notify.
   - While Chattering is in use, this screen tells the computer so (visible,
     focused, last touched, which conversation): the person's other devices
     stay quiet meanwhile (push-policy.js).
   - The notifications stay honest: read a conversation and its notification
     goes; the app icon's number is the unread replies.
   - Once, at the moment it helps (a reply is taking a while, on a phone),
     a small offer to turn them on.

   Where the browser's machinery lives: the page itself at the computer's
   own address, or the shell around it through the encrypted link (the app
   runs there in a frame of the same site: the permission question and the
   subscription belong to the page in front). In the Android app, the app
   itself receives them (window.ChatteringNotify, NotifyService). */
(function () {
  'use strict';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));
  const front = (() => { try { if (window.top !== window && window.top.location.origin === location.origin) return window.top; } catch {} return window; })();
  const shell = () => { try { return front !== window && front.__anywhere && typeof front.__anywhere.pushKey === 'function' ? front.__anywhere : null; } catch { return null; } };
  const UA = navigator.userAgent;
  const IOS = /iPhone|iPad|iPod/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
  const ANDROID = /Android/.test(UA);
  const app = () => window.ChatteringNotify || null;
  const standalone = () => { try { return front.matchMedia('(display-mode: standalone)').matches || front.navigator.standalone === true; } catch { return false; } };
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const post = async (path, body) => {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    return d;
  };
  const say = (msg, kind) => { if (typeof toast === 'function') toast(msg, null, kind || ''); };
  const sayErr = msg => { if (typeof errToast === 'function') errToast(msg); else say(msg, 'err'); };

  /* ---- what this device can do ---- */
  function support() {
    const a = app();
    if (a) return typeof a.subscription === 'function' ? 'app' : 'old-app';
    if (!window.isSecureContext) return 'insecure';
    if (IOS && !('PushManager' in front)) return standalone() ? 'ios-old' : 'ios-install';
    if (!('serviceWorker' in front.navigator) || !('PushManager' in front) || !('Notification' in front)) return 'browser';
    return 'web';
  }
  const permission = () => { try { return front.Notification.permission; } catch { return 'default'; } };
  function deviceLabel() {
    try { const a = app(); if (a && typeof a.label === 'function' && a.label()) return String(a.label()); } catch {}
    const os = IOS ? (/iPad/.test(UA) || /Macintosh/.test(UA) ? 'iPad' : 'iPhone') : ANDROID ? 'Android' : /Windows/.test(UA) ? 'Windows' : /Macintosh/.test(UA) ? 'Mac' : /CrOS/.test(UA) ? 'ChromeOS' : /Linux/.test(UA) ? 'Linux' : 'Computer';
    const br = /Edg\//.test(UA) ? 'Edge' : /Firefox\//.test(UA) ? 'Firefox' : /SamsungBrowser/.test(UA) ? 'Samsung Internet' : /Chrome\//.test(UA) ? 'Chrome' : /Safari\//.test(UA) ? 'Safari' : 'browser';
    return os + ' · ' + (standalone() ? (IOS ? 'Home Screen' : br + ' app') : br);
  }
  async function idOf(endpoint) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
    return b64u(h).slice(0, 16);
  }
  const timeout = ms => new Promise(r => setTimeout(() => r(null), ms));
  async function registration() {
    try { return await Promise.race([front.navigator.serviceWorker.ready, timeout(8000)]); } catch { return null; }
  }

  /* ---- the computer's side ---- */
  let info = null;      // GET /api/push: { publicKey, home, devices, recent, prefs }
  let loading = null;
  function load() {
    return loading || (loading = fetch('/api/push').then(r => r.ok ? r.json() : null).catch(() => null)
      .then(d => { info = d; return d; }).finally(() => { loading = null; }));
  }

  // This device's subscription: the browser's, or the Android app's mailbox.
  async function deviceSubscription() {
    const how = support();
    if (how === 'app') {
      try { const a = app(); return a.isEnabled() ? JSON.parse(a.subscription() || 'null') : null; } catch { return null; }
    }
    if (how !== 'web') return null;
    const reg = await registration();
    try { const sub = reg && await reg.pushManager.getSubscription(); return sub ? sub.toJSON() : null; } catch { return null; }
  }
  // This device as the computer knows it, or null.
  async function myDevice() {
    if (!info) await load();
    const sub = await deviceSubscription();
    if (!sub || !info) return null;
    const id = await idOf(sub.endpoint);
    return info.devices.find(d => d.id === id) || null;
  }
  // The key the subscription is bound to: this computer's, or (through the
  // encrypted link, where one subscription serves every paired computer)
  // the device's own, which the computer then signs with.
  async function signingKey() {
    const s = shell();
    if (s) return await s.pushKey();
    return { publicKey: info.publicKey, privateJwk: null };
  }

  // The Android app answers its permission question later (nativeNotifyChanged).
  let appAnswer = null;
  const previousNativeHook = window.nativeNotifyChanged;
  window.nativeNotifyChanged = on => {
    if (appAnswer) { const r = appAnswer; appAnswer = null; r(!!on); }
    try { if (typeof previousNativeHook === 'function') previousNativeHook(on); } catch {}
  };

  /* ---- turning on and off (a tap: the browser's question needs it) ---- */
  async function enable(prefs) {
    const how = support();
    if (how === 'web') {
      // The question first, in the same tap: Safari forgets the tap after
      // any other wait.
      let perm = permission();
      if (perm === 'default') perm = await front.Notification.requestPermission();
      if (perm !== 'granted') return perm === 'denied' ? 'blocked' : 'dismissed';
      if (!info) await load();
      if (!info) throw new Error('this computer did not answer');
      const key = await signingKey();
      const reg = await registration();
      if (!reg) throw new Error('the notification helper of this page did not start; reload and try again');
      let sub = await reg.pushManager.getSubscription();
      const want = unb64u(key.publicKey);
      const bound = sub && sub.options && sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
      if (sub && (!bound || bound.length !== want.length || bound.some((b, i) => b !== want[i]))) { await sub.unsubscribe().catch(() => {}); sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
      const d = await post('/api/push/subscribe', { subscription: sub.toJSON(), label: deviceLabel(), kind: 'web', prefs, vapid: key.privateJwk || undefined });
      remember(d.device.id);
    } else if (how === 'app') {
      const a = app();
      if (!a.isEnabled()) {
        const answered = new Promise(r => { appAnswer = r; setTimeout(() => { if (appAnswer === r) { appAnswer = null; r(false); } }, 60000); });
        a.setEnabled(true);
        if (!(await answered)) return 'blocked';
      }
      const sub = JSON.parse(a.subscription() || 'null');
      if (!sub) throw new Error('the app could not make its notification address');
      const d = await post('/api/push/subscribe', { subscription: sub, label: deviceLabel(), kind: 'android-app', prefs });
      remember(d.device.id);
    } else throw new Error('notifications are not available here');
    await load();
    report(true);
    return 'on';
  }
  async function disable() {
    const mine = await myDevice();
    if (mine) await post('/api/push/remove', { id: mine.id });
    const how = support();
    const s = shell();
    const otherComputers = s ? s.homes().length > 1 : false;
    // Through the encrypted link the same address serves the other paired
    // computers: it stays, only this computer forgets it.
    if (how === 'web' && !otherComputers) {
      const reg = await registration();
      const sub = reg && await reg.pushManager.getSubscription().catch(() => null);
      if (sub) await sub.unsubscribe().catch(() => {});
    }
    if (how === 'app' && !otherComputers) { try { app().setEnabled(false); } catch {} }
    forget();
    await load();
  }

  // Which device id this page registered with this computer: when the
  // browser replaces its address, the next start moves the record over.
  const memKey = () => 'chattering.push.device.' + ((info && info.home && info.home.id) || location.host);
  const remember = id => store.set(memKey(), id);
  const forget = () => { try { localStorage.removeItem(memKey()); } catch {} };
  async function reconcile() {
    const how = support();
    if (how !== 'web' && how !== 'app') return;
    if (how === 'web' && permission() !== 'granted') return;
    await load();
    if (!info) return;
    const was = store.get(memKey());
    if (!was) return;
    const sub = await deviceSubscription();
    if (!sub) return;
    const id = await idOf(sub.endpoint);
    if (id === was) return;
    if (!info.devices.some(d => d.id === was)) return forget(); // turned off from another device
    try {
      const key = how === 'web' ? await signingKey() : null;
      const d = await post('/api/push/subscribe', { subscription: sub, label: (info.devices.find(x => x.id === was) || {}).label || deviceLabel(),
        kind: how === 'app' ? 'android-app' : 'web', prefs: (info.devices.find(x => x.id === was) || {}).prefs, vapid: key && key.privateJwk || undefined });
      await post('/api/push/remove', { id: was });
      remember(d.device.id);
      await load();
    } catch {}
  }

  /* ---- "I am here": the other devices stay quiet meanwhile ---- */
  // Sent whether or not this person has devices yet: one added on the phone
  // a minute from now must already find the laptop's screen known. A small
  // request a minute per visible window, and on each change.
  let lastInput = Date.now(), reportTimer = 0, lastSent = 0;
  function route() { try { return typeof peopleCurrentRoute === 'function' ? peopleCurrentRoute() : 'home'; } catch { return 'home'; } }
  function conn() { try { return typeof peopleState !== 'undefined' && peopleState.conn ? peopleState.conn : null; } catch { return null; } }
  // What kind of screen this is, in a few words: the computer's record of
  // where a sound went names it (design/102).
  function device() {
    const ua = navigator.userAgent || '';
    const kind = typeof window.ChatteringApp === 'object' || window.__anywhereApp ? 'Android app' : /iPhone|iPad/.test(ua) ? 'iPhone or iPad' : /Android/.test(ua) ? 'Android browser' : 'browser';
    return kind + (window.__anywhereInside ? ' (encrypted link)' : '');
  }
  // `now`: at once, in this very task (a page that is going away runs no
  // timer after this, and its last word, "hidden", is the one that matters).
  function report(now) {
    clearTimeout(reportTimer);
    if (now) send(); else reportTimer = setTimeout(send, 400);
  }
  function send() {
    const c = conn();
    if (!c) return;
    lastSent = Date.now();
    const body = JSON.stringify({ conn: c, visible: !document.hidden && !leaving, focused: !leaving && document.hasFocus(), idleMs: Date.now() - lastInput, route: route(), device: device(), talking: talking() });
    fetch('/api/push/here', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }
  // This screen talks with the frog (the walkie-talkie, design/102): its
  // voice sounds here, hidden or not (a phone in a pocket, in a call).
  function talking() { try { return typeof voice !== 'undefined' && voice.mode === 'walkie' && !leaving; } catch { return false; } }
  function here() { report(true); }
  for (const t of ['pointerdown', 'keydown', 'touchstart', 'wheel']) {
    addEventListener(t, () => { const was = lastInput; lastInput = Date.now(); if (lastInput - was > 45000 || Date.now() - lastSent > 10000) report(); }, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => { report(true); if (!document.hidden) { tidy(); reconcile(); } });
  let leaving = false;
  addEventListener('pagehide', () => { leaving = true; report(true); });
  addEventListener('pageshow', e => { if (e.persisted) { leaving = false; report(true); } });
  addEventListener('focus', () => report());
  addEventListener('blur', () => report());
  addEventListener('chattering:route', () => report());
  setInterval(() => { if (!document.hidden || talking()) send(); }, 60000);

  /* ---- honest notifications: read ones go, the icon counts unread ---- */
  let unreadKeys = null, tidyTimer = 0;
  function unreadChanged(sessions) {
    unreadKeys = new Set((sessions || []).map(s => s.key));
    clearTimeout(tidyTimer);
    tidyTimer = setTimeout(tidy, 800);
  }
  async function tidy() {
    if (!unreadKeys || document.hidden) return;
    const n = unreadKeys.size;
    try {
      const nav = front.navigator;
      if (standalone() && nav.setAppBadge) { if (n) await nav.setAppBadge(n); else await nav.clearAppBadge(); }
    } catch {}
    if (support() !== 'web' || permission() !== 'granted') return;
    const home = info && info.home && info.home.id;
    if (!home) return;
    try {
      const reg = await registration();
      for (const note of reg ? await reg.getNotifications() : []) {
        const d = note.data || {};
        if (d.home === home && d.key && d.kind !== 'test' && !unreadKeys.has(d.key)) note.close();
      }
    } catch {}
  }

  /* ---- the offer: once or twice, when a reply takes a while on a phone ---- */
  const OFFERS = 'chattering.push.offers';
  function offerWanted() {
    const how = support();
    if (how !== 'web' && how !== 'app') return false;
    if (how === 'web' && permission() === 'denied') return false;
    if (!(IOS || ANDROID || app() || standalone())) return false;
    const o = (() => { try { return JSON.parse(store.get(OFFERS) || '{}'); } catch { return {}; } })();
    if ((o.n || 0) >= 2 || Date.now() - (o.at || 0) < 3 * 24 * 3600e3) return false;
    return true;
  }
  addEventListener('chattering:sent', ev => {
    const key = ev.detail && ev.detail.key;
    if (!key || !offerWanted()) return;
    setTimeout(async () => {
      if (document.hidden || !offerWanted()) return;
      let running = false;
      try { running = typeof activeRuns !== 'undefined' && [...activeRuns.values()].some(r => r.key === key && r.status === 'running'); } catch {}
      if (!running) return;
      await load();
      if (!info || await myDevice()) return;
      const o = (() => { try { return JSON.parse(store.get(OFFERS) || '{}'); } catch { return {}; } })();
      store.set(OFFERS, JSON.stringify({ n: (o.n || 0) + 1, at: Date.now() }));
      if (typeof toast !== 'function') return;
      toast('This may take a while. Get a notification on this ' + (IOS ? (/iPad/.test(UA) ? 'iPad' : 'iPhone') : 'device') + ' when the reply is ready? Tap here.', () => {
        enable().then(r => {
          if (r === 'on') { store.set(OFFERS, JSON.stringify({ n: 9, at: Date.now() })); say('Notifications are on. Change them in Settings → notifications.', 'ok'); }
          else if (r === 'blocked') sayErr('Notifications are blocked here. Settings → notifications says how to allow them.');
        }).catch(e => sayErr('could not turn notifications on: ' + e.message));
      }, 'ok');
    }, 15000);
  });

  /* ---- Settings → notifications ---- */
  const PREF_ROWS = [
    ['replies', 'a reply is ready'],
    ['questions', 'an agent waits for my answer'],
    ['problems', 'a run fails, or work goes quiet'],
    ['preview', 'show the first words of replies (on the lock screen too)'],
    ['whileActive', 'even while I use Chattering on another screen'],
  ];
  const ago = t => {
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago';
  };
  const SERVICE = h => /apple/.test(h) ? 'Apple' : /google/.test(h) ? 'Google' : /mozilla/.test(h) ? 'Mozilla' : /windows/.test(h) ? 'Microsoft' : 'the relay';

  function paneHtml({ appUpdate = '' } = {}) {
    return `<h2>notifications</h2>
      <p class="lead">Your phone, tablet or browser tells you when a reply is ready, an agent needs an answer, or work stops, even when Chattering is closed.</p>
      <div id="pushPane" class="push-pane"><div class="set-status">Looking at this device…</div></div>
      ${appUpdate}
      <details class="set-more"><summary>how it works, and what is shared</summary>
        <p>This computer sends each notification itself, encrypted for your device. Apple, Google or Mozilla (for a browser) or the Chattering relay (for the Android app) carry it; they see that a notification passed and how big it was, never what it says.</p>
        <p>Your other devices stay quiet while you are using Chattering on a screen, and never buzz about a conversation you are looking at. Notifications only come for conversations in your list, never for a helper agent's own work.</p>
        <p>Notifications need this computer to be on and online. Each device decides for itself what it shows.</p>
      </details>`;
  }

  function prefsHtml(d) {
    return `<div class="push-prefs">${PREF_ROWS.map(([k, label]) => `<label class="set-check"><input type="checkbox" data-push-pref="${k}"${d.prefs[k] ? ' checked' : ''}> ${esc(label)}</label>`).join('')}</div>`;
  }

  async function renderPane(root) {
    const box = root.querySelector('#pushPane');
    if (!box) return;
    await load();
    const how = support();
    const mine = await myDevice();
    const perm = how === 'web' ? permission() : null;
    let here = '';
    if (mine) {
      here = `<div class="push-here on">
        <div class="push-state"><span class="push-dot" aria-hidden="true"></span><b>On for this device</b> <span class="push-label">${esc(mine.label)}</span></div>
        ${prefsHtml(mine)}
        <div class="set-row"><button type="button" class="primary" data-push="test" data-id="${esc(mine.id)}">Send a test</button><button type="button" data-push="rename" data-id="${esc(mine.id)}">Rename</button><button type="button" class="ghost" data-push="off">Turn off here</button></div>
        ${mine.lastError ? `<div class="set-help push-err">Last try did not arrive: ${esc(mine.lastError.text)} (${esc(ago(mine.lastError.at))}).</div>` : ''}
      </div>`;
    } else if (how === 'web' && perm === 'denied') {
      here = `<div class="push-here"><div class="push-state"><b>Blocked in this browser</b></div>
        <div class="set-help">${IOS ? 'Allow them in the iPhone’s Settings → Notifications → Chattering, then come back here.' : 'Allow notifications for this site in the browser (the icon left of the address, or its site settings), then come back here.'}</div></div>`;
    } else if (how === 'web' || how === 'app') {
      here = `<div class="push-here"><div class="push-state"><b>Off for this device</b> <span class="push-label">${esc(deviceLabel())}</span></div>
        <div class="set-row"><button type="button" class="primary" data-push="on">Turn on notifications</button></div>
        ${how === 'app' ? '<div class="set-help">Android asks once. The app then keeps a quiet connection to the relay and shows a small “Chattering is listening” notice that you can hide in Android’s settings for that notice.</div>' : IOS ? '' : '<div class="set-help">The browser asks once.</div>'}
      </div>`;
    } else {
      const why = {
        'old-app': 'This Chattering app is too old for notifications. Update it (below), then come back here.',
        'insecure': `Notifications need Chattering’s secure address (https).${info && info.relay ? ' Use the encrypted link (Settings → machines → Add a device), or your Tailscale https address.' : ''}`,
        'ios-install': 'On iPhone and iPad, notifications come to Chattering on the Home Screen: in Safari tap <b>Share</b> → <b>Add to Home Screen</b>, open Chattering from that icon, then turn them on here.',
        'ios-old': 'This iPhone or iPad needs iOS 16.4 or newer for notifications.',
        'browser': 'This browser cannot show notifications from a web page.',
      }[how] || 'Notifications are not available here.';
      here = `<div class="push-here"><div class="push-state"><b>Not available here</b></div><div class="set-help">${why}</div></div>`;
    }
    const others = info ? info.devices.filter(d => !mine || d.id !== mine.id) : [];
    const othersHtml = others.length ? `<div class="set-group"><h3>your other devices</h3>
      <ul class="push-devices">${others.map(d => `<li>
        <div><b>${esc(d.label)}</b> <span class="push-meta">${esc(d.kind === 'android-app' ? 'Android app' : 'via ' + SERVICE(d.service))}${d.lastOkAt ? ' · last delivered ' + esc(ago(d.lastOkAt)) : ''}</span>
          ${d.lastError ? `<div class="push-meta push-err">last try did not arrive: ${esc(d.lastError.text)}</div>` : ''}</div>
        <span class="push-actions"><button type="button" class="ghost" data-push="test" data-id="${esc(d.id)}">test</button><button type="button" class="ghost" data-push="rename" data-id="${esc(d.id)}">rename</button><button type="button" class="ghost" data-push="remove" data-id="${esc(d.id)}" title="Stop notifying this device">✕</button></span>
      </li>`).join('')}</ul></div>` : '';
    const recent = info && info.recent && info.recent.length ? `<details class="set-more push-recent"><summary>recent notifications, and why</summary><ul>${info.recent.map(r => {
      const what = { reply: 'Reply', failed: 'Failed', question: 'Question', quiet: 'Quiet work', test: 'Test' }[r.kind] || r.kind;
      const sent = r.sent.map(x => esc(x.device)).join(', ');
      const skipped = r.skipped.map(x => `${esc(x.device)}: ${esc(WHY[x.why] || x.why)}`).join('; ');
      return `<li><span class="push-meta">${esc(ago(r.at))}</span> ${esc(what)}${r.title && r.kind !== 'test' ? ' · ' + esc(r.title) : ''}<br>${sent ? 'sent to ' + sent : ''}${sent && skipped ? ' · ' : ''}${skipped ? 'not sent to ' + skipped : ''}</li>`;
    }).join('')}</ul></details>` : '';
    box.innerHTML = here + othersHtml + recent;
    bindPaneBox(root, box);
  }
  const WHY = {
    'looking at it': 'you were looking at it',
    'at another screen': 'you were using Chattering on another screen',
    'off for replies': 'replies are off there',
    'off for problems': 'problems are off there',
    'off for questions': 'questions are off there',
  };

  function bindPaneBox(root, box) {
    const busy = async (btn, fn) => { if (btn) btn.disabled = true; try { await fn(); } catch (e) { sayErr(e.message); } finally { if (btn && btn.isConnected) btn.disabled = false; } renderPane(root); };
    box.querySelectorAll('[data-push]').forEach(btn => {
      btn.onclick = () => {
        const what = btn.dataset.push, id = btn.dataset.id;
        // Turning on starts with the browser's question, in this very tap.
        if (what === 'on') return busy(btn, async () => {
          const r = await enable();
          if (r === 'on') say('Notifications are on for this device. Send a test to see one.', 'ok');
          else if (r === 'blocked') sayErr(IOS ? 'Notifications were not allowed. The iPhone’s Settings → Notifications → Chattering can allow them.' : 'Notifications were not allowed on this device.');
        });
        if (what === 'off') return busy(btn, async () => { await disable(); say('Notifications are off for this device.'); });
        if (what === 'test') return busy(btn, async () => {
          await post('/api/push/test', { id });
          say(document.hidden ? 'Test sent.' : 'Test sent. It shows in the notification shade' + (IOS ? ' or the lock screen' : '') + ' in a moment.', 'ok');
        });
        if (what === 'remove') return busy(btn, async () => { await post('/api/push/remove', { id }); await load(); });
        if (what === 'rename') {
          const d = info && info.devices.find(x => x.id === id);
          const name = prompt('Name this device', d ? d.label : '');
          if (name && name.trim()) return busy(btn, async () => { await post('/api/push/rename', { id, label: name.trim() }); await load(); });
        }
      };
    });
    box.querySelectorAll('[data-push-pref]').forEach(input => {
      input.onchange = async () => {
        const mine = await myDevice();
        if (!mine) return;
        try { await post('/api/push/prefs', { id: mine.id, prefs: { [input.dataset.pushPref]: input.checked } }); await load(); }
        catch (e) { input.checked = !input.checked; sayErr('could not save: ' + e.message); }
      };
    });
  }
  function bindPane(root) { renderPane(root).catch(e => { const b = root.querySelector('#pushPane'); if (b) b.innerHTML = `<div class="set-help">Could not read notifications: ${esc(e.message)}</div>`; }); }

  // A tapped notification, at the computer's own address: the worker asks
  // this window to go there (through the encrypted link, the shell does).
  // (Not every page has a worker: a shared link's viewer, a sandboxed frame.)
  const workers = (() => { try { return navigator.serviceWorker || null; } catch { return null; } })();
  if (front === window && workers) {
    workers.addEventListener('message', ev => {
      const m = ev.data;
      if (!m || m.type !== 'chattering-open' || typeof m.url !== 'string' || !m.url.startsWith('/') || m.url.startsWith('//')) return;
      const target = new URL(m.url, location.origin);
      if (target.pathname === location.pathname && target.hash) { if (location.hash !== target.hash) location.hash = target.hash; }
      else location.href = target.pathname + target.search + target.hash;
    });
  }

  window.PushUI = { paneHtml, bindPane, enable, disable, unreadChanged, support, load, report, here };
  // On start: bring a replaced address up to date, and say where this screen is.
  setTimeout(() => { load().then(() => { reconcile(); report(true); tidy(); }); }, 2500);
})();
