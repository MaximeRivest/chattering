'use strict';
// plain-steps.js — the work steps of a conversation, in plain words.
//
// An agent's work shows as folded groups of steps: "21 steps · thinking ×7 ·
// bash ×11", and inside, one line per command or search. Useful to someone
// who programs, noise to someone who does not. When the owner turns this on
// (settings → model), a small model reads one group at a time and writes one
// sentence for the group ("Looked through the code to see how reviews are
// saved") and one short phrase per step. The technical lines stay: one click
// on the screen shows them again.
//
// The rules that keep it cheap and honest:
// - Only groups someone is looking at are explained: the browser asks for
//   the groups on screen, never for a whole history.
// - The server builds what the model reads from the conversation itself
//   (the browser only names the steps), so a person can only have explained
//   what they may already read, and nothing else goes to the model.
// - One call per group, remembered on disk under a hash of exactly what the
//   model read and which model read it: every screen, every person and every
//   copy of the conversation (forks) reuses it; an edited step asks again.
// - The answer streams: the sentence first, then a phrase per line, sent to
//   the screens of the conversations that asked (onProgress) as it is written.
// - A few calls at a time, newest request first (what is on screen now);
//   a failed group waits before it is asked again, and the model's own
//   circuit (modelhealth.js, in the caller's run) pauses everything when the
//   model keeps failing.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Bump when the inputs or the program change in a way old answers should not survive.
const REVISION = 1;
const MAX_STEPS = 200;           // explained per group; the rest keep their technical line
const INPUT_BUDGET = 24000;      // characters of step text per call, shared by its steps
const REQUEST_CHARS = 700;
const RESULT_CHARS = 240;
const PLAIN_CHARS = 240;         // longest phrase kept from the model
const SUMMARY_CHARS = 400;

const STEP_ID = /^(t|k):[\w.:@-]{1,200}$/;

// ---- what the model reads -------------------------------------------------------

const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n - 1)).trimEnd() + '…' : s);

// Everything a conversation's cached snapshot holds that the steps need, by id.
function indexConversation(data) {
  const tools = new Map(), results = new Map(), thinking = new Map(), roleOf = new Map(), userText = new Map();
  const order = new Map();
  (data.messages || []).forEach((m, i) => {
    if (!m || typeof m !== 'object') return;
    if (m.role === 'tool' && m.id) { tools.set(String(m.id), m); order.set('t:' + m.id, i); }
    else if (m.role === 'toolresult' && m.tid) results.set(String(m.tid), m);
    else if (m.role === 'thinking' && m.eid) {
      thinking.set(m.eid, (thinking.has(m.eid) ? thinking.get(m.eid) + '\n' : '') + String(m.text || ''));
      if (!order.has('k:' + m.eid)) order.set('k:' + m.eid, i);
    }
    if (m.eid && !roleOf.has(m.eid)) roleOf.set(m.eid, m.role);
    if (m.eid && m.role === 'user') { roleOf.set(m.eid, 'user'); userText.set(m.eid, String(m.text || '')); }
  });
  const parents = new Map(Array.isArray(data.entryParents) ? data.entryParents : Object.entries(data.entryParents || {}));
  return { tools, results, thinking, roleOf, userText, parents, order, messages: data.messages || [] };
}

// The person's message the work answers: up the entry tree from the step, so
// a conversation with branches finds the question of this branch.
function requestOf(ix, eid, index) {
  const seen = new Set();
  for (let at = eid; at && !seen.has(at); at = ix.parents.get(at)) {
    seen.add(at);
    if (ix.roleOf.get(at) === 'user') return ix.userText.get(at) || '';
  }
  // No recorded tree (older snapshots): the nearest question before it.
  for (let i = index; i >= 0; i--) if (ix.messages[i] && ix.messages[i].role === 'user') return String(ix.messages[i].text || '');
  return '';
}

/**
 * The model's inputs for one group, from the conversation: the person's
 * request and the numbered steps. Unknown ids are skipped (they keep their
 * technical line). Returns null when nothing is left to explain.
 */
