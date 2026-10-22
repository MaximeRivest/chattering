'use strict';
// Muse Code conversation files (Meta's terminal agent, `muse`) read into the
// transcript shape the rest of Chattering reads: { meta, messages,
// entryParents }. Read-only: Muse Code owns its files.
//
// Where they are: ${XDG_DATA_HOME:-~/.local/share}/muse/sessions/
//   YYYY/MM/DD/<session id>/session.jsonl   one conversation (appended to
//                                            when it is resumed)
//   …/<session id>/subagent/<id>/session.jsonl   its helpers: not
//                                            conversations of their own
//
// The file is an event log, one record per line:
//   { schema_version, id, stream, sequence, recorded_at (µs), payload_type,
//     payload }
// A line may instead be a "retained frame" holding several records, each
// as a JSON string (children[].record_json), or a marker that a live-only
// record was left out (retained_marker). Which records carry what:
//   runtime.user_intent.accepted        what the person sent (surface main)
//   runtime.session, kind run, event:
//     assistant_message_committed       an answer
//     reasoning_committed               reasoning (its text, when not encrypted)
//     assistant_tool_calls_committed    tool calls (name, JSON args, call id)
//     tool_result_batch_committed       their results, by call id
//     model_completed                   the model and its token use
//     terminal                          how the turn ended (completed,
//                                       failed with a reason, cancelled…)
//   runtime.session.route_facts         the folder and the program's pid
//   runtime.session.metadata            the workspace and the model
// Everything else (tasks, reminders, approvals, diagnostics) is Muse Code's
// own bookkeeping, not conversation. Entry ids are the records' own ids
// (stable: the log is only appended to); a conversation is one line.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const MAX_TEXT = 4000;
const { splitMessage } = require('../agent-modes.js');
// A main conversation file, relative to the sessions folder.
const MAIN = /^\d{4}[\\/]\d{2}[\\/]\d{2}[\\/][^\\/]+[\\/]session\.jsonl$/;

function isMuseSession(relPath) { return MAIN.test(String(relPath || '')); }
function cap(text, n = MAX_TEXT) { const t = String(text == null ? '' : text); return t.length > n ? t.slice(0, n) + '\n… (truncated)' : t; }
function parseJson(value) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : null;
  try { return JSON.parse(value); } catch { return null; }
}
// recorded_at is in microseconds since the epoch.
function isoOf(us) { const n = Number(us); return Number.isFinite(n) && n > 0 ? new Date(Math.floor(n / 1000)).toISOString() : null; }

// Where Muse Code keeps its sessions on this computer.
function museSessionsDir(env = process.env, home = require('node:os').homedir()) {
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  return path.join(data, 'muse', 'sessions');
}

// The records of one file, unwrapped, in order.
async function* recordsOf(absPath) {
  const rl = readline.createInterface({ input: fs.createReadStream(absPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const d = parseJson(line);
    if (!d) continue;
    if (d.retained_frame && Array.isArray(d.children)) {
      for (const c of d.children) { const r = parseJson(c && c.record_json); if (r) yield r; }
    } else if (d.payload_type) yield d;
  }
}

function textOfBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : []).filter(b => b && b.kind === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
}
function imagePathsOf(blocks) {
  const out = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || b.kind !== 'image') continue;
    const p = b.path || (b.source && b.source.path) || null;
    if (typeof p === 'string' && p) out.push(p);
  }
  return out;
}

