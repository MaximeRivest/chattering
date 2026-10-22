'use strict';
// The frog (design/102): one conversation a person talks to, which
// steers all the others. This module holds what is the frog's own and
// can be tested without the server:
//
// · state      which conversation is the frog, and where its home
//              folder (the "assistant" project) is;
// · asks       "tell me / ping me / call me when X finishes or crashes":
//              durable watches on conversations, checked when a run ends;
// · events     what reaches the frog from outside a person's message
//              (a watched run ended, a script on the server said something),
//              queued while it is busy and delivered one turn at a time;
// · workspace  the compact picture of who is working on what, built from
//              the server's index, inbox state and runs;
// · refs       short conversation ids, the ones the records tools print
//              (conversation-ids.js: 8 characters of the session id,
//              longer where another conversation shares them).
//
// Everything that touches runs, files or devices is a dependency the
// server passes in, so the rules here stay small and testable.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const convIds = require('./conversation-ids.js');

const WHEN = ['done', 'failed', 'question'];
// The frog's model, everywhere it thinks (its turns, its memory): the
// person's choice, this by default (Claude Opus 5.5 through the Claude
// subscription in Pi). Only the walkie-talkie's end-of-turn check is not it.
const DEFAULT_MODEL = 'claude-code/claude-opus-5-5';
// The walkie-talkie: how sure the end-of-turn check must be.
const TURN_SEND_AT = 0.85;   // sent
const TURN_ASK_AT = 0.5;     // "Send it?", sent on a click or on the next "over"
// Talk (its replies spoken) lasts while a page that talks with it says so:
// a page closed mid-talk leaves no frog speaking in an empty room.
const TALK_KEEP_MS = 5 * 60 * 1000;
// Words that hand the turn over, as they close what was said. Taken off the
// message when they are there; the check decides, these only clean.
const HAND_OVER = /(?:^|[\s,.;:!?—-])(?:(?:ok(?:ay)?|so|alright|right|and|well)[\s,]+)*(?:over(?:\s+(?:to\s+you|and\s+out|to\s+the\s+frog))?|(?:back\s+)?to\s+you|your\s+turn|go\s+ahead|(?:i'?m\s+|i\s+am\s+)?done|that'?s\s+(?:it|all)|that\s+is\s+(?:it|all)|send\s+it|you\s+go)(?:[\s,]+(?:frog|please|thanks|thank\s+you))*[\s.!?…]*$/i;
const THEN = ['tell', 'notify', 'call'];
const EVENT_TEXT_MAX = 4000;
const QUEUE_MAX = 50;
const WATCHES_MAX = 200;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function clip(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : s;
}
function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 48) return h + ' h ago';
  return Math.round(h / 24) + ' d ago';
}

// A conversation's short id, as `chattering show` and the records tools
// print it: unique among the conversations in `index`.
function refOf(index, key) {
  return convIds.shortIdOf(index, key);
}
// A ref (or a full key) back to its key: { key }, or { keys } when it names
// none or several (the caller says which, with `describeRef`). Never a pick.
function resolveRef(index, ref) {
  return convIds.resolveShortId(index, ref);
}
// The candidates of an ambiguous ref, one line each, with their ids now.
function describeRef(index, keys) {
  return convIds.describeMatches(index, keys);
}

