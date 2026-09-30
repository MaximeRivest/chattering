/* Chattering Anywhere, the phone's service worker (design/85).

   Every address of this site is Chattering on the phone's home computer.
   A page the person opens is the shell (shell.html: the connection, the
   pairing screens); inside it the app runs in a frame, and every request
   that frame makes arrives here and is handed to the shell, which carries
   it through the encrypted tunnel to the home and streams the answer back.
   This worker keeps no data of its own: the shell's files, cached so the
   page opens without the network, and nothing else. */
'use strict';
const VERSION = 'anywhere-9';
const SHELL_CACHE = 'anywhere-shell-' + VERSION;
const SHELL_FILES = ['/_anywhere/shell.html', '/_anywhere/shell.css', '/_anywhere/shell.js', '/_anywhere/protocol.js', '/_anywhere/client.js',
  '/_anywhere/inside.js', '/_anywhere/manifest.webmanifest', '/_anywhere/mark.svg', '/_anywhere/favicon.svg', '/_anywhere/icon-192.png', '/_anywhere/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL_FILES)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('anywhere-shell-') && k !== SHELL_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname === '/sw.js' || url.pathname === '/healthz') return;
  if (url.pathname.startsWith('/_anywhere/')) return e.respondWith(shellFile(e.request));
  // A page opened by the person (a link, the home-screen icon, a reload):
  // always the shell, which then opens the app at this address.
  if (e.request.mode === 'navigate' && e.request.destination === 'document') return e.respondWith(shellFile(new Request('/_anywhere/shell.html')));
  e.respondWith(throughTunnel(e));
});

// The shell's own files: from the cache at once, refreshed behind.
async function shellFile(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const fresh = fetch(req).then(r => { if (r.ok) cache.put(req, r.clone()).catch(() => {}); return r; }).catch(() => null);
  if (hit) return hit;
  return (await fresh) || new Response('Chattering cannot open without the network the first time.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

// Which shell carries the request: every top-level page of this site is
// one, all connected to the same computer. The one in front first.
async function pickShell() {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const tops = all.filter(c => c.frameType === 'top-level');
  return tops.find(c => c.focused) || tops.find(c => c.visibilityState === 'visible') || tops[0] || null;
}

const NOT_CONNECTED = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font:16px/1.5 system-ui,sans-serif;background:#101412;color:#dce3dd;display:grid;place-items:center;min-height:90vh;margin:0">
<p>Not connected to your computer. <a style="color:#7dd492" href="/">Open Chattering</a></p>`;

async function throughTunnel(e) {
  const req = e.request;
  if (req.mode === 'navigate' && req.method !== 'GET' && req.method !== 'HEAD') return new Response('Forms that leave the page are not carried to your computer.', { status: 405 });
  const shell = await pickShell();
  if (!shell) return new Response(NOT_CONNECTED, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const url = new URL(req.url);
  const headers = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer();
  const { port1, port2 } = new MessageChannel();
  shell.postMessage({ type: 'anywhere-fetch', method: req.method, path: url.pathname + url.search, headers, body, redirect: req.redirect, dest: req.destination }, body ? [port2, body] : [port2]);

  return new Promise(resolve => {
    let answered = false, ended = false, failed = null, notify = null;
    const queue = [];
    const wake = () => { const n = notify; notify = null; if (n) n(); };
    // Pulled as the page reads: each chunk taken tells the shell, which
    // tells the home it may send more.
    const stream = new ReadableStream({
      async pull(c) {
        while (!queue.length && !ended && !failed) await new Promise(r => { notify = r; });
        if (queue.length) { c.enqueue(queue.shift()); port1.postMessage({ type: 'pull' }); }
        else if (failed) c.error(failed);
        else c.close();
      },
      cancel() { port1.postMessage({ type: 'cancel' }); },
    }, new CountQueuingStrategy({ highWaterMark: 4 }));
    port1.onmessage = ev => {
      const m = ev.data || {};
      if (m.type === 'head' && !answered) {
        answered = true;
        const status = m.status;
        const loc = m.headers && m.headers.location;
        if (status >= 300 && status < 400 && loc && req.mode === 'navigate') { try { return resolve(Response.redirect(new URL(loc, location.origin).href, status === 301 || status === 302 || status === 303 || status === 307 || status === 308 ? status : 302)); } catch {} }
        const bodyless = req.method === 'HEAD' || status === 204 || status === 205 || status === 304;
        let h;
        try { h = new Headers(m.headers || {}); } catch { h = new Headers({ 'Content-Type': (m.headers && m.headers['content-type']) || 'application/octet-stream' }); }
        try { resolve(new Response(bodyless ? null : stream, { status: status >= 200 && status <= 599 ? status : 502, headers: h })); }
        catch { resolve(new Response(null, { status: 502 })); }
      } else if (m.type === 'chunk') { queue.push(new Uint8Array(m.bytes)); wake(); }
      else if (m.type === 'end') { ended = true; wake(); }
      else if (m.type === 'error') {
        if (!answered) { answered = true; resolve(req.mode === 'navigate' ? new Response(NOT_CONNECTED, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : Response.error()); }
        else { failed = new TypeError(m.message || 'the connection to your computer broke'); wake(); }
      }
    };
  });
}
