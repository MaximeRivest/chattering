'use strict';
// Codex conversation files (~/.codex/sessions/**/rollout-*.jsonl, and the
// mid-2025 rollout-*.json) read into the transcript shape the rest of
// Chattering reads for Pi and Claude Code: { meta, messages, entryParents }.
// Read-only: Codex owns its files (design/87).
//
// Three generations exist on real machines, all handled here:
//   1. rollout-*.json (mid 2025): { session, items } with raw Responses items.
//   2. early JSONL (2025): a header line { id, timestamp, instructions, git },
//      { record_type: "state" } markers, then raw items one per line, no
//      timestamps and no UI records.
//   3. current JSONL: { timestamp, type, payload } lines: session_meta,
//      turn_context, response_item (what the model saw), event_msg (Codex's
//      own UI stream), compacted, world_state.
//
// Which record is the truth for what:
//   - What a person typed: event_msg user_message when the file has them.
//     The model-visible user items also hold injected instructions, the IDE
//     context and system notices nobody typed. Files without UI records fall
//     back to the model-visible items with those injections filtered out.
//   - Answers, reasoning, tool calls and results: response_item (they carry
//     call ids and full outputs; event_msg is a shortened UI copy).
//
// Entry ids are line numbers ("L" + 1-based line), stable because Codex only
// appends. A conversation is a line: each entry's parent is the one before.
// Codex forks are new files (forkedFromId), never branches inside one.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const ROLLOUT_NAME = /^rollout-.*\.jsonl?$/;
const MAX_TEXT = 4000;

// Text Codex (or the IDE extension) puts into the model's context as a user
// message, which no person typed. Matched at the start of the text only.
const INJECTED_PREFIXES = [
  '<environment_context>', '<user_instructions>', '# AGENTS.md instructions for', '<permissions instructions>',
  '<skills_instructions>', '<collaboration_mode>', '<apps_instructions>', '<plugins_instructions>',
  '<multi_agent_mode>', '<recommended_plugins>', '<realtime_delegation>', '<turn_aborted>',
  '<user_shell_command>', '<personality>', '<memory>',
];
// Records other agents' tools leave in imported copies (Claude Code's
// command echoes): shown by neither app, so not shown here.
const NOISE_PREFIXES = ['<command-name>', '<local-command-stdout>', '<local-command-stderr>', '<local-command-caveat>', 'Caveat: The messages below'];

function isRollout(absPath) { return ROLLOUT_NAME.test(path.basename(String(absPath || ''))); }
function startsWithAny(text, list) { const t = String(text || '').trimStart(); return list.some(p => t.startsWith(p)); }
function cap(text, n = MAX_TEXT) { const t = String(text == null ? '' : text); return t.length > n ? t.slice(0, n) + '\n… (truncated)' : t; }

// The VS Code extension sends "# Context from my IDE setup: … ## My request
// for Codex: <request>". The person typed the request.
function splitIdeContext(text) {
  const t = String(text || '');
  if (!t.trimStart().startsWith('# Context from my IDE setup')) return { text: t, context: null };
  const m = /(?:^|\n)## My request for Codex:\s*\n?([\s\S]*)$/.exec(t);
  if (!m) return { text: t, context: null };
  return { text: m[1].trim(), context: t.slice(0, m.index).trim() };
}

function contentText(content, types = ['input_text', 'output_text', 'text']) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(c => c && types.includes(c.type) && typeof c.text === 'string').map(c => c.text).join('\n');
}

function parseJson(value) {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value : null;
  try { return JSON.parse(value); } catch { return null; }
}

// Tool outputs are either JSON { output, metadata: { exit_code } } (older
// tools, apply_patch) or plain text ending "Process exited with code N".
function toolOutput(raw) {
  let text = '', exit = null;
  const parsed = typeof raw === 'string' ? parseJson(raw) : raw;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && ('output' in parsed || 'metadata' in parsed)) {
    text = typeof parsed.output === 'string' ? parsed.output : JSON.stringify(parsed.output ?? '');
    const code = parsed.metadata && parsed.metadata.exit_code;
    if (Number.isInteger(code)) exit = code;
  } else if (Array.isArray(parsed)) {
    text = contentText(parsed, ['input_text', 'output_text', 'text']);
  } else if (typeof raw === 'string') {
    text = raw;
  } else if (raw && typeof raw === 'object') {
    text = contentText(raw.content) || JSON.stringify(raw);
  }
  const m = /Process exited with code (-?\d+)/.exec(text);
  if (exit == null && m) exit = Number(m[1]);
  return { text, exit };
}

