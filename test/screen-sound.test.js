'use strict';
// A finished-run sound plays where the person is (design/100, "Sound
// follows the person"): the computer's speakers when they are at a browser
// on the computer, else the page in front of them, which plays it itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const { HereBook, soundScreen, FRESH_MS } = require('../push-policy.js');
const { viewerBrowser } = require('./helpers/viewer-browser.js');
const { fakeOpenAI } = require('./helpers/fake-openai.js');
const { chromiumAvailable } = require('./helpers/chromium.js');

test('the screen a sound plays on: the visible one touched last, else any open one', () => {
  const now = 10 * 60 * 1000;
  const book = new HereBook();
  book.set('phone', 'u', { visible: false, idleMs: 0, local: false }, now - 1000);
  book.set('laptop', 'u', { visible: true, focused: false, idleMs: 5 * 60 * 1000, local: false }, now - 2000);
  book.set('desk', 'u', { visible: true, focused: true, idleMs: 9 * 60 * 1000, local: true }, now - 3000);
  // Shown screens win over a hidden one touched later; among them, the
  // latest touch (the laptop, watched for five minutes, not the desk).
  assert.equal(soundScreen(book.forUser('u'), now).conn, 'laptop');
  // A visible screen that stopped reporting (a laptop asleep) is no longer
  // known to be shown: the open ones are ranked by their last touch.
  assert.equal(soundScreen(book.forUser('u'), now + FRESH_MS).conn, 'phone');
  // Only one person's screens, and only open ones.
  book.set('other', 'v', { visible: true, idleMs: 0 }, now);
  assert.equal(soundScreen(book.forUser('u', c => c === 'desk'), now).conn, 'desk');
  assert.equal(soundScreen([], now), null);
});

test('a screen talking with the frog is where its voice sounds, hidden and untouched or not', () => {
  const now = 10 * 60 * 1000;
  const book = new HereBook();
  // The phone in a pocket, in a call: hidden, last touched ten minutes ago.
  book.set('phone', 'u', { visible: false, idleMs: 10 * 60 * 1000, local: false, talking: true }, now - 30 * 1000);
  book.set('laptop', 'u', { visible: true, focused: true, idleMs: 0, local: false }, now - 1000);
  assert.equal(soundScreen(book.forUser('u'), now).conn, 'phone');
  // Talk reports keep coming while it lasts; one that stopped (the page
  // gone) no longer claims the sound.
  assert.equal(soundScreen(book.forUser('u'), now + FRESH_MS).conn, 'laptop');
  // Two talking screens: the one touched last.
  book.set('tablet', 'u', { visible: true, idleMs: 0, local: false, talking: true }, now);
  assert.equal(soundScreen(book.forUser('u'), now).conn, 'tablet');
});

test('where the person was last is remembered after the screen closes', () => {
  const book = new HereBook();
  assert.equal(book.lastFor('u'), null);
  book.set('desk', 'u', { visible: true, idleMs: 0, local: true }, 1000);
  book.set('laptop', 'u', { visible: true, idleMs: 0, local: false }, 5000);
  // An older screen reporting again does not take "last" back.
  book.set('desk', 'u', { visible: false, idleMs: 3000, local: true }, 6000);
  book.remove('laptop'); book.remove('desk');
  assert.deepEqual(book.lastFor('u'), { local: false, activeAt: 5000 });
});

test('a reply finishing plays on the page of a screen elsewhere, not on a page on this computer', { skip: !chromiumAvailable() && 'chromium is not installed', timeout: 180000 }, async t => {
  const model = await fakeOpenAI({ reply: 'Done: the tests pass.' });
  t.after(() => model.close());
  const app = await viewerBrowser(t, { flags: ['--autoplay-policy=no-user-gesture-required'] });
  const { base, auth, token, command, evaluate, until } = app;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const d = await r.json(); assert.ok(r.ok, p + ': ' + JSON.stringify(d)); return d; };
  const server = await post('/api/ai/server', { baseUrl: model.baseUrl });
  const key = 'pi:fixture/media.jsonl';
  await post('/api/agent-read', { open: [key] });
  const doneRuns = async () => (await (await fetch(base + '/api/jobs', { headers: auth })).json()).filter(j => j.type === 'agent-run' && j.status === 'done').length;
  async function runOnce(prompt) {
    const before = await doneRuns();
    await post('/api/node/send', { id: key, prompt, models: [{ provider: server.name, modelId: 'fixture-chat' }] });
    for (let i = 0; i < 300 && await doneRuns() <= before; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 1500));
  }
  const ready = async () => {
    await until(`typeof ScreenSound !== 'undefined' && typeof peopleState !== 'undefined' && peopleState.conn`, 'the page connected');
    await evaluate(`window.__sounds = []; ScreenSound.play = s => window.__sounds.push(s); PushUI.report(true); true`);
    await new Promise(r => setTimeout(r, 500));
  };

  // The page's own chime: three notes, made in the page.
  await until(`typeof ScreenSound !== 'undefined'`, 'the page loaded');
  assert.deepEqual(await evaluate(`new Promise(resolve => {
    const notes = [], make = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () { const o = make.call(this); notes.push(o.frequency); return o; };
    ScreenSound.play({ tone: 'done' });
    setTimeout(() => resolve(notes.map(f => Math.round(f.value))), 800);
  })`), [523, 659, 784]);

  // A browser on this computer: this computer's speakers play it.
  await ready();
  await runOnce('First');
  assert.deepEqual(await evaluate('window.__sounds'), [], 'a page on this computer plays nothing itself');

  // The same page as another device sees it (through Tailscale Serve, the
  // request is forwarded): the page is told to play the chime.
  await command('Network.setExtraHTTPHeaders', { headers: { 'X-Forwarded-For': '100.64.0.9' } });
  await command('Page.navigate', { url: base + '/?token=' + token });
  await ready();
  await runOnce('Second');
  assert.deepEqual(await evaluate('window.__sounds.map(s => s.tone || s.audio)'), ['done'], app.log().slice(-2000));
});

