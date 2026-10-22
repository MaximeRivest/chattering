'use strict';
// Continuing a conversation in another agent (design/87, "Switching
// agent"). The conversation so far is read in Chattering's common shape
// (any agent's), reduced to turns, and written in the new agent's own
// form, so the new agent takes it as its own history:
//
//   Pi           a Pi session file (its own JSONL), the mode as Pi records it
//   Claude Code  a Claude Code session file (its own JSONL), then resumed
//   Codex        messages added to a new thread (thread/inject_items)
//   Antigravity, Muse Code   no way to load a history: a marked block before
//                the person's first message to them
//
// What carries over: every message the person wrote and every answer,
// word for word; the work in between (commands, files read and changed) as
// a short note under the answer it belongs to, with a bit of each result.
// What does not: reasoning (most agents keep it encrypted, for their own
// model only), pictures (named, not sent), each agent's own private state.
// Too long for a budget: the oldest turns are left out, and the history
// says so.
//
// Everything written here is marked as carried over, so readers leave the
// copies out where the original is shown (the conversation's earlier part).

const crypto = require('node:crypto');

const MARK = 'chattering-handoff';
const MARK_RE = /<!-- chattering-handoff (\{[^\n]*?\}) -->/;
const STEP_RESULT = 400;   // characters of a step's result kept in its note
const STEPS_PER_TURN = 40; // notes under one answer, at most

