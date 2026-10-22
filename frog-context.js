'use strict';
// What the frog reads of its own past (design/102, part 3, "speed first").
//
// The frog's conversation never ends, and what it re-reads each turn is
// mostly its own steps: tool calls, their results, the workspace notes added
// before each turn, its thinking. Those go stale within a turn or two; the
// messages (what the person said, what the frog answered) are what the
// conversation is, and they are small. Measured on its first day: of ~115k
// tokens, the messages were ~19k.
//
// So before each model call (Pi's `context` hook, request-local: the saved
// conversation is never changed), turns older than the recent ones keep
// their messages whole and lose the rest:
// - workspace notes go (each is stale by the next turn);
// - thinking goes (unless it is all an answer holds);
// - a tool call keeps its name and short arguments (long ones clipped);
// - a tool result keeps its first words, marked as shortened;
// - an event note (an ask that fired, a script's event) is clipped.
// Every call keeps its result, so the provider's pairing of tool calls and
// results holds.
//
// Prompt cache: the provider caches the request's prefix. A cut that moved
// every turn would change the prefix every turn (no cache, slower). The cut
// moves in steps of STEP turns, so between steps the shrunk prefix is the
// same bytes and stays cached; it costs one cache miss every STEP turns.
// Pure: no clock, no files.

const KEEP = 3;          // the last turns read as they were
const STEP = 6;          // the cut moves this many turns at a time
const ARG_CHARS = 240;   // a tool call's string argument, at most
const RESULT_CHARS = 200;
const EVENT_CHARS = 400;
const STALE_NOTES = new Set(['frog-workspace', 'navigator-workspace']);
const EVENT_NOTES = new Set(['frog-event', 'navigator-event', 'frog-asides']);

const clip = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '\u2026' : t;
};
const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n') : '';

// Turns: a run of the person's side (their message, notes, events) and then
// the frog's side (its answers, tool calls, results), in order.
function turnsOf(messages) {
  const turns = [];
  let cur = null, frogSide = false;
  for (const m of messages) {
    const frog = m && (m.role === 'assistant' || m.role === 'toolResult');
    if (!cur || (!frog && frogSide)) { cur = []; turns.push(cur); frogSide = false; }
    cur.push(m);
    if (frog) frogSide = true;
  }
  return turns;
}

// How many leading turns are shrunk, for `n` turns: a multiple of STEP,
// leaving at least KEEP whole.
function cutFor(n, keep = KEEP, step = STEP) {
  return Math.max(0, Math.floor(Math.max(0, n - keep) / step) * step);
}

function shrinkArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = Array.isArray(args) ? [] : {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') out[k] = clip(v, ARG_CHARS);
    else if (v && typeof v === 'object') { const j = JSON.stringify(v); out[k] = j.length > ARG_CHARS ? clip(j, ARG_CHARS) : v; }
    else out[k] = v;
  }
  return out;
}

function shrinkMessage(m, { keepThinking = false } = {}) {
  if (!m || typeof m !== 'object') return m;
  if (m.role === 'custom') {
    if (STALE_NOTES.has(m.customType)) return null;
    if (EVENT_NOTES.has(m.customType)) {
      const t = textOf(m.content);
      return t.length > EVENT_CHARS ? { ...m, content: clip(t, EVENT_CHARS) } : m;
    }
    return m;
  }
  if (m.role === 'assistant' && Array.isArray(m.content)) {
    const kept = keepThinking ? m.content : m.content.filter(b => b && b.type !== 'thinking' && b.type !== 'redacted_thinking');
    const content = (kept.length ? kept : m.content).map(b => b && b.type === 'toolCall' ? { ...b, arguments: shrinkArgs(b.arguments) } : b);
    return { ...m, content };
  }
  if (m.role === 'toolResult') {
    const t = textOf(m.content);
    const images = Array.isArray(m.content) ? m.content.filter(b => b && b.type === 'image').length : 0;
    if (t.length <= RESULT_CHARS && !images) return m;
    const note = '[older result, shortened: ' + t.length + ' characters' + (images ? ', ' + images + ' picture' + (images > 1 ? 's' : '') : '') + ']';
    return { ...m, content: [{ type: 'text', text: (t ? clip(t.trim(), RESULT_CHARS) + '\n' : '') + note }] };
  }
  return m;
}

// The messages the model reads: the old turns shrunk, the recent ones whole.
// Returns { messages, turns, shrunk } (shrunk: how many turns were).
function frogContext(messages, { keep = KEEP, step = STEP, keepThinking = false } = {}) {
  if (!Array.isArray(messages) || !messages.length) return { messages, turns: 0, shrunk: 0 };
  const turns = turnsOf(messages);
  const cut = cutFor(turns.length, keep, step);
  if (!cut) return { messages, turns: turns.length, shrunk: 0 };
  const out = [];
  turns.forEach((turn, i) => {
    for (const m of turn) {
      const s = i < cut ? shrinkMessage(m, { keepThinking }) : m;
      if (s) out.push(s);
    }
  });
  return { messages: out, turns: turns.length, shrunk: cut };
}

// Rough size in characters of what the model reads (for the record).
function sizeOf(messages) {
  let n = 0;
  for (const m of messages || []) {
    if (!m) continue;
    if (typeof m.content === 'string') { n += m.content.length; continue; }
    for (const b of m.content || []) {
      if (!b) continue;
      if (b.type === 'text') n += (b.text || '').length;
      else if (b.type === 'thinking') n += (b.thinking || '').length;
      else if (b.type === 'toolCall') n += JSON.stringify(b.arguments || {}).length + 20;
    }
  }
  return n;
}

module.exports = { frogContext, turnsOf, cutFor, shrinkMessage, sizeOf, KEEP, STEP };
