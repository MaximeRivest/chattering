'use strict';
// activity-watch.js — noticing work that has gone quiet (design/29, "Quiet work").
//
// Running for a long time is fine: builds, test suites and deep reviews take
// hours, and nothing here ever stops them. Silence is the signal. A worker
// whose output has not moved for the quiet threshold is either waiting on
// something slow but healthy, or stuck (a test runner with no time limit
// sitting at 0% processor for four hours, 2026-09-28). The watcher cannot
// tell which, so it reports facts that let whoever is told decide in a
// glance: how long it has been quiet, which tool call is open, and what the
// processes under it are doing.
//
//   quietLevel(quietMs, thresholdMs)   0-based reminder due now, or -1
//   nextReminderMs(level, thresholdMs) quiet time at which that reminder is due
//   toolWhat(name, args)               "bash: npm test" — one line, bounded
//   openToolsFromEvents(lines)         tool calls started and not yet ended
//   readTail(file, bytes)              the last whole lines of a growing log
//   createRunActivity(now)             the same facts, fed live pi events
//   processReport(rootPid, deps)       the processes under a worker, busiest first
//   describeQuiet(facts)               the sentence the parent or person reads
//   quietLabel(ms)                     "25 min", "4 h 10 min"
const fs = require('node:fs/promises');

const DEFAULT_QUIET_MINUTES = 20;
// Reminder n is due after threshold × 1, 3, 9, then every 9 more
// (20 min → 20 min, 1 h, 3 h, 6 h, 9 h …). Early reminders catch a hang
// while it is cheap to fix; later ones are rare enough never to become
// noise, and never stop while the work stays quiet.
function nextReminderMs(level, thresholdMs) {
  const factor = level < 3 ? 3 ** level : 9 * (level - 1);
  return thresholdMs * factor;
}
// The highest reminder whose time has come. A host that was down across
// several levels sends one reminder for the current level, not a burst.
function quietLevel(quietMs, thresholdMs) {
  if (!(thresholdMs > 0) || !(quietMs >= thresholdMs)) return -1;
  let level = 0;
  while (quietMs >= nextReminderMs(level + 1, thresholdMs)) level++;
  return level;
}

function quietLabel(ms) {
  const min = Math.max(0, Math.floor(ms / 60000));
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60), m = min % 60;
  if (h >= 48) return Math.floor(h / 24) + ' d ' + (h % 24) + ' h';
  return h + ' h' + (m ? ' ' + m + ' min' : '');
}

function oneLine(text, max) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
// What a tool call is doing, in the words a person would use: the command
// for a shell, the path for a file tool, the arguments otherwise.
function toolWhat(name, args) {
  const tool = oneLine(name || 'tool', 60);
  let a = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return tool + ': ' + oneLine(a, 300); } }
  if (!a || typeof a !== 'object') return tool;
  if (typeof a.command === 'string') return tool + ': ' + oneLine(a.command, 300);
  const target = a.path || a.file_path || a.file || a.url || a.pattern || a.query;
  if (typeof target === 'string') return tool + ': ' + oneLine(target, 300);
  let json = '';
  try { json = JSON.stringify(a); } catch {}
  return json && json !== '{}' ? tool + ': ' + oneLine(json, 200) : tool;
}

// Tool calls a pi JSON event stream started and has not finished. pi emits
// tool_execution_start / _update / _end with the call id; an update carries
// the arguments too, so a call whose start fell outside the tail is still
// found while it keeps streaming output.
function openToolsFromEvents(lines) {
  const open = new Map();
  for (const line of lines) {
    let e; try { e = typeof line === 'string' ? JSON.parse(line) : line; } catch { continue; }
    if (!e || typeof e.toolCallId !== 'string') continue;
    if (e.type === 'tool_execution_end') open.delete(e.toolCallId);
    else if (e.type === 'tool_execution_start' || e.type === 'tool_execution_update') {
      if (!open.has(e.toolCallId)) open.set(e.toolCallId, { id: e.toolCallId, name: e.toolName || 'tool', what: toolWhat(e.toolName, e.args) });
    }
  }
  return [...open.values()];
}

