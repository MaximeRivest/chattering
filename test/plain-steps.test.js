'use strict';
// Work steps in plain words (plain-steps.js): what the model reads, and the
// service that explains each step once, as soon as it is finished, and a
// finished group's sentence; or an older group in one call.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlainSteps, indexConversation, resolveStep, readAnswer, readPhrases } = require('../plain-steps.js');
const settingsLib = require('../settings.js');

// Two questions on two branches; the second branch's work is three steps.
const conversation = () => ({
  entryParents: [['u1', null], ['a1', 'u1'], ['u2', 'u1'], ['a2', 'u2'], ['r2', 'a2'], ['r3', 'r2']],
  messages: [
    { role: 'user', text: 'first question, on another branch', eid: 'u1' },
    { role: 'tool', name: 'bash', text: 'ls', id: 'call-0', eid: 'a1' },
    { role: 'user', text: 'Why does the app open slowly?', eid: 'u2' },
    { role: 'thinking', text: 'I should look at the startup code first.', eid: 'a2' },
    { role: 'tool', name: 'bash', text: 'grep -rn "startup" server.js', id: 'call-1', eid: 'a2' },
    { role: 'tool', name: 'read', text: '', path: '/p/server.js', id: 'call-2', eid: 'a2' },
    { role: 'toolresult', text: '\n12: startup()\n40: startup done\n', tid: 'call-1', eid: 'r2' },
    { role: 'toolresult', text: 'ENOENT', tid: 'call-2', err: true, eid: 'r3' },
  ],
});
const GROUP = ['k:a2', 't:call-1', 't:call-2'];

test('a step, as the model reads it, once it is finished', () => {
  const ix = indexConversation(conversation());
  const grep = resolveStep(ix, 't:call-1');
  assert.deepEqual([grep.identity, grep.kind, grep.detail, grep.outcome], ['t:call-1', 'bash', 'grep -rn "startup" server.js', '12: startup() / 40: startup done']);
  assert.equal(resolveStep(ix, 't:call-2').outcome, 'failed: ENOENT');
  // A thought is kept under its text: the saved entry and the run agree.
  const saved = resolveStep(ix, 'k:a2');
  const live = resolveStep(ix, 'j:run:ab12:7', { thought: (run, block) => run === 'run:ab12' && block === 7 ? { text: 'I should look at the startup code first.', done: true } : null });
  assert.equal(saved.identity, live.identity);
  assert.match(saved.identity, /^h:[0-9a-f]{32}$/);
  // Not finished, or not there: nothing to explain yet.
  assert.equal(resolveStep(ix, 'j:run:ab12:7', { thought: () => ({ text: 'half a tho', done: false }) }), null);
  assert.equal(resolveStep(ix, 't:call-9', { tool: id => id === 'call-9' ? { name: 'bash', args: 'npm test', out: 'ok', done: false } : null }), null);
  const running = resolveStep(ix, 't:call-9', { tool: id => id === 'call-9' ? { name: 'bash', args: 'npm test', out: '\n12 passed\n', error: false, done: true } : null });
  assert.deepEqual([running.detail, running.outcome], ['npm test', '12 passed']);
  assert.equal(resolveStep(ix, 't:missing'), null);
  assert.equal(resolveStep(ix, 'x:bad'), null);
});

test('a group reply keeps a sentence and phrases for known step numbers only', () => {
  const a = readAnswer({ summary: '  Looked  for\nthe slow part. ', phrases: '1. Thought about where to start\n9. nope\n2.\nnot a step line' }, 2);
  assert.deepEqual(a, { summary: 'Looked for the slow part.', steps: { 1: 'Thought about where to start' } });
  assert.throws(() => readAnswer({ summary: '', phrases: '' }, 1), /no explanation/);
  assert.deepEqual(readPhrases('[1] Read the notes\n2) Ran the tests\n- 3: "Checked the page"\n4 \u2014 Fixed it', 4),
    { 1: 'Read the notes', 2: 'Ran the tests', 3: 'Checked the page', 4: 'Fixed it' });
  assert.deepEqual(readPhrases('1. Read the notes\n2. Ra', 3, { partial: true }), { 1: 'Read the notes', 2: 'Ra' });
});

