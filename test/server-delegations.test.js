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
