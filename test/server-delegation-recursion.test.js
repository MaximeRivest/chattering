'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDelegationCoordinator } = require('../server-delegations');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(10); } assert.fail('Callback timed out'); }

test('nested callbacks finish before a parent reports its result upward, regardless of task order or UI limits', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-recursion-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, 'root.jsonl'), child = path.join(root, 'a.jsonl');
  for (const file of [parent, child]) await fs.writeFile(file, JSON.stringify({ type: 'message', id: 'launch', parentId: null }) + '\n');
  const a = { id: 'a', title: 'A', parentSessionPath: parent, parentEntryId: 'launch', sessionPath: child, outputDir: root, status: 'succeeded', review: 'unreviewed', delivery: 'web' };
  const b = { ...a, id: 'b', title: 'B', parentTaskId: 'a', parentSessionPath: child, sessionPath: path.join(root, 'b.jsonl') };
  const order = [];
  let release;
  const review = new Promise(r => { release = r; });
  const coordinator = createDelegationCoordinator({ root, list: async () => [b], listAll: async () => [a, b], canDeliver: async () => true,
    deliver: async (file, message) => {
      order.push(file);
      if (file === child) await review;
      await fs.appendFile(file, JSON.stringify({ type: 'custom_message', id: message.details.deliveryId, parentId: 'launch', ...message }) + '\n');
    } });
  await coordinator.processPending(); await until(() => order.length > 0);
  assert.deepEqual(order, [child]);
  await coordinator.processPending(); assert.deepEqual(order, [child]);
  release(); await until(async () => (await coordinator.refresh()).tasks[0].notificationState === 'delivered');
  await coordinator.processPending(); await until(() => order.length === 2);
  assert.deepEqual(order, [child, parent]);
  await until(async () => { try { return JSON.parse(await fs.readFile(path.join(root, 'notifications/a.json'), 'utf8')).state === 'delivered'; } catch { return false; } });
});
