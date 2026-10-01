'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { exited, stopAndRemove } = require('./helpers/cleanup');

function unexited() {
  // No PID: this controlled child can never name or signal an OS process.
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.kill = () => true;
  return child;
}

test('Given a child without an exit event, When the exit window expires, Then the wait rejects and releases its listener', async () => {
  const child = unexited();
  await assert.rejects(exited(child, 10), /exit.*not observed|not.*exit/i);
  assert.equal(child.listenerCount('exit'), 0);
});

test('Given an accepted kill request without exit, When cleanup reaches its deadline, Then it rejects and retains the profile', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-unjoined-'));
  fs.writeFileSync(path.join(profile, 'owned'), 'must survive uncertain exit');
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const child = unexited();
  await assert.rejects(stopAndRemove(child, profile, { graceMs: 10 }), /exit.*not observed|not.*exit/i);
  assert.equal(fs.readFileSync(path.join(profile, 'owned'), 'utf8'), 'must survive uncertain exit');
  assert.equal(child.listenerCount('exit'), 0);
});

test('Given an observed numeric exit without a signal, When joining completes, Then terminal state is accepted', async () => {
  const child = unexited();
  const done = exited(child, 1000);
  child.exitCode = 1; child.emit('exit', 1, null);
  await done;
  assert.equal(child.listenerCount('exit'), 0);
});

test('Given a child exiting synchronously during kill, When cleanup stops it, Then the registered exit join precedes removal', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-synchronous-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const child = unexited(); let observedBeforeKill = false;
  child.kill = () => {
    observedBeforeKill = child.listenerCount('exit') > 0;
    child.exitCode = 1; child.emit('exit', 1, null); return true;
  };
  await stopAndRemove(child, profile, { graceMs: 100 });
  assert.equal(observedBeforeKill, true, 'exit listener must exist before the stop request');
  assert.equal(fs.existsSync(profile), false);
});

test('Given a Windows tree-stop timeout, When the native handle stops the child, Then exit is joined within the original shared deadline', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-windows-budget-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const child = unexited(); child.pid = 424242;
  let taskkillBudget, killObserved = false;
  // Exercise the real helper's Windows branch without any OS signal or
  // taskkill process: every process boundary below is controlled.
  const vm = require('node:vm');
  const box = {
    module: { exports: {} }, process: { platform: 'win32', env: {}, pid: 123 },
    setTimeout, clearTimeout,
    require: name => {
      if (name === '../../processes.js') return { list: () => [] };
      if (name === 'node:child_process') return { execFile: (_cmd, args, options, callback) => {
        assert.deepEqual(Array.from(args), ['/PID', '424242', '/T', '/F']);
        taskkillBudget = options.timeout;
        setTimeout(() => callback(new Error('controlled taskkill timeout')), options.timeout);
      } };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'helpers/cleanup.js'), 'utf8'), box);
  child.kill = signal => {
    assert.equal(signal, 'SIGKILL');
    killObserved = child.listenerCount('exit') > 0;
    child.exitCode = 1; child.emit('exit', 1, null); return true;
  };
  await box.module.exports.stopAndRemove(child, profile, { graceMs: 100 });
  assert.ok(taskkillBudget > 0 && taskkillBudget < 100, 'native fallback must have a share of the existing deadline');
  assert.equal(killObserved, true);
  assert.equal(child.exitCode, 1);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(fs.existsSync(profile), false);
});
