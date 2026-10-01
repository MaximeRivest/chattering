'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const W = require('../activity-watch');
const P = require('../processes');

const MIN = 60000;

test('reminders come at 1, 3, 9, then every 9 times the threshold, and a gap sends one, not a burst', () => {
  const t = 20 * MIN;
  assert.deepEqual([0, 1, 2, 3, 4].map(l => W.nextReminderMs(l, t) / MIN), [20, 60, 180, 360, 540]);
  assert.equal(W.quietLevel(19 * MIN, t), -1);
  assert.equal(W.quietLevel(20 * MIN, t), 0);
  assert.equal(W.quietLevel(59 * MIN, t), 0);
  assert.equal(W.quietLevel(60 * MIN, t), 1);
  // Four hours quiet (the 2026-09-28 builder): the 3-hour reminder is the one due.
  assert.equal(W.quietLevel(240 * MIN, t), 2);
  assert.equal(W.quietLevel(600 * MIN, t), 4);
  assert.equal(W.quietLevel(10 * 24 * 60 * MIN, 0), -1, 'a zero threshold is off');
});

test('labels and tool descriptions are one bounded line in plain words', () => {
  assert.equal(W.quietLabel(25 * MIN), '25 min');
  assert.equal(W.quietLabel(250 * MIN), '4 h 10 min');
  assert.equal(W.quietLabel(120 * MIN), '2 h');
  assert.equal(W.quietLabel(50 * 60 * MIN), '2 d 2 h');
  assert.equal(W.toolWhat('bash', { command: 'cd ts &&\n  node --test tests/stage1-runtime.test.ts' }), 'bash: cd ts && node --test tests/stage1-runtime.test.ts');
  assert.equal(W.toolWhat('read', { path: '/tmp/a.md' }), 'read: /tmp/a.md');
  assert.equal(W.toolWhat('bash', '{"command":"sleep 9"}'), 'bash: sleep 9');
  assert.equal(W.toolWhat('mystery', {}), 'mystery');
  assert.ok(W.toolWhat('bash', { command: 'x'.repeat(1000) }).length <= 306);
});

test('open tool calls come from start and update events without an end, as pi writes them', () => {
  const lines = [
    JSON.stringify({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash', args: { command: 'ls' } }),
    JSON.stringify({ type: 'tool_execution_end', toolCallId: 'a', toolName: 'bash' }),
    '{half a line',
    // The start fell before the tail; an update still names the call.
    JSON.stringify({ type: 'tool_execution_update', toolCallId: 'b', toolName: 'bash', args: { command: 'npm test' } }),
    JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } }),
  ];
  assert.deepEqual(W.openToolsFromEvents(lines), [{ id: 'b', name: 'bash', what: 'bash: npm test' }]);
});

test('the tail of a large log yields whole lines only', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'activity-tail-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'stdout.jsonl');
  const lines = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ n: i, pad: 'x'.repeat(40) }));
  await fs.writeFile(file, lines.join('\n') + '\n');
  const tail = await W.readTail(file, 4096);
  assert.ok(tail.length > 10 && tail.length < 100);
  for (const l of tail) JSON.parse(l);
  assert.equal(JSON.parse(tail.at(-1)).n, 1999);
  assert.deepEqual(await W.readTail(path.join(dir, 'missing')), []);
});

test('a live run records its last event and the tool calls still open', () => {
  let clock = 1000;
  const a = W.createRunActivity(() => clock);
  assert.equal(a.lastAt(), 1000);
  clock = 2000; a.observe({ type: 'tool_execution_start', toolCallId: 'x', toolName: 'bash', args: { command: 'make' } });
  clock = 3000; a.observe({ type: 'tool_execution_update', toolCallId: 'x', toolName: 'bash' });
  assert.equal(a.lastAt(), 3000);
  assert.deepEqual(a.openTools(), [{ id: 'x', name: 'bash', what: 'bash: make', startedAt: 2000 }]);
  a.observe({ type: 'tool_execution_end', toolCallId: 'x' });
  assert.deepEqual(a.openTools(), []);
});

test('the process report excludes the agent itself, orders busiest first, and says unknown rather than guess', () => {
  const table = [
    { pid: 10, ppid: 1, argv: ['pi'] },
    { pid: 11, ppid: 10, argv: ['bash', '-c', 'npm test'] },
    { pid: 12, ppid: 11, argv: ['node', '--test', 'x.test.ts'] },
    { pid: 13, ppid: 11, argv: ['esbuild'] },
    { pid: 99, ppid: 1, argv: ['unrelated'] },
  ];
  const usage = { 11: { ageMs: 4 * 3600000, cpuMs: 50 }, 12: { ageMs: 4 * 3600000, cpuMs: 2000 }, 13: { ageMs: 60000, cpuMs: 30000 } };
  const deps = { list: () => table, descendantsOf: P.descendantsOf, usage: pid => usage[pid] || null };
  const r = W.processReport(10, deps);
  assert.equal(r.count, 3);
  assert.deepEqual(r.top.map(p => [p.pid, p.idle]), [[13, false], [12, true], [11, true]]);
  assert.equal(W.processReport(10, { ...deps, usage: () => null }), null, 'no usage for one process: unknown');
  assert.equal(W.processReport(10, { ...deps, list: () => [] }), null, 'no process table: unknown');
  assert.deepEqual(W.processReport(99, deps), { count: 0, top: [] });
});

