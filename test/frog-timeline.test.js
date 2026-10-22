'use strict';
// The woven timeline (frog-timeline.js): sentences placed on this
// computer's clock from the page's play/pause reports, the person's words
// placed among them, where to resume after a barge-in, and the note.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTimeline, sentencesOf, createClocks } = require('../frog-timeline.js');

const runs = [{ text: 'Two things. First, the run finished.', startMs: 0, endMs: 4000 }, { text: 'Second, the paper one waits for you to pick a title.', startMs: 4600, endMs: 9000 }];

test('sentences are placed inside their runs by length', () => {
  const s = sentencesOf(runs);
  assert.deepEqual(s.map(x => x.text), ['Two things.', 'First, the run finished.', 'Second, the paper one waits for you to pick a title.']);
  assert.equal(s[0].startMs, 0);
  assert.ok(s[0].endMs > 1000 && s[0].endMs < 1600, 'short sentence, short share: ' + s[0].endMs);
  assert.equal(s[1].endMs, 4000);
  assert.deepEqual([s[2].startMs, s[2].endMs], [4600, 9000]);
});

test('a page clock is placed on ours by its fastest message', () => {
  const c = createClocks();
  assert.equal(c.wall('p1', 1000, 1300), 1300);        // first: as received
  assert.equal(c.wall('p1', 2000, 2250), 2250);        // faster trip: the offset shrinks
  assert.equal(c.wall('p1', 3000, 3900), 3250);        // a slow trip does not move it
  assert.equal(c.wall(null, 3000, 3900), 3900);        // no page id: as received
});

test('the weave: heard, cut, unsaid, and the words over it', () => {
  let t = 100000;
  const now = () => t;
  const tl = createTimeline({ now });
  tl.addClip('j1', 'c1', sentencesOf(runs), { device: 'phone call' });
  // Plays from the start at wall 100000 (the page's clock runs 50 ms behind, trip 20 ms).
  tl.playback({ job: 'j1', clip: 'c1', state: 'play', ms: 0, t: 99930, page: 'pg', received: 100000, rate: 1 });
  t = 105200; // 5.2 s in: inside the third sentence
  assert.deepEqual(tl.speakingAt(t) && [tl.speakingAt(t).clip, tl.speakingAt(t).sentence.index], ['c1', 2]);
  // The person begins at 5.0 s; the page pauses at 5.3 s (it heard of it then), stepping back.
  tl.onset({ at: 105000, device: 'phone call' });
  const back = tl.resumeFor('j1', 'c1', 105000);
  assert.equal(back, 4500, 'began just after the sentence started: resume at its start (minus a beat)');
  t = 105300;
  tl.playback({ job: 'j1', clip: 'c1', state: 'pause', ms: 4500, t: 105230, page: 'pg', received: 105300, by: 'barge' });
  assert.equal(tl.speakingAt(105400), null, 'paused: not speaking');
  const said = tl.heard({ start: 105000, end: 106100, text: 'wait, which run?', device: 'phone call', speaker: { mine: 'yes', score: 0.6 } });
  tl.acted(said.start, 'sent as a new message');
  const w = tl.weave('j1');
  assert.deepEqual(w.sentences.map(s => s.status), ['heard', 'heard', 'partial']);
  assert.equal(w.sentences[0].start, 100000);
  assert.ok(Math.abs(w.sentences[1].end - 104000) < 2, 'the second ended at 4.0 s on our clock');
  assert.equal(w.person[0].acted, 'sent as a new message');
  const note = tl.note('j1');
  assert.match(note, /0\.0–1\.\d  you said: Two things\./);
  assert.match(note, /4\.6–5\.3  you said, cut off: "Second," of "Second, the paper one waits/, 'cut 0.7 s into a 4.4 s sentence: about its first word');
  assert.match(note, /5\.0–6\.1  they said: wait, which run\? \(sent as a new message\)/);
  assert.doesNotMatch(note, /not said:/, 'nothing left wholly unsaid in this clip');
  assert.match(note, /continue from the cut sentence/);
});

test('resume a little before the word they cut into, deep in a sentence', () => {
  const tl = createTimeline({ now: () => 0 });
  tl.addClip('j', 'c', [{ text: 'A long sentence that goes on for a while and more.', startMs: 0, endMs: 6000 }]);
  tl.playback({ job: 'j', clip: 'c', state: 'play', ms: 0, received: 1000, rate: 1 });
  assert.equal(tl.resumeFor('j', 'c', 5000), 3600, '4.0 s in, minus 400 ms');
  // At 1.5× the clip moves faster than the wall.
  const tl2 = createTimeline({ now: () => 0 });
  tl2.addClip('j', 'c', [{ text: 'A long sentence that goes on for a while and more.', startMs: 0, endMs: 6000 }]);
  tl2.playback({ job: 'j', clip: 'c', state: 'play', ms: 0, received: 1000, rate: 1.5 });
  assert.equal(tl2.resumeFor('j', 'c', 3000), 2600, '3.0 s in at 1.5×, minus 400 ms');
});

test('heard whole, stopped on purpose, unsent pieces, many sentences folded', () => {
  let t = 0;
  const tl = createTimeline({ now: () => t });
  const many = Array.from({ length: 9 }, (_, i) => ({ text: 'Sentence number ' + (i + 1) + '.', startMs: i * 1000, endMs: i * 1000 + 900 }));
  tl.addClip('j', 'c1', many, { device: 'laptop' });
  tl.playback({ job: 'j', clip: 'c1', state: 'play', ms: 0, received: 10000 });
  t = 19000;
  tl.playback({ job: 'j', clip: 'c1', state: 'ended', ms: 9000, received: 19000 });
  assert.equal(tl.note('j'), '', 'heard whole and nothing said over it: no note');
  // Said during it, resumed after: still a note, with the words.
  const s = tl.heard({ start: 12000, end: 12400, text: 'mm-hmm', speaker: { mine: 'yes', score: 0.5 } });
  tl.acted(s.start, 'a reaction; you went on');
  let note = tl.note('j');
  assert.match(note, /you said 5 more sentences, heard whole/);
  assert.match(note, /2\.0–2\.4  they said: mm-hmm \(a reaction; you went on\)/);
  assert.match(note, /They heard it all/);
  // A second clip never sent, and a stop.
  tl.addClip('j', 'c2', [{ text: 'The end.', startMs: 0, endMs: 800 }]);
  tl.cancelled('j', { unsaid: ['Never made.'] });
  tl.playback({ job: 'j', clip: 'c2', state: 'stopped', ms: 0, received: 19500, by: 'voice' });
  note = tl.note('j');
  assert.match(note, /not said: The end\. Never made\./);
  assert.match(note, /stopped it on purpose/);
});

test('words outside a turn are kept loose; a new turn closes the weave', () => {
  let t = 0;
  const tl = createTimeline({ now: () => t });
  const e = tl.heard({ start: 500, end: 900, text: 'hello' });
  assert.equal(tl.weave('j'), null);
  tl.addClip('j', 'c', [{ text: 'Hi.', startMs: 0, endMs: 500 }]);
  tl.playback({ job: 'j', clip: 'c', state: 'play', ms: 0, received: 1000 });
  t = 3000;
  tl.newTurn('j');
  t = 4000;
  tl.heard({ start: 3500, end: 3900, text: 'after' });
  assert.equal(tl.weave('j').person.length, 0, 'said after the new turn: not this weave');
  assert.equal(tl.acted(e.start, 'x').text, 'hello');
});
