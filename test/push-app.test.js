'use strict';
// Notifications in the app (push-ui.js, push-worker.js, the /api/push routes; design/100):
// Settings turns them on for this browser, the computer delivers to the
// browser's push service encrypted, the service worker shows one notification
// per conversation and the page clears those read meanwhile.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { viewerBrowser } = require('./helpers/viewer-browser.js');
const push = require('../push.js');

// The browser's push service, here: what the computer posts lands in `got`.
function fakePushService() {
  const got = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => { got.push({ path: req.url, headers: req.headers, body: Buffer.concat(parts) }); res.writeHead(201); res.end(); });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, got, origin: 'http://127.0.0.1:' + server.address().port })));
}

test('settings turns notifications on, a test arrives encrypted, the worker shows and the page clears them', { timeout: 120000 }, async t => {
  const svc = await fakePushService();
  t.after(() => svc.server.close());
  const app = await viewerBrowser(t, { env: { CHATTERING_PUSH_ORIGINS: svc.origin } });
  const { base, auth, evaluate, until, command, browser, onEvent } = app;
  await browser('Browser.grantPermissions', { origin: base, permissions: ['notifications'] });

  // A refused address: not a push service.
  const bad = await fetch(base + '/api/push/subscribe', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: { endpoint: 'http://127.0.0.1:9/x', keys: { p256dh: 'x', auth: 'y' } } }) });
  assert.equal(bad.status, 400);

  // This browser's subscription, made by "the browser's push service":
  // keys held by the test so it can read what the computer sends.
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const dev = { priv: push.b64u(ecdh.getPrivateKey()), p256dh: push.b64u(ecdh.getPublicKey()), auth: push.b64u(crypto.randomBytes(16)) };
  const endpoint = svc.origin + '/_push/browser-' + crypto.randomBytes(6).toString('hex');
  await evaluate(`(() => {
    let sub = null;
    PushManager.prototype.getSubscription = async function () { return sub; };
    PushManager.prototype.subscribe = async function (opts) {
      window.__subscribeKey = btoa(String.fromCharCode(...new Uint8Array(opts.applicationServerKey))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
      const json = { endpoint: ${JSON.stringify(endpoint)}, expirationTime: null, keys: { p256dh: ${JSON.stringify(dev.p256dh)}, auth: ${JSON.stringify(dev.auth)} } };
      sub = { endpoint: json.endpoint, options: { applicationServerKey: opts.applicationServerKey }, toJSON: () => json, unsubscribe: async () => { sub = null; return true; } };
      return sub;
    };
    return true;
  })()`);

  await evaluate(`location.hash = '#settings=notifications'`);
  await until(`document.querySelector('#pushPane .push-here')`, 'the notifications pane');
  assert.match(await evaluate(`document.querySelector('#pushPane').textContent`), /Off for this device/);
  await evaluate(`document.querySelector('[data-push=on]').click()`);
  await until(`/On for this device/.test(document.querySelector('#pushPane')?.textContent || '')`, 'turned on');
  const info = await (await fetch(base + '/api/push', { headers: auth })).json();
  assert.equal(info.devices.length, 1);
  assert.equal(info.devices[0].kind, 'web');
  assert.equal(await evaluate('window.__subscribeKey'), info.publicKey);

  // Send a test: it reaches the push service, readable only with the device's keys.
  await evaluate(`document.querySelector('#pushPane [data-push=test]').click()`);
  for (let i = 0; i < 100 && !svc.got.length; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(svc.got.length, 1);
  assert.match(svc.got[0].headers.authorization, /^vapid t=/);
  const msg = JSON.parse(push.decryptPayload(svc.got[0].body, dev.priv, dev.p256dh, dev.auth));
  assert.equal(msg.kind, 'test');
  assert.equal(msg.home.id, info.home.id);

  // A preference, saved on the computer.
  await evaluate(`(() => { const b = document.querySelector('[data-push-pref=preview]'); b.checked = false; b.dispatchEvent(new Event('change')); })()`);
  for (let i = 0; i < 60; i++) { const d = await (await fetch(base + '/api/push', { headers: auth })).json(); if (d.devices[0].prefs.preview === false) break; await new Promise(r => setTimeout(r, 50)); }
  assert.equal((await (await fetch(base + '/api/push', { headers: auth })).json()).devices[0].prefs.preview, false);

  // The service worker: a push becomes one notification per conversation.
  const regs = [];
  const off = onEvent(m => { if (m.method === 'ServiceWorker.workerRegistrationUpdated') regs.push(...m.params.registrations); });
  await command('ServiceWorker.enable');
  for (let i = 0; i < 100 && !regs.some(r => r.scopeURL === base + '/'); i++) await new Promise(r => setTimeout(r, 50));
  off();
  const reg = regs.find(r => r.scopeURL === base + '/');
  assert.ok(reg, 'the app registers its service worker');
  await until(`navigator.serviceWorker.controller || true`);
  const home = info.home.id;
  const deliver = m => command('ServiceWorker.deliverPushMessage', { origin: base, registrationId: reg.registrationId, data: JSON.stringify(m) });
  const note = (key, body, extra = {}) => ({ v: 1, kind: 'reply', title: 'Conversation ' + key, body, tag: 't-' + key, key, url: '/#' + key, home: { id: home, name: 'here' }, renotify: true, at: Date.now(), ...extra });
  await deliver(note('one', 'first words'));
  await deliver(note('two', 'other words'));
  await deliver(note('one', 'newer words'));
  const shown = async () => evaluate(`navigator.serviceWorker.ready.then(r => r.getNotifications()).then(ns => ns.map(n => ({ title: n.title, body: n.body, tag: n.tag, data: n.data })))`);
  let list = [];
  for (let i = 0; i < 100; i++) { list = await shown(); if (list.length === 2 && list.some(n => n.body === 'newer words')) break; await new Promise(r => setTimeout(r, 50)); }
  assert.deepEqual(list.map(n => n.tag).sort(), ['t-one', 't-two']);
  const one = list.find(n => n.tag === 't-one');
  assert.equal(one.body, 'newer words');
  assert.deepEqual(one.data, { url: '/#one', key: 'one', home, tag: 't-one', kind: 'reply' });

  // A later push names what is still unread: the rest go.
  await deliver(note('three', 'third', { open: ['t-three', 't-two'] }));
  for (let i = 0; i < 100; i++) { list = await shown(); if (list.some(n => n.tag === 't-three') && list.length === 2) break; await new Promise(r => setTimeout(r, 50)); }
  assert.deepEqual(list.map(n => n.tag).sort(), ['t-three', 't-two']);

  // The page knows what is read: those notifications go when it looks.
  // (The app's own unread list says so; here it holds one conversation.)
  await evaluate(`(() => { finishedUnreadSessions = () => [{ key: 'two' }]; updateActiveBtn(); return true; })()`);
  for (let i = 0; i < 100; i++) { list = await shown(); if (list.length === 1) break; await new Promise(r => setTimeout(r, 50)); }
  assert.deepEqual(list.map(n => n.tag), ['t-two']);

  // An unreadable push still shows something (Safari ends silent subscriptions).
  await deliver('not json');
  for (let i = 0; i < 100; i++) { list = await shown(); if (list.some(n => n.tag === 'chattering')) break; await new Promise(r => setTimeout(r, 50)); }
  assert.ok(list.some(n => n.tag === 'chattering' && n.title === 'Chattering'));

  // Turn off: the computer forgets this device.
  await evaluate(`document.querySelector('#pushPane [data-push=off]').click()`);
  await until(`/Off for this device/.test(document.querySelector('#pushPane')?.textContent || '')`, 'turned off');
  assert.equal((await (await fetch(base + '/api/push', { headers: auth })).json()).devices.length, 0);
  assert.deepEqual(app.exceptions, []);
});
