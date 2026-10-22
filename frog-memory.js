'use strict';
// The frog's memory (design/102, part 3): what it keeps of a conversation
// that never ends.
//
// The design is OptMem's (Victor Taelin, github.com/VictorTaelin/OptMem;
// the repository carries no licence, so this is a reimplementation of the
// idea, with credit, not a copy of the code):
// - an append-only log of one-line memories, never edited;
// - a binary tree of summaries above it: #0-1, #2-3 are one line each,
//   #0-3 one line of those two, and so on, every block an aligned
//   power-of-two range;
// - a print within a fixed budget of lines, finest near the present: recent
//   memories verbatim, older ones as summaries of ever larger ranges (the
//   "cover"); when everything fits, nothing is summarized at all;
// - zoom opens a block into its two halves, down to the memories
//   themselves; recall searches every memory ever recorded; forget drops a
//   bad summary so it is written again.
//
// What differs here: the memories are not noted by the agent in a shell;
// they are written between the frog's turns, by its own model, from the
// turns about to leave its context (digest), and the summaries the same way
// (merge). The frog can also note one itself. Each memory names where it
// came from (the conversation part and its entries), so the raw transcript
// is one step away; the transcript itself is never changed. The store is
// JSON lines read whole and kept in memory (thousands of lines, not
// OptMem's millions: fixed-width records and seeks would buy nothing here).
//
// The pure parts (cover, pending, planning, digest text) have no files and
// no clock; the store is small and tested on a temporary folder.

const fs = require('node:fs');
const path = require('node:path');

const LINE_BYTES = 280;   // one memory or summary, at most (OptMem's size)
const RAW_MAX = 16;       // a block of up to this many memories is summarized from them; bigger ones from their two halves
const BUDGET = 64;        // lines the memory print holds (OptMem prints 96 ≈ 8k tokens; voice wants less)
const KEEP = 8;           // turns kept whole in the conversation after a compaction
const STEP = 8;           // turns digested per compaction (the cut moves in steps: the prompt cache holds between)
const NAP_EXTRA = 4;      // summaries built beyond what the print needs, per pass (the tree fills in over time)

const clipBytes = (s, n = LINE_BYTES) => {
  let t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(t) <= n) return t;
  while (Buffer.byteLength(t) > n - 3) t = t.slice(0, -1); // the ellipsis is three bytes
  return t.replace(/\s+\S*$/, '') + '…';
};
const clipChars = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, '') + '…' : t; };
const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// ---- the cover (OptMem's) ----
// Tile [0,T) with aligned power-of-two blocks; a block stays whole iff its
// size is at most alpha times its age (T - lo). Bigger alpha, fewer lines.
function coverAt(T, alpha) {
  let root = 1;
  while (root < T) root *= 2;
  const out = [], stack = [[0, root]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (lo >= T) continue;
    const size = hi - lo;
    if (size > 1 && (hi > T || size > alpha * (T - lo))) {
      const mid = (lo + hi) / 2;
      stack.push([mid, hi]); stack.push([lo, mid]);
    } else out.push([lo, hi]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
// The blocks the print shows: at most `budget`, finest near T.
function cover(T, budget) {
  if (T <= 0) return [];
  if (T <= budget) return Array.from({ length: T }, (_, i) => [i, i + 1]);
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (coverAt(T, mid).length > budget) lo = mid; else hi = mid;
  }
  const out = coverAt(T, hi);
  // Sizes jump in powers of two, so alpha alone can undershoot the budget:
  // spend what is left on the present, where detail is worth most.
  while (out.length < budget) {
    let i = -1;
    for (let k = out.length - 1; k >= 0; k--) if (out[k][1] - out[k][0] > 1) { i = k; break; }
    if (i < 0) break;
    const [a, b] = out[i], mid = (a + b) / 2;
    out.splice(i, 1, [a, mid], [mid, b]);
  }
  return out;
}
const isBlock = (lo, hi) => { const n = hi - lo; return n >= 2 && (n & (n - 1)) === 0 && lo % n === 0; };
const blockId = (lo, hi) => '#' + lo + '-' + (hi - 1);
// "#4-7" or "4-7" → [4, 8]; null when it is not an aligned block.
function parseBlockId(s) {
  const m = /^#?(\d+)-(\d+)$/.exec(String(s || '').trim());
  if (!m) return null;
  const lo = Number(m[1]), hi = Number(m[2]) + 1;
  return isBlock(lo, hi) ? [lo, hi] : null;
}

// ---- the store ----
function readJsonl(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {} // a torn last line (a crash mid-write) is skipped; the next append lands after it
  }
  return out;
}
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + '\n');
  fs.renameSync(tmp, file);
}

