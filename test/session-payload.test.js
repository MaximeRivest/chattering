'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../session-payload.js');

const long = (s, n = 600) => (s + ' ').repeat(Math.ceil(n / (s.length + 1))).slice(0, n);
function convo(extra = []) {
  return {
    key: 'k', title: 't',
    messages: [
      { role: 'user', eid: 'u1', text: 'Fix the bug' },
      { role: 'thinking', eid: 'a1', text: long('pondering') },
      { role: 'tool', eid: 'a1', id: 'c1', name: 'bash', text: '  ls   -la\n' + long('arg') , paths: ['/x'] },
      { role: 'toolresult', eid: 'r1', tid: 'c1', text: '\n\n  first line  \nsecond\n' + long('out'), paths: ['/y'], images: [] },
      { role: 'tool', eid: 'a2', id: 'c2', name: 'bash', text: 'short' },
      { role: 'tool', eid: 'a3', id: 'd1', name: 'delegate', text: JSON.stringify({ title: 'Sub task', brief: long('brief') }) },
      { role: 'toolresult', eid: 'r3', tid: 'd1', text: 'task id abc ' + long('log') },
      { role: 'assistant', eid: 'a4', text: long('answer', 900) },
      ...extra,
    ],
    entryParents: [['u1', null], ['a1', 'u1'], ['r1', 'a1'], ['a2', 'r1'], ['a3', 'a2'], ['r3', 'a3'], ['a4', 'r3']],
  };
}

test('a lean copy keeps what the folded lines show and drops the words', () => {
  const d = convo();
  const lean = P.leanMessages(d.messages);
  const [user, think, call, result, short, dcall, dres, answer] = lean;
  assert.equal(user, d.messages[0]);
  assert.equal(answer, d.messages[7], 'answers are read, never cut');
  assert.equal(short, d.messages[4], 'a short step is sent whole');
  assert.equal(dcall, d.messages[5], 'a delegation call is read by its card');
  assert.equal(dres, d.messages[6], 'and so is its result');
  assert.equal(think.text, ''); assert.equal(think.cut.n, d.messages[1].text.length);
  assert.equal(call.text, ''); assert.equal(call.cut.head, P.callHead(d.messages[2].text)); assert.equal(call.cut.head.slice(0, 9), 'ls -la ar');
  assert.equal(call.paths, undefined, 'paths come with the words');
  assert.equal(call.id, 'c1'); assert.equal(call.name, 'bash');
  assert.equal(result.cut.head, 'first line  ', 'as the page reads it: the line, trimmed at its start only');
  assert.equal(result.cut.lines, d.messages[3].text.split('\n').length);
  assert.deepEqual(result.images, []);
  assert.ok(d.messages[2].text.length > 0, 'the source is not changed');
});

test('a delegation result in the tail is still recognised by its call before it', () => {
  const d = convo();
  const tail = P.leanMessages(d.messages.slice(6), d.messages);
  assert.equal(tail[0], d.messages[6]);
});

test('a reader that has the start gets only what follows', () => {
  const hasher = P.createHasher();
  const d1 = convo();
  const first = P.sessionPayload(d1, { key: 'k', version: 'v1', lean: true, hasher });
  assert.equal(first.delta, undefined);
  assert.equal(first.messages.length, 8);
  assert.equal(first.lean, true);
  assert.match(first.token, /^8\.7\.[0-9a-f]{20}$/);
  // The conversation grows.
  const d2 = convo([{ role: 'user', eid: 'u2', text: 'more' }]);
  d2.entryParents.push(['u2', 'a4']);
  const next = P.sessionPayload(d2, { key: 'k', version: 'v2', lean: true, known: first.token, hasher });
  assert.deepEqual(next.delta, { base: first.token, from: 8, epFrom: 7 });
  assert.deepEqual(next.messages.map(m => m.eid), ['u2']);
  assert.deepEqual(next.entryParents, [['u2', 'a4']]);
  assert.match(next.token, /^9\.8\./);
  // Nothing new: an empty tail.
  const same = P.sessionPayload(d2, { key: 'k', version: 'v2', lean: true, known: next.token, hasher });
  assert.equal(same.messages.length, 0); assert.equal(same.token, next.token);
  // Fields other than the messages always come along.
  assert.equal(same.title, 't');
});

test('a start that changed sends everything again', () => {
  const hasher = P.createHasher();
  const first = P.sessionPayload(convo(), { key: 'k', version: 'v1', hasher });
  const d2 = convo();
  d2.messages[4] = { ...d2.messages[4], off: true }; // an earlier message changed (another path chosen)
  const next = P.sessionPayload(d2, { key: 'k', version: 'v2', known: first.token, hasher });
  assert.equal(next.delta, undefined);
  assert.equal(next.messages.length, 8);
  // Shorter than what the reader has, or nonsense: everything.
  const d3 = convo(); d3.messages.pop(); d3.entryParents.pop();
  assert.equal(P.sessionPayload(d3, { key: 'k', version: 'v3', known: first.token, hasher }).delta, undefined);
  for (const bad of ['', 'x', '1.2.zz', '99999999.1.' + 'a'.repeat(20)]) assert.equal(P.sessionPayload(convo(), { key: 'k', version: 'v1', known: bad, hasher }).delta, undefined);
});

test('the hashes are remembered per version, bounded', () => {
  const hasher = P.createHasher({ max: 4 });
  for (let i = 0; i < 10; i++) P.sessionPayload(convo(), { key: 'k' + i, version: 'v', hasher });
  assert.equal(hasher.size(), 4);
});

test('parts name what they are', () => {
  const d = convo();
  const parts = P.partsOf(d.messages, [3, 2, 2, -1, 99, 1.5]);
  assert.deepEqual(parts.map(p => p.i), [3, 2]);
  assert.equal(parts[0].tid, 'c1'); assert.equal(parts[0].text, d.messages[3].text); assert.deepEqual(parts[0].paths, ['/y']);
  assert.equal(parts[1].id, 'c1'); assert.equal(parts[1].role, 'tool');
});
