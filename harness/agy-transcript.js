'use strict';
// Antigravity CLI conversations (Google's terminal agent, `agy`) read into
// the transcript shape the rest of Chattering reads: { meta, messages,
// entryParents }. Read-only: Antigravity owns its files.
//
// Where they are: ~/.gemini/antigravity-cli/conversations/<id>.db, one
// SQLite database per conversation, in write-ahead mode: while `agy` runs,
// new steps are in <id>.db-wal beside it, and the .db file itself may not
// change until SQLite folds them in (the watcher follows both).
//
// Tables used:
//   steps(idx, step_type, status, step_payload)   one row per step; the
//       payload is a protocol-buffer message gemini_coder.Step
//   trajectory_metadata_blob(id 'main', data)     exa.cortex_pb.
//       CortexTrajectoryMetadata: the workspace folder, its git branch, when
//       it began, the parent conversation of a helper agent
//
// The field numbers below come from the message definitions compiled into
// `agy` 1.3.4 (extracted from its binary, 2026-10-14). Protocol buffers never
// renumber a field, so a newer `agy` adds fields this reader ignores; it
// does not move the ones read here. Unknown fields and step kinds are
// skipped, never guessed at.
//
//   Step: 1 type, 4 status, 5 metadata, 19 user_input, 20 planner_response,
//         24 error_message, 31 error, 140 generic (a tool's arguments and
//         result)
//   metadata: 1 created_at, 8 completed_at, 4 tool_call, 9 model_usage
//   tool_call: 1 id, 2 name, 3 arguments_json
//   model_usage: 2 input_tokens, 3 output_tokens, 5 cache_read_tokens
//   user_input: 1 query, 2 user_response, 3 items (1 text), 5 images
//               (1 base64_data, 2 mime_type)
//   planner_response: 1 response, 8 modified_response, 3 thinking,
//               7 tool_calls
//   generic: 1 args (1 key, 2 value), 2 result (1 result text)
//   error details: 1 user_error_message, 2 short_error
//   step status: 6 canceled, 7 error, 12 interrupted
//   step type: 14 user input, 15 planner response, 17 error message,
//              101 system message (114: 1 its text; a hook's injection)
//
// Entry ids are "s<step index>": a step keeps its index while `agy` updates
// it. A conversation is one line.

const path = require('node:path');
const { fileURLToPath } = require('node:url');

const MAX_TEXT = 4000;
const STATUS = { CANCELED: 6, ERROR: 7, INTERRUPTED: 12 };
const TYPE = { USER_INPUT: 14, PLANNER_RESPONSE: 15, ERROR_MESSAGE: 17, SYSTEM_MESSAGE: 101 };
const { switchOf } = require('../agent-modes.js');

function isAgyConversation(relPath) { return /^[0-9a-f-]{36}\.db$/i.test(String(relPath || '')); }
function agyConversationsDir(home = require('node:os').homedir()) { return path.join(home, '.gemini', 'antigravity-cli', 'conversations'); }
function cap(text, n = MAX_TEXT) { const t = String(text == null ? '' : text); return t.length > n ? t.slice(0, n) + '\n… (truncated)' : t; }
function parseJson(value) { try { return JSON.parse(value); } catch { return null; } }

// ---- a minimal protocol-buffer reader (wire format only) ----
// fields(buf) → Map(field number → [values]); a value is a Number for
// varints and fixed widths, a Buffer for length-delimited fields. A buffer
// that is not a valid message gives what was read before the fault.
function fields(buf) {
  const out = new Map();
  if (!Buffer.isBuffer(buf)) return out;
  let i = 0;
  const varint = () => {
    let r = 0, mul = 1, b;
    do {
      if (i >= buf.length) throw new Error('truncated');
      b = buf[i++]; r += (b & 0x7f) * mul; mul *= 128;
    } while (b & 0x80);
    return r;
  };
  try {
    while (i < buf.length) {
      const key = varint(), no = Math.floor(key / 8), wire = key & 7;
      let v;
      if (wire === 0) v = varint();
      else if (wire === 1) { if (i + 8 > buf.length) break; v = buf.readDoubleLE(i); i += 8; }
      else if (wire === 2) { const n = varint(); if (i + n > buf.length) break; v = buf.subarray(i, i + n); i += n; }
      else if (wire === 5) { if (i + 4 > buf.length) break; v = buf.readUInt32LE(i); i += 4; }
      else break; // groups (3, 4) are not used by these messages
      if (!out.has(no)) out.set(no, []);
      out.get(no).push(v);
    }
  } catch {}
  return out;
}
const one = (f, no) => { const v = f.get(no); return v ? v[0] : undefined; };
const all = (f, no) => f.get(no) || [];
const str = v => (Buffer.isBuffer(v) ? v.toString('utf8') : '');
const msg = v => fields(Buffer.isBuffer(v) ? v : null);
const num = v => (typeof v === 'number' ? v : 0);
function isoOf(v) {
  const t = msg(v), s = num(one(t, 1)), n = num(one(t, 2));
  return s > 0 ? new Date(s * 1000 + Math.floor(n / 1e6)).toISOString() : null;
}
function folderOf(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return null;
  try { return fileURLToPath(uri); } catch { return null; }
}

