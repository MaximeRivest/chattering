'use strict';
// The woven timeline of a talk with the frog (design/102, "interrupting
// the frog"): what the frog's voice actually played on the person's device,
// sentence by sentence, with the moments its audio started and stopped
// there, and what the person said, with the moments they spoke, from
// whatever device listened. All on one clock: this computer's.
//
// Why: while the frog's audio played, nothing else knew about it: the
// frog did not know when the person spoke over it, and the "cut-off point"
// was where the page was when it understood a command, not where the
// person started talking. With both sides on one clock the frog can be
// told, before its next turn, exactly how the two speeches wove together
// and decide what to do, and the player can pause at the moment the person
// began.
//
// The frog side comes from the page that plays the clips (play / pause /
// seek / ended, each with the clip's own time and the page's clock), and
// from the clip's sentence table (where each sentence lies in the clip).
// The person side comes from the listener: speech onsets and closed
// utterances with their first and last speech frame's time.
//
// Nothing here talks to the network. Pure, tested in test/frog-timeline.test.js.

const KEEP_JOBS = 6;
const HEARD_SHARE = 0.85;      // a sentence played this much of its length counts as heard
const ONSET_LEAD_MS = 400;     // resume this much before the person began (the word they cut into)
const SENTENCE_FRESH_MS = 1500; // began this soon after a sentence started: resume at its start

