'use strict';
// The live strip's actions against a program that draws like Claude Code,
// Pi and Codex (test/fixtures/fake-terminal-agent.js, no model calls), each
// read with its own profile, through the hub as Chattering runs it: typing
// into the program's own editor, its "/" list, a permission question, a
// panel opened and closed, a reply stopped, a message sent from a touch
// keyboard, two devices, a message received twice.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { terminalDeps } = require('../harness/terminal/deps');
const { TerminalHost } = require('../harness/terminal/host');
const { createHub } = require('../harness/terminal/hub');
const { profileFor } = require('../harness/terminal/profiles');

const FAKE = path.join(__dirname, 'fixtures', 'fake-terminal-agent.js');
const skip = terminalDeps().error || (process.platform === 'win32' ? 'a Unix pseudoterminal' : false);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function device(hub, name) {
  const ws = new EventEmitter(); ws.readyState = 1; ws.close = () => {};
  const state = {}; const answers = new Map(); let seq = 0;
  ws.send = raw => {
    const m = JSON.parse(raw);
    if (m.t === 'patch') Object.assign(state, m.set);
    else if (m.seq != null) { const w = answers.get(m.seq); if (w) { answers.delete(m.seq); w(m); } }
  };
  hub.attach(ws, { name });
  ws.emit('message', JSON.stringify({ t: 'hello', clientId: name + '-0000-id', name }));
  const send = (m, n = ++seq) => { ws.emit('message', JSON.stringify({ ...m, seq: n })); return n; };
  const ask = m => new Promise(resolve => { const n = ++seq; answers.set(n, resolve); ws.emit('message', JSON.stringify({ ...m, seq: n })); });
  const until = async (test, what, ms = 6000) => { const t0 = Date.now(); while (!test(state)) { if (Date.now() - t0 > ms) throw new Error('timed out: ' + what + '\n' + JSON.stringify(state).slice(0, 1500)); await sleep(20); } };
  return { state, send, ask, until, ws, seq: () => seq };
}

