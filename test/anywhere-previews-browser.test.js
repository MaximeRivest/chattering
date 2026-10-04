'use strict';
// Previews on a device paired through the relay (design/67, design/85), in a
// real browser: a phone-sized Chromium pairs with a real Chattering through
// a real relay, then shows a web page an agent made and a widget. They run
// at previews.<relay>, a site apart from the app's, and every byte of them
// comes from the computer through the encrypted tunnel; the relay serves
// only the carrier and never sees an artifact's address (which names the
// conversation and the folder).
//
// The relay is reached as relay.localhost and previews.relay.localhost:
// one site, two origins, as encrypted-link-to-your-devices.rockfrog.ai and
// previews.encrypted-link-to-your-devices.rockfrog.ai are.
// CHATTERING_SHOTS=<dir> keeps screenshots.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const { chromiumBinary, chromiumAvailable, CHROMIUM_TEST_FLAGS } = require('./helpers/chromium.js');
const { createRelay } = require('../anywhere/relay.js');
const { loadRtc } = require('../anywhere-home.js');

const root = path.join(__dirname, '..');
const rtc = loadRtc(root);
after(async () => { await new Promise(r => setTimeout(r, 300)); if (rtc.cleanup) rtc.cleanup(); setTimeout(() => process.exit(), 1000); });
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
// A real 2×2 picture, so the page can say it decoded.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAAMIM/////w8AH+4F+7C4l8kAAAAASUVORK5CYII=', 'base64');

