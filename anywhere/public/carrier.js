/* Chattering Anywhere, the previews' carrier (design/67, design/85).

   What agents make (web pages, slides, widgets) runs on an address that is
   not the app's, so a page may run any script without acting as the person
   inside Chattering. Through the relay that address is previews.<relay>.
   The shell holds this page there, hidden. It installs that site's service
   worker (sw.js, which sends every request of the site here) and passes
   each request on to the shell, which carries it through the tunnel to the
   computer's preview server. The answers go straight from the shell to the
   worker; nothing passes through here twice, nothing is kept.

   Any page on this site could do what this one does (they share it), so
   the shell grants it nothing more than a preview could ask for anyway:
   an artifact's files, read-only, and only those (the computer checks). */
(function () {
  'use strict';
  if (window.parent === window || !location.hostname.startsWith('previews.')) return;
  // The shell is the relay's own page: this name without "previews.".
  const SHELL = location.protocol + '//' + location.host.slice('previews.'.length);
  const tell = (m, transfer) => window.parent.postMessage({ type: 'anywhere-carrier', ...m }, SHELL, transfer || []);
  (async () => {
    if (!('serviceWorker' in navigator)) throw new Error('this browser has no service workers here');
    const { port1, port2 } = new MessageChannel();
    navigator.serviceWorker.addEventListener('message', ev => {
      const m = ev.data;
      if (m && m.type === 'anywhere-fetch' && ev.ports[0]) port1.postMessage(m, [ev.ports[0]]);
    });
    navigator.serviceWorker.startMessages();
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // Active: from now on every page of this site goes through it.
    await navigator.serviceWorker.ready;
    tell({ ready: true }, [port2]);
  })().catch(e => tell({ failed: String(e && e.message || e) }));
})();
