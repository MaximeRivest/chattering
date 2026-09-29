'use strict';
// The reach switch (settings → machines) moves the listener between
// loopback and every interface without a restart. Boot the real server on
// a throwaway HOME and flip it both ways, checking where it answers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');

async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r));
  return port;
}

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (!n.internal && n.family === 'IPv4' && !n.address.startsWith('172.')) return n.address;
  }
  return null;
}

async function boot(t, extraEnv) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'lan-switch-')));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  const port = await freePort(), tlsPort = await freePort();
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(tlsPort), CHATTERING_NO_WATCH: '0', CHATTERING_NO_LEDGER: '0', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, CHATTERING_HOST: '', CHATTERING_LAN: '', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: '', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 400; i++) {
    try { if ((await fetch(base + '/api/settings', withToken(home))).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  return { base, port, tlsPort, home, log: () => log };
}

async function reachable(host, port) {
  try { return (await globalThis.fetch(`http://${host}:${port}/api/settings`, { signal: AbortSignal.timeout(1500) })).status; }
  catch { return 0; }
}

// This machine signs in with the install token like anyone else, on the
// network or not (design/53, design/69); the token file says which.
const installTokenOf = home => { try { return fs.readFileSync(path.join(home, 'cache', 'lan-token'), 'utf8').trim(); } catch { return ''; } };
const withToken = (home, opts = {}) => { const t = installTokenOf(home); return t ? { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } } : opts; };
async function putLan(base, on, home) {
  const cur = await (await fetch(base + '/api/settings', withToken(home))).json();
  const r = await fetch(base + '/api/settings', withToken(home, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cur.settings, lan: on }) }));
  return r.json();
}

