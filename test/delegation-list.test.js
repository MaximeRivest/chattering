'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const D = require('../delegation');
const S = require('../delegation-store');

test('bounded lists retain old surviving workers and active web continuations', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-list-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const save = (createdAt, patch = {}) => {
    const id = randomUUID(), dir = path.join(root, id); fs.mkdirSync(dir);
    const task = { id, version: 1, title: 'Fixture', status: 'succeeded', createdAt, updatedAt: createdAt,
      sessionPath: path.join(root, id + '.jsonl'), parentTaskId: null, ...patch };
    fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(task)); return task;
  };
  const lost = save(1, { status: 'lost', processIdentity: S.identity(process.pid) });
  const resumed = save(2);
  for (let i = 0; i < 2000; i++) save(100 + i);
  const tasks = await D.listDelegations({ root, includeSessionPaths: [resumed.sessionPath] });
  assert.ok(tasks.some(t => t.id === lost.id && t.workerAlive && t.status === 'lost'));
  assert.ok(tasks.some(t => t.id === resumed.id));
  assert.equal(tasks.listing.live, 2);
  assert.equal(tasks.length, 2000);
  assert.equal(tasks.listing.omitted, 2);
});
