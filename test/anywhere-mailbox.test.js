'use strict';
// The relay's mailbox: Web Push for the Android app (anywhere/mailbox.js, design/100).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRelay } = require('../anywhere/relay.js');
const { idOf } = require('../anywhere/mailbox.js');
const push = require('../push.js');

function startRelay() {
  const relay = createRelay({ env: { USAGE_FILE: '' } });
  return new Promise(r => relay.server.listen(0, '127.0.0.1', () => r({ relay, origin: 'http://127.0.0.1:' + relay.server.address().port })));
}
function phone() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const secret = crypto.randomBytes(32).toString('base64url');
  return { secret, priv: push.b64u(ecdh.getPrivateKey()), keys: { p256dh: push.b64u(ecdh.getPublicKey()), auth: push.b64u(crypto.randomBytes(16)) } };
}
function listen(origin, secret, { ack = true } = {}) {
  const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/_push/listen');
  const got = [];
  let wake = null;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'listen', secret }));
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.t === 'push') { got.push(m); if (ack) ws.send(JSON.stringify({ t: 'ack', id: m.id })); }
    if (wake) wake();
  };
  const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => { wake = r; setTimeout(r, 50); }); } };
  return { ws, got, until, ready: new Promise(r => { ws.addEventListener('message', ev => { if (JSON.parse(ev.data).t === 'ready') r(); }); }) };
}

test('a computer posts, the app reads it, only the app can open it', async t => {
  const { relay, origin } = await startRelay();
  t.after(() => relay.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-'));
  const service = push.createPushService({ dir, extraOrigins: () => [origin] });
  const p = phone();
  const rec = service.subscribe('me', { endpoint: origin + '/_push/' + idOf(p.secret), keys: p.keys }, { kind: 'android-app', label: 'app' });
  // Waiting before the app connects: kept.
  assert.ok((await service.send(service.find('me', rec.id), { n: 1 }, { ttl: 60, topic: 'cA' })).ok);
  const l = listen(origin, p.secret);
  await l.ready;
  await l.until(() => l.got.length === 1);
  assert.deepEqual(JSON.parse(push.decryptPayload(Buffer.from(l.got[0].body, 'base64'), p.priv, p.keys.p256dh, p.keys.auth)), { n: 1 });
  // While connected: straight through.
  assert.ok((await service.send(service.find('me', rec.id), { n: 2 }, { ttl: 60, urgency: 'high' })).ok);
  await l.until(() => l.got.length === 2);
  assert.equal(l.got[1].urgency, 'high');
  l.ws.close();
  // Acknowledged messages are gone: a new connection gets nothing old.
  await new Promise(r => setTimeout(r, 100));
  const l2 = listen(origin, p.secret);
  await l2.ready;
  await new Promise(r => setTimeout(r, 200));
  assert.equal(l2.got.length, 0);
  l2.ws.close();
});

test('unacknowledged messages come again; a newer one on the same topic replaces the older', async t => {
  const { relay, origin } = await startRelay();
  t.after(() => relay.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-'));
  const service = push.createPushService({ dir, extraOrigins: () => [origin] });
  const p = phone();
  const rec = service.subscribe('me', { endpoint: origin + '/_push/' + idOf(p.secret), keys: p.keys });
  for (const n of [1, 2, 3]) await service.send(service.find('me', rec.id), { n }, { ttl: 60, topic: n < 3 ? 'same' : 'other' });
  const l = listen(origin, p.secret, { ack: false });
  await l.ready;
  await l.until(() => l.got.length === 2);
  await new Promise(r => setTimeout(r, 100));
  const ns = l.got.map(m => JSON.parse(push.decryptPayload(Buffer.from(m.body, 'base64'), p.priv, p.keys.p256dh, p.keys.auth)).n);
  assert.deepEqual(ns.sort(), [2, 3]);
  l.ws.close();
  await new Promise(r => setTimeout(r, 100));
  const l2 = listen(origin, p.secret);
  await l2.ready;
  await l2.until(() => l2.got.length === 2);
  l2.ws.close();
});

test('refusals: bad ids, plain bodies, too large, too many', async t => {
  const { relay, origin } = await startRelay();
  t.after(() => relay.close());
  const post = (p, body, headers = {}) => fetch(origin + p, { method: 'POST', body, headers: { 'Content-Encoding': 'aes128gcm', TTL: '60', ...headers } });
  assert.equal((await post('/_push/short', Buffer.alloc(200))).status, 404);
  const id = idOf(crypto.randomBytes(32).toString('base64url'));
  assert.equal((await post('/_push/' + id, Buffer.alloc(200), { 'Content-Encoding': 'identity' })).status, 400);
  await assert.rejects(async () => { const r = await post('/_push/' + id, Buffer.alloc(9000)); if (r.status !== 413) throw new Error(String(r.status)); });
  assert.equal((await fetch(origin + '/_push/' + id)).status, 405);
  let last = 0;
  for (let i = 0; i < 70; i++) last = (await post('/_push/' + id, Buffer.alloc(200))).status;
  assert.equal(last, 429);
});

test('the app must say a well-formed secret, and a second connection replaces the first', async t => {
  const { relay, origin } = await startRelay();
  t.after(() => relay.close());
  const bad = new WebSocket(origin.replace(/^http/, 'ws') + '/_push/listen');
  const closed = new Promise(r => { bad.onclose = ev => r(ev.reason); });
  bad.onopen = () => bad.send(JSON.stringify({ t: 'listen', secret: 'short' }));
  assert.equal(await closed, 'bad secret');
  const p = phone();
  const a = listen(origin, p.secret); await a.ready;
  const aClosed = new Promise(r => { a.ws.onclose = ev => r(ev.reason); });
  const b = listen(origin, p.secret); await b.ready;
  assert.match(await aClosed, /replaced/);
  b.ws.close();
});
