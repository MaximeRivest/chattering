'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../conversation-tree.js');

// d = { entryParents: [[id, parent]…], messages: [{ eid, role, text, model? }…] }
function convo(spec) {
  const entryParents = [], messages = [];
  for (const [id, parent, role, text, extra] of spec) {
    entryParents.push([id, parent]);
    if (role) messages.push({ eid: id, role, text: text ?? id, ...(extra || {}) });
  }
  return { key: 'k', entryParents, messages };
}
const kinds = L => L.blocks.map(b => b.type === 'nodes' ? 'n:' + b.ids.join(',')
  : b.type === 'answers' ? 'A:' + b.columns.map(c => c.key + (c.selected ? '*' : '') + (c.versions.length > 1 ? '×' + c.versions.length : '')).join(',')
  : b.type === 'versions' ? `V${b.index + 1}/${b.versions.length}` : `P${b.index + 1}/${b.options.length}`);

const parallel = () => convo([
  ['q', null, 'user', 'Which is better?'],
  ['a1', 'q', 'assistant', 'A1', { model: 'claude', provider: 'x' }],
  ['a2', 'q', 'assistant', 'A2', { model: 'gpt', provider: 'y' }],
  ['f1', 'a1', 'user', 'Follow up on 1'], ['g1', 'f1', 'assistant', 'G1', { model: 'claude', provider: 'x' }],
  ['f2', 'a2', 'user', 'Follow up on 2'], ['g2', 'f2', 'assistant', 'G2', { model: 'gpt', provider: 'y' }],
]);

test('the head decides the transcript: newest path by default, one group of side-by-side answers', () => {
  const t = T.build(parallel());
  const L = T.layout(t, {});
  assert.equal(L.head, 'g2');
  assert.deepEqual(kinds(L), ['n:q', 'A:x/claude,y/gpt*', 'n:f2,g2']);
  const group = L.blocks[1];
  assert.deepEqual(group.columns.map(c => c.nodes), [['a1'], ['a2']]);
});

test('clicking another answer moves the head to its own follow-up, and the route back is remembered', () => {
  const t = T.build(parallel());
  let s = T.moveHead(t, {}, 'a1');
  assert.equal(T.effectiveHead(t, s), 'g1');
  assert.deepEqual(kinds(T.layout(t, s)), ['n:q', 'A:x/claude*,y/gpt', 'n:f1,g1']);
  s = T.moveHead(t, s, 'a2');
  assert.equal(s.head, 'g2');
  // Back to the first answer: the route read below it is still there.
  s = T.moveHead(t, s, 'a1');
  assert.equal(s.head, 'g1');
});

test('an exact head stops at a branch point; a plain head follows the conversation as it grows', () => {
  const d = parallel();
  let t = T.build(d);
  const exact = T.moveHead(t, {}, 'a1', { exact: true });
  assert.equal(T.effectiveHead(t, exact), 'a1');
  assert.equal(T.layout(t, exact).atLeaf, false);
  const plain = T.moveHead(t, {}, 'a1');
  d.entryParents.push(['f3', 'g1']); d.messages.push({ eid: 'f3', role: 'user', text: 'more' });
  t = T.build(d);
  assert.equal(T.effectiveHead(t, plain), 'f3');
  assert.equal(T.effectiveHead(t, exact), 'a1');
});

test('regeneration re-asks verbatim: one question, the model column gets versions', () => {
  const t = T.build(convo([
    ['s', null, 'user', 'Start'], ['r', 's', 'assistant', 'R', { model: 'm', provider: 'p' }],
    ['q1', 'r', 'user', 'Same words'], ['a1', 'q1', 'assistant', 'first', { model: 'm', provider: 'p' }],
    ['q2', 'r', 'user', 'Same words'], ['a2', 'q2', 'assistant', 'second', { model: 'm', provider: 'p' }],
  ]));
  const L = T.layout(t, {});
  assert.deepEqual(kinds(L), ['n:s,r,q2', 'A:p/m*×2']);
  assert.equal(L.blocks[1].columns[0].index, 1);
  assert.deepEqual(L.blocks[1].questions, ['q1', 'q2']);
});