function groupInputs(ix, stepIds) {
  const ids = [];
  const raw = [];
  for (const id of stepIds) {
    if (ids.length >= MAX_STEPS) break;
    if (typeof id !== 'string' || !STEP_ID.test(id) || ids.includes(id)) continue;
    const [kind, ref] = [id[0], id.slice(2)];
    if (kind === 't') {
      const call = ix.tools.get(ref);
      if (!call) continue;
      const res = ix.results.get(ref);
      const firstLines = res ? String(res.text || '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 4).join(' / ') : '';
      const outcome = !res ? 'no result recorded' : (res.err ? 'failed: ' : '') + (firstLines || (res.images && res.images.length ? res.images.length + ' image(s)' : 'nothing came back'));
      raw.push({ id, eid: call.eid, kind: String(call.name || 'tool'), detail: oneLine([call.path, call.text].filter(Boolean).join(' ')), outcome: oneLine(outcome) });
    } else {
      const text = ix.thinking.get(ref);
      if (text === undefined) continue;
      raw.push({ id, eid: ref, kind: 'thinking', detail: oneLine(text), outcome: '' });
    }
    ids.push(id);
  }
  if (!raw.length) return null;
  // A long group shares the budget: every step keeps a readable start.
  const each = Math.max(120, Math.floor(INPUT_BUDGET / raw.length));
  const steps = raw.map((s, i) => [
    `[${i + 1}] ${s.kind}`,
    s.detail ? `${s.kind === 'thinking' ? 'thought' : 'given'}: ${clip(s.detail, each)}` : '',
    s.outcome ? `came back: ${clip(s.outcome, Math.min(RESULT_CHARS, each))}` : '',
  ].filter(Boolean).join('\n'));
  const first = raw[0];
  const request = clip(oneLine(requestOf(ix, first.eid, ix.order.get(first.id) ?? ix.messages.length - 1)), REQUEST_CHARS) || '(not recorded)';
  return { ids, inputs: { request, steps: steps.join('\n\n') } };
}

// ---- the program's answer ---------------------------------------------------------

// "3. Checked the settings" → [3, 'Checked the settings']. The model may
// keep the brackets of its input ("[3] …") or use another separator.
const PHRASE_LINE = /^\s*[-*]?\s*\[?(\d{1,3})\]?\s*[.:)\u2013\u2014-]?\s+(.*)$/;
const unquote = t => t.replace(/^["\u201c]+|["\u201d]+$/g, '');

// The phrases of a reply, by step number. `partial`: the reply is still being
// written, so its last line may be half a phrase (shown as it grows).
function readPhrases(text, count, { partial = false } = {}) {
  const steps = {};
  const lines = String(text || '').split('\n');
  lines.forEach((line, i) => {
    const m = PHRASE_LINE.exec(line);
    if (!m) return;
    const n = Number(m[1]);
    const whole = !partial || i < lines.length - 1;
    const plain = clip(unquote(oneLine(m[2])), PLAIN_CHARS);
    if (n >= 1 && n <= count && plain && (whole || plain.length >= 2)) steps[n] = plain;
  });
  return steps;
}

// Keep what can be shown: one sentence, and a phrase per numbered step.
function readAnswer(outputs, ids) {
  const summary = clip(oneLine(outputs && outputs.summary), SUMMARY_CHARS);
  const steps = readPhrases(outputs && outputs.phrases, ids.length);
  if (!summary && !Object.keys(steps).length) throw new Error('the model gave no explanation');
  return { summary, steps };
}

// ---- the service ------------------------------------------------------------------

/**
 * @param {object} o
 * @param {string} o.file                where answers are kept (JSON)
 * @param {(inputs, live) => Promise<object>} o.run  one program call → its
 *   outputs; it tells `live.text(field, piece)` what the model writes and
 *   `live.retry()` when the call starts its answer again
 * @param {() => string} o.model          the label of the model that answers now
 * @param {(p) => void} [o.onProgress]    { key, job, summary, steps: {id: phrase}, state }
 *   for each conversation waiting on a group: state 'writing', 'done' or 'failed'
 */
