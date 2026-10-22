'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const S = require('../voice-speaker.js');
const { VoiceWindow, FRAME_BYTES, BYTES_PER_SECOND } = require('../voice-window.js');

const wins = scores => scores.map((score, i) => ({ start: i * 0.5, end: i * 0.5 + 1, score }));

test('a long utterance needs the strict bar; a little under it is unsure', () => {
  assert.equal(S.decide({ score: 0.5, secs: 4 }).mine, 'yes');
  assert.equal(S.decide({ score: 0.28, secs: 4 }).mine, 'unsure');
  assert.equal(S.decide({ score: 0.1, secs: 4 }).mine, 'no');
});

test('a short utterance gets a lower bar; a short control phrase lower still right after one of mine; short is never "unsure"', () => {
  // "okay, over": 0.25 fails the strict bar but passes the short one
  assert.equal(S.decide({ score: 0.25, secs: 0.9, control: true }).mine, 'yes');
  // 0.15 fails alone (no unsure for short words), passes 2 s after my own sentence when it is a control phrase
  assert.equal(S.decide({ score: 0.15, secs: 0.9, sinceMineMs: 60000, control: true }).mine, 'no');
  assert.equal(S.decide({ score: 0.15, secs: 0.9, sinceMineMs: 2000, control: true }).mine, 'yes');
  // "Monday" from another voice right after my sentence: no benefit of the doubt for a word that is not a control phrase
  assert.equal(S.decide({ score: 0.15, secs: 0.8, sinceMineMs: 2000, control: false }).mine, 'no');
  assert.equal(S.decide({ score: 0.25, secs: 0.8, sinceMineMs: 2000, control: false }).mine, 'yes');
  // another voice's short control word is still another voice
  assert.equal(S.decide({ score: 0.02, secs: 0.9, sinceMineMs: 2000, control: true }).mine, 'no');
});

test('control phrases: hand-overs, the frog addressed, yes and no; not ordinary words', () => {
  for (const t of ['over', 'Okay, over.', 'Monday, over', 'over to you', 'frog, wait', 'hold on, frog', 'hey frog stop', 'yes', 'No.', 'that\'s all', 'go ahead frog'])
    assert.equal(S.isControl(t), true, t);
  for (const t of ['Monday', 'the overview is ready', 'tomorrow at ten', 'and then', ''])
    assert.equal(S.isControl(t), false, t);
});

test('two voices in turn: cut to my pieces, padded and merged', () => {
  const d = S.decide({ score: 0.39, secs: 5.6, windows: wins([0.72, 0.6, 0.65, 0.76, 0.69, 0.1, 0.01, -0.01, 0.0, 0.09, 0.1]) });
  assert.equal(d.mine, 'yes');
  assert.equal(d.mixed, true);
  assert.deepEqual(d.keep, [[0, 3.25]]);           // pieces 0–4 (0 → 3 s), padded by 0.25 at the end only
  assert.equal(d.dropped, 2.35);
  // the other way round: my part at the end
  const e = S.decide({ score: 0.39, secs: 5.6, windows: wins([0.05, 0.0, 0.08, 0.02, 0.1, 0.5, 0.7, 0.66, 0.72, 0.6, 0.55]) });
  assert.deepEqual(e.keep, [[2.25, 5.6]]);
});

test('pieces that agree leave the whole-utterance verdict alone', () => {
  assert.equal(S.decide({ score: 0.6, secs: 4, windows: wins([0.6, 0.5, 0.7, 0.55, 0.6, 0.65, 0.7]) }).mixed, undefined);
  // one doubtful piece at the edge of my own sentence is not another voice: no cut
  const d = S.decide({ score: 0.78, secs: 4.9, windows: wins([0.7, 0.6, 0.65, 0.7, 0.6, 0.55, 0.5, 0.15, 0.1]) });
  assert.equal(d.mixed, undefined);
  assert.equal(d.mine, 'yes');
  // nearly all pieces another voice, whole score low: no
  assert.equal(S.decide({ score: 0.1, secs: 4, windows: wins([0.05, 0.0, 0.1, 0.02, 0.0, 0.3, 0.05]) }).mine, 'no');
});

test('slicePcm keeps the spans, on sample boundaries', () => {
  const pcm = Buffer.alloc(BYTES_PER_SECOND * 3);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.floor(i / BYTES_PER_SECOND) + 1, i); // second k holds value k+1
  const out = S.slicePcm(pcm, [[0, 1], [2, 3]]);
  assert.equal(out.length, BYTES_PER_SECOND * 2);
  assert.equal(out.readInt16LE(0), 1);
  assert.equal(out.readInt16LE(BYTES_PER_SECOND), 3);
});

