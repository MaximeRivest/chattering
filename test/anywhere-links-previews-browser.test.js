'use strict';
// Previews through a link between computers (design/90, design/67), in a
// real browser: B links to A through a real relay, and B's browser opens A
// at the link's local address. What A's agents made shows there: a web page
// in the artifact panel and a widget, each at <artifact>.localhost:<the
// link's preview port>, answered by A's preview server through the tunnel.
// Before, the page framed <artifact>.localhost:<A's preview port>, which on
// B is B's own Chattering (or nothing): the panel stayed empty.
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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAAMIM/////w8AH+4F+7C4l8kAAAAASUVORK5CYII=', 'base64');
const raw = (url, headers = {}) => new Promise((resolve, reject) => {
  const r = require('node:http').get(url, { headers }, res => { let body = ''; res.on('data', b => body += b); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body })); });
  r.on('error', reject);
});

async function chattering(t, name, token, relayUrl, linkBase, prepare) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'link-previews-' + name + '-')));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  if (prepare) prepare(home, agent);
  require('./helpers/first-run.js').answerFirstRun(home);
  const port = await freePort(), previewPort = await freePort();
  registerConsole(port, token);
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(await freePort()), CHATTERING_PREVIEW_PORT: String(previewPort),
    CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, CHATTERING_HOST: '', CHATTERING_LAN: '', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: token, CHATTERING_HOSTNAME: name, CHATTERING_LINK_PORT_BASE: String(linkBase) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; ; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} if (i > 200) assert.fail(name + ' did not start\n' + log); await sleep(100); }
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })).json();
  await post('/api/anywhere/settings', { relay: relayUrl });
  return { home, base, port, previewPort, post, log: () => log };
}

