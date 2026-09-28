'use strict';
// programs-live.js: what a person watching Chattering's AI programs sees
// while they run (design/74, "Live"), from FunctAI stream events
// (functai contract/streaming.md), without a server.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLiveCalls, scopeOf } = require('../programs-live.js');

// A stream's events, pushed by the test and read by the tracker.
function events() {
  const queue = [];
  let wake = null, ended = false;
  return {
    push(e) { queue.push(e); if (wake) { wake(); wake = null; } },
    end() { ended = true; if (wake) { wake(); wake = null; } },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift();
        if (ended) return;
        await new Promise(r => { wake = r; });
      }
    },
  };
}
const tick = () => new Promise(r => setImmediate(r));

// Timers the test moves by hand.
function clock() {
  let t = 1_000_000;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const x = { at: t + ms, fn }; timers.push(x); return x; },
    clearTimer: x => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      t += ms;
      for (;;) {
        const due = timers.filter(x => x.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
      }
    },
  };
}

function setup(opts = {}) {
  const c = clock();
  const batches = [];
  const live = createLiveCalls({ publish: ops => batches.push(ops), now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, ...opts });
  const ops = () => batches.flat();
  return { live, clock: c, batches, ops };
}
const meta = (extra = {}) => ({ name: 'conversation_title', module: 'chattering', answer: 'title', outputs: ['label', 'title'],
  inputs: { opening_user_messages: ['The login loops.'] }, caller: { kind: 'chattering', conversation: 'pi:x.jsonl', user: 'maxime' }, content: true, ...extra });
const started = { kind: 'started', call: 'c1', function: 'conversation_title', parent: null, inputs: {} };
const text = (field, t, answer = field === 'title') => ({ kind: 'text', call: 'c1', function: 'conversation_title', field, answer, text: t });

test('a call as it runs: started, text gathered per output, done; ops in order with versions', async () => {
  const { live, clock, batches, ops } = setup();
  const ev = events();
  const tracker = live.track(meta(), ev);
  ev.push(started); await tick();
  ev.push(text('label', 'Auth')); ev.push(text('label', ' loop')); ev.push(text('title', 'Fix login')); ev.push(text('title', ' loop'));
  await tick();
  assert.equal(batches.length, 0, 'nothing leaves before the flush');
  clock.advance(60);
  assert.equal(batches.length, 1, 'one batch');
  const [start, label, title] = ops();
  assert.equal(start.op, 'start');
  assert.equal(start.id, 'c1');
  assert.deepEqual(start.scope, { key: 'pi:x.jsonl' });
  assert.deepEqual(start.call.inputs, { opening_user_messages: { text: '[\n  "The login loops."\n]', line: '["The login loops."]' } });
  assert.deepEqual([label.op, label.field, label.text, label.answer], ['text', 'label', 'Auth loop', false], 'the pieces of one output gather');
  assert.deepEqual([title.field, title.text, title.answer], ['title', 'Fix login loop', true]);
  assert.ok(start.v < label.v && label.v < title.v, 'versions grow');
  ev.push({ kind: 'done', call: 'c1', function: 'conversation_title', value: 'Fix login loop' });
  ev.end(); await tracker.done;
  clock.advance(60);
  const end = ops().at(-1);
  assert.deepEqual([end.op, end.state, end.error], ['end', 'done', null]);
  assert.equal(typeof end.seconds, 'number');
  const [snap] = live.snapshot();
  assert.equal(snap.state, 'done');
  assert.deepEqual(snap.fields.map(f => [f.name, f.text]), [['label', 'Auth loop'], ['title', 'Fix login loop']]);
  assert.equal(snap.v, end.v, 'the snapshot is the state after the last op');
  // It stays a while (the page swaps it for its example), then goes.
  clock.advance(29000);
  assert.equal(live.snapshot().length, 1);
  clock.advance(1100);
  assert.equal(live.snapshot().length, 0);
  clock.advance(60);
  assert.deepEqual(ops().at(-1), { op: 'gone', id: 'c1', scope: { key: 'pi:x.jsonl' } });
});