test('edited questions are versions of the question, not paths', () => {
  const t = T.build(convo([
    ['s', null, 'user', 'Start'], ['r', 's', 'assistant', 'R'],
    ['q1', 'r', 'user', 'First wording'], ['a1', 'q1', 'assistant', 'A1'],
    ['q2', 'r', 'user', 'Second wording', { operation: { kind: 'edit', sourceEntryId: 'q1' } }], ['a2', 'q2', 'assistant', 'A2'],
  ]));
  const L = T.layout(t, {});
  assert.deepEqual(kinds(L), ['n:s,r,q2', 'V2/2', 'n:a2']);
  const moved = T.moveHead(t, {}, L.blocks[1].versions[0].id);
  assert.equal(moved.head, 'a1');
});

test('settings entries are transparent, and a send keeps them in context', () => {
  const d = convo([
    ['q', null, 'user', 'Q'], ['a', 'q', 'assistant', 'A'],
    ['model-change', 'a', null], ['thinking', 'model-change', null],
  ]);
  const t = T.build(d);
  assert.equal(T.effectiveHead(t, {}), 'a');
  assert.equal(T.sendNode(t, 'a'), 'thinking');
  assert.equal(T.sendNode(t, 'q'), 'q');
  // A new conversation with settings but no message continues at the file's end.
  const empty = T.build(convo([['model', null, null], ['mode', 'model', null], ['info', 'mode', null]]));
  assert.equal(T.effectiveHead(empty, {}), null);
  assert.equal(T.sendNode(empty, null), 'info');
});

test('a label anchor between a branch point and a new question is transparent too', () => {
  const t = T.build(convo([
    ['q', null, 'user', 'Q'], ['a', 'q', 'assistant', 'A'], ['q2', 'a', 'user', 'Next'], ['a2', 'q2', 'assistant', 'A2'],
    ['label', 'a', null], ['q3', 'label', 'user', 'Other next'], ['a3', 'q3', 'assistant', 'A3'],
  ]));
  assert.equal(T.nodeParentOf(t, 'q3'), 'a');
  assert.deepEqual(kinds(T.layout(t, {})), ['n:q,a,q3', 'V2/2', 'n:a3']);
});

test('older transport entries become typed answers: regenerate, merge (with sources) and include-all', () => {
  const t = T.build(convo([
    ['q', null, 'user', 'Q'],
    ['a1', 'q', 'assistant', 'A1', { model: 'claude', provider: 'x' }],
    ['a2', 'q', 'assistant', 'A2', { model: 'gpt', provider: 'y' }],
    ['regen', 'q', 'user', 'Continue.\n<!-- chattering:regenerate -->'], ['a3', 'regen', 'assistant', 'A3', { model: 'claude', provider: 'x' }],
    ['merge', 'q', 'user', '2 models answered my last message in parallel. Their replies:\n…\n<!-- chattering:merge -->', { operation: { kind: 'merge', sources: [{ id: 'a1' }, { id: 'a2' }] } }],
    ['m', 'merge', 'assistant', 'Merged', { model: 'claude', provider: 'x' }],
    ['both', 'q', 'assistant', 'quoted\n<!-- chattering:both -->', { operation: { kind: 'both', sources: [{ id: 'a1' }, { id: 'a2' }] } }],
    ['f', 'm', 'user', 'Thanks'],
  ]));
  const L = T.layout(t, {});
  assert.deepEqual(kinds(L), ['n:q', 'A:x/claude×2,y/gpt,merge*,both', 'n:f']);
  const cols = L.blocks[1].columns;
  assert.equal(cols[0].shown.start, 'a3');
  assert.equal(cols[0].shown.via, 'regen');
  assert.deepEqual(cols[2].shown.sources.map(s => s.id), ['a1', 'a2']);
  // The transport entries are never displayed as messages.
  const shown = L.blocks.flatMap(b => b.type === 'nodes' ? b.ids : b.type === 'answers' ? b.columns.flatMap(c => c.nodes) : []);
  assert.ok(!shown.includes('regen') && !shown.includes('merge'));
  assert.equal(T.answerAt(t, 'm').question, 'q');
  assert.equal(T.answerAt(t, 'm').via, 'merge');
});

