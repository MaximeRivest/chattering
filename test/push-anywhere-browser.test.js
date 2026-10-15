'use strict';
// Notifications on a phone through the encrypted link (design/100): the
// iPhone home-screen icon, paired with two computers, turns notifications on
// in each. One browser subscription serves both (the phone's own signing key,
// given to each computer); each computer's test arrives signed with it; the
// relay's worker shows a notification naming its computer, and opening one
// switches the phone to that computer. Two real Chattering servers, a relay,
// and a stand-in for the browser's push service.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const { chromiumBinary, chromiumAvailable, CHROMIUM_TEST_FLAGS } = require('./helpers/chromium.js');
const { createRelay } = require('../anywhere/relay.js');
const { loadRtc } = require('../anywhere-home.js');
const P = require('../anywhere/protocol.js');

const root = path.join(__dirname, '..');
const rtc = loadRtc(root);
after(async () => { await new Promise(r => setTimeout(r, 300)); if (rtc.cleanup) rtc.cleanup(); setTimeout(() => process.exit(), 1000); });
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const http = require('node:http');
const crypto = require('node:crypto');
const push = require('../push.js');
let PUSH_ORIGIN = '';
async function chattering(t, name) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-switch-')));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  const port = await freePort(), tlsPort = await freePort(), previewPort = await freePort();
  const token = 'tok-' + name;
  registerConsole(port, token);
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(tlsPort), CHATTERING_PREVIEW_PORT: String(previewPort), CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    CHATTERING_HOST: '', CHATTERING_LAN: '', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: token, CHATTERING_HOSTNAME: name, CHATTERING_PUSH_ORIGINS: PUSH_ORIGIN }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; ; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} if (i > 200) assert.fail(name + ' did not start\n' + log); await sleep(100); }
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
  return { base, post, log: () => log };
}