test('a retry voids the text so far; thinking is shown, and voided too', async () => {
  const { live, clock, ops } = setup();
  const ev = events();
  live.track(meta(), ev);
  ev.push(started);
  ev.push({ kind: 'thinking', call: 'c1', function: 'conversation_title', text: 'The user wants' });
  ev.push(text('label', 'Sure! The'));
  ev.push({ kind: 'retry', call: 'c1', function: 'conversation_title', reason: 'the reply could not be read', wait: null });
  ev.push(text('label', 'Auth'));
  await tick(); clock.advance(60);
  assert.deepEqual(ops().map(o => o.op), ['start', 'thinking', 'text', 'reset', 'text']);
  const reset = ops()[3];
  assert.deepEqual([reset.reason, reset.attempt], ['the reply could not be read', 2]);
  const [snap] = live.snapshot();
  assert.deepEqual(snap.fields.map(f => f.text), ['Auth'], 'only what came after the retry');
  assert.equal(snap.thinking, '');
  assert.equal(snap.attempt, 2);
  assert.equal(snap.retry.reason, 'the reply could not be read');
});

test('a follower joining mid-call: flush, snapshot, then only what is new', async () => {
  const { live, clock, batches } = setup();
  const ev = events();
  live.track(meta(), ev);
  ev.push(started); ev.push(text('title', 'Fix')); await tick();
  // The server flushes before the snapshot: the batch goes to those already following.
  live.flush();
  const snap = live.snapshot()[0];
  assert.equal(snap.fields[0].text, 'Fix');
  const before = batches.length;
  ev.push(text('title', ' login')); await tick(); clock.advance(60);
  const next = batches.slice(before).flat();
  assert.deepEqual(next.map(o => [o.op, o.text]), [['text', ' login']]);
  assert.ok(next[0].v > snap.v, 'newer than the snapshot: applied once');
});

test('failures, a closed stream, and a stream that breaks off', async () => {
  const { live, clock, ops } = setup();
  const failing = events();
  live.track(meta(), failing);
  failing.push(started);
  failing.push({ kind: 'failed', call: 'c1', function: 'conversation_title', error: { type: 'Refusal', code: 'parse-missing-fields', message: 'reply is missing <title>' } });
  failing.end(); await tick();
  const cancelled = events();
  live.track(meta(), cancelled);
  cancelled.push({ ...started, call: 'c2' });
  cancelled.push({ kind: 'failed', call: 'c2', function: 'conversation_title', error: { type: 'Cancelled' } });
  cancelled.end(); await tick();
  const broken = events();
  const t = live.track(meta(), broken);
  broken.push({ ...started, call: 'c3' });
  broken.end(); await t.done;
  clock.advance(60);
  const ends = ops().filter(o => o.op === 'end');
  assert.deepEqual(ends.map(o => [o.id, o.state]), [['c1', 'failed'], ['c2', 'cancelled'], ['c3', 'failed']]);
  assert.deepEqual(ends[0].error, { type: 'Refusal', code: 'parse-missing-fields', message: 'reply is missing <title>' });
  assert.match(ends[2].error.message, /without saying how/);
});

test('a call logged as sizes only shows its inputs as sizes only, and no error message', async () => {
  const { live, clock, ops } = setup();
  const ev = events();
  live.track(meta({ name: 'conversation_evidence', inputs: { conversation: 'x'.repeat(500) }, content: false, caller: {} }), ev);
  ev.push({ ...started, function: 'conversation_evidence' });
  ev.push({ kind: 'failed', call: 'c1', function: 'conversation_evidence', error: { type: 'Refusal', message: 'the reply said: secret' } });
  ev.end(); await tick(); clock.advance(60);
  const [start, end] = ops();
  assert.equal(start.call.inputs, null);
  assert.deepEqual(start.call.sizes, { conversation: 502 });
  assert.deepEqual(start.scope, {});
  assert.deepEqual(end.error, { type: 'Refusal' });
});

