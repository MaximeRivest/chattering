'use strict';
// Only my voice (design/102): is the utterance the person's? Each utterance
// the listening window closes is compared with the person's voice print
// (enrolled once, from about a minute of their speech on the device they
// talk from) through the voice-print service (speaker/speaker_service.py,
// TitaNet-large), and comes out as mine / not mine / unsure. Another voice's
// utterance is not acted on (the page shows it greyed, one tap to use it).
//
// Rules, from the measurements on real meeting speech (AMI test set, 16
// speakers, headset microphone; scratch/frog-voice-research/bench_policy.py):
// - one bar for all would reject half of the person's short turns ("okay",
//   "over"), so a short utterance gets a lower bar; a short *control* phrase
//   (a hand-over, "frog, wait", yes / no) lower still right after one of the
//   person's own turns (the "over" after their sentence). Only control
//   phrases get that: missing one costs a turn, while another voice's short
//   word in the message costs a word — and that word got through on the
//   first real call ("Monday", 2026-10-17), with a doubt bar that let a
//   quarter of other voices' short words in. Short words that are not
//   control phrases are never "unsure, sent": under the bar is not mine;
// - an utterance holding two voices in turn (no pause long enough to close
//   it) often passes as a whole: its 1 s pieces are checked, and when they
//   disagree the audio is cut to the person's pieces and transcribed again;
// - the print never drifts toward what was accepted: with another voice close
//   to the microphone that let it in within minutes. Re-enrol instead.
// The service is stateless: the prints go with every request, Chattering
// keeps them (voice-prints.json in the data folder, one entry per person).
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const frogLib = require('./frog-assistant.js');

const DIM = 192;
const RATE = 16000, BYTES_PER_SECOND = RATE * 2;
// Cosine bars for TitaNet-large, from the AMI distributions: others pass
// 1% / 10% / 25% of the time. Unsure: a little under the bar that applied.
const THRESHOLDS = { strict: 0.32, lenient: 0.20, doubt: 0.13, unsureBand: 0.06 };
const SHORT_SECS = 1.2;        // "okay", "over", "yeah"
const CONTEXT_MS = 4000;       // a short utterance this soon after one of mine gets the benefit of the doubt
const MIXED_MIN_SECS = 2.5;    // below this, pieces are too few to tell two voices apart
const MIXED_BAND = [0.15, 0.85]; // share of pieces that are mine: between these, the utterance holds two voices
const PIECE_PAD_SECS = 0.25;   // kept audio is padded this much (cut tight, the recognizer loses the edge word)
const MIN_DROP_SECS = 0.75;    // a cut must drop at least this much: one doubtful piece of my own speech is not another voice
const ENROL_MIN_SECS = 20, ENROL_TARGET_SECS = 60, MAX_PRINTS = 4;
// Short phrases that steer the talk rather than fill the message: a
// hand-over (frog-assistant's HAND_OVER), the frog addressed ("frog, wait",
// "hold on frog"), a yes or no.
const FROG_ADDRESSED = /(?:^\W*(?:hey\s+|okay\s+|ok\s+)?frog\b|\bfrog\W*$)/i;
// A yes or no, and the frog's playback words said plain (design/102:
// "pause" alone was dropped as another voice): stop, pause, wait, go on,
// next sentence, the sentence before, say that again.
const YES_NO = /^\W*(?:(?:hey\s+|okay\s+|ok\s+)?frog\W+)?(?:yes|yeah|yep|no|nope|okay|ok|stop|wait|pause|hold on|hang on|go on|continue|resume|keep going|next|skip|next sentence|previous sentence|go back|back up|repeat|again|say that again|what)(?:\W+(?:please|frog))?\W*$/i;
function isControl(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return !!(frogLib.stripHandOver(t).phrase || FROG_ADDRESSED.test(t) || YES_NO.test(t));
}

/**
 * The rule. `windows`: [{start, end, score}] of the utterance's 1 s pieces
 * (empty for short audio). Returns {mine: 'yes'|'no'|'unsure', bar, ...}
 * and, for a two-voice utterance, keep: [[startSec, endSec], …] of the
 * person's parts (then the caller transcribes just those).
 */