test('a print is the mean of the pieces, with their agreement; the store keeps at most four, and shows no embeddings', () => {
  const e = (a, b) => { const v = new Array(S.DIM).fill(0); v[0] = a; v[1] = b; return v; };
  const p = S.buildPrint({ embedding: e(1, 0), windows: [e(1, 0), e(0.8, 0.6), e(0.6, 0.8)], secs: 61.4 }, { label: 'laptop', at: 1000 });
  assert.equal(p.embedding.length, S.DIM);
  assert.ok(Math.abs(Math.hypot(...p.embedding) - 1) < 1e-4);
  assert.ok(p.consistency > 0.9 && p.consistency < 1);
  assert.equal(p.secs, 61);
  let entry = S.entryFor({}, 'u1');
  assert.equal(entry.on, false);
  for (let i = 0; i < 5; i++) entry = S.addPrint(entry, { ...p, id: 'p' + i });
  assert.equal(entry.prints.length, 4);
  assert.deepEqual(entry.prints.map(x => x.id), ['p1', 'p2', 'p3', 'p4']);
  assert.equal(entry.on, true);
  const pub = S.publicEntry(entry);
  assert.equal(pub.prints[0].embedding, undefined);
  assert.equal(pub.prints[0].label, 'laptop');
  entry = S.forgetPrint(S.forgetPrint(S.forgetPrint(S.forgetPrint(entry, 'p1'), 'p2'), 'p3'), 'p4');
  assert.equal(entry.on, false);
  // header: float32 little-endian, prints × DIM
  const h = Buffer.from(S.printsHeader([p, p]), 'base64');
  assert.equal(h.length, 2 * S.DIM * 4);
  assert.ok(Math.abs(h.readFloatLE(0) - p.embedding[0]) < 1e-5);
  // store round trip, private file
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-'));
  const file = path.join(dir, 'voice-prints.json');
  S.saveStore(file, { u1: S.addPrint(S.entryFor({}, 'u1'), p) });
  assert.equal(S.loadStore(file).u1.prints[0].id, p.id);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A fake voice-print service: the score is the audio's first sample / 1000
// (so a test names the score it wants), pieces every 0.5 s score from the
// sample at their start.
function fakeService() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const pcm = Buffer.concat(chunks);
        const secs = pcm.length / BYTES_PER_SECOND;
        const at = s => pcm.readInt16LE(Math.min(pcm.length - 2, Math.floor(s * BYTES_PER_SECOND) & ~1)) / 1000;
        if (req.url.startsWith('/embed')) {
          const v = new Array(S.DIM).fill(0); v[0] = 1;
          return res.end(JSON.stringify({ secs, embedding: v, windows: [v, v, v], ms: 1 }));
        }
        if (!req.headers['x-voice-prints']) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'no prints' })); }
        const windows = [];
        if (secs > 1.5) for (let s = 0; s + 1 <= secs; s += 0.5) windows.push({ start: s, end: s + 1, score: at(s) });
        res.end(JSON.stringify({ secs, score: at(0), windows, ms: 1 }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + srv.address().port, close: () => srv.close() }));
  });
}
const audio = (secs, score, scoreFrom = null) => {
  // sample value = score × 1000 everywhere, or scoreFrom.at seconds on
  const b = Buffer.alloc(Math.round(secs * BYTES_PER_SECOND) & ~1);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(Math.round((scoreFrom && i / BYTES_PER_SECOND >= scoreFrom.at ? scoreFrom.score : score) * 1000), i);
  return b;
};
const print = () => { const v = new Array(S.DIM).fill(0); v[0] = 1; return { id: 'p', label: '', at: 0, secs: 60, consistency: 0.9, embedding: v }; };

test('the check: mine / not mine / unsure, the context after my own turn, and a two-voice cut re-transcribed', async () => {
  const svc = await fakeService();
  try {
    let clock = 0;
    const transcribed = [];
    const chk = S.makeCheck({ url: svc.url, prints: [print()], transcribe: async pcm => { transcribed.push(pcm.length); return 'my part'; }, now: () => clock });
    assert.equal((await chk(audio(3, 0.6), 'hello there')).mine, 'yes');          // sets lastMineAt = 0
    clock = 2000;
    const over = await chk(audio(0.8, 0.15), 'over');                             // short control phrase, soon after mine: the doubt bar
    assert.equal(over.mine, 'yes');
    clock = 2000;
    assert.equal((await chk(audio(0.8, 0.15), 'Monday')).mine, 'no');             // the same score, a plain word: no
    clock = 20000;
    assert.equal((await chk(audio(0.8, 0.15), 'over')).mine, 'no');               // long after: no
    assert.equal((await chk(audio(0.8, 0.10), 'over')).mine, 'no');
    assert.equal((await chk(audio(3, 0.28), 'maybe')).mine, 'unsure');
    assert.equal((await chk(audio(3, 0.02), 'someone else')).mine, 'no');
    const mixed = await chk(audio(6, 0.7, { at: 3, score: 0.02 }), 'my part their part');
    assert.equal(mixed.mixed, true);
    assert.equal(mixed.text, 'my part');
    assert.deepEqual(mixed.keep, [[0, 3.75]]); // the piece starting at 2.5 s still reads as mine in the fake
    assert.equal(transcribed.length, 1);
    assert.ok(Math.abs(transcribed[0] - 3.75 * BYTES_PER_SECOND) <= 2);
  } finally { svc.close(); }
});

