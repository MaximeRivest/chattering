'use strict';
// Work steps in plain words (plain-steps.js): what the model reads, and the
// service that asks once per group and remembers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlainSteps, indexConversation, groupInputs, readAnswer, readPhrases } = require('../plain-steps.js');
const settingsLib = require('../settings.js');

// Two questions on two branches; the second branch's work is two steps.
const conversation = () => ({
  entryParents: [['u1', null], ['a1', 'u1'], ['u2', 'u1'], ['a2', 'u2'], ['r2', 'a2']],
  messages: [
    { role: 'user', text: 'first question, on another branch', eid: 'u1' },
    { role: 'tool', name: 'bash', text: 'ls', id: 'call-0', eid: 'a1' },
    { role: 'user', text: 'Why does the app open slowly?', eid: 'u2' },
    { role: 'thinking', text: 'I should look at the startup code first.', eid: 'a2' },
    { role: 'tool', name: 'bash', text: 'grep -rn "startup" server.js', id: 'call-1', eid: 'a2' },
    { role: 'tool', name: 'read', text: '', path: '/p/server.js', id: 'call-2', eid: 'a2' },
    { role: 'toolresult', text: '\n12: startup()\n40: startup done\n', tid: 'call-1', eid: 'r2' },
    { role: 'toolresult', text: 'ENOENT', tid: 'call-2', err: true, eid: 'r2' },
  ],
});

test('the model reads the question of this branch and the numbered steps', () => {
  const ix = indexConversation(conversation());
  const built = groupInputs(ix, ['k:a2', 't:call-1', 't:call-2', 't:missing', 'x:bad', 't:call-1']);
  assert.deepEqual(built.ids, ['k:a2', 't:call-1', 't:call-2']);
  assert.equal(built.inputs.request, 'Why does the app open slowly?');
  const steps = built.inputs.steps.split('\n\n');
  assert.equal(steps.length, 3);
  assert.match(steps[0], /^\[1\] thinking\nthought: I should look at the startup code first\.$/);
  assert.match(steps[1], /^\[2\] bash\ngiven: grep -rn "startup" server\.js\ncame back: 12: startup\(\) \/ 40: startup done$/);
  assert.match(steps[2], /^\[3\] read\ngiven: \/p\/server\.js\ncame back: failed: ENOENT$/);
  assert.equal(groupInputs(ix, ['t:missing']), null);
});

test('a long group shares the text budget; every step keeps a start', () => {
  const data = { messages: [{ role: 'user', text: 'q', eid: 'u' }] };
  const ids = [];
  for (let i = 0; i < 300; i++) {
    data.messages.push({ role: 'tool', name: 'bash', text: 'x'.repeat(5000), id: 'c' + i, eid: 'a' });
    ids.push('t:c' + i);
  }
  const built = groupInputs(indexConversation(data), ids);
  assert.equal(built.ids.length, 200, 'at most 200 steps per group');
  const total = built.inputs.steps.length;
  assert.ok(total < 40000, 'bounded: ' + total);
  assert.ok(built.inputs.steps.split('\n\n').every(s => /given: x{50}/.test(s)));
});

test('the answer keeps a sentence and phrases for known step numbers only', () => {
  const a = readAnswer({ summary: '  Looked  for\nthe slow part. ', phrases: '1. Thought about where to start\n9. nope\n2.\nnot a step line' }, ['k:a', 't:b']);
  assert.deepEqual(a, { summary: 'Looked for the slow part.', steps: { 1: 'Thought about where to start' } });
  assert.throws(() => readAnswer({ summary: '', phrases: '' }, ['t:b']), /no explanation/);
  // The forms a model tends to use.
  assert.deepEqual(readPhrases('[1] Read the notes\n2) Ran the tests\n- 3: "Checked the page"\n4 \u2014 Fixed it', 4),
    { 1: 'Read the notes', 2: 'Ran the tests', 3: 'Checked the page', 4: 'Fixed it' });
  // Being written: the last line counts once it has a word started.
  assert.deepEqual(readPhrases('1. Read the notes\n2. Ra', 3, { partial: true }), { 1: 'Read the notes', 2: 'Ra' });
  assert.deepEqual(readPhrases('1. Read the notes\n2', 3, { partial: true }), { 1: 'Read the notes' });
});

