'use strict';
// launcher.js on the system running the tests: start, find, stop; and an
// update from a release (a local stand-in for GitHub): checked, unpacked
// beside the old version, switched to, and rolled back; a download that
// does not match its checksum changes nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { homeEnv, systemEnv } = require('./helpers/home-env.js');

const root = path.join(__dirname, '..');
const win = process.platform === 'win32';
const run = (launcher, args, home, extra = {}) => spawnSync(process.execPath, [launcher, ...args], { encoding: 'utf8', timeout: 120000,
  env: { ...process.env, ...systemEnv(), ...homeEnv(home), CHATTERING_NO_BROWSER: '1', ...extra } });

// The same, without blocking: the update test serves its release from this process.
const runAsync = (launcher, args, home, extra = {}) => new Promise(resolve => {
  const c = spawn(process.execPath, [launcher, ...args], { env: { ...process.env, ...systemEnv(), ...homeEnv(home), CHATTERING_NO_BROWSER: '1', ...extra } });
  let stdout = '', stderr = '';
  c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d);
  c.on('close', status => resolve({ status, stdout, stderr }));
});

test('start, status, url and stop, from a checkout', { timeout: 180000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.homedir(), '.launcher-test-'));
  const launcher = path.join(root, 'launcher.js');
  t.after(() => { run(launcher, ['stop', '--force'], home); fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const port = String(18000 + Math.floor(Math.random() * 2000));
  const started = run(launcher, ['start'], home, { PORT: port });
  assert.equal(started.status, 0, started.stdout + started.stderr);
  assert.equal(run(launcher, ['start'], home, { PORT: port }).stdout.includes('running on port'), true, 'a second start finds the first');
  const url = new URL(run(launcher, ['url'], home).stdout.trim());
  assert.ok(url.searchParams.get('token'), 'the address signs in');
  const status = await (await fetch(url.origin + '/api/app/status', { headers: { Authorization: 'Bearer ' + url.searchParams.get('token') } })).json();
  assert.equal(status.app, 'chattering');
  assert.match(run(launcher, ['status'], home).stdout, /is running on port/);
  const stopped = run(launcher, ['stop'], home);
  assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  assert.equal(run(launcher, ['status'], home).status, 3, 'stopped means stopped');
});

test('update from a release, keep the old version, roll back; a bad checksum changes nothing', { timeout: 180000 }, async t => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-update-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const home = path.join(tmp, 'home'), installHome = path.join(tmp, 'program');
  fs.mkdirSync(home);
  // A minimal program folder of a given version: the launcher and what it needs.
  const program = (dir, version) => {
    fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true });
    for (const f of ['launcher.js', 'platform.js', 'runtime.js', 'processes.js', 'win-hide.js']) fs.copyFileSync(path.join(root, f), path.join(dir, f));
    fs.copyFileSync(path.join(root, 'runtime', 'package.json'), path.join(dir, 'runtime', 'package.json'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'chattering', version }));
  };
  program(path.join(installHome, 'versions', '0.0.1'), '0.0.1');
  fs.writeFileSync(path.join(installHome, 'current.txt'), '0.0.1\n');
  // The release: an archive for this system, its checksum, the API answer.
  const { assetName } = require('../launcher.js');
  const asset = assetName('0.0.2'), stage = path.join(tmp, 'stage'), inner = asset.replace(/\.(zip|tar\.gz)$/, '');
  program(path.join(stage, inner), '0.0.2');
  const archive = path.join(tmp, asset);
  const tarArgs = win ? ['-a', '-cf', archive, '-C', stage, inner] : ['-czf', archive, '-C', stage, inner];
  assert.equal(spawnSync(win ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', tarArgs).status, 0);
  let sha = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const server = http.createServer((req, res) => {
    const base = 'http://127.0.0.1:' + server.address().port;
    if (req.url === '/release') return res.end(JSON.stringify({ tag_name: 'v0.0.2', assets: [{ name: asset, browser_download_url: base + '/a' }, { name: 'SHA256SUMS', browser_download_url: base + '/sums' }] }));
    if (req.url === '/a') return res.end(fs.readFileSync(archive));
    if (req.url === '/sums') return res.end(`${sha}  ${asset}\n`);
    res.statusCode = 404; res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const env = { CHATTERING_RELEASE_API: 'http://127.0.0.1:' + server.address().port + '/release' };
  const old = path.join(installHome, 'versions', '0.0.1', 'launcher.js');

  const realSha = sha; sha = '0'.repeat(64);
  const refused = await runAsync(old, ['update'], home, env);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /checksum/);
  assert.equal(fs.readFileSync(path.join(installHome, 'current.txt'), 'utf8').trim(), '0.0.1', 'nothing changed');
  assert.equal(fs.existsSync(path.join(installHome, 'versions', '0.0.2')), false);
  sha = realSha;

  const updated = await runAsync(old, ['update'], home, env);
  assert.equal(updated.status, 0, updated.stdout + updated.stderr);
  assert.equal(fs.readFileSync(path.join(installHome, 'current.txt'), 'utf8').trim(), '0.0.2');
  assert.equal(JSON.parse(fs.readFileSync(path.join(installHome, 'versions', '0.0.2', 'package.json'), 'utf8')).version, '0.0.2');
  assert.ok(fs.existsSync(old), 'the old version is kept');
  if (!win) assert.equal(fs.readlinkSync(path.join(installHome, 'current')), path.join('versions', '0.0.2'));
  const rolled = await runAsync(path.join(installHome, 'versions', '0.0.2', 'launcher.js'), ['rollback'], home);
  assert.equal(rolled.status, 0, rolled.stdout + rolled.stderr);
  assert.equal(fs.readFileSync(path.join(installHome, 'current.txt'), 'utf8').trim(), '0.0.1');
});
