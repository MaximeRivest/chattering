'use strict';
// Restart to use what is on disk (design/107), for real: a server runs from
// a copy of this app; a file of the copy changes, as a fix copied into a
// running install does (Lilly's Windows app, 2026-10-24 to 27). The owner is
// told, in the page, and a restart is offered or, started by hand, said how.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromiumAvailable } = require('./helpers/chromium.js');
const { viewerBrowser } = require('./helpers/viewer-browser.js');

// The app's own files, as a reflink where the file system can (instant).
function copyApp(t, sub = '') {
  const src = path.join(__dirname, '..');
  const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'app-copy-')));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  const dest = path.join(top, sub);
  for (const rel of execFileSync('git', ['-C', src, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean)) {
    const from = path.join(src, rel); let st;
    try { st = fs.lstatSync(from); } catch { continue; } // deleted, not yet committed
    if (!st.isFile()) continue;
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(dest, rel), fs.constants.COPYFILE_FICLONE);
  }
  // The runtime (Pi, WebRTC): the same, not copied.
  if (fs.existsSync(path.join(src, 'runtime', 'node_modules')) && !fs.existsSync(path.join(dest, 'runtime', 'node_modules'))) fs.symlinkSync(path.join(src, 'runtime', 'node_modules'), path.join(dest, 'runtime', 'node_modules'));
  return dest;
}