test('every verdict is recorded, one line each, in a private file', async () => {
  const svc = await fakeService();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-'));
  const file = path.join(dir, 'voice-speaker.jsonl');
  try {
    const chk = S.makeCheck({ url: svc.url, prints: [print()], transcribe: async () => '', record: S.makeRecorder(file) });
    await chk(audio(3, 0.6), 'hello there');
    await chk(audio(0.8, 0.05), 'Monday');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(lines.map(l => [l.text, l.mine, l.score, l.control]), [['hello there', 'yes', 0.6, false], ['Monday', 'no', 0.05, false]]);
    assert.ok(lines[0].ts && lines[0].bar === S.THRESHOLDS.strict);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { svc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('with the service down the utterance counts as mine, marked', async () => {
  const chk = S.makeCheck({ url: 'http://127.0.0.1:9', prints: [print()], transcribe: async () => '' });
  const r = await chk(audio(2, 0.5), 'hi');
  assert.equal(r.mine, 'yes');
  assert.ok(r.error);
});

test('the window hands the utterance audio to the check and carries its answer; a replaced text goes out instead', async () => {
  const events = [];
  const seen = [];
  const frame = amp => { const b = Buffer.alloc(FRAME_BYTES); for (let i = 0; i < FRAME_BYTES / 2; i++) b.writeInt16LE(Math.round(amp * Math.sin(i / 3)), i * 2); return b; };
  const speech = n => Buffer.concat(Array.from({ length: n }, () => frame(3000)));
  const quiet = n => Buffer.concat(Array.from({ length: n }, () => frame(0)));
  // the fake recognizer: one word per two loud frames, so the text grows with the speech
  const loud = pcm => { let n = 0; for (let at = 0; at + FRAME_BYTES <= pcm.length; at += FRAME_BYTES) if (Math.abs(pcm.readInt16LE(at + 2)) > 500) n++; return n; };
  const transcribe = async pcm => Array.from({ length: Math.floor(loud(pcm) / 2) }, (_, i) => 'w' + i).join(' ');
  let replace = 'one two';
  const w = new VoiceWindow({ emit: e => events.push(e), transcribe, check: async (pcm, text) => { seen.push({ bytes: pcm.length, text }); return { mine: 'yes', score: 0.5, text: replace }; } });
  w.feed(quiet(10)); w.feed(speech(8)); w.feed(quiet(12)); await w.idle();
  const utt = events.filter(e => e.type === 'utterance');
  assert.equal(utt.length, 1);
  assert.equal(utt[0].text, 'one two');
  assert.deepEqual(utt[0].speaker, { mine: 'yes', score: 0.5 });
  assert.equal(seen[0].text, 'w0 w1 w2 w3');
  // the audio handed over is the speech plus the little kept of the pause, never the whole quiet
  assert.ok(seen[0].bytes >= 8 * FRAME_BYTES && seen[0].bytes <= 14 * FRAME_BYTES, String(seen[0].bytes));
  // a second utterance gets only its own audio, and its own words
  replace = '';
  w.feed(speech(6)); w.feed(quiet(12)); await w.idle();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].text, 'w4 w5 w6');
  assert.ok(seen[1].bytes >= 6 * FRAME_BYTES && seen[1].bytes <= 12 * FRAME_BYTES, String(seen[1].bytes));
  assert.equal(events.filter(e => e.type === 'utterance')[1].text, 'w4 w5 w6'); // an empty replacement keeps the words
});

test('an enrolment collects speech frames until it has enough, then builds the print', async () => {
  const svc = await fakeService();
  try {
    const progress = [];
    const en = S.makeEnrolment({ url: svc.url, seconds: 20, label: 'phone', onProgress: (s, want) => progress.push([s, want]) });
    for (let i = 0; i < 21; i++) en.feed(Buffer.alloc(BYTES_PER_SECOND));
    const p = await en.done;
    assert.equal(p.label, 'phone');
    assert.equal(p.secs, 20);
    assert.equal(p.embedding.length, S.DIM);
    assert.deepEqual(progress[progress.length - 1], [20, 20]);
    const short = S.makeEnrolment({ url: svc.url, seconds: 20 });
    short.feed(Buffer.alloc(BYTES_PER_SECOND * 5));
    short.finish();
    await assert.rejects(short.done, /only 5 s/);
  } finally { svc.close(); }
});
