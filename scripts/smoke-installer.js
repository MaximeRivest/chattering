#!/usr/bin/env node
'use strict';
// The stranger test for the installer a person double-clicks (design/71):
//
//   macOS    the .dmg: attached, Chattering.app copied out and marked as
//            downloaded (quarantine), opened in a home that never saw
//            Chattering; it unpacks itself, starts, connects a model and
//            holds a first conversation (journey.js); opened again it is
//            the same Chattering; opened the way Finder opens it, it starts.
//   Windows  the Setup: run as a person would (silently here), opened from
//            its Start menu target (a windowless Chattering.exe), a first
//            conversation; Setup run again over a running Chattering; then
//            uninstalled, leaving the person's conversations and settings.
//
//   node scripts/smoke-installer.js dist/<installer>
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const { firstConversation } = require('./journey.js');

const installer = path.resolve(process.argv[2] || '');
assert.ok(fs.existsSync(installer), 'usage: smoke-installer.js <installer>');
const version = require('../package.json').version;
const step = m => console.log('· ' + m);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sh = (file, args, opts = {}) => {
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: 180000, ...opts });
  assert.equal(r.status, 0, `${path.basename(file)} ${args.join(' ')} → ${r.status}\n${r.stdout || ''}${r.stderr || ''}${r.error ? r.error.message : ''}`);
  return r;
};
// The signed-in address of the Chattering running for `home`, from its own launcher.
async function signedIn(launcher, env) {
  for (let i = 0; i < 300; i++) {
    const r = spawnSync(launcher.file, [...launcher.args, 'url'], { env, encoding: 'utf8', timeout: 30000 });
    if (r.status === 0 && /^http/.test(r.stdout.trim())) { const u = new URL(r.stdout.trim()); return { base: u.origin, token: u.searchParams.get('token') }; }
    await sleep(200);
  }
  throw new Error('Chattering did not come up');
}
async function status(base, token) {
  let r;
  try { r = await fetch(base + '/api/app/status', { headers: { Authorization: 'Bearer ' + token } }); }
  catch (e) { throw new Error(`${base} did not answer: ${e.cause ? e.cause.code || e.cause.message : e.message}`); }
  return r.json();
}
// What a failure needs: the end of the server's log, and Setup's.
function showLogs() {
  const files = [path.join(require('../platform.js').appDirs().data, 'logs', 'server.log'), path.join(require('../platform.js').appDirs().data, 'logs', 'server.log.1'),
    path.join(os.tmpdir(), 'chattering-setup.log'), path.join(os.homedir(), 'Library', 'Logs', 'Chattering.log')];
  for (const f of files) { try { console.error(`--- ${f}\n` + fs.readFileSync(f, 'utf8').slice(-3000)); } catch {} }
}

