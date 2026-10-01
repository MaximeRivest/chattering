'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { Module } = require('node:module');
const { CheckpointStore } = require('../checkpoint-store');
const { stopAndRemove } = require('./helpers/cleanup');

// Run the real delegated-worker scenario and real SQLite store, but guard
// unlink as Windows does. This is controlled Linux lifecycle evidence.
test('Given a delegated checkpoint store, When its registered teardown runs, Then SQLite closes before removal', { timeout: 90000 }, async () => {
  const stores = [], hooks = []; let scenario, home;
  class TrackedStore extends CheckpointStore { constructor(...args) { super(...args); stores.push(this); } }
  const fixture = new Module(path.join(__dirname, 'delegation-checkpoints.test.js'), module);
  fixture.require = function(name) {
    if (name === 'node:test') return (_name, _options, run) => { scenario = run; };
    if (name === '../checkpoint-store') return { CheckpointStore: TrackedStore };
    if (name === './helpers/cleanup.js') return { async stopAndRemove(child, dir) {
      home = dir;
      assert.ok(stores.every(s => !s.db.isOpen), 'Windows cannot remove an open SQLite database');
      return stopAndRemove(child, dir);
    } };
    return name.startsWith('.') ? require(path.resolve(__dirname, name)) : require(name);
  };
  fixture._compile(fs.readFileSync(fixture.id, 'utf8'), fixture.id);
  try {
    await scenario({ after: hook => hooks.push(hook) });
    for (const hook of hooks) await hook();
    assert.equal(fs.existsSync(home), false, 'owned fixture was removed');
  } finally {
    for (const s of stores) if (s.db.isOpen) s.close();
    if (home) await stopAndRemove(null, home);
  }
});
