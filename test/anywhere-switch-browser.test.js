'use strict';
// Switching computers on a phone (design/85): the home-screen icon, paired
// with one computer, adds a second from the app's own machine switcher
// (the computers sheet, a pasted code), and the switcher then moves between
// the two, each through its own encrypted link. Two real Chattering
// servers and a relay; the icon as on an iPhone (standalone, its own
// storage). CHATTERING_SHOTS=<dir> keeps screenshots.
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
    CHATTERING_HOST: '', CHATTERING_LAN: '', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: token, CHATTERING_HOSTNAME: name }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; ; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} if (i > 200) assert.fail(name + ' did not start\n' + log); await sleep(100); }
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
  return { base, post, log: () => log };
}

test('a phone switches between its computers from the app, and adds one there', { skip: rtc.error || (!chromiumAvailable() && 'chromium is not installed'), timeout: 150000 }, async t => {
  const relay = createRelay({ env: {}, noCache: true });
  await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
  t.after(() => relay.close());
  const relayUrl = 'http://127.0.0.1:' + relay.server.address().port;
  const lambda = await chattering(t, 'lambda');
  const laptop = await chattering(t, 'LILLY-PC');
  for (const c of [lambda, laptop]) await c.post('/api/anywhere/settings', { relay: relayUrl });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-switch-browser-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const browser = spawn(chromiumBinary(), [...CHROMIUM_TEST_FLAGS, '--user-data-dir=' + tmp, '--remote-debugging-port=0', '--disable-features=WebRtcHideLocalIpsWithMdns', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => { try { browser.kill('SIGKILL'); } catch {} });
  const endpoint = await new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(Error(out)), 15000);
    browser.stderr.on('data', b => { out += b; const m = out.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
  });
  const ws = new WebSocket(endpoint); await new Promise(res => ws.onopen = res);
  t.after(() => ws.close());
  let id = 0; const pending = new Map(), problems = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const ctx = (await send('Target.createBrowserContext')).result.browserContextId;
  await send('Browser.grantPermissions', { browserContextId: ctx, origin: relayUrl, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  const target = await send('Target.createTarget', { url: 'about:blank', browserContextId: ctx });
  const sid = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
  await send('Runtime.enable', {}, sid); await send('Page.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sid);
  await send('Emulation.setUserAgentOverride', { userAgent: IPHONE, platform: 'iPhone' }, sid);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });` }, sid);
  const evaluate = async expression => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sid);
    if (out.result?.exceptionDetails) return { error: JSON.stringify(out.result.exceptionDetails).slice(0, 400) };
    return out.result?.result?.value;
  };
  const until = async (expression, label, ms = 40000) => {
    const t0 = Date.now();
    for (;;) {
      if ((await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`)) === true) return;
      if (Date.now() - t0 > ms) assert.fail('Timed out: ' + label + '\nscreen: ' + JSON.stringify(await evaluate(`(document.getElementById('sheet')?.hidden === false ? document.getElementById('sheet').innerText : document.getElementById('stage')?.innerText) || ''`)) + '\n' + problems.join('\n'));
      await sleep(50);
    }
  };
  const tapAt = async (expr) => {
    const box = await evaluate(`(() => { const el = ${expr}; const r = el.getBoundingClientRect(); let x = r.x + r.width / 2, y = r.y + r.height / 2; let w = el.ownerDocument.defaultView; while (w !== window) { const f = w.frameElement.getBoundingClientRect(); x += f.x; y += f.y; w = w.parent; } return { x, y }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sid);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sid);
  };
  const shot = async name => {
    if (!process.env.CHATTERING_SHOTS) return;
    fs.mkdirSync(process.env.CHATTERING_SHOTS, { recursive: true });
    const r = await send('Page.captureScreenshot', { format: 'png' }, sid);
    fs.writeFileSync(path.join(process.env.CHATTERING_SHOTS, name), Buffer.from(r.result.data, 'base64'));
  };
  const app = `document.getElementById('app').contentWindow`;
  const hostIn = `${app}.eval('typeof settingsState !== "undefined" && settingsState && settingsState.hostname')`;
  const appHost = async () => evaluate(hostIn);

  // The icon, paired with lambda (its first computer).
  const first = await lambda.post('/api/anywhere/pair');
  await send('Page.navigate', { url: relayUrl + '/' }, sid);
  await until(`document.getElementById('pasteCode')`, 'the icon, nothing paired');
  await evaluate(`navigator.clipboard.writeText(${JSON.stringify(first.url)})`);
  await tapAt(`document.getElementById('pasteCode')`);
  await until(`document.body.classList.contains('app-open') && ${hostIn}`, 'lambda open', 60000);
  assert.equal(await appHost(), 'lambda');

  // The app's switcher: the phone's computers, not the addresses lambda
  // knows for others; with one computer, a way to add one.
  await evaluate(`${app}.toggleMachinePop(true), 1`);
  const one = await evaluate(`[...${app}.document.querySelectorAll('#machinePop button')].map(b => b.innerText.replace(/\\s+/g, ' ').trim())`);
  assert.deepEqual(one, ['Add a computer… on this phone']);
  await shot('switch-0-one.png');
  await tapAt(`${app}.document.querySelector('#machinePop [data-computers]')`);
  await until(`document.getElementById('sheet').hidden === false && document.getElementById('sheetPaste')`, 'the computers sheet, with a way to add one');
  await shot('switch-1-sheet.png');
  const second = await laptop.post('/api/anywhere/pair');
  await evaluate(`navigator.clipboard.writeText(${JSON.stringify(second.url)})`);
  await tapAt(`document.getElementById('sheetPaste')`);
  await until(`document.body.classList.contains('app-open') && ${hostIn} === 'LILLY-PC'`, 'the laptop added and open', 60000);

  // Now the switcher moves between the two.
  await evaluate(`${app}.toggleMachinePop(true), 1`);
  const two = await evaluate(`[...${app}.document.querySelectorAll('#machinePop button')].map(b => b.innerText.replace(/\\s+/g, ' ').trim())`);
  assert.deepEqual(two, ['lambda encrypted link', 'Your computers… on this phone']);
  await shot('switch-2-two.png');
  await tapAt(`${app}.document.querySelector('#machinePop [data-home]')`);
  await until(`${hostIn} === 'lambda'`, 'back on lambda', 60000);
  // Settings → machines lists them too, and opens the other one.
  await evaluate(`${app}.showSettings('machines'), 1`);
  await until(`${app}.document.querySelector('#setPhoneComputers [data-phone-home]')`, 'the computers in settings');
  const rows = await evaluate(`[...${app}.document.querySelectorAll('#setPhoneComputers .mach-item')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
  assert.deepEqual(rows, ['lambda you are here', 'LILLY-PC encrypted link open']);
  await shot('switch-3-settings.png');
  await tapAt(`${app}.document.querySelector('#setPhoneComputers [data-phone-home]')`);
  await until(`${hostIn} === 'LILLY-PC'`, 'the laptop from settings', 60000);
  assert.equal((await (await fetch(lambda.base + '/api/anywhere')).json()).devices.length, 1);
  assert.equal((await (await fetch(laptop.base + '/api/anywhere')).json()).devices.length, 1);
  assert.deepEqual(problems, []);
});
