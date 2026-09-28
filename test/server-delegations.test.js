'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDelegationCoordinator, inspectDeliverySession, completionMessage } = require('../server-delegations');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'chattering-delivery-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, 'parent.jsonl');
  await fs.writeFile(parent, JSON.stringify({ type: 'session', id: 'session' }) + '\n' + JSON.stringify({ type: 'message', id: 'launch', parentId: null }) + '\n');
  const task = { id: 'a', title: 'Review', parentEntryId: 'launch', parentSessionPath: parent,
    sessionPath: path.join(root, 'child.jsonl'), outputDir: root, status: 'succeeded', review: 'unreviewed', delivery: 'web' };
  return { root, parent, task };
}
async function appendEvent(file, message) {
  await fs.appendFile(file, JSON.stringify({ type: 'custom_message', id: 'callback-' + message.details.deliveryId, parentId: 'launch', ...message }) + '\n');
}
async function until(fn) { for (let i = 0; i < 500; i++) { if (await fn()) return; await wait(10); } assert.fail('Timed out waiting for delivery.'); }

test('waits for siblings, then delivers one honest callback with separate review state', async t => {
  const { root, parent, task } = await fixture(t);
  const tasks = [task, { ...task, id: 'b', status: 'running' }]; let calls = 0;
  const host = createDelegationCoordinator({ root, list: async () => tasks, canDeliver: async () => true,
    deliver: async (file, message) => { calls++; assert.equal(message.customType, 'delegation-complete'); assert.deepEqual(message.details.taskIds, ['a', 'b']); await appendEvent(file, message); } });
  await host.processPending(); assert.equal(calls, 0);
  tasks[1].status = 'failed'; await host.processPending();
  await until(async () => (await host.refresh()).tasks.every(t => t.notificationState === 'delivered'));
  await host.processPending(); assert.equal(calls, 1);
  assert.equal((await host.refresh()).tasks[0].review, 'unreviewed');
});

test('reconciles a persisted callback after host restart without sending twice', async t => {
  const { root, parent, task } = await fixture(t);
  const message = completionMessage([task], 'already-written');
  await appendEvent(parent, message);
  await fs.mkdir(path.join(root, 'notifications'));
  await fs.writeFile(path.join(root, 'notifications/a.json'), JSON.stringify({ state: 'delivering', deliveryId: 'already-written' }));
  const host = createDelegationCoordinator({ root, list: async () => [task], canDeliver: async () => true,
    deliver: async () => assert.fail('Duplicate callback') });
  await host.processPending(); assert.equal((await host.refresh()).tasks[0].notificationState, 'delivered');
});

test('does not move the conversation to an abandoned launch branch', async t => {
  const { root, parent, task } = await fixture(t);
  await fs.appendFile(parent, JSON.stringify({ type: 'message', id: 'another-branch', parentId: null }) + '\n');
  const host = createDelegationCoordinator({ root, list: async () => [task], canDeliver: async () => true,
    deliver: async () => assert.fail('Wrong branch callback') });
  await host.processPending(); assert.equal((await host.refresh()).tasks[0].notificationState, 'blocked');
});

test('busy and terminal-owned parents do not receive callbacks; cancellation does not awaken work', async t => {
  const { root, task } = await fixture(t);
  let can = false, calls = 0;
  const host = createDelegationCoordinator({ root, list: async () => [task], canDeliver: async () => can,
    deliver: async () => { calls++; } });
  await host.processPending(); assert.equal(calls, 0);
  can = true; task.status = 'cancelled'; await host.processPending(); assert.equal(calls, 0);
  assert.equal((await host.refresh()).tasks[0].notificationState, 'cancelled');
});