const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const PHRASE = { thinking: 'Worked out where to start', bash: 'Searched the code', read: 'Tried to open the server file' };
const answer = (program, inputs) => program === 'step' ? { phrase: PHRASE[inputs.step.split('\n')[0]] || 'Did a step' }
  : program === 'summary' ? { summary: 'Looked for why the app starts slowly.' }
  : { summary: 'Looked at the whole group.', phrases: inputs.steps.split('\n\n').map((_, i) => `${i + 1}. Group step ${i + 1}`).join('\n') };

function service(t, { run = answer, model = () => 'small/fast', ...rest } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-steps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'plain-steps.json');
  const calls = [];
  const make = () => createPlainSteps({ file, model, run: async (program, inputs, live) => { calls.push({ program, inputs }); return run(program, inputs, live); }, ...rest });
  return { file, calls, make };
}

test('work being done: each finished step alone and side by side, no sentence yet', async t => {
  const { calls, make } = service(t);
  const steps = make();
  const first = steps.lookup(conversation(), [{ g: 'a', steps: GROUP, settled: false }], { key: 'k1' });
  assert.equal(first.groups.a.jobs.length, 3);
  await settle();
  assert.deepEqual(calls.map(c => c.program), ['step', 'step', 'step'], 'three calls, started together');
  assert.match(calls[0].inputs.step, /^thinking\nthought: I should look/);
  assert.equal(calls[0].inputs.request, 'Why does the app open slowly?');
  const again = steps.lookup(conversation(), [{ g: 'a', steps: GROUP, settled: false }], { key: 'k1' }).groups.a;
  assert.deepEqual(again, { steps: { 'k:a2': 'Worked out where to start', 't:call-1': 'Searched the code', 't:call-2': 'Tried to open the server file' }, jobs: [] });
});

test('a finished group whose phrases are in: one small call for its sentence, reading the phrases', async t => {
  const { calls, make, file } = service(t);
  const steps = make();
  steps.lookup(conversation(), [{ g: 'a', steps: GROUP, settled: false }], { key: 'k1' });
  await settle();
  const settled = steps.lookup(conversation(), [{ g: 'a', steps: GROUP, settled: true }], { key: 'k1' }).groups.a;
  assert.equal(settled.jobs.length, 1);
  await settle();
  assert.equal(calls.at(-1).program, 'summary');
  assert.equal(calls.at(-1).inputs.phrases, '1. Worked out where to start\n2. Searched the code\n3. Tried to open the server file');
  assert.doesNotMatch(calls.at(-1).inputs.phrases, /grep/);
  assert.equal(steps.lookup(conversation(), [{ g: 'a', steps: GROUP, settled: true }], { key: 'k1' }).groups.a.summary, 'Looked for why the app starts slowly.');
  // Kept across restarts, and shared by a copy of the conversation.
  await new Promise(r => setTimeout(r, 1100));
  const fork = conversation(); fork.messages[0].text = 'renamed';
  const kept = make().lookup(fork, [{ g: 'a', steps: GROUP, settled: true }], { key: 'k2' }).groups.a;
  assert.equal(kept.summary, 'Looked for why the app starts slowly.');
  assert.equal(Object.keys(kept.steps).length, 3);
  assert.equal(calls.length, 4);
  assert.ok(fs.statSync(file).mode & 0o600);
});

test('an older group, mostly unexplained, is one call; a few missing phrases are asked alone', async t => {
  const data = { messages: [{ role: 'user', text: 'q', eid: 'u' }] };
  const names = [];
  for (let i = 0; i < 8; i++) {
    data.messages.push({ role: 'tool', name: 'bash', text: 'cmd ' + i, id: 'c' + i, eid: 'a' }, { role: 'toolresult', text: 'out ' + i, tid: 'c' + i, eid: 'r' + i });
    names.push('t:c' + i);
  }
  const { calls, make } = service(t);
  const steps = make();
  steps.lookup(data, [{ g: 'a', steps: names, settled: true }], { key: 'k1' });
  await settle();
  assert.deepEqual(calls.map(c => c.program), ['group']);
  const done = steps.lookup(data, [{ g: 'a', steps: names, settled: true }], { key: 'k1' }).groups.a;
  assert.equal(done.summary, 'Looked at the whole group.');
  assert.equal(done.steps['t:c7'], 'Group step 8');
  // The group grew by two steps: those two alone, then a new sentence.
  data.messages.push({ role: 'tool', name: 'bash', text: 'cmd 8', id: 'c8', eid: 'a' }, { role: 'toolresult', text: 'out', tid: 'c8', eid: 'r8' },
    { role: 'tool', name: 'read', text: 'x', id: 'c9', eid: 'a' }, { role: 'toolresult', text: 'out', tid: 'c9', eid: 'r9' });
  const grown = [...names, 't:c8', 't:c9'];
  steps.lookup(data, [{ g: 'a', steps: grown, settled: true }], { key: 'k1' });
  await settle();
  steps.lookup(data, [{ g: 'a', steps: grown, settled: true }], { key: 'k1' });
  await settle();
  assert.deepEqual(calls.map(c => c.program), ['group', 'step', 'step', 'summary']);
});