test('a file of the running app changes: the owner is told in the page; started by hand, told how to restart', { skip: !chromiumAvailable() && 'chromium is not installed', timeout: 180000 }, async t => {
  const root = copyApp(t);
  const app = await viewerBrowser(t, { root, env: { CHATTERING_UPDATE_SETTLE_MS: '1', CHATTERING_UPDATE_EVERY_MS: '500' } });
  const { base, auth, evaluate, until } = app;
  const update = async (q = '') => (await fetch(base + '/api/app/update' + q, { headers: auth })).json();
  assert.equal((await update('?check=1')).stale, false, 'just started: the code on disk');
  await until(`document.querySelector('#appUpdate') !== null || typeof AppUpdateUI === 'object'`, 'the notice is wired');
  assert.equal(await evaluate(`!document.querySelector('#appUpdate') || document.querySelector('#appUpdate').hidden`), true, 'nothing to say yet');

  // A fix lands in the running app's folder.
  const file = path.join(root, 'anywhere-link.js');
  fs.appendFileSync(file, '\n// a fix\n');
  const later = new Date(Date.now() + 2000); fs.utimesSync(file, later, later);
  let u;
  for (let i = 0; i < 100; i++) { u = await update('?check=1'); if (u.stale) break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(u.stale, true, JSON.stringify(u));
  assert.deepEqual(u.files, ['anywhere-link.js']);
  assert.equal(u.how, 'manual', 'this test server was started by hand');
  assert.equal(u.canRestart, false);

  // The page hears it, without a reload.
  await until(`document.querySelector('#appUpdate') && !document.querySelector('#appUpdate').hidden`, 'the notice shows');
  const text = await evaluate(`document.querySelector('#appUpdate').textContent`);
  assert.match(text, /runs older code: 1 file changed on disk/);
  assert.match(text, /restart it where you started it/, 'no button that cannot work');
  assert.equal(await evaluate(`!!document.querySelector('#appUpdate button')`), false);
  if (process.env.CHATTERING_SHOT) await app.screenshot(process.env.CHATTERING_SHOT);

  // Asked to restart anyway: refused, with why; nothing stops.
  const r = await fetch(base + '/api/app/restart', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /started by hand/);
  assert.equal((await fetch(base + '/api/app/update', { headers: auth })).status, 200, 'still running');
});

// Run by systemd, as on lambda: the restart button asks its manager, which
// starts it again; it comes back as a new process on the same port. A
// server started from inside a service (this test's own process may be) is
// not that service, and must not restart it (app-update.js supervisorOf).
const systemdUser = (() => { try { return execFileSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8', timeout: 5000 }).trim() !== 'offline'; } catch (e) { return /running|degraded/.test(String(e.stdout || '')); } })();
test('run as a systemd unit, a restart asked from the page brings it back as a new process', { skip: (process.platform !== 'linux' || !systemdUser) && 'no systemd user manager here', timeout: 120000 }, async t => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'app-restart-')));
  const unit = 'chattering-restart-test-' + process.pid + '.service';
  const net = require('node:net');
  const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
  const port = await freePort(), token = 'restart-test-token';
  const env = { ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_PREVIEW_PORT: String(await freePort()), CHATTERING_HOST: '127.0.0.1',
    CHATTERING_TOKEN: token, CHATTERING_NO_SYNC: '1', CHATTERING_NO_WATCH: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'),
    PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'), PATH: process.env.PATH };
  fs.mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
  require('./helpers/first-run.js').answerFirstRun(home);
  execFileSync('systemd-run', ['--user', '--quiet', '--unit', unit, '--property=Restart=no', `--working-directory=${path.join(__dirname, '..')}`,
    ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), process.execPath, 'server.js']);
  t.after(() => { try { execFileSync('systemctl', ['--user', 'stop', unit], { timeout: 20000 }); } catch {} try { execFileSync('systemctl', ['--user', 'reset-failed', unit]); } catch {} fs.rmSync(home, { recursive: true, force: true }); });
  const auth = { Authorization: 'Bearer ' + token }, base = 'http://127.0.0.1:' + port;
  const status = async () => { try { return await (await fetch(base + '/api/app/update', { headers: auth })).json(); } catch { return null; } };
  let before = null;
  for (let i = 0; i < 300 && !before; i++) { before = await status(); if (!before) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(before, 'the server answers');
  assert.equal(before.how, 'systemd', 'it knows its manager: ' + JSON.stringify(before));
  assert.equal(before.canRestart, true);
  const asked = await (await fetch(base + '/api/app/restart', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.equal(asked.restarting, true, JSON.stringify(asked));
  let after = null;
  for (let i = 0; i < 300; i++) { const s = await status(); if (s && s.startedAt !== before.startedAt) { after = s; break; } await new Promise(r => setTimeout(r, 100)); }
  assert.ok(after, 'a new process answers on the same port');
  assert.equal(execFileSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' }).trim(), 'active');
});

// An install (Windows, macOS, the Linux installer: <home>/versions/<v>/):
// the restart ends this process, and a helper starts the install's launcher
// once it has ended, so the current version starts. The launcher here is a
// stand-in that writes down that it was started.
test('an install restarts through its launcher, after the old process has ended', { skip: process.platform === 'win32' && 'the stand-in launcher is a shell script', timeout: 120000 }, async t => {
  const appDir = copyApp(t, path.join('versions', '0.1.7'));
  const installHome = path.dirname(path.dirname(appDir));
  fs.writeFileSync(path.join(installHome, 'current.txt'), '0.1.7');
  const marker = path.join(installHome, 'started.txt');
  fs.mkdirSync(path.join(installHome, 'bin'));
  fs.writeFileSync(path.join(installHome, 'bin', 'chattering-app'), `#!/bin/sh\necho "$@" > '${marker}'\n`, { mode: 0o755 });
  const app = await viewerBrowser(t, { root: appDir });
  const u = await (await fetch(app.base + '/api/app/update', { headers: app.auth })).json();
  assert.equal(u.how, 'launcher', JSON.stringify(u));
  // A newer version installed beside it: said at once.
  fs.writeFileSync(path.join(installHome, 'current.txt'), '0.1.8');
  const v = await (await fetch(app.base + '/api/app/update?check=1', { headers: app.auth })).json();
  assert.equal(v.stale, true); assert.equal(v.installed, '0.1.8');
  const r = await (await fetch(app.base + '/api/app/restart', { method: 'POST', headers: { ...app.auth, 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.equal(r.restarting, true, JSON.stringify(r));
  let started = '';
  for (let i = 0; i < 200 && !started; i++) { try { started = fs.readFileSync(marker, 'utf8').trim(); } catch {} if (!started) await new Promise(r => setTimeout(r, 100)); }
  assert.equal(started, 'start', 'the launcher was started');
  let down = false;
  try { await fetch(app.base + '/api/app/update', { headers: app.auth, signal: AbortSignal.timeout(2000) }); } catch { down = true; }
  assert.ok(down, 'the old process ended first');
});
