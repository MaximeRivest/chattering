'use strict';
// Artifacts (design/67): the preview origin's rules, and a real server with
// versions from checkpoints, followed by the reader's head, in a real browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const preview = require('../preview.js');
const { chromiumBinary } = require('./helpers/chromium.js');

const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };

test('capabilities are signed, expire, and survive a restart through their secret file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-'));
  try {
    const file = path.join(dir, 'secret');
    const a = new preview.Capabilities(file);
    // Unix permission bits; Windows keeps it private by the per-user folder's access list.
    if (process.platform !== 'win32') assert.equal((fs.statSync(file).mode & 0o777), 0o600);
    const token = a.sign({ u: 'me', k: 'k', r: '/tmp/x', e: '' });
    assert.equal(new preview.Capabilities(file).verify(token).r, '/tmp/x', 'the same secret after a restart');
    const [body, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), r: '/' })).toString('base64url') + '.' + mac;
    assert.throws(() => a.verify(forged), /Unknown preview/);
    assert.throws(() => a.verify(a.sign({ r: '/x' }, -1)), /expired/);
    assert.throws(() => a.verify('nonsense'), /Unknown preview/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('policies: open by default, libraries on request, never plugins, framed only by Chattering', () => {
  const open = preview.contentPolicy('open', ['http://127.0.0.1:7433']);
  assert.match(open, /connect-src \*/);
  assert.match(open, /object-src 'none'/);
  assert.match(open, /frame-ancestors 'self' http:\/\/127\.0\.0\.1:7433/);
  const libs = preview.contentPolicy('libraries', []);
  assert.match(libs, /connect-src 'self' https:\/\/cdn\.jsdelivr\.net/);
  assert.doesNotMatch(libs, /connect-src \*/);
  const page = preview.proxyPage('http://127.0.0.1:7433');
  assert.match(page, /const HOST = "http:\/\/127\.0\.0\.1:7433"/);
  assert.match(page, /sandbox-proxy-ready/);
  assert.match(preview.withKit('<html><head><title>x</title></head></html>'), /<head><script src="\/_c\/kit\.js"><\/script><title>/);
  assert.match(preview.withKit('<p>bare</p>'), /^<script src="\/_c\/kit\.js"><\/script><p>/);
});

test('a real server: versions follow the head, the preview origin serves them, widgets and hardening', { timeout: 90000 }, async t => {
  const root = path.join(__dirname, '..'), home = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-'));
  const agent = path.join(home, '.pi/agent'), sessions = path.join(agent, 'sessions/fixture'), work = path.join(home, 'work');
  const site = path.join(work, 'site');
  fs.mkdirSync(sessions, { recursive: true }); fs.mkdirSync(site, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: work });
  let server, browser, ws;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer);
  };
  // Pi workers finish within seconds of the server's exit: the removal retries (helpers/cleanup.js).
  t.after(async () => { ws?.close(); await stop(browser); await stop(server); await require('./helpers/cleanup.js').stopAndRemove(null, home); });

  // Two versions of the page, captured after two tool calls, as the
  // checkpoint extension does during a run.
  const { CheckpointStore } = require('../checkpoint-store.js');
  const store = new CheckpointStore(path.join(home, 'checkpoints'));
  await store.addArtifactScope(work, site);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><html><head><title>v</title></head><body><h1>FIRST PAGE</h1><img src="frog.png"></body></html>');
  fs.writeFileSync(path.join(site, 'frog.png'), png);
  const v1 = await store.capture(work, { session: 's', run: 'r', call: 'c1', tool: 'write', phase: 'after' });
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><html><head><title>v</title></head><body><h1>SECOND PAGE</h1></body></html>');
  const v2 = await store.capture(work, { session: 's', run: 'r', call: 'c2', tool: 'edit', phase: 'after' });
  store.close();
  assert.ok(v1.snapshot && v2.snapshot && v1.snapshot !== v2.snapshot);

  let clock = 0;
  const ts = () => new Date(Date.UTC(2026, 8, 1, 12, 0, clock++)).toISOString();
  const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
  const assistant = (id, parentId, content) => ({ type: 'message', id, parentId, timestamp: ts(), message: { role: 'assistant', model: 'm', provider: 'p', content } });
  const result = (id, parentId, callId, name) => ({ type: 'message', id, parentId, timestamp: ts(), message: { role: 'toolResult', toolCallId: callId, toolName: name, content: [{ type: 'text', text: 'ok' }], isError: false } });
  const user = (id, parentId, text) => ({ type: 'message', id, parentId, timestamp: ts(), message: { role: 'user', content: [{ type: 'text', text }] } });
  const widgetHtml = '<!doctype html><html><head></head><body style="margin:0"><div id="w" style="height:300px;background:var(--color-background-secondary,#eee)">WIDGET BODY</div></body></html>';
  fs.writeFileSync(path.join(sessions, 'chat.jsonl'), [
    { type: 'session', version: 3, id: 'fixture', cwd: work },
    user('q1', null, 'Make a page'),
    assistant('a1', 'q1', [call('c1', 'write', { path: 'site/index.html', content: '…' })]), result('r1', 'a1', 'c1', 'write'),
    assistant('a2', 'r1', [call('art', 'artifact', { path: 'site', title: 'The page' }), call('w1', 'show', { html: widgetHtml, title: 'A widget' })]),
    result('r2', 'a2', 'art', 'artifact'), result('r3', 'r2', 'w1', 'show'),
    // A declaration that failed is not an artifact.
    assistant('af', 'r3', [call('bad', 'artifact', { path: 'nothing-here' })]),
    { type: 'message', id: 'rf', parentId: 'af', timestamp: ts(), message: { role: 'toolResult', toolCallId: 'bad', toolName: 'artifact', content: [{ type: 'text', text: 'Nothing at …' }], isError: true } },
    assistant('a3', 'rf', [{ type: 'text', text: 'Here it is.' }]),
    user('q2', 'a3', 'Change the title'),
    assistant('a4', 'q2', [call('c2', 'edit', { path: 'site/index.html', edits: [] })]), result('r4', 'a4', 'c2', 'edit'),
    assistant('a5', 'r4', [{ type: 'text', text: 'Changed.\n\n```html\n<p>CODE BLOCK PAGE</p>\n```' }]),
  ].map(JSON.stringify).join('\n') + '\n');

  const port = await freePort(), previewPort = await freePort();
  const base = 'http://127.0.0.1:' + port, token = 'artifact-test-token', auth = { Authorization: 'Bearer ' + token };
  let log = '';
  require('./helpers/first-run.js').answerFirstRun(home); // no first-run modal over the page
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, HOME: home, PORT: String(port), CHATTERING_PREVIEW_PORT: String(previewPort),
    CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_TOKEN: token, CHATTERING_NO_SYNC: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'),
    CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  const key = 'pi:fixture/chat.jsonl';
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    try { ready = (await (await fetch(base + '/api/sessions', { headers: auth })).json()).some(s => s.key === key); } catch {}
    if (!ready) await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, log);
  const api = async (p, opts = {}) => { const r = await fetch(base + p, { ...opts, headers: { ...auth, ...(opts.headers || {}) } }); return { status: r.status, body: await r.json().catch(() => null) }; };

  // Versions along the path: at the end both, and the disk equals the last.
  const q = (extra = {}) => '/api/artifacts/resolve?' + new URLSearchParams({ id: key, path: 'site', ...extra });
  const end = (await api(q())).body;
  assert.equal(end.kind, 'web');
  assert.deepEqual(end.versions.map(v => v.id), [v1.snapshot, v2.snapshot]);
  assert.equal(end.show, v2.snapshot);
  assert.equal(end.live.same, true);
  // At an earlier point of the conversation: only the first version.
  const early = (await api(q({ head: 'a3' }))).body;
  assert.deepEqual(early.versions.map(v => v.id), [v1.snapshot]);
  assert.equal(early.show, v1.snapshot);

  // The preview origin serves each version, with the kit, the policy, and
  // the picture captured with the first version.
  const pv = (cap, version, file = '') => fetch(`http://127.0.0.1:${previewPort}/a/${cap}/${version}/${file}`);
  let r = await pv(end.cap, v1.snapshot);
  const first = await r.text();
  assert.match(first, /FIRST PAGE/);
  assert.match(first, /<script src="\/_c\/kit\.js"><\/script>/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self' http:\/\/localhost:/);
  assert.equal(r.headers.get('x-chattering-source'), 'version');
  assert.equal(r.headers.get('set-cookie'), null);
  r = await pv(end.cap, v1.snapshot, 'frog.png');
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
  assert.match(await (await pv(end.cap, 'live')).text(), /SECOND PAGE/);
  // Tamper inside the signature (its last character carries padding bits).
  const at = end.cap.length - 10, forged = end.cap.slice(0, at) + (end.cap[at] === 'A' ? 'B' : 'A') + end.cap.slice(at + 1);
  assert.equal((await pv(forged, 'live')).status, 404);
  assert.equal((await pv(end.cap, 'live', '..%2F..%2Fetc%2Fpasswd')).status, 400);

  // A widget's HTML comes from its tool call; the app side refuses requests
  // that other pages start.
  const widget = (await api('/api/artifacts/widget?' + new URLSearchParams({ id: key, entry: 'a2', call: 'w1' }))).body;
  assert.equal(widget.html, widgetHtml);
  assert.equal((await fetch(base + '/api/sessions', { headers: { Cookie: 'chattering=' + token, 'Sec-Fetch-Site': 'same-site' } })).status, 403);
  assert.equal((await fetch(base + '/api/sessions', { headers: { Cookie: 'chattering=' + token, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);

  // The artifact tool's call: the folder becomes versioned; addresses to test.
  const declared = (await api('/api/artifacts/declare', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: path.join(sessions, 'chat.jsonl'), path: 'site', title: 'The page' }) })).body;
  assert.equal(declared.kind, 'web');
  assert.match(declared.urls[0], new RegExp(`^http://[0-9a-f]{20}\\.localhost:${previewPort}/a/`));

  // ---- the browser --------------------------------------------------------
  const bin = chromiumBinary();
  if (spawnSync(bin, ['--version']).error) return t.skip('chromium is not installed');
  browser = spawn(bin, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(Error(out)), 10000);
    browser.stderr.on('data', b => { out += b; const m = out.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
  });
  ws = new WebSocket(endpoint); await new Promise(res => ws.onopen = res);
  let id = 0; const pending = new Map(), exceptions = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}, sessionId) => new Promise(res => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const sid = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
  const evaluate = async expression => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
    assert.ok(!out.result?.exceptionDetails, JSON.stringify(out.result?.exceptionDetails));
    return out.result?.result?.value;
  };
  const until = async (expression, label) => {
    for (let i = 0; i < 400; i++) { if (await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`)) return; await new Promise(res => setTimeout(res, 25)); }
    assert.fail('Timed out: ' + label + '\n' + exceptions.join('\n') + '\n' + log.slice(-2000));
  };
  await send('Runtime.enable', {}, sid); await send('Page.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  // localhost, so previews get their own *.localhost site.
  await send('Page.navigate', { url: `http://localhost:${port}/?token=${token}#${encodeURIComponent(key)}` }, sid);
  await until(`current && current.key === ${JSON.stringify(key)} && document.querySelector('.art-card')`, 'the artifact card');

  // The widget: through the sandbox proxy, initialised, sized to its content.
  await until(`document.querySelector('.art-widget iframe') && parseInt(document.querySelector('.art-widget iframe').style.height) >= 290`, 'the widget sized to 300px');
  assert.match(await evaluate(`document.querySelector('.art-widget iframe').src`), new RegExp(`^http://w[0-9a-f]{8}\\.localhost:${previewPort}/_c/proxy\\.html\\?host=`));

  // The panel opens beside the conversation at the head's version.
  await evaluate(`document.querySelector('.art-card .art-open').click(); 1`);
  await until(`document.body.classList.contains('artifact-open') && document.querySelector('#artifactPane iframe')`, 'the panel');
  const src = await evaluate(`document.querySelector('#artifactPane iframe').src`);
  assert.ok(src.includes('/' + v2.snapshot + '/'), src);
  const box = await evaluate(`JSON.stringify([document.getElementById('artifactPane').getBoundingClientRect().left, document.getElementById('view').getBoundingClientRect().right])`);
  const [paneLeft, viewRight] = JSON.parse(box);
  assert.ok(paneLeft >= viewRight - 2, 'beside, not over, the conversation: ' + box);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.art-version option')].map(o => o.value)`), [v1.snapshot, v2.snapshot]);

  // The conversation keeps a readable column whatever width was saved: a
  // panel dragged wide on a big screen, or a window made smaller since.
  // The reading column keeps 420px; the composer in it, its margins aside.
  const convWidth = `(() => { const v = document.getElementById('view').getBoundingClientRect().width, c = document.getElementById('composerDock')?.getBoundingClientRect().width; return v >= 419 && (c == null || c >= 380) ? v : 0; })()`;
  await evaluate(`document.body.style.setProperty('--art-w', '5000px'); 1`);
  await until(`${convWidth} > 0`, 'a saved width that leaves no room');
  const shot = async name => { if (!process.env.CHATTERING_SHOTS) return; await evaluate(`document.querySelector('dialog.bg-ask [data-none]')?.click(); 1`); await new Promise(r => setTimeout(r, 800)); const r = await send('Page.captureScreenshot', { format: 'png' }, sid); fs.writeFileSync(path.join(process.env.CHATTERING_SHOTS, name), Buffer.from(r.result.data, 'base64')); };
  await shot('artifact-wide.png');
  // Too narrow for list, conversation and panel side by side: the panel
  // lies over the conversation, as the Files panel does, and every part of
  // it stays inside the window.
  for (const w of [1000, 760]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
    await until(`innerWidth === ${w} && document.body.classList.contains('side-layout')`);
    const r = JSON.parse(await evaluate(`JSON.stringify({ pane: document.getElementById('artifactPane').getBoundingClientRect(), conv: ${convWidth} })`));
    assert.ok(r.pane.left >= 0 && r.pane.right <= w + 1 && r.pane.width >= 320, w + ': the panel fits the window: ' + JSON.stringify(r));
    assert.ok(r.conv > 0, w + ': the conversation under it keeps its width: ' + JSON.stringify(r));
    // Floating buttons only: the voice button now lives in the list's foot.
    await until(`(() => { const s = document.getElementById('side').getBoundingClientRect(); return [...document.querySelectorAll('#filesToggle, #voiceOnButton.corner')].every(b => { const r = b.getBoundingClientRect(); return !r.width || r.left >= s.right; }); })()`, w + ': no floating button over the list');
    await shot('artifact-' + w + '.png');
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await evaluate(`document.body.style.removeProperty('--art-w'); 1`);
  await until(`innerWidth === 1500`);
  // Moving the head to before the change shows the first version.
  await evaluate(`moveReading(current.key, 'a3', { exact: true })`);
  await until(`document.querySelector('#artifactPane iframe')?.src.includes(${JSON.stringify('/' + v1.snapshot + '/')})`, 'the earlier version');
  assert.match(await evaluate(`document.querySelector('.art-banner').textContent`), /different now/);
  await evaluate(`moveReading(current.key, 'a3', { exact: false })`);
  await until(`document.querySelector('#artifactPane iframe')?.src.includes(${JSON.stringify('/' + v2.snapshot + '/')})`, 'back to the last version');

  // A code block gets a preview that opens in the panel through the proxy.
  await until(`document.querySelector('pre.md-code[data-lang="html"] .md-preview')`, 'the code preview button');
  await evaluate(`document.querySelector('pre.md-code[data-lang="html"] .md-preview').click(); 1`);
  await until(`document.querySelector('#artifactPane iframe')?.src.includes('/_c/proxy.html')`, 'the code preview in the panel');
  // Leaving the conversation hides the panel.
  await evaluate(`goHome(); 1`);
  await until(`!document.body.classList.contains('artifact-open')`, 'the panel closes with its conversation');

  // A picture floats: picture in picture, over whatever page, taking no
  // column, moved by its head, always whole on screen, and it stays when
  // the person goes to a conversation. Away from a conversation there is
  // nothing to be beside, so only "float" is offered.
  const dot = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="red"/></svg>');
  await evaluate(`openMediaLightbox(${JSON.stringify(dot)}, 'dot.svg'); 1`);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.media-lightbox [data-media-act]')].map(b => b.dataset.mediaAct)`), ['float', 'close']);
  await evaluate(`document.querySelector('.media-lightbox [data-media-act="float"]').click(); 1`);
  await until(`document.body.classList.contains('artifact-float') && !document.body.classList.contains('artifact-open') && document.querySelector('#artifactPane .art-media img') && !document.querySelector('.media-lightbox')`, 'the picture floating');
  const rect = () => evaluate(`JSON.stringify(document.getElementById('artifactPane').getBoundingClientRect())`).then(JSON.parse);
  const before = await rect();
  assert.ok(before.width >= 220 && before.right <= 1500 && before.left >= 0, JSON.stringify(before));
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, sid);
  await evaluate(`document.querySelector('dialog.bg-ask [data-none]')?.click(); 1`);
  await until(`!document.querySelector('dialog.bg-ask')`, 'the first-run question answered');
  const title = JSON.parse(await evaluate(`JSON.stringify(document.querySelector('#artifactPane .art-titles').getBoundingClientRect())`));
  const hx = title.left + 20, hy = title.top + title.height / 2;
  await mouse('mousePressed', hx, hy); await mouse('mouseMoved', hx - 300, hy + 200); await mouse('mouseReleased', hx - 300, hy + 200);
  const moved = await rect();
  assert.ok(Math.abs(moved.left - (before.left - 300)) <= 2 && Math.abs(moved.top - (before.top + 200)) <= 2, 'moved by its head: ' + JSON.stringify(moved));
  await mouse('mousePressed', hx - 300, hy + 200); await mouse('mouseMoved', 5000, 5000); await mouse('mouseReleased', 5000, 5000);
  const edge = await rect();
  assert.ok(Math.abs(edge.right - 1500) <= 1 && Math.abs(edge.bottom - 1000) <= 1, 'kept whole on screen: ' + JSON.stringify(edge));
  await evaluate(`open(${JSON.stringify(key)}, 'bottom')`);
  await until(`current && current.key === ${JSON.stringify(key)} && document.querySelector('.art-card')`, 'the conversation under the picture');
  assert.equal(await evaluate(`document.body.classList.contains('artifact-float') && Artifacts.state().kind`), 'media', 'the float stays and is not replaced by what the conversation had open');
  await shot('float-desktop.png');
  // A phone-sized window: it fits inside, above the phone's bar. Back to the
  // big window, it is where the person put it, not shrunk.
  await send('Emulation.setDeviceMetricsOverride', { width: 400, height: 850, deviceScaleFactor: 2, mobile: true }, sid);
  await until(`innerWidth === 400 && (() => { const r = document.getElementById('artifactPane').getBoundingClientRect(), bar = document.getElementById('phoneBar'), top = bar && !bar.hidden && bar.getClientRects().length ? bar.getBoundingClientRect().top : innerHeight; return r.left >= 0 && r.right <= 401 && r.top >= 0 && r.bottom <= top + 1; })()`, 'the float fits a phone');
  await shot('float-phone.png');
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await until('innerWidth === 1500');
  assert.deepEqual(await rect(), edge, 'the chosen place comes back');
  // Docked, it goes beside the conversation; floating again, same place.
  await evaluate(`document.querySelector('#artifactPane [data-art-act="float"]').click(); 1`);
  await until(`document.body.classList.contains('artifact-open') && !document.body.classList.contains('artifact-float')`, 'docked');
  const docked = JSON.parse(await evaluate(`JSON.stringify([document.getElementById('artifactPane').getBoundingClientRect().left, document.getElementById('view').getBoundingClientRect().right])`));
  assert.ok(docked[0] >= docked[1] - 2, 'beside the conversation: ' + docked);
  await evaluate(`document.querySelector('#artifactPane [data-art-act="float"]').click(); 1`);
  assert.deepEqual(await rect(), edge);
  await evaluate(`document.querySelector('#artifactPane [data-art-act="close"]').click(); 1`);
  await until(`!document.body.classList.contains('artifact-float') && !Artifacts.state()`, 'closed');
  // From a conversation, a picture can also go beside it.
  await evaluate(`openMediaLightbox(${JSON.stringify(dot)}, 'dot.svg'); document.querySelector('.media-lightbox [data-media-act="side"]').click(); 1`);
  await until(`document.body.classList.contains('artifact-open') && document.querySelector('#artifactPane .art-media img')`, 'the picture beside the conversation');
  await evaluate(`Artifacts.closePanel(); 1`);

  // The library: the conversation list carries each conversation's artifacts
  // (indexed with it, no scan); the right panel lists them and opens one
  // where it was made.
  const listed = (await api('/api/sessions')).body.find(s => s.key === key);
  assert.deepEqual(listed.artifacts.map(a => a.widget ? 'widget:' + a.title : a.path), [site, 'widget:A widget']);
  await evaluate(`setRightFiles('recent-files', true); document.querySelector('[data-right-view="artifacts"]').click(); 1`);
  await until(`document.querySelectorAll('#rightFileList .art-lib-row').length === 2`, 'two artifacts listed');
  await evaluate(`(() => { const s = document.querySelector('.art-lib-search'); s.value = 'widget'; s.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await until(`document.querySelectorAll('#rightFileList .art-lib-row').length === 1`, 'the search narrows the list');
  await evaluate(`(() => { const s = document.querySelector('.art-lib-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await until(`document.querySelectorAll('#rightFileList .art-lib-row').length === 2`, 'the whole list again');
  await evaluate(`[...document.querySelectorAll('#rightFileList .art-lib-row')].find(r => r.textContent.includes('The page')).querySelector('.art-lib-open').click(); 1`);
  await until(`current && current.key === ${JSON.stringify(key)} && document.body.classList.contains('artifact-open') && document.querySelector('.art-title').textContent === 'The page'`, 'opened from the library');
  assert.equal(await evaluate(`rightFilesOpen`), false, 'one right panel at a time');
  // Files the artifact holds carry its mark in the Files list.
  assert.equal(await evaluate(`Artifacts.library.items().length`), 2);
  assert.match(await evaluate(`Artifacts.library.ownerMarkHtml(${JSON.stringify(path.join(site, 'index.html'))})`), /data-art-owner="f\|/);
  assert.deepEqual(exceptions.filter(e => !/ResizeObserver/.test(e)), []);
});