test('a computer opened through a link shows what its agents made, from the link\'s own preview address', { skip: rtc.error || (!chromiumAvailable() && 'chromium is not installed'), timeout: 180000 }, async t => {
  const relay = createRelay({ env: {} });
  await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
  t.after(() => relay.close());
  const relayUrl = 'http://127.0.0.1:' + relay.server.address().port;
  const linkBase = 31000 + Math.floor(Math.random() * 20000);
  const key = 'pi:fixture/chat.jsonl';
  const A = await chattering(t, 'lambda', 'tok-a', relayUrl, linkBase + 100, (home, agent) => {
    const sessions = path.join(agent, 'sessions', 'fixture'), work = path.join(home, 'work'), site = path.join(work, 'site');
    fs.mkdirSync(sessions, { recursive: true }); fs.mkdirSync(site, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: work });
    fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><html><head><title>p</title></head><body><h1>PAGE FROM THE OTHER COMPUTER</h1><img id="pic" src="frog.png"></body></html>');
    fs.writeFileSync(path.join(site, 'frog.png'), PNG);
    let clock = 0;
    const ts = () => new Date(Date.UTC(2026, 8, 1, 12, 0, clock++)).toISOString();
    fs.writeFileSync(path.join(sessions, 'chat.jsonl'), [
      { type: 'session', version: 3, id: 'fixture', cwd: work },
      { type: 'message', id: 'q1', parentId: null, timestamp: ts(), message: { role: 'user', content: [{ type: 'text', text: 'Make a page' }] } },
      { type: 'message', id: 'a1', parentId: 'q1', timestamp: ts(), message: { role: 'assistant', model: 'm', provider: 'p', content: [{ type: 'toolCall', id: 'art', name: 'artifact', arguments: { path: 'site', title: 'The page' } }] } },
      { type: 'message', id: 'r1', parentId: 'a1', timestamp: ts(), message: { role: 'toolResult', toolCallId: 'art', toolName: 'artifact', content: [{ type: 'text', text: 'ok' }], isError: false } },
    ].map(JSON.stringify).join('\n') + '\n');
  });
  const B = await chattering(t, 'lilly-pc', 'tok-b', relayUrl, linkBase);
  for (let i = 0; ; i++) { try { if ((await (await fetch(A.base + '/api/sessions')).json()).some(s => s.key === key)) break; } catch {} if (i > 200) assert.fail('A did not index the conversation\n' + A.log()); await sleep(100); }

  const code = await A.post('/api/anywhere/pair');
  const linked = await B.post('/api/anywhere/links/add', { link: code.url });
  assert.equal(linked.error, undefined, linked.error);
  const link = linked.links[0];
  assert.equal(link.port, linkBase);
  assert.equal(link.previewPort, linkBase + 1, 'the link has a preview port of its own, next to its address');
  const at = `http://localhost:${link.port}`, previewAt = `http://127.0.0.1:${link.previewPort}`;

  // The link's preview port, without a browser: what a preview may ask, and nothing else.
  assert.equal((await raw(previewAt + '/api/settings')).status, 404, 'nothing of the app');
  assert.equal((await raw(previewAt + '/_c/kit.js', { Host: `elsewhere.example:${link.previewPort}` })).status, 421, 'for localhost names only');
  const kit = await raw(previewAt + '/_c/kit.js', { Host: `w1.localhost:${link.previewPort}` });
  assert.equal(kit.status, 200, 'the kit, from A\'s preview server');
  assert.match(kit.headers['content-security-policy'], new RegExp(`frame-ancestors 'self' http://localhost:${link.port} http://127.0.0.1:${link.port}$`), 'framed by the app at this link only');
  assert.doesNotMatch(kit.headers['content-security-policy'], new RegExp(`localhost:${A.port}`), 'A\'s own addresses mean nothing here');

  // ---- B's browser ----
  const profile = path.join(B.home, 'browser');
  const browser = spawn(chromiumBinary(), [...CHROMIUM_TEST_FLAGS, '--user-data-dir=' + profile, '--remote-debugging-port=0', '--disable-features=WebRtcHideLocalIpsWithMdns', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
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
  // Where to evaluate: the app (default), or a frame's own world ({ sid, contextId }).
  // Previews on another *.localhost name may run in a process of their own
  // (an out-of-process frame): found among the browser's targets then.
  const evaluate = async (expression, where = {}) => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(where.contextId ? { contextId: where.contextId } : {}) }, where.sid || sid);
    if (out.result?.exceptionDetails) return { error: JSON.stringify(out.result.exceptionDetails).slice(0, 400) };
    return out.result?.result?.value;
  };
  const until = async (expression, label, ms = 30000, where) => {
    const t0 = Date.now();
    for (;;) {
      const v = await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`, where);
      if (v === true) return;
      if (Date.now() - t0 > ms) assert.fail('Timed out: ' + label + '\n' + problems.join('\n') + '\n' + B.log().slice(-2000) + '\n' + A.log().slice(-2000));
      await sleep(50);
    }
  };
  const sessions = [sid], attached = new Set();
  const frames = async session => { const out = []; const walk = n => { out.push(n.frame); for (const c of n.childFrames || []) walk(c); }; const tree = (await send('Page.getFrameTree', {}, session)).result; if (tree) walk(tree.frameTree); return out; };
  const inFrame = async (match, label) => {
    const t0 = Date.now();
    for (;;) {
      for (const tg of (await send('Target.getTargets')).result.targetInfos) {
        if (tg.type !== 'iframe' || attached.has(tg.targetId)) continue;
        attached.add(tg.targetId);
        sessions.push((await send('Target.attachToTarget', { targetId: tg.targetId, flatten: true })).result.sessionId);
      }
      for (const session of sessions) {
        const f = (await frames(session)).find(match);
        if (f) return { sid: session, frameId: f.id, contextId: (await send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'test' }, session)).result.executionContextId };
      }
      if (Date.now() - t0 > 30000) assert.fail('no frame: ' + label + '\n' + problems.join('\n'));
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  // Signed in to B (its cookie reaches every localhost port), then A at the link.
  await send('Page.navigate', { url: `http://localhost:${B.port}/?token=tok-b` }, sid);
  await until(`document.readyState === 'complete' && location.search === ''`, 'signed in to B');
  await send('Page.navigate', { url: at + '/' }, sid);
  await until(`window.Artifacts && document.readyState === 'complete'`, 'A\'s app at the link');
  assert.equal(await evaluate(`fetch('/api/artifacts/config').then(r => r.json()).then(c => c.port)`), link.previewPort, 'the link answers with its own preview port');

  // ---- a web page A's agent made, in the artifact panel ----
  const pageSite = `.localhost:${link.previewPort}/a/`;
  await evaluate(`Artifacts.openPanel({ kind: 'files', key: ${JSON.stringify(key)}, path: 'site', title: 'The page' }); 1`);
  await until(`(() => { const f = document.querySelector('#artifactPane iframe.art-frame'); if (!f) return false; const u = new URL(f.src); return u.hostname.endsWith('.localhost') && u.port === '${link.previewPort}' && u.pathname.startsWith('/a/'); })()`, 'the panel frames the link\'s preview address');
  const page = await inFrame(f => f.url.includes(pageSite), 'the page');
  await until(`/PAGE FROM THE OTHER COMPUTER/.test(document.body.innerText)`, 'the page, from the other computer', 30000, page);
  await until(`document.getElementById('pic').complete && document.getElementById('pic').naturalWidth === 2`, 'its picture, through the tunnel', 30000, page);
  await shot('link-previews-1-page.png');
  assert.equal(await evaluate(`location.port`, page), String(link.previewPort), 'on the link\'s preview port, not the app\'s');
  await until(`document.documentElement.dataset.theme === 'light' || document.documentElement.dataset.theme === 'dark'`, 'the host\'s theme, from the app', 30000, page);
  assert.equal(await evaluate(`(() => { try { return !!window.parent.document; } catch { return false; } })()`, page), false, 'it cannot reach into the app');

  // ---- a widget (the MCP Apps sandbox proxy) ----
  const widgetHtml = '<!doctype html><html><head></head><body style="margin:0"><div id="w" style="height:240px">WIDGET BODY</div></body></html>';
  await evaluate(`Artifacts.openPanel({ kind: 'html', key: ${JSON.stringify(key)}, title: 'A widget', html: ${JSON.stringify(widgetHtml)}, site: 'wtest', source: 'widget' }); 1`);
  const proxy = await inFrame(f => f.url.startsWith(`http://wtest.localhost:${link.previewPort}/_c/proxy.html`), 'the sandbox proxy');
  const widget = await inFrame(f => f.url === 'about:srcdoc' && f.parentId === proxy.frameId, 'the widget inside the proxy');
  await until(`/WIDGET BODY/.test(document.body.innerText)`, 'the widget, its HTML from the app through the proxy', 30000, widget);
  await shot('link-previews-2-widget.png');
  assert.deepEqual(problems.filter(p => !/favicon|ERR_|net::/.test(p)), [], 'no errors on the page');
});
