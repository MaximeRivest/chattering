'use strict';
// What the frog reads of its past (design/102, part 3, "speed first").
const test = require('node:test');
const assert = require('node:assert/strict');
const { frogContext, turnsOf, cutFor, KEEP, STEP } = require('../frog-context.js');

const user = t => ({ role: 'user', content: [{ type: 'text', text: t }] });
const note = (type, t) => ({ role: 'custom', customType: type, content: t, display: false });
const call = (id, name, args) => ({ role: 'assistant', content: [{ type: 'thinking', thinking: 'let me think about ' + id, thinkingSignature: 'sig' }, { type: 'toolCall', id, name, arguments: args }] });
const result = (id, t) => ({ role: 'toolResult', toolCallId: id, toolName: 'x', content: [{ type: 'text', text: t }], isError: false });
const answer = t => ({ role: 'assistant', content: [{ type: 'thinking', thinking: 'so', thinkingSignature: 's' }, { type: 'text', text: t }] });
const turn = i => [user('question ' + i), note('frog-workspace', 'workspace ' + i + ' '.repeat(500)),
  call('c' + i, 'read_conversation', { id: 'abc', note: 'n'.repeat(1000) }), result('c' + i, 'line one of ' + i + '\n' + 'x'.repeat(5000)), answer('answer ' + i)];

test('turns: the person\u2019s side, then the frog\u2019s', () => {
  const msgs = [...turn(0), note('frog-event', 'an ask fired'), call('e', 'workspace', {}), result('e', 'ok'), answer('told'), ...turn(1)];
  const t = turnsOf(msgs);
  assert.equal(t.length, 3);
  assert.equal(t[1][0].customType, 'frog-event');
  assert.equal(t[2][0].content[0].text, 'question 1');
});

test('the cut moves in steps and always leaves the last turns whole', () => {
  assert.equal(cutFor(0), 0);
  assert.equal(cutFor(KEEP + STEP - 1), 0);
  assert.equal(cutFor(KEEP + STEP), STEP);
  for (let n = 0; n < 60; n++) assert.ok(n - cutFor(n) >= Math.min(n, KEEP));
  // Same cut for STEP turns in a row: the shrunk prefix is the same bytes, the cache holds.
  const cuts = new Set(); for (let n = KEEP + STEP; n < KEEP + 2 * STEP; n++) cuts.add(cutFor(n));
  assert.equal(cuts.size, 1);
});

test('old turns keep their words and lose their steps; recent turns are untouched', () => {
  const msgs = []; for (let i = 0; i < KEEP + STEP + 2; i++) msgs.push(...turn(i));
  const r = frogContext(msgs);
  assert.equal(r.shrunk, STEP);
  const turns = turnsOf(r.messages);
  const old = turns[0], recent = turns[turns.length - 1];
  // Words kept, whole.
  assert.equal(old[0].content[0].text, 'question 0');
  assert.ok(old.some(m => m.role === 'assistant' && m.content.some(b => b.type === 'text' && b.text === 'answer 0')));
  // The workspace note went; thinking went; the call kept its name, its argument clipped.
  assert.ok(!old.some(m => m.customType === 'frog-workspace'));
  assert.ok(!old.some(m => m.role === 'assistant' && m.content.some(b => b.type === 'thinking')));
  const c = old.find(m => m.role === 'assistant' && m.content.some(b => b.type === 'toolCall')).content.find(b => b.type === 'toolCall');
  assert.equal(c.name, 'read_conversation'); assert.equal(c.arguments.id, 'abc'); assert.ok(c.arguments.note.length < 300);
  // The result is still there for its call, shortened and saying so.
  const res = old.find(m => m.role === 'toolResult');
  assert.equal(res.toolCallId, c.id);
  assert.match(res.content[0].text, /^line one of 0/);
  assert.match(res.content[0].text, /older result, shortened: \d+ characters/);
  assert.ok(res.content[0].text.length < 400);
  // The last turn is exactly as it was.
  assert.deepEqual(recent, turn(KEEP + STEP + 1));
  // The input is not changed.
  assert.equal(msgs[1].customType, 'frog-workspace');
});

test('every tool call keeps its result (the provider pairs them)', () => {
  const msgs = []; for (let i = 0; i < 20; i++) msgs.push(...turn(i));
  const out = frogContext(msgs).messages;
  const calls = out.flatMap(m => m.role === 'assistant' ? m.content.filter(b => b.type === 'toolCall').map(b => b.id) : []);
  const results = out.filter(m => m.role === 'toolResult').map(m => m.toolCallId);
  assert.deepEqual(calls, results);
});

test('an answer that is only thinking keeps it; events are clipped, not dropped', () => {
  const msgs = [user('q'), { role: 'assistant', content: [{ type: 'thinking', thinking: 'only this' }] }, note('frog-event', 'e'.repeat(2000)), answer('a')];
  for (let i = 0; i < KEEP + STEP; i++) msgs.push(...turn(i));
  const out = frogContext(msgs).messages;
  assert.equal(out[1].content[0].thinking, 'only this');
  const ev = out.find(m => m.customType === 'frog-event');
  assert.ok(ev && ev.content.length < 500);
});

test('a short conversation is read whole', () => {
  const msgs = [...turn(0), ...turn(1)];
  const r = frogContext(msgs);
  assert.equal(r.shrunk, 0);
  assert.equal(r.messages, msgs);
});
