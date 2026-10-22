'use strict';
// Read-aloud speech at a phone's loudness (speech-level.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { louder, GAIN_DB, CEILING } = require('../speech-level.js');

const pcmOf = f => { const n = 24000, b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(f(i) * 32767), i * 2); return b; };
const peak = b => { let p = 0; for (let i = 0; i < b.length; i += 2) p = Math.max(p, Math.abs(b.readInt16LE(i)) / 32767); return p; };
const rms = b => { let s = 0; for (let i = 0; i < b.length; i += 2) { const v = b.readInt16LE(i) / 32767; s += v * v; } return Math.sqrt(s / (b.length / 2)); };

test('quiet speech is lifted by the fixed gain, unchanged otherwise', () => {
  const quiet = pcmOf(i => 0.05 * Math.sin(i / 7));
  const out = louder(quiet);
  assert.equal(out.length, quiet.length);
  const db = 20 * Math.log10(rms(out) / rms(quiet));
  assert.ok(Math.abs(db - GAIN_DB) < 0.1, db);
});

test('a loud peak is held under the ceiling, never clipped', () => {
  const loud = pcmOf(i => (i > 12000 && i < 12200 ? 0.9 : 0.1) * Math.sin(i / 5));
  const out = louder(loud);
  assert.ok(peak(out) <= CEILING + 0.002, peak(out));
  // Away from the peak (after the release), the gain is back.
  let s = 0; for (let i = 20000; i < 24000; i++) s = Math.max(s, Math.abs(out.readInt16LE(i * 2)) / 32767);
  assert.ok(s > 0.1 * Math.pow(10, GAIN_DB / 20) * 0.95, s);
});

test('empty in, empty out', () => assert.equal(louder(Buffer.alloc(0)).length, 0));
