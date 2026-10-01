'use strict';
// Two real Chattering servers and a relay (design/90): B links to A through
// its settings; A opens at B's local address, for B's person only; B's
// switcher lists it; removing the link closes the address.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const { createRelay } = require('../anywhere/relay.js');
const { loadRtc } = require('../anywhere-home.js');

const root = path.join(__dirname, '..');
const rtc = loadRtc(root);
after(async () => { await new Promise(r => setTimeout(r, 300)); if (rtc.cleanup) rtc.cleanup(); setTimeout(() => process.exit(), 1000); });
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
const until = async (fn, label, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out: ' + label); await new Promise(r => setTimeout(r, 100)); } };

async function chattering(t, name, token, relayUrl, linkBase) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'links-' + name + '-')));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  const port = await freePort();
  registerConsole(port, token);
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(await freePort()), CHATTERING_PREVIEW_PORT: String(await freePort()),
    CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, CHATTERING_HOST: '', CHATTERING_LAN: '', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: token, CHATTERING_HOSTNAME: name, CHATTERING_LINK_PORT_BASE: String(linkBase) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  await until(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } }, name);
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
  await post('/api/anywhere/settings', { relay: relayUrl });
  return { base, post, log: () => log };
}

test('Given delayed relay registration, When Chattering links through settings, Then its private local address works', { skip: rtc.error || false, timeout: 120000 }, async t => {
  const relay = createRelay({ env: {} });
  await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
  t.after(() => relay.close());
  const relayUrl = 'http://127.0.0.1:' + relay.server.address().port;
  const linkBase = 31000 + Math.floor(Math.random() * 20000);
  const A = await chattering(t, 'lambda', 'tok-a', relayUrl, linkBase + 100);
  const B = await chattering(t, 'xpswhite', 'tok-b', relayUrl, linkBase);

  // Hold the real home WebSocket before its registration proof reaches the relay.
  let held;
  relay.server.on('upgrade', (req, socket) => { if (!held) { held = socket; socket.pause(); } });
  const code = await A.post('/api/anywhere/pair');
  await until(() => held, 'the registration socket');
  assert.ok(code.url, JSON.stringify(code));
  held.resume();
  // pair() issues a code, not a relay-registration acknowledgement.
  await until(async () => (await (await fetch(A.base + '/api/anywhere')).json()).relayState === 'ready', 'A registered on the relay');
  const linked = await B.post('/api/anywhere/links/add', { link: code.url });
  assert.equal(linked.error, undefined, linked.error);
  assert.equal(linked.links.length, 1);
  assert.equal(linked.links[0].name, 'lambda');
  assert.equal(linked.links[0].port, linkBase);
  // A lists B as one of its devices.
  const aSees = await (await fetch(A.base + '/api/anywhere')).json();
  assert.equal(aSees.devices[0].name, 'xpswhite · Chattering');
  // B's switcher has it.
  const bSettings = await (await fetch(B.base + '/api/settings')).json();
  assert.deepEqual(bSettings.anywhereLinks.map(l => l.name), ['lambda']);

  // B's person, signed in to B (B's cookie reaches every localhost port),
  // opens A: A's own pages and A's own data.
  const login = await fetch(B.base.replace('127.0.0.1', 'localhost') + '/?token=tok-b', { redirect: 'manual' });
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^chattering(_[0-9a-f]+)?=/, 'this install\'s own sign-in cookie');
  const at = `http://localhost:${linkBase}`;
  const page = await fetch(at + '/', { headers: { Cookie: cookie, Accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>[^<]*Chattering/i);
  const whoThere = await (await fetch(at + '/api/settings', { headers: { Cookie: cookie } })).json();
  assert.equal(whoThere.hostname, 'lambda', 'the settings of A, not of B');
  // Nobody else: no sign-in, or a sign-in B does not know.
  assert.equal((await fetch(at + '/api/settings')).status, 401);
  assert.equal((await fetch(at + '/api/settings', { headers: { Cookie: 'chattering=someone-else' } })).status, 401);
  // The switcher's check, then removal: the address closes.
  const check = await (await fetch(B.base + '/api/anywhere/links/check?id=' + linked.links[0].id)).json();
  assert.equal(check.ok, true);
  const removed = await B.post('/api/anywhere/links/remove', { id: linked.links[0].id });
  assert.deepEqual(removed.links, []);
  await assert.rejects(fetch(at + '/api/settings', { headers: { Cookie: cookie } }));
  assert.doesNotMatch(B.log() + A.log(), /anywhere link .*: port/, 'no port trouble');
});