test('delivery failures back off and expose error instead of claiming success', async t => {
  const { root, task } = await fixture(t); let calls = 0;
  const host = createDelegationCoordinator({ root, list: async () => [task], canDeliver: async () => true,
    deliver: async () => { calls++; throw new Error('No model'); } });
  await host.processPending(); await until(async () => (await host.refresh()).tasks[0].notificationState === 'error');
  await host.processPending(); assert.equal(calls, 1);
  assert.match((await host.refresh()).tasks[0].notificationError, /No model/);
});

test('a long callback cannot block delivery to another parent', async t => {
  const { root, parent, task } = await fixture(t);
  const second = path.join(root, 'second.jsonl'); await fs.copyFile(parent, second);
  let release, started = [];
  const barrier = new Promise(r => { release = r; });
  const host = createDelegationCoordinator({ root, list: async () => [task, { ...task, id: 'b', parentSessionPath: second }], canDeliver: async () => true,
    deliver: async (file, message) => { started.push(file); if (file === parent) await barrier; await appendEvent(file, message); } });
  await host.processPending(); await until(() => started.length === 2); release();
  await until(async () => (await host.refresh()).tasks.every(t => t.notificationState === 'delivered'));
});

test('session inspection handles partial JSON, custom messages and parent cycles', async t => {
  const { parent } = await fixture(t);
  await fs.appendFile(parent, JSON.stringify({ type: 'label', id: 'cycle', parentId: 'cycle' }) + '\n{incomplete');
  const result = await inspectDeliverySession(parent);
  assert.deepEqual([...result.branch], ['cycle']);
});

test('reading a parent covers only the delivered descendants, recursively, up to the delivery moment', async t => {
  const { root, parent, task } = await fixture(t);
  const grandchild = { ...task, id: 'g', parentTaskId: 'a', parentSessionPath: task.sessionPath, sessionPath: path.join(root, 'grandchild.jsonl') };
  const pending = { ...task, id: 'p', sessionPath: path.join(root, 'pending.jsonl') };
  const blocked = { ...task, id: 'b', sessionPath: path.join(root, 'blocked.jsonl') };
  const running = { ...task, id: 'r', status: 'running', sessionPath: path.join(root, 'running.jsonl') };
  const tasks = [task, grandchild, pending, blocked, running];
  await fs.mkdir(path.join(root, 'notifications'));
  await fs.writeFile(path.join(root, 'notifications/a.json'), JSON.stringify({ state: 'delivered', deliveryId: 'x', updatedAt: 1000 }));
  await fs.writeFile(path.join(root, 'notifications/g.json'), JSON.stringify({ state: 'delivered', deliveryId: 'y', updatedAt: 900 }));
  await fs.writeFile(path.join(root, 'notifications/b.json'), JSON.stringify({ state: 'blocked' }));
  await fs.writeFile(path.join(root, 'notifications/r.json'), JSON.stringify({ state: 'delivered', deliveryId: 'z', updatedAt: 1 }));
  const host = createDelegationCoordinator({ root, list: async () => tasks, canDeliver: async () => false, deliver: async () => assert.fail('no delivery') });
  const reported = await host.reportedDescendants(parent);
  assert.deepEqual(reported.map(r => [r.task.id, r.deliveredAt]), [['a', 1000], ['g', 900]]);
  assert.deepEqual(await host.reportedDescendants(path.join(root, 'nobody.jsonl')), []);
});

test('a continued attempt reaches the parent again; the message names the stop reason and the way back', async t => {
  const { root, parent, task } = await fixture(t);
  const current = { ...task, status: 'failed', failure: { kind: 'usage-limit', message: '429', resumable: true } };
  const tasks = [current]; const sent = [];
  const host = createDelegationCoordinator({ root, list: async () => tasks, canDeliver: async () => true,
    deliver: async (file, message) => { sent.push(message); await appendEvent(file, message); } });
  await host.processPending();
  await until(async () => (await host.refresh()).tasks[0].notificationState === 'delivered');
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /failed \(usage-limit\)/);
  assert.match(sent[0].content, /delegation_resume can continue it/);
  // The parent continued it. The host forgets the old outcome; the new one is a new delivery.
  await host.forget('a');
  tasks[0] = { ...task, status: 'running', attempt: 2 };
  await host.processPending(); assert.equal(sent.length, 1);
  tasks[0] = { ...task, status: 'succeeded', attempt: 2 };
  await host.processPending();
  await until(async () => (await host.refresh()).tasks[0].notificationState === 'delivered');
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0].details.deliveryId, sent[1].details.deliveryId);
  assert.match(sent[1].content, /succeeded, attempt 2/);
  await host.processPending(); assert.equal(sent.length, 2);
});

