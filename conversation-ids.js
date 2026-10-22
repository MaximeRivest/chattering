'use strict';
// conversation-ids.js — a conversation's short id, the same everywhere it is
// printed (the records tools, the CLI, the frog's tools), and the way back
// from an id someone typed to one conversation key.
//
// A conversation's id is the start of its session uuid: 8 hex characters,
// lengthened in steps of 4 only as far as it takes to tell it from every
// other conversation on record. Pi's session ids are UUIDv7, whose first 8
// characters are a coarse timestamp (one value per ~65 s), so conversations
// started in a burst would otherwise all print as one id (design/102: the
// frog starts several at once). An id stays valid when it is longer than
// needed, so one printed earlier keeps working unless a later conversation
// made it ambiguous; then resolving it is an error that lists the
// candidates with their ids as they are now. Never a silent pick.
//
// The uuid comes from the index entry's sessionId when it has one, else from
// the key (the last uuid in it: a folder name can hold one too). Keys with
// neither (odd file names) use the file's stem; if that is not unique, the
// key itself.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Older Pi files carry only the first 8 characters of their uuid.
const SHORT_TAIL_RE = /_([0-9a-f]{8})\.jsonl$/i;
const MIN = 8, STEP = 4;

// The hex the id is cut from (lowercase, no dashes), or null. A sessionId
// is a uuid; any hex string of 8 or more is taken as one all the same.
function hexOf(key, entry) {
  const sid = entry && typeof entry.sessionId === 'string' ? entry.sessionId.replace(/-/g, '').toLowerCase() : '';
  if (/^[0-9a-f]{8,32}$/.test(sid)) return sid;
  const k = String(key || '');
  const inKey = k.match(UUID_RE);
  if (inKey) return inKey[inKey.length - 1].replace(/-/g, '').toLowerCase();
  const tail = SHORT_TAIL_RE.exec(k);
  return tail ? tail[1].toLowerCase() : null;
}
// Without a uuid: the file's stem (x/odd-name.jsonl → odd-name).
function stemOf(key) {
  const s = String(key || '');
  return s.slice(s.lastIndexOf('/') + 1).replace(/\.[a-z0-9]+$/i, '') || s;
}
function commonPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// Every conversation's id: Map key → id, each unique within `index`.
function computeShortIds(index) {
  const out = new Map();
  const hexed = [];
  const stems = new Map();
  for (const key of Object.keys(index)) {
    const h = hexOf(key, index[key]);
    if (h) hexed.push([key, h]);
    else {
      const s = stemOf(key);
      if (!stems.has(s)) stems.set(s, []);
      stems.get(s).push(key);
    }
  }
  // Sorted, each hex's longest shared prefix is with one of its neighbours.
  hexed.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  for (let i = 0; i < hexed.length; i++) {
    const [key, h] = hexed[i];
    let shared = 0;
    if (i > 0) shared = Math.max(shared, commonPrefix(h, hexed[i - 1][1]));
    if (i < hexed.length - 1) shared = Math.max(shared, commonPrefix(h, hexed[i + 1][1]));
    if (shared >= h.length) { out.set(key, key); continue; } // the same uuid twice: only the key tells them apart
    let n = MIN;
    while (n <= shared) n += STEP;
    out.set(key, h.slice(0, Math.min(n, h.length)));
  }
  for (const [s, keys] of stems) for (const k of keys) out.set(k, keys.length === 1 ? s : k);
  return out;
}

// The map is rebuilt when the index's keys changed (the server mutates one
// object in place: its size and its newest key tell).
const cache = new WeakMap();
function shortIds(index) {
  if (!index || typeof index !== 'object') return new Map();
  const keys = Object.keys(index);
  const sig = keys.length + '\n' + (keys.length ? keys[keys.length - 1] : '');
  const hit = cache.get(index);
  if (hit && hit.sig === sig) return hit.ids;
  const ids = computeShortIds(index);
  cache.set(index, { sig, ids });
  return ids;
}
// One conversation's id. A key the index does not hold gets the plain
// 8-character cut (a conversation just removed, printed one last time).
function shortIdOf(index, key, entry) {
  const ids = shortIds(index);
  if (ids.has(key)) return ids.get(key);
  const h = hexOf(key, entry || (index && index[key]));
  return h ? h.slice(0, MIN) : stemOf(key);
}

// What someone typed → { key } when it names exactly one conversation;
// { keys: [...] } otherwise (several candidates, or none). Accepted: a full
// key; an id as printed, or any longer prefix of the uuid, with or without
// dashes, at least 6 hex characters; a stem, for keys without a uuid.
function resolveShortId(index, ref) {
  const raw = String(ref || '').trim();
  if (!raw) return { keys: [] };
  if (index[raw]) return { key: raw };
  const hex = raw.replace(/-/g, '').toLowerCase();
  const keys = [];
  if (/^[0-9a-f]{6,32}$/.test(hex)) {
    for (const key of Object.keys(index)) {
      const h = hexOf(key, index[key]);
      if (h && h.startsWith(hex)) keys.push(key);
    }
  }
  if (!keys.length) {
    for (const key of Object.keys(index)) if (!hexOf(key, index[key]) && stemOf(key) === raw) keys.push(key);
  }
  return keys.length === 1 ? { key: keys[0] } : { keys };
}

// One line per candidate, for the error that lists them: id, day, title.
function describeMatches(index, keys, { limit = 6, title = e => e && (e.timelineTitle || e.title) || '(untitled)' } = {}) {
  const ids = shortIds(index);
  const sorted = [...keys].sort((a, b) => String((index[b] || {}).lastTs || '').localeCompare(String((index[a] || {}).lastTs || '')));
  return sorted.slice(0, limit).map(k => {
    const e = index[k] || {};
    const d = e.lastTs ? String(e.lastTs).slice(0, 10) : '';
    return `  ${ids.get(k) || k}  ${d}  ${String(title(e)).replace(/\s+/g, ' ').trim().slice(0, 60)}`;
  });
}

module.exports = { hexOf, stemOf, shortIds, shortIdOf, resolveShortId, describeMatches, computeShortIds, MIN, STEP };