test('one notification address serves every computer the phone is paired with', { skip: rtc.error || (!chromiumAvailable() && 'chromium is not installed'), timeout: 180000 }, async t => {
  // The browser's push service, here.
  const got = [];
  const svc = http.createServer((req, res) => { const parts = []; req.on('data', c => parts.push(c)); req.on('end', () => { got.push({ headers: req.headers, body: Buffer.concat(parts) }); res.writeHead(201); res.end(); }); });
  await new Promise(r => svc.listen(0, '127.0.0.1', r));
  t.after(() => svc.close());
  PUSH_ORIGIN = 'http://127.0.0.1:' + svc.address().port;
  const relay = createRelay({ env: {}, noCache: true });
  await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
  t.after(() => relay.close());
  const relayUrl = 'http://127.0.0.1:' + relay.server.address().port;
  const lambda = await chattering(t, 'lambda');
  const laptop = await chattering(t, 'LILLY-PC');
  for (const c of [lambda, laptop]) await c.post('/api/anywhere/settings', { relay: relayUrl });
  const lambdaId = (await (await fetch(lambda.base + '/api/anywhere')).json()).homeId;
  const laptopId = (await (await fetch(laptop.base + '/api/anywhere')).json()).homeId;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-anywhere-browser-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const browser = spawn(chromiumBinary(), [...CHROMIUM_TEST_FLAGS, '--user-data-dir=' + tmp, '--remote-debugging-port=0', '--disable-features=WebRtcHideLocalIpsWithMdns', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => { try { browser.kill('SIGKILL'); } catch {} });
  const endpoint = await new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(Error(out)), 15000);
    browser.stderr.on('data', b => { out += b; const m = out.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
  });
  const ws = new WebSocket(endpoint); await new Promise(res => ws.onopen = res);
  t.after(() => ws.close());
  let id = 0; const pending = new Map(), problems = [], regs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'ServiceWorker.workerRegistrationUpdated') regs.push(...m.params.registrations);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const ctx = (await send('Target.createBrowserContext')).result.browserContextId;
  await send('Browser.grantPermissions', { browserContextId: ctx, origin: relayUrl, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite', 'notifications'] });
  const target = await send('Target.createTarget', { url: 'about:blank', browserContextId: ctx });
  const sid = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
  await send('Runtime.enable', {}, sid); await send('Page.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sid);
  await send('Emulation.setUserAgentOverride', { userAgent: IPHONE, platform: 'iPhone' }, sid);
  // The icon on the home screen, and a stand-in for the browser's push
  // service: the phone's keys are the test's, so it can read what arrives.
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const dev = { priv: push.b64u(ecdh.getPrivateKey()), p256dh: push.b64u(ecdh.getPublicKey()), auth: push.b64u(crypto.randomBytes(16)) };
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });
    (() => {
      const json = { endpoint: ${JSON.stringify(PUSH_ORIGIN + '/_push/the-phone')}, expirationTime: null, keys: { p256dh: ${JSON.stringify(dev.p256dh)}, auth: ${JSON.stringify(dev.auth)} } };
      PushManager.prototype.getSubscription = async function () { const s = sessionStorage.getItem('fake-sub-key'); return s ? { endpoint: json.endpoint, options: { applicationServerKey: Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer }, toJSON: () => json, unsubscribe: async () => { sessionStorage.removeItem('fake-sub-key'); return true; } } : null; };
      PushManager.prototype.subscribe = async function (opts) {
        sessionStorage.setItem('fake-sub-key', btoa(String.fromCharCode(...new Uint8Array(opts.applicationServerKey))));
        sessionStorage.setItem('fake-subscribes', String(Number(sessionStorage.getItem('fake-subscribes') || 0) + 1));
        return this.getSubscription();
      };
    })();` }, sid);
  const evaluate = async expression => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sid);
    if (out.result?.exceptionDetails) return { error: JSON.stringify(out.result.exceptionDetails).slice(0, 400) };
    return out.result?.result?.value;
  };
  const until = async (expression, label, ms = 40000) => {
    const t0 = Date.now();
    for (;;) {
      if ((await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`)) === true) return;
      if (Date.now() - t0 > ms) assert.fail('Timed out: ' + label + '\n' + problems.join('\n'));
      await sleep(50);
    }
  };
  const app = `document.getElementById('app').contentWindow`;
  const hostIn = `${app}.eval('typeof settingsState !== "undefined" && settingsState && settingsState.hostname')`;
  const pairWith = async c => {
    const code = await c.post('/api/anywhere/pair');
    await send('Page.navigate', { url: code.url }, sid);
  };
  // Paired with lambda, then with the laptop (each code opens the icon at it).
  await pairWith(lambda);
  await until(`document.body.classList.contains('app-open') && ${hostIn} === 'lambda'`, 'lambda open', 60000);
  const turnOn = async () => {
    await evaluate(`${app}.location.hash = '#settings=notifications', 1`);
    await until(`${app}.document.querySelector('#pushPane [data-push=on]')`, 'the notifications pane, off');
    await evaluate(`${app}.document.querySelector('#pushPane [data-push=on]').click(), 1`);
    await until(`/On for this device/.test(${app}.document.querySelector('#pushPane')?.textContent || '')`, 'on');
  };
  await turnOn();
  await pairWith(laptop);
  await until(`document.body.classList.contains('app-open') && ${hostIn} === 'LILLY-PC'`, 'the laptop open', 60000);
  await turnOn();
  assert.equal(await evaluate(`sessionStorage.getItem('fake-subscribes')`), '1', 'one subscription for both computers');

  // Each computer knows the same address, and signs with the phone's key.
  const devA = (await (await fetch(lambda.base + '/api/push')).json()).devices;
  const devB = (await (await fetch(laptop.base + '/api/push')).json()).devices;
  assert.equal(devA.length, 1); assert.equal(devB.length, 1);
  assert.equal(devA[0].id, devB[0].id);
  await lambda.post('/api/push/test', { id: devA[0].id });
  await laptop.post('/api/push/test', { id: devB[0].id });
  for (let i = 0; i < 100 && got.length < 2; i++) await sleep(50);
  assert.equal(got.length, 2);
  const keyOf = h => /k=([A-Za-z0-9_-]+)/.exec(h.authorization)[1];
  const phoneKey = (await evaluate(`window.__anywhere.pushKey().then(k => k.publicKey)`));
  assert.equal(keyOf(got[0].headers), phoneKey);
  assert.equal(keyOf(got[1].headers), phoneKey);
  const homes = got.map(g => JSON.parse(push.decryptPayload(g.body, dev.priv, dev.p256dh, dev.auth)).home.id).sort();
  assert.deepEqual(homes, [lambdaId, laptopId].sort());

  // The relay's worker shows a notification naming its computer.
  await send('ServiceWorker.enable', {}, sid);
  for (let i = 0; i < 100 && !regs.some(r => r.scopeURL === relayUrl + '/'); i++) await sleep(50);
  const reg = regs.find(r => r.scopeURL === relayUrl + '/');
  assert.ok(reg, 'the relay worker is registered');
  await send('ServiceWorker.deliverPushMessage', { origin: relayUrl, registrationId: reg.registrationId, data: JSON.stringify({ v: 1, kind: 'reply', title: 'From lambda', body: 'ready', tag: 'c-l', key: 'k', url: '/#settings=machines', home: { id: lambdaId, name: 'lambda' }, at: Date.now() }) }, sid);
  let data = null;
  for (let i = 0; i < 200 && !data; i++) { data = await evaluate(`navigator.serviceWorker.ready.then(r => r.getNotifications()).then(n => (n.find(x => x.title === 'From lambda') || {}).data || null)`); if (!data) await sleep(50); }
  assert.deepEqual(data, { url: '/#settings=machines', key: 'k', home: lambdaId, tag: 'c-l', kind: 'reply' });
  // Opening it (what the worker asks of the shell) switches to lambda, at that place.
  await evaluate(`window.anywhereOpen(${JSON.stringify(lambdaId)}, '/#settings=machines')`);
  await until(`${hostIn} === 'lambda' && ${app}.location.hash === '#settings=machines'`, 'lambda, at the notification’s place', 60000);
  // And with no window open: the icon starts at ?home=, on that computer.
  await send('Page.navigate', { url: relayUrl + '/?home=' + encodeURIComponent(laptopId) + '#settings=notifications' }, sid);
  await until(`document.body.classList.contains('app-open') && ${hostIn} === 'LILLY-PC' && ${app}.location.hash === '#settings=notifications' && !location.search`, 'the laptop from a cold start', 60000);
  assert.deepEqual(problems, []);
});