test('corrupt cycles terminate and keep the valid chain readable', () => {
  const t = T.build({ entryParents: [['root', null], ['child', 'root'], ['x', 'y'], ['y', 'x']],
    messages: [{ eid: 'root', role: 'user', text: 'r' }, { eid: 'child', role: 'assistant', text: 'c' }, { eid: 'x', role: 'user', text: 'x' }, { eid: 'y', role: 'assistant', text: 'y' }] });
  const L = T.layout(t, { head: 'child' });
  assert.deepEqual(L.path, ['root', 'child']);
  assert.ok(T.layout(t, { head: 'x' }).path.length <= 2);
});

test('real conversation shapes: every head lays out its whole path once, quickly', () => {
  const dir = path.join(__dirname, 'fixtures/trees');
  for (const file of fs.readdirSync(dir)) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const t = T.build(d);
    const started = Date.now();
    let heads = 0;
    for (const head of t.nodes) {
      const L = T.layout(t, { head, exact: true });
      heads++;
      const shown = [];
      for (const b of L.blocks) {
        if (b.type === 'nodes') shown.push(...b.ids);
        if (b.type === 'answers') { const c = b.columns[b.selected]; if (c) shown.push(...c.nodes); }
      }
      // Every path node is shown once, except transport entries (their answer
      // is shown instead) and questions a bridge answered from beside them.
      const counts = new Map();
      for (const id of shown) counts.set(id, (counts.get(id) || 0) + 1);
      for (const [id, n] of counts) assert.equal(n, 1, `${file}: ${id} shown ${n} times with head ${head}`);
      for (const id of L.path) {
        if (counts.has(id)) continue;
        assert.ok(T.transport(T.rowsOf(t, id)[0]), `${file}: ${id} missing with head ${head}`);
      }
      for (const b of L.blocks.filter(b => b.type === 'answers')) {
        assert.ok(b.columns.length >= 1 && b.columns.every(c => c.versions.includes(c.shown)), file);
        assert.ok(b.selected >= -1 && b.selected < b.columns.length, file);
      }
    }
    const ms = (Date.now() - started) / Math.max(heads, 1);
    assert.ok(ms < 25, `${file}: ${ms.toFixed(1)} ms per layout`);
  }
});

test('the default head of a real parallel conversation lands in a group with a selected column', () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/trees/parallel-3-small.json'), 'utf8'));
  const t = T.build(d);
  const L = T.layout(t, {});
  const g = L.blocks.find(b => b.type === 'answers');
  assert.equal(g.columns.length, 4);
  assert.equal(g.columns[g.selected].key, 'both');
});

// A send from an earlier point: the question is written by the run a moment
// later. `at(n)` is a server timestamp n seconds into the fixture's minute.
const at = n => new Date(Date.UTC(2026, 8, 1, 12, 0, n)).toISOString();
const continued = () => convo([
  ['q1', null, 'user', 'First', { ts: at(0) }], ['a1', 'q1', 'assistant', 'A1', { ts: at(1) }],
  ['q2', 'a1', 'user', 'Older path', { ts: at(2) }], ['a2', 'q2', 'assistant', 'A2', { ts: at(3) }],
]);
const since = Date.parse(at(10));
const growNew = d => {
  // The run's own writing: pi's branch anchor (a label), its question, its answer.
  d.entryParents.push(['anchor', 'a1'], ['q3', 'anchor'], ['a3', 'q3']);
  d.messages.push({ eid: 'q3', role: 'user', text: 'New path', ts: at(11) }, { eid: 'a3', role: 'assistant', text: 'A3', ts: at(12) });
  return d;
};

