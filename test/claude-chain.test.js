'use strict';
// Claude Code's parallel tool calls are one step, not branches (claude-chain.js). The fixture is the shape Claude
// Code 2.1 writes when one reply edits two files at once.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClaudeChain } = require('../claude-chain.js');

const line = (uuid, parentUuid, type, content, msgId) => ({ uuid, parentUuid, type, message: { role: type, content, ...(msgId ? { id: msgId } : {}) } });
const use = (id, name = 'Edit') => [{ type: 'tool_use', id, name, input: {} }];
const result = id => [{ type: 'tool_result', tool_use_id: id, content: 'ok' }];
function relink(lines) {
  const chain = createClaudeChain(), parents = new Map();
  for (const d of lines) { parents.set(d.uuid, d.parentUuid ?? null); chain.add(d); }
  chain.linearize(parents);
  return parents;
}
const childrenOf = (parents, id) => [...parents].filter(([, p]) => p === id).map(([c]) => c);

test('two tool calls in one reply read as one path: results follow the reply, in order', () => {
  const p = relink([
    line('u1', null, 'user', 'Add a print button'),
    line('a1', 'u1', 'assistant', use('t1'), 'msg_1'),
    line('a2', 'a1', 'assistant', use('t2'), 'msg_1'),
    line('r1', 'a1', 'user', result('t1')),
    line('r2', 'a2', 'user', result('t2')),
    line('a3', 'r2', 'assistant', [{ type: 'text', text: 'Done.' }], 'msg_2'),
  ]);
  assert.deepEqual(['a1', 'a2', 'r1', 'r2', 'a3'].map(id => p.get(id)), ['u1', 'a1', 'a2', 'r1', 'r2']);
  for (const id of ['u1', 'a1', 'a2', 'r1', 'r2']) assert.equal(childrenOf(p, id).length, 1, `${id} has one child`);
});

test('three calls, and the reply continuing from an earlier result, still one path', () => {
  const p = relink([
    line('u1', null, 'user', 'Read three files'),
    line('a1', 'u1', 'assistant', use('t1', 'Read'), 'm'),
    line('a2', 'a1', 'assistant', use('t2', 'Read'), 'm'),
    line('a3', 'a2', 'assistant', use('t3', 'Read'), 'm'),
    line('r1', 'a1', 'user', result('t1')),
    line('r2', 'a2', 'user', result('t2')),
    line('r3', 'a3', 'user', result('t3')),
    line('b1', 'r1', 'assistant', [{ type: 'text', text: 'All read.' }], 'n'),
  ]);
  assert.deepEqual(['r1', 'r2', 'r3', 'b1'].map(id => p.get(id)), ['a3', 'r1', 'r2', 'r3']);
});

test('a single tool call, and a real branch, are left as they are', () => {
  const lines = [
    line('u1', null, 'user', 'Fix the rounding'),
    line('a1', 'u1', 'assistant', use('t1'), 'm1'),
    line('r1', 'a1', 'user', result('t1')),
    line('a2', 'r1', 'assistant', [{ type: 'text', text: 'Fixed.' }], 'm2'),
    // resumed later from the first answer: a person's words, a real second path
    line('u2', 'a2', 'user', 'Now add a test'),
    line('u3', 'a2', 'user', 'Actually, explain it first'),
  ];
  const p = relink(lines);
  for (const d of lines) assert.equal(p.get(d.uuid), d.parentUuid ?? null, d.uuid);
  assert.deepEqual(childrenOf(p, 'a2').sort(), ['u2', 'u3']);
});