// The working folder from Codex's environment note (<environment_context>),
// the only place early files keep it: "<cwd>/x</cwd>" or, earlier still,
// "Current working directory: /x".
function environmentCwd(text) {
  const s = String(text || '');
  if (s.indexOf('<environment_context>') < 0) return null;
  const m = /<cwd>([^<\n]+)<\/cwd>/.exec(s) || /^Current working directory: (.+)$/m.exec(s);
  return m && m[1].trim().startsWith('/') ? m[1].trim() : null;
}

// The files a patch touches, from its own headers.
function patchPaths(patch) {
  const out = [];
  for (const m of String(patch || '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) out.push(m[1].trim());
  for (const m of String(patch || '').matchAll(/^\*\*\* Move to: (.+)$/gm)) out.push(m[1].trim());
  return [...new Set(out)];
}
function patchSummary(patch) {
  const lines = [];
  for (const m of String(patch || '').matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) lines.push(m[1].toLowerCase() + ' ' + m[2].trim());
  return lines.join('\n');
}

function commandOf(args) {
  if (!args || typeof args !== 'object') return '';
  const c = args.cmd ?? args.command;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    // ["bash", "-lc", "<script>"] is how Codex runs everything; show the script.
    if (c.length === 3 && /(^|\/)(ba|z)?sh$/.test(String(c[0])) && /^-l?c$/.test(String(c[1]))) return String(c[2]);
    return c.map(String).join(' ');
  }
  return '';
}

function shellWrites(command, cwd) {
  try {
    const located = require('../task-locations').inspectShell(command, { host: 'local', cwd });
    return [...new Set(located.locations.filter(l => l.host === 'local' && l.path && l.role !== 'copy-source').map(l => l.path))].slice(0, 6);
  } catch { return []; }
}

function pathsIn(text) {
  const out = [], seen = new Set();
  for (const match of String(text || '').matchAll(/(?:^|[\s"'`(])((?:~\/|\/|\.\.?\/)[^\s"'`<>|)\]}]+)/gm)) {
    const value = match[1].replace(/[.,;!?]+$/, '');
    if (value.length < 2 || value.length > 1000 || seen.has(value)) continue;
    seen.add(value); out.push(value);
    if (out.length >= 24) break;
  }
  return out;
}

function imageFromDataUrl(url) {
  const m = /^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,/i.exec(String(url || ''));
  return m ? (m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase()) : null;
}

// One normalized record from any generation: { kind, item, ts }.
// kind: 'meta' (session header), 'turn' (turn_context), 'item' (a Responses
// item the model saw), 'ui' (an event_msg), 'compacted', 'other'.
function normalize(record, generation) {
  if (!record || typeof record !== 'object') return { kind: 'other' };
  if (generation === 3) {
    const p = record.payload;
    const ts = typeof record.timestamp === 'string' ? record.timestamp : null;
    if (record.type === 'session_meta') return { kind: 'meta', item: p || {}, ts };
    if (record.type === 'turn_context') return { kind: 'turn', item: p || {}, ts };
    if (record.type === 'response_item') return { kind: 'item', item: p || {}, ts };
    if (record.type === 'event_msg') return { kind: 'ui', item: p || {}, ts };
    if (record.type === 'compacted') return { kind: 'compacted', item: p || {}, ts };
    return { kind: 'other', ts };
  }
  if (record.record_type) return { kind: 'other' };
  if (!record.type && record.id && ('instructions' in record || 'git' in record || 'timestamp' in record)) return { kind: 'meta', item: record, ts: record.timestamp || null };
  if (record.type) return { kind: 'item', item: record, ts: null };
  return { kind: 'other' };
}

async function* recordsOf(absPath) {
  if (absPath.endsWith('.json')) {
    // Generation 1: one JSON document.
    const doc = JSON.parse(await fs.promises.readFile(absPath, 'utf8'));
    yield { line: 1, record: { ...(doc.session || {}), _header: true }, generation: 1 };
    let n = 1;
    for (const item of doc.items || []) yield { line: ++n, record: item, generation: 1 };
    return;
  }
  const rl = readline.createInterface({ input: fs.createReadStream(absPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let line = 0, generation = null;
  for await (const raw of rl) {
    line++;
    if (!raw.trim()) continue;
    let record;
    try { record = JSON.parse(raw); } catch { continue; } // a line being written
    if (generation == null) generation = record.type && record.payload !== undefined && record.timestamp ? 3 : 2;
    yield { line, record, generation };
  }
}

// Entry ids: the conversation's own id (its random tail) and the line.
// Globally unique, so a fork's inherited history keeps its original's ids
// and the tree view joins the two as a branch, as it does for Pi forks.
const tagOf = id => String(id || '').replace(/-/g, '').slice(-12) || 'x';
const idOf = (tag, line) => tag + ':L' + line;

// A rollout by conversation id, under Codex's sessions folder.
function findRollout(sessionsRoot, threadId) {
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const hit = walk(p); if (hit) return hit; }
      else if (ROLLOUT_NAME.test(e.name) && e.name.includes(threadId)) return p;
    }
    return null;
  };
  return walk(sessionsRoot);
}
function sessionsRootOf(absPath) {
  const parts = path.resolve(absPath).split(path.sep);
  const i = parts.lastIndexOf('sessions');
  return i > 0 ? parts.slice(0, i + 1).join(path.sep) : path.dirname(absPath);
}

async function parseCodexRollout(absPath, { mtimeMs = null, depth = 0 } = {}) {
  const messages = [];
  const meta = { sessionId: null, cwd: null, gitBranch: null, firstTs: null, lastTs: null, rootId: null, parentSession: null,
    ctx: null, codex: { originator: null, cliVersion: null, source: null, subagent: null, forkedFromId: null, imported: false, generation: null, model: null, effort: null } };
  const order = []; // entry ids in file order
  let model = null, effort = null, turnId = null, lastTs = null, hasUi = false, headerTs = null;
  const calls = new Map(); // call_id → the tool message, to fill its outcome
  const ctx = { used: null, window: null };
  const items = [];
  // Pass 1: read everything once; the user-message source depends on
  // whether the file has UI records anywhere.
  for await (const { line, record, generation } of recordsOf(absPath)) {
    meta.codex.generation = meta.codex.generation || generation;
    const n = generation === 1 && record._header ? { kind: 'meta', item: record, ts: record.timestamp || null } : normalize(record, generation === 1 ? 1 : generation);
    if (n.kind === 'ui' && n.item && n.item.type === 'user_message') hasUi = true;
    items.push({ line, ordinal: Number.isInteger(record.ordinal) ? record.ordinal : line - 1, ...n });
  }
  const header = items.find(i => i.kind === 'meta');
  const threadIdOfFile = header && (header.item.id || header.item.session_id);
  const tag = tagOf(threadIdOfFile || path.basename(absPath));
  const eid = line => idOf(tag, line);
  const ordinalOf = new Map(items.map(i => [eid(i.line), i.ordinal]));
  const push = (msg, line, ts) => {
    msg.eid = eid(line); msg.ts = ts || null;
    if (turnId) msg.turnId = turnId;
    messages.push(msg);
  };
  for (const { line, kind, item, ts } of items) {
    // The header's time is when the conversation began, not activity: old
    // files have no other times, and their end is then the file's mtime.
    if (ts && kind !== 'meta') { if (!meta.firstTs) meta.firstTs = ts; lastTs = ts; }
    if (kind === 'meta') {
      meta.sessionId = meta.sessionId || item.id || item.session_id || null;
      meta.cwd = meta.cwd || item.cwd || null;
      meta.gitBranch = meta.gitBranch || (item.git && item.git.branch) || null;
      headerTs = headerTs || item.timestamp || null;
      meta.codex.originator = meta.codex.originator || item.originator || null;
      meta.codex.cliVersion = meta.codex.cliVersion || item.cli_version || null;
      const src = item.source;
      meta.codex.source = typeof src === 'string' ? src : src ? JSON.stringify(src) : meta.codex.source;
      if (src && typeof src === 'object' && (src.subagent || src.subAgent)) meta.codex.subagent = src.subagent || src.subAgent;
      meta.codex.forkedFromId = meta.codex.forkedFromId || item.forked_from_id || item.forkedFromId || null;
      order.push(eid(line));
      continue;
    }
    if (kind === 'turn') {
      model = item.model || model; effort = item.effort || (item.collaboration_mode && item.collaboration_mode.settings && item.collaboration_mode.settings.reasoning_effort) || effort;
      turnId = item.turn_id || turnId;
      if (!meta.cwd && item.cwd) meta.cwd = item.cwd;
      order.push(eid(line));
      continue;
    }
    if (kind === 'compacted') {
      order.push(eid(line));
      push({ role: 'event', customType: 'compaction', text: String(item.message || 'Codex summarized the earlier conversation to make room.') }, line, ts);
      continue;
    }
    if (kind === 'ui') {
      const t = item.type;
      if (t === 'task_started' && item.turn_id) turnId = item.turn_id;
      if (t === 'task_started' && typeof item.turn_id === 'string' && item.turn_id.startsWith('external-import-turn-')) meta.codex.imported = true;
      if (t === 'token_count' && item.info) {
        const last = item.info.last_token_usage;
        if (last) ctx.used = (Number(last.input_tokens) || 0) + (Number(last.output_tokens) || 0);
        if (item.info.model_context_window) ctx.window = Number(item.info.model_context_window) || ctx.window;
      }
      if (t === 'user_message') {
        order.push(eid(line));
        const raw = String(item.message || '');
        if (startsWithAny(raw, NOISE_PREFIXES)) continue;
        if (raw.trimStart().startsWith('<task-notification>')) { push({ role: 'event', customType: 'notification', text: cap(raw) }, line, ts); continue; }
        // Realtime voice mode hands the spoken request over wrapped.
        const spoken = /^\s*<realtime_delegation>[\s\S]*?<input>([\s\S]*?)<\/input>/.exec(raw);
        const { text, context } = spoken ? { text: spoken[1].trim(), context: null } : splitIdeContext(raw);
        const images = (Array.isArray(item.images) ? item.images : []).map((url, i) => {
          const mime = imageFromDataUrl(url);
          return mime ? { entry: eid(line), path: String(i), mime } : null;
        }).filter(Boolean);
        const localImages = Array.isArray(item.local_images) ? item.local_images.map(p => typeof p === 'string' ? p : p && p.path).filter(Boolean) : [];
        if (!text.trim() && !images.length) continue;
        if (/^\[Request interrupted by user/.test(text.trim())) { push({ role: 'abort', text: 'interrupted by you' }, line, ts); continue; }
        const msg = { role: 'user', text, images };
        if (spoken) msg.input = 'voice';
        if (context) msg.context = cap(context, 2000);
        if (localImages.length) msg.localImages = localImages;
        push(msg, line, ts);
        continue;
      }
      if (t === 'turn_aborted') { order.push(eid(line)); push({ role: 'abort', text: item.reason === 'interrupted' ? 'interrupted by you' : 'stopped' }, line, ts); continue; }
      if (t === 'entered_review_mode' || t === 'exited_review_mode') { order.push(eid(line)); push({ role: 'event', customType: 'review', text: t === 'entered_review_mode' ? 'Codex started a code review.' : 'Codex finished the code review.' }, line, ts); continue; }
      continue;
    }
    if (kind !== 'item' || !item || typeof item !== 'object') continue;
    const type = item.type;
    if (type === 'message') {
      const role = item.role;
      if (role === 'developer' || role === 'system') continue;
      if (role === 'user') {
        const raw = contentText(item.content, ['input_text', 'text']);
        // Early files keep the folder only in Codex's environment note.
        if (!meta.cwd) meta.cwd = environmentCwd(raw);
        if (hasUi) continue; // the UI record is the person's words
        if (!raw.trim() || startsWithAny(raw, INJECTED_PREFIXES) || startsWithAny(raw, NOISE_PREFIXES)) continue;
        order.push(eid(line));
        const { text, context } = splitIdeContext(raw);
        if (/^\[Request interrupted by user/.test(text.trim())) { push({ role: 'abort', text: 'interrupted by you' }, line, ts); continue; }
        const msg = { role: 'user', text };
        if (context) msg.context = cap(context, 2000);
        push(msg, line, ts);
        continue;
      }
      if (role === 'assistant') {
        const text = contentText(item.content, ['output_text', 'text']);
        if (!text.trim()) continue;
        order.push(eid(line));
        const msg = { role: 'assistant', text, provider: 'codex' };
        if (model) msg.model = model;
        if (item.phase) msg.phase = item.phase;
        push(msg, line, ts);
      }
      continue;
    }
    if (type === 'reasoning') {
      const parts = [...(item.summary || []), ...(Array.isArray(item.content) ? item.content : [])]
        .map(s => (typeof s === 'string' ? s : s && s.text) || '').filter(Boolean);
      if (!parts.length) continue;
      order.push(eid(line));
      push({ role: 'thinking', text: cap(parts.join('\n\n'), 8000) }, line, ts);
      continue;
    }
    if (type === 'function_call' || type === 'custom_tool_call' || type === 'local_shell_call' || type === 'web_search_call' || type === 'tool_search_call') {
      order.push(eid(line));
      const id = item.call_id || item.id || null;
      let name = item.name || type.replace(/_call$/, ''), text = '', p = null, writes = [];
      if (type === 'custom_tool_call' && name === 'apply_patch') {
        const files = patchPaths(item.input);
        text = patchSummary(item.input) || cap(item.input, 2000);
        writes = files.map(f => path.resolve(meta.cwd || '/', f));
        p = writes[0] || null;
      } else if (type === 'local_shell_call') {
        name = 'shell'; text = commandOf(item.action || {});
      } else if (type === 'web_search_call') {
        name = 'web_search';
        const a = item.action || {};
        text = a.query || (Array.isArray(a.queries) ? a.queries.join(' · ') : '') || a.url || '';
      } else if (type === 'tool_search_call') {
        text = JSON.stringify(item.arguments || {});
      } else {
        const args = type === 'custom_tool_call' ? { input: item.input } : (parseJson(item.arguments) || {});
        const cmd = commandOf(args);
        if (cmd) text = cmd;
        else if (name === 'update_plan' && Array.isArray(args.plan)) text = args.plan.map(s => (s.status === 'completed' ? '✓ ' : s.status === 'in_progress' ? '→ ' : '· ') + s.step).join('\n');
        else if (typeof args.input === 'string') text = args.input;
        else text = JSON.stringify(args);
        p = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : null;
      }
      if ((name === 'shell' || name === 'exec_command' || name === 'shell_command' || name === 'local_shell') && text) {
        // Earlier Codex ran its patches as `apply_patch <<'EOF'` scripts.
        writes = text.indexOf('*** Begin Patch') >= 0
          ? patchPaths(text).map(f => path.resolve(meta.cwd || '/', f)).slice(0, 12)
          : shellWrites(text, meta.cwd);
      }
      const msg = { role: 'tool', name, text: cap(text, 2000), path: p, paths: writes.length ? writes : pathsIn(text), id };
      if (writes.length) msg.writes = writes;
      push(msg, line, ts);
      if (id) calls.set(id, msg);
      continue;
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output' || type === 'tool_search_output') {
      order.push(eid(line));
      const { text, exit } = toolOutput(item.output);
      const msg = { role: 'toolresult', text: cap(text), images: [], paths: pathsIn(text), tid: item.call_id || null, err: exit != null && exit !== 0 };
      push(msg, line, ts);
      continue;
    }
    // ghost_snapshot (an undo snapshot), world_state and future item kinds:
    // Codex's own state, not conversation. Kept out of the reading view.
  }
  // A Codex fork refers to its original's history instead of copying it:
  // the original's entries before the recorded point, then this file's.
  let inherited = { messages: [], entryParents: [] };
  const forkFrom = header && (header.item.forked_from_id || header.item.forkedFromId);
  const forkUntil = header && header.item.forked_from_ordinal_exclusive;
  if (forkFrom && depth < 8) {
    const parentPath = findRollout(sessionsRootOf(absPath), forkFrom);
    if (parentPath) {
      const parent = await parseCodexRollout(parentPath, { depth: depth + 1 });
      const keep = Number.isInteger(forkUntil) ? id => (parent.ordinals.get(id) ?? Infinity) < forkUntil : () => true;
      inherited.entryParents = parent.entryParents.filter(([id]) => keep(id));
      const kept = new Set(inherited.entryParents.map(([id]) => id));
      inherited.messages = parent.messages.filter(m => kept.has(m.eid)).map(m => ({ ...m, inherited: true }));
      for (const [id] of inherited.entryParents) ordinalOf.set(id, parent.ordinals.get(id));
      meta.parentSession = parentPath;
      meta.codex.rootThreadId = parent.meta.codex.rootThreadId || parent.meta.sessionId;
      if (!meta.firstTs || (parent.meta.firstTs && parent.meta.firstTs < meta.firstTs)) meta.firstTs = parent.meta.firstTs;
      if (!model) model = parent.meta.codex.model;
      if (!effort) effort = parent.meta.codex.effort;
    } else meta.codex.forkParentMissing = true;
    meta.codex.forkedFromId = forkFrom;
  }
  meta.lastTs = lastTs || (mtimeMs ? new Date(mtimeMs).toISOString() : null);
  if (headerTs && (!meta.firstTs || headerTs < meta.firstTs)) meta.firstTs = headerTs;
  if (!meta.firstTs) meta.firstTs = meta.lastTs;
  meta.codex.rootThreadId = meta.codex.rootThreadId || meta.sessionId;
  meta.rootId = meta.codex.rootThreadId ? 'codex:' + meta.codex.rootThreadId : null;
  meta.codex.model = model; meta.codex.effort = effort;
  meta.codex.timesApproximate = !lastTs;
  messages.unshift(...inherited.messages);
  const lastMessage = [...messages].reverse().find(m => m.role === 'user' || m.role === 'assistant');
  meta.codex.lastMessageEid = lastMessage ? lastMessage.eid : null;
  if (ctx.used) meta.ctx = { used: ctx.used, provider: 'codex', model, window: ctx.window || null };
  // A line: every entry's parent is the one before it (a fork's first own
  // entry hangs under the last entry it inherited).
  const base = inherited.entryParents.length ? inherited.entryParents[inherited.entryParents.length - 1][0] : null;
  const entryParents = [...inherited.entryParents, ...order.map((id, i) => [id, i ? order[i - 1] : base])];
  // Not part of the transcript contract: kept off the returned shape's JSON.
  Object.defineProperty(entryParents, 'ordinals', { value: ordinalOf, enumerable: false });
  const out = { meta, messages, entryParents };
  Object.defineProperty(out, 'ordinals', { value: ordinalOf, enumerable: false });
  return out;
}

// The picture a person pasted, from its UI record: entry "L<line>", index i.
async function codexImageAt(absPath, entry, index) {
  const want = /^([0-9a-z]{1,12}):L(\d+)$/.exec(String(entry || ''));
  if (!want || !/^\d+$/.test(String(index))) throw new Error('bad image reference');
  const target = Number(want[2]);
  // An inherited entry (a fork's history) lives in its original's file.
  let file = absPath;
  if (!path.basename(absPath).replace(/-/g, '').includes(want[1])) {
    file = null;
    const root = sessionsRootOf(absPath);
    const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { const h = walk(p); if (h) return h; } else if (ROLLOUT_NAME.test(e.name) && e.name.replace(/-/g, '').includes(want[1])) return p; } return null; };
    try { file = walk(root); } catch {}
    if (!file) throw new Error('image entry not found');
  }
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let line = 0;
  for await (const raw of rl) {
    if (++line !== target) continue;
    rl.close();
    const r = JSON.parse(raw);
    const url = r && r.payload && Array.isArray(r.payload.images) ? r.payload.images[Number(index)] : null;
    const mime = imageFromDataUrl(url);
    if (!mime) throw new Error('image not found');
    const body = Buffer.from(String(url).slice(String(url).indexOf(',') + 1), 'base64');
    if (!body.length || body.length > 32 * 1024 * 1024) throw new Error('image is empty or too large');
    return { body, mime };
  }
  throw new Error('image entry not found');
}

module.exports = { environmentCwd, parseCodexRollout, codexImageAt, isRollout, splitIdeContext, toolOutput, patchPaths, commandOf, INJECTED_PREFIXES, NOISE_PREFIXES };
