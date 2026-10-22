'use strict';
// Only my voice, on a real server (design/102): the print routes, an
// enrolment over the listening socket, then utterances checked against the
// print — through stand-ins that speak the real protocols: POST /transcribe
// (speech), and the voice-print service's POST /embed and /check (the score
// is named by the tone's loudness: words at amplitude ≥ 5000 are "mine").
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
const { FRAME_BYTES, BYTES_PER_SECOND } = require('../voice-window.js');
const S = require('../voice-speaker.js');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };

const frame = amp => { const b = Buffer.alloc(FRAME_BYTES); for (let i = 0; i < FRAME_BYTES / 2; i++) b.writeInt16LE(Math.round(amp * Math.sin(i / 3)), i * 2); return b; };
const quiet = ms => Buffer.concat(Array.from({ length: ms / 100 }, () => frame(0)));
// My voice: loud tones; another voice: softer tones. One "word" = 400 ms.
const tones = (n, amp) => Buffer.concat(Array.from({ length: n }, () => Buffer.concat([...[...Array(4)].map(() => frame(amp)), frame(0)])));
const mine = n => tones(n, 6000);
const theirs = n => tones(n, 2000);
const peakAt = (pcm, at) => { let p = 0; for (let i = 0; i < FRAME_BYTES / 2 && at + i * 2 + 1 < pcm.length; i++) p = Math.max(p, Math.abs(pcm.readInt16LE(at + i * 2))); return p; };
function recognize(pcm) {
  const out = []; let run = null;
  for (let at = 0; at + FRAME_BYTES <= pcm.length; at += FRAME_BYTES) {
    const p = peakAt(pcm, at); const k = p > 4000 ? 'mine' : p > 1000 ? 'theirs' : null;
    if (k) { if (run !== k) out.push(k); run = k; } else run = null;
  }
  return out.join(' ');
}
async function standIns(t) {
  const speech = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(recognize(Buffer.concat(chunks))); });
  });
  const checks = [];
  const speaker = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const pcm = Buffer.concat(chunks); const secs = pcm.length / BYTES_PER_SECOND;
      const v = new Array(S.DIM).fill(0); v[0] = 1;
      if (req.url.startsWith('/embed')) return res.end(JSON.stringify({ secs, embedding: v, windows: [v, v, v, v], ms: 2 }));
      checks.push({ secs, prints: req.headers['x-voice-prints'] });
      // the score: the loudest frame's amplitude, 6000 → 0.8, 2000 → 0.05
      let peak = 0; for (let at = 0; at + FRAME_BYTES <= pcm.length; at += FRAME_BYTES) peak = Math.max(peak, peakAt(pcm, at));
      const score = peak > 4000 ? 0.8 : 0.05;
      res.end(JSON.stringify({ secs, score, windows: [], ms: 2 }));
    });
  });
  await Promise.all([speech, speaker].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
  t.after(() => { speech.close(); speaker.close(); });
  return { speechUrl: 'http://127.0.0.1:' + speech.address().port, speakerUrl: 'http://127.0.0.1:' + speaker.address().port, checks };
}

async function boot(t) {
  const stand = await standIns(t);
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-print-')));
  fs.mkdirSync(path.join(home, '.config', 'chattering'), { recursive: true });
  fs.mkdirSync(path.join(home, '.pi', 'agent', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'chattering', 'settings.json'), JSON.stringify({ speechUrl: stand.speechUrl, speakerUrl: stand.speakerUrl }));
  const port = await freePort();
  registerConsole(port, TEST_TOKEN);
  const env = { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_LAN: '', CHATTERING_TOKEN: TEST_TOKEN, CHATTERING_NO_WATCH: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent') };
  delete env.SPEAKER_URL;
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
  return { ...stand, base, port, home, log: () => log };
}
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function listen(s) {
  const ws = new WebSocket('ws://127.0.0.1:' + s.port + '/api/voice/listen?window=45', { headers: { Authorization: 'Bearer ' + TEST_TOKEN } });
  const events = [];
  ws.onmessage = m => events.push(JSON.parse(m.data));
  const open = new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('no socket: ' + s.log().slice(-400))); });
  const send = async buf => { for (let at = 0; at < buf.length; at += FRAME_BYTES * 4) { ws.send(buf.subarray(at, at + FRAME_BYTES * 4)); await sleep(2); } };
  const until = async (pred, ms = 8000) => { for (let i = 0; i < ms / 30 && !events.some(pred); i++) await sleep(30); return events.find(pred); };
  return { ws, events, open, send, until };
}