// ---- 2026-09-28: one stuck worker held three finished siblings back for
// four hours, and nothing told anyone it was stuck. ----
function clockHost(root, tasks, extra = {}) {
  const clock = { t: 10 * 3600000 };
  const sent = [], told = [];
  const host = createDelegationCoordinator({ root, list: async () => tasks, now: () => clock.t,
    reach: async () => 'ready',
    deliver: async (file, message) => { sent.push(message); await appendEvent(file, message); },
    onQuiet: item => { told.push(item); },
    ...extra });
  host.root = root;
  return { host, clock, sent, told };
}
// Passes until n messages went out and no delivery is still in flight
// (records say "delivering" until the transcript check completes).
async function settle(host, sent, n) {
  const root = host.root;
  const inFlight = async () => {
    for (const dir of ['notifications', 'attention']) {
      let files = [];
      try { files = await fs.readdir(path.join(root, dir)); } catch {}
      for (const f of files.filter(f => f.endsWith('.json'))) {
        // A record being replaced (atomic write) may vanish between the listing and the read.
        const text = await fs.readFile(path.join(root, dir, f), 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
        if (text && JSON.parse(text).state === 'delivering') return true;
      }
    }
    return false;
  };
  await until(async () => { await host.processPending(); return sent.length >= n && !(await inFlight()); });
}

test('a sibling still at work never holds a returned result back; the parent reads what is still running', async t => {
  const { root, task } = await fixture(t);
  const tasks = [];
  const { host, clock, sent } = clockHost(root, tasks);
  tasks.push({ ...task, id: 'py', title: 'Python', finishedAt: clock.t - 5 * 60000 },
    { ...task, id: 'ts', title: 'TypeScript', status: 'running', startedAt: clock.t - 3 * 3600000 });
  await settle(host, sent, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].details.taskIds, ['py']);
  assert.match(sent[0].content, /Still running:\n\* TypeScript \(task ts\), 3 h so far\./);
  // The running worker is not reported as a result.
  assert.doesNotMatch(sent[0].content, /^- TypeScript/m);
  await host.processPending(); assert.equal(sent.length, 1);
});

test('results that return close together share one turn: quiet for a minute, at most three after the first', async t => {
  const { root, task } = await fixture(t);
  const tasks = [];
  const { host, clock, sent } = clockHost(root, tasks);
  const base = clock.t;
  tasks.push({ ...task, id: 'r', title: 'R', finishedAt: base },
    { ...task, id: 'ts', title: 'TypeScript', status: 'running', startedAt: base - 3600000 },
    { ...task, id: 'jl', title: 'Julia', status: 'running', startedAt: base - 3600000 });
  await host.processPending(); assert.equal(sent.length, 0, 'waits for a quiet minute');
  clock.t = base + 40000; tasks[2] = { ...tasks[2], status: 'succeeded', finishedAt: clock.t };
  await host.processPending(); assert.equal(sent.length, 0, 'another arrival restarts the minute');
  clock.t = base + 100001;
  await settle(host, sent, 1);
  assert.deepEqual(sent[0].details.taskIds.sort(), ['jl', 'r']);
  // A stream of arrivals cannot postpone delivery past three minutes.
  const more = [{ ...task, id: 'a1', title: 'A1', finishedAt: clock.t }];
  tasks.push(...more);
  for (const step of [50000, 50000, 50000]) {
    clock.t += step;
    tasks.push({ ...task, id: 'n' + clock.t, title: 'N', finishedAt: clock.t });
    await host.processPending();
  }
  assert.equal(sent.length, 1, 'still inside three minutes of the first');
  clock.t += 30001;
  await settle(host, sent, 2);
  assert.equal(sent[1].details.taskIds.length, 4);
});