test('the answer streams to every conversation waiting on it, in its own step names', async t => {
  const told = [];
  const lives = [];
  const finishers = [];
  const { make } = service(t, {
    run: (program, inputs, live) => { lives.push(live); return new Promise(r => finishers.push(() => r(answer(program, inputs)))); },
    onProgress: p => told.push(p), throttleMs: 0,
  });
  const steps = make();
  const job = steps.lookup(conversation(), [{ g: 'a', steps: ['t:call-1'], settled: false }], { key: 'k1' }).groups.a.jobs[0];
  await settle();
  // Another step, asked meanwhile: a call of its own.
  steps.lookup(conversation(), [{ g: 'b', steps: ['k:a2'], settled: false }], { key: 'k1' });
  await settle();
  lives[0].text('phrase', 'Searched ');
  await new Promise(r => setTimeout(r, 5));
  lives[0].text('phrase', 'the code');
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(told.at(-1), { key: 'k1', job, state: 'writing', steps: { 't:call-1': 'Searched the code' } });
  // Someone opening the conversation now sees what is written so far.
  assert.deepEqual(steps.lookup(conversation(), [{ g: 'a', steps: ['t:call-1'], settled: false }], { key: 'k1' }).groups.a.writing, { 't:call-1': 'Searched the code' });
  lives[0].retry(); await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(told.at(-1).steps, {});
  finishers[0](); await settle();
  assert.deepEqual(told.filter(p => p.state === 'done').map(p => p.steps), [{ 't:call-1': 'Searched the code' }]);
});

test('a failed call waits before it is asked again; a paused model says until when', async t => {
  let now = 1000;
  let fail = new Error('rate limited');
  const told = [];
  const { calls, make } = service(t, { run: () => { throw fail; }, now: () => now, retryMs: 5000, onProgress: p => told.push(p) });
  const steps = make();
  const ask = () => steps.lookup(conversation(), [{ g: 'a', steps: ['t:call-1'], settled: false }], { key: 'k1' }).groups.a;
  ask(); await settle();
  assert.deepEqual([told.at(-1).state, told.at(-1).reason], ['failed', 'rate limited']);
  assert.deepEqual(ask().jobs, [], 'not asked again yet');
  now += 5001;
  fail = Object.assign(new Error('paused'), { retryAt: now + 60000 });
  assert.equal(ask().jobs.length, 1);
  await settle();
  now += 30000;
  assert.deepEqual(ask().jobs, []);
  assert.equal(calls.length, 2);
});

test('a few calls at a time, newest asked first', async t => {
  const release = [];
  const { calls, make } = service(t, { run: (program, inputs) => new Promise(r => release.push(() => r(answer(program, inputs)))), concurrency: 1 });
  const steps = make();
  steps.lookup(conversation(), [{ g: 'old', steps: ['t:call-1'], settled: false }], { key: 'k1' });
  steps.lookup(conversation(), [{ g: 'x', steps: ['t:call-2'], settled: false }], { key: 'k1' });
  steps.lookup(conversation(), [{ g: 'new', steps: ['k:a2'], settled: false }], { key: 'k1' });
  await tick();
  assert.equal(calls.length, 1);
  release.shift()(); await settle();
  assert.equal(calls.length, 2);
  assert.match(calls[1].inputs.step, /^thinking/, 'the latest request went before the older one');
});

test('the setting: off by default; a model of its own needs both halves', () => {
  assert.deepEqual(settingsLib.normalizeSettings({}).plainSteps, { on: false, provider: '', model: '' });
  assert.deepEqual(settingsLib.normalizeSettings({ plainSteps: { on: true, provider: 'anthropic' } }).plainSteps, { on: true, provider: '', model: '' });
  assert.deepEqual(settingsLib.normalizeSettings({ plainSteps: { on: 'yes', provider: 'a', model: 'b c' } }).plainSteps, { on: false, provider: '', model: '' });
});
