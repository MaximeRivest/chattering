'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixtureCleanup } = require('./helpers/fixture-cleanup');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CheckpointStore } = require('../checkpoint-store');

// A Windows-style open-file guard makes the teardown order observable on
// every host. This checks the handle lifecycle, not native Windows unlink.
test('Given two handles share a fixture, When its after hooks run, Then both close before removal', async () => {
  const hooks = [], open = new Set(['first', 'second']), events = [];
  const cleanup = fixtureCleanup({ after: hook => hooks.push(hook) }, async () => {
    assert.equal(open.size, 0, 'removal must not run while a store still holds the SQLite files');
    events.push('remove');
  });
  cleanup.add(() => { open.delete('first'); events.push('first closed'); });
  cleanup.add(async () => {
    await Promise.resolve();
    open.delete('second'); events.push('second closed');
  });
  for (const hook of hooks) await hook();
  assert.equal(events.at(-1), 'remove');
  assert.deepEqual([...events].sort(), ['first closed', 'remove', 'second closed']);
});

test('Given a fixture fails before opening its store, When teardown runs, Then its directory is still removed', async () => {
  const hooks = []; let removed = false;
  fixtureCleanup({ after: hook => hooks.push(hook) }, () => { removed = true; });
  for (const hook of hooks) await hook();
  assert.equal(removed, true);
});

test('Given two real SQLite stores share a folder, When fixture teardown runs, Then neither database is open at unlink', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fixture-cleanup-'));
  const stores = [];
  // Own the regression's scratch even if the intentional open-handle
  // assertion fails. No user or canonical database is used here.
  t.after(async () => {
    for (const store of stores) if (store.db.isOpen) store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const hooks = [];
  const cleanup = fixtureCleanup({ after: hook => hooks.push(hook) }, async () => {
    assert.ok(stores.every(store => !store.db.isOpen), 'both real SQLite handles must close before directory removal');
    await fs.rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 2; i++) {
    const store = new CheckpointStore(path.join(dir, 'private'), { autoMaintain: false });
    stores.push(store); cleanup.add(() => store.close());
  }
  for (const hook of hooks) await hook();
  await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
});

test('Given a handle cannot close, When fixture teardown fails, Then the directory is retained', async () => {
  const hooks = []; let removed = false;
  const cleanup = fixtureCleanup({ after: hook => hooks.push(hook) }, () => { removed = true; });
  cleanup.add(() => { throw Error('close failed'); });
  await assert.rejects(async () => { for (const hook of hooks) await hook(); }, /close failed/);
  assert.equal(removed, false, 'an uncertain handle must not be hidden by deleting its folder');
});
