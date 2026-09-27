'use strict';
// The doors (frontdoor.js) and what stands before the sign-in (authguard.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fd = require('../frontdoor.js');
const ag = require('../authguard.js');

const status = JSON.stringify({ Self: { DNSName: 'lambda.tail69222b.ts.net.', ID: 'npCG', HostName: 'lambda', Online: true }, CurrentTailnet: { Name: 'm@x' } });
const serveOnly = JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { 'lambda.tail69222b.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7433' } } } } });
const funnelOn = JSON.stringify({ ...JSON.parse(serveOnly), AllowFunnel: { 'lambda.tail69222b.ts.net:443': true } });

test('door state: serve, funnel, another port, not signed in, not installed', async () => {
  const mk = (st, sv) => async (_, args) => { if (args[0] === 'status') return st; if (args[0] === 'serve') return sv; throw new Error('?'); };
  let d = await fd.doorState({ exec: mk(status, serveOnly), port: 7433 });
  assert.deepEqual([d.running, d.serve, d.funnel, d.url, d.deviceId], [true, true, false, 'https://lambda.tail69222b.ts.net', 'npCG']);
  d = await fd.doorState({ exec: mk(status, funnelOn), port: 7433 });
  assert.deepEqual([d.serve, d.funnel], [true, true]);
  d = await fd.doorState({ exec: mk(status, funnelOn), port: 9999 });
  assert.deepEqual([d.serve, d.funnel], [false, false], 'a handler for some other service is not our door');
  d = await fd.doorState({ exec: mk(JSON.stringify({ Self: {} }), serveOnly), port: 7433 });
  assert.equal(d.running, false);
  d = await fd.doorState({ exec: async () => { throw new Error('spawn tailscale ENOENT'); }, port: 7433 });
  assert.equal(d.installed, false);
});

test('turning the door on and off: the commands, and the refusals in words', async () => {
  const calls = [];
  const exec = async (_, args) => { calls.push(args.join(' ')); return ''; };
  assert.deepEqual(await fd.setFunnel(true, { exec, port: 7433 }), { ok: true });
  assert.deepEqual(await fd.setFunnel(false, { exec, port: 7433 }), { ok: true });
  assert.deepEqual(calls, ['funnel --bg --https=443 http://127.0.0.1:7433', 'serve --bg --https=443 http://127.0.0.1:7433'], 'off re-declares serve, never removes the handler');
  const refuse = msg => fd.setFunnel(true, { exec: async () => { throw new Error(msg); }, port: 7433 });
  let r = await refuse('\nFunnel is not enabled on your tailnet.\nTo enable, visit:\n\n\thttps://login.tailscale.com/f/funnel?node=npCG\n');
  assert.equal(r.code, 'tailnet'); assert.equal(r.enableUrl, 'https://login.tailscale.com/f/funnel?node=npCG');
  r = await refuse('sending serve config: Access denied: serve config denied\n\nUse \'sudo tailscale ...\'.');
  assert.equal(r.code, 'operator'); assert.match(r.message, /--operator=/);
  r = await refuse('failed to connect to local tailscaled');
  assert.equal(r.code, 'down');
});

test('a device invite through the API: the request shape, the answer, the refusals', async () => {
  let seen = null;
  const fetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, text: async () => JSON.stringify([{ id: 'inv1', inviteUrl: 'https://login.tailscale.com/admin/invite/abc', created: '2026-09-21T00:00:00Z' }]) }; };
  const inv = await fd.mintDeviceInvite({ fetch, apiKey: 'tskey-api-x', deviceId: 'npCG' });
  assert.equal(inv.url, 'https://login.tailscale.com/admin/invite/abc');
  assert.equal(seen.url, 'https://api.tailscale.com/api/v2/device/npCG/device-invites');
  assert.deepEqual(JSON.parse(seen.init.body), [{ multiUse: false, allowExitNode: false }]);
  assert.equal(seen.init.headers.Authorization, 'Basic ' + Buffer.from('tskey-api-x:').toString('base64'));
  await assert.rejects(fd.mintDeviceInvite({ fetch, apiKey: '', deviceId: 'npCG' }), /no Tailscale API access token/);
  const denied = async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ message: 'insufficient permissions' }) });
  await assert.rejects(fd.mintDeviceInvite({ fetch: denied, apiKey: 'k', deviceId: 'npCG' }), /insufficient permissions/);
});

