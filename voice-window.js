'use strict';
// Always-listening speech: one sliding window of audio per listener,
// transcribed again, whole, at every pause, so each word is recognized with
// up to a minute or two of context before it.
//
// Audio arrives as 16 kHz mono 16-bit PCM. A voice-activity gate with an
// adaptive noise floor (the InkType speech bridge's: the quietest frame of
// the last ten seconds, times 2.5, never below a fixed minimum) splits it
// into speech and silence:
// - Silence is not kept: at most SILENCE_KEEP of each pause stays in the
//   window. Listening all day costs nothing while nobody talks, and the
//   window's length is speech, not time.
// - A short pause (ROUND_PAUSE) after speech transcribes the window again:
//   the live text.
// - A longer pause (UTTERANCE_PAUSE) ends an utterance: what was said since
//   the last one is handed on to be understood (a command, dictation…).
// - A long quiet after speech (QUIET_PAUSE, ~4 s) is said once ('quiet').
// - Past 1.2 × its target length the window slides back to about 0.8 ×:
//   the audio before a pause near that point is transcribed once more on
//   its own, that text becomes final ("committed") and the audio leaves the
//   window. The window averages its target; a slide (one extra pass over
//   the head) comes once per ~0.4 × target of speech.
//
// The transcriber is injected (transcribe(pcm) → text), so the whole
// behavior runs faster than real time in tests.
//
// The gate can be a model instead of the energy floor (`gate`, design/102:
// a wood mill at 300–4,000 RMS kept the energy gate open for 43 s
// utterances). The model (voice-vad.js) gives each 100 ms frame a
// probability of being the person's speech; a frame is speech above GATE_ON
// and stays speech until below GATE_OFF. The RMS floor is still computed
// and is the fallback the moment the model throws.

const RATE = 16000;
const BYTES_PER_SECOND = RATE * 2;
const FRAME_BYTES = BYTES_PER_SECOND / 10;            // one 100 ms frame
const FLOOR_FRAMES = 100;                              // ~10 s of noise-floor history
const FLOOR_WARMUP = 20;                               // ~2 s before the floor is trusted
const SILENCE_RMS_MIN = 30;
const SILENCE_FACTOR = 2.5;
const ROUND_PAUSE = 3;                                 // frames: ~300 ms → transcribe
const UTTERANCE_PAUSE = 8;                             // frames: ~800 ms → end of utterance
const SILENCE_KEEP = 4;                                // frames of each pause kept in the window
const QUIET_PAUSE = 40;                                // frames: ~4 s of quiet after speech → 'quiet' (once)
const BURST_FRAMES = [5, 15, 30];                      // frames of speech in a row → 'burst' (the person is clearly talking): at 0.5 s, and again at 1.5 s and 3 s (in noise the first half second is the noise; measured 2026-10-19)
const SPEECH_RUN_MAX = 150;                            // frames: ~15 s of "speech" with no pause → the gate is stuck on noise: the utterance closes at the next short pause
const GATE_ON = 0.4;                                   // model gate: a frame is speech from this probability… (set on the recorded clips, myvoice/vad/evaluate.py)
const GATE_OFF = 0.2;                                  // …and stays speech until it falls below this
const MIN_ROUND_BYTES = BYTES_PER_SECOND / 4;          // a quarter second: "send" is short
const MIN_HEAD_BYTES = BYTES_PER_SECOND * 4;           // never commit less than this
const MIN_TAIL_BYTES = BYTES_PER_SECOND * 2;           // always keep this much rolling
const COMMITTED_KEEP_WORDS = 400;
const SLIDE_OVER = 1.2;                                // slide past this × target…
const SLIDE_TO = 0.8;                                  // …back to about this × target                      // final text kept for display and alignment

const WINDOW_SECONDS = Object.freeze({ min: 15, default: 60, max: 180 });

function clampWindowSeconds(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(WINDOW_SECONDS.min, Math.min(WINDOW_SECONDS.max, n)) : WINDOW_SECONDS.default;
}

function frameRms(buf, offset) {
  let sum = 0;
  const n = FRAME_BYTES / 2;
  for (let i = 0; i < n; i++) { const s = buf.readInt16LE(offset + i * 2); sum += s * s; }
  return Math.sqrt(sum / n);
}