test('limits: long inputs and outputs are cut, and say so', async () => {
  const { live, clock, ops } = setup({ maxText: 10, maxInput: 5, maxThinking: 4 });
  const ev = events();
  live.track(meta({ inputs: { opening_user_messages: 'abcdefgh' } }), ev);
  ev.push(started);
  ev.push(text('title', '123456')); ev.push(text('title', '7890AB')); ev.push(text('title', 'more'));
  ev.push({ kind: 'thinking', call: 'c1', function: 'conversation_title', text: 'hmmmm' });
  await tick(); clock.advance(60);
  const [start, t, th] = ops();
  assert.deepEqual(start.call.inputs.opening_user_messages, { text: 'abcde', line: 'abcdefgh', cut: true });
  assert.deepEqual([t.text, t.cut], ['1234567890', true]);
  assert.deepEqual([th.text, th.cut], ['hmmm', true]);
  assert.equal(live.snapshot()[0].fields[0].cut, true);
});

test('a raw program: the text as the model writes it, the stream\u2019s own text ignored', async () => {
  const { live, clock, ops } = setup();
  const ev = events();
  const tracker = live.track(meta({ name: 'doc_sentence', answer: 'result', outputs: ['result'], raw: true }), ev);
  tracker.raw(' and'); // before the call is known: kept
  ev.push({ ...started, function: 'doc_sentence' }); await tick();
  tracker.raw(' then');
  ev.push({ kind: 'text', call: 'c1', function: 'doc_sentence', field: 'result', answer: true, text: 'and then' });
  ev.push({ kind: 'done', call: 'c1', function: 'doc_sentence', value: 'and then' });
  ev.end(); await tick(); clock.advance(60);
  assert.deepEqual(ops().filter(o => o.op === 'text').map(o => o.text), [' and then']);
  assert.equal(live.snapshot()[0].fields[0].text, ' and then', 'the leading space kept');
});

test('a call inside the call is left to the log; tools start the text afresh', async () => {
  const { live, clock, ops } = setup();
  const ev = events();
  live.track(meta(), ev);
  ev.push(started);
  ev.push(text('title', 'draft'));
  ev.push({ kind: 'started', call: 'inner', function: 'helper', parent: 'c1', inputs: {} });
  ev.push({ kind: 'text', call: 'inner', function: 'helper', field: 'result', answer: true, text: 'inner text' });
  ev.push({ kind: 'tool_result', call: 'c1', function: 'conversation_title', id: 't', name: 'look', output: 'x' });
  await tick(); clock.advance(60);
  assert.deepEqual(ops().map(o => o.op), ['start', 'text', 'reset']);
  assert.equal(ops()[2].reason, null, 'not a retry');
  assert.equal(live.snapshot()[0].attempt, 1);
});

test('ended calls are kept for a while, the oldest dropped past the limit', async () => {
  const { live, clock } = setup({ maxEnded: 2 });
  for (const id of ['a', 'b', 'c']) {
    const ev = events();
    live.track(meta(), ev);
    ev.push({ ...started, call: id });
    ev.push({ kind: 'done', call: id, function: 'conversation_title', value: 'x' });
    ev.end();
    await tick();
  }
  clock.advance(60);
  assert.deepEqual(live.snapshot().map(c => c.id), ['b', 'c']);
});

test('what a call is about, for who may watch it', () => {
  assert.deepEqual(scopeOf({ kind: 'chattering', conversation: 'pi:a', project: 'p', file: '/w/a.md', user: 'x' }), { key: 'pi:a', project: 'p', path: '/w/a.md' });
  assert.deepEqual(scopeOf({ repository: '/w/repo' }), { path: '/w/repo' });
  assert.deepEqual(scopeOf({}), {});
});