// A tool call shown as Chattering shows any: its name, what it was asked
// (a command, a path), and the files it wrote.
function toolMessage(call, cwd) {
  const name = String(call.name || 'tool');
  const args = parseJson(call.args) || {};
  const abs = p => (typeof p === 'string' && p ? path.resolve(cwd || '/', p) : null);
  let text = '', p = null, writes = [];
  if (typeof args.command === 'string') text = args.command;
  else if (typeof args.path === 'string') text = args.path;
  else text = JSON.stringify(args);
  if (typeof args.path === 'string') p = abs(args.path);
  if (/^(write_file|edit_file)$/.test(name) && p) writes = [p];
  if (name === 'bash' && text) {
    try {
      const located = require('../task-locations').inspectShell(text, { host: 'local', cwd });
      writes = [...new Set(located.locations.filter(l => l.host === 'local' && l.path && l.role !== 'copy-source').map(l => l.path))].slice(0, 6);
    } catch {}
  }
  // Chattering's own names for a file write and an edit, so "files changed"
  // and the edit links treat them as they treat Claude Code's and Pi's.
  const shown = name === 'write_file' ? 'write' : name === 'edit_file' ? 'edit' : name === 'read_file' ? 'read' : name;
  const msg = { role: 'tool', name: shown, text: cap(text, 2000), path: p, paths: writes.length ? writes : (p ? [p] : []), id: call.call_id || call.id || null };
  if (writes.length) msg.writes = writes;
  return msg;
}

// A result's text and whether it failed: Muse Code's shell results are JSON
// ({ output, exit_code, terminal_status }); others are plain text.
function resultOf(text) {
  const parsed = parseJson(text);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && ('output' in parsed || 'exit_code' in parsed)) {
    const exit = Number.isInteger(parsed.exit_code) ? parsed.exit_code : null;
    const failed = (exit != null && exit !== 0) || (typeof parsed.terminal_status === 'string' && parsed.terminal_status !== 'completed');
    return { text: typeof parsed.output === 'string' ? parsed.output : JSON.stringify(parsed.output ?? ''), err: failed };
  }
  return { text: String(text == null ? '' : text), err: false };
}

