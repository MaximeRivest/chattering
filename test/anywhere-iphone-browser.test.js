'use strict';
// An iPhone's home-screen icon (design/85): it keeps its own storage, apart
// from Safari's, and may open at the manifest's start page without the code
// that was in Safari's address. So Safari copies the code when the person
// chooses the home screen, and the icon, opened with no code, offers to
// paste it, then pairs. Two browser contexts stand for Safari and the icon
// (separate storage); the icon is "standalone" as iOS says it
// (navigator.standalone). CHATTERING_SHOTS=<dir> keeps screenshots.
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

test('an iPhone: Safari copies the code for the home-screen icon, which pastes it and pairs', { skip: rtc.error || (!chromiumAvailable() && 'chromium is not installed'), timeout: 120000 }, async t => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-iphone-')));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  const relay = createRelay({ env: {}, noCache: true });
  await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
  t.after(() => relay.close());
  const relayUrl = 'http://127.0.0.1:' + relay.server.address().port;
  const port = await freePort(), tlsPort = await freePort(), previewPort = await freePort();
  registerConsole(port, 'install-tok');
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(tlsPort), CHATTERING_PREVIEW_PORT: String(previewPort), CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    CHATTERING_HOST: '', CHATTERING_LAN: '', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: 'install-tok', CHATTERING_HOSTNAME: 'lambda' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; ; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} if (i > 200) assert.fail('server did not start\n' + log); await sleep(100); }
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
  await post('/api/anywhere/settings', { relay: relayUrl });
  const code = await post('/api/anywhere/pair');
  assert.ok(code.url, JSON.stringify(code));
  const want = P.readPairingLink(new URL(code.url).hash);

  const browser = spawn(chromiumBinary(), [...CHROMIUM_TEST_FLAGS, '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0',
    '--disable-features=WebRtcHideLocalIpsWithMdns', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
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

  // A device: its own browser context (its own storage), iPhone-sized, an
  // iPhone's user agent, the clipboard allowed as Safari allows it after
  // the person confirms.
  async function device({ standalone }) {
    const ctx = (await send('Target.createBrowserContext')).result.browserContextId;
    await send('Browser.grantPermissions', { browserContextId: ctx, origin: relayUrl, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    const target = await send('Target.createTarget', { url: 'about:blank', browserContextId: ctx });
    const sid = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
    await send('Runtime.enable', {}, sid); await send('Page.enable', {}, sid);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sid);
    await send('Emulation.setUserAgentOverride', { userAgent: IPHONE, platform: 'iPhone' }, sid);
    if (standalone) await send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true });` }, sid);
    const evaluate = async expression => {
      const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sid);
      if (out.result?.exceptionDetails) return { error: JSON.stringify(out.result.exceptionDetails).slice(0, 400) };
      return out.result?.result?.value;
    };
    const until = async (expression, label, ms = 30000) => {
      const t0 = Date.now();
      for (;;) {
        if ((await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`)) === true) return;
        if (Date.now() - t0 > ms) assert.fail('Timed out: ' + label + '\nscreen: ' + JSON.stringify(await evaluate(`document.getElementById('stage')?.innerText || ''`)) + '\n' + problems.join('\n') + '\n' + log.slice(-2000));
        await sleep(50);
      }
    };
    // A real tap: the browser's own input, so the page has the person's
    // gesture and the focus (the clipboard asks for both).
    const tap = async elId => {
      const box = await evaluate(`(() => { const r = document.getElementById(${JSON.stringify(elId)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sid);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sid);
    };
    const shot = async name => {
      if (!process.env.CHATTERING_SHOTS) return;
      fs.mkdirSync(process.env.CHATTERING_SHOTS, { recursive: true });
      const r = await send('Page.captureScreenshot', { format: 'png' }, sid);
      fs.writeFileSync(path.join(process.env.CHATTERING_SHOTS, name), Buffer.from(r.result.data, 'base64'));
    };
    return { sid, evaluate, until, tap, shot, go: url => send('Page.navigate', { url }, sid) };
  }

  // ---- Safari: the camera opened the code here ----
  const safari = await device({ standalone: false });
  await safari.go(code.url);
  await safari.until(`document.getElementById('homeScreen')`, 'Safari asks where Chattering should live');
  await safari.shot('iphone-0-choice.png');
  await safari.tap('homeScreen');
  await safari.until(`/Add to Home Screen/.test(document.getElementById('stage').innerText)`, 'how to add it to the home screen');
  assert.match(await safari.evaluate(`document.getElementById('stage').innerText`), /code is copied/, 'the person is told the code is copied');
  await safari.shot('iphone-1-add.png');
  const copied = await safari.evaluate(`navigator.clipboard.readText()`);
  const got = P.readPairingLink(new URL(copied).hash);
  assert.equal(new URL(copied).origin, relayUrl, 'a link to this relay');
  assert.deepEqual([got.homeId, got.id, got.secret], [want.homeId, want.id, want.secret], 'the same code');
  assert.equal(relay.homes.size >= 1, true);

  // ---- the icon: its own storage, opened at the start page, no code ----
  const icon = await device({ standalone: true });
  await icon.go(relayUrl + '/');
  await icon.until(`document.getElementById('pasteCode')`, 'the icon offers to paste the code');
  const welcome = await icon.evaluate(`document.getElementById('stage').innerText`);
  assert.match(welcome, /On the home screen/, 'it says where the code comes from');
  assert.doesNotMatch(welcome, /Scan the code with this device's camera\./, 'no step this icon cannot do');
  await icon.shot('iphone-2-icon.png');
  // An empty clipboard: the field is shown, nothing is sent.
  await icon.evaluate(`navigator.clipboard.writeText('')`);
  await icon.tap('pasteCode');
  await icon.until(`document.activeElement && document.activeElement.id === 'pasteLink'`, 'an empty clipboard leaves the field for the link');
  assert.equal(await icon.evaluate(`document.body.classList.contains('app-open')`), false);
  // The copied code: one tap pairs.
  await icon.evaluate(`navigator.clipboard.writeText(${JSON.stringify(copied)})`);
  await icon.tap('pasteCode');
  await icon.until(`document.body.classList.contains('app-open')`, 'paired, and the app open', 60000);
  await icon.until(`document.getElementById('app').contentWindow.document.title.includes('Chattering')`, 'Chattering itself in the icon');
  await icon.shot('iphone-3-app.png');

  // The safe area: an iPhone's clock and camera above, its home indicator
  // below (59 and 34 px on a 15 Pro). Chromium gives the frame the page's
  // safe area itself: the frame stays full screen and the app pads itself.
  await send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 59, bottom: 34, left: 0, right: 0 } }, icon.sid);
  await icon.evaluate(`dispatchEvent(new Event('resize')), 1`);
  const app = `document.getElementById('app')`;
  const fit = () => icon.evaluate(`({ t: getComputedStyle(document.documentElement).getPropertyValue('--fit-t').trim(), top: ${app}.getBoundingClientRect().top, bottomInApp: ${app}.contentDocument.documentElement.style.getPropertyValue('--anywhere-inset-bottom'), bar: ${app}.contentWindow.getComputedStyle(${app}.contentDocument.documentElement).getPropertyValue('--sai-bottom').trim() })`);
  const chromium = await fit();
  assert.equal(chromium.t, '0px', 'Chromium: the frame has its own safe area');
  assert.equal(chromium.top, 0);
  assert.equal(chromium.bottomInApp, '0px');
  // WebKit gives a frame no safe area (env() is 0 there): stand for it by
  // having the frame measure none. The frame then keeps clear of the top,
  // and the app is told the bottom, which it pads itself.
  await icon.evaluate(`(() => { const w = ${app}.contentWindow, real = w.getComputedStyle.bind(w); w.getComputedStyle = (el, p) => (el && /safe-area-inset/.test(el.style.cssText) ? { paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px' } : real(el, p)); dispatchEvent(new Event('resize')); return 1; })()`);
  const webkit = await fit();
  assert.equal(webkit.t, '59px', 'WebKit: the frame starts below the clock and the camera');
  assert.equal(webkit.top, 59);
  assert.equal(webkit.bottomInApp, '34px', 'the app is told the home indicator');
  assert.match(await icon.evaluate(`getComputedStyle(document.body, '::before').height`), /^59px$/, 'a dark strip under the status bar');
  await icon.shot('iphone-4-safe-area.png');
  const st = await (await fetch(base + '/api/anywhere')).json();
  assert.equal(st.devices.length, 1);
  assert.equal(st.devices[0].name, 'iPhone · Safari');
  assert.deepEqual(problems, []);
});