test('when nothing else is running, a result goes at once', async t => {
  const { root, task } = await fixture(t);
  const tasks = [];
  const { host, clock, sent } = clockHost(root, tasks);
  tasks.push({ ...task, finishedAt: clock.t });
  await settle(host, sent, 1);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].content, /Still running/);
});

async function quietFixture(t, extra = {}) {
  const f = await fixture(t);
  const log = path.join(f.root, 'stdout.jsonl');
  const tasks = [{ ...f.task, id: 'ts', title: 'TypeScript', status: 'running', startedAt: 0, logPath: log }];
  let lastActivityAt = 0;
  const h = clockHost(f.root, tasks, { quietMs: () => 20 * 60000,
    activityOf: async () => ({ lastActivityAt }),
    reportOf: async (task, facts) => `${task.title} (task ${task.id}): no new output for ${Math.round(facts.quietMs / 60000)} min. pid 12 idle.`,
    ...extra });
  lastActivityAt = h.clock.t;
  return { ...f, ...h, tasks, setActivity: at => { lastActivityAt = at; } };
}

test('a quiet worker wakes its parent once per reminder; output starts the count over; nothing is stopped', async t => {
  const q = await quietFixture(t);
  const start = q.clock.t;
  q.clock.t = start + 19 * 60000; await q.host.processPending(); assert.equal(q.sent.length, 0);
  q.clock.t = start + 20 * 60000; await settle(q.host, q.sent, 1);
  assert.equal(q.sent[0].customType, 'delegation-attention');
  assert.deepEqual(q.sent[0].details.taskIds, ['ts']);
  assert.match(q.sent[0].content, /has gone quiet\. This is a runner event, not a user request\. Nothing was stopped\./);
  assert.match(q.sent[0].content, /\* TypeScript \(task ts\): no new output for 20 min\. pid 12 idle\./);
  assert.match(q.sent[0].content, /If you cannot tell, tell the user/);
  assert.equal((await q.host.refresh()).tasks[0].quiet.told, 'parent');
  q.clock.t = start + 59 * 60000; await q.host.processPending(); assert.equal(q.sent.length, 1, 'same level: not again');
  q.clock.t = start + 60 * 60000; await settle(q.host, q.sent, 2);
  assert.notEqual(q.sent[1].details.deliveryId, q.sent[0].details.deliveryId);
  // It speaks again: the flag clears, and a new stretch needs the full threshold.
  q.setActivity(q.clock.t); await q.host.processPending();
  assert.equal((await q.host.refresh()).tasks[0].quiet, undefined);
  q.clock.t += 19 * 60000; await q.host.processPending(); assert.equal(q.sent.length, 2);
  q.clock.t += 60000; await settle(q.host, q.sent, 3);
  assert.equal(q.told.length, 0, 'the parent could hear every time: the person is not alarmed');
  assert.equal(q.tasks[0].status, 'running');
});

test('a parent that is busy hears when it is free; one that cannot take a turn means the person hears', async t => {
  let state = 'busy';
  const q = await quietFixture(t, { reach: async () => state });
  q.clock.t += 25 * 60000;
  await q.host.processPending(); assert.equal(q.sent.length, 0); assert.equal(q.told.length, 0);
  state = 'ready'; await settle(q.host, q.sent, 1);
  assert.equal(q.sent[0].customType, 'delegation-attention');
  state = 'unreachable'; q.clock.t += 40 * 60000;
  await q.host.processPending();
  assert.equal(q.told.length, 1);
  assert.equal(q.told[0].reason, 'parent-unreachable'); assert.equal(q.told[0].level, 1);
  assert.match(q.told[0].report, /no new output for 65 min/);
  assert.equal((await q.host.refresh()).tasks[0].quiet.told, 'person');
  await q.host.processPending(); assert.equal(q.told.length, 1, 'once per level');
});