test('a device paired through the relay shows what agents make, from its own preview address', { skip: rtc.error || (!chromiumAvailable() && 'chromium is not installed'), timeout: 150000 }, async t => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-previews-')));
  const agent = path.join(home, '.pi', 'agent'), sessions = path.join(agent, 'sessions', 'fixture'), work = path.join(home, 'work'), site = path.join(work, 'site');
  fs.mkdirSync(sessions, { recursive: true }); fs.mkdirSync(site, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: work });
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><html><head><title>p</title></head><body><h1>PAGE FROM THE COMPUTER</h1><img id="pic" src="frog.png"><script>localStorage.setItem("seen", "1")</script></body></html>');
  fs.writeFileSync(path.join(site, 'frog.png'), PNG);
  const widgetHtml = '<!doctype html><html><head></head><body style="margin:0"><div id="w" style="height:240px">WIDGET BODY</div></body></html>';
  let clock = 0;
  const ts = () => new Date(Date.UTC(2026, 8, 1, 12, 0, clock++)).toISOString();
  fs.writeFileSync(path.join(sessions, 'chat.jsonl'), [
    { type: 'session', version: 3, id: 'fixture', cwd: work },
    { type: 'message', id: 'q1', parentId: null, timestamp: ts(), message: { role: 'user', content: [{ type: 'text', text: 'Make a page' }] } },
    { type: 'message', id: 'a1', parentId: 'q1', timestamp: ts(), message: { role: 'assistant', model: 'm', provider: 'p', content: [{ type: 'toolCall', id: 'art', name: 'artifact', arguments: { path: 'site', title: 'The page' } }] } },
    { type: 'message', id: 'r1', parentId: 'a1', timestamp: ts(), message: { role: 'toolResult', toolCallId: 'art', toolName: 'artifact', content: [{ type: 'text', text: 'ok' }], isError: false } },
  ].map(JSON.stringify).join('\n') + '\n');
  const key = 'pi:fixture/chat.jsonl';

  // The relay, on both loopback addresses (relay.localhost may resolve to
  // either); every request it gets, by name and path.
  const relay = createRelay({ env: {}, noCache: true });
  const asked = [];
  relay.server.prependListener('request', req => asked.push({ host: String(req.headers.host || ''), url: req.url }));
  await new Promise(r => relay.server.listen(0, '::', r));
  t.after(() => relay.close());
  const relayPort = relay.server.address().port;
  const relayUrl = `http://relay.localhost:${relayPort}`, previewSite = `http://previews.relay.localhost:${relayPort}`;

  const port = await freePort(), tlsPort = await freePort(), previewPort = await freePort();
  registerConsole(port, 'install-tok');
  require('./helpers/first-run.js').answerFirstRun(home);
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(tlsPort), CHATTERING_PREVIEW_PORT: String(previewPort), CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    CHATTERING_HOST: '', CHATTERING_LAN: '', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: 'install-tok', CHATTERING_HOSTNAME: 'lambda' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; ; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} if (i > 200) assert.fail('server did not start\n' + log); await sleep(100); }
  for (let i = 0; ; i++) { try { if ((await (await fetch(base + '/api/sessions')).json()).some(s => s.key === key)) break; } catch {} if (i > 200) assert.fail('the conversation was not indexed\n' + log); await sleep(100); }
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
  const set = await post('/api/anywhere/settings', { relay: relayUrl });
  assert.ok(!set.error, JSON.stringify(set));
  const code = await post('/api/anywhere/pair');
  assert.ok(code.url && code.url.startsWith(relayUrl + '/#pair='), JSON.stringify(code));

  // ---- the phone ----
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
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(m.params.args.map(a => a.value || a.description).join(' '));
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const sid = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
  const evaluate = async (expression, contextId) => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, sid);
    if (out.result?.exceptionDetails) return { error: JSON.stringify(out.result.exceptionDetails).slice(0, 400) };
    return out.result?.result?.value;
  };
  const until = async (expression, label, ms = 30000, contextId) => {
    const t0 = Date.now();
    for (;;) {
      const v = await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`, contextId);
      if (v === true) return;
      if (Date.now() - t0 > ms) assert.fail('Timed out: ' + label + '\n' + problems.join('\n') + '\nrelay saw: ' + JSON.stringify(asked.slice(-20)) + '\n' + log.slice(-3000));
      await sleep(50);
    }
  };
  // A frame of another origin, read from the inside (a world of its own in it).
  const frames = async () => { const out = []; const walk = n => { out.push(n.frame); for (const c of n.childFrames || []) walk(c); }; walk((await send('Page.getFrameTree', {}, sid)).result.frameTree); return out; };
  const inFrame = async (match, label) => {
    const t0 = Date.now();
    for (;;) {
      const f = (await frames()).find(match);
      if (f) return (await send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'test' }, sid)).result.executionContextId;
      if (Date.now() - t0 > 30000) assert.fail('no frame: ' + label + '\n' + JSON.stringify((await frames()).map(f => f.url)) + '\n' + problems.join('\n'));
      await sleep(100);
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
  await until(`document.getElementById('inBrowser')`, 'the choice: the app or the browser');
  await evaluate(`document.getElementById('inBrowser').click(); 1`);
  await until(`document.body.classList.contains('app-open')`, 'the app open');
  const app = `document.getElementById('app').contentWindow`;
  await until(`${app}.Artifacts && ${app}.__anywherePreview`, 'the app, told where previews show');
  assert.equal(await evaluate(`${app}.__anywherePreview.origin`), previewSite);
  assert.equal(await evaluate(`${app}.Artifacts.previewOrigin('x')`), previewSite);
  assert.equal(await evaluate(`document.querySelector('iframe.carrier')`), null, 'no carrier until a preview is shown');

  // ---- a web page an agent made, in the artifact panel ----
  await evaluate(`${app}.Artifacts.openPanel({ kind: 'files', key: ${JSON.stringify(key)}, path: 'site', title: 'The page' }); 1`);
  await until(`${app}.document.querySelector('#artifactPane iframe.art-frame')?.src.startsWith(${JSON.stringify(previewSite + '/a/')})`, 'the panel frames the preview address');
  const page = await inFrame(f => f.url.startsWith(previewSite + '/a/'), 'the page');
  await until(`/PAGE FROM THE COMPUTER/.test(document.body.innerText)`, 'the page, from the computer', 30000, page);
  await until(`document.getElementById('pic').complete && document.getElementById('pic').naturalWidth === 2`, 'its picture, through the tunnel', 30000, page);
  await shot('previews-1-page.png');
  assert.equal(await evaluate(`location.origin`, page), previewSite, 'on the preview address, not the app\'s');
  assert.equal(await evaluate(`localStorage.getItem('seen')`, page), '1', 'a site of its own, with storage');
  assert.equal(await evaluate(`typeof window.chattering`, page), 'undefined', 'the isolated world sees no page globals');
  // The page's kit speaks to the app across the two origins: the panel learned its theme handshake.
  await until(`document.documentElement.dataset.theme === 'light' || document.documentElement.dataset.theme === 'dark'`, 'the host\'s theme, from the app', 30000, page);
  // The app cannot reach into it, nor it into the app.
  assert.equal(await evaluate(`(() => { try { return ${app}.document.querySelector('#artifactPane iframe.art-frame').contentDocument === null; } catch { return true; } })()`), true);
  assert.equal(await evaluate(`(() => { try { return !!window.parent.document; } catch { return false; } })()`, page), false);

  // ---- a widget (the MCP Apps sandbox proxy) ----
  await evaluate(`${app}.Artifacts.openPanel({ kind: 'html', key: ${JSON.stringify(key)}, title: 'A widget', html: ${JSON.stringify(widgetHtml)}, site: 'wtest', source: 'widget' }); 1`);
  await inFrame(f => f.url.startsWith(previewSite + '/_c/proxy.html'), 'the sandbox proxy');
  const proxyId = (await frames()).find(f => f.url.startsWith(previewSite + '/_c/proxy.html')).id;
  const widget = await inFrame(f => f.url === 'about:srcdoc' && f.parentId === proxyId, 'the widget inside the proxy');
  await until(`/WIDGET BODY/.test(document.body.innerText)`, 'the widget, its HTML from the app through the proxy', 30000, widget);
  await shot('previews-2-widget.png');

  // ---- what the relay saw ----
  const onPreview = asked.filter(a => a.host.startsWith('previews.'));
  assert.ok(onPreview.length > 0, 'the carrier came from the relay');
  assert.deepEqual([...new Set(onPreview.map(a => a.url))].sort(), ['/_anywhere/carrier.html', '/_anywhere/carrier.js', '/sw.js'], 'the preview address asked the relay for the carrier only');
  assert.deepEqual(asked.filter(a => /\/a\/|\/_c\//.test(a.url)), [], 'no artifact address ever reached the relay');
  assert.equal(await evaluate(`document.querySelectorAll('iframe.carrier').length`), 1, 'one carrier, kept');
  assert.deepEqual(problems.filter(p => !/favicon|ERR_|net::/.test(p)), [], 'no errors on the page');
});
