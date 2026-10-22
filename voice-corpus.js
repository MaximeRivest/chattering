'use strict';
// The voice corpus (design/102): every utterance the person says to
// Chattering by voice, its audio and its transcript, from any device and any
// microphone, kept to train a small speech model of their own voice later
// (~/Projects/myvoice). The person asked for it, and for a diverse set: the
// phone's microphone, headsets, the laptop's.
//
// One WAV (16 kHz mono, as the listener heard it: pauses inside an utterance
// shortened to ~0.4 s) and one JSON sidecar per utterance, in
// <dir>/YYYY/MM/DD/<time>-<id>.wav|.json:
//   text        what was handed on (after the voice check's own cut, if any)
//   heard       the listener's text for the whole audio, when it differs
//   asrMs       how long the transcription took
//   engine      which speech engine wrote `text` (speech-engines.js):
//               "parakeet", "myvoice", or "parakeet (my voice failed: …)"
//               when the chosen engine fell back. A training set must know:
//               "myvoice" text is the student's own output, not a teacher's.
//   speaker     the voice check's verdict: mine yes/no/unsure, score, bar
//   mode        what the page was doing: walkie (talking with the frog),
//               command, dictation, enrol (recording a voice print)
//   device      the page's own words ("app · ISOtunes LINK 2.0", "computer")
//   mic         what the page knows of the microphone (route, source)
//   user        whose voice (only the install's owner is recorded)
// Other voices that reached the microphone are kept, marked by `speaker`,
// so a training set can leave them out.
// Files are written whole (a .part then a rename) and never changed after.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RATE = 16000;

function wavOf(pcm, rate = RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const pad = n => String(n).padStart(2, '0');

function writeWhole(file, data, mode = 0o600) {
  const part = file + '.part';
  fs.writeFileSync(part, data, { mode });
  fs.renameSync(part, file);
}

/**
 * A recorder writing under `dir`. record({ pcm, text, ... }) → the paths
 * written, or null (too short, or no folder). Never throws: a failure to
 * record is logged and the voice goes on.
 */
function createVoiceCorpus({ dir, now = () => new Date(), log = () => {}, minBytes = RATE * 2 * 0.25 } = {}) {
  let warned = false;
  function record({ pcm, text, heard = null, asrMs = null, engine = null, speaker = null, mode = null, device = null, mic = null, user = null, at = null }) {
    if (!dir || !pcm || pcm.length < minBytes) return null;
    try {
      const t = at ? new Date(at) : now();
      const day = path.join(dir, String(t.getFullYear()), pad(t.getMonth() + 1), pad(t.getDate()));
      fs.mkdirSync(day, { recursive: true, mode: 0o700 });
      const stem = pad(t.getHours()) + '-' + pad(t.getMinutes()) + '-' + pad(t.getSeconds()) + '.' + String(t.getMilliseconds()).padStart(3, '0') + '-' + crypto.randomBytes(3).toString('hex');
      const wav = path.join(day, stem + '.wav'), json = path.join(day, stem + '.json');
      writeWhole(wav, wavOf(pcm));
      const meta = {
        v: 1, at: t.toISOString(), secs: Math.round(pcm.length / 2 / RATE * 100) / 100, rate: RATE,
        text: String(text || ''), ...(heard && heard !== text ? { heard: String(heard) } : {}),
        ...(asrMs != null ? { asrMs } : {}), ...(engine ? { engine: String(engine).slice(0, 120) } : {}), ...(speaker ? { speaker } : {}),
        ...(mode ? { mode: String(mode).slice(0, 20) } : {}), ...(device ? { device: String(device).slice(0, 120) } : {}),
        ...(mic ? { mic: String(mic).slice(0, 120) } : {}), ...(user ? { user: String(user) } : {}),
        source: 'chattering',
      };
      writeWhole(json, JSON.stringify(meta, null, 1) + '\n');
      return { wav, json };
    } catch (e) {
      if (!warned) { warned = true; log('[voice corpus] not recorded: ' + e.message); }
      return null;
    }
  }
  return { record, dir };
}

module.exports = { createVoiceCorpus, wavOf };
