'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromiumBinary } = require('./helpers/chromium.js');
const pause = ms => new Promise(r => setTimeout(r, ms));

test('real host and panel recover saved failures without duplicate launches or stale writes', { timeout: 60000 }, async t => {
  const root = path.join(__dirname, '..'), home = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-api-'));
  let server, browser, ws;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM'); const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(timeout); }
  };
  t.after(async () => { ws?.close(); await stop(browser); await stop(server); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
  const agent = path.join(home, '.pi/agent'), dir = path.join(agent, 'sessions/fixture'), cache = path.join(home, 'cache');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(cache);
  const source = path.join(dir, 'chat.jsonl');
  fs.writeFileSync(source, JSON.stringify({ type: 'session', version: 3, id: 'fixture', cwd: home }) + '\n');
  const preload = path.join(home, 'fake-model.cjs');
  fs.writeFileSync(preload, `
if (process.argv[1] === ${JSON.stringify(path.join(root, 'server.js'))}) {
  const fs = require('node:fs'), crypto = require('node:crypto');
  const sdk = require(${JSON.stringify(path.join(root, 'pisdk.js'))});
  sdk.piHeadlessRun = (target, options) => {
    let doneResolve;
    const done = new Promise(r => { doneResolve = r; });
    const emit = message => {
      const entries = fs.readFileSync(target.sessionPath, 'utf8').trim().split('\\n').map(JSON.parse);
      const row = { type: 'message', id: crypto.randomUUID().slice(0,8), parentId: entries.at(-1).type === 'session' ? null : entries.at(-1).id, timestamp: new Date().toISOString(), message };
      fs.appendFileSync(target.sessionPath, JSON.stringify(row)+'\\n');
      options.onEvent({ type: 'message_start', message });
      options.onEvent({ type: 'message_end', message });
    };
    emit({ role: 'user', content: [{ type: 'text', text: options.message }] });
    const timer = setTimeout(() => {
      const fail = options.message.startsWith('Fail');
      emit({ role: 'assistant', provider: 'anthropic', model: 'fixture', content: [{ type: 'text', text: fail ? '' : 'Recovered successfully' }], stopReason: fail ? 'error' : 'stop', ...(fail ? { errorMessage: 'Connection error. ECONNRESET' } : {}) });
      doneResolve();
    }, options.message === 'Hold' ? 100000 : 30);
    return { done, abort: async () => { clearTimeout(timer); doneResolve(); } };
  };
}
`);
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  let log = '';
  const start = () => {
    require('./helpers/first-run.js').answerFirstRun(home); // no first-run modal over the page
    server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env,
      HOME: home, PORT: String(port), CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1',
      CHATTERING_NO_FILE_HISTORY: '1', CHATTERING_NO_CHECKPOINTS: '1', CHATTERING_DISABLE_NETWORK_RECOVERY: '1',
      CHATTERING_CACHE_DIR: cache, CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
      PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, NODE_OPTIONS: '--require=' + preload,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  };
  const base = 'http://127.0.0.1:' + port, key = 'pi:fixture/chat.jsonl';
  const get = async route => { const r = await fetch(base + route, { signal: AbortSignal.timeout(3000) }); assert.ok(r.ok, route); return r.json(); };
  const post = async (route, body) => {
    const r = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { status: r.status, body: await r.json() };
  };
  const waitFor = async predicate => {
    for (let i = 0; i < 150; i++) { try { if (await predicate()) return; } catch {} await pause(50); }
    assert.fail('Timed out\n' + log);
  };
  start(); await waitFor(async () => (await get('/api/sessions')).some(s => s.key === key));
  let sent = await post('/api/node/send', { id: key, prompt: 'Fail once' }); assert.equal(sent.status, 202, JSON.stringify(sent));
  await waitFor(async () => (await get('/api/agents/recovery')).interrupted.length === 1);
  let record = (await get('/api/agents/recovery')).interrupted[0];
  assert.equal(record.kind, 'network'); assert.equal(record.canResume, true); assert.equal(record.waiting, false);
  assert.equal((await get('/api/agents/active')).recovery.interrupted[0].id, record.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cache, 'agent-interruptions.json')))[0].auto, true, 'saved prompt must qualify for opt-in recovery');
  await stop(server); start();
  await waitFor(async () => (await get('/api/sessions')).some(s => s.key === key));
  assert.equal((await get('/api/agents/recovery')).interrupted[0].id, record.id, 'restart lost interruption');

  if (!spawnSync(chromiumBinary(), ['--version']).error) {
    browser = spawn(chromiumBinary(), ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(Error(text)), 10000);
      browser.stderr.on('data', b => { text += b; const m = text.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } }); browser.on('error', reject);
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
      assert.ok(!out.result?.exceptionDetails, JSON.stringify(out.result)); return out.result?.result?.value;
    };
    await send('Runtime.enable', {}, sid);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }, sid);
    await send('Page.navigate', { url: base }, sid);
    await waitFor(async () => evaluate('!!document.querySelector("#activeBtn") && !document.querySelector("#activeBtn").hidden'));
    await evaluate('document.querySelector("#activeBtn").click()');
    await waitFor(async () => evaluate('!!document.querySelector("[data-recovery-action=resume]")'));
    // design/59: the interrupted run is a stopped row saying why.
    assert.equal(await evaluate('document.querySelector("#agentsPop .ag-row.stopped .ag-doing")?.textContent'), 'connection lost');
    assert.equal(await evaluate('document.querySelector("#agentAutoResume").checked'), false);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'panel overflows phone');
    assert.equal(await evaluate('(r => r.scrollWidth <= r.clientWidth)(document.querySelector("#agentsPop .ag-row.stopped"))'), true, 'row overflows phone');
    await evaluate('document.querySelector("[data-recovery-action=resume]").click()');
    await waitFor(async () => (await get('/api/agents/recovery')).interrupted.length === 0);
    assert.deepEqual(exceptions, []);
    ws.close(); ws = null; await stop(browser);
  } else {
    t.diagnostic('Chromium unavailable; testing resume over HTTP only');
    assert.equal((await post('/api/agents/recovery', { id: record.id, action: 'resume' })).status, 200);
  }
  await waitFor(() => fs.readFileSync(source, 'utf8').includes('Recovered successfully'));
  assert.equal(fs.readFileSync(source, 'utf8').split('Sorry, you were interrupted, continue').length - 1, 1, 'resume must send the default message exactly once');
  assert.equal((await post('/api/agents/recovery', { id: record.id, action: 'resume' })).status, 409);
  await pause(100);
  await post('/api/node/send', { id: key, prompt: 'Fail again' });
  await waitFor(async () => (await get('/api/agents/recovery')).interrupted.length === 1);
  record = (await get('/api/agents/recovery')).interrupted[0];
  fs.appendFileSync(source, '\n'); const before = fs.readFileSync(source, 'utf8');
  const stale = await post('/api/agents/recovery', { id: record.id, action: 'resume' });
  assert.equal(stale.status, 409); assert.match(stale.body.error, /changed/);
  assert.equal(fs.readFileSync(source, 'utf8'), before);
  assert.equal((await post('/api/agents/recovery', { id: record.id, action: 'dismiss' })).status, 200);
  assert.equal((await get('/api/agents/recovery')).interrupted.length, 0);
  sent = await post('/api/node/send', { id: key, prompt: 'Hold' }); assert.equal(sent.status, 202);
  await post('/api/run/abort', { jobId: sent.body.job.id });
  await waitFor(async () => (await get('/api/agents/recovery')).interrupted.length === 1);
  record = (await get('/api/agents/recovery')).interrupted[0];
  assert.equal(record.kind, 'stopped');
  assert.equal(JSON.parse(fs.readFileSync(path.join(cache, 'agent-interruptions.json'))).find(r => r.id === record.id).auto, false);
});
