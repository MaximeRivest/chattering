// Minimal service worker: it exists so the app installs as a PWA, and it
// keeps the large vendor bundles (document editor, mermaid) in a cache.
// Vendor files answer from the cache at once and revalidate in the
// background (stale-while-revalidate), so an upgraded bundle takes effect
// on the next load and a plain reload never re-downloads 1–4 MB.
// Everything else goes straight to the network: the app's own freshness
// rules (ETag + no-cache) stay with the server.
const VENDOR_CACHE = 'chattering-vendor-v1';

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== VENDOR_CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  // Not answered here at all: the browser fetches it as it would with no
  // worker. (Answering with fetch(req) made a page opened by the person a
  // request of this worker's, no longer a navigation, which the way back
  // through an encrypted link refuses, design/90.)
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/vendor/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(VENDOR_CACHE);
    const hit = await cache.match(req);
    const refresh = fetch(req).then(res => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { event.waitUntil(refresh); return hit; }
    const fresh = await refresh;
    return fresh || Response.error();
  })());
});