// The path a Pi session file is on now: from its last entry back to the root
// through parentId. Only messages, with their entry ids, so the frog can
// branch or fork at one of them.
// `at`: an entry id (as a memory line names one): the messages around it on
// the path instead of the newest, `last` of them, the named one last but
// a few.
function piBranchMessages(raw, { last = 12, chars = 1500, at = null } = {}) {
  const byId = new Map();
  let leaf = null;
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || d.type === 'session' || typeof d.id !== 'string') continue;
    byId.set(d.id, d);
    leaf = d;
  }
  const chain = [];
  for (let e = leaf, guard = 0; e && guard < 100000; e = byId.get(e.parentId), guard++) chain.push(e);
  chain.reverse();
  const out = [];
  for (const e of chain) {
    if (e.type === 'message' && e.message && (e.message.role === 'user' || e.message.role === 'assistant')) {
      const c = e.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : '';
      const tools = Array.isArray(c) ? c.filter(b => b && b.type === 'toolCall').map(b => b.name) : [];
      if (!text.trim() && !tools.length) continue;
      out.push({ entryId: e.id, role: e.message.role, text: text.length > chars ? text.slice(0, chars) + ' […]' : text, ...(tools.length ? { tools } : {}), at: e.timestamp || null });
    } else if (e.type === 'custom_message' && e.customType) {
      const c = e.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : '';
      out.push({ entryId: e.id, role: 'event', kind: e.customType, text: clip(text, chars), at: e.timestamp || null });
    }
  }
  const n = Math.max(1, last);
  if (at) {
    const k = out.findIndex(m => m.entryId === at);
    if (k < 0) return { leaf: leaf ? leaf.id : null, total: out.length, messages: [], note: 'no message with entry id ' + at + ' on this conversation\u2019s path' };
    const end = Math.min(out.length, k + Math.max(1, Math.floor(n / 4)) + 1);
    return { leaf: leaf ? leaf.id : null, total: out.length, around: at, messages: out.slice(Math.max(0, end - n), end) };
  }
  return { leaf: leaf ? leaf.id : null, total: out.length, messages: out.slice(-n) };
}