// ---- reading the database ----
function openDb(absPath) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(absPath, { readOnly: true, timeout: 2000 });
}

// The conversation's own facts (CortexTrajectoryMetadata).
function trajectoryMeta(db) {
  let row = null;
  try { row = db.prepare("select data from trajectory_metadata_blob where id = 'main'").get() || db.prepare('select data from trajectory_metadata_blob limit 1').get(); } catch {}
  const f = msg(row && row.data ? Buffer.from(row.data) : null);
  const ws = msg(one(f, 1));
  return {
    cwd: folderOf(str(one(ws, 1))) || folderOf(str(one(f, 7))),
    gitBranch: str(one(ws, 4)) || null,
    createdAt: isoOf(one(f, 2)),
    parentId: str(one(f, 5)) || null,
    rootId: str(one(f, 6)) || null,
    nesting: num(one(f, 17)),
  };
}

function stepsOf(db) {
  return db.prepare('select idx, step_payload from steps order by idx').all()
    .map(r => ({ idx: Number(r.idx), f: fields(r.step_payload ? Buffer.from(r.step_payload) : null) }));
}

// A tool call as Chattering shows any: its name, what it was asked, the
// files it wrote. Arguments from its JSON when there is one (typed), else
// from the step's own list of arguments.
function toolMessageOf(call, genericArgs, cwd) {
  const name = call.name || 'tool';
  const args = parseJson(call.args) || genericArgs || {};
  const abs = p => (typeof p === 'string' && p ? path.resolve(cwd || '/', p.startsWith('file://') ? folderOf(p) || p : p) : null);
  const target = abs(args.TargetFile || args.AbsolutePath || args.FilePath || args.DirectoryPath || args.SearchPath || null);
  const command = typeof args.CommandLine === 'string' ? args.CommandLine : null;
  let text = command || (args.TargetFile || args.AbsolutePath || args.FilePath || args.DirectoryPath) || args.Query || args.Url || args.query || '';
  if (!text) { const shown = { ...args }; delete shown.toolAction; delete shown.toolSummary; text = JSON.stringify(shown); }
  let writes = [];
  if (/^(write_to_file|replace_file_content|multi_replace_file_content|edit_file|create_file)$/.test(name) && target) writes = [target];
  if (command) {
    try {
      const located = require('../task-locations').inspectShell(command, { host: 'local', cwd: abs(args.Cwd) || cwd });
      writes = [...new Set(located.locations.filter(l => l.host === 'local' && l.path && l.role !== 'copy-source').map(l => l.path))].slice(0, 6);
    } catch {}
  }
  // Chattering's own names for reading, writing and editing a file and for
  // a shell command, so "files changed" and the edit links treat them as
  // they treat the other agents'.
  const shown = name === 'view_file' ? 'read' : name === 'write_to_file' ? 'write'
    : /^(replace_file_content|multi_replace_file_content)$/.test(name) ? 'edit' : name === 'run_command' ? 'bash' : name;
  const out = { role: 'tool', name: shown, text: cap(text, 2000), path: target, paths: writes.length ? writes : (target ? [target] : []), id: call.id || null };
  if (typeof args.toolSummary === 'string' && args.toolSummary) out.summary = args.toolSummary;
  if (writes.length) out.writes = writes;
  return out;
}
function callOf(v) { const c = msg(v); return { id: str(one(c, 1)), name: str(one(c, 2)), args: str(one(c, 3)) }; }
function errorText(v) { const e = msg(v); return str(one(e, 1)) || str(one(e, 2)) || ''; }

