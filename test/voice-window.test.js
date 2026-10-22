'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { VoiceWindow, mapWordIndex, clampWindowSeconds, FRAME_BYTES, BYTES_PER_SECOND } = require('../voice-window.js');

// A fake microphone: each "word" is 400 ms of tone whose loudness names it
// (word k at amplitude 1000·k); a gap is quiet noise. The fake recognizer
// reads the audio back: one word per run of loud frames. So a window that
// lost or duplicated audio shows as lost or duplicated words.
const frame = amp => { const b = Buffer.alloc(FRAME_BYTES); for (let i = 0; i < FRAME_BYTES / 2; i++) b.writeInt16LE(Math.round(amp * Math.sin(i / 3)) + (i % 7) - 3, i * 2); return b; };
const word = k => Buffer.concat(Array.from({ length: 4 }, () => frame(1000 * k)));
const pause = ms => Buffer.concat(Array.from({ length: Math.round(ms / 100) }, () => frame(0)));
function recognize(pcm) {
  const words = [];
  let run = null;
  for (let at = 0; at + FRAME_BYTES <= pcm.length; at += FRAME_BYTES) {
    let peak = 0;
    for (let i = 0; i < FRAME_BYTES / 2; i++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(at + i * 2)));
    const k = Math.round(peak / 1000);
    if (k >= 1) { if (run !== k) words.push('w' + k); run = k; } else run = null;
  }
  return words.join(' ');
}
function listener(opts = {}) {
  const events = [], calls = [];
  const w = new VoiceWindow({ windowSeconds: opts.windowSeconds, emit: e => events.push(e), transcribe: async pcm => { calls.push(pcm.length); return recognize(pcm); } });
  return { w, events, calls, utterances: () => events.filter(e => e.type === 'utterance').map(e => e.text) };
}
const say = async (l, ...parts) => { for (const p of parts) { l.w.feed(p); await l.w.idle(); } };

test('silence alone costs nothing: no rounds, an empty window', async () => {
  const l = listener();
  await say(l, pause(5000));
  assert.equal(l.calls.length, 0);
  assert.equal(l.w.window.length, 0);
});

test('a pause shows the words; a longer one hands on the utterance, once', async () => {
  const l = listener();
  await say(l, pause(1000), word(1), pause(100), word(2), pause(400));
  const heard = l.events.filter(e => e.type === 'heard');
  assert.equal(heard.at(-1).stable + ' ' + heard.at(-1).volatile, ' w1 w2'.replace(/^ /, ' '));
  assert.deepEqual(l.utterances(), []);
  await say(l, pause(600));
  assert.deepEqual(l.utterances(), ['w1 w2']);
  assert.equal(l.calls.length, 1, 'the end of the utterance reuses the pause\u2019s round');
  await say(l, word(3), pause(1200));
  assert.deepEqual(l.utterances(), ['w1 w2', 'w3'], 'the next utterance is only the new words');
  assert.ok(l.calls.at(-1) > word(3).length, 'with the earlier words as context');
});

test('a long quiet after speech is said once, and not for silence alone', async () => {
  const l = listener();
  const quiets = () => l.events.filter(e => e.type === 'quiet').length;
  await say(l, pause(6000));
  assert.equal(quiets(), 0, 'nothing was said: no quiet');
  await say(l, word(1), pause(3000));
  assert.equal(quiets(), 0, 'not yet: three seconds');
  await say(l, pause(1500));
  assert.equal(quiets(), 1, 'four seconds after speech');
  await say(l, pause(8000));
  assert.equal(quiets(), 1, 'once per quiet');
  await say(l, word(2), pause(4500));
  assert.equal(quiets(), 2, 'again after new speech');
});

test('a short word alone is heard (send)', async () => {
  const l = listener();
  await say(l, frame(3000), frame(3000), frame(3000), pause(1000));
  assert.deepEqual(l.utterances(), ['w3']);
});

test('pauses are shortened in the window: its length is speech', async () => {
  const l = listener();
  await say(l, word(1), pause(10000), word(2), pause(900));
  assert.ok(l.w.window.length <= word(1).length * 2 + 8 * FRAME_BYTES, l.w.window.length);
});