async function mac() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.chattering-dmg-')));
  const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-'));
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR, CHATTERING_NO_BROWSER: '1', PORT: String(18433 + Math.floor(Math.random() * 500)) };
  const program = path.join(home, 'Library', 'Application Support', 'Chattering', 'program');
  const launcher = { file: path.join(program, 'bin', 'chattering-app'), args: [] };
  try {
    sh('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, installer]);
    const listed = fs.readdirSync(mount).filter(n => !n.startsWith('.')).sort();
    assert.deepEqual(listed, ['Applications', 'Chattering.app'], 'the disk image shows the app and where to drag it');
    assert.equal(fs.readlinkSync(path.join(mount, 'Applications')), '/Applications');
    fs.mkdirSync(path.join(home, 'Applications'));
    const app = path.join(home, 'Applications', 'Chattering.app');
    sh('ditto', [path.join(mount, 'Chattering.app'), app]);
    sh('hdiutil', ['detach', mount]);
    step('dragged Chattering.app out of the disk image');
    // As a browser download leaves it.
    sh('xattr', ['-w', '-r', 'com.apple.quarantine', `0081;${Math.floor(Date.now() / 1000).toString(16)};Safari;`, app]);
    const plist = sh('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')]).stdout;
    assert.equal(JSON.parse(plist).CFBundleShortVersionString, version);
    assert.ok(fs.statSync(path.join(app, 'Contents', 'Resources', 'Chattering.icns')).size > 10000, 'the app has its icon');
    const t0 = Date.now();
    sh(path.join(app, 'Contents', 'MacOS', 'Chattering'), [], { env });
    step(`first open: unpacked and started in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    assert.equal(fs.readFileSync(path.join(program, 'current.txt'), 'utf8').trim(), version);
    const node = path.join(program, 'versions', version, 'runtime', 'node', 'bin', 'node');
    assert.equal(spawnSync('xattr', ['-p', 'com.apple.quarantine', node]).status, 1, 'the installed program is not marked as a download');
    const { base, token } = await signedIn(launcher, env);
    const s = await status(base, token);
    assert.equal(s.version, version);
    assert.equal(s.piSource, 'bundled');
    step(`running ${s.version}, Pi ${s.pi}`);
    await firstConversation({ base, token, home, step });
    const t1 = Date.now();
    sh(path.join(app, 'Contents', 'MacOS', 'Chattering'), [], { env });
    assert.equal((await signedIn(launcher, env)).base, base, 'a second open finds the same Chattering');
    step(`second open: ${((Date.now() - t1) / 1000).toFixed(1)} s, the same Chattering`);
    assert.match(fs.readFileSync(path.join(home, 'Library', 'Logs', 'Chattering.log'), 'utf8'), new RegExp(`Chattering ${version.replace(/\./g, '\\.')} opened`));
    sh(launcher.file, ['stop'], { env });
    // As Finder opens it: through Launch Services, with this machine's own
    // home (a Launch Services app takes the session's). Without quarantine:
    // Gatekeeper's first-open question needs a person (the app is unsigned).
    sh('xattr', ['-d', '-r', 'com.apple.quarantine', app]);
    sh('open', ['-n', '-g', app], { env: { ...process.env, CHATTERING_NO_BROWSER: '1' } });
    const realProgram = path.join(os.homedir(), 'Library', 'Application Support', 'Chattering', 'program');
    const real = await signedIn({ file: path.join(realProgram, 'bin', 'chattering-app'), args: [] }, process.env);
    assert.equal((await status(real.base, real.token)).version, version);
    sh(path.join(realProgram, 'bin', 'chattering-app'), ['stop', '--force']);
    step('opened as Finder opens it (Launch Services)');
  } finally {
    spawnSync(launcher.file, ['stop', '--force'], { env });
    spawnSync('hdiutil', ['detach', '-force', mount]);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function windows() {
  const app = path.join(process.env.LOCALAPPDATA, 'Programs', 'Chattering');
  const env = { ...process.env, CHATTERING_NO_BROWSER: '1', PORT: String(18433 + Math.floor(Math.random() * 500)) };
  const cmd = { file: process.env.ComSpec || 'cmd.exe', args: ['/c', path.join(app, 'bin', 'chattering-app.cmd')] };
  const setup = () => sh(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=desktopicon', '/LOG=' + path.join(os.tmpdir(), 'chattering-setup.log')], { env });
  try {
    setup();
    step('Setup ran');
    assert.equal(fs.readFileSync(path.join(app, 'current.txt'), 'utf8').trim(), version);
    const exe = fs.readFileSync(path.join(app, 'Chattering.exe'));
    const pe = exe.readUInt32LE(0x3c);
    assert.equal(exe.readUInt16LE(pe + 24 + 68), 2, 'Chattering.exe opens no console window');
    const start = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Chattering.lnk');
    assert.ok(fs.existsSync(start), 'a Start menu entry');
    assert.ok(fs.existsSync(path.join(os.homedir(), 'Desktop', 'Chattering.lnk')) || fs.existsSync(path.join(process.env.USERPROFILE, 'Desktop', 'Chattering.lnk')), 'the desktop icon that was asked for');
    // What the Start menu entry runs.
    const t0 = Date.now();
    sh(path.join(app, 'Chattering.exe'), [path.join(app, 'bin', 'open.js')], { env });
    step(`opened from the Start menu target in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const { base, token } = await signedIn(cmd, env);
    const s = await status(base, token);
    assert.equal(s.version, version);
    step(`running ${s.version}, Pi ${s.pi}`);
    await firstConversation({ base, token, home: os.homedir(), step });
    // Setup again, over a running Chattering (the next version would do this).
    setup();
    step('Setup over a running Chattering stopped it and installed');
    sh(path.join(app, 'Chattering.exe'), [path.join(app, 'bin', 'open.js'), 'start'], { env });
    const again = await signedIn(cmd, env);
    assert.equal((await status(again.base, again.token)).version, version);
    step('started again after the second Setup');
    // Uninstall, as Settings → Apps does; the person's things stay.
    const data = require('../platform.js').appDirs().config;
    assert.ok(fs.existsSync(path.join(data, 'settings.json')), 'settings exist before uninstalling');
    sh(path.join(app, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { env });
    for (let i = 0; i < 150 && fs.existsSync(path.join(app, 'versions')); i++) await sleep(200);
    assert.equal(fs.existsSync(path.join(app, 'versions')), false, 'the program is gone');
    assert.equal(fs.existsSync(start), false, 'the Start menu entry is gone');
    assert.ok(fs.existsSync(path.join(data, 'settings.json')), 'settings and conversations stay');
    const listening = await fetch(again.base + '/api/app/status', { headers: { Authorization: 'Bearer ' + again.token } }).then(() => true, () => false);
    assert.equal(listening, false, 'uninstalling stopped it');
    step('uninstalled; the person’s settings and conversations stay');
  } finally {
    spawnSync(cmd.file, [...cmd.args, 'stop', '--force'], { env });
  }
}

(async () => {
  let ok = false;
  try {
    if (process.platform === 'darwin') await mac();
    else if (process.platform === 'win32') await windows();
    else throw new Error('no installer on this system');
    ok = true;
  } catch (e) { console.error(e); showLogs(); }
  console.log(ok ? 'The installer works for a stranger.' : 'The installer FAILED the stranger test.');
  process.exit(ok ? 0 : 1);
})();