function run(style, { trust = false } = {}) { // trust: true (asked at once) or 'late' (after its box)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-agent-'));
  const work = path.join(home, 'work'); fs.mkdirSync(work);
  const id = style === 'pi' ? '01a0f000-0000-7000-8000-0000000000aa' : '11111111-2222-4333-8444-5555555555aa';
  const args = style === 'codex' ? [] : ['--session-id', id];
  const host = new TerminalHost({ command: process.execPath, args: [FAKE, ...args], cwd: work, cols: 90, rows: 24, scrollback: 200,
    env: { ...process.env, HOME: home, FAKE_AGENT_STYLE: style, FAKE_AGENT_TRUST: trust === 'late' ? 'late' : trust ? '1' : '', PI_CODING_AGENT_DIR: path.join(home, 'pi'), CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude') } });
  const hub = createHub({ host, profile: profileFor(style), liveOnly: true });
  return { host, hub, home, work, close: () => { hub.close(); host.kill(); fs.rmSync(home, { recursive: true, force: true }); } };
}
const files = dir => { const out = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push(p); } }; walk(dir); return out; };

for (const style of ['claude', 'pi', 'codex']) {
  test(`${style}: its own editor, its "/" list, a question, a panel, stop, a touch keyboard`, { skip, timeout: 60000 }, async t => {
    const r = run(style);
    t.after(r.close);
    const a = device(r.hub, 'laptop');
    await a.until(s => s.composer && s.mode === 'compose', 'the box');

    // Keys go to the program's editor; the program decides (Home, Backspace).
    a.send({ t: 'text', text: 'hello' });
    await a.until(s => s.composer.text === 'hello', 'typed');
    a.send({ t: 'key', key: 'Home' }); a.send({ t: 'text', text: 'X' });
    await a.until(s => s.composer.text === 'Xhello', 'Home then X');
    a.send({ t: 'key', key: 'End' }); a.send({ t: 'key', key: 'Backspace' });
    await a.until(s => s.composer.text === 'Xhell', 'End then Backspace');

    // A touch keyboard's text, brought into the editor (closed loop).
    let ans = await a.ask({ t: 'draft', text: 'from the phone' });
    assert.equal(ans.t, 'done', JSON.stringify(ans)); assert.equal(ans.text, 'from the phone');

    // Its "/" list, as a menu; a pick completes it in the box.
    ans = await a.ask({ t: 'draft', text: '/' });
    await a.until(s => s.menu && s.menu.items.length === 4, 'the / list');
    const i = a.state.menu.items.findIndex(x => x.label === '/model');
    ans = await a.ask({ t: 'menu', index: i });
    assert.equal(ans.t, 'done', JSON.stringify(ans)); assert.match(ans.text, /^\/model/);

    // A panel (no box): its keys close it.
    ans = await a.ask({ t: 'submit', text: '/usage' });
    assert.equal(ans.t, 'done', JSON.stringify(ans));
    await a.until(s => s.mode === 'panel' && s.live.length === 1, 'the panel, one block');
    a.send({ t: 'key', key: 'Escape' });
    await a.until(s => s.mode === 'compose', 'the panel closed');

    // A permission question, answered by a click (verified on screen).
    ans = await a.ask({ t: 'submit', text: 'make it, ask permission' });
    assert.equal(ans.t, 'done', JSON.stringify(ans));
    await a.until(s => s.mode === 'choice', 'the question');
    assert.deepEqual(a.state.choice.options.map(o => o.label), ['Yes', 'No']);
    assert.match(a.state.choice.question, /proceed/);
    ans = await a.ask({ t: 'choose', index: 0 });
    assert.equal(ans.t, 'done', JSON.stringify(ans));
    await a.until(s => s.mode === 'compose' && !s.status, 'done after yes');

    // A reply stopped.
    ans = await a.ask({ t: 'submit', text: 'a slow one' });
    await a.until(s => s.mode === 'working' && s.status, 'working');
    assert.equal(r.hub.state().working, true);
    a.send({ t: 'stop' });
    await a.until(s => s.mode === 'compose' && !s.status, 'stopped');

    // The conversation is in the agent's own file, each message once.
    const written = files(r.home).filter(f => f.endsWith('.jsonl')).map(f => fs.readFileSync(f, 'utf8')).join('');
    // Codex writes a typed message twice (an event and the message itself).
    assert.equal(written.split('make it, ask permission').length - 1, style === 'codex' ? 3 : 2, 'the question and its answer, once each');
    assert.match(written, /Done: make it, ask permission/);
  });
}

test('a folder question at start; two devices: one typist; a message received twice is applied once', { skip, timeout: 30000 }, async t => {
  const r = run('claude', { trust: true });
  t.after(r.close);
  const a = device(r.hub, 'laptop'), b = device(r.hub, 'phone');
  await a.until(s => s.mode === 'choice', 'trust question');
  assert.equal((await a.ask({ t: 'choose', index: 0 })).t, 'done');
  await a.until(s => s.mode === 'compose', 'the box after trusting');
  a.send({ t: 'text', text: 'ab' });
  const refused = await b.ask({ t: 'text', text: 'zz' });
  assert.equal(refused.t, 'refused'); assert.match(refused.error, /laptop is typing/);
  // The laptop's message again, as a reconnect would replay it.
  const again = a.seq();
  a.send({ t: 'text', text: 'ab' }, again);
  a.send({ t: 'text', text: 'c' });
  await a.until(s => s.composer.text === 'abc', 'once');
  await sleep(150);
  assert.equal(a.state.composer.text, 'abc');
  assert.equal(b.state.composer.text, 'abc', 'every device sees the same box');
  assert.deepEqual(r.hub.state().devices.sort(), ['laptop', 'phone']);
});

test('a message sent the moment the program starts waits for its box, and goes once', { skip, timeout: 30000 }, async t => {
  const r = run('claude', { trust: false });
  t.after(r.close);
  const a = device(r.hub, 'phone');
  const ans = await a.ask({ t: 'submit', text: 'sent at once' });
  assert.equal(ans.t, 'done', JSON.stringify(ans));
  await a.until(s => s.mode === 'compose' && !s.status, 'answered');
  await new Promise(res => setTimeout(res, 300));
  const written = files(r.home).filter(f => f.endsWith('.jsonl')).map(f => fs.readFileSync(f, 'utf8')).join('');
  assert.equal(written.split('"sent at once"').length - 1, 1, 'once');
  assert.match(written, /Done: sent at once/);
});

test('a question that comes up right after the box (Codex trusting a folder): the message waits, then goes once', { skip, timeout: 30000 }, async t => {
  const r = run('codex', { trust: 'late' });
  t.after(r.close);
  const a = device(r.hub, 'laptop');
  let ans = await a.ask({ t: 'submit', text: 'first words' });
  if (ans.t !== 'done') {
    // Told to answer first: answered, then sent again (as the page does).
    assert.match(ans.error, /asks something first/);
    await a.until(s => s.mode === 'choice', 'the question');
    assert.equal((await a.ask({ t: 'choose', index: 0 })).t, 'done');
    await a.until(s => s.mode === 'compose', 'its box');
    ans = await a.ask({ t: 'submit', text: 'first words' });
  } else if (a.state.mode === 'choice') {
    // Its Enter went to the question: answered, the message goes by itself.
    assert.equal((await a.ask({ t: 'choose', index: 0 })).t, 'done');
  }
  assert.equal(ans.t, 'done', JSON.stringify(ans));
  const t0 = Date.now();
  let written = '';
  while (Date.now() - t0 < 8000 && !/Done: first words/.test(written)) { await sleep(150); written = files(r.home).filter(f => f.endsWith('.jsonl')).map(f => fs.readFileSync(f, 'utf8')).join(''); }
  assert.match(written, /Done: first words/);
  assert.equal(written.split('first words').length - 1, 3, 'once (Codex writes a message twice, and the reply)');
});