function decide({ score, secs, sinceMineMs = Infinity, windows = [], control = false }, th = THRESHOLDS) {
  const short = secs <= SHORT_SECS;
  // A control phrase faces the lenient bar whatever its length: outside
  // with a machine running, "over to you" came padded with noise to 1.8 s,
  // met the strict bar and was dropped three times (2026-10-19). What a
  // wrong pass costs is one hand-over.
  const bar = short || control ? (control && sinceMineMs <= CONTEXT_MS ? th.doubt : th.lenient) : th.strict;
  const out = { score, secs, bar, short, control: !!control };
  if (windows.length >= 3 && secs >= MIXED_MIN_SECS) {
    const mineWins = windows.filter(w => w.score >= th.lenient);
    const share = mineWins.length / windows.length;
    out.pieces = { mine: mineWins.length, all: windows.length };
    if (share >= MIXED_BAND[0] && share <= MIXED_BAND[1]) {
      const keep = [];
      for (const w of mineWins) {
        const s = Math.max(0, w.start - PIECE_PAD_SECS), e = Math.min(secs, w.end + PIECE_PAD_SECS);
        if (keep.length && s <= keep[keep.length - 1][1]) keep[keep.length - 1][1] = Math.max(keep[keep.length - 1][1], e);
        else keep.push([s, e]);
      }
      const kept = keep.reduce((n, [s, e]) => n + e - s, 0);
      if (secs - kept >= MIN_DROP_SECS) return Object.assign(out, { mine: 'yes', mixed: true, keep, kept: Math.round(kept * 100) / 100, dropped: Math.round((secs - kept) * 100) / 100 });
    }
    if (share < MIXED_BAND[0] && score < bar) return Object.assign(out, { mine: 'no' });
  }
  if (score >= bar) return Object.assign(out, { mine: 'yes' });
  // Unsure (sent, marked) only for long utterances: a sentence of the
  // person's lost would be a loss; a short word under its bar is not theirs.
  if (!short && score >= bar - th.unsureBand) return Object.assign(out, { mine: 'unsure' });
  return Object.assign(out, { mine: 'no' });
}

/** PCM of the kept spans, in order (for transcribing the person's part alone). */
function slicePcm(pcm, keep) {
  const parts = keep.map(([s, e]) => pcm.subarray(Math.max(0, Math.floor(s * BYTES_PER_SECOND) & ~1), Math.min(pcm.length, Math.ceil(e * BYTES_PER_SECOND) & ~1)));
  return Buffer.concat(parts);
}

// ---- the print store ----
const unit = v => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map(x => x / n); };
function loadStore(file) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return d && typeof d === 'object' ? d : {}; } catch { return {}; }
}
function saveStore(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function entryFor(data, user) {
  const e = data[user];
  return e && typeof e === 'object' && Array.isArray(e.prints) ? e : { on: false, prints: [] };
}
/** What a page may see: no embeddings. */
function publicEntry(e) {
  return { on: !!e.on && e.prints.length > 0, prints: e.prints.map(p => ({ id: p.id, label: p.label, at: p.at, secs: p.secs, consistency: p.consistency })) };
}
/**
 * A print from the service's /embed answer for an enrolment recording:
 * the mean of its 3 s pieces (what a print of several recordings would be),
 * and how much the pieces agree with it (median cosine: ~0.85 for a clean
 * recording of one voice; low means noise, or two voices).
 */
function buildPrint({ embedding, windows = [], secs }, { label = '', at = Date.now() } = {}) {
  const src = windows.length >= 3 ? windows : [embedding];
  const mean = unit(src[0].map((_, i) => src.reduce((s, w) => s + w[i], 0) / src.length));
  if (mean.length !== DIM) throw new Error('the voice-print service answered with ' + mean.length + ' numbers, not ' + DIM);
  const cos = src.map(w => unit(w).reduce((s, x, i) => s + x * mean[i], 0)).sort((a, b) => a - b);
  const consistency = Math.round(cos[Math.floor(cos.length / 2)] * 100) / 100;
  return { id: at.toString(36) + Math.random().toString(36).slice(2, 6), label: String(label || '').slice(0, 80), at, secs: Math.round(secs), consistency, embedding: mean.map(x => Math.round(x * 1e5) / 1e5) };
}
function addPrint(e, print) {
  const prints = e.prints.filter(p => p.id !== print.id).concat([print]).slice(-MAX_PRINTS);
  return { on: true, prints };
}
function forgetPrint(e, id) {
  const prints = e.prints.filter(p => p.id !== id);
  return { on: prints.length ? e.on : false, prints };
}
/** The header the service wants: float32 of all the person's prints. */
function printsHeader(prints) {
  const buf = Buffer.alloc(prints.length * DIM * 4);
  prints.forEach((p, i) => p.embedding.forEach((x, j) => buf.writeFloatLE(x, (i * DIM + j) * 4)));
  return buf.toString('base64');
}

// ---- the service ----
function post(url, pcm, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', headers: { 'Content-Type': 'audio/L16;rate=16000;channels=1', 'Content-Length': pcm.length, ...headers }, timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body; try { body = JSON.parse(text); } catch { body = null; }
        if (res.statusCode !== 200) return reject(new Error((body && body.error) || ('voice-print service ' + res.statusCode)));
        resolve(body);
      });
    });
    req.on('timeout', () => req.destroy(new Error('voice-print service: no answer in ' + timeoutMs + ' ms')));
    req.on('error', reject);
    req.end(pcm);
  });
}
const embed = (url, pcm, timeoutMs = 20000) => post(url.replace(/\/+$/, '') + '/embed', pcm, {}, timeoutMs);
const check = (url, pcm, prints, timeoutMs = 1500) => post(url.replace(/\/+$/, '') + '/check', pcm, { 'X-Voice-Prints': printsHeader(prints) }, timeoutMs);