function createMemory({ dir, now = Date.now } = {}) {
  if (!dir) throw new Error('frog memory: dir is required');
  const LOG = path.join(dir, 'log.jsonl');     // every memory, one per line, append-only, never edited
  const TREE = path.join(dir, 'tree.json');    // the summaries: a cache, rebuildable from the log
  const STATE = path.join(dir, 'state.json');  // what was digested of which conversation part
  fs.mkdirSync(dir, { recursive: true });
  // Ids are positions: memory i is line i. A line whose id is off (a torn
  // write skipped above) is renumbered on read; the file is left as it is.
  const lines = readJsonl(LOG).map((e, i) => ({ ...e, i }));
  let tree = {};
  try { tree = JSON.parse(fs.readFileSync(TREE, 'utf8')) || {}; } catch {}
  let state = { digested: {} };
  try { state = { digested: {}, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch {}
  const saveTree = () => writeJsonAtomic(TREE, tree);
  const saveState = () => writeJsonAtomic(STATE, state);

  const count = () => lines.length;
  const get = i => lines[i] || null;
  const slice = (lo, hi) => lines.slice(Math.max(0, lo), Math.max(0, hi));

  // Record one memory. Returns it. The only way the log changes.
  function note(text, { src = null, date = null, by = 'frog' } = {}) {
    const t = clipBytes(text);
    if (!t) throw new Error('A memory is one line of text.');
    const e = { i: lines.length, date: date || dateOf(now()), text: t, ...(src ? { src } : {}), ...(by && by !== 'frog' ? { by } : {}) };
    fs.appendFileSync(LOG, JSON.stringify(e) + '\n');
    lines.push(e);
    return e;
  }

  const block = (lo, hi) => (tree[lo + '-' + hi] && tree[lo + '-' + hi].text) || null;
  function setBlock(lo, hi, text) {
    if (!isBlock(lo, hi) || hi > lines.length) throw new Error(blockId(lo, hi) + ' is not a block of this memory');
    tree[lo + '-' + hi] = { text: clipBytes(text), at: now() };
    saveTree();
    return tree[lo + '-' + hi].text;
  }
  // Drop a summary and every one built on it; they are written again later.
  function forget(lo, hi) {
    if (!isBlock(lo, hi)) throw new Error('not a block: ' + lo + '-' + hi);
    const gone = [];
    let root = 1;
    while (root < lines.length) root *= 2;
    for (let size = hi - lo; size <= root; size *= 2) {
      const a = Math.floor(lo / size) * size, b = a + size;
      if (tree[a + '-' + b]) { delete tree[a + '-' + b]; gone.push([a, b]); }
    }
    if (gone.length) saveTree();
    return gone;
  }

  // Blocks that could be built and are not, smallest first (a block's halves
  // before it), as of T memories.
  function pending(T = lines.length, { limit = Infinity, only = null } = {}) {
    const out = [];
    for (let size = 2; size <= T; size *= 2) {
      for (let k = 0; (k + 1) * size <= T; k++) {
        const lo = k * size, hi = lo + size;
        if (tree[lo + '-' + hi]) continue;
        if (only && !only.has(lo + '-' + hi)) continue;
        out.push([lo, hi]);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
  // What a merge of [lo,hi) is written from: the memories themselves when
  // the block is small, else its two halves' summaries (null if one is missing).
  function mergeInput(lo, hi) {
    if (hi - lo <= RAW_MAX) return { kind: 'lines', lines: slice(lo, hi).map(lineText) };
    const mid = (lo + hi) / 2;
    const a = block(lo, mid), b = block(mid, hi);
    if (!a || !b) return null;
    return { kind: 'halves', lines: [blockId(lo, mid) + ' ' + a, blockId(mid, hi) + ' ' + b] };
  }

  const lineText = e => '#' + e.i + ' ' + e.date + ' ' + e.text;
  const spanOf = (lo, hi) => { const a = lines[lo], b = lines[hi - 1]; if (!a || !b) return ''; return a.date === b.date ? a.date : a.date + '..' + b.date; };
  // The print: the cover's blocks, each one line. A block not summarized yet
  // is shown as its halves (down to the memories): the print is never
  // refused, only longer, and `missing` says which summaries it wanted.
  function print({ budget = BUDGET, T = lines.length } = {}) {
    const out = [], missing = [];
    const show = (lo, hi) => {
      if (hi - lo === 1) { out.push({ lo, hi, text: lineText(lines[lo]) }); return; }
      const s = block(lo, hi);
      if (s) { out.push({ lo, hi, text: blockId(lo, hi) + ' ' + spanOf(lo, hi) + ' ' + s }); return; }
      missing.push([lo, hi]);
      const mid = (lo + hi) / 2;
      show(lo, mid); show(mid, hi);
    };
    for (const [lo, hi] of cover(T, budget)) show(lo, hi);
    return { T, lines: out, text: out.map(l => l.text).join('\n'), missing };
  }
  // The blocks the print needs built, then a few more of the pending ones.
  function wanted({ budget = BUDGET, extra = NAP_EXTRA } = {}) {
    const seen = new Set(), out = [];
    // A block whose halves are not summarized either: the halves first.
    const add = (lo, hi) => {
      const k = lo + '-' + hi;
      if (seen.has(k) || tree[k] || hi - lo < 2) return;
      if (hi - lo > RAW_MAX) { const mid = (lo + hi) / 2; add(lo, mid); add(mid, hi); }
      seen.add(k); out.push([lo, hi]);
    };
    for (const [lo, hi] of print({ budget }).missing) add(lo, hi);
    const needed = out.length;
    for (const [lo, hi] of pending()) { if (out.length >= needed + extra) break; add(lo, hi); }
    return out;
  }
  // Build the wanted summaries with `merge({ lo, hi, id, lines }) → text`.
  // Smallest first, so a parent's halves exist when its turn comes.
  async function nap({ merge, budget = BUDGET, extra = NAP_EXTRA, limit = 40 } = {}) {
    const built = [], failed = [];
    for (const [lo, hi] of wanted({ budget, extra }).sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]) || a[0] - b[0]).slice(0, limit)) {
      const input = mergeInput(lo, hi);
      if (!input) continue;
      try {
        const text = clipBytes(await merge({ lo, hi, id: blockId(lo, hi), ...input }));
        if (!text) throw new Error('empty summary');
        setBlock(lo, hi, text);
        built.push([lo, hi]);
      } catch (e) { failed.push([lo, hi, e.message]); }
    }
    return { built, failed };
  }

  // A block opened: its two halves, each a summary when built, else its
  // memories when small, else a note to zoom further.
  function zoom(id) {
    const b = typeof id === 'string' ? parseBlockId(id) : id;
    if (!b) throw new Error('"' + id + '" is not a range like #16-31 (as the memory prints them).');
    const [lo, hi] = b;
    if (hi > lines.length) throw new Error(blockId(lo, hi) + ' is beyond the memory (' + lines.length + ' memories).');
    const half = (a, c) => {
      const s = c - a === 1 ? null : block(a, c);
      if (c - a === 1) return { id: '#' + a, lines: [lineOf(a)] };
      if (s) return { id: blockId(a, c), span: spanOf(a, c), summary: s, ...(c - a <= RAW_MAX ? { lines: slice(a, c).map(e => lineOf(e.i)) } : {}) };
      if (c - a <= RAW_MAX) return { id: blockId(a, c), span: spanOf(a, c), summary: null, lines: slice(a, c).map(e => lineOf(e.i)) };
      return { id: blockId(a, c), span: spanOf(a, c), summary: null, note: 'not summarized yet: zoom ' + blockId(a, c) + ' for its halves' };
    };
    const mid = (lo + hi) / 2;
    return { id: blockId(lo, hi), summary: block(lo, hi), halves: [half(lo, mid), half(mid, hi)] };
  }
  const lineOf = i => { const e = lines[i]; return { i, date: e.date, text: e.text, ...(e.src ? { src: e.src } : {}), ...(e.by ? { by: e.by } : {}) }; };

  // Every memory holding all the words (or matching the regex), newest last,
  // the newest `limit` of them.
  function recall(query, { limit = 40, regex = false } = {}) {
    const q = String(query || '').trim();
    if (!q) throw new Error('what to recall?');
    let test;
    if (regex) { let re; try { re = new RegExp(q, 'i'); } catch (e) { throw new Error('bad regex: ' + e.message); } test = t => re.test(t); }
    else { const words = q.toLowerCase().split(/\s+/).filter(Boolean); test = t => { const l = t.toLowerCase(); return words.every(w => l.includes(w)); }; }
    const hits = lines.filter(e => test(e.date + ' ' + e.text));
    return { query: q, total: hits.length, matches: hits.slice(-limit).map(e => lineOf(e.i)) };
  }

  // What was digested of a conversation part: nothing before it is read again.
  const digestedOf = key => (state.digested && state.digested[key]) || null;
  function setDigested(key, entryId) { state.digested[key] = { entryId, at: now() }; saveState(); }

  return { dir, count, get, slice, note, block, setBlock, forget, pending, mergeInput, print, wanted, nap, zoom, recall, digestedOf, setDigested, lineText,
    stats: () => ({ memories: lines.length, summaries: Object.keys(tree).length, pending: pending().length, first: lines[0] ? lines[0].date : null, last: lines.length ? lines[lines.length - 1].date : null }) };
}

// ---- the conversation: what leaves it, and when ----
// Pi session entries (parsed JSONL lines) → the path from the newest entry
// to the root, in order. The latest compaction on it says where the model's
// context starts (its firstKeptEntryId).
function sessionPath(entries) {
  const byId = new Map();
  let leaf = null;
  for (const d of entries) { if (!d || d.type === 'session' || typeof d.id !== 'string') continue; byId.set(d.id, d); leaf = d; }
  const chain = [];
  for (let e = leaf, guard = 0; e && guard < 1e6; e = byId.get(e.parentId), guard++) chain.push(e);
  return chain.reverse();
}
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n') : '';
const STALE_NOTES = new Set(['frog-workspace', 'navigator-workspace']);

// Turns of the context window (after the latest compaction's first kept
// entry): a turn starts at a person's message, or at a note or event once
// the frog has answered. Bookkeeping entries (authors, speeds, labels) stay
// with the turn they are in.
function turnsOf(pathEntries) {
  let start = 0;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    if (pathEntries[i].type !== 'compaction') continue;
    const k = pathEntries.findIndex(e => e.id === pathEntries[i].firstKeptEntryId);
    start = k >= 0 && k < i ? k : i + 1;
    break;
  }
  const turns = [];
  let cur = null, answered = false, held = [];
  for (let i = start; i < pathEntries.length; i++) {
    const e = pathEntries[i];
    if (e.type === 'compaction') { cur = null; held = []; continue; }
    // Bookkeeping (who typed, speeds, mode and model changes) goes with the
    // message that follows it, so a kept part starts with its own.
    if (e.type !== 'message' && e.type !== 'custom_message') { held.push(e); continue; }
    const person = e.type === 'message' && e.message && e.message.role === 'user';
    const note = e.type === 'custom_message';
    const starts = person || (note && answered);
    if (!cur || starts) { cur = { entries: [], at: e.timestamp || null }; turns.push(cur); answered = false; }
    cur.entries.push(...held, e);
    held = [];
    if (e.type === 'message' && e.message && e.message.role === 'assistant') answered = true;
  }
  if (cur && held.length) cur.entries.push(...held);
  return turns;
}
// Rough size of what a turn puts in the context.
function turnChars(turn) {
  let n = 0;
  for (const e of turn.entries) {
    if (e.type === 'message' && e.message) {
      const c = e.message.content;
      if (typeof c === 'string') n += c.length;
      else for (const b of c || []) n += b.type === 'text' ? (b.text || '').length : b.type === 'thinking' ? (b.thinking || '').length : b.type === 'toolCall' ? JSON.stringify(b.arguments || {}).length : 0;
    } else if (e.type === 'custom_message') n += textOf(e.content).length;
  }
  return n;
}
function lastUsageTokens(pathEntries) {
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    const e = pathEntries[i];
    if (e.type === 'message' && e.message && e.message.role === 'assistant' && e.message.usage) {
      const u = e.message.usage;
      return Number(u.totalTokens) || (Number(u.input) || 0) + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0) + (Number(u.output) || 0);
    }
  }
  return 0;
}

