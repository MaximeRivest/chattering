'use strict';
// Restart to use what is on disk (design/107): app-update.js says when a
// running Chattering's own code differs from the code on disk, and how it
// can be restarted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppUpdate, supervisorOf } = require('../app-update.js');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-update-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'versions', '0.1.7'); fs.mkdirSync(path.join(app, 'test'), { recursive: true });
  const files = ['server.js', 'anywhere-link.js', 'test/x.test.js'].map(f => path.join(app, f));
  for (const f of files) fs.writeFileSync(f, '// v1');
  const elsewhere = path.join(dir, 'project.js'); fs.writeFileSync(elsewhere, '// a project file');
  const stamps = new Map([...files, elsewhere].map(f => [f, fs.statSync(f).mtimeMs]));
  fs.writeFileSync(path.join(dir, 'current.txt'), '0.1.7');
  let clock = Date.now();
  const u = createAppUpdate({ loaded: () => stamps, appDir: app, version: '0.1.7', installHome: dir, settleMs: 30000, now: () => clock });
  return { u, app, dir, files, elsewhere, advance: ms => { clock += ms; } };
}
const touch = (f, text = '// v2') => { fs.writeFileSync(f, text); const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t); };

test('the code it runs is the code on disk: nothing to say', async t => {
  const { u } = fixture(t);
  const s = await u.check();
  assert.equal(s.stale, false); assert.equal(s.changed, 0); assert.equal(s.installed, null);
});

test('a file it loaded changed (a fix copied in): said once it has rested, not while files are being saved', async t => {
  const { u, files, advance } = fixture(t);
  touch(files[1]);
  let s = await u.check();
  assert.equal(s.changed, 1); assert.equal(s.stale, false, 'still being written');
  advance(60000);
  s = await u.check();
  assert.equal(s.stale, true);
  assert.deepEqual(s.files, ['anywhere-link.js']);
});

test('only its own code counts: not its tests, not a project file it read', async t => {
  const { u, files, elsewhere, advance } = fixture(t);
  touch(files[2]); touch(elsewhere); advance(60000);
  assert.equal((await u.check()).stale, false);
});

test('a file it loaded is gone (an update replaced the folder): stale', async t => {
  const { u, files, advance } = fixture(t);
  fs.rmSync(files[0]);
  assert.equal((await u.check()).stale, false, 'missing for a moment: an update may be copying');
  advance(60000);
  const s = await u.check();
  assert.equal(s.stale, true); assert.deepEqual(s.files, ['server.js']);
});

test('a newer version installed beside it: stale at once, and named', async t => {
  const { u, dir } = fixture(t);
  fs.writeFileSync(path.join(dir, 'current.txt'), '0.1.8\n');
  const s = await u.check();
  assert.equal(s.stale, true); assert.equal(s.installed, '0.1.8');
});

test('listeners hear a change of state, not every check', async t => {
  const { u, files, advance } = fixture(t);
  const heard = []; u.onChange(s => heard.push(s.stale));
  await u.check(); touch(files[0]); advance(60000); await u.check(); await u.check();
  assert.deepEqual(heard, [true]);
});

test('how it can be restarted: its systemd unit, its install\u2019s launcher, or by hand', () => {
  const cgroup = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/chattering.service\n';
  const main = pid => () => pid;
  assert.deepEqual(supervisorOf({ env: { INVOCATION_ID: 'x' }, cgroup, pid: 42, mainPid: main(42) }), { kind: 'systemd', unit: 'chattering.service', user: true });
  assert.deepEqual(supervisorOf({ env: { INVOCATION_ID: 'x' }, cgroup: '0::/system.slice/chattering.service\n', pid: 42, mainPid: main(42) }), { kind: 'systemd', unit: 'chattering.service', user: false });
  // Started from inside the service (an agent's shell, a test server): the
  // same cgroup and environment, but not the service. Restarting "its"
  // unit would restart the real server (found by this test on 2026-10-27).
  assert.deepEqual(supervisorOf({ env: { INVOCATION_ID: 'x' }, cgroup, pid: 43, mainPid: main(42) }), { kind: 'manual' });
  assert.deepEqual(supervisorOf({ env: { INVOCATION_ID: 'x' }, cgroup, pid: 42 }), { kind: 'manual' }, 'its manager not asked: never assumed');
  assert.equal(supervisorOf({ env: {}, cgroup, installHome: 'C:\\Users\\a\\AppData\\Local\\Programs\\Chattering', platform: 'win32' }).command, path.join('C:\\Users\\a\\AppData\\Local\\Programs\\Chattering', 'bin', 'chattering-app.cmd'));
  assert.deepEqual(supervisorOf({ env: {}, cgroup: '0::/user.slice/session-3.scope\n' }), { kind: 'manual' });
  assert.deepEqual(supervisorOf({ env: { INVOCATION_ID: 'x' }, cgroup: '0::/user.slice/user-1000.slice/session-3.scope\n' }), { kind: 'manual' }, 'a terminal under systemd is not a service');
});

test('the helper that starts an install again quotes the launcher for cmd.exe as the installer does', () => {
  const { restartHelperSource } = require('../app-update.js');
  const src = restartHelperSource(123, 'C:\\Users\\a b\\Chattering\\bin\\chattering-app.cmd');
  assert.doesNotThrow(() => new Function(src), 'valid JavaScript');
  assert.match(src, /const pid=123;/);
  // With /s, cmd drops the first and last quote of what follows /c: the
  // command is quoted once more, or the launcher never starts (verified on
  // Windows, 2026-10-27: without it, nothing started).
  assert.ok(src.includes(`'""'+cmd+'" start"'`), src);
});
