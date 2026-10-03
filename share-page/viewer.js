/* A shared conversation, read in Chattering's own page (design/92).

   The share serves app.html itself, with this file first. It makes the app
   a reader of one conversation:
   - the app's requests are answered from the share's routes, which name
     only this conversation (its messages, its people, its pictures, its
     live updates); everything else gets an empty answer, and anything
     that would change something is refused, here and by the server;
   - the app's own screens around a conversation (lists, composer, actions)
     are hidden by viewer.css, and app.html asks `chatteringViewer()` where
     a reader-only choice is made in code.
   The conversation is known to the page as "shared", never by its file. */
(function () {
  'use strict';
  const m = /^\/s\/([a-z2-7]{16})\/view$/.exec(location.pathname);
  if (!m) return;
  const BASE = '/s/' + m[1];
  const KEY = 'shared';
  window.CHATTERING_VIEWER = { base: BASE, key: KEY };
  window.chatteringViewer = () => true;
  document.documentElement.classList.add('chattering-viewer');
  // The app opens what the address names: this conversation, nothing else.
  if (location.hash !== '#' + KEY) history.replaceState(null, '', location.pathname + '#' + KEY);
  window.addEventListener('hashchange', () => { if (location.hash !== '#' + KEY && !/^#(read=|shared)/.test(location.hash)) history.replaceState(null, '', location.pathname + '#' + KEY); });

  // No service worker: it would answer for every page of this address.
  try { Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true }); } catch {}
  try { navigator.sendBeacon = () => true; } catch {}

  const realFetch = window.fetch.bind(window);
  const answer = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  // Requests of the app that have a read-only meaning here.
  const EMPTY = {
    '/api/notes': [], '/api/epics': [], '/api/project-folds': { folds: {}, created: [] }, '/api/agent-read': {}, '/api/open-files': { files: [] },
    '/api/recent-files': { files: [] }, '/api/jobs': [], '/api/presence': { people: [] }, '/api/themes': { themes: [], invalid: [] },
    '/api/models': [], '/api/modes': [], '/api/related': [], '/api/artifacts/config': { port: 0, tlsPort: 0, tailnetPort: 0, base: '', network: 'libraries' },
    '/api/delegations': [], '/api/anywhere': {}, '/api/public-links': {}, '/api/hotkeys': {},
  };
  let unknown = [];
  function route(url, method, init) {
    const p = url.pathname;
    if (method === 'GET' || method === 'HEAD') {
      if (p === '/api/session') return realFetch(BASE + '/api/session', { credentials: 'same-origin' });
      if (p === '/api/sessions') return realFetch(BASE + '/api/sessions', { credentials: 'same-origin' });
      if (p === '/api/users') return realFetch(BASE + '/api/users', { credentials: 'same-origin' }).then(r => r.json()).then(users => answer({ users, me: null, viewer: true }));
      if (p === '/api/conversation/media') return realFetch(BASE + '/api/media?' + new URLSearchParams({ entry: url.searchParams.get('entry') || '', path: url.searchParams.get('path') || '' }), { credentials: 'same-origin' });
      if (p === '/api/settings') return answer({ viewer: true });
      if (p === '/api/themes.css') return Promise.resolve(new Response('', { status: 200, headers: { 'Content-Type': 'text/css' } }));
      if (Object.prototype.hasOwnProperty.call(EMPTY, p)) return answer(EMPTY[p]);
      // Anything else the app asks for is not part of a shared conversation:
      // "not found", which every caller already handles.
      if (unknown.length < 50) unknown.push(p);
      return answer({ error: 'Not part of a shared conversation.' }, 404);
    }
    // Moving through the conversation (branches, folds) is the reader's own.
    if (p === '/api/conversation/reading') return answer({ ok: true, reading: null });
    // Read marks and the owner's inbox: nothing to keep for a visitor.
    if (p === '/api/agent-read') return answer({});
    // The files each step changed are not part of a shared conversation.
    if (p === '/api/conversation/changes') return readBody(init).then(b => answer({ groups: (b.groups || []).map(() => ({ files: [], during: [] })) }));
    if (p === '/api/path/exists') return answer({ exists: {} });
    return answer({ error: 'This is a read-only view of a shared conversation.' }, 403);
  }
  const readBody = init => { try { return Promise.resolve(JSON.parse(init && init.body || '{}')); } catch { return Promise.resolve({}); } };
  let currentInit = null;
  window.fetch = function (input, init) {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href); } catch { return realFetch(input, init); }
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    currentInit = init;
    return route(url, method, init);
  };
  window.__viewerUnknown = () => unknown.slice();

  // Live updates: the share's stream for this conversation; any other
  // stream (runs, voice, terminals) never opens.
  const RealES = window.EventSource;
  class Quiet {
    constructor(url) { this.url = String(url); this.readyState = 0; this.withCredentials = false; }
    addEventListener() {} removeEventListener() {} dispatchEvent() { return false; } close() { this.readyState = 2; }
  }
  Quiet.CONNECTING = 0; Quiet.OPEN = 1; Quiet.CLOSED = 2;
  function ViewerEventSource(url, opts) {
    let u;
    try { u = new URL(String(url), location.href); } catch { return new Quiet(url); }
    if (u.origin === location.origin && u.pathname === '/api/events') {
      const es = new RealES(BASE + '/api/events', opts);
      es.addEventListener('ended', () => { es.close(); window.dispatchEvent(new CustomEvent('chattering:viewer-ended')); });
      return es;
    }
    if (u.origin === location.origin && u.pathname.startsWith('/api/')) return new Quiet(url);
    return new RealES(url, opts);
  }
  ViewerEventSource.CONNECTING = 0; ViewerEventSource.OPEN = 1; ViewerEventSource.CLOSED = 2;
  window.EventSource = ViewerEventSource;
  const RealWS = window.WebSocket;
  function ViewerWebSocket(url, protocols) {
    let u;
    try { u = new URL(String(url), location.href); } catch { return new Quiet(url); }
    if (u.host === location.host) { const q = new Quiet(url); q.send = () => {}; q.binaryType = 'blob'; return q; }
    return new RealWS(url, protocols);
  }
  ViewerWebSocket.CONNECTING = 0; ViewerWebSocket.OPEN = 1; ViewerWebSocket.CLOSING = 2; ViewerWebSocket.CLOSED = 3;
  window.WebSocket = ViewerWebSocket;

  // Who shared it, and how: a quiet bar where the composer would be.
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  realFetch(BASE + '/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin' })
    .then(r => r.ok ? r.json() : null).then(info => {
      if (!info) return;
      window.CHATTERING_VIEWER.info = info;
      const put = () => {
        const bar = document.createElement('div');
        bar.id = 'viewerBar';
        const when = info.mode === 'snapshot' ? '<span>A copy from ' + esc(new Date(info.snapshotAt).toLocaleString()) + '</span>' : '<span class="vb-live">Live: new messages appear as they are written</span>';
        bar.innerHTML = '<span>Shared by <b>' + esc(info.owner.name) + '</b> · read only</span>' + when + '<a href="https://rockfrog.ai" target="_blank" rel="noopener noreferrer">Chattering</a>';
        document.body.appendChild(bar);
      };
      if (document.body) put(); else document.addEventListener('DOMContentLoaded', put);
    }).catch(() => {});

  // The link was turned off or replaced: the page says so and stops.
  window.addEventListener('chattering:viewer-ended', () => {
    document.body.innerHTML = '<div class="viewer-ended"><h1>This link has ended</h1><p>The person who shared this conversation turned the link off or replaced it.</p></div>';
  });
})();