function oneLine(t, n) { const s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// A step as a past-tense line: what was done, and a bit of what came back.
function stepLine(tool, result) {
  const name = String(tool.name || 'tool');
  const what = oneLine(tool.text || tool.path || '', 300);
  const verb = /^(bash|shell|exec_command|run_command|local_shell|shell_command)$/i.test(name) ? 'ran `' + what + '`'
    : /^(read|view_file|read_file)$/i.test(name) ? 'read ' + what
    : /^(write|write_to_file|write_file|create_file)$/i.test(name) ? 'wrote ' + what
    : /^(edit|multiedit|replace_file_content|multi_replace_file_content|edit_file|apply_patch|str_replace_editor)$/i.test(name) ? 'edited ' + (tool.writes && tool.writes.length ? tool.writes.join(', ') : what)
    : 'used ' + name + (what ? ' (' + what + ')' : '');
  if (!result) return verb;
  const out = oneLine(result.text, STEP_RESULT);
  return verb + (result.err ? ' → failed' : '') + (out ? ': ' + out : '');
}

// The conversation as alternating turns { role, text, agent }, from the
// common message shape. `messages` may span several agents' parts (each
// message's `agent` names whose it was).
function turnsOf(messages, { budget = 240000, agentName = null } = {}) {
  const turns = [];
  const results = new Map();
  for (const m of messages) if (m.role === 'toolresult' && m.tid) results.set(m.tid, m);
  let reply = null; // the answer being gathered: { texts, steps, agent }
  const flush = () => {
    if (!reply) return;
    const parts = [];
    if (reply.steps.length) {
      const shown = reply.steps.slice(0, STEPS_PER_TURN);
      parts.push('(Work done in this turn' + (reply.agent ? ' by ' + reply.agent : '') + ', carried over as notes; not run again:\n' + shown.map(s => '- ' + s).join('\n')
        + (reply.steps.length > shown.length ? '\n- … and ' + (reply.steps.length - shown.length) + ' more steps' : '') + ')');
    }
    parts.push(...reply.texts);
    const body = parts.join('\n\n').trim();
    // Labelled with the agent that gave it: the new agent must not take an
    // earlier agent's answers for its own.
    if (body) turns.push({ role: 'assistant', text: (reply.agent ? '[Answer by ' + reply.agent + ']\n' : '') + body, agent: reply.agent });
    reply = null;
  };
  const replyFor = m => { reply ||= { texts: [], steps: [], agent: null }; reply.agent = reply.agent || m.agentName || agentName || null; return reply; };
  for (const m of messages) {
    if (m.carried) continue;
    if (m.role === 'user') {
      flush();
      let text = String(m.text || '');
      const pics = (m.images || []).length + (m.localImages || []).length;
      if (pics) text += (text ? '\n\n' : '') + '[' + pics + ' picture' + (pics === 1 ? '' : 's') + ' attached here; not carried over]';
      if (!text.trim()) continue;
      const last = turns[turns.length - 1];
      if (last && last.role === 'user') last.text += '\n\n' + text; else turns.push({ role: 'user', text });
    } else if (m.role === 'assistant') {
      if (String(m.text || '').trim()) replyFor(m).texts.push(String(m.text));
    } else if (m.role === 'tool') {
      replyFor(m).steps.push(stepLine(m, m.id ? results.get(m.id) : null));
    } else if (m.role === 'abort') {
      replyFor(m).texts.push('(' + oneLine(m.text || 'stopped', 200) + ')');
    }
  }
  flush();
  // Each agent wants it to start with the person and alternate.
  while (turns.length && turns[0].role !== 'user') turns.shift();
  const merged = [];
  for (const t of turns) { const last = merged[merged.length - 1]; if (last && last.role === t.role) last.text += '\n\n' + t.text; else merged.push({ ...t }); }
  // The newest turns that fit; whole turn pairs, the person's first.
  let used = 0, from = merged.length;
  while (from > 0 && used + merged[from - 1].text.length <= budget) { used += merged[from - 1].text.length; from--; }
  while (from < merged.length && merged[from].role !== 'user') from++;
  const kept = merged.slice(from);
  const left = merged.slice(0, from).filter(t => t.role === 'user').length;
  if (left && kept.length) kept[0] = { ...kept[0], text: '(' + left + ' earlier message' + (left === 1 ? '' : 's') + ' of this conversation left out: too long to carry over.)\n\n' + kept[0].text };
  // It ends on an answer, so the person's next message comes next.
  if (kept.length && kept[kept.length - 1].role === 'user') kept.push({ role: 'assistant', text: '(No answer was given to this message.)' });
  return { turns: kept, left };
}

function tag(info) { return `<!-- ${MARK} ${JSON.stringify(info)} -->`; }

// What the new agent is told after the history: who it was with, that the
// labelled answers were theirs, and that it answers as itself.
function orientation(turns, toName) {
  const agents = [];
  for (const t of turns) if (t.agent && agents[agents.length - 1] !== t.agent) agents.push(t.agent);
  const was = agents.length ? 'with ' + agents.join(', then ') : 'with another agent';
  return '(From Chattering, the app this conversation runs in: until now this conversation was ' + was + '; it continues with you' + (toName ? ', ' + toName : '') + '. Answers labelled [Answer by …] above were theirs, not yours; their work is described in notes and was not run again. Reply normally, as yourself, without such a label.)';
}

// ---- Pi ----
// A Pi session file: its header, the mode as Pi's modes extension records
// it (it checks the definition's SHA-256), then the turns.
function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function piSessionLines({ sessionId, cwd, turns, mode = null, from = null, toName = 'Pi', now = new Date() }) {
  const ts = now.toISOString();
  const id = () => crypto.randomBytes(4).toString('hex');
  const out = [{ type: 'session', version: 3, id: sessionId, timestamp: ts, cwd }];
  let parent = null;
  const add = e => { const eid = id(); out.push({ ...e, id: eid, parentId: parent, timestamp: ts }); parent = eid; };
  if (mode) {
    const definition = { key: mode.key, label: mode.label || mode.key, ...(mode.opener ? { opener: mode.opener } : {}), ...(mode.appendix ? { appendix: mode.appendix } : {}), ...(mode.systemPrompt ? { systemPrompt: mode.systemPrompt } : {}) };
    add({ type: 'custom', customType: 'mode-switch', data: { version: 1, mode: definition.key, definition, source: { kind: 'chattering-handoff' }, sha256: crypto.createHash('sha256').update(canonicalJson(definition)).digest('hex') } });
  }
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (const t of turns) {
    const message = t.role === 'user'
      ? { role: 'user', content: [{ type: 'text', text: t.text }], timestamp: now.getTime() }
      : { role: 'assistant', content: [{ type: 'text', text: t.text }], api: 'chattering-handoff', provider: 'chattering', model: 'carried-over', usage, stopReason: 'stop', timestamp: now.getTime() };
    add({ type: 'message', message, chatteringCarried: from || true });
  }
  if (turns.length) add({ type: 'custom_message', customType: 'chattering-handoff', content: orientation(turns, toName), display: false, chatteringCarried: from || true });
  return out;
}

// ---- Claude Code ----
function claudeSessionLines({ sessionId, cwd, turns, version = '2.1.0', gitBranch = '', from = null, toName = 'Claude Code', now = new Date() }) {
  const ts = now.toISOString();
  const base = { isSidechain: false, userType: 'external', cwd, sessionId, version, gitBranch };
  const out = [];
  let parent = null;
  turns.forEach((t, i) => {
    const uuid = crypto.randomUUID();
    out.push(t.role === 'user'
      ? { ...base, parentUuid: parent, type: 'user', message: { role: 'user', content: t.text }, uuid, timestamp: ts, chatteringCarried: from || true }
      : { ...base, parentUuid: parent, type: 'assistant', message: { id: 'msg_chattering_' + i, type: 'message', role: 'assistant', model: 'carried-over', content: [{ type: 'text', text: t.text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }, uuid, timestamp: ts, chatteringCarried: from || true });
    parent = uuid;
  });
  if (turns.length) out.push({ ...base, parentUuid: parent, type: 'user', isMeta: true, message: { role: 'user', content: orientation(turns, toName) }, uuid: crypto.randomUUID(), timestamp: ts, chatteringCarried: from || true });
  return out;
}

// ---- Codex ----
// Items for thread/inject_items, between two marks so its reader can tell
// the carried copies from the conversation's own.
function codexItems(turns, info = {}) {
  const dev = text => ({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });
  return [
    dev(tag({ ...info, part: 'start' }) + '\nThe messages that follow are this conversation so far, from before it moved to you. Continue it.'),
    ...turns.map(t => t.role === 'user'
      ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: t.text }] }
      : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t.text }] }),
    dev(tag({ ...info, part: 'end' }) + '\nEnd of the conversation so far. The next message is new.\n' + orientation(turns, info.toName || 'Codex')),
  ];
}