test('past its target the window slides: final text, nothing lost or said twice', async () => {
  const l = listener({ windowSeconds: 15 });
  const spoken = [];
  for (let i = 0; i < 40; i++) {
    const k = 1 + (i % 9);
    spoken.push('w' + k);
    await say(l, word(k), pause(i % 3 === 2 ? 900 : 350));
  }
  await say(l, pause(1000));
  assert.ok(l.events.some(e => e.type === 'slide'), 'it slid');
  assert.ok(l.w.window.length <= 15 * 1.2 * BYTES_PER_SECOND + 8 * FRAME_BYTES, 'the window stays near its target');
  assert.ok(l.events.filter(e => e.type === 'slide').every(e => e.committedSeconds >= 5), 'slides in steps, not word by word');
  assert.deepEqual(l.utterances().join(' ').split(' '), spoken, 'every word handed on exactly once, in order');
  const last = l.events.filter(e => e.type === 'heard').at(-1);
  assert.deepEqual((last.committed + ' ' + last.stable + ' ' + last.volatile).trim().split(/\s+/), spoken, 'final + live text is everything said');
});

test('the same commands said again and again, in a long window: each handed on once', async () => {
  // Repeated phrases make many places in the text look alike; the hand-off
  // mark must stay at its own place, not jump to an earlier repeat.
  for (const windowSeconds of [60, 180]) {
    const l = listener({ windowSeconds });
    const spoken = [];
    for (let i = 0; i < 260; i++) {
      const k = 1 + (i % 4);
      spoken.push('w' + k);
      await say(l, word(k), pause(i % 2 === 1 ? 900 : 200));
    }
    await say(l, pause(1000));
    assert.deepEqual(l.utterances().join(' ').split(' '), spoken, `every word handed on exactly once (${windowSeconds} s window)`);
  }
});

test('a word rewritten at the last hand-off is not handed on again', async () => {
  // Like Parakeet with more context (or another language): words already
  // handed on come back different in the next transcription.
  for (const rewrite of [
    words => words.map((w, i) => (i === 2 && words.length > 3 ? 'W3X' : w)),         // the boundary word
    words => words.map((w, i) => (i < 3 && words.length > 4 ? w + 'X' : w)),        // three of them
  ]) {
    const events = [];
    let calls = 0;
    const w = new VoiceWindow({ emit: e => events.push(e), transcribe: async pcm => { calls++; return rewrite(recognize(pcm).split(' ').filter(Boolean)).join(' '); } });
    const l = { w };
    await say(l, word(1), pause(200), word(2), pause(1000), word(3), pause(1000));
    await say(l, word(4), pause(200), word(5), pause(1000), word(6), pause(200), word(7), pause(1000));
    assert.deepEqual(events.filter(e => e.type === 'utterance').map(e => e.text), ['w1 w2', 'w3', 'w4 w5', 'w6 w7']);
    assert.ok(events.some(e => e.type === 'realign'), 'the decided audio was transcribed again to count');
  }
});

test('an index follows a word through a revised transcription', () => {
  const prev = 'please open the sittings now'.split(' ');
  const next = 'please open the settings now and send'.split(' ');
  assert.equal(mapWordIndex(prev, 5, next), 5, 'a revised word keeps its place');
  assert.equal(mapWordIndex('a b c'.split(' '), 3, 'x a b c d'.split(' ')), 4);
  assert.equal(mapWordIndex([], 0, ['a']), 0);
  // Words merged or split at the boundary: the next sentence keeps its first word.
  assert.equal(mapWordIndex('the file called Voice Window JS.'.split(' '), 6, 'the file called voice window.js. What can I say?'.split(' ')), 5);
  assert.equal(mapWordIndex('ask char lie'.split(' '), 3, 'ask charlie to come'.split(' ')), 2);
  assert.equal(mapWordIndex('ask charlie'.split(' '), 2, 'ask char lie to come'.split(' ')), 3);
  assert.equal(mapWordIndex('now send Sender.'.split(' '), 3, 'now send Send. Start dictation.'.split(' ')), 3, 'a word heard longer is not stretched over the next one');
  // Repeats: the mark stays at its own place, not an earlier copy.
  const rep = 'scroll up send scroll up send scroll up send'.split(' ');
  assert.equal(mapWordIndex(rep, 6, rep.concat('open it'.split(' '))), 6);
  assert.deepEqual([clampWindowSeconds(5), clampWindowSeconds('90'), clampWindowSeconds(999), clampWindowSeconds('x')], [15, 90, 180, 60]);
});