/**
 * The per-listener check the VoiceWindow calls with each utterance's audio
 * and text. Fails open: with the service down the utterance counts as the
 * person's, marked (error), so a broken service never silences them.
 */
function makeCheck({ url, prints, transcribe, now = Date.now, log = () => {}, record = () => {} }) {
  let lastMineAt = -Infinity;
  return async (pcm, text) => {
    const t0 = now();
    let r;
    try { r = await check(url, pcm, prints); }
    catch (e) { log('voice print check failed: ' + e.message); record({ text, mine: 'yes', error: e.message }); return { mine: 'yes', error: e.message, ms: now() - t0 }; }
    const sinceMineMs = t0 - lastMineAt;
    const d = decide({ score: r.score, secs: r.secs, sinceMineMs, windows: r.windows || [], control: isControl(text) });
    d.ms = r.ms;
    record({ text, ...d, sinceMineMs: Number.isFinite(sinceMineMs) ? sinceMineMs : null, pieces: (r.windows || []).map(w => w.score) });
    if (d.mixed && d.keep.length) {
      try {
        const t1 = now();
        d.text = String(await transcribe(slicePcm(pcm, d.keep)) || '').trim();
        d.retranscribeMs = now() - t1;
        if (!d.text) d.mine = 'no';
      } catch (e) { d.text = text; d.error = 'retranscribe: ' + e.message; }
    }
    if (d.mine === 'yes') lastMineAt = now();
    d.ms = now() - t0;
    return d;
  };
}

/**
 * Collects the speech of an enrolment (fed the window's speech frames) until
 * it has `seconds`, then asks the service and builds the print.
 */
function makeEnrolment({ url, seconds = ENROL_TARGET_SECS, label = '', onProgress = () => {} }) {
  const want = Math.max(ENROL_MIN_SECS, Math.min(180, Number(seconds) || ENROL_TARGET_SECS)) * BYTES_PER_SECOND;
  const chunks = []; let have = 0, lastTold = -1, settled = false;
  let resolveDone, rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
  return {
    done,
    get seconds() { return have / BYTES_PER_SECOND; },
    feed(buf) {
      if (settled) return;
      chunks.push(buf); have += buf.length;
      const secs = Math.floor(have / BYTES_PER_SECOND);
      if (secs !== lastTold) { lastTold = secs; onProgress(secs, want / BYTES_PER_SECOND); }
      if (have >= want) this.finish();
    },
    async finish() {
      if (settled) return; settled = true;
      try {
        const pcm = Buffer.concat(chunks);
        if (pcm.length < ENROL_MIN_SECS * BYTES_PER_SECOND) throw new Error('only ' + Math.round(pcm.length / BYTES_PER_SECOND) + ' s of speech: at least ' + ENROL_MIN_SECS + ' are needed');
        resolveDone(buildPrint(await embed(url, pcm), { label }));
      } catch (e) { rejectDone(e); }
    },
    cancel() { if (!settled) { settled = true; rejectDone(new Error('cancelled')); } },
  };
}

/** One line per decision, appended to `file` (0600): what was said, the score, the bar, the verdict. */
function makeRecorder(file) {
  return entry => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
      fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    } catch {}
  };
}

module.exports = { isControl, makeRecorder, THRESHOLDS, SHORT_SECS, CONTEXT_MS, ENROL_MIN_SECS, ENROL_TARGET_SECS, MAX_PRINTS, DIM, decide, slicePcm, loadStore, saveStore, entryFor, publicEntry, buildPrint, addPrint, forgetPrint, printsHeader, embed, check, makeCheck, makeEnrolment };
