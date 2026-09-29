'use strict';
// plain-steps.js — the work steps of a conversation, in plain words.
//
// An agent's work shows as folded groups of steps: "21 steps · thinking ×7 ·
// bash ×11", and inside, one line per command or search. The commands are
// what is daunting to someone who does not program. When the owner turns
// this on (settings → model), a small model writes, above each tool call,
// one light sentence on what it is trying to achieve and how ("Finding where
// the app starts: searching the code for the word “startup”"), and one
// sentence per finished group. The command stays under its sentence: read
// together, they teach what the commands mean.
//
// Only tool calls. The assistant's reasoning is already words: it is shown as
// it was written, never rewritten or summarized, and it is not a step here.
//
// A tool call is described by its aim, not its result: the model reads the
// command (and the thought just before it, for its why), never what came
// back. So a call can be described as soon as it is written, while it runs,
// and no file contents reach the model through a command's output.
//
// Two ways to get there, whichever costs less for what is on screen:
// - Work being done now: each call on its own, as soon as it is written,
//   several at a time.
//   The group's sentence waits for the group to be finished; then it is one
//   small call that reads the phrases, not the commands again.
// - Older work scrolled to, mostly unexplained: the whole group in one call,
//   sentence and phrases together.
// Every phrase is kept per tool call (by its id, unique), so a call explained
// live keeps its phrase in the saved transcript, in forks, and on every screen.
//
// The rules that keep it cheap and honest:
// - Only what someone is looking at is explained: the browser names the steps
//   on its screen, never a whole history.
// - The server builds what the model reads from the conversation itself (its
//   saved snapshot, or the run in progress), so a person can only have
//   explained what they may already read, and nothing else goes to the model.
// - Answers stream to the screens of the conversations that asked
//   (onProgress) as they are written, and are remembered on disk per model.
// - A few calls at a time, newest first (what is on screen now); a failed
//   call waits before it is asked again, and the model's own circuit
//   (modelhealth.js, in the caller's run) pauses everything when the model
//   keeps failing.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Bump when the inputs or the programs change in a way old answers should not survive.
const REVISION = 3;
const MAX_STEPS = 200;           // explained per group; the rest keep their technical line
const INPUT_BUDGET = 24000;      // characters of step text per group call, shared by its steps
const STEP_BUDGET = 3000;        // characters of one step, for a call about that step alone
const THOUGHT_BEFORE = 1500;     // the end of the thought before a command, for its why
const REQUEST_CHARS = 700;
const PLAIN_CHARS = 240;         // longest phrase kept from the model
const SUMMARY_CHARS = 400;
// A finished group with more unexplained steps than this is one group call.
const GROUP_CALL_ABOVE = 3;

// 't:<tool call id>': the only steps described.
const STEP_ID = /^t:[\w.:@-]{1,200}$/;

// ---- what the model reads -------------------------------------------------------