const normWord = w => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');

/**
 * Where word `index` of `prev` is in `next`, when both transcribe audio
 * that starts at the same moment (the window, before and after more speech
 * or a fresh pass; words revised, merged, split). Aligns the two from their
 * start by the longest common subsequence over normalized words, preferring
 * the earliest matches: anchored at the shared start, that is the true
 * place even when phrases repeat ("scroll up… scroll up"). Aligning only
 * the last words instead let a repeat pull the mark one phrase back, and
 * everything after it was handed on again. Returns the index in `next`
 * right after the last aligned word at or before `index`.
 */
function mapWordIndex(prev, index, next, max) {
  return alignWordIndex(prev, index, next, max).index;
}

/**
 * mapWordIndex, and whether the mapping is sure: the word just before
 * `index` is itself found in `next`. When the recognizer rewrote it (more
 * context, another language), the count is a guess.
 *
 * A window is at most 1.2 × 180 s of speech (under ~1000 words), so the
 * table stays small; past `max` words both sides drop the same number
 * from their start, which keeps them roughly anchored.
 */
function alignWordIndex(prev, index, next, max = 1500) {
  if (index <= 0) return { index: 0, sure: true };
  const a0 = Math.max(0, index - max), b0 = Math.min(a0, Math.max(0, next.length - 1));
  const a = prev.slice(a0, index).map(normWord), b = next.slice(b0, b0 + max * 2).map(normWord);
  // LCS table (small: see above).
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] && a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Walk the alignment; remember where the last matched word of `a` sits in `b`.
  let i = 0, j = 0, lastA = -1, lastB = -1;
  while (i < a.length && j < b.length) {
    if (a[i] && a[i] === b[j]) { lastA = i; lastB = j; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  if (lastA === a.length - 1) return { index: b0 + lastB + 1, sure: true };
  // After the last word both share, the rest is matched letter by letter:
  // recognizers split and merge words ("window js" → "window.js", "char
  // lie" → "charlie") and change a letter or two far more often than they
  // change everything. A word count here swallowed the first word of the
  // next sentence. Only when the letters mostly differ (another language)
  // is the word count the better guess.
  const from = lastB + 1;
  const tailWords = a.length - 1 - lastA;
  const k = letterBoundary(a.slice(lastA + 1), b.slice(from), tailWords);
  return { index: b0 + from + (k ?? Math.min(b.length - from, tailWords)), sure: false };
}

// How many of `words` (normalized) are the same speech as `tail`: the count
// whose letters are fewest edits from the tail's ("sender" → "send", not
// "send start"; "window js" → "windowjs"). Ties go to the count nearest
// `tailWords`. Null when even the best is more than half rewritten.
function letterBoundary(tail, words, tailWords) {
  const A = tail.join('').slice(-300);
  if (!A) return 0;
  const ends = [0];
  let B = '';
  for (const w of words) { if (B.length > A.length * 2 + 40) break; B += w; ends.push(B.length); }
  // Edit distance from A to every prefix of B: one row per letter of A.
  let row = Int32Array.from({ length: B.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    const next = new Int32Array(B.length + 1);
    next[0] = i;
    for (let j = 1; j <= B.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
    row = next;
  }
  let best = null, bestD = Infinity;
  ends.forEach((e, n) => {
    const d = row[e];
    if (d < bestD || (d === bestD && Math.abs(n - tailWords) < Math.abs(best - tailWords))) { best = n; bestD = d; }
  });
  return bestD * 2 > A.length ? null : best;
}

class VoiceWindow {
  /**
   * @param {object} o
   * @param {(pcm: Buffer) => Promise<string>} o.transcribe
   * @param {(event: object) => void} o.emit  heard / utterance / slide / error events
   * @param {number} [o.windowSeconds]
   * @param {(pcm: Buffer, text: string) => Promise<object>} [o.check]  looks at
   *   each utterance's audio before it is handed on (who spoke: voice-speaker.js);
   *   its answer rides on the utterance event as `speaker`, and a `text` in it
   *   replaces the words (the person's part of a two-voice utterance)
   * @param {(pcm: Buffer) => void} [o.onSpeech]  gets every speech frame kept
   *   (an enrolment recording); settable later
   * @param {(b: {pcm: Buffer, at: number}) => void} [o.onBurst]  called once per
   *   utterance when speech has gone on for BURST_FRAMES in a row (the person
   *   is clearly talking, ~0.5 s in), with the utterance's audio so far and
   *   the wall time its speech began: the barge-in check (design/102)
   * @param {() => number} [o.now]  the clock (tests)
   * @param {{step: (frame: Buffer, offset: number) => number, reset?: () => void}} [o.gate]
   *   the voice-activity model: the probability that a 100 ms frame is the
   *   person's speech (voice-vad.js). Null: the energy floor decides.
   */
  constructor({ transcribe, emit, windowSeconds = WINDOW_SECONDS.default, check = null, onSpeech = null, onUtterance = null, onBurst = null, now = Date.now, gate = null }) {
    this.transcribe = transcribe;
    this.emit = emit;
    this.check = check;
    this.gate = gate;
    this.gateOpen = false;           // the model gate's hysteresis state
    this.gateProb = null;            // the last frame's speech probability (the debug view)
    this.gateFailed = false;         // the model threw: the energy floor took over (said once)
    // Each utterance's audio and words, after the check (the voice corpus).
    this.onUtterance = onUtterance;
    this.onSpeech = onSpeech;
    this.onBurst = onBurst;
    this.now = now;
    // When the utterance's speech began and was last heard (wall clock):
    // the person's side of the woven timeline (design/102).
    this.speechStartAt = null;
    this.speechLastAt = null;
    this.speechRun = 0;              // speech frames in a row
    this.utteranceBytes = 0;         // window offset where this utterance's audio begins
    this.setWindowSeconds(windowSeconds);
    this.window = Buffer.alloc(0);   // speech audio (silences shortened)
    this.pending = Buffer.alloc(0);  // bytes short of a whole frame
    this.floor = [];                 // recent frame RMS
    this.silentRun = 0;              // silent frames in a row
    this.speechSinceRound = false;
    this.speechSinceUtterance = false;
    this.speechSinceQuiet = false;   // a 'quiet' event is owed after the next long pause
    this.cuts = [];                  // window offsets at the ends of pauses (where a slide may cut)
    this.committed = [];             // final words (last COMMITTED_KEEP_WORDS)
    this.windowWords = [];           // the last round's words of the window
    this.prevWindowWords = [];
    this.decided = 0;                // words (committed + window) already handed on as utterances
    this.decidedBytes = 0;           // the window audio those words came from
    this.round = 0;
    this.busy = null;                // the round in progress
    this.wantRound = false;
    this.wantUtterance = false;
    this.closed = false;
  }

  setWindowSeconds(s) {
    this.windowSeconds = clampWindowSeconds(s);
    this.targetBytes = this.windowSeconds * BYTES_PER_SECOND;
  }

  // Until the floor has a little history, only the fixed minimum: learning
  // "silence" from the first sound would make speech that starts at once
  // count as quiet.
  // The quietest frame of the last ten seconds times 2.5. A noise-level
  // term (a percentile of the last ten seconds) was tried for a room with
  // a machine running (a wood mill, 2026-10-19: noise 300-4000 with dips
  // to 20, voice 10,000+) and dropped: steady speech with few gaps raised
  // it to the voice's own level and cut the speaker off. An energy gate
  // cannot tell a mill's bursts from a voice; the caps below bound the
  // damage (SPEECH_RUN_MAX, closeUtterance), and a neural voice-activity
  // model would be the real fix.
  threshold() {
    if (this.floor.length < FLOOR_WARMUP) return SILENCE_RMS_MIN;
    return Math.max(SILENCE_RMS_MIN, Math.min(...this.floor) * SILENCE_FACTOR);
  }
  // The gate's decision for one frame: the model with hysteresis when there
  // is one, else the energy floor. A model that throws is dropped for this
  // listener (the floor goes on) and reported once.
  isSpeech(buf, at, rms) {
    if (this.gate) {
      try {
        const p = this.gate.step(buf, at);
        this.gateProb = p;
        this.gateOpen = this.gateOpen ? p >= GATE_OFF : p >= GATE_ON;
        return this.gateOpen;
      } catch (e) {
        this.gate = null; this.gateProb = null;
        if (!this.gateFailed) { this.gateFailed = true; this.emit({ type: 'error', message: 'voice gate model: ' + e.message + ' (the energy gate took over)' }); }
      }
    }
    return rms >= this.threshold();
  }
  /**
   * Close the utterance now, at the next short pause (the server asks when
   * the live words end with a hand-over or a command and the gate has not
   * closed: a machine keeps it open; design/102). No-op without speech.
   */
  closeUtterance() {
    if (!this.speechSinceUtterance) return false;
    this.wantUtterance = true;
    this.utteranceTimes = { startedAt: this.speechStartAt, endedAt: this.speechLastAt };
    this.kick();
    return true;
  }

  /** Feed PCM. Rounds run in order; feeding never waits for them. */
  feed(chunk) {
    if (this.closed) return;
    let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    let at = 0;
    const kept = [];
    // The chunk arrived now; a frame inside it was spoken earlier by the
    // audio that follows it (the device sends in chunks of a few hundred ms).
    const arrived = this.now();
    const bursts = [];
    for (; at + FRAME_BYTES <= buf.length; at += FRAME_BYTES) {
      const rms = frameRms(buf, at);
      this.floor.push(rms);
      if (this.floor.length > FLOOR_FRAMES) this.floor.shift();
      const silent = !this.isSpeech(buf, at, rms);
      const frame = buf.subarray(at, at + FRAME_BYTES);
      const frameAt = arrived - Math.round((buf.length - at - FRAME_BYTES) * 1000 / BYTES_PER_SECOND);
      if (!silent) {
        if (this.silentRun >= ROUND_PAUSE) this.cuts.push(this.window.length + kept.reduce((n, f) => n + f.length, 0));
        if (!this.speechSinceUtterance) {
          // The first speech of an utterance: said at once (where the
          // frog's player may pause), and remembered for the utterance.
          this.speechStartAt = frameAt;
          this.utteranceBytes = this.window.length + kept.reduce((n, f) => n + f.length, 0);
          this.emit({ type: 'speech', at: frameAt });
        }
        this.speechLastAt = frameAt;
        this.speechRun = this.silentRun >= ROUND_PAUSE || !this.speechSinceUtterance ? 1 : this.speechRun + 1;
        this.silentRun = 0;
        this.speechSinceRound = true;
        this.speechSinceUtterance = true;
        this.speechSinceQuiet = true;
        kept.push(frame);
        if (BURST_FRAMES.includes(this.speechRun)) bursts.push(this.speechRun);
        // The gate stuck on noise (no 800 ms dip in 15 s): the utterance
        // closes at the next short pause, so words are handed on and the
        // hand-over at their end is seen (43 s utterances, 2026-10-19).
        if (this.speechRun >= SPEECH_RUN_MAX && !this.wantUtterance) { this.wantUtterance = true; this.utteranceTimes = { startedAt: this.speechStartAt, endedAt: this.speechLastAt }; this.speechRun = 0; }
        continue;
      }
      this.silentRun++;
      // Before any speech the window holds nothing; inside a pause, a little.
      if ((this.window.length || kept.length) && this.silentRun <= SILENCE_KEEP) kept.push(frame);
      if (this.silentRun === ROUND_PAUSE && this.speechSinceRound) this.wantRound = true;
      if (this.silentRun === UTTERANCE_PAUSE && this.speechSinceUtterance) { this.wantUtterance = true; this.utteranceTimes = { startedAt: this.speechStartAt, endedAt: this.speechLastAt }; }
      // A long quiet after speech, said once: what the page does with it is
      // its own (the walkie-talkie: "your words wait for over"). From the
      // audio itself, so it comes on time even when the page's timers sleep.
      if (this.silentRun === QUIET_PAUSE && this.speechSinceQuiet) { this.speechSinceQuiet = false; this.emit({ type: 'quiet', seconds: QUIET_PAUSE / 10, at: Date.now() }); }
    }
    this.pending = Buffer.from(buf.subarray(at));
    if (kept.length) {
      this.window = Buffer.concat([this.window, ...kept]);
      if (this.onSpeech) try { this.onSpeech(kept.length === 1 ? kept[0] : Buffer.concat(kept)); } catch {}
      // Clearly talking (half a second of speech in a row): the utterance's
      // audio so far, for the barge-in check, once per utterance.
      if (bursts.length && this.onBurst) {
        for (const run of bursts) { try { this.onBurst({ pcm: this.window.subarray(Math.min(this.utteranceBytes, this.window.length)), at: this.speechStartAt, stage: BURST_FRAMES.indexOf(run) }); } catch {} }
      }
    }
    if (this.wantRound || this.wantUtterance) this.kick();
  }

  // Run a round unless one is running (it runs again after, if still wanted).
  kick() {
    if (this.busy || this.closed) return this.busy;
    if (!this.wantRound && !this.wantUtterance) return null;
    this.busy = this.runRound().finally(() => { this.busy = null; if (this.wantRound || this.wantUtterance) this.kick(); });
    return this.busy;
  }

  /** Resolves when no round is running or wanted (tests; a stop). */
  async idle() { while (this.busy) await this.busy; }

  words() { return this.committed.concat(this.windowWords); }

  async runRound() {
    const utterance = this.wantUtterance;
    const times = utterance ? this.utteranceTimes || null : null;
    // The end of an utterance comes a moment after the short pause's round:
    // with no speech since, that round's words are current; no new pass.
    const transcribe = this.wantRound || this.speechSinceRound;
    this.wantRound = false;
    this.wantUtterance = false;
    if (utterance) this.speechSinceUtterance = false;
    this.speechSinceRound = false;
    if (!transcribe || this.window.length < MIN_ROUND_BYTES) {
      if (utterance) await this.flushUtterance(0, times);
      return;
    }
    const before = this.words();
    const t0 = Date.now();
    let text;
    try { text = await this.transcribe(this.window); }
    catch (e) { this.emit({ type: 'error', message: 'speech-to-text: ' + e.message }); return; }
    if (this.closed) return;
    const asrMs = Date.now() - t0;
    this.round++;
    const words = String(text || '').split(/\s+/).filter(Boolean);
    // Where the decided part now ends, in the new transcription. When the
    // recognizer rewrote the words at the boundary, text alone cannot tell:
    // transcribe exactly the decided audio once, and count its words (the
    // same audio, the same context before it) — so nothing is handed on twice.
    const committedN = this.committed.length;
    const decidedInWindow = Math.max(0, this.decided - committedN);
    let align = alignWordIndex(before.slice(committedN), decidedInWindow, words);
    if (!align.sure && this.decidedBytes >= MIN_ROUND_BYTES && this.decidedBytes < this.window.length) {
      try {
        const head = String(await this.transcribe(this.window.subarray(0, this.decidedBytes)) || '').split(/\s+/).filter(Boolean);
        if (this.closed) return;
        const byHead = alignWordIndex(head, head.length, words);
        align = { index: byHead.index, sure: true };
        this.emit({ type: 'realign', words: head.length });
      } catch (e) { this.emit({ type: 'error', message: 'speech-to-text (realign): ' + e.message }); }
    }
    this.decided = committedN + align.index;
    this.prevWindowWords = this.windowWords;
    this.windowWords = words;
    let slideMs = 0;
    if (this.window.length > this.targetBytes * SLIDE_OVER) slideMs = await this.slide();
    const stableN = this.stableCount();
    this.emit({
      type: 'heard', round: this.round, asrMs, slideMs,
      committed: this.committed.join(' '),
      stable: this.windowWords.slice(0, stableN).join(' '),
      volatile: this.windowWords.slice(stableN).join(' '),
      windowSeconds: Math.round(this.window.length / BYTES_PER_SECOND * 10) / 10,
      decided: this.decided,
    });
    if (utterance) await this.flushUtterance(asrMs, times);
  }

  // Words the last two rounds agree on, from the start of the window.
  stableCount() {
    const a = this.prevWindowWords, b = this.windowWords;
    let n = 0;
    while (n < a.length && n < b.length && normWord(a[n]) === normWord(b[n])) n++;
    return n;
  }

  // The utterance's audio is the window since the last one handed on; the
  // check (if any) hears it before the words go out, and may replace them.
  async flushUtterance(asrMs, times = null) {
    const all = this.words();
    let text = all.slice(this.decided).join(' ').trim();
    const pcm = this.window.subarray(this.decidedBytes, this.window.length);
    this.decided = all.length;
    this.decidedBytes = this.window.length;
    if (!text) return;
    const heard = text; // the listener's words for the whole audio, before any cut
    let speaker;
    if (this.check && pcm.length >= FRAME_BYTES * 2) {
      try {
        speaker = await this.check(pcm, text);
        if (this.closed) return;
        if (speaker && typeof speaker.text === 'string') { if (speaker.text) text = speaker.text; delete speaker.text; }
      } catch (e) { speaker = { mine: 'yes', error: e.message }; }
    }
    const startedAt = times ? times.startedAt : this.speechStartAt, endedAt = times ? times.endedAt : this.speechLastAt;
    if (this.onUtterance) { try { this.onUtterance({ pcm: Buffer.from(pcm), text, heard, asrMs, speaker: speaker || null, startedAt, endedAt }); } catch {} }
    if (text) this.emit({ type: 'utterance', text, asrMs, at: this.now(), startedAt, endedAt, ...(speaker ? { speaker } : {}) });
  }

  // Commit the audio before the pause nearest to (length − SLIDE_TO ×
  // target): one transcription of exactly that audio, so the final text
  // matches the cut.
  async slide() {
    const want = this.window.length - this.targetBytes * SLIDE_TO;
    const limit = this.window.length - MIN_TAIL_BYTES;
    let cut = 0;
    for (const c of this.cuts) if (c >= MIN_HEAD_BYTES && c <= limit && Math.abs(c - want) < Math.abs(cut - want)) cut = c;
    // No usable pause (long unbroken speech): cut anyway, at the target.
    if (!cut && this.window.length > this.targetBytes * 2) cut = Math.max(MIN_HEAD_BYTES, want - (want % FRAME_BYTES));
    if (!cut) return 0;
    const t0 = Date.now();
    let head;
    try { head = await this.transcribe(this.window.subarray(0, cut)); }
    catch (e) { this.emit({ type: 'error', message: 'speech-to-text (slide): ' + e.message }); return 0; }
    if (this.closed) return 0;
    const headWords = String(head || '').split(/\s+/).filter(Boolean);
    // The head's words move from the window to the committed text; the
    // words after them stay the window's until the next round retranscribes
    // it. The decided mark counts words of both, so it keeps its place.
    this.window = Buffer.from(this.window.subarray(cut));
    this.cuts = this.cuts.map(c => c - cut).filter(c => c > 0);
    this.decidedBytes = Math.max(0, this.decidedBytes - cut);
    this.committed.push(...headWords);
    this.windowWords = this.windowWords.slice(Math.min(this.windowWords.length, headWords.length));
    this.prevWindowWords = [];
    this.decided = Math.min(this.decided, this.committed.length + this.windowWords.length);
    // Bound the committed text; the decided mark moves with it.
    const drop = Math.max(0, this.committed.length - COMMITTED_KEEP_WORDS);
    if (drop) { this.committed.splice(0, drop); this.decided = Math.max(0, this.decided - drop); }
    this.emit({ type: 'slide', committedSeconds: Math.round(cut / BYTES_PER_SECOND * 10) / 10, text: headWords.join(' ') });
    return Date.now() - t0;
  }

  /** Stop: the last pause's words are handed on, then nothing more runs. */
  async close({ flush = true } = {}) {
    if (this.closed) return;
    if (flush && this.speechSinceUtterance) { this.wantUtterance = true; this.kick(); }
    await this.idle();
    this.closed = true;
  }
}

module.exports = { VoiceWindow, mapWordIndex, alignWordIndex, clampWindowSeconds, WINDOW_SECONDS, RATE, FRAME_BYTES, BYTES_PER_SECOND, GATE_ON, GATE_OFF };
