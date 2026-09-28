'use strict';
// Local requests sign in like every client (design/69): the test server's
// install token, sent by consoleFetch on 127.0.0.1 and set as the browser's cookie.
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const TEST_TOKEN = 'test-install-token';
// Files kept open in the side list (open-files.js, design/68, design/77).
// A notebook run here keeps running when the person goes elsewhere, its
// results land in the document (and on disk), its row says what it is
// doing, and coming back shows the same editor. Any file can be kept: by
// its pin, Alt+P, or by being edited; reading one adds nothing. A kept code
// file comes back with the same editor. The list is the server's: a second
// device sees it and closes from it; a guest keeps theirs in the browser;
// the old per-browser list is carried over. rat is mocked: this is about
// the page, not the kernel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromiumBinary, chromiumAvailable } = require('./helpers/chromium.js');

test('files kept open: notebooks run on, any file can be kept, one list for every device', { timeout: 150000 }, async t => {
  if (!chromiumAvailable()) return t.skip('chromium is not installed');
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
  const notebook = path.join(work, 'analysis.md'), other = path.join(work, 'notes.md'), code = path.join(work, 'tool.py');
  fs.writeFileSync(notebook, '# Analysis\n\n```python\nfirst = 1\n```\n\nBetween.\n\n```python\nsecond = 2\n```\n');
  fs.writeFileSync(other, '# Notes\n\nPlain prose.\n');
  fs.writeFileSync(code, 'def tool():\n    return 1\n');
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
  for (let i = 0; i < 200; i++) {
    try { const rows = await (await fetch(base + '/api/sessions')).json(); if (rows.some(s => s.key === key)) { indexed = true; break; } } catch {}
    if (server.exitCode != null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(indexed, serverLog);
  assert.equal((await fetch(base + '/open-files.js')).status, 200);

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
  await until(`typeof OpenFiles !== 'undefined' && viewKind === 'conversation' && document.querySelector('#conversationTranscript')?.textContent.includes('Hi.')`, 'the app did not load');
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
  // The editor exists before a shared document's text arrives: wait for its cells, with code.
  await until(`!!(docState && docState.editor && docState.path === ${JSON.stringify(notebook)} && docState.editor.listCells().length === 2 && docState.editor.listCells()[0].code.trim())`, 'the notebook did not open');
  assert.equal(await evaluate(`document.querySelectorAll('.ag-row.ag-of').length`), 0, 'opening alone lists nothing');

  // Run the first cell; the row appears, working.
  // Its answer and every toast are kept: a toast is gone before a slow failure is reported.
  await evaluate(`window.first = docState; window.toldToasts = []; { const shown = window.toast; window.toast = (...a) => { toldToasts.push(String(a[0])); return shown(...a); }; }
    runDocCell(docState.editor.listCells()[0]).then(r => { window.firstRun = r; }, e => { window.firstRun = { error: String(e) }; }); 0`);
  for (let i = 0; i < 160 && !(await evaluate(`streams.length === 1`)); i++) await new Promise(r => setTimeout(r, 50));
  if (!(await evaluate(`streams.length === 1`))) assert.fail('the run was not requested; the page said: ' + await evaluate(`JSON.stringify({ toasts: toldToasts, firstRun: window.firstRun === undefined ? 'still waiting' : window.firstRun, running: docState && docState.running, runner: !!(docState && docState.runner), cells: docState && docState.editor && docState.editor.listCells().length })`));
  await evaluate(`emit(0, { type: 'output', text: 'working on it\\n' })`);
  await until(`!!document.querySelector('.ag-row.ag-of.working.current')`, 'the notebook row is not listed as running');
  assert.match(await evaluate(`document.querySelector('.ag-row.ag-of .ag-dir').textContent`), /running a cell/);

  // Go elsewhere: the notebook is parked, not closed; the run goes on.
  await evaluate(`openLiveFile(${JSON.stringify(other)}, { project: 'work' })`);
  await until(`!!(docState && docState.path === ${JSON.stringify(other)})`, 'the other file did not open');
  assert.deepEqual(await evaluate(`({ closed: !!first.closed, ws: first.ws, attached: first.body.isConnected, running: !!first.runner.running })`), { closed: false, ws: null, attached: false, running: true });
  await until(`!!document.querySelector('.ag-row.ag-of.working:not(.current)')`, 'the parked notebook row does not say it runs');
  fs.writeFileSync(path.join(os.tmpdir(), 'open-files-running.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, sid)).result.data, 'base64'));

  // The run ends while parked: its output is written into the notebook and saved to disk.
  await evaluate(`finish(0, 'working on it\\ndone\\n\\n\u2713 1.2s | 1 var')`);
  await until(`!first.runner.running && first.editor.getContent().includes('\\x60\\x60\\x60output\\nworking on it\\ndone\\n\\x60\\x60\\x60')`, 'the parked notebook did not get its output');
  for (let i = 0; i < 100 && !fs.readFileSync(notebook, 'utf8').includes('working on it\ndone'); i++) await new Promise(r => setTimeout(r, 100));
  assert.match(fs.readFileSync(notebook, 'utf8'), /```output\nworking on it\ndone\n```/, 'the output did not reach the disk');
  assert.equal(await evaluate(`docState.path`), other, 'the page stayed where the person went');
  await until(`!!document.querySelector('.ag-row.ag-of.unread')`, 'a run that ended off screen is not marked');
  assert.match(await evaluate(`[...document.querySelectorAll('#toasts .toast')].map(t => t.textContent).join('|')`), /analysis\.md · cell finished/);

  // Back through the row: the same editor, the mark read.
  await evaluate(`document.querySelector('.ag-row.ag-of .ag-main').click()`);
  await until(`docState === first && first.body.isConnected`, 'the row did not bring the same editor back');
  assert.equal(await evaluate(`fileWs.editor === first.editor`), true);
  await until(`!!document.querySelector('.ag-row.ag-of.current:not(.unread)')`, 'the row is not current and read');

  // Run all, then leave after the first cell: the queue goes on in the background.
  await evaluate(`runAllDocCells(); 0`);
  await until(`streams.length === 2`, 'run all did not start');
  await until(`/running all · cell 1 of 2/.test(document.querySelector('.ag-row.ag-of .ag-dir')?.textContent || '')`, 'the row does not follow run all');
  await evaluate(`open(${JSON.stringify(key)})`);
  await until(`viewKind === 'conversation' && !docState`, 'the conversation did not open');
  await evaluate(`finish(1, 'one\\n')`);
  await until(`streams.length === 3`, 'run all stopped when the notebook left the screen');
  await until(`/cell 2 of 2/.test(document.querySelector('.ag-row.ag-of .ag-dir')?.textContent || '')`, 'the row did not move to the second cell');
  await evaluate(`finish(2, 'two\\n')`);
  await until(`!first.runner.running && /\\x60\\x60\\x60output\\ntwo\\n\\x60\\x60\\x60/.test(first.editor.getContent())`, 'the second cell did not write its output');
  await until(`/ran all 2 cells/.test([...document.querySelectorAll('#toasts .toast')].map(t => t.textContent).join('|'))`, 'the end of run all was not reported');

  // The list is the server's: the notebook is on it, from its first run.
  const listed = async () => (await (await fetch(base + '/api/open-files')).json()).files.map(f => f.path);
  const serverHas = async (p, want = true, what = '') => {
    for (let i = 0; i < 100; i++) { if ((await listed()).includes(p) === want) return; await new Promise(r => setTimeout(r, 50)); }
    assert.fail((what || p) + (want ? ' is not' : ' is still') + ' on the server\'s list: ' + JSON.stringify(await listed()));
  };
  await serverHas(notebook);
  assert.match(await evaluate(`toldToasts.join('|')`), /analysis\.md stays under Open files in the side list: you ran a cell in it/, 'the first file kept without a pin says why, once');

  // Close the row: the parked editor is released, the file stays; Undo puts it back.
  await evaluate(`document.querySelector('.ag-row.ag-of [data-of-close]').click()`);
  await until(`!document.querySelector('.ag-row.ag-of') && first.closed`, 'closing the row did not release the notebook');
  assert.ok(fs.existsSync(notebook));
  await serverHas(notebook, false);
  await evaluate(`[...document.querySelectorAll('#toasts .toast')].find(t => /^Closed analysis\.md · Undo/.test(t.textContent)).click()`);
  await until(`!!document.querySelector('.ag-row.ag-of')`, 'undo did not bring the row back');
  await serverHas(notebook);
  await evaluate(`OpenFiles.close(${JSON.stringify(notebook)}, { undo: false })`);
  await serverHas(notebook, false);

  // Reading a file lists nothing; a change that is not the person's neither;
  // the person's own edit keeps it.
  await evaluate(`openLiveFile(${JSON.stringify(other)}, { project: 'work' })`);
  await until(`!!(docState && docState.path === ${JSON.stringify(other)} && docState.editor)`, 'the notes did not open');
  await evaluate(`docState.editor.view.dispatch({ changes: { from: docState.editor.getContent().length, insert: '\\nFrom elsewhere.' } }); 0`);
  await new Promise(r => setTimeout(r, 400));
  await evaluate(`renderAgentsPop(false)`); // the list as it is now, not after the next debounce
  assert.equal(await evaluate(`document.querySelectorAll('.ag-row.ag-of').length`), 0, 'a change without a person behind it keeps nothing');
  assert.equal(await evaluate(`$('fileKeep').getAttribute('aria-pressed')`), 'false');
  await evaluate(`docState.editor.view.dispatch({ changes: { from: docState.editor.getContent().length, insert: '\\nTyped.' }, userEvent: 'input.type' }); 0`);
  await until(`[...document.querySelectorAll('.ag-row.ag-of .of-name')].some(n => n.textContent === 'notes.md')`, 'an edited file was not kept');
  await until(`$('fileKeep').getAttribute('aria-pressed') === 'true'`, 'the pin does not show the file is kept');
  await serverHas(other);

  // A code file: kept by its pin; leaving parks the same editor, the row
  // brings it back with the unsaved text and its undo history.
  await evaluate(`openLiveFile(${JSON.stringify(code)}, { project: 'work' })`);
  await until(`!!(fileWs && fileWs.path === ${JSON.stringify(code)} && fileWs.editor && fileWs.kind === 'code')`, 'the code file did not open');
  await evaluate(`$('fileKeep').click()`);
  await until(`[...document.querySelectorAll('.ag-row.ag-of .of-name')].some(n => n.textContent === 'tool.py')`, 'the pin did not keep the code file');
  assert.equal(await evaluate(`document.querySelector('.ag-row.ag-of.current .of-glyph').textContent`), '‹›');
  await evaluate(`window.codeEd = fileWs.editor; window.codeWs = fileWs;
    codeEd.view.dispatch({ changes: { from: codeEd.getContent().length, insert: '# kept\\n' }, userEvent: 'input.type' }); 0`);
  await evaluate(`open(${JSON.stringify(key)})`);
  await until(`viewKind === 'conversation' && !fileWs`, 'the conversation did not open');
  assert.deepEqual(await evaluate(`({ alive: !!codeWs.editor, shown: codeEd.view.dom.isConnected })`), { alive: true, shown: false }, 'leaving a kept code file parks its editor');
  await evaluate(`[...document.querySelectorAll('.ag-row.ag-of')].find(r => r.querySelector('.of-name').textContent === 'tool.py').querySelector('.ag-main').click()`);
  await until(`fileWs === codeWs && fileWs.editor === codeEd && codeEd.view.dom.isConnected`, 'the row did not bring the same code editor back');
  assert.match(await evaluate(`codeEd.getContent()`), /# kept/);
  await until(`!!document.querySelector('.ag-row.ag-of.current')`, 'the code row is not current');
  const shot = async name => fs.writeFileSync(path.join(os.tmpdir(), name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, sid)).result.data, 'base64'));
  await evaluate(`renderAgentsPop(false)`);
  await shot('open-files-desktop.png');
  assert.ok(await evaluate(`$('fileKeep').getBoundingClientRect().left - $('ffTitle').getBoundingClientRect().right`) < 8, 'the pin sits by the name');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sid);
  await new Promise(r => setTimeout(r, 300));
  await shot('open-files-phone.png');
  assert.deepEqual(await evaluate(`(() => { const pin = $('fileKeep').getBoundingClientRect(), name = $('ffTitle').getBoundingClientRect(), head = $('fileKeep').closest('header').getBoundingClientRect();
    return { big: pin.width >= 36 && pin.height >= 36, inside: pin.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth, byName: pin.left - name.right < 8, oneLine: head.height < 60 }; })()`),
    { big: true, inside: true, byName: true, oneLine: true }, 'on a phone the pin is a touch target by the name, and the header stays one line');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);

  // Alt+P lets the file on screen go, and keeps it again.
  const altP = () => evaluate(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', altKey: true, bubbles: true })); 0`);
  await altP();
  await until(`$('fileKeep').getAttribute('aria-pressed') === 'false' && ![...document.querySelectorAll('.ag-row.ag-of .of-name')].some(n => n.textContent === 'tool.py')`, 'Alt+P did not let the file go');
  await altP();
  await until(`$('fileKeep').getAttribute('aria-pressed') === 'true'`, 'Alt+P did not keep the file again');
  await serverHas(code);

  // A second device: the same list, live. Closing there lets this window
  // release the parked editor.
  const target2 = await send('Target.createTarget', { url: 'about:blank' });
  const sid2 = (await send('Target.attachToTarget', { targetId: target2.result.targetId, flatten: true })).result.sessionId;
  const evaluate2 = async expression => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid2);
    assert.ok(!out.result?.exceptionDetails, JSON.stringify(out.result));
    return out.result?.result?.value;
  };
  const until2 = async (expr, what) => {
    for (let i = 0; i < 400; i++) { if (await evaluate2(`(()=>{try{return !!(${expr})}catch{return false}})()`)) return; await new Promise(r => setTimeout(r, 50)); }
    assert.fail(what);
  };
  await send('Runtime.enable', {}, sid2);
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false }, sid2);
  await send('Page.navigate', { url: base + '/#' + encodeURIComponent(key) }, sid2);
  await until2(`typeof OpenFiles !== 'undefined' && viewKind === 'conversation' && [...document.querySelectorAll('.ag-row.ag-of .of-name')].map(n => n.textContent).sort().join() === 'notes.md,tool.py'`, 'the second device does not show the same open files');
  await evaluate(`open(${JSON.stringify(key)})`);
  await until(`viewKind === 'conversation' && !fileWs && !codeEd.view.dom.isConnected`, 'the conversation did not open');
  await evaluate2(`[...document.querySelectorAll('.ag-row.ag-of')].find(r => r.querySelector('.of-name').textContent === 'tool.py').querySelector('[data-of-close]').click()`);
  await until(`![...document.querySelectorAll('.ag-row.ag-of .of-name')].some(n => n.textContent === 'tool.py') && !codeWs.editor`, 'closing on another device did not reach this one');

  // The old per-browser notebook list joins the shared one, once.
  await evaluate(`localStorage.setItem('chattering.notebookTabs', JSON.stringify([{ path: ${JSON.stringify(notebook)}, project: 'work', listedAt: 1000, last: { ok: true, at: 1000, ms: 900 }, unseen: false }])); OpenFiles.refresh()`);
  await serverHas(notebook, true, 'the old local list');
  assert.equal(await evaluate(`localStorage.getItem('chattering.notebookTabs')`), null);
  await until(`[...document.querySelectorAll('.ag-row.ag-of .of-name')].map(n => n.textContent).join() === 'notes.md,analysis.md'`, 'the old list is not carried over in its own (old) place, last');

  // A guest cannot write the household's list: theirs stays in the browser.
  await evaluate2(`(() => { const real = window.fetch; window.fetch = (u, o) => String(u).includes('/api/open-files') ? Promise.resolve(new Response(JSON.stringify({ error: 'not for guests' }), { status: 403 })) : real(u, o); })(); OpenFiles.refresh()`);
  await until2(`OpenFiles.own === true && !document.querySelector('.ag-row.ag-of')`, 'a refused person did not get a list of their own');
  await evaluate2(`OpenFiles.keep(${JSON.stringify(code)}, 'work')`);
  await until2(`[...document.querySelectorAll('.ag-row.ag-of .of-name')].some(n => n.textContent === 'tool.py')`, 'a guest could not keep a file in their own list');
  assert.equal((await listed()).includes(code), false, 'a guest\'s file reached the household list');

  assert.deepEqual(exceptions, []);
});
