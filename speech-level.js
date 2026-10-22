'use strict';
// How loud read-aloud speech is (design/102: "the frog is quieter than
// things I listen to through the speaker").
//
// Kokoro's clips come out quiet and very even: speech at about -23.5 dBFS
// RMS, peaks near -8 dBFS (measured on the day's clips, within half a dB of
// each other). Spoken audio meant for phones sits near -16. So every clip
// gets the same fixed lift, GAIN_DB, and a look-ahead peak limiter keeps it
// under CEILING: the loud syllable is turned down a few milliseconds before
// it arrives and let back up over RELEASE_MS, so nothing clips and the
// level stays the same from one piece to the next (a per-clip
// normalisation would make pieces of one answer differ).
// Pure: 16-bit little-endian mono PCM in, the same out.

const GAIN_DB = 7;
const CEILING = 0.89;        // -1 dBFS
const LOOKAHEAD_MS = 3;
const RELEASE_MS = 60;

function louder(pcm, rate = 24000, { gainDb = GAIN_DB, ceiling = CEILING } = {}) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return Buffer.from(pcm);
  const gain = Math.pow(10, gainDb / 20);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = pcm.readInt16LE(i * 2) / 32768 * gain;
  // The gain each sample needs to stay under the ceiling, the minimum over
  // the look-ahead ahead of it, then released slowly.
  const ahead = Math.max(1, Math.round(rate * LOOKAHEAD_MS / 1000));
  const release = Math.exp(-1 / (rate * RELEASE_MS / 1000));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) { const a = Math.abs(x[i]); need[i] = a > ceiling ? ceiling / a : 1; }
  // Minimum over [i, i + ahead]: a sliding minimum (monotonic deque).
  const minAhead = new Float32Array(n);
  const q = new Int32Array(n); let h = 0, t = 0;
  for (let j = 0; j < n + ahead; j++) {
    if (j < n) { while (t > h && need[q[t - 1]] >= need[j]) t--; q[t++] = j; }
    const i = j - ahead;
    if (i < 0) continue;
    while (q[h] < i) h++;
    minAhead[i] = need[q[h]];
  }
  const out = Buffer.alloc(n * 2);
  let g = 1;
  for (let i = 0; i < n; i++) {
    const target = minAhead[i];
    g = target < g ? target : target - (target - g) * release;
    const y = Math.max(-1, Math.min(1, x[i] * g));
    out.writeInt16LE(Math.round(y * 32767), i * 2);
  }
  return out;
}

module.exports = { louder, GAIN_DB, CEILING };
