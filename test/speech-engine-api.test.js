'use strict';
// The speech engine choice on a real server (speech-engines.js): Parakeet
// by default; a person switches to "my voice" and the very next utterance
// on an open listening socket goes there; the corpus names the engine; a
// failing engine falls back to Parakeet, named as such; dictation
// (/api/speech/transcribe) follows the same choice.
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const TEST_TOKEN = 'test-install-token';
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
const frame = amp => { const b = Buffer.alloc(FRAME_BYTES); for (let i = 0; i < FRAME_BYTES / 2; i++) b.writeInt16LE(Math.round(amp * Math.sin(i / 3)), i * 2); return b; };
const quiet = ms => Buffer.concat(Array.from({ length: ms / 100 }, () => frame(0)));
const words = n => Buffer.concat(Array.from({ length: n }, () => Buffer.concat([...[...Array(4)].map(() => frame(6000)), frame(0)])));

// A stand-in speech server: one copy of its word per spoken tone in the
// audio (the listener re-transcribes its whole window, so the answer must
// grow with the audio), and a count of the calls.
const peakAt = (pcm, at) => { let p = 0; for (let i = 0; i < FRAME_BYTES / 2 && at + i * 2 + 1 < pcm.length; i++) p = Math.max(p, Math.abs(pcm.readInt16LE(at + i * 2))); return p; };
function countWords(pcm) { let n = 0, run = false; for (let at = 0; at + FRAME_BYTES <= pcm.length; at += FRAME_BYTES) { const loud = peakAt(pcm, at) > 1000; if (loud && !run) n++; run = loud; } return n; }
async function standIn(t, word) {
  const hits = { n: 0 };
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { hits.n++; res.writeHead(200, { 'content-type': 'text/plain' }); res.end(Array.from({ length: countWords(Buffer.concat(chunks)) }, () => word).join(' ')); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { url: 'http://127.0.0.1:' + srv.address().port, hits, close: () => new Promise(r => srv.close(r)) };
}

async function boot(t) {
  const parakeet = await standIn(t, 'Parakeet.');
  const myvoice = await standIn(t, 'myvoice');
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'speech-engine-')));
  fs.mkdirSync(path.join(home, '.config', 'chattering'), { recursive: true });
  fs.mkdirSync(path.join(home, '.pi', 'agent', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'chattering', 'settings.json'), JSON.stringify({ speechUrl: parakeet.url, myVoiceUrl: myvoice.url }));
  const corpus = path.join(home, 'corpus');
  const port = await freePort();
  registerConsole(port, TEST_TOKEN);
  const env = { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_LAN: '', CHATTERING_TOKEN: TEST_TOKEN, CHATTERING_NO_WATCH: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'), CHATTERING_VOICE_CORPUS_DIR: corpus };
  delete env.SPEECH_URL; delete env.MYVOICE_URL; delete env.SPEAKER_URL;
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(async () => {
    const exited = child.exitCode !== null || new Promise(r => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
    await require('./helpers/cleanup.js').stopAndRemove(null, home);
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(base + '/api/settings')).ok) break; } catch {} await sleep(50); }
  return { parakeet, myvoice, base, port, home, corpus, log: () => log };
}
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function listen(s) {
  const ws = new WebSocket('ws://127.0.0.1:' + s.port + '/api/voice/listen?window=45', { headers: { Authorization: 'Bearer ' + TEST_TOKEN } });
  const events = [];
  ws.onmessage = m => events.push(JSON.parse(m.data));
  const open = new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('no socket: ' + s.log().slice(-400))); });
  const send = async buf => { for (let at = 0; at < buf.length; at += FRAME_BYTES * 4) { ws.send(buf.subarray(at, at + FRAME_BYTES * 4)); await sleep(2); } };
  const utterances = () => events.filter(e => e.type === 'utterance');
  const nextUtterance = async (n, ms = 8000) => { for (let i = 0; i < ms / 30 && utterances().length < n; i++) await sleep(30); assert.equal(utterances().length, n, JSON.stringify(events.map(e => e.type + (e.message ? ':' + e.message : '')))); return utterances()[n - 1]; };
  return { ws, events, open, send, utterances, nextUtterance };
}
const corpusLabels = dir => { const out = []; const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.json')) out.push(JSON.parse(fs.readFileSync(p, 'utf8'))); } }; if (fs.existsSync(dir)) walk(dir); return out.sort((a, b) => a.at < b.at ? -1 : 1).map(m => [m.text, m.engine]); };

test('Parakeet by default; "my voice" from the next utterance after the switch; the corpus names the engine; a failing engine falls back, named', async t => {
  const s = await boot(t);
  let st = await (await fetch(s.base + '/api/voice/engine')).json();
  assert.deepEqual([st.chosen, st.active, st.fallback], ['parakeet', 'parakeet', undefined]);
  assert.deepEqual(st.engines.map(e => [e.id, e.configured]), [['parakeet', true], ['myvoice', true]]);

  const l = listen(s);
  await l.open;
  for (let i = 0; i < 200 && !l.events.some(e => e.type === 'ready'); i++) await sleep(30);
  assert.equal(l.events.find(e => e.type === 'ready').engine, 'parakeet');
  await l.send(quiet(2500));
  await l.send(words(2)); await l.send(quiet(1200));
  let u = await l.nextUtterance(1);
  assert.deepEqual([u.text, u.engine], ['Parakeet. Parakeet.', 'parakeet']);
  assert.ok(s.parakeet.hits.n >= 1 && s.myvoice.hits.n === 0);

  // the switch, while the socket stays open
  st = await (await post(s.base, '/api/voice/engine', { engine: 'myvoice' })).json();
  assert.deepEqual([st.chosen, st.active], ['myvoice', 'myvoice']);
  await l.send(words(2)); await l.send(quiet(1200));
  u = await l.nextUtterance(2);
  assert.deepEqual([u.text, u.engine], ['myvoice myvoice', 'myvoice']);
  assert.ok(s.myvoice.hits.n >= 1, 'my voice was asked');
  assert.ok(l.events.some(e => e.type === 'heard' && e.engine === 'myvoice'), 'the live words name the engine too');

  // dictation follows the same choice
  const r = await fetch(s.base + '/api/speech/transcribe', { method: 'POST', headers: { 'content-type': 'audio/L16;rate=16000;channels=1' }, body: words(3) });
  assert.equal(await r.text(), 'myvoice myvoice myvoice');
  assert.equal(r.headers.get('x-speech-engine'), 'myvoice');

  // my voice goes down: Parakeet answers, and the fall-back is named
  await s.myvoice.close();
  await l.send(words(2)); await l.send(quiet(1200));
  u = await l.nextUtterance(3);
  assert.equal(u.text, 'Parakeet. Parakeet.');
  assert.match(u.engine, /^parakeet \(my voice failed: /);
  const r2 = await fetch(s.base + '/api/speech/transcribe', { method: 'POST', headers: { 'content-type': 'audio/L16;rate=16000;channels=1' }, body: words(3) });
  assert.equal(r2.headers.get('x-speech-engine'), 'parakeet; fallback');

  // back to Parakeet by choice
  st = await (await post(s.base, '/api/voice/engine', { engine: 'parakeet' })).json();
  assert.equal(st.active, 'parakeet');
  await l.send(words(2)); await l.send(quiet(1200));
  u = await l.nextUtterance(4);
  assert.equal(u.engine, 'parakeet');
  assert.equal((await post(s.base, '/api/voice/engine', { engine: 'whisper' })).status, 400);

  // the corpus (the owner is recorded) labels every utterance with its engine
  for (let i = 0; i < 100 && corpusLabels(s.corpus).length < 4; i++) await sleep(30);
  const labels = corpusLabels(s.corpus);
  assert.equal(labels.length, 4, JSON.stringify(labels));
  assert.deepEqual(labels.map(x => x[1]).slice(0, 2), ['parakeet', 'myvoice']);
  assert.match(labels[2][1], /^parakeet \(my voice failed/);
  assert.equal(labels[3][1], 'parakeet');
  l.ws.close();
});