const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n - 1)).trimEnd() + '…' : s);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// Everything a conversation's cached snapshot holds that the steps need, by id.
function indexConversation(data) {
  const tools = new Map(), results = new Map(), thinking = new Map(), roleOf = new Map(), userText = new Map();
  const order = new Map();
  (data.messages || []).forEach((m, i) => {
    if (!m || typeof m !== 'object') return;
    if (m.role === 'tool' && m.id) { tools.set(String(m.id), m); order.set('t:' + m.id, i); }
    else if (m.role === 'toolresult' && m.tid) results.set(String(m.tid), m);
    else if (m.role === 'thinking' && m.eid) thinking.set(m.eid, (thinking.has(m.eid) ? thinking.get(m.eid) + '\n' : '') + String(m.text || ''));
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
  // No recorded tree (older snapshots, a run not saved yet): the nearest question before it.
  for (let i = index; i >= 0; i--) if (ix.messages[i] && ix.messages[i].role === 'user') return String(ix.messages[i].text || '');
  return '';
}

// The thought the assistant had just before a saved step, in the same turn.
function thoughtBefore(ix, index) {
  for (let i = (index ?? 0) - 1; i >= 0; i--) {
    const m = ix.messages[i];
    if (!m || m.role === 'user') return '';
    if (m.role === 'thinking') return ix.thinking.get(m.eid) || String(m.text || '');
  }
  return '';
}
const tail = (s, n) => { s = oneLine(s); return s.length > n ? '…' + s.slice(-(n - 1)) : s; };

/**
 * One tool call named by the page, as the model will read it, once it is
 * written; null while it is not (its call still streaming), when it is not
 * in this conversation, or when it is not a tool call. `live` finds calls of
 * a run in progress that the snapshot does not hold yet: { tool(callId) }.
 */
function resolveStep(ix, name, live = null) {
  if (typeof name !== 'string' || !STEP_ID.test(name)) return null;
  const id = name.slice(2), call = ix.tools.get(id);
  if (call) {
    const index = ix.order.get(name);
    return { name, identity: name, kind: String(call.name || 'tool'), eid: call.eid, index,
      detail: oneLine([call.path, call.text].filter(Boolean).join(' ')), before: tail(thoughtBefore(ix, index), THOUGHT_BEFORE) };
  }
  const t = live && live.tool ? live.tool(id) : null;
  if (t && t.written) return { name, identity: name, kind: String(t.name || 'tool'), detail: oneLine(t.args), before: tail(t.thought || '', THOUGHT_BEFORE) };
  return null;
}

const stepText = (s, budget) => [s.kind, s.detail ? `given: ${clip(s.detail, budget)}` : ''].filter(Boolean).join('\n');

// The question the steps answer: that of the first saved one, else the latest.
function requestFor(ix, steps) {
  const saved = steps.find(s => s.index !== undefined);
  const text = saved ? requestOf(ix, saved.eid, saved.index) : requestOf(ix, null, ix.messages.length - 1);
  return clip(oneLine(text), REQUEST_CHARS) || '(not recorded)';
}

// A whole group in one call: the numbered steps share the text budget, so
// every step keeps a readable start.
function groupInputs(request, steps) {
  const each = Math.max(120, Math.floor(INPUT_BUDGET / Math.max(1, steps.length)));
  return { request, steps: steps.map((s, i) => `[${i + 1}] ${stepText(s, each)}`).join('\n\n') };
}

// ---- the programs' answers ---------------------------------------------------------

// "3. Checked the settings" → [3, 'Checked the settings']. The model may
// keep the brackets of its input ("[3] …") or use another separator.
const PHRASE_LINE = /^\s*[-*]?\s*\[?(\d{1,3})\]?\s*[.:)\u2013\u2014-]?\s+(.*)$/;
const unquote = t => t.replace(/^["\u201c]+|["\u201d]+$/g, '');
const cleanPhrase = t => clip(unquote(oneLine(t)), PLAIN_CHARS);

// The phrases of a group reply, by step number. `partial`: the reply is still
// being written, so its last line may be half a phrase (shown as it grows).
function readPhrases(text, count, { partial = false } = {}) {
  const steps = {};
  const lines = String(text || '').split('\n');
  lines.forEach((line, i) => {
    const m = PHRASE_LINE.exec(line);
    if (!m) return;
    const n = Number(m[1]);
    const whole = !partial || i < lines.length - 1;
    const plain = cleanPhrase(m[2]);
    if (n >= 1 && n <= count && plain && (whole || plain.length >= 2)) steps[n] = plain;
  });
  return steps;
}

// Keep what can be shown of a group reply: one sentence, a phrase per numbered step.
function readAnswer(outputs, count) {
  const summary = clip(oneLine(outputs && outputs.summary), SUMMARY_CHARS);
  const steps = readPhrases(outputs && outputs.phrases, count);
  if (!summary && !Object.keys(steps).length) throw new Error('the model gave no explanation');
  return { summary, steps };
}

// ---- the service ------------------------------------------------------------------

/**
 * @param {object} o
 * @param {string} o.file                where answers are kept (JSON)
 * @param {(program, inputs, live) => Promise<object>} o.run  one program call
 *   → its outputs: 'step' ({request, thought_before, step} → {phrase}), 'summary' ({request,
 *   phrases} → {summary}) or 'group' ({request, steps} → {summary, phrases});
 *   it tells `live.text(field, piece)` what the model writes and `live.retry()`
 *   when the call starts its answer again
 * @param {() => string} o.model          the label of the model that answers now
 * @param {(p) => void} [o.onProgress]    { key, job, state, summary?, steps: {name: phrase} }
 *   for each conversation waiting on a call: state 'writing', 'done' or 'failed'
 */
function createPlainSteps({ file, run, model, onProgress = () => {}, concurrency = 6, maxSteps = 20000, maxSummaries = 5000,
  maxQueue = 80, retryMs = 10 * 60 * 1000, throttleMs = 120, now = Date.now } = {}) {
  const phrases = new Map();   // step key → { plain, at }
  const summaries = new Map(); // group key → { summary, at }
  const jobs = new Map();      // job hash → a call asked and not answered yet (queued or running)
  const failures = new Map();  // job hash → { until, reason }
  let queue = [];              // job hashes, newest first
  let running = 0;

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && saved.revision === REVISION) {
      for (const [k, v] of Object.entries(saved.steps || {})) phrases.set(k, v);
      for (const [k, v] of Object.entries(saved.summaries || {})) summaries.set(k, v);
    }
  } catch {}

  let saveTimer = null;
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      // The least recently shown go first.
      const trim = (map, max) => {
        if (map.size <= max) return;
        for (const [k] of [...map].sort((a, b) => (a[1].at || 0) - (b[1].at || 0)).slice(0, map.size - max)) map.delete(k);
      };
      trim(phrases, maxSteps); trim(summaries, maxSummaries);
      const tmp = file + '.' + process.pid + '.tmp';
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ revision: REVISION, steps: Object.fromEntries(phrases), summaries: Object.fromEntries(summaries) }), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch { try { fs.unlinkSync(tmp); } catch {} }
    }, 1000);
    if (saveTimer.unref) saveTimer.unref();
  }

  const stepKey = (label, identity) => sha(JSON.stringify([REVISION, label, identity]));
  const groupKey = (label, request, steps) => sha(JSON.stringify([REVISION, label, request, steps.map(s => s.identity)]));
  // What the page calls a job: short, and says nothing of its content.
  const tokenOf = hash => hash.slice(0, 20);

  // ---- calls ---------------------------------------------------------------------

  // A job's answer so far, for one waiting conversation, in its step names.
  function viewOf(job, names, final = null) {
    if (job.program === 'step') {
      const plain = final ? final.plain : cleanPhrase(job.text.phrase);
      return { steps: plain ? Object.fromEntries([...names].map(n => [n, plain])) : {} };
    }
    if (job.program === 'summary') return { summary: final ? final.summary : clip(oneLine(job.text.summary), SUMMARY_CHARS), steps: {} };
    const a = final || { summary: clip(oneLine(job.text.summary), SUMMARY_CHARS), steps: readPhrases(job.text.phrases, job.steps.length, { partial: true }) };
    const steps = {};
    for (const [n, plain] of Object.entries(a.steps)) if (names[Number(n) - 1]) steps[names[Number(n) - 1]] = plain;
    return { summary: a.summary, steps };
  }
  // Every conversation waiting on the job hears it. Writing is sent at most
  // every throttleMs, with the latest text; the end is sent at once.
  function tell(job, state, final = null, reason = '') {
    clearTimeout(job.timer); job.timer = null; job.toldAt = now();
    for (const [key, names] of job.waiters) {
      const view = state === 'failed' ? { steps: {} } : viewOf(job, names, final);
      try { onProgress({ key, job: job.token, state, ...view, ...(reason ? { reason } : {}) }); } catch {}
    }
  }
  function writing(job) {
    if (job.timer) return;
    job.timer = setTimeout(() => tell(job, 'writing'), Math.max(0, throttleMs - (now() - (job.toldAt || 0))));
    if (job.timer.unref) job.timer.unref();
  }
  const FIELDS = { step: ['phrase'], summary: ['summary'], group: ['summary', 'phrases'] };
  const emptyText = program => Object.fromEntries(FIELDS[program].map(f => [f, '']));

  function finish(job, outputs) {
    const at = now();
    if (job.program === 'step') {
      const plain = cleanPhrase(outputs && outputs.phrase);
      if (!plain) throw new Error('the model gave no phrase');
      const final = { plain, at };
      phrases.set(job.hash, final);
      return final;
    }
    if (job.program === 'summary') {
      const summary = clip(oneLine(outputs && outputs.summary), SUMMARY_CHARS);
      if (!summary) throw new Error('the model gave no sentence');
      summaries.set(job.groupKey, { summary, at });
      return { summary };
    }
    const a = readAnswer(outputs, job.steps.length);
    if (a.summary) summaries.set(job.groupKey, { summary: a.summary, at });
    // A phrase already kept (written live, alone) stays: it was read closer.
    for (const [n, plain] of Object.entries(a.steps)) {
      const k = job.stepKeys[Number(n) - 1];
      if (k && !phrases.has(k)) phrases.set(k, { plain, at });
    }
    return a;
  }

  function pump() {
    while (running < concurrency && queue.length) {
      const job = jobs.get(queue.shift());
      if (!job || job.running) continue;
      running++; job.running = true;
      const live = {
        text(field, piece) {
          if (!(field in job.text)) return;
          job.text[field] += String(piece || '');
          writing(job);
        },
        retry() { job.text = emptyText(job.program); writing(job); },
      };
      Promise.resolve()
        .then(() => run(job.program, job.inputs, live))
        .then(outputs => {
          const final = finish(job, outputs);
          failures.delete(job.hash);
          save();
          tell(job, 'done', final);
        })
        .catch(error => {
          // A paused model says when it can be asked again; anything else waits retryMs.
          const until = error && error.retryAt ? Number(error.retryAt) : now() + retryMs;
          const reason = String((error && error.message) || error || 'failed').slice(0, 300);
          failures.set(job.hash, { until, reason });
          tell(job, 'failed', null, reason);
        })
        .finally(() => { running--; jobs.delete(job.hash); pump(); });
    }
  }

  // The job for `hash`, made if needed, with this conversation waiting on it.
  // null when it failed a moment ago (it is not asked again yet).
  function ask(hash, key, names, make, fresh) {
    let job = jobs.get(hash);
    if (!job) {
      const failed = failures.get(hash);
      if (failed && failed.until > now()) return null;
      job = { hash, token: tokenOf(hash), waiters: new Map(), running: false, timer: null, toldAt: 0, ...make() };
      job.text = emptyText(job.program);
      jobs.set(hash, job);
    }
    if (job.program === 'step') {
      const set = job.waiters.get(key) || new Set();
      for (const n of names) set.add(n);
      job.waiters.set(key, set);
    } else job.waiters.set(key, names);
    if (!job.running) fresh.push(hash);
    return job;
  }

  /**
   * The page names the groups on its screen, of one conversation:
   * [{ g, steps: [names], settled }]. settled: the group will not grow (its
   * work is finished); only then does it get its sentence. `conversation`:
   * its snapshot, or indexConversation of it; `live`: steps of the run in
   * progress (resolveStep). Answers what is known and starts what is not:
   * groups[g] = { summary?, steps: {name: phrase}, writing: {name|'': text so
   * far}, jobs: [tokens the page will hear about] }. No jobs: nothing more
   * will come for now (a step not finished yet is asked again when it is).
   */
  function lookup(conversation, groups, { key = '', live = null } = {}) {
    const ix = conversation && conversation.tools instanceof Map ? conversation : indexConversation(conversation || {});
    const label = model();
    const out = { groups: {} };
    const fresh = [];
    const at = now();
    for (const group of groups) {
      const steps = [];
      for (const name of [...new Set(group.steps || [])]) {
        if (steps.length >= MAX_STEPS) break;
        const s = resolveStep(ix, name, live);
        if (s) steps.push({ ...s, key: stepKey(label, s.identity) });
      }
      const res = { steps: {}, jobs: [] };
      out.groups[group.g] = res;
      if (!steps.length) continue;
      const request = requestFor(ix, steps);
      const missing = [];
      for (const s of steps) {
        const known = phrases.get(s.key);
        if (known) { known.at = at; res.steps[s.name] = known.plain; } else missing.push(s);
      }
      const wait = job => { if (job && !res.jobs.includes(job.token)) res.jobs.push(job.token); return job; };
      const alone = list => { for (const s of list) wait(ask(s.key, key, [s.name], () => ({ program: 'step', inputs: { request, thought_before: s.before || 'none', step: stepText(s, STEP_BUDGET) } }), fresh)); };
      if (!group.settled) { alone(missing); continue; }

      const gk = groupKey(label, request, steps);
      const summary = summaries.get(gk);
      if (summary) { summary.at = at; res.summary = summary.summary; }
      const inGroupCall = jobs.get('g' + gk);
      if (inGroupCall) { wait(ask('g' + gk, key, steps.map(s => s.name), null, fresh)); continue; }
      // Steps already being explained alone are coming; the rest decide.
      const coming = missing.filter(s => jobs.has(s.key));
      const rest = missing.filter(s => !jobs.has(s.key) && !(failures.get(s.key)?.until > at));
      alone(coming);
      if (!summary && rest.length > GROUP_CALL_ABOVE) {
        wait(ask('g' + gk, key, steps.map(s => s.name), () => ({ program: 'group', groupKey: gk, steps, stepKeys: steps.map(s => s.key), inputs: groupInputs(request, steps) }), fresh));
        continue;
      }
      alone(rest.length <= GROUP_CALL_ABOVE ? rest : []);
      // Every phrase is here: the sentence reads them, not the commands again.
      if (!summary && !res.jobs.length && steps.every(s => res.steps[s.name])) {
        wait(ask('s' + gk, key, true, () => ({ program: 'summary', groupKey: gk, inputs: { request, phrases: steps.map((s, i) => `${i + 1}. ${res.steps[s.name]}`).join('\n') } }), fresh));
      }
    }
    // What is written so far of the calls this page will hear about.
    for (const res of Object.values(out.groups)) {
      for (const token of res.jobs) {
        const job = [...jobs.values()].find(j => j.token === token);
        if (!job || !Object.values(job.text).some(t => t.trim())) continue;
        const view = viewOf(job, job.waiters.get(key));
        res.writing = res.writing || {};
        if (view.summary) res.writing[''] = view.summary;
        for (const [n, p] of Object.entries(view.steps)) if (!res.steps[n]) res.writing[n] = p;
      }
    }
    // Their last use moved in memory; it is written with the next answer.
    if (fresh.length) {
      const asked = new Set(fresh);
      // What is asked now goes first; a backlog from scrolling past is dropped
      // (what is still on screen will ask again).
      const next = [...new Set(fresh), ...queue.filter(h => !asked.has(h))];
      for (const h of next.slice(maxQueue)) if (!jobs.get(h)?.running) jobs.delete(h);
      queue = next.slice(0, maxQueue);
      pump();
    }
    return out;
  }

  return { lookup, stats: () => ({ phrases: phrases.size, summaries: summaries.size, running, queued: queue.length, failures: failures.size }) };
}

module.exports = { createPlainSteps, indexConversation, resolveStep, groupInputs, readAnswer, readPhrases, STEP_ID, MAX_STEPS };
