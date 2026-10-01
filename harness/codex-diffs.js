'use strict';
// The file changes of a Codex conversation (design/87), in the shape
// Chattering already reads for Pi and Claude Code: one "edit" per patch
// hunk (the text before → the text after), one "write" per new file.
// This lights up everything built on those edits for Codex too: the files a
// turn changed and their review, the per-line history, the file ledger.
//
// Codex edits files with its apply_patch tool, recorded two ways:
//   - custom_tool_call name "apply_patch", input = the patch (2025-09 on);
//   - a shell / exec_command whose script runs `apply_patch <<'EOF' … EOF`
//     (earlier Codex).
// Both carry Codex's own patch format:
//   *** Begin Patch
//   *** Update File: path          (then optional "*** Move to: new/path")
//   @@ optional context header
//    context line / -removed line / +added line
//   *** End of File                (optional)
//   *** Add File: path             (+ lines are the whole file)
//   *** Delete File: path
//   *** End Patch
// Paths may be relative: to the turn's working directory.
// Outcomes: the call's output ("Success. Updated the following files" or
// "apply_patch verification failed: …"), or Codex's patch_apply_end event.
// Read-only: nothing here writes a Codex file.

const path = require('node:path');
const { environmentCwd } = require('./codex-transcript');

// Every patch in a text (a shell script can hold several).
function patchesIn(text) {
  const out = [];
  const s = String(text || '');
  let at = 0;
  for (;;) {
    const begin = s.indexOf('*** Begin Patch', at);
    if (begin < 0) break;
    const end = s.indexOf('*** End Patch', begin);
    out.push(s.slice(begin, end < 0 ? s.length : end + '*** End Patch'.length));
    if (end < 0) break;
    at = end + 1;
  }
  return out;
}

