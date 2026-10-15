'use strict';
// A real reply becomes a notification (server.js pushRunFinal, design/100):
// the person who asked gets it on their device, with the reply's first
// words and the unread count; while they look at the conversation, nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { viewerBrowser } = require('./helpers/viewer-browser.js');
const { fakeOpenAI } = require('./helpers/fake-openai.js');
const { chromiumAvailable } = require('./helpers/chromium.js');
const push = require('../push.js');

function fakePushService() {
  const got = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => { got.push({ path: req.url, headers: req.headers, body: Buffer.concat(parts) }); res.writeHead(201); res.end(); });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, got, origin: 'http://127.0.0.1:' + server.address().port })));
}

test('a finished reply reaches the asker’s phone; not while they read it', { skip: !chromiumAvailable() && 'chromium is not installed', timeout: 180000 }, async t => {
  const model = await fakeOpenAI({ reply: 'The plan is ready: three steps, the first is tests.' });
  t.after(() => model.close());
  const svc = await fakePushService();
  t.after(() => svc.server.close());
  const app = await viewerBrowser(t, { env: { CHATTERING_PUSH_ORIGINS: svc.origin } });
  const { base, auth, command, evaluate, until } = app;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const d = await r.json(); assert.ok(r.ok, p + ': ' + JSON.stringify(d)); return d; };

  const server = await post('/api/ai/server', { baseUrl: model.baseUrl });
  const key = 'pi:fixture/media.jsonl';
  await post('/api/agent-read', { open: [key] });
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const dev = { priv: push.b64u(ecdh.getPrivateKey()), p256dh: push.b64u(ecdh.getPublicKey()), auth: push.b64u(crypto.randomBytes(16)) };
  await post('/api/push/subscribe', { subscription: { endpoint: svc.origin + '/_push/phone', keys: { p256dh: dev.p256dh, auth: dev.auth } }, label: 'phone', kind: 'web' });

  // Nobody at a screen: the page goes away, its connection with it.
  await command('Page.navigate', { url: 'about:blank' });
  await new Promise(r => setTimeout(r, 3000));
  await post('/api/node/send', { id: key, prompt: 'Make a plan', models: [{ provider: server.name, modelId: 'fixture-chat' }] });
  for (let i = 0; i < 300 && !svc.got.length; i++) await new Promise(r => setTimeout(r, 100));
  if (svc.got.length !== 1) {
    const info = await (await fetch(base + '/api/push', { headers: auth })).json();
    const jobs = await (await fetch(base + '/api/jobs', { headers: auth })).json().catch(() => null);
    assert.fail(JSON.stringify({ recent: info.recent, asked: model.requests.length, jobs: JSON.stringify(jobs).slice(0, 1500), read: await (await fetch(base + '/api/agent-read', { headers: auth })).json() }) + app.log().slice(-2000));
  }
  const msg = JSON.parse(push.decryptPayload(svc.got[0].body, dev.priv, dev.p256dh, dev.auth));
  assert.equal(msg.kind, 'reply');
  assert.equal(msg.key, key);
  assert.equal(msg.title, 'File viewer fixture');
  assert.match(msg.body, /^The plan is ready/);
  assert.equal(msg.url, '/#' + encodeURIComponent(key));
  assert.equal(msg.badge, 1);
  assert.equal(svc.got[0].headers.urgency, 'high');
  assert.equal(svc.got[0].headers.topic, msg.tag);

  // Reading it on a screen: the next reply does not buzz the phone.
  await command('Page.navigate', { url: base + '/#' + encodeURIComponent(key) });
  await until(`typeof viewKind !== 'undefined' && viewKind === 'conversation' && typeof peopleState !== 'undefined' && peopleState.conn`, 'the conversation open');
  await evaluate(`PushUI.report(true)`);
  await new Promise(r => setTimeout(r, 500));
  await post('/api/node/send', { id: key, prompt: 'And again', models: [{ provider: server.name, modelId: 'fixture-chat' }] });
  // The reply lands on the open conversation, which reads it at once: the
  // waiting notification is dropped (or, had it gone out, the rule
  // "looking at it" holds it back). Either way the phone stays quiet.
  for (let i = 0; i < 300; i++) {
    const jobs = await (await fetch(base + '/api/jobs', { headers: auth })).json();
    if (jobs.filter(j => j.type === 'agent-run' && j.status === 'done').length >= 2) break;
    await new Promise(r => setTimeout(r, 100));
  }
  await new Promise(r => setTimeout(r, 3000));
  assert.equal(svc.got.length, 1, 'no second notification');
  const recent = (await (await fetch(base + '/api/push', { headers: auth })).json()).recent;
  assert.ok(!recent.slice(0, -1).some(r => r.sent.length), JSON.stringify(recent));
});