const r1 = n => Math.round(n * 10) / 10;
const secs = ms => r1(ms / 1000).toFixed(1);
const clipText = (s, max) => { s = String(s || ''); return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…'; };

/**
 * A clip's sentences from its runs ([{ text, startMs, endMs }], one per
 * Kokoro request: several sentences made together). Within a run,
 * sentences are placed by their length (Kokoro's pace is even enough).
 */
function sentencesOf(runs) {
  const out = [];
  for (const run of runs || []) {
    const parts = String(run.text || '').split(/(?<=[.!?…]["')\]]*)\s+/).filter(Boolean);
    const total = parts.reduce((n, p) => n + p.length + 1, 0) || 1;
    let chars = 0;
    for (const p of parts) {
      const startMs = run.startMs + (run.endMs - run.startMs) * chars / total;
      chars += p.length + 1;
      const endMs = run.startMs + (run.endMs - run.startMs) * chars / total;
      out.push({ text: p, startMs: Math.round(startMs), endMs: Math.round(Math.min(run.endMs, endMs)) });
    }
  }
  return out;
}

/**
 * A page's clock against ours: the smallest difference seen between our
 * receive time and the page's send time is the offset plus the fastest
 * trip, close enough (tens of ms) for weaving speech.
 */
function createClocks() {
  const offsets = new Map(); // page id → ms to add to the page's time
  return {
    wall(page, t, received) {
      if (!Number.isFinite(t) || !page) return received;
      const d = received - t;
      const had = offsets.get(page);
      const off = had === undefined || d < had ? d : had;
      offsets.set(page, off);
      if (offsets.size > 50) offsets.delete(offsets.keys().next().value);
      return t + off;
    },
  };
}

function createTimeline({ now = Date.now, log = () => {} } = {}) {
  const jobs = new Map(); // job id → turn
  const clocks = createClocks();
  // What the person said and did outside any frog turn is kept too (the
  // last few minutes), so a turn can show what came just before it.
  const loose = [];

  function turn(job, make = true) {
    let t = jobs.get(job);
    if (!t && make) {
      t = { job, startedAt: null, clips: new Map(), order: [], person: [], controls: [], ended: false, stopped: false, newTurnAt: null };
      jobs.set(job, t);
      while (jobs.size > KEEP_JOBS) jobs.delete(jobs.keys().next().value);
    }
    return t || null;
  }
  const emit = (kind, d) => { try { log({ at: now(), kind, ...d }); } catch {} };

  /** A piece of the frog's reply is made: its clip and sentence table. */
  function addClip(job, clip, sentences, { device } = {}) {
    const t = turn(job);
    if (t.clips.has(clip)) return t.clips.get(clip);
    const c = { clip, sentences: (sentences || []).map(s => ({ ...s })), segments: [], open: null, device: device || null, index: t.order.length };
    t.clips.set(clip, c);
    t.order.push(clip);
    return c;
  }

  // The playing segments of a clip: [{ fromWall, fromMs, rate, toWall, toMs }].
  function closeOpen(c, wall, ms) {
    if (!c.open) return;
    const o = c.open;
    c.open = null;
    const toMs = Number.isFinite(ms) ? ms : o.fromMs + (wall - o.fromWall) * (o.rate || 1);
    if (toMs > o.fromMs + 20) c.segments.push({ fromWall: o.fromWall, fromMs: o.fromMs, toWall: wall, toMs, rate: o.rate || 1 });
  }
  /**
   * The page reports what its player did with a frog clip.
   * state: play | pause | ended | seek | cut | stopped
   * ms: the clip's own time at that moment; t: the page's clock then;
   * page: the page's id (its clock); by: voice | button | app | barge | turn.
   */
  function playback({ job, clip, state, ms, t, page, received = now(), rate, by, device, why }) {
    const tj = turn(job);
    const wall = clocks.wall(page, Number(t), received);
    let c = tj.clips.get(clip);
    if (!c) c = addClip(job, clip, [], { device });
    if (device && !c.device) c.device = device;
    if (tj.startedAt == null && state === 'play') tj.startedAt = wall;
    const at = Number.isFinite(Number(ms)) ? Math.max(0, Number(ms)) : null;
    if (state === 'play') {
      closeOpen(c, wall, null);
      c.open = { fromWall: wall, fromMs: at || 0, rate: rate > 0 ? rate : 1 };
      tj.ended = false;
    } else if (state === 'seek') {
      // Where it was, then where it went; playing on if it was playing.
      const wasOpen = !!c.open;
      closeOpen(c, wall, null);
      if (wasOpen) c.open = { fromWall: wall, fromMs: at || 0, rate: rate > 0 ? rate : 1 };
    } else {
      // A pause reported after a step back (the player rewound before it
      // told us): what played reached where the clip was, not where it was
      // put; the projected place closes the segment.
      const projected = positionNow(c, wall);
      closeOpen(c, wall, at != null && projected != null && at < projected - 300 ? projected : at);
      if (state === 'ended') c.done = true;
    }
    if (state === 'stopped' || why === 'stopped') tj.stopped = true;
    if (state === 'cut') { tj.cutAt = wall; tj.stopped = tj.stopped || why === 'stopped'; }
    tj.controls.push({ at: wall, clip, state, ms: at, by: by || null });
    emit('frog', { job, clip, state, ms: at, wall, by: by || null });
    return { wall };
  }

  /** The reply's remaining pieces will not come: a new turn, or talk off. */
  function cancelled(job, { unsaid = [] } = {}) {
    const t = turn(job, false);
    if (!t) return;
    t.cancelledAt = now();
    if (unsaid.length) t.unsent = unsaid.slice();
  }

  // ---- the person ----
  /** The listener heard speech begin (the first speech frame). */
  function onset({ at, device, user }) {
    const ev = { kind: 'onset', at, device: device || null, user: user || null };
    place(ev);
    emit('person', ev);
    return ev;
  }
  /**
   * A closed utterance: its first and last speech frame's time, the words,
   * the voice check's verdict, and (later) what was done with it.
   */
  function heard({ start, end, text, device, speaker, user }) {
    const ev = { kind: 'said', start, end: end || start, text: String(text || ''), device: device || null, user: user || null,
      mine: speaker ? speaker.mine : null, score: speaker && speaker.score != null ? speaker.score : null, acted: null };
    place(ev);
    emit('person', { ...ev, speaker: undefined });
    return ev;
  }
  /** What the page did with an utterance (its id is its start time). */
  function acted(start, what) {
    for (const t of [...jobs.values()].reverse()) {
      const ev = t.person.find(e => e.kind === 'said' && e.start === start);
      if (ev) { ev.acted = what; emit('acted', { start, what, job: t.job }); return ev; }
    }
    const ev = loose.find(e => e.kind === 'said' && e.start === start);
    if (ev) { ev.acted = what; emit('acted', { start, what }); }
    return ev || null;
  }
  // An event belongs to the turn speaking (or paused) at its time: the
  // latest turn that had started and was not yet replaced by a new one.
  function place(ev) {
    const at = ev.at != null ? ev.at : ev.start;
    const ts = [...jobs.values()].reverse();
    const t = ts.find(x => x.startedAt != null && x.startedAt <= at + 500 && (x.newTurnAt == null || at <= x.newTurnAt));
    if (t) t.person.push(ev); else { loose.push(ev); while (loose.length > 40) loose.shift(); }
  }
  /** The person's new message went to the frog: this turn's weave is over. */
  function newTurn(job) {
    const t = job ? turn(job, false) : [...jobs.values()].pop();
    if (t && t.newTurnAt == null) t.newTurnAt = now();
    return t;
  }

  // ---- questions ----
  /** Where a clip is playing now on the page, from its open segment. */
  function positionNow(c, at = now()) {
    if (!c.open) return null;
    return c.open.fromMs + (at - c.open.fromWall) * (c.open.rate || 1);
  }
  /** Is the frog's voice playing on the person's device at this moment? */
  function speakingAt(at = now()) {
    for (const t of [...jobs.values()].reverse()) {
      for (const clip of [...t.order].reverse()) {
        const c = t.clips.get(clip);
        if (!c.open || c.open.fromWall > at) continue;
        const pos = c.open.fromMs + (at - c.open.fromWall) * (c.open.rate || 1);
        const end = c.sentences.length ? c.sentences[c.sentences.length - 1].endMs : Infinity;
        if (pos <= end + 1500) return { job: t.job, clip, ms: Math.round(pos), sentence: sentenceAt(c, pos) };
      }
    }
    return null;
  }
  function sentenceAt(c, ms) {
    const i = c.sentences.findIndex(s => s.startMs <= ms && ms < s.endMs);
    if (i >= 0) return { index: i, ...c.sentences[i] };
    let last = -1;
    c.sentences.forEach((s, k) => { if (s.startMs <= ms) last = k; });
    return last >= 0 ? { index: last, ...c.sentences[last] } : null;
  }
  /**
   * Where to resume after the person began speaking at `onsetAt` while
   * `clip` played: a little before the word they cut into, or the start of
   * that sentence when they began just after it started. Null if unknown.
   */
  function resumeFor(job, clip, onsetAt) {
    const t = turn(job, false);
    const c = t && t.clips.get(clip);
    if (!c) return null;
    const seg = c.open && c.open.fromWall <= onsetAt ? c.open : [...c.segments].reverse().find(s => s.fromWall <= onsetAt);
    if (!seg) return null;
    const pos = seg.fromMs + (onsetAt - seg.fromWall) * (seg.rate || 1);
    const s = sentenceAt(c, pos);
    const back = Math.max(0, pos - ONSET_LEAD_MS);
    if (s && back < s.startMs + SENTENCE_FRESH_MS) return Math.max(0, Math.round(s.startMs - 100));
    return Math.round(back);
  }

  // How much of a sentence the device played: the union of its played
  // clip ranges clipped to the sentence, with the wall times of the first
  // and the last moment of it heard.
  function playedOf(c, s) {
    const segs = c.segments.concat(c.open ? [{ ...c.open, toWall: now(), toMs: positionNow(c) }] : []);
    let covered = 0, firstWall = null, lastWall = null, cutMs = null;
    const ranges = [];
    for (const g of segs) {
      const a = Math.max(g.fromMs, s.startMs), b = Math.min(g.toMs, s.endMs);
      if (b <= a) continue;
      ranges.push([a, b]);
      const rate = g.rate || 1;
      const wa = g.fromWall + (a - g.fromMs) / rate, wb = g.fromWall + (b - g.fromMs) / rate;
      if (firstWall == null || wa < firstWall) firstWall = wa;
      if (lastWall == null || wb > lastWall) lastWall = wb;
      if (b < s.endMs - 150 && (cutMs == null || b > cutMs)) cutMs = b;
    }
    ranges.sort((x, y) => x[0] - y[0]);
    let end = -1;
    for (const [a, b] of ranges) { if (b <= end) continue; covered += b - Math.max(a, end); end = b; }
    const len = Math.max(1, s.endMs - s.startMs);
    const share = covered / len;
    const reachedEnd = ranges.some(([, b]) => b >= s.endMs - 150);
    return { share, firstWall, lastWall, status: share >= HEARD_SHARE || reachedEnd ? 'heard' : share > 0.05 ? 'partial' : 'unheard', cutMs: reachedEnd ? null : cutMs };
  }

  /** The weave of a turn, for the note and for inspection. */
  function weave(job) {
    const t = job ? turn(job, false) : [...jobs.values()].pop();
    if (!t) return null;
    const sentences = [];
    for (const clip of t.order) {
      const c = t.clips.get(clip);
      c.sentences.forEach((s, i) => {
        const p = playedOf(c, s);
        sentences.push({ clip, index: i, text: s.text, status: p.status, start: p.firstWall, end: p.lastWall, cutAtMs: p.cutMs, startMs: s.startMs, endMs: s.endMs, share: r1(p.share) });
      });
    }
    for (const text of t.unsent || []) sentences.push({ clip: null, index: -1, text, status: 'unsent', start: null, end: null });
    const person = t.person.filter(e => e.kind === 'said').map(e => ({ ...e }));
    const onsets = t.person.filter(e => e.kind === 'onset').map(e => e.at);
    return { job: t.job, startedAt: t.startedAt, sentences, person, onsets, controls: t.controls.slice(), stopped: t.stopped, cutAt: t.cutAt || null, newTurnAt: t.newTurnAt, device: [...t.clips.values()].map(c => c.device).find(Boolean) || null };
  }

  /**
   * The note for the frog's next turn: what they heard, where they cut in,
   * what they said, what was left unsaid, in order on one clock (seconds
   * from the first sound of the reply on their device). Empty when the
   * reply was heard whole and nothing was said over it.
   */
  function note(job) {
    const w = weave(job);
    if (!w || w.startedAt == null) return '';
    const t0 = w.startedAt;
    const unsaid = w.sentences.filter(s => s.status === 'unheard' || s.status === 'unsent');
    const partial = w.sentences.filter(s => s.status === 'partial');
    const over = w.person.filter(e => e.mine !== 'no' && e.text.trim());
    if (!unsaid.length && !partial.length && !over.length) return '';
    const rows = [];
    const heardRows = w.sentences.filter(s => s.status === 'heard');
    const heardRow = s => ({ at: s.start, line: secs(s.start - t0) + '–' + secs(s.end - t0) + '  you said: ' + s.text });
    if (heardRows.length > 6) {
      const head = heardRows.slice(0, 2), tail = heardRows.slice(-2), mid = heardRows.length - 4;
      head.forEach(s => rows.push(heardRow(s)));
      rows.push({ at: heardRows[2].start, line: secs(heardRows[2].start - t0) + '–' + secs(heardRows[heardRows.length - 3].end - t0) + '  you said ' + mid + ' more sentences, heard whole' });
      tail.forEach(s => rows.push(heardRow(s)));
    } else heardRows.forEach(s => rows.push(heardRow(s)));
    for (const s of partial) {
      const cutIn = s.cutAtMs != null ? s.text.slice(0, Math.round(s.text.length * (s.cutAtMs - s.startMs) / Math.max(1, s.endMs - s.startMs))).trim() : '';
      rows.push({ at: s.start, line: secs(s.start - t0) + '–' + secs(s.end - t0) + '  you said, cut off: ' + (cutIn ? '"' + cutIn + '" of "' + s.text + '"' : s.text) });
    }
    for (const e of over) {
      const what = e.acted ? ' (' + e.acted + ')' : '';
      rows.push({ at: e.start, line: secs(e.start - t0) + '–' + secs(e.end - t0) + '  they said: ' + clipText(e.text.trim(), 300) + what });
    }
    rows.sort((a, b) => (a.at || 0) - (b.at || 0));
    const lines = ['Your last reply as it played on their ' + (w.device || 'device') + ', and what they said meanwhile (seconds from its first sound; sentences you wrote but they never heard are "not said"):'];
    lines.push(...rows.map(r => '  ' + r.line));
    if (unsaid.length) lines.push('  not said: ' + clipText(unsaid.map(s => s.text).join(' '), 1200));
    const allHeard = !unsaid.length && !partial.length;
    if (w.stopped) lines.push('They stopped it on purpose and did not resume: they did not want the rest. Do not offer it, repeat it or sum it up unless they ask.');
    else if (!allHeard) lines.push('Their message follows. If it is about what you were saying, or asks you to go on, continue from the cut sentence without repeating what they heard. If they changed direction, answer that; mention what was left unsaid in one short sentence only if it matters.');
    else lines.push('They heard it all; what they said meanwhile is above, with what was done about it.');
    return lines.join('\n');
  }

  /** For the page and for debugging: the last turns, compact. */
  function dump() {
    return [...jobs.keys()].map(j => weave(j));
  }

  return { addClip, playback, cancelled, onset, heard, acted, newTurn, speakingAt, resumeFor, weave, note, dump, clocks, sentencesOf, get jobs() { return jobs; } };
}

module.exports = { createTimeline, sentencesOf, createClocks, HEARD_SHARE, ONSET_LEAD_MS, SENTENCE_FRESH_MS };