// What to do now with the frog's conversation: the turns to digest (the
// oldest, in steps of `step`, leaving `keep` whole), where the kept part
// starts, and whether those turns are already in the memory. `digested` is
// the id of the last entry already digested (from the store).
// `force`: digest everything but the last `keep` turns (a fresh segment).
// Null when nothing is due.
function planCompaction(entries, { keep = KEEP, step = STEP, digested = null, force = false, maxChars = 480000 } = {}) {
  const p = sessionPath(entries);
  if (!p.length) return null;
  const turns = turnsOf(p);
  const n = turns.length;
  let drop = force ? Math.max(0, n - keep) : Math.floor(Math.max(0, n - keep) / step) * step;
  // Too big even so (a few huge turns): drop in steps until it fits, keeping at least three.
  if (!force) { let chars = turns.slice(drop).reduce((a, t) => a + turnChars(t), 0); while (chars > maxChars && n - drop > 3) { const more = Math.min(step, n - drop - 3); chars -= turns.slice(drop, drop + more).reduce((a, t) => a + turnChars(t), 0); drop += more; } }
  if (drop <= 0) return null;
  const dropped = turns.slice(0, drop);
  const kept = turns[drop];
  let from = 0;
  if (digested) { const k = dropped.findIndex(t => t.entries.some(e => e.id === digested)); if (k >= 0) from = k + 1; }
  const last = dropped[dropped.length - 1].entries;
  return {
    turns: n, drop, keep: n - drop,
    toDigest: dropped.slice(from),
    alreadyDigested: from,
    firstKeptEntryId: kept.entries[0].id,
    lastDroppedEntryId: last[last.length - 1].id,
    leafId: p[p.length - 1].id,
    tokensBefore: lastUsageTokens(p),
  };
}

