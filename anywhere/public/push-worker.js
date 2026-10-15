/* Notifications, in the service worker (design/100).

   One file for both places Chattering runs in a browser:
   - at the computer's own address (Tailscale, home network), imported by
     Chattering's sw.js: the page in front is the app;
   - at the relay's address (Chattering Anywhere, every iPhone), imported by
     the relay's sw.js with self.CHATTERING_SHELL set: the page in front is
     the shell (shell.js), which runs the app in a frame and may be paired
     with several computers.

   A message arrives encrypted from the computer (push.js); the browser has
   already opened it. It is shown as one notification per conversation (a
   newer one replaces it), the app icon's badge says how many replies wait,
   and notifications of conversations read meanwhile on another device are
   cleared. A tap opens that conversation, in the window already open if
   there is one. */
(function () {
  'use strict';
  const SHELL = !!self.CHATTERING_SHELL;
  const ICON = SHELL ? '/_anywhere/icon-192.png' : '/icon-192.png?v=frog';
  const BADGE = SHELL ? '/_anywhere/notification-badge.png' : '/notification-badge.png';

  self.addEventListener('push', event => { event.waitUntil(onPush(event)); });

  async function onPush(event) {
    let m = null;
    try { m = event.data ? event.data.json() : null; } catch {}
    // Every push must show something (Safari ends the subscription of a site
    // that stays silent); a message this worker cannot read says so plainly.
    if (!m || typeof m !== 'object' || m.v !== 1) m = { title: 'Chattering', body: 'Something new is waiting.', tag: 'chattering', url: '/' };
    const home = m.home && m.home.id ? m.home.id : '';
    // Read on another device since: those notifications go.
    if (Array.isArray(m.open)) {
      const keep = new Set(m.open.concat(m.tag || []));
      try {
        for (const n of await self.registration.getNotifications()) {
          const d = n.data || {};
          if (d.tag && d.home === home && d.kind !== 'test' && !keep.has(d.tag)) n.close();
        }
      } catch {}
    }
    if (typeof m.badge === 'number') await setBadge(m.badge);
    await self.registration.showNotification(m.title || 'Chattering', {
      body: m.body || '',
      tag: m.tag || undefined,
      renotify: !!(m.renotify && m.tag),
      icon: ICON,
      badge: BADGE,
      timestamp: typeof m.at === 'number' ? m.at : Date.now(),
      data: { url: typeof m.url === 'string' && m.url.startsWith('/') ? m.url : '/', key: m.key || null, home, tag: m.tag || null, kind: m.kind || null },
    });
  }

  async function setBadge(n) {
    try {
      if (n > 0 && self.navigator.setAppBadge) await self.navigator.setAppBadge(n);
      else if (self.navigator.clearAppBadge) await self.navigator.clearAppBadge();
    } catch {}
  }

  self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(openFrom(event.notification.data || {}));
  });

  async function openFrom(d) {
    const url = typeof d.url === 'string' && d.url.startsWith('/') ? d.url : '/';
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // The window to reuse: the shell (any page of the relay's site is one),
    // or, at the computer's address, the app itself (not a shared page).
    const fit = all.filter(c => c.frameType === 'top-level' && (SHELL || new URL(c.url).pathname === '/'));
    const c = fit.find(x => x.focused) || fit.find(x => x.visibilityState === 'visible') || fit[0];
    if (c) {
      try { await c.focus(); } catch {}
      c.postMessage({ type: 'chattering-open', url, key: d.key || null, home: d.home || '' });
      return;
    }
    // None open: a new one, at the conversation (the shell picks the
    // computer from ?home= before it starts the app).
    const target = SHELL && d.home ? '/?home=' + encodeURIComponent(d.home) + url.slice(1) : url;
    try { await self.clients.openWindow(target); } catch {}
  }

  // The browser replaced the subscription (Firefox does, now and then). At
  // the computer's address the worker can tell it at once; through the
  // relay it cannot reach the computer by itself, and the page brings the
  // new address the next time it opens (push-ui.js reconciles on every start).
  self.addEventListener('pushsubscriptionchange', event => {
    if (SHELL) return;
    event.waitUntil((async () => {
      const old = event.oldSubscription;
      let sub = event.newSubscription;
      if (!sub && old && old.options) { try { sub = await self.registration.pushManager.subscribe(old.options); } catch {} }
      if (!sub) return;
      await fetch('/api/push/renew', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify({ old: old ? old.endpoint : null, subscription: sub.toJSON() }) }).catch(() => {});
    })());
  });
})();
