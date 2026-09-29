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

// Keep what can be shown: one sentence, and a phrase per numbered step.
function readAnswer(outputs, ids) {
  const summary = clip(oneLine(outputs && outputs.summary), SUMMARY_CHARS);
  const steps = {};
  for (const s of Array.isArray(outputs && outputs.phrases) ? outputs.phrases : []) {
    const n = Number(s && s.n);
    const plain = clip(oneLine(s && s.plain), PLAIN_CHARS);
    if (Number.isInteger(n) && n >= 1 && n <= ids.length && plain) steps[n] = plain;
  }
  if (!summary && !Object.keys(steps).length) throw new Error('the model gave no explanation');
  return { summary, steps };
}

// ---- the service ------------------------------------------------------------------

/**
 * @param {object} o
 * @param {string} o.file                where answers are kept (JSON)
 * @param {(inputs, meta) => Promise<object>} o.run  one program call → its outputs
 * @param {() => string} o.model          the label of the model that answers now
 */
function createPlainSteps({ file, run, model, concurrency = 2, maxEntries = 3000, maxQueue = 24, retryMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const answers = new Map();   // hash → { summary, steps: {n: plain}, at }
  const inFlight = new Set();  // hash
  const failures = new Map();  // hash → { until, reason }
  let queue = [];              // newest first: { hash, inputs, ids, meta }
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

  function pump() {
    while (running < concurrency && queue.length) {
      const job = queue.shift();
      if (answers.has(job.hash) || inFlight.has(job.hash)) continue;
      running++; inFlight.add(job.hash);
      Promise.resolve()
        .then(() => run(job.inputs, job.meta))
        .then(outputs => {
          answers.set(job.hash, { ...readAnswer(outputs, job.ids), at: now() });
          failures.delete(job.hash);
          save();
        }, error => {
          // A paused model says when it can be asked again; anything else waits retryMs.
          const until = error && error.retryAt ? Number(error.retryAt) : now() + retryMs;
          failures.set(job.hash, { until, reason: String((error && error.message) || error || 'failed').slice(0, 300) });
        })
        .finally(() => { running--; inFlight.delete(job.hash); pump(); });
    }
  }

  // Shown answers keyed by step id, for the browser.
  const byId = (a, ids) => ({ summary: a.summary, steps: Object.fromEntries(Object.entries(a.steps).map(([n, p]) => [ids[Number(n) - 1], p])) });

  /**
   * The browser names the groups on its screen: [{ g, steps: [ids] }], of
   * one conversation (its snapshot, or indexConversation of it).
   * Answers what is known; starts what is not. `results[g]` is ready,
   * `pending` is being written (ask again soon), `failed[g]` will not be
   * tried again for now (the browser keeps the technical lines).
   */
  function lookup(conversation, groups, meta = {}) {
    // A conversation's snapshot, or its index (indexConversation) kept by the caller.
    const ix = conversation && conversation.tools instanceof Map ? conversation : indexConversation(conversation || {});
    const label = model();
    const out = { results: {}, pending: [], failed: {} };
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
      out.pending.push(group.g);
      if (!inFlight.has(hash)) fresh.push({ hash, inputs: built.inputs, ids: built.ids, meta });
    }
    if (Object.keys(out.results).length) save(); // their last use moved
    if (fresh.length) {
      const hashes = new Set(fresh.map(j => j.hash));
      // What is asked now goes first; a backlog from scrolling past is dropped
      // (the groups still on screen will ask again).
      queue = [...fresh, ...queue.filter(j => !hashes.has(j.hash))].slice(0, maxQueue);
      pump();
    }
    return out;
  }

  return { lookup, stats: () => ({ answers: answers.size, running, queued: queue.length, failures: failures.size }) };
}

module.exports = { createPlainSteps, indexConversation, groupInputs, readAnswer, STEP_ID, MAX_STEPS };
