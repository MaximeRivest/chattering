'use strict';
// open-files-store.js — the files kept open in the side list (design/77),
// owned by the server so every device shows the same list.
//
// A file is on the list because a person meant it: they pinned it, ran a
// cell in it, or edited it. Opening a file to look at it adds nothing. The
// list is the household's, like the conversation list (agentread.js): one
// per Chattering install, written by its members.
//
// Each entry is { path, project, at }. `at` is when the file joined the list,
// and the list is ordered by it, newest first. Keeping a file that is
// already kept changes nothing, so a row never jumps while it is used.
//
// `rev` grows with every change (and across restarts: it follows the
// clock), so a browser can drop a list older than one it already has: an
// event that arrives after the answer to a later change, a fetch that was
// under way when a change landed.
//
// What a browser does with a kept file (a notebook that keeps running, an
// editor kept warm, the last run's result) is that browser's own business:
// the server knows the list, not the windows.

const MAX_FILES = 200;

// An absolute local path on any system: /x, C:\x or C:/x, \\server\share.
const isAbsolute = p => typeof p === 'string' && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(p) && !p.includes('\0');
const newestFirst = (a, b) => b.at - a.at || a.path.localeCompare(b.path);

function entry(raw) {
  if (!raw || !isAbsolute(raw.path)) return null;
  const at = Number(raw.at);
  return { path: raw.path, project: typeof raw.project === 'string' ? raw.project : '', at: Number.isFinite(at) && at > 0 ? at : 0 };
}

function createState() { return { version: 1, rev: 0, files: [] }; }

// A change happened: the next revision, never lower than the clock's.
function bump(state, now = Date.now()) { state.rev = Math.max(state.rev + 1, now); }

function normalize(raw) {
  const state = createState();
  if (Number.isFinite(Number(raw?.rev)) && Number(raw.rev) > 0) state.rev = Number(raw.rev);
  const seen = new Set();
  for (const r of Array.isArray(raw?.files) ? raw.files : []) {
    const e = entry(r);
    if (!e || !e.at || seen.has(e.path)) continue;
    seen.add(e.path);
    state.files.push(e);
  }
  state.files.sort(newestFirst);
  state.files.length = Math.min(state.files.length, MAX_FILES);
  return state;
}

// Past the cap, the file kept longest ago leaves. Two hundred is far beyond
// a working set; the cap only bounds a runaway client.
function add(state, e) {
  state.files.push(e);
  state.files.sort(newestFirst);
  if (state.files.length > MAX_FILES) state.files.length = MAX_FILES;
}

// Keep a file (pin, run, edit). True when the list changed. A file already
// kept stays where it is; it only learns its project if it had none. The
// server clock places it: a new entry is newer than every entry there.
function keep(state, raw, now = Date.now()) {
  const e = entry(raw);
  if (!e) return false;
  const have = state.files.find(f => f.path === e.path);
  if (have) {
    if (!have.project && e.project) { have.project = e.project; bump(state, now); return true; }
    return false;
  }
  const newest = state.files.length ? state.files[0].at : 0;
  add(state, { path: e.path, project: e.project, at: Math.max(now, newest + 1) });
  bump(state, now);
  return true;
}

// Let a file go. True when it was on the list.
function close(state, pathValue, now = Date.now()) {
  const i = state.files.findIndex(f => f.path === pathValue);
  if (i < 0) return false;
  state.files.splice(i, 1);
  bump(state, now);
  return true;
}

// Put back a file exactly where it was: an undone close, or a list carried
// over from a browser's old local one. Its own `at`, never in the future.
function restore(state, raw, now = Date.now()) {
  const e = entry(raw);
  if (!e || state.files.some(f => f.path === e.path)) return false;
  add(state, { path: e.path, project: e.project, at: Math.min(e.at || now, now) });
  bump(state, now);
  return true;
}

module.exports = { MAX_FILES, createState, normalize, keep, close, restore, isAbsolute };
