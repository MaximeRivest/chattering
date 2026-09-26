'use strict';
// design/44: back and forward through the screens — the stack, the ‹ ›
// buttons, the long-press list, scroll return, reload, and foreign entries,
// against the real server and a headless Chromium.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromiumBinary } = require('./helpers/chromium.js');

test('back and forward through the screens', { timeout: 90000 }, async t => {
  // A plain Chromium, not the shared everyday one (test/helpers/chromium.js).
  const chromium = chromiumBinary();
  if (spawnSync(chromium, ['--version']).error) return t.skip('chromium is not installed');
  const root = path.join(__dirname, '..'), home = fs.mkdtempSync(path.join(os.homedir(), '.navigation-test-'));
  let server, browser, ws;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(timeout); }
  };
  t.after(async () => {
    ws?.close();
    await stop(browser); await stop(server);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const agent = path.join(home, '.pi/agent'), sessionDir = path.join(agent, 'sessions/fixture');
  fs.mkdirSync(sessionDir, { recursive: true });
  const work = path.join(home, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'README.md'), '# Navigation fixture\n\n' + 'A paragraph of the project readme, long enough to scroll.\n\n'.repeat(120));
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Initial']]) {
    const result = spawnSync('git', args, { cwd: work }); assert.equal(result.status, 0, String(result.stderr));
  }
  const msg = (id, parentId, role, text) => ({ type: 'message', id, parentId, timestamp: '2026-09-01T12:00:00Z', message: { role, content: [{ type: 'text', text }], model: 'fixture' } });
  const session = (name, title) => fs.writeFileSync(path.join(sessionDir, name + '.jsonl'), [
    { type: 'session', version: 3, id: name, cwd: work },
    msg('p', null, 'user', title), msg('a', 'p', 'assistant', 'Reply for ' + title + '.\n\n' + 'More of the reply. '.repeat(400)),
  ].map(JSON.stringify).join('\n') + '\n');
  session('alpha', 'Alpha question'); session('beta', 'Beta question');
  // Enough conversations that the project overview scrolls.
  for (let i = 0; i < 40; i++) session('filler' + i, 'Filler question ' + i);
  const keys = { alpha: 'pi:fixture/alpha.jsonl', beta: 'pi:fixture/beta.jsonl' };
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  let serverLog = '';
  require('./helpers/first-run.js').answerFirstRun(home); // no first-run modal over the page
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, HOME: home, PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => serverLog += b); server.stderr.on('data', b => serverLog += b);
  const base = 'http://127.0.0.1:' + port;
  let indexed = false;
  for (let i = 0; i < 150; i++) {
    try { const rows = await (await fetch(base + '/api/sessions')).json(); if (Object.values(keys).every(k => rows.some(s => s.key === k))) { indexed = true; break; } } catch {}
    if (server.exitCode != null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(indexed, serverLog);

  browser = spawn(chromium, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(Error(log)), 10000);
    browser.stderr.on('data', b => { log += b; const m = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    browser.on('error', reject);
  });
  ws = new WebSocket(endpoint); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(), exceptions = [];
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true }), sid = attached.result.sessionId;
  const evaluate = async expression => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
    assert.ok(!out.result?.exceptionDetails, JSON.stringify(out.result));
    return out.result?.result?.value;
  };
  const until = async (expression, label) => {
    for (let i = 0; i < 240; i++) { if (await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`)) return; await new Promise(r => setTimeout(r, 25)); }
    assert.fail('timed out: ' + (label || expression) + '\n' + exceptions.join('\n'));
  };
  const hash = () => evaluate(`decodeURIComponent(location.hash.slice(1))`);
  const stack = () => evaluate(`JSON.stringify({ n: nav.length(), i: nav.index(), back: nav.canBack(), fwd: nav.canForward(), titles: nav.entries().map(e => describeRoute(e.hash).title) })`).then(JSON.parse);
  const buttons = () => evaluate(`JSON.stringify({ back: $('navBack').disabled, fwd: $('navFwd').disabled, sideBack: $('sideBack').disabled, sideFwd: $('sideFwd').disabled, backTitle: $('navBack').title, fwdTitle: $('navFwd').title })`).then(JSON.parse);
  await send('Runtime.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
  await send('Page.enable', {}, sid);
  await send('Page.navigate', { url: base + '/' }, sid);
  await until(`typeof nav === 'object' && sessions.length >= 2 && nav.length() === 1`, 'the app booted with a one-entry stack');

  // ---- the stack follows the screens ----
  let s = await stack();
  assert.deepEqual(s, { n: 1, i: 0, back: false, fwd: false, titles: ['Gantt'] });
  let b = await buttons();
  assert.equal(b.back && b.fwd && b.sideBack && b.sideFwd, true, 'nothing to go to yet');
  assert.match(b.backTitle, /Nothing to go back to/);
  await evaluate(`open(${JSON.stringify(keys.alpha)})`);
  await until(`viewKind === 'conversation' && current && current.key === ${JSON.stringify(keys.alpha)}`);
  await evaluate(`showProjectOverview('work')`);
  await until(`viewKind === 'project' && document.querySelector('.project-overview')`);
  await evaluate(`open(${JSON.stringify(keys.beta)})`);
  await until(`viewKind === 'conversation' && current && current.key === ${JSON.stringify(keys.beta)}`);
  s = await stack();
  assert.deepEqual(s, { n: 4, i: 3, back: true, fwd: false, titles: ['Gantt', 'Alpha question', 'work', 'Beta question'] });
  b = await buttons();
  assert.equal(b.back, false); assert.equal(b.fwd, true);
  assert.match(b.backTitle, /^Back to work \(alt\+←\)/, 'the tooltip names the screen behind');
  assert.equal(await evaluate(`history.state.nav.id === nav.current().id`), true, 'the browser entry carries the stamp');
  // Opening the screen you are on adds nothing.
  await evaluate(`open(${JSON.stringify(keys.beta)})`);
  await new Promise(r => setTimeout(r, 200));
  assert.equal((await stack()).n, 4, 'reopening the current screen is not a new entry');

  // ---- ‹ goes back; › returns; the forward path drops on a new screen ----
  await evaluate(`$('navBack').click()`);
  await until(`viewKind === 'project' && nav.index() === 2`, 'back to the project');
  assert.equal(await hash(), 'project=work');
  b = await buttons();
  assert.equal(b.fwd, false, 'forward is now available');
  assert.match(b.fwdTitle, /^Forward to Beta question/);
  await evaluate(`$('sideBack').click()`);
  await until(`viewKind === 'conversation' && nav.index() === 1`, 'back again, from the column pair');
  await evaluate(`$('navFwd').click()`);
  await until(`viewKind === 'project' && nav.index() === 2`, 'forward');
  await evaluate(`open(${JSON.stringify(keys.alpha)})`);
  await until(`viewKind === 'conversation' && nav.index() === 3`);
  s = await stack();
  assert.deepEqual(s.titles, ['Gantt', 'Alpha question', 'work', 'Alpha question']);
  assert.equal(s.fwd, false, 'a new screen forgets the forward path, as a browser does');

  // ---- alt+arrows, and the browser's own back (the Android key) ----
  const key = k => evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, altKey: true, bubbles: true, cancelable: true }))`);
  await key('ArrowLeft');
  await until(`viewKind === 'project' && nav.index() === 2`, 'alt+← goes back');
  await key('ArrowRight');
  await until(`viewKind === 'conversation' && nav.index() === 3`, 'alt+→ goes forward');
  await evaluate(`history.back()`);
  await until(`viewKind === 'project' && nav.index() === 2`, 'the browser back button still drives the app');

  // ---- scroll comes back with the screen ----
  // The usage dashboard is a plain page that scrolls #view (a transcript
  // restores its own reading anchor; a note has an inner pane).
  const size = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sid);
  await size(1440, 520);
  await evaluate(`showUsageDashboard()`);
  await until(`viewKind === 'usage' && nav.index() === 3 && $('view').scrollHeight > $('view').clientHeight + 350`, 'the usage page is tall enough to scroll');
  await evaluate(`$('view').scrollTop = 300`);
  await evaluate(`open(${JSON.stringify(keys.beta)})`);
  await until(`viewKind === 'conversation' && current && current.key === ${JSON.stringify(keys.beta)}`);
  assert.deepEqual(await evaluate(`nav.entries()[3].scroll`), { view: 300, win: 0 }, 'the position was kept on the entry when the page was left: ' + await evaluate(`JSON.stringify(nav.entries().map(e => [e.id, e.kind, e.scroll]))`));
  await evaluate(`history.back()`);
  await until(`viewKind === 'usage' && nav.index() === 3 && Math.abs($('view').scrollTop - 300) < 3`, 'the usage page returns to where it was left');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await evaluate(`Math.abs($('view').scrollTop - 300) < 3`), true, 'and stays there while the page settles');
  await evaluate(`history.back()`);
  await until(`viewKind === 'project' && nav.index() === 2`);
  await size(1440, 900);

  // ---- the long-press / right-click list ----
  await evaluate(`$('navFwd').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
  await until(`document.querySelector('.nav-menu')`, 'the forward list opens');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.nav-menu button')].map(b => b.textContent.replace(/^\\S+\\s/, ''))`), ['usage', 'Beta question'], 'nearest first');
  await evaluate(`$('navBack').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
  await until(`document.querySelectorAll('.nav-menu').length === 1 && document.querySelector('.nav-menu .file-action-head').textContent === 'Back to'`, 'one list at a time');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.nav-menu button')].map(b => b.textContent.replace(/^\\S+\\s/, ''))`), ['Alpha question', 'Gantt'], 'nearest first');
  await evaluate(`document.querySelectorAll('.nav-menu button')[1].click()`);
  await until(`viewKind === 'home' && nav.index() === 0 && !document.querySelector('.nav-menu')`, 'two steps back in one pick');
  assert.equal((await buttons()).back, true, 'home is the first entry: nothing behind');
  assert.equal((await stack()).fwd, true);

  // ---- a reload keeps the stack and the place in it ----
  await evaluate(`$('navFwd').click()`);
  await until(`viewKind === 'conversation' && nav.index() === 1`);
  // The old page also satisfies the condition until it is gone: wait for a
  // page that does not carry the mark set before reloading.
  await evaluate('window.beforeNavReload = true');
  await send('Page.reload', {}, sid);
  await until(`!window.beforeNavReload && typeof nav === 'object' && sessions.length >= 2 && viewKind === 'conversation' && nav.length() === 5`, 'the stack survived the reload');
  s = await stack();
  assert.equal(s.i, 1);
  assert.equal(s.back && s.fwd, true, 'both directions still exist after a reload');
  await evaluate(`$('navFwd').click()`);
  await until(`viewKind === 'project' && nav.index() === 2`, 'forward works after a reload');

  // ---- a typed or linked hash is a new entry, stamped for next time ----
  await evaluate(`location.hash = '#' + ${JSON.stringify(keys.alpha)}`);
  await until(`viewKind === 'conversation' && nav.index() === 3 && nav.length() === 4 && history.state && history.state.nav`, 'a foreign hash joins the stack as the newest entry');
  assert.equal((await stack()).fwd, false);

  // ---- an in-screen change is not a new entry ----
  await evaluate(`showSettings()`);
  await until(`viewKind === 'settings'`);
  const before = (await stack()).n;
  await evaluate(`showSettingsPane('sound')`);
  await until(`location.hash === '#settings=sound'`);
  assert.equal((await stack()).n, before, 'switching a settings pane replaces the entry');
  assert.equal(await evaluate(`history.state.nav.id === nav.current().id`), true, 'the replaced entry keeps its stamp');
  assert.deepEqual(exceptions, [], 'no page errors');
});
