'use strict';
// The frog's memory (design/102, part 3): OptMem's design, rebuilt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mem = require('../frog-memory.js');
const { createMemory, cover, isBlock, parseBlockId, planCompaction, turnsOf, sessionPath, digestChunks, printText, cleanLine, KEEP, STEP, RAW_MAX } = mem;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'frog-memory-'));

// ---- the cover ----
test('cover: everything verbatim while it fits; aligned power-of-two blocks, finest near the present, within budget', () => {
  assert.deepEqual(cover(0, 8), []);
  assert.deepEqual(cover(3, 8), [[0, 1], [1, 2], [2, 3]]);
  for (const T of [9, 17, 100, 1000, 12345]) {
    const c = cover(T, 8);
    assert.ok(c.length <= 8, T + ': ' + c.length + ' lines');
    assert.equal(c[0][0], 0); assert.equal(c[c.length - 1][1], T);
    for (let i = 1; i < c.length; i++) assert.equal(c[i][0], c[i - 1][1]); // tiles [0,T) with no gap
    for (const [lo, hi] of c) assert.ok(hi - lo === 1 || isBlock(lo, hi), lo + '-' + hi);
    for (let i = 1; i < c.length; i++) assert.ok(c[i][1] - c[i][0] <= c[i - 1][1] - c[i - 1][0], 'coarser as it ages'); // never finer further back
    assert.ok(c[c.length - 1][1] - c[c.length - 1][0] <= 2, 'the newest memories are nearly verbatim');
  }
});

test('block ids: "#16-31" is a block, "4-6" is not', () => {
  assert.deepEqual(parseBlockId('#16-31'), [16, 32]);
  assert.deepEqual(parseBlockId('0-1'), [0, 2]);
  assert.equal(parseBlockId('4-6'), null);
  assert.equal(parseBlockId('5-6'), null);
  assert.equal(parseBlockId('x'), null);
});

// ---- the store ----
test('the log is append-only and survives a restart; ids are positions', () => {
  const dir = tmp();
  const m = createMemory({ dir, now: () => Date.parse('2026-10-17T12:00:00Z') });
  assert.equal(m.count(), 0);
  const a = m.note('Lilly\u2019s recital is Friday at seven.');
  const b = m.note('  The groups one must keep folds on refresh  ', { src: { conv: 'ab12', from: 'e1', to: 'e9' } });
  assert.equal(a.i, 0); assert.equal(b.i, 1); assert.equal(b.text, 'The groups one must keep folds on refresh'); assert.equal(a.date, '2026-10-17');
  assert.throws(() => m.note('   '), /one line/);
  const again = createMemory({ dir });
  assert.equal(again.count(), 2);
  assert.deepEqual(again.get(1).src, { conv: 'ab12', from: 'e1', to: 'e9' });
  assert.equal(fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2);
});

test('a memory is at most 280 bytes, cut at a word; accents cost two', () => {
  const m = createMemory({ dir: tmp() });
  const e = m.note('é'.repeat(200) + ' tail');
  assert.ok(Buffer.byteLength(e.text) <= 280);
  assert.ok(e.text.endsWith('…'));
});

test('pending: the blocks that can be built, smallest first; the print falls back to halves when one is missing', () => {
  const m = createMemory({ dir: tmp() });
  for (let i = 0; i < 6; i++) m.note('memory ' + i);
  assert.deepEqual(m.pending(), [[0, 2], [2, 4], [4, 6], [0, 4]]);
  const p = m.print({ budget: 3 });
  // Budget 3 over 6: the cover wants #0-3, #4, #5 (or so); nothing is built, so #0-3 shows as its memories.
  assert.ok(p.lines.length > 3);
  assert.ok(p.missing.length >= 1);
  assert.ok(p.text.includes('#0 '));
  m.setBlock(0, 2, 'memories 0 and 1'); m.setBlock(2, 4, 'memories 2 and 3'); m.setBlock(0, 4, 'the first four');
  const q = m.print({ budget: 3 });
  assert.deepEqual(q.missing, []);
  assert.ok(q.text.includes('#0-3 '));
  assert.ok(q.text.includes('the first four'));
  assert.ok(q.text.includes('#5 '));
  assert.deepEqual(m.pending(), [[4, 6]]);
});

test('nap builds what the print needs, halves before parents, then a few more; a failed merge is reported, not fatal', async () => {
  const m = createMemory({ dir: tmp() });
  for (let i = 0; i < 40; i++) m.note('memory ' + i);
  const calls = [];
  const merge = async ({ id, kind, lines }) => { calls.push({ id, kind, n: lines.length }); if (id === '#32-33') throw new Error('model down'); return 'sum of ' + id; };
  const r = await m.nap({ merge, budget: 8, extra: 2 });
  assert.ok(r.built.length > 0);
  assert.deepEqual(m.print({ budget: 8 }).missing, []);
  assert.equal(m.print({ budget: 8 }).lines.length, 8);
  // A block of up to 16 is written from its memories; a bigger one from its halves, which were built first.
  const big = calls.find(c => c.id === '#0-31');
  if (big) { assert.equal(big.kind, 'halves'); assert.equal(big.n, 2); assert.ok(calls.findIndex(c => c.id === '#0-15') < calls.indexOf(big)); }
  assert.ok(calls.every(c => c.kind === 'lines' ? c.n <= RAW_MAX : c.n === 2));
  if (calls.some(c => c.id === '#32-33')) assert.ok(r.failed.some(f => f[0] === 32 && f[1] === 34));
});