test('a quiet sibling and a returned result make one parent turn, not two', async t => {
  const q = await quietFixture(t);
  q.clock.t += 21 * 60000;
  q.tasks.push({ ...q.task, id: 'py', title: 'Python', finishedAt: q.clock.t - 1000 });
  await settle(q.host, q.sent, 1);
  await q.host.processPending();
  assert.equal(q.sent.length, 1);
  assert.equal(q.sent[0].customType, 'delegation-complete');
  assert.deepEqual(q.sent[0].details.taskIds, ['py']);
  assert.match(q.sent[0].content, /Still running:\n\* TypeScript \(task ts\): no new output for 21 min\. pid 12 idle\./);
  assert.deepEqual(q.sent[0].details.attention.map(a => a.taskId), ['ts']);
  assert.equal((await q.host.refresh()).tasks.find(t => t.id === 'ts').quiet.told, 'parent');
});

test('when the parent cannot run its turn (a usage limit), the person hears about the stuck worker', async t => {
  const q = await quietFixture(t, { deliver: async () => { throw new Error('429 usage limit'); } });
  q.clock.t += 20 * 60000;
  await q.host.processPending();
  await until(() => q.told.length === 1);
  assert.equal(q.told[0].reason, 'parent-failed');
});

test('a terminal parent gets no automatic turn, so its quiet worker is the person\'s; a paused one too', async t => {
  const q = await quietFixture(t);
  q.tasks[0] = { ...q.tasks[0], delivery: 'nextTurn' };
  q.clock.t += 20 * 60000;
  await q.host.processPending();
  assert.deepEqual(q.told.map(i => i.reason), ['terminal-parent']); assert.equal(q.sent.length, 0);
  q.tasks[0] = { ...q.tasks[0], delivery: 'web', paused: true };
  q.clock.t += 40 * 60000;
  await q.host.processPending();
  assert.deepEqual(q.told.map(i => i.reason), ['terminal-parent', 'paused']); assert.equal(q.sent.length, 0);
});

test('a quiet reminder that landed before a host restart is not sent again', async t => {
  const q = await quietFixture(t);
  q.clock.t += 20 * 60000;
  await settle(q.host, q.sent, 1);
  // A new host over the same records and transcript, with the record left mid-delivery.
  const file = path.join(q.root, 'attention', 'ts.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...record, state: 'delivering' }));
  const again = createDelegationCoordinator({ root: q.root, list: async () => q.tasks, now: () => q.clock.t, reach: async () => 'ready',
    quietMs: () => 20 * 60000, activityOf: async () => ({ lastActivityAt: q.clock.t - 20 * 60000 }),
    deliver: async () => assert.fail('duplicate reminder') });
  await again.processPending();
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).state, 'delivered');
});

test('the watch is off at 0 minutes, for finished work, and for a person continuing a worker in the web', async t => {
  let minutes = 0;
  const q = await quietFixture(t, { quietMs: () => minutes * 60000 });
  q.clock.t += 5 * 3600000;
  await q.host.processPending(); assert.equal(q.sent.length, 0);
  minutes = 20; q.tasks[0] = { ...q.tasks[0], sessionActive: true };
  await q.host.processPending(); assert.equal(q.sent.length, 0);
  q.tasks[0] = { ...q.tasks[0], sessionActive: false, status: 'succeeded', finishedAt: q.clock.t };
  await settle(q.host, q.sent, 1);
  assert.equal(q.sent[0].customType, 'delegation-complete');
});
