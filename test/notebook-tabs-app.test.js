'use strict';
// Local requests sign in like every client (design/69): the test server's
// install token, sent by consoleFetch on 127.0.0.1 and set as the browser's cookie.
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const TEST_TOKEN = 'test-install-token';
// Notebooks kept open in the side list (notebook-tabs.js, design/68): a
// notebook run here keeps running when the person goes elsewhere, its
// results land in the document (and on disk), its row says what it is
// doing, and coming back shows the same editor. rat is mocked: this is
// about the page, not the kernel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromiumBinary } = require('./helpers/chromium.js');

test('a notebook runs on while you are elsewhere, and comes back as it was', { timeout: 90000 }, async t => {
  if (spawnSync(chromiumBinary(), ['--version']).error) return t.skip('chromium is not installed');
  const root = path.join(__dirname, '..'), home = fs.mkdtempSync(path.join(os.homedir(), '.notebook-tabs-test-'));
  let server, browser, ws;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  t.after(async () => {
    ws?.close();
    await require('./helpers/cleanup.js').stopAndRemove(browser, null); await stop(server);
    await require('./helpers/cleanup.js').stopAndRemove(null, home);
  });
  const agent = path.join(home, '.pi/agent'), sessionDir = path.join(agent, 'sessions/fixture');
  const work = path.join(home, 'work');
  fs.mkdirSync(sessionDir, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  const notebook = path.join(work, 'analysis.md'), other = path.join(work, 'notes.md');
  fs.writeFileSync(notebook, '# Analysis\n\n```python\nfirst = 1\n```\n\nBetween.\n\n```python\nsecond = 2\n```\n');
  fs.writeFileSync(other, '# Notes\n\nPlain prose.\n');
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
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TOKEN: TEST_TOKEN, CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '0', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => serverLog += b); server.stderr.on('data', b => serverLog += b);
  const base = 'http://127.0.0.1:' + port, key = 'pi:fixture/chat.jsonl';
  let indexed = false;
  for (let i = 0; i < 150; i++) {
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
    for (let i = 0; i < 160; i++) { if (await evaluate(`(()=>{try{return !!(${expr})}catch{return false}})()`)) return; await new Promise(r => setTimeout(r, 50)); }
    assert.fail(what + '\n' + exceptions.join('\n'));
  };
  await send('Runtime.enable', {}, sid);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
  await send('Network.setCookie', { name: 'chattering', value: TEST_TOKEN, url: base }, sid);
  await send('Page.navigate', { url: base + '/#' + encodeURIComponent(key) }, sid);
  await until(`typeof NotebookTabs !== 'undefined' && viewKind === 'conversation' && document.querySelector('#conversationTranscript')?.textContent.includes('Hi.')`, 'the app did not load');
  assert.equal(await evaluate(`sideLayoutOn() && !$('agentsPop').hidden`), true, 'the side column is the default layout');

  // rat mocked: every run is a stream the test drives; the doctor says ready.
  await evaluate(`(() => {
    window.streams = [];
    const real = window.fetch;
    window.fetch = (url, opts) => {
      const u = String(url);
      if (u.includes('/api/doc/run-cell')) return Promise.resolve(new Response(new ReadableStream({ start(c) { streams.push({ c, body: JSON.parse(opts.body) }); } }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
      if (u.includes('/api/doc/doctor')) return Promise.resolve(new Response(JSON.stringify({ ok: true, project: 'x', project_source: 'detected', checks: [], actions: [], steps: [], python: { kernel: 'fixture', venv: '/v', venv_exists: true, kernel_running: true } })));
      if (u.includes('/api/doc/follow') || u.includes('/api/doc/cancel-run')) return Promise.resolve(new Response(JSON.stringify({ ok: true, kernels: [] })));
      // Environment setup too: whatever rat this machine has (or none) plays no part.
      if (u.includes('/api/doc/ensure')) return Promise.resolve(new Response(JSON.stringify({ ok: true, changed: false, steps: [] })));
      return real(url, opts);
    };
    window.emit = (i, ev) => streams[i].c.enqueue(new TextEncoder().encode(JSON.stringify(ev) + '\\n'));
    window.finish = (i, out) => { emit(i, { type: 'done', code: 0, out, runtime: 'py', ms: 1200 }); streams[i].c.close(); };
  })()`);

  // Open the notebook: not listed until something runs in it.
  await evaluate(`openLiveFile(${JSON.stringify(notebook)}, { project: 'work' })`);
  await until(`!!(docState && docState.editor && docState.path === ${JSON.stringify(notebook)})`, 'the notebook did not open');
  assert.equal(await evaluate(`document.querySelectorAll('.ag-row.ag-nb').length`), 0, 'opening alone lists nothing');

  // Run the first cell; the row appears, working.
  await evaluate(`window.first = docState; runDocCell(docState.editor.listCells()[0]); 0`);
  for (let i = 0; i < 160 && !(await evaluate(`streams.length === 1`)); i++) await new Promise(r => setTimeout(r, 50));
  if (!(await evaluate(`streams.length === 1`))) assert.fail('the run was not requested; the page said: ' + await evaluate(`JSON.stringify({ toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent), running: docState && docState.running, runner: !!(docState && docState.runner), cells: docState && docState.editor && docState.editor.listCells().length })`));
  await evaluate(`emit(0, { type: 'output', text: 'working on it\\n' })`);
  await until(`!!document.querySelector('.ag-row.ag-nb.working.current')`, 'the notebook row is not listed as running');
  assert.match(await evaluate(`document.querySelector('.ag-row.ag-nb .ag-dir').textContent`), /running a cell/);

  // Go elsewhere: the notebook is parked, not closed; the run goes on.
  await evaluate(`openLiveFile(${JSON.stringify(other)}, { project: 'work' })`);
  await until(`!!(docState && docState.path === ${JSON.stringify(other)})`, 'the other file did not open');
  assert.deepEqual(await evaluate(`({ closed: !!first.closed, ws: first.ws, attached: first.body.isConnected, running: !!first.runner.running })`), { closed: false, ws: null, attached: false, running: true });
  await until(`!!document.querySelector('.ag-row.ag-nb.working:not(.current)')`, 'the parked notebook row does not say it runs');
  fs.writeFileSync(path.join(os.tmpdir(), 'notebook-tabs-running.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, sid)).result.data, 'base64'));

  // The run ends while parked: its output is written into the notebook and saved to disk.
  await evaluate(`finish(0, 'working on it\\ndone\\n\\n\u2713 1.2s | 1 var')`);
  await until(`!first.runner.running && first.editor.getContent().includes('\\x60\\x60\\x60output\\nworking on it\\ndone\\n\\x60\\x60\\x60')`, 'the parked notebook did not get its output');
  for (let i = 0; i < 100 && !fs.readFileSync(notebook, 'utf8').includes('working on it\ndone'); i++) await new Promise(r => setTimeout(r, 100));
  assert.match(fs.readFileSync(notebook, 'utf8'), /```output\nworking on it\ndone\n```/, 'the output did not reach the disk');
  assert.equal(await evaluate(`docState.path`), other, 'the page stayed where the person went');
  await until(`!!document.querySelector('.ag-row.ag-nb.unread')`, 'a run that ended off screen is not marked');
  assert.match(await evaluate(`[...document.querySelectorAll('#toasts .toast')].map(t => t.textContent).join('|')`), /analysis · cell finished/);

  // Back through the row: the same editor, the mark read.
  await evaluate(`document.querySelector('.ag-row.ag-nb .ag-main').click()`);
  await until(`docState === first && first.body.isConnected`, 'the row did not bring the same editor back');
  assert.equal(await evaluate(`fileWs.editor === first.editor`), true);
  await until(`!!document.querySelector('.ag-row.ag-nb.current:not(.unread)')`, 'the row is not current and read');

  // Run all, then leave after the first cell: the queue goes on in the background.
  await evaluate(`runAllDocCells(); 0`);
  await until(`streams.length === 2`, 'run all did not start');
  await until(`/running all · cell 1 of 2/.test(document.querySelector('.ag-row.ag-nb .ag-dir')?.textContent || '')`, 'the row does not follow run all');
  await evaluate(`open(${JSON.stringify(key)})`);
  await until(`viewKind === 'conversation' && !docState`, 'the conversation did not open');
  await evaluate(`finish(1, 'one\\n')`);
  await until(`streams.length === 3`, 'run all stopped when the notebook left the screen');
  await until(`/cell 2 of 2/.test(document.querySelector('.ag-row.ag-nb .ag-dir')?.textContent || '')`, 'the row did not move to the second cell');
  await evaluate(`finish(2, 'two\\n')`);
  await until(`!first.runner.running && /\\x60\\x60\\x60output\\ntwo\\n\\x60\\x60\\x60/.test(first.editor.getContent())`, 'the second cell did not write its output');
  await until(`/ran all 2 cells/.test([...document.querySelectorAll('#toasts .toast')].map(t => t.textContent).join('|'))`, 'the end of run all was not reported');

  // Close the row: the parked editor is released, the file stays.
  await evaluate(`document.querySelector('.ag-row.ag-nb [data-nb-close]').click()`);
  await until(`!document.querySelector('.ag-row.ag-nb') && first.closed`, 'closing the row did not release the notebook');
  assert.ok(fs.existsSync(notebook));
  assert.deepEqual(exceptions, []);
});