// An agent's own program (Claude Code here, a stand-in that draws and writes
// like it): "working" ending is a finished reply, and it sounds like one.
test('a reply from an agent\'s own program plays too', { skip: require('../harness/terminal/deps').terminalDeps().error || (process.platform === 'win32' && 'a Unix pseudoterminal'), timeout: 120000 }, async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
  const { spawn } = require('node:child_process');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'screen-sound-')));
  const work = path.join(home, 'Projects', 'zoo'); fs.mkdirSync(work, { recursive: true });
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  const fake = path.join(__dirname, 'fixtures', 'fake-terminal-agent.js');
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nFAKE_AGENT_STYLE=claude exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fake)} "$@"\n`, { mode: 0o755 });
  const dir = path.join(home, '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-')); fs.mkdirSync(dir, { recursive: true });
  const cid = '11111111-2222-4333-8444-555555555555';
  fs.writeFileSync(path.join(dir, cid + '.jsonl'), [
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: cid, cwd: work, timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'Explain the kestrel parser' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: cid, cwd: work, timestamp: '2026-09-01T10:00:05Z', message: { role: 'assistant', model: 'claude-fixture', content: [{ type: 'text', text: 'It reads kestrels.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  require('./helpers/first-run').answerFirstRun(home);
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const TOKEN = 'screen-sound-token', AUTH = { Authorization: 'Bearer ' + TOKEN }, base = 'http://127.0.0.1:' + port;
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...require('./helpers/home-env').homeEnv(home),
    PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_PUBLIC_URL: '', CHATTERING_NO_WATCH: '1', CHATTERING_NO_SYNC: '1', CHATTERING_NO_LEDGER: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    CHATTERING_NO_CGROUP: '1', CHATTERING_CLAUDE: path.join(bin, 'claude'), FAKE_AGENT_DELAY: '300', CHATTERING_DISABLE_NETWORK_RECOVERY: '1',
    CHATTERING_TOKEN: TOKEN, CHATTERING_PREVIEW_PORT: '0', CHATTERING_PREVIEW_TLS_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup').stopAndRemove(child, home));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, what, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out: ' + what + '\n' + log.slice(-2000)); await sleep(60); } };
  const api = (p, body) => fetch(base + p, body === undefined ? { headers: AUTH } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  const key = await until(async () => (await api('/api/sessions')).body.find(s => s.key.startsWith('claude:'))?.key, 'the conversation indexed', 30000);

  // A screen elsewhere: its event stream comes forwarded, as through Tailscale Serve.
  const abort = new AbortController(); t.after(() => abort.abort());
  const events = [];
  const res = await fetch(base + '/api/events', { headers: { ...AUTH, 'X-Forwarded-For': '100.64.0.9' }, signal: abort.signal });
  (async () => { let buf = ''; try { for await (const chunk of res.body) { buf += Buffer.from(chunk).toString(); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); const m = block.match(/^data: (.*)$/m); if (m) try { events.push(JSON.parse(m[1])); } catch {} } } } catch {} })();
  const hello = await until(async () => events.find(e => e.type === 'hello'), 'the stream says hello');
  assert.equal((await api('/api/push/here', { conn: hello.conn, visible: true, focused: true, idleMs: 0, route: 'home' })).status, 200);

  assert.equal((await api('/api/live-terminal/start', { id: key })).status, 200);
  const ws = new WebSocket(base.replace('http', 'ws') + '/api/live-terminal/ws?id=' + encodeURIComponent(key), { headers: AUTH });
  t.after(() => ws.close());
  const state = {}, answers = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.t === 'patch') Object.assign(state, m.set); else if (answers.has(m.seq)) { answers.get(m.seq)(m); answers.delete(m.seq); } };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.send(JSON.stringify({ t: 'hello', clientId: 'sound-' + Date.now(), name: 'test' }));
  await until(async () => state.composer && state.mode === 'compose', 'its box');
  const answered = await new Promise(r => { answers.set(1, r); ws.send(JSON.stringify({ t: 'submit', text: 'count the kestrels', seq: 1 })); });
  assert.equal(answered.t, 'done', JSON.stringify(answered));
  const sound = await until(async () => events.find(e => e.type === 'done-sound'), 'the finished-run sound on the screen elsewhere');
  assert.equal(sound.tone, 'done');
  await sleep(5000);
  assert.equal(events.filter(e => e.type === 'done-sound').length, 1, 'one reply, one sound');
});