// The turns as the digest reads them: the person's words whole, the frog's
// answers whole, its steps in one line each (tool, short arguments, the
// first words of the result), notes and events clipped, workspace notes
// (stale by the next turn) left out. Split into chunks under `chars`.
function digestChunks(turns, { chars = 60000, stepChars = 160, textChars = 4000, steps = 14 } = {}) {
  const results = new Map();
  for (const t of turns) for (const e of t.entries) if (e.type === 'message' && e.message && e.message.role === 'toolResult') results.set(e.message.toolCallId, e.message);
  const chunks = [];
  let cur = null;
  turns.forEach((t, k) => {
    const when = t.at ? String(t.at).replace('T', ' ').slice(0, 16) : '';
    const out = ['[turn ' + (k + 1) + (when ? ', ' + when : '') + ']'];
    let nSteps = 0;
    for (const e of t.entries) {
      if (e.type === 'custom_message') {
        if (STALE_NOTES.has(e.customType)) continue;
        out.push('Note (' + e.customType + '): ' + clipChars(textOf(e.content), 600));
      } else if (e.type !== 'message' || !e.message) continue;
      else if (e.message.role === 'user') {
        const text = textOf(e.message.content);
        const pics = Array.isArray(e.message.content) ? e.message.content.filter(b => b && b.type === 'image').length : 0;
        out.push('Person: ' + clipChars(text, textChars) + (pics ? ' [' + pics + ' picture' + (pics > 1 ? 's' : '') + ']' : ''));
      } else if (e.message.role === 'assistant') {
        const c = Array.isArray(e.message.content) ? e.message.content : [{ type: 'text', text: String(e.message.content || '') }];
        for (const b of c) {
          if (b.type === 'text' && b.text && b.text.trim()) out.push('Frog: ' + clipChars(b.text, textChars));
          else if (b.type === 'toolCall') {
            nSteps++;
            if (nSteps > steps) continue;
            const r = results.get(b.id);
            const rt = r ? textOf(r.content) : '';
            out.push('  did ' + b.name + '(' + clipChars(JSON.stringify(b.arguments || {}), stepChars) + ')' + (r ? (r.isError ? ' → failed' : ' →') + (rt ? ' ' + clipChars(rt, stepChars) : '') : ''));
          }
        }
      }
    }
    if (nSteps > steps) out.push('  … and ' + (nSteps - steps) + ' more steps');
    const text = out.join('\n');
    const first = t.entries[0].id, last = t.entries[t.entries.length - 1].id;
    if (!cur || cur.chars + text.length > chars) { cur = { texts: [], chars: 0, from: first, to: last, turns: 0 }; chunks.push(cur); }
    cur.texts.push(text); cur.chars += text.length + 2; cur.to = last; cur.turns++;
  });
  return chunks.map(c => ({ text: c.texts.join('\n\n'), from: c.from, to: c.to, turns: c.turns }));
}