function createPlainSteps({ file, run, model, onProgress = () => {}, concurrency = 2, maxEntries = 3000, maxQueue = 24, retryMs = 10 * 60 * 1000, throttleMs = 120, now = Date.now } = {}) {
  const answers = new Map();   // hash → { summary, steps: {n: plain}, at }
  const jobs = new Map();      // hash → a group asked and not answered yet (queued or running)
  const failures = new Map();  // hash → { until, reason }
  let queue = [];              // hashes, newest first
  let running = 0;

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && saved.revision === REVISION) for (const [h, a] of Object.entries(saved.answers || {})) answers.set(h, a);
  } catch {}

  let saveTimer = null;
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      // The least recently shown go first.
      if (answers.size > maxEntries) {
        const old = [...answers].sort((a, b) => (a[1].at || 0) - (b[1].at || 0)).slice(0, answers.size - maxEntries);
        for (const [h] of old) answers.delete(h);
      }
      const tmp = file + '.' + process.pid + '.tmp';
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ revision: REVISION, answers: Object.fromEntries(answers) }), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch { try { fs.unlinkSync(tmp); } catch {} }
    }, 1000);
    if (saveTimer.unref) saveTimer.unref();
  }

  const hashOf = (label, inputs) => crypto.createHash('sha256').update(JSON.stringify([REVISION, label, inputs])).digest('hex');
  // What the page calls a job: short, and says nothing of its content.
  const tokenOf = hash => hash.slice(0, 20);

  // Shown answers keyed by step id, for the browser.
  const byId = (a, ids) => ({ summary: a.summary, steps: Object.fromEntries(Object.entries(a.steps).map(([n, p]) => [ids[Number(n) - 1], p])) });
  // The answer so far: the sentence as written, the phrases line by line.
  const partialOf = job => ({ summary: clip(oneLine(job.text.summary), SUMMARY_CHARS), steps: readPhrases(job.text.phrases, job.count, { partial: true }) });
  const hasPartial = job => !!(job.text.summary.trim() || job.text.phrases.trim());

  // Every conversation waiting on the job hears it, in its own step ids (a
  // fork asks the same thing under other ids). Writing is sent at most every
  // throttleMs, with the latest text; the end is sent at once.
  function tell(job, state, answer = null, reason = '') {
    clearTimeout(job.timer); job.timer = null; job.toldAt = now();
    const a = answer || partialOf(job);
    for (const [key, ids] of job.waiters) {
      try { onProgress({ key, job: tokenOf(job.hash), state, ...byId(a, ids), ...(reason ? { reason } : {}) }); } catch {}
    }
  }
  function writing(job) {
    if (job.timer) return;
    const wait = Math.max(0, throttleMs - (now() - (job.toldAt || 0)));
    job.timer = setTimeout(() => tell(job, 'writing'), wait);
    if (job.timer.unref) job.timer.unref();
  }

  function pump() {
    while (running < concurrency && queue.length) {
      const job = jobs.get(queue.shift());
      if (!job || job.running) continue;
      if (answers.has(job.hash)) { jobs.delete(job.hash); continue; }
      running++; job.running = true;
      const live = {
        text(field, piece) {
          if (field !== 'summary' && field !== 'phrases') return;
          job.text[field] += String(piece || '');
          writing(job);
        },
        retry() { job.text = { summary: '', phrases: '' }; writing(job); },
      };
      Promise.resolve()
        .then(() => run(job.inputs, live))
        .then(outputs => {
          const answer = { ...readAnswer(outputs, job.ids), at: now() };
          answers.set(job.hash, answer);
          failures.delete(job.hash);
          save();
          tell(job, 'done', answer);
        }, error => {
          // A paused model says when it can be asked again; anything else waits retryMs.
          const until = error && error.retryAt ? Number(error.retryAt) : now() + retryMs;
          const reason = String((error && error.message) || error || 'failed').slice(0, 300);
          failures.set(job.hash, { until, reason });
          tell(job, 'failed', { summary: '', steps: {} }, reason);
        })
        .finally(() => { running--; jobs.delete(job.hash); pump(); });
    }
  }

  /**
   * The browser names the groups on its screen: [{ g, steps: [ids] }], of
   * one conversation (its snapshot, or indexConversation of it).
   * Answers what is known; starts what is not. `results[g]` is ready,
   * `pending` is being written (ask again soon), `failed[g]` will not be
   * tried again for now (the browser keeps the technical lines).
   */
  function lookup(conversation, groups, { key = '' } = {}) {
    // A conversation's snapshot, or its index (indexConversation) kept by the caller.
    const ix = conversation && conversation.tools instanceof Map ? conversation : indexConversation(conversation || {});
    const label = model();
    // pending[g]: the job the page will hear about (onProgress); partial[g]:
    // what is already written of it.
    const out = { results: {}, pending: {}, partial: {}, failed: {} };
    const fresh = [];
    for (const group of groups) {
      const built = groupInputs(ix, group.steps);
      if (!built) { out.failed[group.g] = 'nothing here to explain'; continue; }
      const hash = hashOf(label, built.inputs);
      const known = answers.get(hash);
      if (known) {
        known.at = now();
        out.results[group.g] = byId(known, built.ids);
        continue;
      }
      const failed = failures.get(hash);
      if (failed && failed.until > now()) { out.failed[group.g] = failed.reason; continue; }
      let job = jobs.get(hash);
      if (!job) {
        job = { hash, inputs: built.inputs, ids: built.ids, count: built.ids.length, waiters: new Map(), text: { summary: '', phrases: '' }, running: false, timer: null, toldAt: 0 };
        jobs.set(hash, job);
      }
      job.waiters.set(key, built.ids);
      out.pending[group.g] = tokenOf(hash);
      if (hasPartial(job)) out.partial[group.g] = byId(partialOf(job), built.ids);
      if (!job.running) fresh.push(hash);
    }
    if (Object.keys(out.results).length) save(); // their last use moved
    if (fresh.length) {
      const asked = new Set(fresh);
      // What is asked now goes first; a backlog from scrolling past is dropped
      // (the groups still on screen will ask again).
      const next = [...fresh, ...queue.filter(h => !asked.has(h))];
      for (const h of next.slice(maxQueue)) if (!jobs.get(h)?.running) jobs.delete(h);
      queue = next.slice(0, maxQueue);
      pump();
    }
    return out;
  }

  return { lookup, stats: () => ({ answers: answers.size, running, queued: queue.length, failures: failures.size }) };
}

module.exports = { createPlainSteps, indexConversation, groupInputs, readAnswer, readPhrases, STEP_ID, MAX_STEPS };