test('a send from an earlier point stays there until its question is saved, then follows its own path', () => {
  const d = continued();
  let t = T.build(d);
  // "Continue here" on a1 moved the head there exactly; the send keeps it there.
  const sent = { ...T.moveHead(t, T.moveHead(t, {}, 'a2'), 'a1', { exact: true }), follow: { from: 'a1', since, until: null, prefer: null, jobs: ['run:1'] } };
  assert.equal(T.effectiveHead(t, sent), 'a1', 'never the older path below the send point');
  // The remembered route at the branch point (the older path) does not win.
  const routed = { ...sent, routes: { a1: 'a2' } };
  t = T.build(growNew(d));
  assert.equal(T.effectiveHead(t, routed), 'a3', 'the new question and its answer, once saved');
  assert.deepEqual(T.layout(t, routed).path, ['q1', 'a1', 'q3', 'a3']);
  // Settling it is an ordinary move: follow ends, the head goes on growing.
  const settled = T.moveHead(t, routed, T.followTarget(t, routed.follow));
  assert.equal(settled.follow, undefined);
  assert.equal(settled.exact, false);
  assert.equal(T.effectiveHead(t, settled), 'a3');
});

test('a follow ignores questions written before the send or after its runs ended', () => {
  const d = continued();
  const follow = { from: 'a1', since, until: Date.parse(at(20)) };
  // Another screen's older question under the same point is not this send's.
  d.entryParents.push(['early', 'a1']); d.messages.push({ eid: 'early', role: 'user', text: 'earlier', ts: at(5) });
  assert.equal(T.followTarget(T.build(d), follow), null);
  d.entryParents.push(['late', 'a1']); d.messages.push({ eid: 'late', role: 'user', text: 'later', ts: at(30) });
  assert.equal(T.followTarget(T.build(d), follow), null);
  assert.equal(T.effectiveHead(T.build(d), { head: 'a1', exact: true, follow }), 'a1');
  d.entryParents.push(['mine', 'a1']); d.messages.push({ eid: 'mine', role: 'user', text: 'mine', ts: at(15) });
  assert.equal(T.followTarget(T.build(d), follow), 'mine');
});

test('several models at once: the follow lands on the preferred answer', () => {
  const d = continued();
  d.entryParents.push(['q3', 'a1'], ['x', 'q3'], ['y', 'q3']);
  d.messages.push({ eid: 'q3', role: 'user', text: 'Both', ts: at(11) },
    { eid: 'x', role: 'assistant', text: 'X', model: 'claude', provider: 'p', ts: at(12) },
    { eid: 'y', role: 'assistant', text: 'Y', model: 'gpt', provider: 'o', ts: at(13) });
  const t = T.build(d);
  assert.equal(T.followTarget(t, { from: 'a1', since, prefer: 'claude' }), 'x');
  assert.equal(T.followTarget(t, { from: 'a1', since, prefer: 'o/gpt' }), 'y');
  assert.equal(T.followTarget(t, { from: 'a1', since, prefer: 'absent' }), 'q3');
});

test('a live run ends the reading where it continues, until its question is saved', () => {
  const d = continued();
  let t = T.build(d);
  const live = [{ from: 'a1', since }];
  // A reader following the newest path stops above the answer being written...
  assert.equal(T.effectiveHead(t, { live }), 'a1');
  assert.equal(T.effectiveHead(t, { head: 'q1', live }), 'a1');
  // ...one who chose the older path there keeps it, and a run that has not
  // started anything changes nothing.
  assert.equal(T.effectiveHead(t, { head: 'q1', routes: { a1: 'a2' }, live }), 'a2');
  assert.equal(T.effectiveHead(t, { head: 'a2', exact: true, live }), 'a2');
  assert.equal(T.effectiveHead(t, {}), 'a2');
  // Saved: the newest path is the new one; the stop is gone.
  t = T.build(growNew(d));
  assert.equal(T.effectiveHead(t, { head: 'q1', live }), 'a3');
  // Live state is never saved by a move.
  const moved = T.moveHead(t, { live, groups: ['q1'] }, 'q1');
  assert.deepEqual(Object.keys(moved).sort(), ['exact', 'head', 'routes']);
});
