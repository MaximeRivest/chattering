'use strict';
// Voice commands on a real server: the listening socket turns streamed
// audio into heard text and utterances (through a stand-in speech service),
// and /api/voice/decide asks a stand-in Jev and records the decision. The
// stand-ins speak the real protocols: POST /transcribe (PCM in, text out)
// and TypeSafe's /v1/systemone (questions in, typed answers out).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { FRAME_BYTES } = require('../voice-window.js');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };

// Tone words: word k of VOCAB is 400 ms at amplitude 1000·(k+1).
const VOCAB = ['open', 'the', 'settings', 'reasoning', 'off', 'please'];
const frame = amp => { const b = Buffer.alloc(FRAME_BYTES); for (let i = 0; i < FRAME_BYTES / 2; i++) b.writeInt16LE(Math.round(amp * Math.sin(i / 3)), i * 2); return b; };
const speak = words => Buffer.concat(words.flatMap(w => [...Array(4)].map(() => frame(1000 * (VOCAB.indexOf(w) + 1))).concat([frame(0)])));
const quiet = ms => Buffer.concat(Array.from({ length: ms / 100 }, () => frame(0)));
function recognize(pcm) {
  const out = []; let run = null;
  for (let at = 0; at + FRAME_BYTES <= pcm.length; at += FRAME_BYTES) {
    let peak = 0; for (let i = 0; i < FRAME_BYTES / 2; i++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(at + i * 2)));
    const k = Math.round(peak / 1000);
    if (k >= 1) { if (run !== k) out.push(VOCAB[k - 1]); run = k; } else run = null;
  }
  return out.join(' ');
}

async function standIns(t) {
  const jevCalls = [];
  const speech = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(recognize(Buffer.concat(chunks))); });
  });
  // Jev: the action named by the words said; arguments from their candidates.
  const jev = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks)); jevCalls.push({ body, auth: req.headers.authorization });
      const said = body.state.said;
      const pick = (q, want) => { const keys = Object.keys(body.questions[q].criteria); const choice = keys.find(k => want(k)) || keys.at(-1); return { type: 'choice', choice, confidence: 0.97, probabilities: { [choice]: 0.97 } }; };
      const action = /settings/.test(said) ? 'settings' : /reasoning/.test(said) ? 'reasoning' : /^open/.test(said) ? 'open' : 'none';
      const answers = { action: pick('action', k => k === action) };
      if (body.questions['settings.pane']) answers['settings.pane'] = pick('settings.pane', k => k === 'profile');
      if (body.questions['reasoning.level']) answers['reasoning.level'] = pick('reasoning.level', k => said.includes(k));
      if (body.questions['open.name']) answers['open.name'] = pick('open.name', k => /notes\.md$/.test(k));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ answers }));
    });
  });
  await Promise.all([speech, jev].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
  t.after(() => { speech.close(); if (jev.listening) jev.close(); });
  return { speechUrl: 'http://127.0.0.1:' + speech.address().port, jevUrl: 'http://127.0.0.1:' + jev.address().port + '/v1/systemone', jevCalls, jev };
}

