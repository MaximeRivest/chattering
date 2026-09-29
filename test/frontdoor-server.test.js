'use strict';
// The guard in front of the sign-in, on a real server (design/56): wrong
// proofs are counted per address and locked out, the right one clears, a
// stale cookie repeated is one guess, every answer carries the headers,
// the doors routes are the owner's.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');

const root = path.join(__dirname, '..');
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '0.0.0.0', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
function lanIp() { for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (!n.internal && n.family === 'IPv4' && !n.address.startsWith('172.')) return n.address; return null; }
const until = async (fn, ms = 20000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };

test('sign-in guard: lockout after ten distinct wrong tokens, a stale cookie counts once, headers, doors are the owner\'s', { skip: !lanIp() && 'no LAN address' }, async t => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'frontdoor-')));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  const port = await freePort(), tlsPort = await freePort();
  registerConsole(port, 'install-tok');
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(tlsPort), CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    CHATTERING_HOST: '', CHATTERING_LAN: '1', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: 'install-tok', PATH: '/nonexistent' /* no tailscale: the doors say so */ }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const local = 'http://127.0.0.1:' + port, remote = 'http://' + lanIp() + ':' + port;
  await until(async () => { try { return (await fetch(local + '/health')).ok; } catch { return false; } });
  const raw = globalThis.fetch;
  const login = tok => raw(remote + '/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tok }) });

  // The guest rules are public and name nothing.
  const rules = await raw(remote + '/guests');
  assert.equal(rules.status, 200);
  const rulesText = await rules.text();
  assert.match(rulesText, /What a guest can and cannot do/);
  assert.doesNotMatch(rulesText, /install-tok|Lilly/);
  // The page is free; the headers ride on it.
  const page = await raw(remote + '/');
  assert.equal(page.status, 401);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('strict-transport-security'), null, 'no HSTS over http');
  for (let i = 0; i < 30; i++) assert.equal((await raw(remote + '/')).status, 401, 'bare visits are never counted');

  // A stale cookie, sent on every request of a page load: one guess.
  // Its own name is cleared (checked in lan-switch.test.js).
  for (let i = 0; i < 12; i++) {
    const r = await raw(remote + '/api/sessions', { headers: { Cookie: 'chattering=stale-value' } });
    assert.equal(r.status, 401, 'still 401, not 429: ' + i);
    // The shared old name may be another install's on this computer
    // (design/84): it is refused, not cleared.
    if (i === 0) assert.doesNotMatch(r.headers.get('set-cookie') || '', /(^|, )chattering=;/, 'the old shared name is left alone');
  }
  // Nine distinct wrong tokens (the stale cookie was the first guess): the tenth is the last allowed.
  for (let i = 0; i < 8; i++) assert.equal((await login('wrong-' + i)).status, 401);
  assert.equal((await login('wrong-9')).status, 401, 'tenth guess: still answered');
  const locked = await login('wrong-10');
  assert.equal(locked.status, 429, 'eleventh: locked out');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.match(await locked.text(), /Too many failed sign-ins/);
  const lockedRight = await login('install-tok');
  assert.equal(lockedRight.status, 429, 'even the right token waits: the lock is on the address, and it is the point');
  // Another address (loopback, the console) is untouched, and the right token there clears nothing for the LAN address.
  assert.equal((await fetch(local + '/api/sessions')).status, 200);
  // The owner's view of it.
  const seen = await (await fetch(local + '/api/doors/sign-ins')).json();
  assert.ok(seen.recent.length >= 10, JSON.stringify(seen).slice(0, 300));
  assert.equal(seen.recent[0].outcome, 'fail');
  assert.equal(seen.recent[0].door, 'lan');
  assert.equal(seen.recent[0].ip, lanIp());
  assert.ok(seen.recent.some(r => r.via === 'cookie') && seen.recent.some(r => r.via === 'login'));
  assert.ok(fs.existsSync(path.join(require('./helpers/home-env.js').appDir(home, 'data'), 'sign-ins.jsonl')), 'on disk, outside the cache');

  // Doors: readable by the owner, not by a member; without tailscale they say so.
  const doors = await (await fetch(local + '/api/doors')).json();
  assert.equal(doors.installed, false);
  const added = await (await fetch(local + '/api/users/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Lilly' }) })).json();
  const lillyTok = new URL(added.inviteLink).searchParams.get('token');
  const lilly = await raw(local + '/?token=' + lillyTok, { redirect: 'manual' });
  assert.equal(lilly.status, 302);
  const lillyCookie = (lilly.headers.get('set-cookie') || '').split(';')[0];
  assert.doesNotMatch(lilly.headers.get('set-cookie'), /Secure/, 'no Secure flag over plain http, or the cookie would never come back');
  assert.equal((await raw(local + '/api/doors', { headers: { Cookie: lillyCookie } })).status, 403);
  const lillySettings = await (await raw(local + '/api/settings', { headers: { Cookie: lillyCookie } })).json();
  assert.equal(lillySettings.settings.tailscaleApiKey, '', 'the API token never reaches a member');
  assert.equal((await raw(local + '/api/doors/public', { method: 'POST', headers: { Cookie: lillyCookie, 'Content-Type': 'application/json' }, body: '{"on":true}' })).status, 403);
  const flip = await (await fetch(local + '/api/doors/public', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"on":true}' })).json();
  assert.ok(flip.error, 'without tailscale the switch refuses in words: ' + JSON.stringify(flip));
});
