'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const { stopAndRemove } = require('./helpers/cleanup');
const { closeLocalBrowser, localMachinesCleanup } = require('./localmachines-browser-cleanup');

async function fixture(t) {
  const profile = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'local-machines-shutdown-')));
  const browser = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    process.on('message', () => { fs.writeFileSync(process.argv[1] + '/final-write', 'closed'); process.exit(0); });
    process.send('ready');
  `, profile], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => stopAndRemove(browser, profile));
  await new Promise((resolve, reject) => { browser.once('message', resolve); browser.once('error', reject); });
  const ws = new EventTarget(); ws.readyState = 1;
  ws.close = () => { ws.readyState = 3; ws.dispatchEvent(new Event('close')); };
  return { browser, profile, ws };
}

for (const failure of ['hang/no reply', 'disconnect', 'CDP error', 'CDP rejection', 'CDP throw', 'already disconnected']) {
  test(`Given a browser with ${failure}, When graceful shutdown fails, Then fallback joins exit and profile removal within the existing deadline`, { timeout: 120000 }, async t => {
    const f = await fixture(t);
    if (failure === 'already disconnected') f.ws.close();
    const closeBrowser = () => {
      if (failure === 'disconnect') f.ws.close();
      if (failure === 'CDP rejection') return Promise.reject(new Error('controlled CDP rejection'));
      if (failure === 'CDP throw') throw new Error('controlled CDP throw');
      if (failure === 'CDP error') return Promise.resolve({ error: { message: 'controlled CDP failure' } });
      return new Promise(() => {});
    };
    // A watchdog is a RED oracle, not the graceful-shutdown implementation.
    let watchdog;
    const done = closeLocalBrowser({ ...f, closeBrowser, graceMs: 0 });
    const guarded = Promise.race([done, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('unbounded graceful wait')), 1000); })]);
    try {
      await assert.rejects(guarded, error => {
        assert.match(error.message, /local browser shutdown:/);
        assert.doesNotMatch(error.message, /fallback returned before browser exit|exit was not observed/);
        return true;
      });
      assert.ok(f.browser.exitCode !== null || f.browser.signalCode !== null, 'fallback actually stopped the live browser');
      assert.equal(fs.existsSync(f.profile), false, 'all profile removal is joined before rejection');
      assert.equal(f.browser.listenerCount('exit'), 0, 'no graceful waiter survives fallback');
    } finally {
      clearTimeout(watchdog);
      await stopAndRemove(f.browser, f.profile);
      await done.catch(() => {});
    }
  });
}

test('Given Chrome exits normally without a CDP reply, When shutdown joins its exit, Then no forced shutdown is reported', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const result = await closeLocalBrowser({ ...f, closeBrowser: () => { f.browser.send('finish'); return new Promise(() => {}); } });
  assert.equal(result.graceful, true);
  assert.equal(f.browser.exitCode, 0); assert.equal(f.browser.signalCode, null);
  assert.equal(fs.existsSync(f.profile), false);
});

test('Given a primary scenario failure and disconnected CDP, When fallback completes, Then the original failure carries cleanup diagnostics', { timeout: 120000 }, async t => {
  const f = await fixture(t); f.ws.close();
  const primaryError = new Error('primary scenario assertion');
  await assert.rejects(closeLocalBrowser({ ...f, primaryError, closeBrowser: () => {}, graceMs: 0 }), error => error === primaryError && /primary scenario assertion/.test(error.message) && /local browser shutdown:/.test(error.message));
  assert.equal(fs.existsSync(f.profile), false);
});


test('Given primary and removal failures, When fallback rejects, Then neither failure is lost', { timeout: 120000 }, async t => {
  const f = await fixture(t); f.ws.close();
  const primaryError = new Error('primary assertion'), removalError = new Error('controlled removal failure');
  await assert.rejects(closeLocalBrowser({ ...f, primaryError, graceMs: 0 }, {
    remove: async (...args) => { await stopAndRemove(...args); throw removalError; },
  }), error => error === primaryError && error.cleanupDiagnostics.includes(removalError) && /controlled removal failure/.test(error.message));
  assert.equal(fs.existsSync(f.profile), false);
});


test('Given browser teardown fails, When the fixture hook runs, Then remaining resources are joined before the original failure is rethrown', { timeout: 120000 }, async t => {
  const f = await fixture(t); f.ws.close();
  const primaryError = new Error('primary failure');
  const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'local-machines-other-'));
  t.after(() => stopAndRemove(null, otherHome));
  let hook, serverJoined = false;
  const cleanup = localMachinesCleanup({ after: fn => hook = fn }, () => stopAndRemove(null, otherHome));
  cleanup.add(async () => { serverJoined = true; });
  cleanup.add(() => closeLocalBrowser({ ...f, primaryError, graceMs: 0 }));
  await assert.rejects(hook(), error => error === primaryError);
  assert.equal(serverJoined, true);
  assert.equal(fs.existsSync(otherHome), false);
  assert.equal(fs.existsSync(f.profile), false);
});