// One patch → [{ op: 'add'|'update'|'delete', path, moveTo, hunks: [{ oldText, newText }], content }]
function parsePatch(patch) {
  const files = [];
  let file = null, hunk = null;
  const closeHunk = () => {
    if (file && hunk && (hunk.old.length || hunk.new.length)) {
      file.hunks.push({ oldText: hunk.old.join('\n'), newText: hunk.new.join('\n') });
    }
    hunk = null;
  };
  for (const raw of String(patch || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    let m;
    if (line === '*** Begin Patch' || line === '*** End Patch') { closeHunk(); continue; }
    if ((m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line))) {
      closeHunk();
      file = { op: m[1].toLowerCase(), path: m[2].trim(), moveTo: null, hunks: [], added: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if ((m = /^\*\*\* Move to: (.+)$/.exec(line))) { file.moveTo = m[1].trim(); continue; }
    if (line === '*** End of File') { closeHunk(); continue; }
    if (file.op === 'add') { if (line.startsWith('+')) file.added.push(line.slice(1)); continue; }
    if (file.op !== 'update') continue;
    if (line.startsWith('@@')) { closeHunk(); hunk = { old: [], new: [] }; continue; }
    if (!hunk) hunk = { old: [], new: [] };
    const tag = line[0], body = line.slice(1);
    if (tag === '+') hunk.new.push(body);
    else if (tag === '-') hunk.old.push(body);
    else if (tag === ' ') { hunk.old.push(body); hunk.new.push(body); }
    else if (line === '') { hunk.old.push(''); hunk.new.push(''); } // a blank context line whose space was trimmed
  }
  closeHunk();
  return files.map(f => ({ op: f.op, path: f.path, moveTo: f.moveTo, hunks: f.hunks, content: f.op === 'add' ? f.added.join('\n') + (f.added.length ? '\n' : '') : null }));
}

function outputText(raw) {
  if (typeof raw === 'string') {
    try { const j = JSON.parse(raw); if (j && typeof j.output === 'string') return j.output; } catch {}
    return raw;
  }
  if (Array.isArray(raw)) return raw.map(x => (typeof x === 'string' ? x : x && (x.text || x.output)) || '').join('\n');
  if (raw && typeof raw === 'object') return String(raw.output || raw.text || '');
  return '';
}

function outcomeOf(text) {
  const t = String(text || '');
  if (/apply_patch verification failed|^Error|Failed to (find|apply)|Invalid patch|patch rejected/im.test(t)) return 'failed';
  const exit = /Process exited with code (-?\d+)|"exit_code"\s*:\s*(-?\d+)/.exec(t);
  if (exit) return Number(exit[1] ?? exit[2]) === 0 ? 'applied' : 'failed';
  if (/^Success\b|Updated the following files|Done!/m.test(t)) return 'applied';
  return null;
}

function commandText(args) {
  if (!args || typeof args !== 'object') return '';
  const c = args.cmd ?? args.command;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(String).join('\n');
  return typeof args.input === 'string' ? args.input : '';
}

function parseJson(s) { try { return JSON.parse(s); } catch { return null; } }

// The records of a Codex file (one JSON object per line, or the mid-2025
// { items } document) → [{ callId, ts, cwd, files, outcome, result }].
function codexPatchCalls(records, { cwd = null } = {}) {
  const calls = [], byId = new Map();
  let turnCwd = cwd;
  const items = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    if (Array.isArray(r.items)) { for (const it of r.items) items.push({ item: it, ts: r.session && r.session.timestamp || null }); continue; }
    if (r.type === 'session_meta' && r.payload && r.payload.cwd) turnCwd = turnCwd || r.payload.cwd;
    if (r.type === 'turn_context' && r.payload && r.payload.cwd) { items.push({ cwdChange: r.payload.cwd }); continue; }
    if (r.type === 'response_item' && r.payload) { items.push({ item: r.payload, ts: r.timestamp || null }); continue; }
    if (r.type === 'event_msg' && r.payload && r.payload.type === 'patch_apply_end') { items.push({ applyEnd: r.payload }); continue; }
    // Early JSONL (2025): the raw items themselves, one per line.
    if (!('payload' in r) && typeof r.type === 'string' && (r.type === 'message' || /_call(_output)?$/.test(r.type))) items.push({ item: r, ts: r.timestamp || null });
  }
  for (const x of items) {
    if (x.cwdChange) { turnCwd = x.cwdChange; continue; }
    if (x.applyEnd) {
      const c = byId.get(x.applyEnd.call_id);
      if (c && c.outcome == null) c.outcome = x.applyEnd.success === false ? 'failed' : 'applied';
      continue;
    }
    const it = x.item;
    if (!it || typeof it !== 'object') continue;
    const type = it.type;
    if (type === 'message' && it.role === 'user' && !turnCwd) {
      const text = (Array.isArray(it.content) ? it.content : []).map(c => (c && c.text) || '').join('\n');
      turnCwd = environmentCwd(text) || turnCwd;
      continue;
    }
    if (type === 'custom_tool_call' || type === 'function_call' || type === 'local_shell_call') {
      let text = '';
      if (type === 'custom_tool_call') text = it.name === 'apply_patch' ? String(it.input || '') : '';
      else if (type === 'local_shell_call') text = commandText(it.action || {});
      else if (/^(shell|shell_command|exec_command|container\.exec|local_shell)$/.test(String(it.name || ''))) text = commandText(parseJson(it.arguments) || {});
      else if (it.name === 'apply_patch') { const a = parseJson(it.arguments); text = a && (a.input || a.patch) || ''; }
      if (!text || text.indexOf('*** Begin Patch') < 0) continue;
      const files = patchesIn(text).flatMap(parsePatch);
      if (!files.length) continue;
      const args = type === 'function_call' ? parseJson(it.arguments) || {} : {};
      const workdir = typeof args.workdir === 'string' ? args.workdir : null;
      const call = { callId: it.call_id || it.id || null, ts: x.ts, cwd: workdir ? path.resolve(turnCwd || '/', workdir) : turnCwd, files, outcome: null, result: null };
      calls.push(call);
      if (call.callId) byId.set(call.callId, call);
      continue;
    }
    if (type === 'custom_tool_call_output' || type === 'function_call_output' || type === 'local_shell_call_output') {
      const c = byId.get(it.call_id);
      if (!c) continue;
      const text = outputText(it.output);
      c.result = text.slice(0, 2000);
      const o = outcomeOf(text);
      if (o) c.outcome = o;
    }
  }
  return calls;
}

// The calls → Chattering's edit operations, one per hunk or new file.
// { callId, ts, path, kind: 'edit'|'multi-edit'|'write'|'delete', oldText, newText, editIndex, outcome, result, moveTo }
function codexEditOps(records, opts = {}) {
  const ops = [];
  for (const c of codexPatchCalls(records, opts)) {
    let i = 0;
    for (const f of c.files) {
      const abs = path.isAbsolute(f.path) ? f.path : path.resolve(c.cwd || opts.cwd || '/', f.path);
      const base = { callId: c.callId, ts: c.ts, outcome: c.outcome || 'unknown', result: c.result };
      if (f.op === 'add') ops.push({ ...base, path: abs, kind: 'write', oldText: null, newText: f.content, editIndex: i++ });
      else if (f.op === 'delete') ops.push({ ...base, path: abs, kind: 'delete', oldText: null, newText: null, editIndex: i++ });
      else {
        const target = f.moveTo ? (path.isAbsolute(f.moveTo) ? f.moveTo : path.resolve(c.cwd || opts.cwd || '/', f.moveTo)) : abs;
        const kind = f.hunks.length > 1 ? 'multi-edit' : 'edit';
        for (const h of f.hunks) ops.push({ ...base, path: target, kind, oldText: h.oldText, newText: h.newText, editIndex: i++, movedFrom: f.moveTo ? abs : undefined });
        if (!f.hunks.length && f.moveTo) ops.push({ ...base, path: target, kind: 'edit', oldText: '', newText: '', editIndex: i++, movedFrom: abs });
      }
    }
  }
  return ops;
}

module.exports = { patchesIn, parsePatch, codexPatchCalls, codexEditOps, outcomeOf };