// What the person heard of a spoken turn, when they stopped it in \`clip\`
// at \`ms\` (the clip's own time). \`items\`: the turn's pieces in order,
// { texts, clip, runs: [{ text, startMs, endMs }] } (runs once made). A
// sentence playing then is \`partial\`. Null when that clip is not this turn's.
function heardSplit(items, clip, ms) {
  const at = Math.max(0, Number(ms) || 0);
  const heard = [], unheard = [];
  let partial = null, reached = false;
  for (const item of items) {
    if (!reached && item.clip === clip) {
      reached = true;
      for (const r of item.runs || item.texts.map(text => ({ text, startMs: 0, endMs: Infinity }))) {
        if (r.endMs <= at) heard.push(r.text);
        else if (r.startMs < at && !partial) partial = r.text;
        else unheard.push(r.text);
      }
    } else if (!reached) heard.push(...item.texts);
    else unheard.push(...item.texts);
  }
  return reached ? { heard, partial, unheard } : null;
}
// Where to go on after an aside (design/102): the start of the sentence
// the person cut into, in the clip's own time. A piece holds several
// sentences made at once; within it, sentences are placed by their length
// (Kokoro's pace is even enough), and a beat earlier, so the sentence is
// heard whole. Null when the clip is not this turn's.
function resumePoint(items, clip, ms) {
  const at = Math.max(0, Number(ms) || 0);
  const item = items.find(i => i.clip === clip);
  if (!item) return null;
  const runs = item.runs || [];
  const run = runs.find(r => r.startMs <= at && at < r.endMs) || [...runs].reverse().find(r => r.startMs <= at);
  if (!run) return 0;
  const parts = String(run.text).split(/(?<=[.!?…]["')\]]*)\s+/).filter(Boolean);
  const total = parts.reduce((n, p) => n + p.length + 1, 0) || 1;
  let start = run.startMs, chars = 0;
  for (const p of parts) {
    const begin = run.startMs + (run.endMs - run.startMs) * chars / total;
    if (begin > at) break;
    start = begin;
    chars += p.length + 1;
  }
  return Math.max(0, Math.round(start - 150));
}

// The note for the frog's next turn: where its reading was stopped.
function cutNote(c) {
  if (!c) return '';
  const tail = list => clip(list.slice(-2).join(' '), 400);
  const rest = clip((c.unheard || []).join(' '), 1500);
  // "Frog, stop": on purpose. They know there was more and did not want it
  // (design/102): it is not offered again, nor repeated, nor summarized.
  if (c.state === 'stopped') {
    const lines = ['The person stopped your last reply on purpose while it was being read aloud ("frog, stop").'];
    if (c.heard && c.heard.length) lines.push('The last they heard: "' + tail(c.heard) + '"');
    if (c.heard && !c.heard.length && !c.partial) lines.push('They heard none of it.');
    if (c.partial) lines.push('They stopped you during: "' + clip(c.partial, 400) + '"');
    lines.push('They did not hear the rest, and did not want to. Do not offer it, repeat it or sum it up, and do not mention that there was more, unless they ask for it. Answer their new message as it is.');
    return lines.join('\n');
  }
  const lines = [c.state === 'paused'
    ? 'The person paused your last reply while it was being read aloud, and did not resume it.'
    : 'The person cut off your last reply while it was being read aloud.'];
  if (c.heard && c.heard.length) lines.push('The last they heard: "' + tail(c.heard) + '"');
  if (c.heard && !c.heard.length && !c.partial) lines.push('They heard none of it.');
  if (c.partial) lines.push('They were in the middle of: "' + clip(c.partial, 400) + '"');
  if (rest) lines.push('They did not hear: "' + rest + '"');
  lines.push('Answer their new message with this in mind: if it is about what they missed, or asks you to go on, continue from where they stopped without repeating what they heard; if it is about something else, answer it, and if what they missed matters, say so in one short sentence and offer the rest.');
  return lines.join('\n');
}

// A message without the words that handed it over: { text, phrase }.
// "Over" said as a sentence of its own earlier in the turn ("…the message.
// Over. Hello. Over.") was an attempt to hand over that did not take (the
// person heard nothing back and said it again): not part of the message.
const LONE_OVER = /(?<=^|[.!?…]\s*)\s*over(?:\s+(?:to\s+you|and\s+out))?\s*[.!?…]+(?=\s|$)/gi;
function stripHandOver(text) {
  const src = String(text || '');
  const m = HAND_OVER.exec(src);
  const tidy = s => s.replace(LONE_OVER, '').replace(/\s{2,}/g, ' ').trim();
  if (!m) return { text: tidy(src), phrase: '' };
  const kept = tidy(src.slice(0, m.index).replace(/[\s,;:—-]+$/, ''));
  return { text: kept, phrase: m[0].replace(/^[\s,.;:!?—-]+/, '').trim() };
}
// "provider/model" → { provider, modelId }, or null.
function modelParts(model) {
  const s = String(model || '').trim();
  const i = s.indexOf('/');
  return i > 0 && i < s.length - 1 ? { provider: s.slice(0, i), modelId: s.slice(i + 1) } : null;
}
// What the end-of-turn check's answer means for the message.
// Two signals: Jev's probability, and whether a hand-over phrase closes
// the words (HAND_OVER). Alone, Jev must be sure (0.85) to send. When the
// words end in "over" and Jev leans the same way (0.5), the two agree:
// sent. "It seems to work well right now, over" got 0.73 from Jev and was
// only asked about (2026-10-19), so the person had to say it again; "the
// training is over" still gets Jev's low probability and is not sent.
// How strongly the words themselves say hand-over (the second signal):
// 'strong': a phrase that means nothing else ("over to you", "your turn",
// "back to you", "over and out", "send it"), or a lone "over" after a word
// that cannot take it as a predicate ("done now over", "working over");
// 'weak': "over" after a copula or verb ("is over", "take over", "it's
// over"); 'none': no closing phrase.
const OVER_PREDICATE = new Set(['is', 'was', 'are', 'were', 'be', 'been', 'being', 'its', 'thats', 'whats', 's', 'not', 'almost', 'nearly', 'all', 'game', 'take', 'took', 'taking', 'start', 'started', 'hand', 'handed', 'roll', 'come', 'came', 'run', 'ran', 'think', 'go', 'went', 'carry', 'look', 'get', 'got', 'fall', 'fell', 'turn', 'turned', 'flip', 'pull', 'pulled', 'do', 'did', 'half', 'left', 'way', 'bent', 'win', 'won', 'spill', 'spilled']);
function handOverStrength(text) {
  const { phrase } = stripHandOver(text);
  if (!phrase) return 'none';
  const words = String(text || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z]+/).filter(Boolean);
  const p = phrase.toLowerCase().replace(/[’']/g, '').split(/[^a-z]+/).filter(Boolean);
  if (p.length > 1 && p[0] !== 'over' || /^(?:over\s+(?:to\s+you|and\s+out))$/.test(p.join(' '))) return 'strong';
  if (p[0] !== 'over') return 'weak';
  const at = words.lastIndexOf('over');
  const before = at > 0 ? words[at - 1] : '';
  return before && !OVER_PREDICATE.has(before) ? 'strong' : 'weak';
}
// Jev at 0.85 sends alone. With a weak closing phrase, 0.5 (the two
// agree). With a strong one, Jev would have to be sure it is not (0.15):
// "so is the restart done now over" got 0.37 and was held (2026-10-19).
const TURN_WEAK_AT = TURN_ASK_AT, TURN_STRONG_AT = 0.15;
function turnDecision(probabilities, { closesWithHandOver = false, strength = null } = {}) {
  const p = Number(probabilities && probabilities.turn && probabilities.turn.handed_over);
  const sure = Number.isFinite(p) ? p : 0;
  const st = strength || (closesWithHandOver ? 'weak' : 'none');
  const sendAt = st === 'strong' ? TURN_STRONG_AT : st === 'weak' ? TURN_WEAK_AT : TURN_SEND_AT;
  return { handedOver: sure, send: sure >= sendAt, ask: !(sure >= sendAt) && sure >= TURN_ASK_AT && sure < TURN_SEND_AT, strength: st };
}

function createFrog({ dir, homeFolder, now = Date.now, log = () => {} } = {}) {
  if (!dir) throw new Error('frog: dir is required');
  const STATE_FILE = path.join(dir, 'state.json');
  const WATCH_FILE = path.join(dir, 'watches.json');
  const QUEUE_FILE = path.join(dir, 'events.json');
  const READS_FILE = path.join(dir, 'told.json');
  const ASIDES_FILE = path.join(dir, 'asides.json');
  const state = { key: null, folder: homeFolder || null, createdAt: null, model: DEFAULT_MODEL, talk: false, speed: null, ...readJson(STATE_FILE, {}) };
  if (!modelParts(state.model)) state.model = DEFAULT_MODEL;
  let watches = Array.isArray(readJson(WATCH_FILE, [])) ? readJson(WATCH_FILE, []) : [];
  let queue = Array.isArray(readJson(QUEUE_FILE, [])) ? readJson(QUEUE_FILE, []) : [];
  let told = Array.isArray(readJson(READS_FILE, [])) ? readJson(READS_FILE, []) : [];
  let asides = Array.isArray(readJson(ASIDES_FILE, [])) ? readJson(ASIDES_FILE, []) : [];

  const saveState = () => writeJson(STATE_FILE, state);
  const saveWatches = () => writeJson(WATCH_FILE, watches);
  const saveQueue = () => writeJson(QUEUE_FILE, queue);
  const saveTold = () => writeJson(READS_FILE, told);

  function setHome({ key, folder }) {
    if (key !== undefined) state.key = key || null;
    if (folder !== undefined) state.folder = folder || null;
    if (state.key && !state.createdAt) state.createdAt = now();
    saveState();
    return { ...state };
  }

  function setModel(model) {
    const m = typeof model === 'object' && model ? (model.provider && (model.modelId || model.model) ? model.provider + '/' + (model.modelId || model.model) : '') : String(model || '');
    if (!modelParts(m)) throw new Error('a model is provider/model, like ' + DEFAULT_MODEL);
    if (m === state.model) return false;
    state.model = m;
    saveState();
    return true;
  }
  // Its memory (design/102, part 3) has a switch of its own, on unless
  // turned off: the machine's "automatic memory" (project notes for every
  // conversation) is another question, answered elsewhere.
  const memoryOn = () => state.memory !== false;
  function setMemory(on) {
    state.memory = on !== false;
    state.memoryAt = now();
    saveState();
    return memoryOn();
  }
  function setTalk({ on, speed }) {
    if (on !== undefined) { state.talk = on === true; state.talkAt = now(); }
    if (speed !== undefined) {
      const n = Number(speed);
      state.speed = speed === null ? null : Number.isFinite(n) ? Math.max(0.7, Math.min(2.5, Math.round(n * 20) / 20)) : state.speed;
    }
    saveState();
    return { talk: !!state.talk && now() - (state.talkAt || 0) < TALK_KEEP_MS, speed: state.speed };
  }

  // ---- asks ---------------------------------------------------------------
  function addWatch({ key, title, when, then, note, repeat }) {
    if (!key) throw new Error('which conversation?');
    const w = Array.isArray(when) && when.length ? [...new Set(when.map(String))] : WHEN.slice();
    for (const x of w) if (!WHEN.includes(x)) throw new Error('when is one of: ' + WHEN.join(', '));
    const t = String(then || 'tell');
    if (!THEN.includes(t)) throw new Error('then is one of: ' + THEN.join(', '));
    if (watches.length >= WATCHES_MAX) throw new Error('too many asks; remove some first');
    const watch = { id: 'w' + crypto.randomBytes(4).toString('hex'), key, title: clip(title, 120), when: w, then: t,
      note: clip(note, 500), repeat: repeat === true, createdAt: now() };
    watches.push(watch);
    saveWatches();
    return watch;
  }
  function removeWatch(id) {
    const before = watches.length;
    watches = watches.filter(w => w.id !== id);
    if (watches.length === before) throw new Error('no such ask: ' + id);
    saveWatches();
    return { removed: id };
  }
  function listWatches() { return watches.map(w => ({ ...w })); }

  // A run ended in `key`. Which asks fire, and how the run ended:
  // failed (an error or a crash), question (the reply ends by asking the
  // person), done (anything else, stopped by a person included).
  function outcomeOf({ status, asks }) {
    if (status === 'error' || status === 'failed') return 'failed';
    if (asks) return 'question';
    return 'done';
  }
  function runEnded({ key, title, status, statusText, error, excerpt, asks }) {
    if (!key) return [];
    const outcome = outcomeOf({ status, asks });
    const fired = [];
    const keep = [];
    for (const w of watches) {
      if (w.key === key && w.when.includes(outcome)) {
        fired.push({ watch: w, outcome });
        if (w.repeat) keep.push(w);
      } else keep.push(w);
    }
    if (fired.length) { watches = keep; saveWatches(); }
    return fired.map(({ watch, outcome: o }) => ({
      watch, outcome: o,
      text: [
        `Ask ${watch.id} fired: "${watch.title || title || key}" ${o === 'failed' ? 'stopped with an error' : o === 'question' ? 'is waiting for an answer' : 'finished'}.`,
        error || (o === 'failed' && statusText) ? 'Error: ' + clip(error || statusText, 400) : '',
        excerpt ? 'Its last words: ' + clip(excerpt, 600) : '',
        watch.note ? 'The person asked: ' + watch.note : '',
        `The person wanted: ${watch.then === 'call' ? 'a call' : watch.then === 'notify' ? 'a notification on their phone' : 'to be told'}.`,
      ].filter(Boolean).join('\n'),
    }));
  }

  // ---- events --------------------------------------------------------------
  // An event for the frog. Kept on disk until a turn delivers it.
  function pushEvent({ text, source, details }) {
    const body = clip(String(text || ''), EVENT_TEXT_MAX);
    if (!body) throw new Error('an event needs text');
    const ev = { id: 'e' + crypto.randomBytes(4).toString('hex'), at: now(), source: clip(source || 'server', 80), text: body, details: details && typeof details === 'object' ? details : undefined };
    queue.push(ev);
    if (queue.length > QUEUE_MAX) queue = queue.slice(-QUEUE_MAX);
    saveQueue();
    return ev;
  }
  // Every waiting event as one message, oldest first; the queue empties
  // only when the caller says it was delivered (`ack`).
  function pendingEvents() { return queue.map(e => ({ ...e })); }
  function ack(ids) {
    const set = new Set(ids);
    const before = queue.length;
    queue = queue.filter(e => !set.has(e.id));
    if (queue.length !== before) saveQueue();
  }
  function eventMessage(events) {
    const lines = events.map(e => `[${new Date(e.at).toISOString().slice(11, 16)} · ${e.source}] ${e.text}`);
    return {
      customType: 'frog-event',
      content: (events.length === 1 ? 'Something happened while you were waiting:\n\n' : events.length + ' things happened while you were waiting:\n\n') + lines.join('\n\n')
        + '\n\nDecide what the person needs: tell them briefly, ping or call them if their ask said so, or just keep it for when they ask. You may act on it with your tools.',
      details: { events: events.map(e => ({ id: e.id, at: e.at, source: e.source })) },
    };
  }

  // ---- asides ----------------------------------------------------------
  // A thought the person dropped while the frog was speaking: noted, and
  // kept as a thread to come back to once what it was saying is finished.
  const saveAsides = () => writeJson(ASIDES_FILE, asides);
  function addAside({ text, during }) {
    const a = { id: 'a' + crypto.randomBytes(3).toString('hex'), text: clip(text, 2000), during: clip(during, 300) || undefined, at: now(), done: false };
    if (!a.text) throw new Error('an aside needs words');
    asides.push(a);
    asides = asides.filter(x => !x.done || now() - x.at < 7 * 24 * 3600e3).slice(-100);
    saveAsides();
    return { ...a };
  }
  const openAsides = () => asides.filter(a => !a.done).map(a => ({ ...a }));
  function closeAsides(ids) {
    const set = new Set(ids); let n = 0;
    for (const a of asides) if (set.has(a.id) && !a.done) { a.done = true; n++; }
    if (n) saveAsides();
    return n;
  }
  function asidesText() {
    const open = openAsides();
    if (!open.length) return '';
    return 'Asides the person dropped while you were speaking, open threads to come back to (' + open.length + '):\n'
      + open.map((a, i) => `${i + 1}. [${a.id}] "${a.text}"` + (a.during ? ` (said during: "${a.during}")` : '')).join('\n')
      + '\nYou answered each with only "noted" and went on. Come back to them once what you were saying is finished and the person has nothing more pressing: one at a time, briefly, the first first, and ask before the next. Close each with the asides tool when it is dealt with, or when the person drops it.';
  }

  // ---- replies the frog told the person about ----------------------------
  // The frog says it told the person what a reply says, fully enough that
  // they need not open it. That is not yet received: the frog's own answer
  // must reach them first. So a told reply waits until the frog's turn has
  // ended (its answer exists) and then until the person has it: they read
  // the frog's conversation, or they send it their next message. Applied
  // only if the conversation said nothing new since it was told (else the
  // new part is unread, as it should be). Kept a day at most.
  const TOLD_KEEP_MS = 24 * 3600 * 1000;
  function toldAbout(keys, why) {
    const at = now(), set = new Set(keys);
    told = told.filter(r => !set.has(r.key));
    for (const key of set) told.push({ key, at, ready: false, why: clip(why, 200) || undefined });
    saveTold();
    return { waiting: [...set] };
  }
  function untold(keys) {
    const set = new Set(keys), before = told.length;
    told = told.filter(r => !set.has(r.key));
    if (told.length !== before) saveTold();
  }
  // The frog's turn ended: what it told during it is in its answer now.
  function turnEnded() {
    let changed = false;
    for (const r of told) if (!r.ready) { r.ready = true; changed = true; }
    if (changed) saveTold();
  }
  // The person has the frog's answer: the told replies to mark read, each
  // only while nothing newer happened there (\`activity(key)\`: its last
  // activity, ms). Those still in a running turn wait.
  function received(activity) {
    const t = now(), apply = [], keep = [];
    for (const r of told) {
      if (t - r.at > TOLD_KEEP_MS) continue;
      if (!r.ready) { keep.push(r); continue; }
      if ((Number(activity(r.key)) || 0) <= r.at) apply.push(r.key);
    }
    const changed = told.length !== keep.length;
    told = keep;
    if (changed) saveTold();
    return apply;
  }
  const toldKeys = () => new Set(told.map(r => r.key));

  // ---- workspace -------------------------------------------------------
  // `rows`: [{ key, entry, listed, unread, group, pinned }], `runs`: running
  // web jobs by key, `terminals`: keys an agent's program holds, `index`:
  // every conversation on record (ids are unique within it).
  function workspace({ rows, runs, terminals, groups, projectOf, index, limit = 40 }) {
    const t = now();
    const idx = index || Object.fromEntries(rows.map(r => [r.key, r.entry || {}]));
    const ids = convIds.shortIds(idx);
    const working = [], waiting = [], unread = [], stopped = [], quiet = [];
    for (const r of rows) {
      const e = r.entry || {};
      if (r.key === state.key) continue;
      const run = runs.get(r.key);
      const live = terminals.has(r.key);
      const item = {
        id: ids.get(r.key) || refOf(idx, r.key), title: clip(e.timelineTitle || e.title || 'Untitled', 70), project: projectOf(e.cwd, r.key) || 'loose',
        group: r.group || undefined, pinned: r.pinned || undefined,
        // Past half its model's window: said, so the person hears it in time.
        context: r.contextPct >= 50 ? r.contextPct : undefined,
      };
      const last = e.last || null;
      if (run && run.status === 'running') {
        working.push({ ...item, doing: clip(run.statusText || 'working', 50), for: ago(t - (run.startedAt || t)).replace(' ago', '') });
      } else if (live) {
        working.push({ ...item, doing: 'in its own program' });
      } else if (run && (run.status === 'error' || run.status === 'failed') && t - (run.finishedAt || 0) < 6 * 3600e3) {
        stopped.push({ ...item, why: clip(run.error || run.statusText, 120), when: ago(t - (run.finishedAt || t)) });
      } else if (r.listed && last && last.role === 'assistant' && last.asks) {
        waiting.push({ ...item, asks: clip(last.text, 160), when: ago(t - (e.mtimeMs || t)) });
      } else if (r.listed && r.unread) {
        unread.push({ ...item, said: clip(last && last.text, 140), when: ago(t - (e.mtimeMs || t)), ...(told.some(x => x.key === r.key) ? { told: true } : {}) });
      } else if (r.listed) {
        quiet.push({ ...item, when: ago(t - (e.mtimeMs || t)) });
      }
    }
    const data = { working, waiting, stopped, unread, quiet: quiet.slice(0, limit), quietTotal: quiet.length, groups, asks: listWatches().length, events: queue.length };
    return { ...data, text: workspaceText(data) };
  }
  function workspaceText(d) {
    const out = [];
    const row = x => `- ${x.title} [${x.id}] · ${x.project}${x.group ? ' · group ' + x.group : ''}${x.context ? ' · context ' + x.context + '% used' : ''}`;
    out.push(`Working (${d.working.length})` + (d.working.length ? ':' : '.'));
    for (const x of d.working) out.push(row(x) + ` · ${x.doing}${x.for ? ' · ' + x.for : ''}`);
    if (d.waiting.length) { out.push(`Waiting for the person (${d.waiting.length}):`); for (const x of d.waiting) out.push(row(x) + ` · asks: ${x.asks}`); }
    if (d.stopped.length) { out.push(`Stopped with an error (${d.stopped.length}):`); for (const x of d.stopped) out.push(row(x) + ` · ${x.why} · ${x.when}`); }
    if (d.unread.length) { out.push(`Replied, not read yet (${d.unread.length}):`); for (const x of d.unread) out.push(row(x) + ` · ${x.when}${x.told ? ' · you told them; read once they have your answer' : ''}${x.said ? ' · ' + x.said : ''}`); }
    if (d.quietTotal) out.push(`Open and quiet: ${d.quietTotal} more in the side list.`);
    if (d.asks) out.push(`Asks you are watching: ${d.asks}.`);
    return out.join('\n');
  }

  return {
    get key() { return state.key; },
    get folder() { return state.folder; },
    get model() { return state.model; },
    get talk() { return !!state.talk && now() - (state.talkAt || 0) < TALK_KEEP_MS; },
    get speed() { return state.speed; },
    modelParts: () => modelParts(state.model),
    setModel, setTalk,
    home: () => ({ ...state, memory: memoryOn() }),
    memoryOn, setMemory,
    setHome, addAside, openAsides, closeAsides, asidesText, toldAbout, untold, turnEnded, received, toldKeys, addWatch, removeWatch, listWatches, runEnded, pushEvent, pendingEvents, ack, eventMessage, workspace,
    log,
  };
}

module.exports = { createFrog, refOf, resolveRef, describeRef, piBranchMessages, clip, heardSplit, resumePoint, cutNote, stripHandOver, handOverStrength, modelParts, turnDecision, WHEN, THEN, DEFAULT_MODEL, TURN_SEND_AT, TURN_ASK_AT };