// The last whole lines of a log that may be tens of megabytes: read a
// bounded tail and drop the first, possibly cut, line.
async function readTail(file, bytes = 256 * 1024) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes), length = size - start;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  } finally { await handle?.close(); }
}

// Live runs (web conversations) hand every pi event to observe(); the same
// facts come out as from a worker's log, with real start times.
function createRunActivity(now = Date.now) {
  let lastAt = now();
  const open = new Map();
  return {
    observe(e) {
      lastAt = now();
      if (!e || typeof e.toolCallId !== 'string') return;
      if (e.type === 'tool_execution_end') open.delete(e.toolCallId);
      else if ((e.type === 'tool_execution_start' || e.type === 'tool_execution_update') && !open.has(e.toolCallId)) {
        open.set(e.toolCallId, { id: e.toolCallId, name: e.toolName || 'tool', what: toolWhat(e.toolName, e.args), startedAt: lastAt });
      }
    },
    lastAt: () => lastAt,
    openTools: () => [...open.values()],
  };
}

// The processes under a worker, the worker itself excluded (an idle agent
// process is expected while its tool runs). Each with its lifetime and
// processor time; `idle` when it used under 1% of one core over its life.
// Busiest first, then oldest. null when this system cannot say (Windows,
// or no process table): unknown, not "nothing running".
function processReport(rootPid, { list, descendantsOf, usage }, limit = 3) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return null;
  const table = list();
  if (!table.length) return null;
  const argvOf = new Map(table.map(p => [p.pid, p.argv]));
  const rows = [];
  for (const pid of descendantsOf(table, rootPid)) {
    if (pid === rootPid) continue;
    const u = usage(pid);
    if (!u || !Number.isFinite(u.ageMs) || u.ageMs <= 0 || !Number.isFinite(u.cpuMs) || u.cpuMs < 0) return null;
    rows.push({ pid, command: oneLine((argvOf.get(pid) || []).join(' '), 200), ageMs: u.ageMs, cpuMs: u.cpuMs,
      idle: u.cpuMs / u.ageMs < 0.01 });
  }
  rows.sort((a, b) => (b.cpuMs / Math.max(b.ageMs, 1)) - (a.cpuMs / Math.max(a.ageMs, 1)) || b.ageMs - a.ageMs);
  return { count: rows.length, top: rows.slice(0, limit) };
}
function processLine(p) {
  const span = ms => ms < 60000 ? Math.round(ms / 1000) + ' s' : quietLabel(ms);
  return `pid ${p.pid} ${p.command} (alive ${span(p.ageMs)}, ${span(p.cpuMs)} of processor time${p.idle ? ', idle' : ''})`;
}
// One paragraph of facts. `title`, `quietMs` and `openTools` are required;
// `processes` may be null (unknown) or have count 0 (none).
function describeQuiet({ title, id, quietMs, openTools = [], processes = null, log = '', session = '' }) {
  const parts = [`${title}${id ? ` (task ${id})` : ''}: no new output for ${quietLabel(quietMs)}.`];
  if (openTools.length) parts.push('Waiting on ' + openTools.map(t => t.what).join('; ') + '.');
  else parts.push('No tool call is open, so it is waiting on the model or its connection.');
  if (processes && processes.count) {
    parts.push('Processes under it: ' + processes.top.map(processLine).join('; ') + (processes.count > processes.top.length ? `; ${processes.count - processes.top.length} more` : '') + '.');
    if (processes.top.every(p => p.idle)) parts.push('None of them is using the processor: likely stuck or waiting on something external.');
  } else if (processes && openTools.length) parts.push('No process is running under it.');
  if (log) parts.push(`Log: ${log}.`);
  if (session) parts.push(`Session: ${session}.`);
  return parts.join(' ');
}

module.exports = { DEFAULT_QUIET_MINUTES, nextReminderMs, quietLevel, quietLabel, toolWhat, openToolsFromEvents,
  readTail, createRunActivity, processReport, processLine, describeQuiet };