// The person's side of the woven timeline (design/102): when their speech
// began and ended, on the wall clock, from the frames themselves; a 'speech'
// event at the first frame; a 'burst' call half a second in with the audio
// so far (the barge-in check).
test('speech onset, burst and utterance times on the wall clock', async () => {
  let clock = 1_000_000;
  const events = [], bursts = [];
  const w = new VoiceWindow({ emit: e => events.push(e), transcribe: async pcm => recognize(pcm), now: () => clock, onBurst: b => bursts.push({ at: b.at, bytes: b.pcm.length, clock }) });
  // Chunks of 200 ms, the clock advancing with them: 1 s of quiet, a 1.2 s
  // word, 1 s of quiet.
  const feed = async pcm => { for (let at = 0; at < pcm.length; at += FRAME_BYTES * 2) { clock += 200; w.feed(pcm.subarray(at, at + FRAME_BYTES * 2)); await w.idle(); } };
  const long = Buffer.concat(Array.from({ length: 12 }, () => frame(2000)));
  await feed(Buffer.concat([pause(1000), long, pause(1000)]));
  const onset = events.find(e => e.type === 'speech');
  assert.ok(onset, 'speech said at its first frame');
  // The word began at 1.0 s: the chunk holding its first frame arrived at 1.2 s, with 100 ms of audio after that frame.
  assert.equal(onset.at, 1_000_000 + 1200 - 100);
  assert.equal(bursts.length, 1, 'one burst for 1.2 s of speech (the 1.5 s and 3 s stages not reached)');
  assert.equal(bursts[0].at, onset.at);
  assert.ok(bursts[0].bytes >= FRAME_BYTES * 5 && bursts[0].bytes <= FRAME_BYTES * 6, 'the audio so far, ~0.5 s: ' + bursts[0].bytes / FRAME_BYTES);
  assert.equal(bursts[0].clock, 1_000_000 + 1600, 'said half a second in');
  const u = events.find(e => e.type === 'utterance');
  assert.ok(u, 'the utterance closed');
  assert.equal(u.startedAt, onset.at);
  assert.equal(u.endedAt, 1_000_000 + 2200, 'its last speech frame, at 2.2 s');
  // A second utterance: its own onset and burst.
  await feed(Buffer.concat([long, pause(1000)]));
  assert.equal(events.filter(e => e.type === 'speech').length, 2);
  assert.equal(bursts.length, 2);
  // Four seconds of speech in a row: bursts at 0.5, 1.5 and 3 s.
  await feed(Buffer.concat([Buffer.concat(Array.from({ length: 40 }, () => frame(2000))), pause(1000)]));
  assert.equal(bursts.length, 5);
  const u2 = events.filter(e => e.type === 'utterance')[1];
  assert.ok(u2.startedAt > u.endedAt, 'the second began after the first ended');
});


// A machine in the room (a wood mill, 2026-10-19): noise between 300 and
// 4000 with dips to 20 holds the gate open (an energy gate cannot tell its
// bursts from a voice; a 43 s utterance was seen). The cap closes the
// utterance at the next short pause after 15 s, and the server closes it at
// once on a hand-over or a command in the live words (closeUtterance).
test('the gate stuck on for 15 s closes the utterance at the next short pause; closeUtterance() does it at once', async () => {
  const l = listener();
  // Loud "speech" with no dip for 16 s, then a short pause.
  const run = Buffer.concat(Array.from({ length: 160 }, (_, i) => frame(1000 + (i % 3))));
  await say(l, pause(1000), run, pause(400));
  assert.equal(l.utterances().length, 1, 'closed by the limit: ' + JSON.stringify(l.utterances()));
  // closeUtterance: the words so far are handed on without the long pause.
  await say(l, pause(1000), word(5), pause(400));
  assert.equal(l.utterances().length, 1);
  assert.equal(l.w.closeUtterance(), true);
  await l.w.idle();
  assert.equal(l.utterances().length, 2);
  assert.match(l.utterances()[1], /w5/);
  assert.equal(l.w.closeUtterance(), false, 'nothing pending');
});