test('the quiet paragraph gives the facts a parent needs to decide, and draws a conclusion only from idle processes', () => {
  const processes = { count: 1, top: [{ pid: 12, command: 'node --test x.test.ts', ageMs: 4 * 3600000, cpuMs: 2000, idle: true }] };
  const text = W.describeQuiet({ title: 'TS builder', id: 'abc', quietMs: 250 * MIN,
    openTools: [{ what: 'bash: npm test' }], processes, log: '/d/stdout.jsonl', session: '/s.jsonl' });
  assert.match(text, /^TS builder \(task abc\): no new output for 4 h 10 min\./);
  assert.match(text, /Waiting on bash: npm test\./);
  assert.match(text, /pid 12 node --test x\.test\.ts \(alive 4 h, 2 s of processor time, idle\)/);
  assert.match(text, /likely stuck or waiting on something external/);
  assert.match(text, /Log: \/d\/stdout\.jsonl\. Session: \/s\.jsonl\./);
  const busy = W.describeQuiet({ title: 'T', quietMs: 30 * MIN, openTools: [{ what: 'bash: make' }],
    processes: { count: 1, top: [{ pid: 5, command: 'cc', ageMs: MIN, cpuMs: 50000, idle: false }] } });
  assert.doesNotMatch(busy, /likely stuck/);
  assert.match(W.describeQuiet({ title: 'T', quietMs: 30 * MIN }), /waiting on the model or its connection/);
  assert.doesNotMatch(W.describeQuiet({ title: 'T', quietMs: 30 * MIN, openTools: [{ what: 'bash: x' }], processes: null }), /No process/);
});

test('process usage reads real lifetime and processor time, and ps durations parse', { skip: !['linux', 'darwin'].includes(process.platform) }, async () => {
  // macOS ps reports whole seconds: sample until this process is measurable.
  let u;
  const deadline = Date.now() + 3000;
  do {
    u = P.usage(process.pid);
    if (u && u.ageMs > 0) break;
    await new Promise(r => setTimeout(r, 20));
  } while (Date.now() < deadline);
  assert.ok(u && u.ageMs > 0 && u.cpuMs >= 0);
  assert.equal(P.usage(-1), null);
  assert.equal(P.psDurationMs('04:09:45'), (4 * 3600 + 9 * 60 + 45) * 1000);
  assert.equal(P.psDurationMs('1-02:03:04'), ((26 * 60 + 3) * 60 + 4) * 1000);
  assert.equal(P.psDurationMs('0:02.35'), 2350);
  assert.equal(P.psDurationMs('garbage'), null);
});

test('a real idle process under an agent process is reported with its command and as idle', { skip: !['linux', 'darwin'].includes(process.platform) }, async t => {
  const { spawn } = require('node:child_process');
  // The "agent" (sh) runs a tool (sleep) that never prints: the 2026-09-28 shape.
  const agent = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
  t.after(() => { try { process.kill(-agent.pid); } catch {} try { agent.kill('SIGKILL'); } catch {} });
  let report = null;
  for (let i = 0; i < 50 && !(report && report.count); i++) { await new Promise(r => setTimeout(r, 40)); report = W.processReport(agent.pid, P); }
  assert.ok(report && report.count >= 1, 'the sleeping child is found');
  const sleeper = report.top.find(p => /sleep 30/.test(p.command));
  assert.ok(sleeper, JSON.stringify(report));
  assert.equal(sleeper.idle, true);
  assert.match(W.describeQuiet({ title: 'fixture', quietMs: 25 * MIN, openTools: [{ what: 'bash: sleep 30' }], processes: report }),
    /pid \d+ sleep 30 \(alive \d+ s, 0 s of processor time, idle\)/);
});

test('Given a zero-duration or invalid sample, When reporting activity, Then processor use stays unknown', () => {
  const table = [{ pid: 10, ppid: 1, argv: ['agent'] }, { pid: 11, ppid: 10, argv: ['tool'] }];
  for (const sample of [{ ageMs: 0, cpuMs: 0 }, { ageMs: NaN, cpuMs: 0 }, { ageMs: 1000, cpuMs: -1 }]) {
    const report = W.processReport(10, { list: () => table, descendantsOf: P.descendantsOf, usage: () => sample });
    assert.equal(report, null, 'no idle conclusion from an unmeasurable interval');
  }
});
