'use strict';
// Prompt modes for agents other than Pi (design/87, "Modes for every
// agent"). Pi keeps its own: the modes extension writes each switch into
// Pi's session. Claude Code, Codex, Antigravity and Muse Code have no such
// thing, so Chattering keeps, per conversation, the mode that serves the
// next reply, the switches so far, and what each agent has already been
// given (so a switch is handed over once, never repeated).
//
// The modes themselves are Pi's ModeDef files (~/.pi/agent/modes): one
// library for every agent. Only their words travel (opener, appendix, or a
// whole systemPrompt, which other agents receive as instructions added to
// their own: their tools and built-in instructions are theirs). Pi-only
// fields (removeSections, tools) have no meaning elsewhere and are skipped.
//
// How each agent receives a switch is decided by the server; this module
// only holds the state and writes the words.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// A switch handed to an agent as a message (Codex, Antigravity, Muse Code)
// carries this mark, so readers can show it as a mode switch, not as text.
const MARK = 'chattering-mode';
const MARK_RE = /<!-- chattering-mode (\{[^\n]*?\}) -->/;

// The words a mode adds, under the heading Pi's modes extension uses.
function modeText(def) {
  if (!def) return '';
  const body = String(def.systemPrompt || '').trim() || [def.opener, def.appendix].map(x => String(x || '').trim()).filter(Boolean).join('\n\n');
  return body ? '# Current prompt mode: ' + (def.label || def.key) + '\n' + body : '';
}

// A switch, as a message the agent reads in its conversation: what it
// replaces, then the mode. `def` null: back to no mode.
function switchText(def) {
  const tag = `<!-- ${MARK} ${JSON.stringify({ key: def ? def.key : null, label: def ? (def.label || def.key) : null })} -->`;
  if (!def) return tag + '\nPrompt mode switch from Chattering: no prompt mode from now on. Instructions from any earlier prompt mode no longer apply.';
  return tag + '\nPrompt mode switch from Chattering. From now on, follow this prompt mode; it replaces any earlier one.\n\n' + modeText(def);
}

// A mode block put before a person's message (Muse Code, which takes no
// instructions any other way), and taken off again when it is read.
function messagePrefix(def) {
  return switchText(def) + '\n<!-- /' + MARK + ' -->\n\n';
}
function splitMessage(text) {
  const t = String(text == null ? '' : text);
  const m = MARK_RE.exec(t);
  if (!m || m.index > 2) return { text: t, mode: undefined };
  let info = null; try { info = JSON.parse(m[1]); } catch {}
  const close = '<!-- /' + MARK + ' -->';
  const end = t.indexOf(close);
  const rest = end >= 0 ? t.slice(end + close.length).replace(/^\s+/, '') : '';
  return { text: rest, mode: info ? { key: info.key || null, label: info.label || null } : { key: null, label: null } };
}
// A switch handed over as its own message (Codex, Antigravity): which mode.
function switchOf(text) {
  const m = MARK_RE.exec(String(text || ''));
  if (!m) return undefined;
  try { const info = JSON.parse(m[1]); return { key: info.key || null, label: info.label || null }; } catch { return { key: null, label: null }; }
}

function createAgentModes({ file, now = () => Date.now() }) {
  let data = { conversations: {} };
  try { data = { conversations: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) { console.error('[agent modes] ' + e.message); }
  };
  const get = key => data.conversations[key] || null;

  // The mode now, or null; `def` is the ModeDef as it was when chosen (a
  // later edit of the mode's file applies at the next switch).
  function current(key) { const c = get(key); return c && c.mode ? c.mode : null; }
  function has(key) { const c = get(key); return !!(c && c.history && c.history.length); }

  // A switch: `def` (a ModeDef) or null for no mode. Returns the state.
  function set(key, def) {
    const c = data.conversations[key] || { mode: null, history: [], given: {} };
    const mode = def ? { key: def.key, label: def.label || def.key, def: { key: def.key, label: def.label || def.key,
      ...(def.opener ? { opener: def.opener } : {}), ...(def.appendix ? { appendix: def.appendix } : {}), ...(def.systemPrompt ? { systemPrompt: def.systemPrompt } : {}) },
      id: crypto.randomUUID(), at: new Date(now()).toISOString() } : null;
    const same = (c.mode && c.mode.key) === (mode && mode.key) && JSON.stringify(c.mode && c.mode.def) === JSON.stringify(mode && mode.def);
    if (same && (c.mode || !mode)) return c;
    c.mode = mode || { key: null, label: null, def: null, id: crypto.randomUUID(), at: new Date(now()).toISOString() };
    c.history.push({ key: c.mode.key, label: c.mode.label, at: c.mode.at });
    if (c.history.length > 200) c.history.splice(0, c.history.length - 200);
    data.conversations[key] = c;
    save();
    return c;
  }
  // Whether `channel` (an agent's way in) has been given the current mode.
  function pending(key, channel) {
    const c = get(key);
    return !!(c && c.mode && (c.given || {})[channel] !== c.mode.id);
  }
  function given(key, channel, id = null) {
    const c = get(key);
    if (!c || !c.mode) return;
    c.given = { ...(c.given || {}), [channel]: id || c.mode.id };
    save();
  }
  // A new conversation's temporary key becomes its real one.
  function rekey(from, to) {
    if (!data.conversations[from] || from === to) return;
    data.conversations[to] = data.conversations[from];
    delete data.conversations[from];
    save();
  }
  // A detail kept with the conversation (Antigravity's mode file).
  function note(key, name, value) {
    if (value === undefined) { const c = get(key); return c ? c[name] : undefined; }
    const c = data.conversations[key] || (data.conversations[key] = { mode: null, history: [], given: {} });
    c[name] = value;
    save();
    return value;
  }
  function forget(key) { if (data.conversations[key]) { delete data.conversations[key]; save(); } }
  // What the page shows: the mode serving the next reply.
  function publicState(key) {
    const c = get(key);
    if (!c || !c.mode || !c.mode.key) return null;
    return { key: c.mode.key, label: c.mode.label, at: c.mode.at, switches: c.history.length };
  }
  return { current, has, set, pending, given, rekey, note, forget, publicState, get };
}

module.exports = { createAgentModes, modeText, switchText, messagePrefix, splitMessage, switchOf, MARK };
