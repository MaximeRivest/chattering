'use strict';
// The voice corpus: each utterance's audio and words, kept for training (voice-corpus.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVoiceCorpus } = require('../voice-corpus.js');
const { VoiceWindow, FRAME_BYTES } = require('../voice-window.js');

test('an utterance is kept as a WAV and a sidecar with what is known of it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
  const c = createVoiceCorpus({ dir, now: () => new Date('2026-10-17T14:05:06.789') });
  const pcm = Buffer.alloc(16000 * 2); // one second
  const out = c.record({ pcm, text: 'frog wait', heard: 'frog wait', asrMs: 120, speaker: { mine: 'yes', score: 0.41 }, mode: 'walkie', device: 'app \u00b7 ISOtunes LINK 2.0', mic: 'call \u00b7 ISOtunes LINK 2.0 \u00b7 call microphone', user: 'u1' });
  assert.match(out.wav, /2026\/10\/17\/14-05-06\.789-[0-9a-f]{6}\.wav$/);
  const wav = fs.readFileSync(out.wav);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.length, 44 + pcm.length);
  const meta = JSON.parse(fs.readFileSync(out.json, 'utf8'));
  assert.deepEqual([meta.text, meta.secs, meta.mode, meta.device, meta.speaker.mine, meta.user, meta.source], ['frog wait', 1, 'walkie', 'app \u00b7 ISOtunes LINK 2.0', 'yes', 'u1', 'chattering']);
  assert.equal(meta.heard, undefined, 'the same words are not written twice');
  assert.equal(fs.readdirSync(path.dirname(out.wav)).some(f => f.endsWith('.part')), false, 'written whole');
  assert.equal(c.record({ pcm: Buffer.alloc(100), text: 'x' }), null, 'too short to be worth keeping');
  assert.equal(createVoiceCorpus({ dir: null }).record({ pcm, text: 'x' }), null, 'off without a folder');
});

test('a folder that cannot be written does not stop the voice', () => {
  const logs = [];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-')), 'a-file');
  fs.writeFileSync(file, '');
  const c = createVoiceCorpus({ dir: path.join(file, 'corpus'), log: m => logs.push(m) });
  assert.equal(c.record({ pcm: Buffer.alloc(32000), text: 'hello' }), null);
  assert.equal(c.record({ pcm: Buffer.alloc(32000), text: 'hello' }), null);
  assert.equal(logs.length, 1, 'said once');
});

test('the listener hands each utterance\u2019s audio and words to the corpus, after the voice check', async () => {
  const got = [];
  const frame = amp => { const b = Buffer.alloc(FRAME_BYTES); for (let i = 0; i < FRAME_BYTES / 2; i++) b.writeInt16LE(Math.round(amp * Math.sin(i / 3)), i * 2); return b; };
  const w = new VoiceWindow({ transcribe: async () => 'frog wait', emit: () => {}, check: async () => ({ mine: 'yes', score: 0.4 }), onUtterance: u => got.push(u) });
  for (let i = 0; i < 10; i++) w.feed(frame(3000));
  for (let i = 0; i < 12; i++) w.feed(frame(0));
  await w.idle();
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'frog wait'); assert.equal(got[0].heard, 'frog wait');
  assert.deepEqual(got[0].speaker, { mine: 'yes', score: 0.4 });
  assert.ok(got[0].pcm.length >= FRAME_BYTES * 10, 'the utterance\u2019s audio');
});
