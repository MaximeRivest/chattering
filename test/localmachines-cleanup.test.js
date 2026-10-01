'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { Module } = require('node:module');
const cp = require('node:child_process');
const { stopAndRemove } = require('./helpers/cleanup');

test('Given the real local-machine browser scenario, When teardown resolves, Then no profile deletion remains scheduled', { timeout: 120000 }, async () => {
  const hooks = [], dirs = [], children = []; let scenario, tearingDown = false, deferred = 0;
  const fixture = new Module(path.join(__dirname, 'localmachines-server.test.js'), module);
  fixture.require = function(name) {
    if (name === 'cleanup-clock') return (fn, ms, ...args) => {
      if (tearingDown) { deferred++; return null; }
      return setTimeout(fn, ms, ...args);
    };
    if (name === 'node:test') return { test: (_name, run) => { scenario = run; } };
    if (name === 'node:fs') return { ...fs, mkdtempSync(...args) { const dir = fs.mkdtempSync(...args); dirs.push(dir); return dir; } };
    if (name === 'node:child_process') return { ...cp, spawn(...args) { const child = cp.spawn(...args); children.push(child); return child; } };
    return name.startsWith('.') ? require(path.resolve(__dirname, name)) : require(name);
  };
  fixture._compile("const setTimeout = require('cleanup-clock');\n" + fs.readFileSync(fixture.id, 'utf8'), fixture.id);
  try {
    await scenario({ after: hook => hooks.push(hook), skip: reason => assert.fail(reason) });
    tearingDown = true;
    for (const hook of hooks) await hook();
    assert.equal(deferred, 0, 'after hook must join process exit and profile removal, not schedule an unowned timer');
    assert.ok(dirs.every(dir => !fs.existsSync(dir)), 'all owned profiles and server homes removed before teardown completes');
  } finally {
    for (const child of children) await stopAndRemove(child, null);
    for (const dir of dirs) await stopAndRemove(null, dir);
  }
});