test('the limiter: ten wrong guesses lock one address for the window; a success clears it; many addresses only slow', () => {
  const lim = ag.createLimiter({ perAddress: 3, windowMs: 1000, global: 5, slowMs: 50 });
  let now = 1_000_000;
  assert.deepEqual(lim.check('a', now), { ok: true, slowMs: 0 });
  lim.fail('a', now); lim.fail('a', now + 1); lim.fail('a', now + 2);
  const blocked = lim.check('a', now + 3);
  assert.equal(blocked.ok, false); assert.equal(blocked.retryAfterMs, 997);
  assert.equal(lim.check('b', now + 3).ok, true, 'another address is untouched');
  assert.equal(lim.check('a', now + 1001).ok, true, 'the window slid');
  lim.fail('a', now + 2000); lim.fail('a', now + 2001); lim.succeed('a');
  assert.equal(lim.check('a', now + 2002).ok, true, 'a success wipes the slate');
  lim.fail('s', now + 2500, 'stale-cookie'); lim.fail('s', now + 2501, 'stale-cookie'); lim.fail('s', now + 2502, 'stale-cookie'); lim.fail('s', now + 2503, 'stale-cookie');
  assert.equal(lim.check('s', now + 2504).ok, true, 'the same wrong secret over and over is one guess');
  lim.fail('s', now + 2505, 'other'); lim.fail('s', now + 2506, 'third');
  assert.equal(lim.check('s', now + 2507).ok, false, 'three distinct wrong secrets are three guesses');
  for (const ip of ['c', 'd', 'e', 'f', 'g']) lim.fail(ip, now + 3000);
  assert.equal(lim.check('z', now + 3001).slowMs, 50, 'five failures across the board: everyone waits a little');
  assert.equal(lim.check('z', now + 3001).ok, true, 'but nobody is locked out by strangers');
});

test('addresses and doors: proxied loopback is the forwarded hop; the door is named', () => {
  const req = (ip, headers = {}) => ({ socket: { remoteAddress: ip }, headers });
  assert.equal(ag.clientAddress(req('::ffff:192.168.2.5')), '192.168.2.5');
  assert.equal(ag.clientAddress(req('127.0.0.1', { 'x-forwarded-for': '100.64.1.2, 10.0.0.1' })), '100.64.1.2');
  assert.equal(ag.clientAddress(req('192.168.2.5', { 'x-forwarded-for': '1.2.3.4' })), '192.168.2.5', 'a forged header on a direct connection changes nothing');
  assert.equal(ag.doorOf(req('127.0.0.1')), 'local');
  assert.equal(ag.doorOf(req('127.0.0.1', { 'x-forwarded-for': '100.64.1.2', 'tailscale-user-login': 'x@y' })), 'tailnet');
  assert.equal(ag.doorOf(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })), 'public');
  assert.equal(ag.doorOf(req('192.168.2.5')), 'lan');
  assert.match(ag.cookieHeader('chattering', 'a b', req('127.0.0.1', { 'x-forwarded-proto': 'https' })), /chattering=a%20b; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
  assert.doesNotMatch(ag.cookieHeader('chattering', 'x', req('192.168.2.5')), /Secure/);
  const h = ag.securityHeaders(req('127.0.0.1', { 'x-forwarded-proto': 'https' }));
  assert.equal(h['X-Frame-Options'], 'SAMEORIGIN'); assert.equal(h['Referrer-Policy'], 'no-referrer'); assert.ok(h['Strict-Transport-Security']);
  assert.ok(!ag.securityHeaders(req('192.168.2.5'))['Strict-Transport-Security'], 'no HSTS over plain http');
});

test('the sign-in log: appended to disk, bounded in memory, newest first', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'authlog-')));
  const file = path.join(dir, 'auth-log.jsonl');
  const log = ag.createAuthLog(file, { tail: 3 });
  for (let i = 0; i < 5; i++) log.record({ ip: '1.1.1.' + i, outcome: 'fail' });
  await log.flush();
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 5, 'every event on disk');
  assert.deepEqual(log.recent().map(r => r.ip), ['1.1.1.4', '1.1.1.3', '1.1.1.2'], 'the tail, newest first');
  const again = ag.createAuthLog(file, { tail: 3 });
  assert.equal(again.recent().length, 3, 'reloaded from the file');
  fs.rmSync(dir, { recursive: true, force: true });
});
