'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../conversation-flow.js');
const { classifyFanoutGroups } = require('../fanout.js');
const { computeFanoutMerge } = require('../fanoutmerge.js');

function fixture() {
  return { key: 'chat', entryParents: [['p', null], ['a', 'p'], ['qa', 'a'], ['aa', 'qa'], ['b', 'p'], ['qb', 'b'], ['bb', 'qb']],
    messages: ['p', 'a', 'qa', 'aa', 'b', 'qb', 'bb'].map((eid, i) => ({ eid, role: [0, 2, 5].includes(i) ? 'user' : 'assistant', text: eid, off: i > 0 && i < 4 })) };
}
test('reading A projects A and its follow-up, independently of saved continuation B', () => {
  const d = fixture(), saved = JSON.stringify(d);
  assert.deepEqual(F.project(d, F.trace(d, 'aa')).map(m => m.eid), ['p', 'a', 'qa', 'aa']);
  assert.equal(F.trace(d).leaf, 'bb');
  assert.equal(JSON.stringify(d), saved);
});
test('follow restores a known route, follows a single path, and stops at a new decision', () => {
  const d = fixture();
  assert.equal(F.follow(F.trace(d), 'a'), 'aa');
  d.entryParents.push(['alt', 'qa']); d.messages.push({ eid: 'alt', role: 'assistant', text: 'another' });
  assert.equal(F.follow(F.trace(d), 'a'), 'qa');
  assert.equal(F.follow(F.trace(d), 'a', 'aa'), 'aa');
  assert.equal(F.follow(F.trace(d), 'a', 'bb'), 'qa');
});
test('branch controls describe the first different prompt instead of file-order blocks', () => {
  const d = fixture();
  const branches = F.branches(d, F.trace(d));
  assert.equal(branches.length, 1);
  assert.deepEqual(branches[0].choices.map(c => c.id), ['a', 'b']);
  assert.equal(branches[0].choices[1].current, true);
  assert.equal(branches[0].choices[0].text, 'a');
});
test('stopping at an earlier message still exposes its sole saved continuation', () => {
  const d = fixture();
  const points = F.branches(d, F.trace(d, 'a'));
  assert.equal(points.find(p => p.node === 'a').choices[0].id, 'qa');
});
test('editing the first question exposes both root paths', () => {
  const d = { key: 'chat', entryParents: [['original', null], ['reply', 'original'], ['edited', null]], messages: [
    { eid: 'original', role: 'user', text: 'Original question' }, { eid: 'reply', role: 'assistant', text: 'Original answer' },
    { eid: 'edited', role: 'user', text: 'Edited question', operation: { kind: 'edit', sourceEntryId: 'original' } },
  ] };
  const point = F.branches(d, F.trace(d))[0];
  assert.equal(point.anchor, '');
  assert.deepEqual(point.choices.map(c => c.id), ['original', 'edited']);
  assert.equal(point.choices[1].kind, 'Edited question');
});
test('corrupt cycles and out-of-order parents terminate without losing the valid selected chain', () => {
  const d = { messages: [{ eid: 'child', role: 'assistant', text: 'answer' }], entryParents: [['child', 'parent'], ['parent', 'root'], ['root', null], ['x', 'y'], ['y', 'x']] };
  const t = F.trace(d, 'child');
  assert.deepEqual(t.chain, ['root', 'parent', 'child']);
  assert.ok(t.carries.has('root'));
  assert.equal(F.trace(d).onPath.size, 2);
});
test('plain Continue is a real prompt; only explicit markers are transport', () => {
  assert.equal(F.transport({ role: 'user', text: 'Continue.' }), false);
  assert.equal(F.transport({ role: 'user', text: 'Continue.\n<!-- chattering:regenerate -->' }), true);
});
test('quoted markers and assistant explanations are not hidden as transport', () => {
  assert.equal(F.transport({ role: 'assistant', text: '2 models answered my last message in parallel. Their replies: an explanation' }), false);
  assert.equal(F.transport({ role: 'assistant', text: 'Example:\n```html\n<!-- chattering:both -->\n```' }), false);
  assert.equal(F.transport({ role: 'user', text: 'Example:\n```html\n<!-- chattering:regenerate -->\n```' }), false);
});
test('different user questions never become a parallel answer group', () => {
  const n = (id, parent, role, bridge) => ({ id, parent, role, bridge });
  const tree = { nodes: [n('u', null, 'user'), n('a', 'u', 'assistant'), n('q1', 'a', 'user'), n('a1', 'q1', 'assistant'), n('q2', 'a', 'user'), n('a2', 'q2', 'assistant')] };
  assert.deepEqual(classifyFanoutGroups(tree), []);
});
test('answer packages include intermediate work and final text, stopping before the follow-up', () => {
  const n = (id, parent, role, fullText = '', extra = {}) => ({ id, parent, role, fullText, ...extra });
  const tree = { nodes: [n('p', null, 'user'), n('intro', 'p', 'assistant', 'Introduction'), n('tools', 'intro', 'work'), n('final', 'tools', 'assistant', 'Final answer'), n('next', 'final', 'user'), n('later', 'next', 'assistant', 'Later conversation'), n('regen', 'p', 'user', '', { bridge: 'regenerate' }), n('alt', 'regen', 'assistant', 'Alternative')] };
  const g = classifyFanoutGroups(tree)[0];
  assert.equal(g.answers[0].id, 'final');
  assert.equal(g.answers[0].fullText, 'Introduction\n\nFinal answer');
  assert.deepEqual(g.answers[0].entryIds, ['intro', 'tools', 'final']);
  assert.equal(g.answers[1].id, 'alt');
});
test('snapshot checks allow settings but reject new messages and a different branch', () => {
  const entries = [{ type: 'message', id: 'p', parentId: null }, { type: 'message', id: 'answer', parentId: 'p' }];
  assert.equal(F.sameContext(entries, 'answer'), true);
  assert.equal(F.sameContext([...entries, { type: 'thinking_level_change', id: 'think', parentId: 'answer' }], 'answer'), true);
  assert.equal(F.sameContext([...entries, { type: 'message', id: 'new', parentId: 'answer' }], 'answer'), false);
  assert.equal(F.sameContext([...entries, { type: 'label', id: 'branch', parentId: 'p' }], 'answer'), false);
  // An extension's records and a mode carried over are bookkeeping too (the
  // frog's newer mode was cut off by a send that branched around it);
  // a custom_message is context, and counts as new.
  assert.equal(F.sameContext([...entries, { type: 'custom', customType: 'mode-switch', id: 'm', parentId: 'answer', data: { mode: 'frog' } }, { type: 'custom', customType: 'chattering-speed', id: 's', parentId: 'm' }], 'answer'), true);
  assert.equal(F.sameContext([...entries, { type: 'custom_message', customType: 'frog-event', id: 'ev', parentId: 'answer' }], 'answer'), false);
});
test('new parallel and include-all entries preserve typed provenance across reintegration retries', () => {
  const line = d => JSON.stringify(d) + '\n';
  const header = line({ type: 'session', id: 's' });
  const msg = (id, parentId, role, text) => ({ type: 'message', id, parentId, message: { role, content: text } });
  const root = header + line(msg('root', null, 'user', 'before'));
  const forks = ['a', 'b'].map(id => root + line(msg('q' + id, 'root', 'user', 'question')) + line(msg(id, 'q' + id, 'assistant', id)));
  const result = computeFanoutMerge(root, forks, { fanoutId: 'run', newId: 'all', includeAll: true });
  const entries = result.content.trim().split('\n').map(JSON.parse);
  assert.equal(entries.find(d => d.id === 'qa').chattering.runId, 'run');
  assert.deepEqual(entries.find(d => d.id === 'all').chattering.sources.map(s => s.id), ['a', 'b']);
  assert.equal(entries.find(d => d.id === 'all').chattering.unresolved, true);
  assert.equal(computeFanoutMerge(result.content, forks, { fanoutId: 'run', includeAll: true }).content, result.content);
});