test('no print yet: the check is off, and it cannot be switched on; an enrolment over the socket makes one and switches it on', async t => {
  const s = await boot(t);
  let st = await (await fetch(s.base + '/api/voice/print')).json();
  assert.deepEqual([st.on, st.prints, st.service], [false, [], true]);
  st = await (await post(s.base, '/api/voice/print', { on: true })).json();
  assert.equal(st.on, false, 'nothing to compare with yet');

  const l = listen(s);
  await l.open;
  const ready = await l.until(e => e.type === 'ready');
  assert.equal(ready.speaker, false);
  // enrol: 20 s wanted, the minimum; speech frames only count
  l.ws.send(JSON.stringify({ type: 'enrol', seconds: 20, label: 'test laptop' }));
  await l.send(quiet(2500));
  await l.send(mine(55)); // 55 words of 400 ms ≈ 22 s of speech
  const enrolled = await l.until(e => e.type === 'enrolled', 15000);
  assert.ok(enrolled, 'enrolled: ' + JSON.stringify(l.events.filter(e => e.type === 'enrol').slice(-2)) + ' ' + s.log().slice(-300));
  assert.equal(enrolled.print.label, 'test laptop');
  assert.ok(enrolled.print.secs >= 20);
  assert.equal(enrolled.print.embedding, undefined, 'embeddings never go to a page');
  assert.equal(enrolled.speaker, true);
  assert.ok(l.events.some(e => e.type === 'enrol' && e.secs >= 1), 'progress was reported');
  // what was said during the recording was heard (the page ignores it), but is marked by nothing special here
  st = await (await fetch(s.base + '/api/voice/print')).json();
  assert.deepEqual([st.on, st.prints.length, st.prints[0].label], [true, 1, 'test laptop']);
  const file = path.join(require('./helpers/home-env.js').appDir(s.home, 'data'), 'voice-prints.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))[0]].prints[0].embedding.length, S.DIM);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // now utterances are checked: mine goes through as mine, theirs is marked not mine
  await l.send(quiet(1500));
  await l.until(e => e.type === 'utterance'); // the recording's own tail
  await sleep(800); // a 22 s recording without an 800 ms pause is handed on in two (the 15 s cap, voice-window.js)
  l.events.length = 0;
  await l.send(mine(2)); await l.send(quiet(1200));
  await l.send(theirs(2)); await l.send(quiet(1200));
  for (let i = 0; i < 300 && l.events.filter(e => e.type === 'utterance').length < 2; i++) await sleep(30);
  const utts = l.events.filter(e => e.type === 'utterance');
  assert.equal(utts.length, 2, JSON.stringify(l.events.map(e => e.type)));
  assert.match(utts[0].text, /^mine( mine)?$/);
  assert.equal(utts[0].speaker.mine, 'yes');
  assert.equal(utts[0].speaker.score, 0.8);
  assert.match(utts[1].text, /^theirs( theirs)?$/);
  assert.equal(utts[1].speaker.mine, 'no');
  assert.ok(s.checks.length >= 2 && s.checks.every(c => Buffer.from(c.prints, 'base64').length === S.DIM * 4), 'the print went along with each check');

  // "It was me" (design/102, 2026-10-19): the utterance carries an id; a
  // claim logs the correction and pools its audio; at 20 s of pooled
  // speech a print "from your corrections" is made and the listener
  // follows it at once. (One 2-word utterance is ~1 s: pool more first.)
  assert.ok(utts[1].id, 'an id on the utterance');
  let claim = await (await post(s.base, '/api/voice/print/claim', { id: utts[1].id, device: 'test phone' })).json();
  assert.deepEqual([claim.kept, claim.need, claim.print], [true, 20, undefined], JSON.stringify(claim));
  assert.ok(claim.poolSecs >= 0 && claim.poolSecs < 20);
  claim = await (await post(s.base, '/api/voice/print/claim', { id: utts[1].id })).json();
  assert.equal(claim.kept, false, 'claimed once');
  l.events.length = 0;
  await l.send(theirs(50)); await l.send(quiet(1200)); // ~20 s, handed on in two (the cap)
  for (let i = 0; i < 300 && l.events.filter(e => e.type === 'utterance').length < 2; i++) await sleep(30);
  const printsBefore = (await (await fetch(s.base + '/api/voice/print')).json()).prints.length;
  for (const u of l.events.filter(e => e.type === 'utterance')) claim = await (await post(s.base, '/api/voice/print/claim', { id: u.id, device: 'test phone' })).json();
  assert.ok(claim.print && claim.print.label === 'from your corrections (test phone)', 'a print from the corrections: ' + JSON.stringify(claim));
  assert.equal(claim.claims, 3);
  const now = await (await fetch(s.base + '/api/voice/print')).json();
  assert.equal(now.prints.length, printsBefore + 1);
  assert.ok(await l.until(e => e.type === 'speaker' && e.on === true, 3000), 'the listener was told to re-read the prints');
  const logFile = path.join(require('./helpers/home-env.js').appDir(s.home, 'data'), 'voice-speaker.jsonl');
  assert.ok(fs.readFileSync(logFile, 'utf8').split('\n').some(l => l.includes('"claimed":true')), 'the correction is in the verdict log');
  l.events.length = 0;

  // off: the listener is told and stops checking; forget: the print goes, and on with it
  st = await (await post(s.base, '/api/voice/print', { on: false })).json();
  assert.equal(st.on, false);
  l.ws.send(JSON.stringify({ type: 'speaker' }));
  const sp = await l.until(e => e.type === 'speaker');
  assert.equal(sp.on, false);
  l.events.length = 0;
  await l.send(theirs(2)); await l.send(quiet(1200));
  const u = await l.until(e => e.type === 'utterance');
  assert.equal(u.speaker, undefined, 'no check while off');
  st = await (await post(s.base, '/api/voice/print', { on: true })).json();
  assert.equal(st.on, true);
  st = await (await post(s.base, '/api/voice/print', { forget: st.prints[0].id })).json();
  assert.deepEqual([st.on, st.prints.length], [true, 1], 'the print from the corrections stays');
  st = await (await post(s.base, '/api/voice/print', { forget: st.prints[0].id })).json();
  assert.deepEqual([st.on, st.prints], [false, []]);
  l.ws.close();
});

test('an enrolment that is cancelled, or too short when finished early, leaves no print', async t => {
  const s = await boot(t);
  const l = listen(s);
  await l.open;
  l.ws.send(JSON.stringify({ type: 'enrol', seconds: 30 }));
  await l.send(quiet(2500));
  await l.send(mine(2));
  l.ws.send(JSON.stringify({ type: 'enrol-finish' }));
  const err = await l.until(e => e.type === 'enrol' && e.error);
  assert.match(err.error, /at least 20/);
  l.ws.send(JSON.stringify({ type: 'enrol', seconds: 30 }));
  await l.send(mine(1));
  l.ws.send(JSON.stringify({ type: 'enrol-cancel' }));
  await sleep(300);
  assert.equal(l.events.filter(e => e.type === 'enrolled').length, 0);
  const st = await (await fetch(s.base + '/api/voice/print')).json();
  assert.deepEqual(st.prints, []);
  l.ws.close();
});
