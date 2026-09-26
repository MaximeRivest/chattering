'use strict';
// design/66 in a real browser against a real server: one head decides the
// transcript, answers sit side by side, moving is local and patched, the head
// is shared by a person's screens, and a send continues from it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromiumBinary } = require('./helpers/chromium.js');

const browserBin = chromiumBinary();

test('one head: side-by-side answers, instant moves, versions, shared head, phone swipe, sends from the head', { timeout: 90000 }, async t => {
  if (spawnSync(browserBin, ['--version']).error) return t.skip('chromium is not installed');
  const root = path.join(__dirname, '..'), home = fs.mkdtempSync(path.join(os.tmpdir(), 'one-tree-'));
  const agent = path.join(home, '.pi/agent'), dir = path.join(agent, 'sessions/fixture');
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(home, 'work'));
  let server, browser, ws;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer);
  };
  t.after(async () => { ws?.close(); await stop(browser); await stop(server); fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  let clock = 0;
  const ts = () => new Date(Date.UTC(2026, 8, 1, 12, 0, clock++)).toISOString();
  const msg = (id, parentId, role, text, extra = {}) => ({ type: 'message', id, parentId, timestamp: ts(), message: { role, content: [{ type: 'text', text }], ...extra } });
  const long = word => (word + ' ').repeat(160);
  fs.writeFileSync(path.join(dir, 'chat.jsonl'), [
    { type: 'session', version: 3, id: 'fixture', cwd: path.join(home, 'work') },
    msg('q0', null, 'user', 'Opening question'), msg('a0', 'q0', 'assistant', 'Opening answer', { model: 'm-one', provider: 'p' }),
    msg('q1', 'a0', 'user', 'Which design is better?'),
    msg('c1', 'q1', 'assistant', 'CLAUDE ANSWER ' + long('alpha'), { model: 'claude', provider: 'x' }),
    msg('g1', 'q1', 'assistant', 'GPT ANSWER ' + long('beta'), { model: 'gpt', provider: 'y' }),
    msg('fc', 'c1', 'user', 'FOLLOW-UP ON CLAUDE'), msg('rc', 'fc', 'assistant', 'REPLY UNDER CLAUDE', { model: 'claude', provider: 'x' }),
    msg('fg', 'g1', 'user', 'FOLLOW-UP ON GPT'), msg('rg', 'fg', 'assistant', 'REPLY UNDER GPT', { model: 'gpt', provider: 'y' }),
    // An edited wording of the last follow-up, asked at the same point.
    msg('fg2', 'g1', 'user', 'REWORDED FOLLOW-UP ON GPT'), msg('rg2', 'fg2', 'assistant', 'REPLY TO REWORDED', { model: 'gpt', provider: 'y' }),
  ].map(JSON.stringify).join('\n') + '\n');
  const key = 'pi:fixture/chat.jsonl';

  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const base = 'http://127.0.0.1:' + port, token = 'one-tree-token', auth = { Authorization: 'Bearer ' + token };
  let log = '';
  require('./helpers/first-run.js').answerFirstRun(home); // no first-run modal over the page
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_TOKEN: token, CHATTERING_NO_SYNC: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    try { ready = (await (await fetch(base + '/api/sessions', { headers: auth })).json()).some(s => s.key === key); } catch {}
    if (!ready) await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, log);

  browser = spawn(browserBin, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(Error(out)), 10000);
    browser.stderr.on('data', b => { out += b; const m = out.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
  });
  ws = new WebSocket(endpoint); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(), exceptions = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}, sessionId) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const sid = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
  const command = (method, params) => send(method, params, sid);
  const evaluate = async expression => {
    const out = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!out.result?.exceptionDetails, JSON.stringify(out.result?.exceptionDetails));
    return out.result?.result?.value;
  };
  const until = async (expression, label) => {
    for (let i = 0; i < 300; i++) { if (await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`)) return; await new Promise(r => setTimeout(r, 25)); }
    assert.fail('Timed out: ' + (label || expression) + '\n' + exceptions.join('\n'));
  };
  const size = (width, height, mobile = false) => command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await command('Runtime.enable'); await command('Page.enable');
  await size(1500, 1000);
  await command('Page.navigate', { url: base + '/?token=' + token + '#' + encodeURIComponent(key) });
  await until(`typeof current !== 'undefined' && current && current.key === ${JSON.stringify(key)} && document.querySelector('.rd-answers')`, 'the conversation with its answer group');
  const text = () => evaluate(`document.getElementById('conversationTranscript').innerText`);

  // The newest path by default: the GPT answer, its reworded follow-up.
  let body = await text();
  assert.match(body, /REPLY TO REWORDED/);
  assert.doesNotMatch(body, /REPLY UNDER CLAUDE/);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.rd-card')].map(c => c.getAttribute('aria-current'))`), ['false', 'true']);
  // Both answers are complete and side by side across the view, wider than the reading column.
  const geometry = await evaluate(`(() => { const cards = [...document.querySelectorAll('.rd-card')].map(c => c.getBoundingClientRect());
    return { top: Math.abs(cards[0].top - cards[1].top), left: cards[0].left < cards[1].left, span: cards[1].right - cards[0].left, column: document.getElementById('conversationTranscript').clientWidth }; })()`);
  assert.ok(geometry.top < 2 && geometry.left, JSON.stringify(geometry));
  assert.ok(geometry.span > geometry.column, 'side by side uses more than the reading column: ' + JSON.stringify(geometry));
  assert.match(await evaluate(`document.querySelector('.rd-card[data-col="x/claude"]').innerText`), /CLAUDE ANSWER (alpha ){150}/);

  // Clicking the other card is the choice: its follow-up replaces the other,
  // the blocks above keep their DOM, and nothing reloads.
  await evaluate(`window.__first = document.querySelector('#conversationTranscript > .rd-block'); window.__fetches = 0;
    const f = window.fetch; window.fetch = (...a) => { if (String(a[0]).includes('/api/session')) window.__fetches++; return f(...a); }; 1`);
  const ms = await evaluate(`(async () => { const t0 = performance.now(); document.querySelector('.rd-card[data-col="x/claude"] .rd-pick').click(); await new Promise(r => requestAnimationFrame(r)); return performance.now() - t0; })()`);
  body = await text();
  assert.match(body, /FOLLOW-UP ON CLAUDE[\s\S]*REPLY UNDER CLAUDE/);
  assert.doesNotMatch(body, /REPLY TO REWORDED|REPLY UNDER GPT/);
  assert.equal(await evaluate(`window.__first === document.querySelector('#conversationTranscript > .rd-block')`), true, 'blocks above the change keep their DOM');
  assert.equal(await evaluate('window.__fetches'), 0, 'moving the head fetches nothing');
  assert.ok(ms < 400, 'moving took ' + ms + ' ms');
  // The head is saved for this person on the server.
  for (let i = 0; i < 40; i++) {
    const r = (await (await fetch(base + '/api/session?id=' + encodeURIComponent(key), { headers: auth })).json()).reading;
    if (r && r.head === 'rc') break;
    assert.ok(i < 39, 'server head: ' + JSON.stringify(r));
    await new Promise(r => setTimeout(r, 50));
  }

  // Back to GPT: the route read there before (the reworded follow-up) returns.
  await evaluate(`document.querySelector('.rd-card[data-col="y/gpt"] .rd-pick').click(); 1`);
  await until(`document.getElementById('conversationTranscript').innerText.includes('REPLY TO REWORDED')`, 'remembered route');
  // Wordings of a question: the stepper moves between them.
  assert.match(await evaluate(`document.querySelector('.rd-versions').innerText`), /2\/2/);
  await evaluate(`document.querySelector('.rd-versions [data-rd-go]').click(); 1`);
  await until(`document.getElementById('conversationTranscript').innerText.includes('REPLY UNDER GPT')`, 'first wording');
  assert.match(await evaluate(`document.querySelector('.rd-versions').innerText`), /1\/2/);

  // Another screen of the same person moves the head: this one follows.
  await fetch(base + '/api/conversation/reading', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: key, head: 'rc' }) });
  await until(`document.getElementById('conversationTranscript').innerText.includes('REPLY UNDER CLAUDE')`, 'shared head from another screen');

  // A send continues from the head (the exact node), never from the file's end.
  const captureSend = prompt => evaluate(`(async () => { let seen = null; const real = window.fetch;
    window.fetch = async (url, opts) => { if (String(url).includes('/api/node/send')) { seen = JSON.parse(opts.body); return new Response(JSON.stringify({ error: 'test stops here' }), { status: 400 }); } return real(url, opts); };
    try { await headlessSendFromComposer(document.createElement('button'), ${JSON.stringify('PROMPT')}.replace('PROMPT', ${JSON.stringify('x')})); } finally { window.fetch = real; } return seen; })()`);
  const payload = await captureSend('Next');
  assert.equal(payload.node, 'rc');
  assert.equal('expectedLeaf' in payload, false);

  // Continue from an earlier point: the next message starts a new path there.
  await evaluate(`moveReading(${JSON.stringify(key)}, 'a0', { exact: true })`);
  await until(`document.getElementById('readerDestination')`, 'the new-path note');
  body = await text();
  assert.doesNotMatch(body, /Which design is better/);
  const branchPayload = await captureSend('Another way');
  assert.equal(branchPayload.node, 'a0');
  await evaluate(`document.querySelector('[data-reader-end]').click(); 1`);
  await until(`!document.getElementById('readerDestination') && document.querySelector('.rd-answers')`, 'back to the end');

  // Phone: one answer at a time; a swipe settles on the other answer and chooses it.
  await size(390, 844, true);
  await evaluate(`rerenderReading(null)`);
  await until(`document.querySelector('.rd-answers')?.dataset.layout === 'one'`, 'phone layout');
  const before = await evaluate(`document.querySelector('.rd-card[aria-current="true"]').dataset.col`);
  await evaluate(`(() => { const strip = document.querySelector('.rd-cards'); strip.dispatchEvent(new PointerEvent('pointerdown'));
    const other = [...strip.querySelectorAll('.rd-card')].find(c => c.getAttribute('aria-current') !== 'true');
    strip.scrollLeft = other.offsetLeft - strip.offsetLeft; return 1; })()`);
  await until(`document.querySelector('.rd-card[aria-current="true"]')?.dataset.col !== ${JSON.stringify(before)}`, 'swipe chooses');

  // The tree lights the head's path and marks the head as "here".
  await size(1500, 1000);
  const head = await evaluate('headOf(current)');
  await evaluate(`showTree(${JSON.stringify(key)})`);
  await until(`document.querySelector('.tnode.here')`, 'tree here marker');
  const here = await evaluate(`document.querySelector('.tnode.here').dataset.tn`);
  assert.ok([head].includes(here), `here ${here} / head ${head}`);
  assert.deepEqual(exceptions.filter(e => !/ResizeObserver/.test(e)), []);
});
