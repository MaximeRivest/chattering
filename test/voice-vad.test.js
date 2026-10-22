'use strict';
// The voice-activity model in JavaScript (voice-vad.js) against the
// training side's reference (test/fixtures/voice-vad/reference.json, written
// by `python -m myvoice.vad.export` in ~/Projects/myvoice: real clips, their
// log-mel features and the NumPy forward pass), its speed, and the listener's
// gate on recorded audio: the wood mill (2026-10-19) and clean speech.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { VoiceVad, DEFAULT_WEIGHTS, FRAME } = require('../voice-vad.js');
const { VoiceWindow, FRAME_BYTES, GATE_ON, GATE_OFF } = require('../voice-window.js');

const REF = path.join(__dirname, 'fixtures', 'voice-vad', 'reference.json');
const ref = fs.existsSync(REF) && fs.existsSync(DEFAULT_WEIGHTS) ? JSON.parse(fs.readFileSync(REF, 'utf8')) : null;
const clipOf = name => { const c = ref.clips.find(c => c.name === name); return { ...c, pcm: Buffer.from(c.pcm, 'base64') }; };

test('the JS front end and network match the training side on real clips', { skip: !ref && 'no reference fixture' }, () => {
  const vad = new VoiceVad(DEFAULT_WEIGHTS);
  for (const c of ref.clips) {
    const pcm = Buffer.from(c.pcm, 'base64');
    let worstF = 0, worstP = 0;
    vad.reset();
    if (c.features) for (let i = 0; (i + 1) * FRAME * 2 <= pcm.length; i++) {
      const mel = vad.features(pcm, i * FRAME * 2);
      const want = c.features[i].flat();
      for (let k = 0; k < mel.length; k++) worstF = Math.max(worstF, Math.abs(mel[k] - want[k]));
    }
    vad.reset();
    for (let i = 0; (i + 1) * FRAME * 2 <= pcm.length; i++) {
      vad.step(pcm, i * FRAME * 2);
      for (let k = 0; k < 3; k++) worstP = Math.max(worstP, Math.abs(vad.probs[k] - c.probs[i][k]));
    }
    assert.ok(worstF < 1e-3, `${c.name}: features differ by ${worstF}`);
    assert.ok(worstP < 2e-3, `${c.name}: probabilities differ by ${worstP}`);
  }
});

test('under 2 ms per 100 ms frame on one core', { skip: !ref && 'no reference fixture' }, () => {
  const vad = new VoiceVad(DEFAULT_WEIGHTS);
  const pcm = clipOf('mill').pcm;
  const frames = Math.floor(pcm.length / (FRAME * 2));
  for (let i = 0; i < frames; i++) vad.step(pcm, i * FRAME * 2); // warm up
  const t0 = process.hrtime.bigint();
  const rounds = 5;
  for (let r = 0; r < rounds; r++) for (let i = 0; i < frames; i++) vad.step(pcm, i * FRAME * 2);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / (frames * rounds);
  assert.ok(ms < 2, 'ms per frame: ' + ms.toFixed(3));
});

// The listener with the model gate on a recorded clip: when did the
// utterance close, relative to the clip's last speech frame (the reference's
// own labels, from Silero VAD).
async function gateOn(clip, { gate } = {}) {
  const events = [];
  const w = new VoiceWindow({ emit: e => events.push(e), transcribe: async () => 'words', gate: gate === undefined ? new VoiceVad(DEFAULT_WEIGHTS) : gate, now: () => 0 });
  const pcm = clip.pcm;
  const speechFrames = [];
  // Feed frame by frame and note which frames the gate took as speech.
  for (let i = 0; (i + 1) * FRAME_BYTES <= pcm.length; i++) {
    const before = w.speechRun;
    w.feed(pcm.subarray(i * FRAME_BYTES, (i + 1) * FRAME_BYTES));
    speechFrames.push(w.silentRun === 0 && (w.speechRun > before || w.speechRun === 1));
    await w.idle();
  }
  await w.close();
  return { events, speechFrames, utterances: events.filter(e => e.type === 'utterance') };
}
const lastTrue = a => a.lastIndexOf(true);

test('the mill: the model gate closes within 1 s of the last word; the energy gate never does', { skip: !ref && 'no reference fixture' }, async () => {
  const clip = clipOf('mill-then-mill-only');
  const truthLast = clip.speech.lastIndexOf(1);
  const model = await gateOn(clip);
  // The gate's speech frames: speech after the last word is the mill.
  const falseAfter = model.speechFrames.slice(truthLast + 1).filter(Boolean).length;
  assert.ok(falseAfter <= 10, `model gate: ${falseAfter} mill frames after the last word taken as speech`);
  assert.ok(lastTrue(model.speechFrames) >= truthLast - 3, 'the model heard the last word');
  const energy = await gateOn(clip, { gate: null });
  const energyAfter = energy.speechFrames.slice(truthLast + 1).filter(Boolean).length;
  assert.ok(energyAfter > 20, `the energy gate stays open on the mill (${energyAfter} frames)`);
});

test('clean speech: the model gate opens on the first words and does not split the utterance', { skip: !ref && 'no reference fixture' }, async () => {
  const clip = clipOf('clean');
  const truthFirst = clip.speech.indexOf(1), truthLast = clip.speech.lastIndexOf(1);
  const r = await gateOn(clip);
  const first = r.speechFrames.indexOf(true);
  assert.ok(first >= 0 && first <= truthFirst + 2, `opened at frame ${first}, the words begin at ${truthFirst}`);
  // No run of 8 silent frames between the first and the last word.
  let silent = 0, split = false;
  for (let i = first; i <= truthLast; i++) { silent = r.speechFrames[i] ? 0 : silent + 1; if (silent >= 8) split = true; }
  assert.ok(!split, 'no 800 ms gap inside the words');
});

test('without weights or when the model throws, the energy gate decides', async () => {
  const events = [];
  const broken = { step() { throw new Error('boom'); } };
  const w = new VoiceWindow({ emit: e => events.push(e), transcribe: async () => '', gate: broken, now: () => 0 });
  const loud = Buffer.alloc(FRAME_BYTES); for (let i = 0; i < FRAME_BYTES / 2; i++) loud.writeInt16LE(Math.round(3000 * Math.sin(i / 3)), i * 2);
  w.feed(loud);
  assert.equal(w.gate, null, 'the broken model is dropped');
  assert.equal(events.filter(e => e.type === 'error').length, 1, 'said once');
  assert.equal(w.speechRun, 1, 'the loud frame was speech by the energy floor');
  assert.ok(GATE_ON > GATE_OFF);
});