function parseAgyConversation(absPath, { mtimeMs = null } = {}) {
  const messages = [];
  const meta = { sessionId: path.basename(absPath).replace(/\.db$/i, ''), cwd: null, gitBranch: null, firstTs: null, lastTs: null, rootId: null, parentSession: null, ctx: null,
    agy: { parentId: null, helper: false } };
  const order = [];
  let db;
  try { db = openDb(absPath); } catch (e) { throw new Error('cannot open this Antigravity conversation: ' + e.message); }
  let steps;
  try {
    const t = trajectoryMeta(db);
    meta.cwd = t.cwd; meta.gitBranch = t.gitBranch; meta.firstTs = t.createdAt;
    meta.agy.parentId = t.parentId; meta.agy.helper = !!t.parentId || t.nesting > 0;
    meta.rootId = 'agy:' + (t.rootId || meta.sessionId);
    steps = stepsOf(db);
  } finally { try { db.close(); } catch {} }

  // Tool calls that have a step of their own: shown from that step (with
  // its result), not again from the answer that asked for them.
  const stepped = new Set();
  for (const s of steps) { const c = callOf(one(msg(one(s.f, 5)), 4)); if (c.id) stepped.add(c.id); }
  let lastTs = null;
  for (const s of steps) {
    const f = s.f, type = num(one(f, 1)), status = num(one(f, 4)), md = msg(one(f, 5));
    const ts = isoOf(one(md, 1));
    const eid = 's' + s.idx;
    const before = messages.length;
    const push = m => { m.eid = eid; m.ts = ts; messages.push(m); };
    if (ts) { if (!meta.firstTs) meta.firstTs = ts; lastTs = isoOf(one(md, 8)) || ts; }
    if (type === TYPE.USER_INPUT || one(f, 19)) {
      const u = msg(one(f, 19));
      // A history Chattering put before the first message when the
      // conversation moved here (harness/handoff.js): taken off.
      const text = require('./handoff.js').splitPrompt(str(one(u, 2)) || all(u, 3).map(v => str(one(msg(v), 1))).filter(Boolean).join('\n') || str(one(u, 1))).text;
      const images = all(u, 5).map((v, i) => { const im = msg(v); const mime = str(one(im, 2)) || 'image/png'; return str(one(im, 1)) && /^image\//.test(mime) ? { entry: eid, path: String(i), mime } : null; }).filter(Boolean);
      if (text.trim() || images.length) push({ role: 'user', text, images });
    } else if (type === TYPE.PLANNER_RESPONSE || one(f, 20)) {
      const p = msg(one(f, 20));
      const thinking = str(one(p, 3));
      if (thinking.trim()) push({ role: 'thinking', text: cap(thinking, 8000) });
      const text = str(one(p, 8)) || str(one(p, 1));
      if (text.trim()) push({ role: 'assistant', text, provider: 'agy' });
      for (const v of all(p, 7)) { const c = callOf(v); if (c.name && !stepped.has(c.id)) push(toolMessageOf(c, null, meta.cwd)); }
      const u = msg(one(md, 9));
      const used = num(one(u, 2)) + num(one(u, 3));
      if (used > 0) meta.ctx = { used, provider: 'agy', model: null, window: null };
    } else if (type === TYPE.SYSTEM_MESSAGE || one(f, 114)) {
      // Only Chattering's prompt-mode switches are shown (its hook's
      // injection); Antigravity's own notices are its bookkeeping.
      const mode = switchOf(str(one(msg(one(f, 114)), 1)));
      if (mode) { push({ role: 'event', customType: 'mode-switch', text: mode.key ? 'mode: ' + (mode.label || mode.key) : 'no prompt mode', mode }); meta.agy.mode = mode; }
    } else if (type === TYPE.ERROR_MESSAGE || one(f, 24)) {
      const text = errorText(one(msg(one(f, 24)), 3));
      push({ role: 'abort', text: cap('stopped' + (text ? ': ' + text : ''), 500) });
    } else {
      const call = callOf(one(md, 4));
      if (call.name) {
        const g = msg(one(f, 140));
        const args = {};
        for (const v of all(g, 1)) { const kv = msg(v); args[str(one(kv, 1))] = str(one(kv, 2)); }
        const tool = toolMessageOf(call, Object.keys(args).length ? args : null, meta.cwd);
        push(tool);
        const result = str(one(msg(one(g, 2)), 1));
        const code = /The command exited with code (-?\d+)/.exec(result);
        const failed = status === STATUS.ERROR || (code && Number(code[1]) !== 0);
        if (result.trim() || failed) push({ role: 'toolresult', text: cap(result || errorText(one(f, 31))), images: [], paths: [], tid: call.id || null, err: !!failed });
      }
    }
    if (status === STATUS.CANCELED || status === STATUS.INTERRUPTED) push({ role: 'abort', text: 'interrupted by you' });
    else if (status === STATUS.ERROR && type !== TYPE.ERROR_MESSAGE && !one(md, 4)) {
      const text = errorText(one(f, 31));
      push({ role: 'abort', text: cap('stopped' + (text ? ': ' + text : ''), 500) });
    }
    if (messages.length > before) order.push(eid);
  }
  meta.lastTs = lastTs || (mtimeMs ? new Date(mtimeMs).toISOString() : null);
  if (!meta.firstTs) meta.firstTs = meta.lastTs;
  const entryParents = order.map((id, i) => [id, i ? order[i - 1] : null]);
  return { meta, messages, entryParents };
}

// A picture the person pasted: step "s<idx>", picture number `index`.
function agyImageAt(absPath, entry, index) {
  const m = /^s(\d+)$/.exec(String(entry || ''));
  if (!m) return null;
  let db;
  try {
    db = openDb(absPath);
    const row = db.prepare('select step_payload from steps where idx = ?').get(Number(m[1]));
    if (!row || !row.step_payload) return null;
    const v = all(msg(one(fields(Buffer.from(row.step_payload)), 19)), 5)[Number(index)];
    const im = msg(v), data = str(one(im, 1)), mime = str(one(im, 2)) || 'image/png';
    if (!data || !/^image\/(png|jpeg|gif|webp)$/.test(mime)) return null;
    return { body: Buffer.from(data, 'base64'), mime };
  } catch { return null; } finally { try { db && db.close(); } catch {} }
}

module.exports = { parseAgyConversation, agyImageAt, isAgyConversation, agyConversationsDir, fields, toolMessageOf };
