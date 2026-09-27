'use strict';
// R cells in the page, end to end with the real rat and R (no mocks): the
// chip, the kernel menu and the variables drawer follow the language of
// the cell that ran; completion uses where the kernel says the replaced
// text starts (df$co → df$col1). Skipped without Chromium, R + jsonlite,
// or a rat whose look answers --json.
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const TEST_TOKEN = 'test-install-token';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromiumBinary, chromiumAvailable } = require('./helpers/chromium.js');

const ratHelp = args => String(spawnSync('rat', [...args, '--help'], { encoding: 'utf8' }).stdout || '');
const haveGuide = /guide/.test(String(spawnSync('rat', ['--help'], { encoding: 'utf8' }).stdout || ''));

test('a language this computer lacks: "set up Julia" shows rat\'s guide for this system, for the person or their agent', { timeout: 120000, skip: !haveGuide && 'a rat with `rat guide` is missing' }, async t => {
  if (!chromiumAvailable()) return t.skip('chromium is not installed');
  const root = path.join(__dirname, '..'), home = fs.mkdtempSync(path.join(os.homedir(), '.notebook-r-test-'));
  let server, browser, ws;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  const minimalPath = [path.dirname(spawnSync('which', ['rat'], { encoding: 'utf8' }).stdout.trim()), path.dirname(process.execPath), path.dirname(spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim())].join(path.delimiter);
  const isolated = { ...require('./helpers/home-env.js').homeEnv(home), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_STATE_HOME: path.join(home, '.local', 'state') };
  t.after(async () => {
    ws?.close();
    spawnSync('rat', ['stop', '--all'], { env: { ...process.env, ...isolated }, stdio: 'ignore' });
    await require('./helpers/cleanup.js').stopAndRemove(browser, null); await stop(server);
    await require('./helpers/cleanup.js').stopAndRemove(null, home);
  });
  const agent = path.join(home, '.pi/agent'), sessionDir = path.join(agent, 'sessions/fixture');
  const work = path.join(home, 'work');
  fs.mkdirSync(sessionDir, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  const notebook = path.join(work, 'analysis.md');
  fs.writeFileSync(notebook, '# Julia\n\n```julia\nx = 1\n```\n');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Initial files']]) {
    const r = spawnSync('git', args, { cwd: work }); assert.equal(r.status, 0, String(r.stderr));
  }
  const msg = (id, parentId, role, text) => ({ type: 'message', id, parentId, timestamp: '2026-09-01T12:00:00Z', message: { role, content: [{ type: 'text', text }], model: 'fixture' } });
  fs.writeFileSync(path.join(sessionDir, 'chat.jsonl'), [{ type: 'session', version: 3, id: 'fixture', cwd: work }, msg('p', null, 'user', 'Hello'), msg('a', 'p', 'assistant', 'Hi.')].map(JSON.stringify).join('\n') + '\n');
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  registerConsole(port, TEST_TOKEN);
  let serverLog = '';
  require('./helpers/first-run.js').answerFirstRun(home); // no first-run modal over the page
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TOKEN: TEST_TOKEN, CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '0', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, ...isolated, RAT_NOTEBOOK_REQUIREMENTS: '', PATH: minimalPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => serverLog += b); server.stderr.on('data', b => serverLog += b);
  const base = 'http://127.0.0.1:' + port, key = 'pi:fixture/chat.jsonl';
  let indexed = false;
  for (let i = 0; i < 200; i++) {
    try { const rows = await (await fetch(base + '/api/sessions')).json(); if (rows.some(s => s.key === key)) { indexed = true; break; } } catch {}
    if (server.exitCode != null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(indexed, serverLog);
  assert.equal((await fetch(base + '/notebook-tabs.js')).status, 200);

  browser = spawn(chromiumBinary(), [...require('./helpers/chromium.js').CHROMIUM_TEST_FLAGS, '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
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
  const sid = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
  const evaluate = async expression => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
    assert.ok(!out.result?.exceptionDetails, JSON.stringify(out.result));
    return out.result?.result?.value;
  };
  const until = async (expr, what) => {
    // A page still loading may not define what the condition names yet.
    // Up to twenty seconds, as the shared helper allows a loaded machine.
    for (let i = 0; i < 400; i++) { if (await evaluate(`(()=>{try{return !!(${expr})}catch{return false}})()`)) return; await new Promise(r => setTimeout(r, 50)); }
    assert.fail(what + '\n' + exceptions.join('\n'));
  };
  await send('Runtime.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await send('Network.setCookie', { name: 'chattering', value: TEST_TOKEN, url: base }, sid);
  await send('Page.navigate', { url: base + '/#' + encodeURIComponent(key) }, sid);
  await until(`typeof NotebookTabs !== 'undefined' && viewKind === 'conversation' && document.querySelector('#conversationTranscript')?.textContent.includes('Hi.')`, 'the app did not load');
  assert.equal(await evaluate(`sideLayoutOn() && !$('agentsPop').hidden`), true, 'the side column is the default layout');


  const shot = name => send('Page.captureScreenshot', { format: 'png' }, sid).then(r => fs.writeFileSync(path.join(os.tmpdir(), name), Buffer.from(r.result.data, 'base64')));


  await evaluate(`openLiveFile(${JSON.stringify(notebook)}, { project: 'work' })`);
  await until(`!!(docState && docState.editor && docState.path === ${JSON.stringify(notebook)} && docState.editor.listCells().length === 1)`, 'the notebook did not open');
  await evaluate(`refreshDocDoctor(); 0`);
  await until(`!!document.querySelector('.doc-setup-lang[data-lang="jl"]')`, 'no "set up Julia" button: ' + 'x');
  assert.equal(await evaluate(`document.querySelector('.doc-setup-lang').textContent`), 'set up Julia…');
  await evaluate(`document.querySelector('.doc-setup-lang').click(); 0`);
  await until(`!!document.querySelector('.doc-setup-guide pre')`, 'the guide did not open');
  const guide = await evaluate(`document.querySelector('.doc-setup-guide pre').textContent`);
  assert.match(guide, /^# Set up Julia for notebooks/);
  assert.match(guide, /## On this computer \((NixOS|Linux|macOS|Windows)\)/);
  assert.ok(guide.includes('rat doctor ' + notebook), 'the guide names the notebook');
  assert.match(guide, /## For an AI agent doing this/);
  assert.equal(await evaluate(`!!document.querySelector('.doc-guide-copy') && !!document.querySelector('.doc-guide-check')`), true);
  await shot('notebook-setup-guide.png');
  assert.deepEqual(exceptions, []);
});
