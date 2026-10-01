'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { Module } = require('node:module');
const cp = require('node:child_process'), os = require('node:os');
const { stopAndRemove } = require('./helpers/cleanup');

test('Given the real local-machine browser scenario under an aliased temp root, When teardown resolves, Then all profiles are removed without scheduled deletion', { timeout: 120000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-machines-alias-'));
  const real = path.join(temp, 'real'), alias = path.join(temp, 'alias');
  fs.mkdirSync(real); fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const hooks = [], dirs = [], children = []; let scenario, tearingDown = false, deferred = 0, graceful = 0;
  const fixture = new Module(path.join(__dirname, 'localmachines-server.test.js'), module);
  fixture.require = function(name) {
    if (name === 'cleanup-clock') return (fn, ms, ...args) => {
      if (tearingDown) { deferred++; return null; }
      return setTimeout(fn, ms, ...args);
    };
    if (name === 'cleanup-socket') return class extends WebSocket {
      send(data) { if (JSON.parse(data).method === 'Browser.close') graceful++; return super.send(data); }
    };
    if (name === 'node:os') return { ...os, tmpdir: () => alias };
    if (name === 'node:test') return { test: (_name, run) => { scenario = run; } };
    if (name === 'node:fs') return { ...fs, mkdtempSync(...args) { const dir = fs.mkdtempSync(...args); dirs.push(dir); return dir; } };
    if (name === 'node:child_process') return { ...cp, spawn(...args) { const child = cp.spawn(...args); children.push(child); return child; } };
    return name.startsWith('.') ? require(path.resolve(__dirname, name)) : require(name);
  };
  fixture._compile("const WebSocket = require('cleanup-socket');\nconst setTimeout = require('cleanup-clock');\n" + fs.readFileSync(fixture.id, 'utf8'), fixture.id);
  try {
    await scenario({ after: hook => hooks.push(hook), skip: reason => assert.fail(reason) });
    assert.ok(dirs.every(dir => fs.existsSync(dir)), 'negative control: the original removal predicate is false before teardown');
    const browser = children.find(child => child.spawnargs.some(arg => arg.startsWith('--user-data-dir=')));
    const profile = browser.spawnargs.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    assert.equal(profile, fs.realpathSync.native(profile), 'Chrome and profile-writer cleanup use the canonical spelling, not the temp alias');
    tearingDown = true;
    for (const hook of hooks) await hook();
    assert.equal(deferred, 0, 'after hook must join process exit and profile removal, not schedule an unowned timer');
    assert.ok(dirs.every(dir => !fs.existsSync(dir)), 'all owned profiles and server homes removed before teardown completes: ' + dirs.filter(dir => fs.existsSync(dir)).map(dir => dir + ' [' + fs.readdirSync(dir).join(', ') + ']').join('; '));
    assert.equal(graceful, 1, 'Chrome is asked to join its profile writers before removal');
    assert.equal(browser.signalCode, null, 'Chrome exited normally, not by killing its launcher');
    assert.equal(browser.exitCode, 0);
  } finally {
    for (const child of children) await stopAndRemove(child, null);
    for (const dir of dirs) await stopAndRemove(null, dir);
    await stopAndRemove(null, temp);
  }
});
