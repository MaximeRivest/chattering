'use strict';
// Chattering Anywhere on a real Chattering server (design/85): the settings
// routes, a phone pairing through a real relay, its requests arriving as
// its person and never as this machine's console, and the People panel's
// revocation cutting it off.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const P = require('../anywhere/protocol.js');
const Client = require('../anywhere/client.js');
const { createRelay } = require('../anywhere/relay.js');
const { loadRtc } = require('../anywhere-home.js');

const root = path.join(__dirname, '..');
const rtc = loadRtc(root);
// The WebRTC library's threads (RTC poll, SCTP timer) can keep a process
// alive even after its cleanup. The server always ends with process.exit,
// which stops them; so does this file, once its tests have reported
// (process.exit() keeps the exit code the test runner set).
after(async () => { await new Promise(r => setTimeout(r, 300)); if (rtc.cleanup) rtc.cleanup(); setTimeout(() => process.exit(), 1000); });
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
const until = async (fn, label, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out: ' + label); await new Promise(r => setTimeout(r, 100)); } };
function through(tunnel, req) {
  return new Promise((resolve, reject) => {
    let head = null; const parts = [];
    const h = tunnel.request(req, {
      onHead: x => { head = x; },
      onChunk: b => { parts.push(Buffer.from(b)); h.consumed(b.length); },
      onEnd: () => { const body = Buffer.concat(parts); resolve({ ...head, text: (head.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(body) : body).toString() }); },
      onError: reject,
    });
  });
}

test('a phone through the relay is its person, never the console; People revokes it', { skip: rtc.error || false, timeout: 90000 }, async t => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-server-')));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  const relay = createRelay({ env: {} });
  await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
  t.after(() => relay.close());
  const relayUrl = 'http://127.0.0.1:' + relay.server.address().port;
  const port = await freePort(), tlsPort = await freePort();
  registerConsole(port, 'install-tok');
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(tlsPort), CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    CHATTERING_HOST: '', CHATTERING_LAN: '', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: 'install-tok', CHATTERING_HOSTNAME: 'lambda' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  await until(async () => { try { return (await fetch(base + '/health')).ok; } catch { return false; } }, 'the server');
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();

  // Nothing paired: the component is here, the relay untouched.
  let st = await (await fetch(base + '/api/anywhere')).json();
  assert.equal(st.available, true, st.why);
  assert.equal(st.relay, 'https://encrypted-link-to-your-devices.rockfrog.ai', 'Rockfrog\'s relay unless the owner names another');
  assert.equal(st.relayState, 'off');
  assert.deepEqual(st.devices, []);
  assert.match(st.homeId, /^[A-Za-z0-9_-]{22}$/);
  // Only an https relay (or one on this computer).
  assert.match((await post('/api/anywhere/settings', { relay: 'http://relay.example' })).error, /https/);
  st = await post('/api/anywhere/settings', { relay: relayUrl + '/' });
  assert.equal(st.relay, relayUrl);
  assert.equal(JSON.parse(fs.readFileSync(path.join(require('./helpers/home-env.js').appDir(home, 'config'), 'settings.json'), 'utf8')).anywhere.relay, relayUrl);

  // A code: a link and its picture.
  const code = await post('/api/anywhere/pair');
  assert.ok(code.url.startsWith(relayUrl + '/#pair='), code.url);
  assert.match(code.svg, /^<svg[^>]+viewBox="0 0 \d+ \d+"/);
  assert.equal(code.app.url, 'https://github.com/MaximeRivest/chattering/releases/download/android/Chattering-android.apk');
  assert.match(code.app.svg, /^<svg/);
  assert.ok(code.expiresAt > Date.now() + 9 * 60e3);
  await until(async () => (await (await fetch(base + '/api/anywhere')).json()).relayState === 'ready', 'on the relay while the code shows');
  const shown = await (await fetch(base + '/api/anywhere/pairing?id=' + code.id)).json();
  assert.equal(shown.paired, null);

  // The phone.
  const link = P.readPairingLink(new URL(code.url).hash);
  assert.equal(link.name, 'lambda');
  const pair = await P.subtle().generateKey(P.ECDSA, false, ['sign', 'verify']);
  const device = { privateKey: pair.privateKey, spki: new Uint8Array(await P.subtle().exportKey('spki', pair.publicKey)) };
  const tunnel = await Client.connect({ relay: relayUrl, homeId: link.homeId, device, pairing: { id: link.id, secret: link.secret }, name: 'iPhone · Safari', RTCPeerConnection: rtc.RTCPeerConnection, WebSocket, timeoutMs: 20000 });
  t.after(() => tunnel.close());
  assert.equal(tunnel.home.name, 'lambda');
  const paired = await (await fetch(base + '/api/anywhere/pairing?id=' + code.id)).json();
  assert.equal(paired.paired.name, 'iPhone · Safari', 'the settings page sees the phone arrive');

  // The app, through the tunnel.
  const page = await through(tunnel, { method: 'GET', path: '/', headers: { accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>[^<]*Chattering/i);
  const me = JSON.parse((await through(tunnel, { method: 'GET', path: '/api/anywhere' })).text);
  assert.equal(me.devices.length, 1);
  assert.equal(me.devices[0].online, true);
  // The phone is the owner as a person, not this machine's console.
  const action = await through(tunnel, { method: 'POST', path: '/api/path/action', headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') });
  assert.equal(action.status, 403);
  assert.match(action.text, /only on the laptop/);
  // Its credential is listed in People like any device link.
  const users = await (await fetch(base + '/api/users')).json();
  const owner = users.users.find(u => u.role === 'owner');

  // Revoked in People: cut off now, and not back.
  const roster = JSON.parse(fs.readFileSync(path.join(require('./helpers/home-env.js').appDir(home, 'config'), 'users.json'), 'utf8'));
  const cred = roster.users.find(u => u.id === owner.id).credentials.find(c => /iPhone · Safari · anywhere/.test(c.label || ''));
  assert.ok(cred, 'the phone\'s credential, labelled');
  const lost = new Promise(r => tunnel.onLost(r));
  const revoked = await post('/api/users/revoke', { id: owner.id, credentialId: cred.id });
  assert.equal(revoked.revoked, cred.id, JSON.stringify(revoked));
  assert.match(await lost, /removed/);
  st = await (await fetch(base + '/api/anywhere')).json();
  assert.deepEqual(st.devices, []);
  await until(async () => (await (await fetch(base + '/api/anywhere')).json()).relayState === 'off', 'nothing paired: off the relay');

  // Off: no codes.
  st = await post('/api/anywhere/settings', { off: true });
  assert.equal(st.enabled, false);
  assert.match((await post('/api/anywhere/pair')).error, /turned off/);
  assert.doesNotMatch(log, /anywhere: /, log.slice(-2000));
});
