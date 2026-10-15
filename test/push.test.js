'use strict';
// Web Push from this computer (push.js, push-policy.js, push-notify.js; design/100).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const push = require('../push.js');
const policy = require('../push-policy.js');
const { createPushNotifier } = require('../push-notify.js');

// RFC 8291 Section 5 and Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('encryption matches RFC 8291 byte for byte, and decrypts back', () => {
  const out = push.encryptPayload(Buffer.from(RFC.plaintext), RFC.uaPublic, RFC.auth, { as: { privateKey: push.unb64u(RFC.asPrivate) }, salt: push.unb64u(RFC.salt) });
  assert.equal(push.b64u(out), RFC.body);
  assert.equal(push.decryptPayload(out, RFC.uaPrivate, RFC.uaPublic, RFC.auth).toString(), RFC.plaintext);
});

test('padding hides the length and still decrypts', () => {
  const a = push.encryptPayload('hi', RFC.uaPublic, RFC.auth, { padTo: 256 });
  const b = push.encryptPayload('hello there, a longer one', RFC.uaPublic, RFC.auth, { padTo: 256 });
  assert.equal(a.length, b.length);
  assert.equal(push.decryptPayload(b, RFC.uaPrivate, RFC.uaPublic, RFC.auth).toString(), 'hello there, a longer one');
});

test('a device key off the curve is refused', () => {
  const bad = push.b64u(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]));
  assert.throws(() => push.encryptPayload('x', bad, RFC.auth));
});

test('the VAPID token is a valid ES256 JWT for the push service origin', () => {
  const keys = push.makeVapidKeys();
  const header = push.vapidAuthorization(keys.privateJwk, 'https://fcm.googleapis.com/fcm/send/abc', { subject: 'https://rockfrog.ai', now: 1_700_000_000_000 });
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(m);
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: 1_700_000_000 + 12 * 3600, sub: 'https://rockfrog.ai' });
  const raw = push.unb64u(m[4]);
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: push.b64u(raw.subarray(1, 33)), y: push.b64u(raw.subarray(33)) }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(m[1] + '.' + m[2]), { key: pub, dsaEncoding: 'ieee-p1363' }, push.unb64u(m[3])));
});

test('only real push services and known relays may be posted to', () => {
  const ok = ['https://web.push.apple.com/QGuQyavXutnMo', 'https://fcm.googleapis.com/fcm/send/x:y', 'https://updates.push.services.mozilla.com/wpush/v2/g',
    'https://wns2-par02p.notify.windows.com/w/?token=x'];
  for (const e of ok) assert.ok(push.endpointAllowed(e), e);
  const bad = ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.com/x', 'https://evil.com/_push/x',
    'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'file:///etc/passwd', 'https://localhost/_push/x'];
  for (const e of bad) assert.ok(!push.endpointAllowed(e), e);
  assert.ok(push.endpointAllowed('https://relay.example/_push/abc', ['https://relay.example']));
  assert.ok(!push.endpointAllowed('https://relay.example/api/x', ['https://relay.example']));
});

// A local push service: records what it receives; `answer` decides the status.
function fakePushService(answer = () => 201) {
  const got = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      got.push({ path: req.url, headers: req.headers, body: Buffer.concat(parts) });
      const status = answer(req, got.length);
      res.writeHead(status, status === 429 ? { 'Retry-After': '0' } : {});
      res.end();
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, got, origin: 'http://127.0.0.1:' + server.address().port })));
}

// A device: its own keys, as a browser makes them.
function device() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { priv: push.b64u(ecdh.getPrivateKey()), keys: { p256dh: push.b64u(ecdh.getPublicKey()), auth: push.b64u(crypto.randomBytes(16)) } };
}