// ---- Antigravity, Muse Code ----
// The history as text before the person's first message to the new agent.
function promptBlock(turns, info = {}) {
  const lines = [tag(info), 'This conversation began with ' + (info.fromName || 'another agent') + ' and continues with you. Here it is so far (the person\'s messages and the answers; work done as notes, not run again). Continue from it; my new message follows the history.', ''];
  for (const t of turns) lines.push((t.role === 'user' ? '### The person' : '### Answer' + (t.agent ? ' (' + t.agent + ')' : '')), t.text, '');
  lines.push(orientation(turns, info.toName), '<!-- /' + MARK + ' -->', '', '');
  return lines.join('\n');
}
// A first message with such a block: the block taken off.
function splitPrompt(text) {
  const t = String(text == null ? '' : text);
  const m = MARK_RE.exec(t);
  if (!m || m.index > 2) return { text: t, handoff: undefined };
  const close = '<!-- /' + MARK + ' -->';
  const end = t.indexOf(close);
  let info = {}; try { info = JSON.parse(m[1]); } catch {}
  return { text: end >= 0 ? t.slice(end + close.length).replace(/^\s+/, '') : '', handoff: info };
}
function markOf(text) {
  const m = MARK_RE.exec(String(text || ''));
  if (!m) return undefined;
  try { return JSON.parse(m[1]); } catch { return {}; }
}

module.exports = { turnsOf, stepLine, orientation, piSessionLines, claudeSessionLines, codexItems, promptBlock, splitPrompt, markOf, MARK };