// The memory as the frog reads it at the top of its context (the summary of
// a Pi compaction entry).
function printText(memory, { budget = BUDGET } = {}) {
  const p = memory.print({ budget });
  const head = p.T
    ? 'Your memory of this conversation, oldest first (' + p.T + ' memories kept so far; the newest are shown as they are, older ones as summaries of ever larger ranges). A line "#12 2026-10-17 …" is one memory. A line "#0-15 …" sums up memories 0 to 15: the tool zoom_memory opens it into its halves, down to the memories, each naming the conversation part and entries it came from. recall_memory searches every memory ever recorded; remember writes one now. The last turns follow as they were.'
    : 'Your memory of this conversation is empty so far: memories are written from turns as they leave your context, and remember writes one now.';
  return head + (p.T ? '\n\n' + p.text : '');
}

// A memory line as the digest or the frog wrote it: one line, no bullet, no
// leading id or date (the store adds those).
function cleanLine(s) {
  return clipBytes(String(s == null ? '' : s).replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/^#\d+(?:-\d+)?\s+(?:\d{4}-\d{2}-\d{2}\s+)?/, ''));
}

module.exports = { createMemory, cover, coverAt, isBlock, blockId, parseBlockId, sessionPath, turnsOf, turnChars, planCompaction, digestChunks, printText, cleanLine, clipBytes, LINE_BYTES, RAW_MAX, BUDGET, KEEP, STEP, NAP_EXTRA };