test('zoom opens a block into its halves, down to the memories, with where each came from', async () => {
  const m = createMemory({ dir: tmp() });
  for (let i = 0; i < 32; i++) m.note('memory ' + i, { src: { conv: 'c1', from: 'e' + i, to: 'e' + i } });
  await m.nap({ merge: async ({ id }) => 'sum ' + id, budget: 4, extra: 100 });
  const z = m.zoom('#0-31');
  assert.equal(z.summary, 'sum #0-31');
  assert.equal(z.halves[0].id, '#0-15'); assert.equal(z.halves[0].summary, 'sum #0-15'); assert.equal(z.halves[0].lines.length, 16);
  assert.deepEqual(z.halves[0].lines[3].src, { conv: 'c1', from: 'e3', to: 'e3' });
  const leaf = m.zoom('#2-3');
  assert.equal(leaf.halves[0].id, '#2'); assert.equal(leaf.halves[0].lines[0].text, 'memory 2');
  assert.throws(() => m.zoom('#4-6'), /not a range/);
  assert.throws(() => m.zoom('#64-127'), /beyond/);
});

test('recall: all the words, case-insensitive, newest last, capped; or a regex', () => {
  const m = createMemory({ dir: tmp() });
  m.note('Lilly\u2019s recital is Friday'); m.note('The bigspin run finished'); m.note('Jacob asked about the recital on friday');
  const r = m.recall('recital Friday');
  assert.equal(r.total, 2); assert.deepEqual(r.matches.map(x => x.i), [0, 2]);
  assert.equal(m.recall('recital', { limit: 1 }).matches[0].i, 2);
  assert.equal(m.recall('big.?spin', { regex: true }).total, 1);
  assert.throws(() => m.recall('(', { regex: true }), /bad regex/);
  assert.throws(() => m.recall(''), /what to recall/);
});

test('forget drops a summary and every one built on it; the log is untouched', async () => {
  const m = createMemory({ dir: tmp() });
  for (let i = 0; i < 8; i++) m.note('m' + i);
  await m.nap({ merge: async ({ id }) => 'sum ' + id, budget: 1, extra: 100 });
  assert.equal(m.block(0, 8), 'sum #0-7');
  const gone = m.forget(2, 4);
  assert.deepEqual(gone, [[2, 4], [0, 4], [0, 8]]);
  assert.equal(m.block(2, 4), null); assert.equal(m.block(0, 2), 'sum #0-1'); assert.equal(m.block(4, 8), 'sum #4-7');
  assert.equal(m.count(), 8);
  assert.deepEqual(m.pending(), [[2, 4], [0, 4], [0, 8]]);
});

// ---- the conversation ----
let eid = 0;
const mk = (parent, e) => ({ id: 'e' + (++eid), parentId: parent, timestamp: '2026-10-17T10:00:00.000Z', ...e });
const user = t => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: t }] } });
const note = (type, t) => ({ type: 'custom_message', customType: type, content: t, display: false });
const call = (id, name, args) => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'toolCall', id, name, arguments: args }] } });
const result = (id, t) => ({ type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: 'x', content: [{ type: 'text', text: t }], isError: false } });
const answer = (t, tokens) => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: t }], usage: tokens ? { totalTokens: tokens } : undefined } });
const speed = () => ({ type: 'custom', customType: 'chattering-speed', data: {} });
function session(nTurns, { events = false } = {}) {
  const entries = [{ type: 'session', version: 3, id: 's' }];
  let parent = null;
  const add = e => { const x = mk(parent, e); entries.push(x); parent = x.id; return x; };
  add({ type: 'custom', customType: 'mode-switch', data: { mode: 'frog' } });
  for (let i = 0; i < nTurns; i++) {
    if (events && i % 3 === 2) add(note('frog-event', 'ask w1 fired: the run is done ' + i));
    else { add({ type: 'custom', customType: 'chattering-author', data: {} }); add(user('question ' + i)); }
    add(note('frog-workspace', 'workspace of the minute ' + i));
    add(speed());
    add(call('c' + i, 'read_conversation', { id: 'ab12', last: 5 }));
    add(result('c' + i, 'what it said ' + i + '\n' + 'x'.repeat(3000)));
    add(answer('answer ' + i, 1000 * (i + 1)));
  }
  return { entries, leaf: parent };
}

