'use strict';
// Identity, sharing, presence and handoff on the real server: boot it on
// a throwaway HOME reachable on the LAN address, then act as the owner,
// as a member with an invite link, and as a person arriving by handoff.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '0.0.0.0', r));
  const port = s.address().port; await new Promise(r => s.close(r));
  return port;
}
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (!n.internal && n.family === 'IPv4' && !n.address.startsWith('172.')) return n.address;
  return null;
}
const line = o => JSON.stringify(o) + '\n';
function sessionFile(dir, id, cwd, text, extra = '') {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `2026-09-19T10-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(f, line({ type: 'session', version: 3, id, timestamp: '2026-09-19T10:00:00.000Z', cwd })
    + extra
    + line({ type: 'message', id: 'm1', parentId: extra ? 'a1' : null, timestamp: '2026-09-19T10:00:01.000Z', message: { role: 'user', content: text } })
    + line({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-09-19T10:00:02.000Z', message: { role: 'assistant', content: 'ok', model: 'test' } }));
  return f;
}

async function boot(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'users-server-'));
  const agent = path.join(home, '.pi', 'agent');
  const sessions = path.join(agent, 'sessions');
  sessionFile(path.join(sessions, '--home-x-Projects-secret--'), '01a0secret000000000000000000000000', '/home/x/Projects/secret', 'the secret plan');
  sessionFile(path.join(sessions, '--home-x-Projects-open--'), '01a0open00000000000000000000000000', '/home/x/Projects/open', 'the open plan',
    line({ type: 'custom', customType: 'chattering-author', id: 'a1', parentId: null, timestamp: '2026-09-19T10:00:00.500Z', data: { v: 1, user: { id: 'u_lilly', name: 'Lilly' }, input: 'keyboard' } }));
  const port = await freePort(), tlsPort = await freePort();
  registerConsole(port, 'install-tok');
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(tlsPort), CHATTERING_NO_WATCH: '0', CHATTERING_NO_LEDGER: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, CHATTERING_HOST: '', CHATTERING_LAN: '1', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: 'install-tok' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const local = 'http://127.0.0.1:' + port;
  const remote = 'http://' + lanIp() + ':' + port;
  for (let i = 0; i < 300; i++) {
    try { const r = await fetch(local + '/api/sessions'); if (r.ok && (await r.json()).length === 2) break; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  return { local, remote, home, log: () => log };
}
const cookieOf = r => (r.headers.get('set-cookie') || '').split(';')[0];
const as = cookie => ({ headers: { Cookie: cookie } });
const post = (url, body, cookie) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });

test('people, sharing, presence and handoff on one install', { skip: !lanIp() && 'no LAN address' }, async t => {
  const { local, remote, home } = await boot(t);

  // The console is this machine with the install token. This machine
  // without it proves nothing: a guest's sandboxed agent is local too.
  assert.equal((await globalThis.fetch(local + '/api/users')).status, 401);
  const console_ = await (await fetch(local + '/api/users')).json();
  assert.equal(console_.tier, 'console');
  assert.equal(console_.me.role, 'owner');
  assert.ok(fs.existsSync(path.join(require('./helpers/home-env.js').appDir(home, 'config'), 'users.json')), 'the roster is written on first run');

  // From the network: nothing without a credential; the install token is the owner's.
  assert.equal((await fetch(remote + '/api/users')).status, 401);
  const signIn = await fetch(remote + '/?token=install-tok', { redirect: 'manual' });
  assert.equal(signIn.status, 302);
  const ownerCookie = cookieOf(signIn);
  const owner = await (await fetch(remote + '/api/users', as(ownerCookie))).json();
  assert.equal(owner.tier, 'owner');
  assert.equal(owner.canManage, true);

  // The owner adds Lilly and gets her invite link, once.
  const added = await (await post(remote + '/api/users/add', { name: 'Lilly', groups: ['kids'] }, ownerCookie)).json();
  assert.ok(added.inviteLink.includes('?token='), added.error);
  assert.equal(added.user.role, 'member');
  const lillySecret = new URL(added.inviteLink).searchParams.get('token');
  const lillyIn = await fetch(remote + '/?token=' + encodeURIComponent(lillySecret), { redirect: 'manual' });
  const lillyCookie = cookieOf(lillyIn);
  const lilly = await (await fetch(remote + '/api/users', as(lillyCookie))).json();
  assert.equal(lilly.me.name, 'Lilly');
  assert.equal(lilly.tier, 'member');
  assert.equal(lilly.canManage, false);
  assert.equal((await post(remote + '/api/users/add', { name: 'Nope' }, lillyCookie)).status, 403, 'a member does not manage the roster');
  const settingsForLilly = await (await fetch(remote + '/api/settings', as(lillyCookie))).json();
  assert.equal(settingsForLilly.me.name, 'Lilly');
  assert.equal(settingsForLilly.canEditSettings, false);
  assert.equal((await fetch(remote + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: lillyCookie }, body: '{}' })).status, 403);

  // The household default: Lilly sees both conversations, and the one she
  // wrote into names her as a participant.
  let list = await (await fetch(remote + '/api/sessions', as(lillyCookie))).json();
  assert.equal(list.length, 2);
  const open = list.find(e => e.project === 'open'), secret = list.find(e => e.project === 'secret');
  assert.deepEqual(open.participants, [{ id: 'u_lilly', name: 'Lilly' }]);
  assert.equal(open.createdBy, 'u_lilly');
  assert.equal(secret.participants, undefined);

  // The owner hides "secret" from everyone but themselves.
  const before = await (await fetch(remote + '/api/access?project=secret', as(ownerCookie))).json();
  assert.equal(before.summary, 'everyone on this machine');
  assert.equal((await fetch(remote + '/api/access', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: lillyCookie }, body: JSON.stringify({ project: 'secret', mode: 'listed' }) })).status, 403, 'Lilly does not own it');
  const hidden = await (await fetch(remote + '/api/access', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: JSON.stringify({ project: 'secret', mode: 'listed' }) })).json();
  assert.equal(hidden.summary, 'only me');
  list = await (await fetch(remote + '/api/sessions', as(lillyCookie))).json();
  assert.deepEqual(list.map(e => e.project), ['open']);
  assert.equal((await fetch(remote + '/api/session?id=' + encodeURIComponent(secret.key), as(lillyCookie))).status, 403);
  assert.equal((await fetch(remote + '/api/project?name=secret', as(lillyCookie))).status, 403);
  assert.equal((await post(remote + '/api/node/send', { id: secret.key, prompt: 'hi' }, lillyCookie)).status, 403);
  const search = await (await fetch(remote + '/api/search?q=plan', as(lillyCookie))).json();
  assert.deepEqual(search.groups.map(g => g.key), [open.key]);
  // The owner still sees everything, and the console too.
  assert.equal((await (await fetch(remote + '/api/sessions', as(ownerCookie))).json()).length, 2);
  assert.equal((await (await fetch(local + '/api/sessions')).json()).length, 2);
  // Read-only for the kids group on "open": Lilly reads, cannot send.
  await fetch(remote + '/api/access', { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie }, body: JSON.stringify({ project: 'open', mode: 'listed', listed: { 'group:kids': 'see' } }) });
  const openView = await (await fetch(remote + '/api/session?id=' + encodeURIComponent(open.key), as(lillyCookie))).json();
  assert.equal(openView.canAct, false);
  assert.deepEqual(openView.participants.map(p => p.name), ['Lilly']);
  const refused = await post(remote + '/api/node/send', { id: open.key, prompt: 'hi' }, lillyCookie);
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /read .* not act/);

  // Presence: Lilly's live stream names her connection; the owner sees her
  // on the open conversation, but never on a route hidden from him — and
  // she never sees the owner on "secret".
  const ownerEvents = [];
  const ownerStream = await fetch(remote + '/api/events', as(ownerCookie));
  const ownerReader = ownerStream.body.getReader();
  const pump = (reader, sink) => (async () => { const dec = new TextDecoder(); let buf = ''; for (;;) { const { value, done } = await reader.read(); if (done) return; buf += dec.decode(value, { stream: true }); let at; while ((at = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, at); buf = buf.slice(at + 2); const d = chunk.split('\n').find(l => l.startsWith('data: ')); if (d) sink.push(JSON.parse(d.slice(6))); } } })().catch(() => {});
  pump(ownerReader, ownerEvents);
  const lillyEvents = [];
  const lillyStream = await fetch(remote + '/api/events', as(lillyCookie));
  pump(lillyStream.body.getReader(), lillyEvents);
  const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 25)); } };
  await until(() => ownerEvents.some(e => e.type === 'hello') && lillyEvents.some(e => e.type === 'hello'));
  const lillyHello = lillyEvents.find(e => e.type === 'hello');
  assert.equal(lillyHello.me.name, 'Lilly');
  const ownerHello = ownerEvents.find(e => e.type === 'hello');
  const p1 = await (await post(remote + '/api/presence', { conn: lillyHello.conn, route: 'conversation:' + open.key, kind: 'typing' }, lillyCookie)).json();
  assert.equal(p1.ok, true);
  await until(() => ownerEvents.some(e => e.type === 'presence' && e.people.some(p => p.user.name === 'Lilly' && p.kind === 'typing')));
  assert.equal((await post(remote + '/api/presence', { conn: lillyHello.conn, route: 'home' }, ownerCookie)).status, 403, 'a connection belongs to its person');
  await post(remote + '/api/presence', { conn: ownerHello.conn, route: 'conversation:' + secret.key, kind: 'viewing' }, ownerCookie);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(lillyEvents.some(e => e.type === 'presence' && e.people.some(p => p.route.includes('secret'))), false, 'a hidden route does not leak through presence');
  await ownerReader.cancel();
  await until(() => lillyEvents.some(e => e.type === 'presence' && !e.people.some(p => p.user.role === 'owner')));

  // Handoff: pair this install with itself (a stand-in for lambda ↔ lilly-pc),
  // then Lilly asks to go there and arrives signed in as Lilly, no paste.
  const settings = await (await fetch(remote + '/api/settings', as(ownerCookie))).json();
  assert.ok(settings.publicKey);
  const reg = await fetch(remote + '/api/machines/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer install-tok' }, body: JSON.stringify({ name: 'other', url: remote, token: 'install-tok', publicKey: settings.publicKey }) });
  assert.equal((await reg.json()).publicKey, settings.publicKey, 'registering back returns our key');
  const hand = await (await fetch(remote + '/api/handoff?i=0', as(lillyCookie))).json();
  assert.equal(hand.handoff, true);
  assert.equal(hand.as.name, 'Lilly');
  const arrive = await fetch(hand.url, { redirect: 'manual' });
  assert.equal(arrive.status, 302, await arrive.text());
  const arrivedCookie = cookieOf(arrive);
  assert.notEqual(arrivedCookie, lillyCookie);
  const arrived = await (await fetch(remote + '/api/users', as(arrivedCookie))).json();
  assert.equal(arrived.me.id, lilly.me.id);
  // A forged or stale handoff is refused; a member's link from the roster is
  // shown once and hashed on disk.
  const bad = await fetch(remote + '/?handoff=h1.abc.def', { redirect: 'manual' });
  assert.equal(bad.status, 401);
  const rosterOnDisk = fs.readFileSync(path.join(require('./helpers/home-env.js').appDir(home, 'config'), 'users.json'), 'utf8');
  assert.equal(rosterOnDisk.includes(lillySecret), false);
  assert.equal(rosterOnDisk.includes('install-tok'), false);
  // Sign out drops the cookie.
  const out = await fetch(remote + '/logout', { method: 'POST', headers: { Cookie: lillyCookie }, redirect: 'manual' });
  assert.equal(out.status, 302);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});