async function boot(t, { key = 'test-key-0123456789abcdef', setup = null } = {}) {
  const stand = await standIns(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-api-'));
  fs.mkdirSync(path.join(home, '.config', 'chattering'), { recursive: true });
  fs.mkdirSync(path.join(home, '.pi', 'agent', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'chattering', 'settings.json'), JSON.stringify({ speechUrl: stand.speechUrl }));
  if (setup) setup(home);
  const port = await freePort();
  const env = { ...process.env, HOME: home, PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_LAN: '', CHATTERING_TOKEN: '', CHATTERING_NO_WATCH: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'), TYPESAFE_URL: stand.jevUrl };
  delete env.TYPESAFE_API_KEY;
  if (key) fs.writeFileSync(path.join(home, '.config', 'chattering', 'typesafe-api-key'), key + '\n', { mode: 0o600 });
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  // The server may still be writing its caches: wait for it to exit first.
  t.after(async () => {
    const exited = child.exitCode !== null || new Promise(r => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(base + '/api/settings')).ok) break; } catch {} await sleep(50); }
  return { ...stand, base, port, home, log: () => log };
}
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('listening: streamed speech becomes heard text and utterances, with context', async t => {
  const s = await boot(t);
  const ws = new WebSocket('ws://127.0.0.1:' + s.port + '/api/voice/listen?window=45');
  const events = [];
  ws.onmessage = m => events.push(JSON.parse(m.data));
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('no socket: ' + s.log().slice(-400))); });
  const send = async buf => { for (let at = 0; at < buf.length; at += FRAME_BYTES * 2) { ws.send(buf.subarray(at, at + FRAME_BYTES * 2)); await sleep(5); } };
  await send(quiet(2500));
  await send(speak(['open', 'the', 'settings']));
  await send(quiet(1200));
  await send(speak(['reasoning', 'off', 'please']));
  await send(quiet(1200));
  for (let i = 0; i < 300 && events.filter(e => e.type === 'utterance').length < 2; i++) await sleep(30);
  ws.close();
  assert.equal(events[0].type, 'ready');
  assert.equal(events[0].windowSeconds, 45);
  assert.deepEqual(events.filter(e => e.type === 'utterance').map(e => e.text), ['open the settings', 'reasoning off please']);
  const heard = events.filter(e => e.type === 'heard').at(-1);
  assert.equal((heard.committed + ' ' + heard.stable + ' ' + heard.volatile).trim(), 'open the settings reasoning off please', 'the second sentence was heard with the first as context');
  assert.deepEqual(events.filter(e => e.type === 'error'), []);
});

test('deciding: one request to Jev with the key; a decision and its outcome are recorded', async t => {
  const s = await boot(t);
  const status = await (await fetch(s.base + '/api/voice/status')).json();
  assert.deepEqual([status.key, status.keyFromEnv, status.speech, status.refused], [true, false, true, null]);
  const r = await (await post(s.base, '/api/voice/decide', { said: 'reasoning off please', screen: 'a conversation', actions: ['reasoning', 'settings', 'bogus'] })).json();
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual([r.decision.action, r.decision.args], ['reasoning', { level: 'off' }]);
  assert.equal(s.jevCalls.at(-1).auth, 'Bearer test-key-0123456789abcdef', 'the key stays on the server');
  assert.deepEqual(Object.keys(s.jevCalls.at(-1).body.questions).sort(), ['action', 'reasoning.level', 'settings.pane']);
  assert.equal((await post(s.base, '/api/voice/outcome', { id: r.id, outcome: 'done' })).status, 200);
  assert.equal((await post(s.base, '/api/voice/outcome', { id: r.id, outcome: 'maybe' })).status, 400);
  // Every sentence is kept, with what the screen offered and Jev's answers.
  await post(s.base, '/api/voice/decide', { said: 'pass the salt', screen: 'home', actions: ['settings'], asrMs: 210 });
  const file = path.join(s.home, '.local', 'share', 'chattering', 'voice-commands.jsonl');
  const log = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(log.map(l => l.action || l.outcome), ['reasoning', 'done', 'none']);
  const salt = log.at(-1);
  assert.deepEqual([salt.said, salt.screen, salt.asrMs, salt.offered.sort()], ['pass the salt', 'home', 210, ['none', 'settings']]);
  assert.deepEqual(salt.answers.action, { choice: 'none', confidence: 0.97, top: [['none', 0.97]] }, 'Jev\u2019s answer (the stand-in reports the chosen option only)');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // The history: newest first, with outcomes; a note on what was meant.
  const hist = await (await fetch(s.base + '/api/voice/history')).json();
  assert.deepEqual(hist.rows.map(h => [h.said, h.action, h.outcomes]), [['pass the salt', 'none', []], ['reasoning off please', 'reasoning', ['done']]]);
  assert.equal((await post(s.base, '/api/voice/note', { id: hist.rows[0].id, wanted: 'nothing, I was talking to someone' })).status, 200);
  assert.equal((await post(s.base, '/api/voice/note', { id: 'nope', wanted: 'x' })).status, 404);
  assert.equal((await (await fetch(s.base + '/api/voice/history')).json()).rows[0].note, 'nothing, I was talking to someone');
  // Forgetting removes the sentences, their outcomes and their notes.
  assert.equal((await (await post(s.base, '/api/voice/history/clear', {})).json()).removed, 2);
  assert.deepEqual((await (await fetch(s.base + '/api/voice/history')).json()).rows, []);
  assert.equal(fs.readFileSync(file, 'utf8'), '');
});