test('subscribe, send and read back a message; the store survives a restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  const svc = await fakePushService();
  t.after(() => svc.server.close());
  const service = push.createPushService({ dir, extraOrigins: () => [svc.origin] });
  const d = device();
  const rec = service.subscribe('u1', { endpoint: svc.origin + '/_push/abc', keys: d.keys }, { label: 'Pixel', prefs: { preview: false } });
  assert.equal(rec.label, 'Pixel');
  assert.equal(rec.prefs.preview, false);
  assert.equal(rec.prefs.replies, true);
  const r = await service.send(service.find('u1', rec.id), { hello: 'world' }, { ttl: 60, urgency: 'high', topic: 'cABC' });
  assert.ok(r.ok);
  const msg = svc.got[0];
  assert.equal(msg.headers['content-encoding'], 'aes128gcm');
  assert.equal(msg.headers.ttl, '60');
  assert.equal(msg.headers.urgency, 'high');
  assert.equal(msg.headers.topic, 'cABC');
  assert.match(msg.headers.authorization, /^vapid t=.+, k=/);
  assert.deepEqual(JSON.parse(push.decryptPayload(msg.body, d.priv, d.keys.p256dh, d.keys.auth)), { hello: 'world' });
  assert.equal(msg.body.length % 256, 86 + 16); // header + tag around a padded size class
  service.flush();
  const mode = fs.statSync(path.join(dir, 'subscriptions.json')).mode & 0o777;
  assert.equal(mode, 0o600);
  const again = push.createPushService({ dir, extraOrigins: () => [svc.origin] });
  assert.equal(again.publicKey, service.publicKey);
  assert.equal(again.forUser('u1').length, 1);
});

test('a device the push service says is gone is forgotten; a busy one is retried', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  const svc = await fakePushService((req, n) => req.url.endsWith('/gone') ? 410 : n === 2 ? 429 : 201);
  t.after(() => svc.server.close());
  const service = push.createPushService({ dir, extraOrigins: () => [svc.origin] });
  const busy = service.subscribe('u1', { endpoint: svc.origin + '/_push/busy', keys: device().keys });
  const gone = service.subscribe('u1', { endpoint: svc.origin + '/_push/gone', keys: device().keys });
  const r1 = await service.send(service.find('u1', gone.id), { a: 1 });
  assert.equal(r1.removed, true);
  assert.equal(service.forUser('u1').length, 1);
  const r2 = await service.send(service.find('u1', busy.id), { a: 2 });
  assert.ok(r2.ok, JSON.stringify(r2));
});

test('an address moves with the person who registers it; unknown services are refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  const service = push.createPushService({ dir });
  const d = device();
  service.subscribe('u1', { endpoint: 'https://fcm.googleapis.com/fcm/send/same', keys: d.keys });
  service.subscribe('u2', { endpoint: 'https://fcm.googleapis.com/fcm/send/same', keys: d.keys });
  assert.equal(service.forUser('u1').length, 0);
  assert.equal(service.forUser('u2').length, 1);
  assert.throws(() => service.subscribe('u1', { endpoint: 'http://10.0.0.1/x', keys: d.keys }), /not one Chattering knows/);
});

// ---- policy ----
const NOW = 1_800_000_000_000;
const row = o => ({ conn: 'c', userId: 'u', visible: true, focused: true, route: 'home', at: NOW - 1000, activeAt: NOW - 1000, ...o });

test('policy: quiet while looking at the conversation or using another screen', () => {
  const prefs = push.DEFAULT_PREFS;
  assert.equal(policy.decide({ kind: 'reply', key: 'k', prefs, rows: [], now: NOW }).send, true);
  assert.equal(policy.decide({ kind: 'reply', key: 'k', prefs, rows: [row({ route: 'conversation:k', focused: false, activeAt: NOW - 10 * 60000 })], now: NOW }).why, 'looking at it');
  assert.equal(policy.decide({ kind: 'reply', key: 'k', prefs, rows: [row({})], now: NOW }).why, 'at another screen');
  // Idle for three minutes, or the window not focused: away.
  assert.equal(policy.decide({ kind: 'reply', key: 'k', prefs, rows: [row({ activeAt: NOW - 3 * 60000 })], now: NOW }).send, true);
  assert.equal(policy.decide({ kind: 'reply', key: 'k', prefs, rows: [row({ focused: false })], now: NOW }).send, true);
  // A screen that stopped reporting (a laptop that slept) does not count.
  assert.equal(policy.decide({ kind: 'reply', key: 'k', prefs, rows: [row({ at: NOW - 10 * 60000 })], now: NOW }).send, true);
  // The device asked to be told anyway; and per-kind switches.
  assert.equal(policy.decide({ kind: 'reply', key: 'k', prefs: { ...prefs, whileActive: true }, rows: [row({})], now: NOW }).send, true);
  assert.equal(policy.decide({ kind: 'question', key: 'k', prefs: { ...prefs, questions: false }, rows: [], now: NOW }).send, false);
  assert.equal(policy.decide({ kind: 'test', key: null, prefs: { replies: false }, rows: [row({})], now: NOW }).send, true);
});