test('turns: a person\u2019s message or an event after an answer starts one; bookkeeping stays inside', () => {
  const { entries } = session(7, { events: true });
  const turns = turnsOf(sessionPath(entries));
  assert.equal(turns.length, 7);
  assert.equal(turns[2].entries[0].customType, 'frog-event');
  assert.equal(turns[0].entries[0].customType, 'mode-switch', 'what comes before the first message belongs to the first turn');
  assert.equal(turns[1].entries[0].customType, 'chattering-author', 'who typed a message goes with that message');
  assert.ok(turns[0].entries.some(e => e.customType === 'chattering-speed'));
});

test('a compaction is due every STEP turns past KEEP; nothing is due before; the cut is stable between steps', () => {
  assert.equal(planCompaction(session(KEEP + STEP - 1).entries), null);
  const s = session(KEEP + STEP);
  const p = planCompaction(s.entries);
  assert.equal(p.drop, STEP); assert.equal(p.keep, KEEP); assert.equal(p.toDigest.length, STEP);
  assert.equal(p.firstKeptEntryId, turnsOf(sessionPath(s.entries))[STEP].entries[0].id);
  assert.equal(p.leafId, s.leaf);
  assert.equal(p.tokensBefore, 1000 * (KEEP + STEP));
  const more = planCompaction(session(KEEP + STEP + 3).entries);
  assert.equal(more.drop, STEP, 'the same cut for the next few turns');
  assert.equal(planCompaction(session(KEEP + 2 * STEP).entries).drop, 2 * STEP);
});

test('turns already digested are not digested again; force keeps only KEEP', () => {
  const s = session(KEEP + 2 * STEP);
  const p0 = planCompaction(s.entries);
  const p1 = planCompaction(s.entries, { digested: p0.toDigest[STEP - 1].entries.slice(-1)[0].id });
  assert.equal(p1.drop, 2 * STEP); assert.equal(p1.alreadyDigested, STEP); assert.equal(p1.toDigest.length, STEP);
  const p2 = planCompaction(s.entries, { digested: p0.lastDroppedEntryId });
  assert.equal(p2.alreadyDigested, 2 * STEP); assert.equal(p2.toDigest.length, 0, 'all in memory: only the compaction entry is left to write');
  const f = planCompaction(session(KEEP + 3).entries, { force: true });
  assert.equal(f.drop, 3); assert.equal(f.keep, KEEP);
});

test('after a compaction, only the turns after its first kept entry count', () => {
  const s = session(KEEP + STEP);
  const p = planCompaction(s.entries);
  const comp = mk(s.leaf, { type: 'compaction', summary: 'memory print', firstKeptEntryId: p.firstKeptEntryId, tokensBefore: 1 });
  const entries = [...s.entries, comp];
  // Pi then appends new turns after the compaction entry.
  let parent = comp.id;
  const add = e => { const x = mk(parent, e); entries.push(x); parent = x.id; };
  for (let i = 0; i < 3; i++) { add(user('later ' + i)); add(answer('ok ' + i, 5000)); }
  const turns = turnsOf(sessionPath(entries));
  assert.equal(turns.length, KEEP + 3);
  assert.equal(planCompaction(entries), null);
  for (let i = 0; i < STEP - 3; i++) { add(user('more ' + i)); add(answer('ok', 6000)); }
  const again = planCompaction(entries);
  assert.equal(again.drop, STEP);
  assert.equal(again.tokensBefore, 6000);
});

test('the digest text: words whole, steps one line each with the result\u2019s first words, workspace notes left out, chunked', () => {
  const s = session(KEEP + STEP, { events: true });
  const p = planCompaction(s.entries);
  const chunks = digestChunks(p.toDigest, { chars: 400 });
  assert.ok(chunks.length > 1);
  assert.equal(chunks.reduce((a, c) => a + c.turns, 0), STEP);
  const all = chunks.map(c => c.text).join('\n');
  assert.ok(all.includes('Person: question 0'));
  assert.ok(all.includes('Frog: answer 0'));
  assert.ok(all.includes('Note (frog-event): ask w1 fired'));
  assert.ok(all.includes('did read_conversation({"id":"ab12","last":5}) → what it said 0'));
  assert.ok(!all.includes('workspace of the minute'));
  assert.ok(!all.includes('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'));
  assert.equal(chunks[0].from, p.toDigest[0].entries[0].id);
  assert.equal(chunks[chunks.length - 1].to, p.lastDroppedEntryId);
});

test('the print the frog reads says what the lines mean; a line is cleaned of bullets and ids', () => {
  const m = createMemory({ dir: tmp() });
  assert.match(printText(m), /empty so far/);
  m.note('one');
  const t = printText(m);
  assert.match(t, /1 memories kept/); assert.match(t, /zoom_memory/); assert.match(t, /\n#0 \d{4}-\d{2}-\d{2} one$/);
  assert.equal(cleanLine('- #12 2026-10-17 The thing.'), 'The thing.');
  assert.equal(cleanLine('3. Another  thing'), 'Another thing');
});