test('a call to Jev that fails is recorded too, with what was said', async t => {
  const s = await boot(t);
  await new Promise(r => s.jev.close(r)); // Jev unreachable
  const r = await post(s.base, '/api/voice/decide', { said: 'open the settings', actions: ['settings'] });
  assert.equal(r.status, 502);
  const row = (await (await fetch(s.base + '/api/voice/history')).json()).rows[0];
  assert.deepEqual([row.said, row.action], ['open the settings', null]);
  assert.match(row.error, /TypeSafe did not answer/);
});

test('the key: saved by the owner only to a private file, never sent back; without it, a clear refusal', async t => {
  const s = await boot(t, { key: null });
  const r = await post(s.base, '/api/voice/decide', { said: 'open the settings', actions: ['settings'] });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /TypeSafe key/);
  assert.match((await (await post(s.base, '/api/voice/key', { key: 'short' })).json()).error, /does not look like/);
  assert.equal((await (await post(s.base, '/api/voice/key', { key: 'apikey_0123456789abcdef0123' })).json()).key, true);
  const file = path.join(s.home, '.config', 'chattering', 'typesafe-api-key');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const status = await (await fetch(s.base + '/api/voice/status')).text();
  assert.doesNotMatch(status, /apikey_/, 'the key never goes back to a page');
  await post(s.base, '/api/voice/key', { key: '' });
  assert.equal(fs.existsSync(file), false);
});

test('open anywhere: every project by name, and the files of a project the sentence names', async t => {
  // Folders under /tmp are never projects (projectfolds.js): the projects
  // live in memory-backed /dev/shm.
  if (!fs.existsSync('/dev/shm')) return t.skip('no /dev/shm');
  const where = fs.mkdtempSync('/dev/shm/voice-projects-');
  t.after(() => fs.rmSync(where, { recursive: true, force: true }));
  const s = await boot(t, { setup: home => {
    for (const [name, files] of [['alpha-beta', ['notes.md', 'src/main.js']], ['gamma', ['readme.md']], ['delta', ['notes.md']]]) {
      const dir = path.join(where, 'Projects', name);
      for (const f of files) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), 'x'); }
      const sessions = path.join(home, '.pi', 'agent', 'sessions', '--' + name + '--');
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(path.join(sessions, 's.jsonl'), [{ type: 'session', version: 3, id: name, cwd: dir }, { type: 'message', id: 'u', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'hi ' + name }] } }].map(JSON.stringify).join('\n') + '\n');
    }
  } });
  // The server reads the conversations after it starts listening.
  for (let i = 0; i < 100 && (await (await fetch(s.base + '/api/sessions')).json()).length < 3; i++) await sleep(100);
  const r = await (await post(s.base, '/api/voice/decide', { said: 'open the notes file in alpha beta', screen: 'a file', actions: ['open'], project: 'gamma', lists: { targets: [] } })).json();
  assert.equal(r.error, undefined, r.error);
  const names = Object.keys(s.jevCalls.at(-1).body.questions['open.name'].criteria);
  for (const want of ['project · alpha-beta', 'project · delta', 'file · alpha-beta/notes.md', 'file · alpha-beta/src/main.js', 'file · readme.md']) assert.ok(names.includes(want), want + ' in ' + JSON.stringify(names));
  assert.ok(!names.some(n => n.startsWith('file · delta/')), 'not the files of a project nobody named');
  assert.equal(r.decision.args.name, 'pfile:alpha-beta:' + path.join(where, 'Projects', 'alpha-beta', 'notes.md'));
  // The history says what was picked, not its id.
  const hist = await (await fetch(s.base + '/api/voice/history')).json();
  assert.equal(hist.rows[0].argLabels.name, 'file · alpha-beta/notes.md');
});

test('a page on plain http is told the https address, where the browser gives the microphone', async t => {
  const s = await boot(t);
  const get = host => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: s.port, path: '/api/voice/status', headers: { host } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b))); }).on('error', reject));
  assert.match((await get('100.86.49.54:7433')).secureUrl, /^https:\/\/100\.86\.49\.54:\d+\/\?token=/);
  assert.equal((await get('localhost:7433')).secureUrl, null, 'localhost is secure already');
});