test('messages: preview off keeps the conversation words off the lock screen; the size stays under 3 KB', () => {
  const home = { id: 'h1', name: 'lambda' };
  const on = policy.messageFor({ kind: 'reply', key: 'pi:a', title: 'Push notes', excerpt: 'I added the sender.', prefs: { preview: true }, home, at: 1 });
  assert.equal(on.body, 'I added the sender.');
  assert.equal(on.url, '/#pi%3Aa');
  assert.equal(on.tag, policy.tagFor('h1', 'pi:a'));
  assert.match(on.tag, /^[A-Za-z0-9_-]{16}$/);
  const off = policy.messageFor({ kind: 'reply', key: 'pi:a', title: 'Push notes', excerpt: 'secret words', prefs: { preview: false }, home, at: 1 });
  assert.equal(off.body, 'Reply ready');
  const fan = policy.messageFor({ kind: 'reply', key: 'k', title: 't', excerpt: 'first', count: 3, prefs: {}, home, at: 1 });
  assert.equal(fan.body, '3 answers ready · first');
  const big = policy.messageFor({ kind: 'reply', key: 'k'.repeat(900), title: 'x'.repeat(400), excerpt: 'y '.repeat(2000), prefs: {}, home, open: Array(60).fill('cAAAAAAAAAAAAAAA'), at: 1 });
  assert.ok(JSON.stringify(big).length <= 3000);
});

test('notifier: waits, merges a burst, follows the rules per device, and remembers why', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  const svc = await fakePushService();
  t.after(() => svc.server.close());
  const service = push.createPushService({ dir, extraOrigins: () => [svc.origin] });
  const phone = device(), laptop = device();
  service.subscribe('me', { endpoint: svc.origin + '/_push/phone', keys: phone.keys }, { label: 'phone' });
  service.subscribe('me', { endpoint: svc.origin + '/_push/laptop', keys: laptop.keys }, { label: 'laptop', prefs: { replies: false } });
  const here = new policy.HereBook();
  const n = createPushNotifier({ service, here, home: async () => ({ id: 'h', name: 'lambda' }), recipients: () => ['me'],
    listed: key => key !== 'helper', unread: () => ({ count: 2, keys: ['a', 'b'] }), waitMs: 20 });
  n.notify('reply', { key: 'a', title: 'First', excerpt: 'one' });
  n.notify('reply', { key: 'a', title: 'First', excerpt: 'two' });
  n.notify('reply', { key: 'helper', title: 'Helper', excerpt: 'never' });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(svc.got.length, 1);
  const msg = JSON.parse(push.decryptPayload(svc.got[0].body, phone.priv, phone.keys.p256dh, phone.keys.auth));
  assert.equal(msg.body, 'two');
  assert.equal(msg.badge, 2);
  assert.deepEqual(msg.open, [policy.tagFor('h', 'a'), policy.tagFor('h', 'b')]);
  const why = n.recentFor('me')[0];
  assert.deepEqual(why.sent, [{ device: 'phone' }]);
  assert.deepEqual(why.skipped, [{ device: 'laptop', why: 'off for replies' }]);
  // At the laptop now: the phone stays quiet.
  here.set('conn1', 'me', { visible: true, focused: true, idleMs: 0, route: 'home' });
  n.notify('reply', { key: 'a', title: 'First', excerpt: 'three' });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(svc.got.length, 1);
  assert.equal(n.recentFor('me')[0].skipped[0].why, 'at another screen');
  // A question is not replaced by a reply arriving in the same wait.
  here.remove('conn1');
  n.notify('question', { key: 'a', title: 'First', detail: 'Allow edit?' });
  n.notify('reply', { key: 'a', title: 'First', excerpt: 'four' });
  await new Promise(r => setTimeout(r, 200));
  // Both devices take questions (the laptop turned off replies only).
  assert.equal(svc.got.length, 3);
  const q = svc.got.find(g => g.path.endsWith('/phone') && g !== svc.got[0]);
  assert.equal(JSON.parse(push.decryptPayload(q.body, phone.priv, phone.keys.p256dh, phone.keys.auth)).kind, 'question');
  // The test message ignores every rule.
  here.set('conn1', 'me', { visible: true, focused: true, idleMs: 0, route: 'home' });
  const r = await n.test('me', service.forUser('me')[1].id);
  assert.ok(r.ok);
  assert.equal(JSON.parse(push.decryptPayload(svc.got[3].body, laptop.priv, laptop.keys.p256dh, laptop.keys.auth)).kind, 'test');
});
