'use strict';
// Chattering Anywhere in a real browser (design/85): a phone-sized Chromium
// opens the pairing link from a real Chattering, pairs through a real relay
// over WebRTC, and runs the app from the computer: its pages and scripts
// through the service worker, its live event stream and its WebSockets
// through inside.js. Then a reload comes back without the code, as the
// home-screen icon would. CHATTERING_SHOTS=<dir> keeps screenshots.
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

const root = path.join(__dirname, '..');
const rtc = loadRtc(root);
after(async () => { await new Promise(r => setTimeout(r, 300)); if (rtc.cleanup) rtc.cleanup(); setTimeout(() => process.exit(), 1000); });
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('a phone pairs in the browser and runs Chattering from the computer', { skip: rtc.error || (!chromiumAvailable() && 'chromium is not installed'), timeout: 120000 }, async t => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-browser-')));
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

  // ---- the phone ----
  const browser = spawn(chromiumBinary(), [...CHROMIUM_TEST_FLAGS, '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0',
    // Chromium hides this machine's addresses behind mDNS names the
    // computer's WebRTC stack does not resolve; a phone on another network
    // meets it through STUN/TURN instead.
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
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(m.params.args.map(a => a.value || a.description).join(' '));
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const sid = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
  const evaluate = async expression => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
    if (out.result?.exceptionDetails) return { error: JSON.stringify(out.result.exceptionDetails).slice(0, 400) };
    return out.result?.result?.value;
  };
  const until = async (expression, label, ms = 30000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`);
      if (v === true) return;
      if (Date.now() - t0 > ms) {
        const screen = await evaluate(`document.getElementById('stage')?.innerText || ''`);
        assert.fail('Timed out: ' + label + '\nscreen: ' + JSON.stringify(screen) + '\n' + problems.join('\n') + '\n' + log.slice(-3000));
      }
      await sleep(50);
    }
  };
  const shot = async name => {
    if (!process.env.CHATTERING_SHOTS) return;
    fs.mkdirSync(process.env.CHATTERING_SHOTS, { recursive: true });
    const r = await send('Page.captureScreenshot', { format: 'png' }, sid);
    fs.writeFileSync(path.join(process.env.CHATTERING_SHOTS, name), Buffer.from(r.result.data, 'base64'));
  };
  await send('Runtime.enable', {}, sid); await send('Page.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sid);
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36' }, sid);
  await send('Page.navigate', { url: code.url }, sid);

  // Android in a browser: the app first, one button (installs it, or opens it
  // with this code), the browser second.
  await until(`document.getElementById('useApp')`, 'the choice: the app or the browser');
  const intent = await evaluate(`document.getElementById('useApp').getAttribute('href')`);
  const pairLink = require('../anywhere/protocol.js').readPairingLink(new URL(code.url).hash);
  assert.equal(intent, `intent://pair/${pairLink.homeId}.${pairLink.id}.${pairLink.secret}?n=lambda&r=${encodeURIComponent(new URL(relayUrl).host)}#Intent;scheme=chattering;package=app.rockfrog.chattering;S.browser_fallback_url=${encodeURIComponent('https://github.com/MaximeRivest/chattering/releases/download/android/Chattering-android.apk')};end`);
  await shot('anywhere-0-choice.png');
  await evaluate(`document.getElementById('inBrowser').click(); 1`);
  // Pairing, then the app from the computer, full screen.
  await until(`document.querySelector('.link-art')`, 'the connecting screen');
  await shot('anywhere-1-pairing.png');
  await until(`document.body.classList.contains('app-open')`, 'the app open');
  assert.equal(await evaluate('location.hash'), '', 'the code leaves the address bar');
  const frame = `document.getElementById('app').contentWindow`;
  await until(`${frame}.__anywhereInside === true`, 'inside.js in the app page');
  await until(`${frame}.document.title.includes('Chattering')`, 'the app itself');
  // Its live event stream, through the tunnel.
  await until(`${frame}.eval('typeof live !== "undefined" && live.readyState === 1')`, 'the event stream open');
  await sleep(1500);
  await shot('anywhere-2-app.png');
  // Taps reach the app: nothing of the shell lies over it, anywhere on the
  // screen (a hidden but still displayed layer once caught every tap).
  const covered = await evaluate(`(() => { const out = []; for (const [x, y] of [[20, 20], [195, 60], [195, 422], [370, 800], [30, 820], [360, 30]]) { const el = document.elementFromPoint(x, y); if (!el || el.id !== 'app') out.push(x + ',' + y + ': ' + (el ? (el.id || el.className || el.tagName) : 'nothing')); } return out; })()`);
  assert.deepEqual(covered, [], 'points where something covers the app');
  // A real tap, through the browser's input, lands in the app's page.
  await evaluate(`${frame}.__taps = 0; ${frame}.addEventListener('click', () => ${frame}.__taps++, true); 1`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 422 }] }, sid);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sid);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 195, y: 422, button: 'left', clickCount: 1 }, sid);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 195, y: 422, button: 'left', clickCount: 1 }, sid);
  await until(`${frame}.__taps > 0`, 'a tap reaching the app');
  const st = await (await fetch(base + '/api/anywhere')).json();
  assert.equal(st.devices.length, 1);
  assert.equal(st.devices[0].name, 'Pixel 8 · Chrome');
  assert.equal(st.devices[0].online, true);
  assert.ok(['direct', 'relay', null].includes(st.devices[0].path));

  // An event on the computer reaches the phone's app.
  await evaluate(`${frame}.eval('window.__heard = []; live.addEventListener("message", e => window.__heard.push(JSON.parse(e.data).type)); 1')`);
  await post('/api/anywhere/settings', { relay: relayUrl });
  await until(`${frame}.__heard.includes('anywhere')`, 'a live event through the tunnel');

  // A WebSocket (shared drafts) from the app, through the tunnel.
  await evaluate(`${frame}.eval('window.__sock = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/collab/draft:anywheretest"); window.__sock.binaryType = "arraybuffer"; window.__sockGot = 0; window.__sock.onmessage = () => window.__sockGot++; 1')`);
  await until(`${frame}.__sock.readyState === 1`, 'the WebSocket open');
  assert.equal(await evaluate(`${frame}.__sock instanceof ${frame}.WebSocket`), true);
  await until(`${frame}.__sockGot > 0`, 'a message from the collaboration server');
  // The app's own service worker is not installed over the shell's.
  assert.equal(await evaluate(`navigator.serviceWorker.controller.scriptURL`), relayUrl + '/sw.js');

  // Back later, as from the home-screen icon: no code, same phone.
  await send('Page.navigate', { url: relayUrl + '/' }, sid);
  await until(`document.body.classList.contains('app-open') && ${frame}.__anywhereInside === true`, 'reconnected without a code');
  // Removed on the computer: the phone says so and forgets it.
  const devices = (await (await fetch(base + '/api/anywhere')).json()).devices;
  await post('/api/anywhere/forget', { id: devices[0].id });
  await until(`/removed/.test(document.getElementById('stage').innerText)`, 'told it was removed');
  await shot('anywhere-3-removed.png');

  // A laptop: a desktop browser pastes the link and is in.
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sid);
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' }, sid);
  const laptopCode = await post('/api/anywhere/pair');
  await send('Page.navigate', { url: relayUrl + '/' }, sid);
  await until(`document.getElementById('pasteForm') && /Add a device/.test(document.getElementById('stage').innerText)`, 'the welcome, with a place to paste');
  await evaluate(`document.getElementById('pasteLink').value = ${JSON.stringify(laptopCode.url)}; document.getElementById('pasteForm').requestSubmit(); 1`);
  await until(`document.body.classList.contains('app-open') && ${frame}.__anywhereInside === true`, 'the laptop in, from a pasted link');
  const laptop = (await (await fetch(base + '/api/anywhere')).json()).devices.find(d => /Linux computer/.test(d.name));
  assert.ok(laptop, 'listed as a computer');
  assert.deepEqual(problems.filter(p => !/favicon|ERR_|net::/.test(p)), [], 'no errors on the page');
});