function service(t, { run, model = () => 'small/fast', ...rest } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-steps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'plain-steps.json');
  const calls = [];
  const make = () => createPlainSteps({ file, model, run: async (inputs, meta) => { calls.push(inputs); return run(inputs, meta); }, ...rest });
  return { file, calls, make };
}
const tick = () => new Promise(r => setTimeout(r, 0));
const answer = inputs => ({ summary: 'Looked at how the app starts.', phrases: inputs.steps.split('\n\n').map((_, i) => (i + 1) + '. Step ' + (i + 1)).join('\n') });

test('one call per group: pending, then the answer by step id, shared and remembered on disk', async t => {
  const { file, calls, make } = service(t, { run: answer });
  const steps = make();
  const groups = [{ g: 'a', steps: ['k:a2', 't:call-1'] }];
  const first = steps.lookup(conversation(), groups, { key: 'k1' });
  assert.deepEqual(Object.keys(first.pending), ['a']);
  assert.match(first.pending.a, /^[0-9a-f]{20}$/);
  assert.deepEqual([first.results, first.partial, first.failed], [{}, {}, {}]);
  // Asked again while it is being written: no second call.
  steps.lookup(conversation(), groups);
  await tick(); await tick();
  assert.equal(calls.length, 1);
  const second = steps.lookup(indexConversation(conversation()), groups);
  assert.deepEqual(second.results.a, { summary: 'Looked at how the app starts.', steps: { 'k:a2': 'Step 1', 't:call-1': 'Step 2' } });
  // A copy of the conversation (a fork) asks the same thing: same answer.
  const fork = conversation(); fork.messages[0].text = 'renamed';
  assert.ok(steps.lookup(fork, groups).results.a);
  await new Promise(r => setTimeout(r, 1100)); // the debounced save
  const again = make();
  assert.ok(again.lookup(conversation(), groups).results.a, 'kept across restarts');
  assert.equal(calls.length, 1);
  assert.ok(fs.statSync(file).mode & 0o600);
});

test('another model, or a changed step, is another question', async t => {
  let label = 'small/fast';
  const { calls, make } = service(t, { run: answer, model: () => label });
  const steps = make();
  const groups = [{ g: 'a', steps: ['t:call-1'] }];
  steps.lookup(conversation(), groups); await tick(); await tick();
  label = 'other/model';
  assert.deepEqual(Object.keys(steps.lookup(conversation(), groups).pending), ['a']);
  await tick(); await tick();
  const edited = conversation(); edited.messages[4].text = 'grep -rn "boot" server.js';
  assert.deepEqual(Object.keys(steps.lookup(edited, groups).pending), ['a']);
  await tick(); await tick();
  assert.equal(calls.length, 3);
});

test('a failed group waits before it is asked again; a paused model says until when', async t => {
  let now = 1000;
  let fail = new Error('rate limited');
  const { calls, make } = service(t, { run: () => { throw fail; }, now: () => now, retryMs: 5000 });
  const steps = make();
  const groups = [{ g: 'a', steps: ['t:call-1'] }];
  steps.lookup(conversation(), groups); await tick(); await tick();
  assert.deepEqual(steps.lookup(conversation(), groups).failed, { a: 'rate limited' });
  now += 5001;
  fail = Object.assign(new Error('paused'), { retryAt: now + 60000 });
  assert.deepEqual(Object.keys(steps.lookup(conversation(), groups).pending), ['a']);
  await tick(); await tick();
  now += 30000;
  assert.deepEqual(steps.lookup(conversation(), groups).failed, { a: 'paused' });
  assert.equal(calls.length, 2);
  assert.deepEqual(steps.lookup(conversation(), [{ g: 'b', steps: ['t:nope'] }]).failed, { b: 'nothing here to explain' });
});

test('a few calls at a time, newest asked first', async t => {
  const release = [];
  const { calls, make } = service(t, { run: inputs => new Promise(r => release.push(() => r(answer(inputs)))), concurrency: 1 });
  const steps = make();
  steps.lookup(conversation(), [{ g: 'old', steps: ['t:call-1'] }]);
  steps.lookup(conversation(), [{ g: 'x', steps: ['t:call-2'] }]);
  steps.lookup(conversation(), [{ g: 'new', steps: ['k:a2'] }]);
  await tick();
  assert.equal(calls.length, 1);
  release.shift()(); await tick(); await tick(); await tick();
  assert.equal(calls.length, 2);
  assert.match(calls[1].steps, /^\[1\] thinking/, 'the latest request went before the older one');
});

