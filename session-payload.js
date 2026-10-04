'use strict';
// What /api/session sends a reader, and how little it can send (design/95).
//
// A big conversation is mostly the inside of its steps: tool calls, their
// output and the model's thinking are ~85% of the bytes, and all of it sits
// in folded boxes. A lean copy keeps what the folded lines show (the tool's
// name and first words, the first line of its output, its size) and leaves
// the text out: /api/session/parts sends it when a box opens. For the
// largest conversations here that is 2.4 MB → ~0.4 MB before compression.
//
// The reader can also say what it already has: a token names the first n
// messages and m tree entries by a hash of them. When the server's copy
// still starts with exactly those, only what follows is sent (a live
// conversation grows at its end), else everything.
const crypto = require('crypto');

const LEAN_ROLES = new Set(['tool', 'toolresult', 'thinking']);
// Shorter than this, a step is sent whole: asking for it later would cost
// more than its bytes.
const LEAN_MIN = 200;
// The folded line shows a call's first 60 characters and a result's first
// line (app.html msgBlock): the same expressions, so lean and whole agree.
const callHead = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
const resultHead = text => (String(text || '').trim().split('\n').find(x => x.trim()) || '').slice(0, 60);
const lineCount = text => (text ? String(text).split('\n').length : 0);

// Steps whose words the page reads outside their box stay whole: a
// delegation card is named by its call's arguments and finds its task in
// the result (app.html delegateCallOf).
function keptWhole(messages) {
  const calls = new Set();
  for (const m of messages) if (m && m.role === 'tool' && m.name === 'delegate' && m.id) calls.add(m.id);
  return m => (m.role === 'tool' && m.name === 'delegate') || (m.role === 'toolresult' && calls.has(m.tid));
}

function leanMessage(m, whole) {
  if (!m || !LEAN_ROLES.has(m.role) || typeof m.text !== 'string' || m.text.length <= LEAN_MIN || whole(m)) return m;
  const { paths, ...rest } = m; // paths only serve the text they are found in
  const head = m.role === 'tool' ? callHead(m.text) : m.role === 'toolresult' ? resultHead(m.text) : '';
  return { ...rest, text: '', cut: { n: m.text.length, lines: lineCount(m.text), head } };
}

// `context`: the whole list the messages come from, when `messages` is only
// its end (a delegate call may sit before the tail that holds its result).
function leanMessages(messages, context = messages) {
  const whole = keptWhole(context);
  return messages.map(m => leanMessage(m, whole));
}

const ep = entryParents => (Array.isArray(entryParents) ? entryParents : Object.entries(entryParents || {}));

function prefixHash(messages, entryParents, n, m) {
  const h = crypto.createHash('sha1');
  h.update(JSON.stringify(messages.slice(0, n)));
  h.update('\n');
  h.update(JSON.stringify(ep(entryParents).slice(0, m)));
  return h.digest('hex').slice(0, 20);
}

function parseToken(raw) {
  const t = /^(\d{1,7})\.(\d{1,7})\.([0-9a-f]{20})$/.exec(String(raw || ''));
  return t ? { n: Number(t[1]), m: Number(t[2]), hash: t[3], raw: t[0] } : null;
}

// One conversation's hashes, kept while its cached copy is the same file
// version: every reader of a live conversation asks with the token of the
// version before, so each prefix is hashed once, not once per reader.
function createHasher({ max = 64 } = {}) {
  const memo = new Map(); // key|version|n|m → hash
  const remember = (k, v) => { memo.delete(k); memo.set(k, v); if (memo.size > max) memo.delete(memo.keys().next().value); return v; };
  function hashOf(key, version, messages, entryParents, n, m) {
    const k = key + '\0' + version + '\0' + n + '\0' + m;
    const hit = memo.get(k);
    return hit !== undefined ? remember(k, hit) : remember(k, prefixHash(messages, entryParents, n, m));
  }
  // The token of the whole copy, and (when the reader sent one that still
  // matches) where the new part starts.
  function compare(key, version, messages, entryParents, knownRaw) {
    const n = messages.length, m = ep(entryParents).length;
    const token = n + '.' + m + '.' + hashOf(key, version, messages, entryParents, n, m);
    const known = parseToken(knownRaw);
    const match = !!known && known.n <= n && known.m <= m
      && hashOf(key, version, messages, entryParents, known.n, known.m) === known.hash;
    return { token, known: match ? known : null };
  }
  return { compare, size: () => memo.size };
}

// The reader's answer: the conversation whole, or what follows what it has.
function sessionPayload(data, { key, version, lean = false, known = null, hasher }) {
  const { messages: all = [], entryParents = [], ...rest } = data;
  const cmp = hasher.compare(key, version, all, entryParents, known);
  const out = { ...rest, token: cmp.token };
  if (lean) out.lean = true;
  if (cmp.known) {
    const tail = all.slice(cmp.known.n);
    out.delta = { base: cmp.known.raw, from: cmp.known.n, epFrom: cmp.known.m };
    out.messages = lean ? leanMessages(tail, all) : tail;
    out.entryParents = ep(entryParents).slice(cmp.known.m);
  } else {
    out.messages = lean ? leanMessages(all) : all;
    out.entryParents = entryParents;
  }
  return out;
}

// The words of some steps, by their place in the cached copy. Each part
// names what it is, so a reader holding another version can tell.
const PARTS_MAX = 500;
function partsOf(messages, indices) {
  const out = [];
  for (const i of [...new Set(indices)].slice(0, PARTS_MAX)) {
    const msg = Number.isInteger(i) && i >= 0 ? messages[i] : null;
    if (!msg) continue;
    out.push({ i, eid: msg.eid ?? null, role: msg.role, id: msg.id ?? null, tid: msg.tid ?? null, text: msg.text ?? '', paths: msg.paths || [] });
  }
  return out;
}

module.exports = { LEAN_MIN, PARTS_MAX, leanMessages, leanMessage, prefixHash, parseToken, createHasher, sessionPayload, partsOf, callHead, resultHead };