test('the reach switch rebinds the listener both ways without a restart', async t => {
  const ip = lanIp();
  const { base, port, home } = await boot(t, {});
  // Even with the network off, this machine signs in with the token.
  assert.equal(await reachable('127.0.0.1', port), 401, 'locality alone never signs in (design/69)');
  let s = await (await fetch(base + '/api/settings', withToken(home))).json();
  assert.equal(s.lan.on, false); assert.equal(s.lan.fixed, false); assert.equal(s.settings.lan, null);
  assert.deepEqual(s.connectLinks, []);
  if (ip) assert.equal(await reachable(ip, port), 0, 'must not answer on the LAN address while off');

  s = await putLan(base, true, home);
  assert.equal(s.lan.on, true); assert.equal(s.settings.lan, true);
  assert.ok(s.connectLinks.length >= (ip ? 1 : 0));
  for (const l of s.connectLinks) assert.match(l, /^http:\/\/[\d.]+:\d+\/\?token=[\w-]+$/);
  // This machine's own requests now need the install token too (a guest's
  // sandboxed agent is local as well): 401 bare, 200 with the token.
  assert.equal(await reachable('127.0.0.1', port), 401, 'locality alone no longer signs in');
  const installToken = new URL(s.connectLinks[0] || 'http://x/?token=').searchParams.get('token');
  if (installToken) assert.equal((await fetch(base + '/api/settings', { headers: { Authorization: 'Bearer ' + installToken } })).status, 200, 'answers locally with the token');
  // A browser signed in before the rename presents the old cookie name:
  // it is still signed in, and its cookie moves to the new name.
  if (installToken) {
    const legacy = await fetch(base + '/api/settings', { headers: { Cookie: 'aiconvo=' + installToken } });
    assert.equal(legacy.status, 200, 'the pre-rename cookie still signs in');
    const set = legacy.headers.getSetCookie();
    const own = set.find(c => /^chattering_[0-9a-f]{8}=/.test(c));
    assert.ok(own && own.includes('=' + installToken + ';'), 'moved to this install\'s own name: ' + set);
    assert.ok(set.some(c => /^aiconvo=;.*Max-Age=0/.test(c)), 'the old name is cleared: ' + set);
    const bogus = await fetch(base + '/api/settings', { headers: { Cookie: 'aiconvo=not-a-token' } });
    assert.equal(bogus.status, 401, 'a wrong old cookie is still wrong');
    assert.ok(bogus.headers.getSetCookie().some(c => /^aiconvo=;.*Max-Age=0/.test(c)), 'and is cleared');
    // design/84: each install has its own cookie name, since two installs
    // on one computer (Windows and WSL, both 127.0.0.1) share a cookie jar.
    const ownName = own.split('=')[0];
    const shared = await fetch(base + '/api/settings', { headers: { Cookie: 'chattering=' + installToken } });
    assert.equal(shared.status, 200, 'the shared name from before still signs in');
    const moved = shared.headers.getSetCookie();
    assert.ok(moved.some(c => c.startsWith(ownName + '=' + installToken + ';')), 'and moves to the own name: ' + moved);
    assert.ok(moved.some(c => /^chattering=;.*Max-Age=0/.test(c)), 'the shared name is freed for the other install: ' + moved);
    const sibling = await fetch(base + '/api/settings', { headers: { Cookie: 'chattering=another-installs-secret' } });
    assert.equal(sibling.status, 401, 'another install\'s cookie does not sign in here');
    assert.ok(!sibling.headers.getSetCookie().some(c => /^chattering=;/.test(c)), 'nor is it cleared: that would sign the person out there');
    const both = await fetch(base + '/api/settings', { headers: { Cookie: 'chattering=another-installs-secret; ' + ownName + '=' + installToken } });
    assert.equal(both.status, 200, 'the own cookie wins over the other install\'s');
    assert.ok(!both.headers.getSetCookie().some(c => /^chattering=;/.test(c)), 'and the other install\'s stays');
    const staleOwn = await fetch(base + '/api/settings', { headers: { Cookie: ownName + '=revoked' } });
    assert.equal(staleOwn.status, 401);
    assert.ok(staleOwn.headers.getSetCookie().some(c => c.startsWith(ownName + '=;') && /Max-Age=0/.test(c)), 'a stale own cookie is cleared');
  }
  // Flipping the switch on from this machine also signs that browser in,
  // so the person who opened the door is not locked out by it.
  s = await putLan(base, false, home);
  const on = await fetch(base + '/api/settings', withToken(home, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...s.settings, lan: true }) }));
  assert.match(on.headers.get('set-cookie') || '', /^chattering_[0-9a-f]{8}=/);
  s = await on.json();
  assert.equal(s.lan.on, true);
  if (ip) {
    for (let i = 0; i < 20 && await reachable(ip, port) !== 401; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(await reachable(ip, port), 401, 'answers on the LAN address, asking for the token');
    // Readiness probes carry no token (the Windows launcher, update.sh,
    // the machine switcher). /health answers them before sign-in and
    // gives away nothing but "up".
    const health = await fetch(`http://${ip}:${port}/health`, { signal: AbortSignal.timeout(1500) });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`http://${ip}:${port}/health`, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(`http://${ip}:${port}/healthz`, { signal: AbortSignal.timeout(1500) })).status, 401, 'only that one path is open');
    const token = new URL(s.connectLinks[0]).searchParams.get('token');
    const withToken = await fetch(`http://${ip}:${port}/api/settings`, { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(withToken.status, 200);
    assert.equal(fs.readFileSync(path.join(home, 'cache', 'lan-token'), 'utf8').trim(), token);
  }
  // The choice is written down, so it survives a restart.
  assert.equal(JSON.parse(fs.readFileSync(path.join(require('./helpers/home-env.js').appDir(home, 'config'), 'settings.json'), 'utf8')).lan, true);

  s = await putLan(base, false, home);
  assert.equal(s.lan.on, false); assert.deepEqual(s.connectLinks, []);
  assert.equal(await reachable('127.0.0.1', port), 401, 'off again, this machine still signs in');
  if (ip) {
    for (let i = 0; i < 20 && await reachable(ip, port) !== 0; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(await reachable(ip, port), 0, 'no longer answers on the LAN address');
  }
});

test('CHATTERING_LAN=1 is the default until the switch is used; CHATTERING_HOST pins it', async t => {
  const a = await boot(t, { CHATTERING_LAN: '1' });
  let s = await (await fetch(a.base + '/api/settings', withToken(a.home))).json();
  assert.equal(s.lan.on, true); assert.equal(s.lan.fixed, false); assert.equal(s.settings.lan, null);
  s = await putLan(a.base, false, a.home);
  assert.equal(s.lan.on, false, 'an explicit off wins over the environment default');

  const b = await boot(t, { CHATTERING_HOST: '127.0.0.1' });
  s = await (await fetch(b.base + '/api/settings', withToken(b.home))).json();
  assert.equal(s.lan.fixed, true); assert.equal(s.lan.on, false);
  s = await putLan(b.base, true, b.home);
  assert.equal(s.lan.on, false, 'a pinned address ignores the switch');
  assert.deepEqual(s.connectLinks, []);
});