test('the setting: off by default; a model of its own needs both halves', () => {
  assert.deepEqual(settingsLib.normalizeSettings({}).plainSteps, { on: false, provider: '', model: '' });
  assert.deepEqual(settingsLib.normalizeSettings({ plainSteps: { on: true, provider: 'anthropic' } }).plainSteps, { on: true, provider: '', model: '' });
  assert.deepEqual(settingsLib.normalizeSettings({ plainSteps: { on: 'yes', provider: 'a', model: 'b c' } }).plainSteps, { on: false, provider: '', model: '' });
});

test('the answer streams to every conversation waiting on it, in its own step ids', async t => {
  const told = [];
  let live, finish;
  const { make } = service(t, {
    run: (inputs, l) => { live = l; return new Promise(r => { finish = () => r({ summary: 'Looked at how the app starts.', phrases: '1. Worked out where to start\n2. Searched the code' }); }); },
    onProgress: p => told.push(p), throttleMs: 0,
  });
  const steps = make();
  const groups = [{ g: 'a', steps: ['k:a2', 't:call-1'] }];
  const job = steps.lookup(conversation(), groups, { key: 'k1' }).pending.a;
  await tick();
  // A fork of the conversation, whose steps have other ids, asks the same thing.
  const fork = conversation();
  fork.messages = fork.messages.map(m => ({ ...m, ...(m.eid === 'a2' ? { eid: 'b2' } : {}), ...(m.id === 'call-1' ? { id: 'fork-1' } : {}), ...(m.tid === 'call-1' ? { tid: 'fork-1' } : {}) }));
  fork.entryParents = [['u1', null], ['u2', 'u1'], ['b2', 'u2'], ['r2', 'b2']];
  assert.equal(steps.lookup(fork, [{ g: 'f', steps: ['k:b2', 't:fork-1'] }], { key: 'k2' }).pending.f, job);
  live.text('summary', 'Looked at ');
  await new Promise(r => setTimeout(r, 5));
  live.text('summary', 'how the app starts.');
  live.text('phrases', '1. Worked out where to start\n2. Sea');
  await new Promise(r => setTimeout(r, 5));
  const last = told.filter(p => p.key === 'k1').at(-1);
  assert.deepEqual(last, { key: 'k1', job, state: 'writing', summary: 'Looked at how the app starts.', steps: { 'k:a2': 'Worked out where to start', 't:call-1': 'Sea' } });
  assert.deepEqual(told.filter(p => p.key === 'k2').at(-1).steps, { 'k:b2': 'Worked out where to start', 't:fork-1': 'Sea' });
  // Someone opening the conversation now sees what is written so far.
  assert.deepEqual(steps.lookup(conversation(), groups, { key: 'k1' }).partial.a.summary, 'Looked at how the app starts.');
  // A retry starts the answer again.
  live.retry(); await new Promise(r => setTimeout(r, 5));
  assert.equal(told.at(-1).summary, '');
  finish(); await tick(); await tick();
  const done = told.filter(p => p.state === 'done');
  assert.deepEqual(done.map(p => p.key).sort(), ['k1', 'k2']);
  assert.deepEqual(done.find(p => p.key === 'k1').steps, { 'k:a2': 'Worked out where to start', 't:call-1': 'Searched the code' });
});

test('writing is sent at most every throttle period, with the latest text; a failure is told', async t => {
  const told = [];
  let live, fail;
  const { make } = service(t, { run: (inputs, l) => { live = l; return new Promise((_, no) => { fail = no; }); }, onProgress: p => told.push(p), throttleMs: 40 });
  const steps = make();
  steps.lookup(conversation(), [{ g: 'a', steps: ['t:call-1'] }], { key: 'k1' });
  await tick();
  for (const piece of 'Looked at the start.'.split('')) live.text('summary', piece);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(told.length, 1);
  assert.equal(told[0].summary, 'Looked at the start.');
  fail(new Error('rate limited')); await tick(); await tick();
  assert.deepEqual([told.at(-1).state, told.at(-1).reason], ['failed', 'rate limited']);
});