async function parseMuseSession(absPath, { mtimeMs = null } = {}) {
  const messages = [];
  const meta = { sessionId: null, cwd: null, gitBranch: null, firstTs: null, lastTs: null, rootId: null, parentSession: null, ctx: null,
    muse: { model: null, cliVersion: null, name: null } };
  const order = [];
  let model = null, lastTs = null;
  const push = (msg, id, ts) => { msg.eid = 'm:' + id; msg.ts = ts || null; messages.push(msg); order.push(msg.eid); };
  for await (const r of recordsOf(absPath)) {
    const ts = isoOf(r.recorded_at);
    if (ts) { if (!meta.firstTs) meta.firstTs = ts; lastTs = ts; }
    if (!meta.sessionId && r.stream && r.stream.kind === 'session' && typeof r.stream.id === 'string') meta.sessionId = r.stream.id;
    const p = r.payload && typeof r.payload === 'object' ? r.payload : {};
    const type = r.payload_type;
    if (type === 'runtime.session.route_facts') { const rec = p.record || {}; if (rec.cwd) meta.cwd = meta.cwd || rec.cwd; continue; }
    if (type === 'runtime.session.metadata') {
      const rec = p.record || {};
      if (!meta.cwd && rec.workspace_root) meta.cwd = rec.workspace_root;
      if (rec.model_id) model = rec.model_id;
      if (rec.build && rec.build.semver) meta.muse.cliVersion = rec.build.semver;
      continue;
    }
    if (type === 'session.workspace_branch.observed') {
      const ref = (p.record || {}).reference || {};
      if (ref.kind === 'branch' && typeof ref.name === 'string') meta.gitBranch = ref.name;
      continue;
    }
    if (type === 'run.model.configured') { const rec = p.record || {}; if (rec.model_id) model = rec.model_id; continue; }
    if (type === 'session.name.changed') { if (typeof p.new_name === 'string') meta.muse.name = p.new_name; continue; }
    if (type === 'runtime.user_intent.accepted') {
      // What the person sent in the main conversation (not a helper's).
      if (p.surface && p.surface !== 'main') continue;
      // What the box showed (refill_blocks), unless it folded a paste
      // ("[Pasted Content 2113 chars]"): then what the model was sent.
      const modelBlocks = Array.isArray(p.model_messages) ? p.model_messages.flatMap(m => (m && m.content) || []) : [];
      const shown = Array.isArray(p.refill_blocks) && p.refill_blocks.length ? p.refill_blocks : null;
      const blocks = shown && !/\[Pasted Content \d+ chars\]/.test(textOfBlocks(shown)) ? shown : modelBlocks.length ? modelBlocks : (shown || []);
      // A prompt mode Chattering put before the message (agent-modes.js):
      // shown as a switch, the message as typed.
      const split = splitMessage(require('./handoff.js').splitPrompt(textOfBlocks(blocks)).text);
      const text = split.text;
      if (split.mode) { push({ role: 'event', customType: 'mode-switch', text: split.mode.key ? 'mode: ' + (split.mode.label || split.mode.key) : 'no prompt mode', mode: split.mode }, r.id + ':mode', ts); meta.muse.mode = split.mode; }
      const localImages = imagePathsOf(blocks);
      if (!text.trim() && !localImages.length) continue;
      const kind = p.semantic_kind && p.semantic_kind.kind;
      if (kind && kind !== 'chat') { push({ role: 'event', customType: 'muse-' + kind, text: cap(text) }, r.id, ts); continue; }
      const msg = { role: 'user', text, images: [] };
      if (localImages.length) msg.localImages = localImages;
      push(msg, r.id, ts);
      continue;
    }
    if (type !== 'runtime.session' || p.kind !== 'run' || !p.event) continue;
    const ev = p.event;
    if (ev.kind === 'assistant_message_committed') {
      if (typeof ev.text !== 'string' || !ev.text.trim()) continue;
      const msg = { role: 'assistant', text: ev.text, provider: 'muse' };
      if (model) msg.model = model;
      push(msg, r.id, ts);
    } else if (ev.kind === 'reasoning_committed') {
      if (typeof ev.text === 'string' && ev.text.trim()) push({ role: 'thinking', text: cap(ev.text, 8000) }, r.id, ts);
    } else if (ev.kind === 'assistant_tool_calls_committed') {
      (ev.tool_calls || []).forEach((call, i) => { if (call) push(toolMessage(call, meta.cwd), r.id + ':' + i, ts); });
    } else if (ev.kind === 'tool_result_batch_committed') {
      (ev.results || []).forEach((res, i) => {
        if (!res) return;
        const { text, err } = resultOf(res.text);
        push({ role: 'toolresult', text: cap(text), images: [], paths: [], tid: res.tool_call_id || null, err }, r.id + ':' + i, ts);
      });
    } else if (ev.kind === 'model_completed') {
      if (ev.model) model = ev.model;
      const u = ev.usage || {};
      const used = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0);
      if (used > 0) meta.ctx = { used, provider: 'muse', model: ev.model || model, window: null };
    } else if (ev.kind === 'terminal' && ev.terminal && ev.terminal !== 'completed') {
      const reason = typeof ev.reason === 'string' && ev.reason.trim() ? ev.reason.trim() : '';
      const text = ev.terminal === 'failed' ? 'stopped' + (reason ? ': ' + reason : '')
        : /cancel|interrupt|abort/i.test(ev.terminal) ? 'interrupted by you' : ev.terminal + (reason ? ': ' + reason : '');
      push({ role: 'abort', text: cap(text, 500) }, r.id, ts);
    }
  }
  if (!meta.sessionId) meta.sessionId = path.basename(path.dirname(absPath));
  meta.lastTs = lastTs || (mtimeMs ? new Date(mtimeMs).toISOString() : null);
  if (!meta.firstTs) meta.firstTs = meta.lastTs;
  meta.rootId = meta.sessionId ? 'muse:' + meta.sessionId : null;
  meta.muse.model = model;
  const entryParents = order.map((id, i) => [id, i ? order[i - 1] : null]);
  return { meta, messages, entryParents };
}

module.exports = { parseMuseSession, isMuseSession, museSessionsDir, recordsOf, toolMessage, resultOf };
