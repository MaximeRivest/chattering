'use strict';
// Project invites and sync between two real installs: the host invites a
// person to one project; that person's own chattering joins with the link;
// conversations mirror both ways (redacted at the border), memory leaves
// travel, the guest sees nothing but the shared project, and a mirrored
// conversation cannot be driven from the other side.
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
// A pi transcript with one tool step inside the project and one outside it.
function sessionFile(dir, id, cwd, text, { tools = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `2026-09-20T10-00-00-000Z_${id}.jsonl`);
  let body = line({ type: 'session', version: 3, id, timestamp: '2026-09-20T10:00:00.000Z', cwd })
    + line({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-09-20T10:00:01.000Z', message: { role: 'user', content: text } });
  if (tools) {
    body += line({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-09-20T10:00:02.000Z', message: { role: 'assistant', content: [
      { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'cat ' + cwd + '/README.md' } },
      { type: 'toolCall', id: 't2', name: 'bash', arguments: { command: 'cat ~/.ssh/config' } }], model: 'test' } })
      + line({ type: 'message', id: 'm3', parentId: 'm2', timestamp: '2026-09-20T10:00:03.000Z', message: { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'readme says hello' }] } })
      + line({ type: 'message', id: 'm4', parentId: 'm3', timestamp: '2026-09-20T10:00:04.000Z', message: { role: 'toolResult', toolCallId: 't2', content: [{ type: 'text', text: 'Host lambda\n  IdentityFile ~/.ssh/id_ed25519' }] } })
      + line({ type: 'message', id: 'm5', parentId: 'm4', timestamp: '2026-09-20T10:00:05.000Z', message: { role: 'assistant', content: 'done', model: 'test' } });
  } else {
    body += line({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-09-20T10:00:02.000Z', message: { role: 'assistant', content: 'ok', model: 'test' } });
  }
  fs.writeFileSync(f, body);
  return f;
}

// Homes live under the real home, not /tmp: a folder under /tmp is "loose"
// by the project convention, and the id marker must land in a real folder.
const TMP_ROOT = path.join(os.homedir(), '.cache', 'chattering-test-homes');
async function boot(t, { label, sessions, publicUrlFor }) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const home = fs.mkdtempSync(path.join(TMP_ROOT, 'sync-' + label + '-'));
  const agent = path.join(home, '.pi', 'agent');
  sessions(path.join(agent, 'sessions'), home);
  const port = await freePort(), tlsPort = await freePort();
  registerConsole(port, 'tok-' + label);
  const publicUrl = publicUrlFor(port);
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, HOME: home, PORT: String(port), CHATTERING_TLS_PORT: String(tlsPort), CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    CHATTERING_HOST: '', CHATTERING_LAN: '1', CHATTERING_PUBLIC_URL: publicUrl, CHATTERING_TOKEN: 'tok-' + label, CHATTERING_HOSTNAME: label }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const local = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 400; i++) {
    try { const r = await fetch(local + '/api/sessions'); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  return { local, remote: publicUrl, home, port, log: () => log };
}
const cookieOf = r => (r.headers.get('set-cookie') || '').split(';')[0];
const as = cookie => ({ headers: { Cookie: cookie } });
const post = (url, body, cookie) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };

test('invite, join from another install, mirror both ways, guest walls', { skip: !lanIp() && 'no LAN address' }, async t => {
  const ip = lanIp();
  const host = await boot(t, { label: 'host', publicUrlFor: p => `http://${ip}:${p}`, sessions: (dir, home) => {
    fs.mkdirSync(path.join(home, 'Projects', 'open'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Projects', 'secret'), { recursive: true });
    sessionFile(path.join(dir, '--home-h-Projects-open--'), '01a0open00000000000000000000000000', path.join(home, 'Projects', 'open'), 'the open plan', { tools: true });
    sessionFile(path.join(dir, '--home-h-Projects-secret--'), '01a0secret000000000000000000000000', path.join(home, 'Projects', 'secret'), 'the secret plan');
  } });
  const guest = await boot(t, { label: 'guest', publicUrlFor: p => `http://${ip}:${p}`, sessions: (dir, home) => {
    fs.mkdirSync(path.join(home, 'work', 'open-clone'), { recursive: true });
  } });
  await until(async () => (await (await fetch(host.local + '/api/sessions')).json()).length === 2);

  // The host owner invites someone to the open project, with the right to act.
  const invited = await (await post(host.local + '/api/invites', { project: 'open', right: 'act', name: 'Sam' })).json();
  assert.ok(invited.link && invited.link.includes('?invite='), JSON.stringify(invited));
  assert.equal(invited.runsAsAccount, true, 'the answer says plainly that act means running as the account');
  assert.ok(fs.existsSync(path.join(host.home, 'Projects', 'open', '.chattering', 'project.json')), 'the id marker is written into the checkout');
  const marker = JSON.parse(fs.readFileSync(path.join(host.home, 'Projects', 'open', '.chattering', 'project.json'), 'utf8'));
  assert.match(marker.id, /^p_[0-9a-f]{16}$/);

  // The invite page shows what is shared and the join command; a wrong link is refused.
  const page = await (await fetch(invited.link)).text();
  assert.match(page, /invited you to work on <b>open<\/b>/);
  assert.match(page, /chattering join http/);
  assert.equal((await fetch(host.remote + '/?invite=nope')).status, 410);

  // Sam's own chattering joins with the link, binding the project to a local folder.
  const folder = path.join(guest.home, 'work', 'open-clone');
  const joined = await (await post(guest.local + '/api/sync/join-remote', { link: invited.link, name: 'Sam', folder })).json();
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(joined.me.name, 'Sam');
  assert.equal(joined.me.scope, 'guest');
  assert.equal(joined.projects[0].id, marker.id);
  assert.equal(joined.registered, true, 'the guest install is registered as a peer on the host');
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, '.chattering', 'project.json'), 'utf8')).id, marker.id, 'the clone carries the same id');

  // The host now has Sam as a guest listed on open only; the secret project stays out of the feed.
  const hostUsers = await (await fetch(host.local + '/api/users')).json();
  const sam = hostUsers.users.find(u => u.name === 'Sam');
  assert.ok(sam && sam.scope === 'guest');
  const hostAccess = JSON.parse(fs.readFileSync(path.join(host.home, 'notes', 'chattering', 'access.json'), 'utf8'));
  assert.equal(hostAccess.rules['project:open'].listed['user:' + sam.id], 'act');
  assert.equal(hostAccess.rules['project:secret'], undefined);
  const hostPeers = await (await fetch(host.local + '/api/sync/peers')).json();
  assert.equal(hostPeers.peers.length, 1);
  assert.equal(hostPeers.peers[0].them.id, sam.id);
  assert.equal(hostPeers.peers[0].url, guest.remote, 'the host knows where to pull from');

  // The join already pulled: the open conversation is mirrored on Sam's machine under the local folder's name.
  const guestList = await until(async () => { const l = await (await fetch(guest.local + '/api/sessions')).json(); return l.length ? l : null; });
  assert.equal(guestList.length, 1);
  assert.ok(guestList[0].key.startsWith('mirror:'), guestList[0].key);
  assert.equal(guestList[0].project, 'open-clone');
  assert.equal(guestList[0].mirror.peerName, 'host');
  const mirrored = await (await fetch(guest.local + '/api/session?id=' + encodeURIComponent(guestList[0].key))).json();
  assert.equal(mirrored.canAct, false);
  const results = mirrored.messages.filter(m => m.role === 'toolresult').map(m => m.text);
  assert.ok(results.some(t => t.includes('readme says hello')), 'a tool step inside the project travels whole');
  assert.ok(results.some(t => t.includes('[redacted before sharing')), 'a tool step outside the project is redacted');
  assert.ok(!results.some(t => t.includes('IdentityFile')), 'the ssh config never left the host');
  // Sending into the mirror is refused with the reason.
  const refused = await (await post(guest.local + '/api/conversation/send', { id: guestList[0].key, text: 'hello' })).json();
  assert.match(refused.error || '', /lives on host/);

  // Sam works locally; the host pulls it and sees it as a mirror from Sam's machine.
  sessionFile(path.join(guest.home, '.pi', 'agent', 'sessions', '--work-open-clone--'), '01a0sam000000000000000000000000000', folder, 'sam adds a design');
  await until(async () => (await (await fetch(guest.local + '/api/sessions')).json()).length === 2 || (await post(guest.local + '/api/rescan', {})).ok && false);
  const synced = await (await post(host.local + '/api/sync/now', {})).json();
  assert.ok(synced.results, JSON.stringify(synced));
  const hostList = await (await fetch(host.local + '/api/sessions')).json();
  const fromSam = hostList.find(s => s.key.startsWith('mirror:'));
  assert.ok(fromSam, 'the host has a mirror of Sam\'s conversation: ' + hostList.map(s => s.key).join(', '));
  assert.equal(fromSam.project, 'open');
  assert.equal(fromSam.title, 'sam adds a design');

  // In the host's browser, Sam (signed in with the cookie a claim gives) sees only the open project.
  const link2 = await (await post(host.local + '/api/invites', { project: 'open', right: 'see', name: 'Kim' })).json();
  const claim = await fetch(host.remote + '/invite/claim', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ invite: new URL(link2.link).searchParams.get('invite'), name: 'Kim' }) });
  assert.equal(claim.status, 302);
  const kim = cookieOf(claim);
  const kimSees = await (await fetch(host.remote + '/api/sessions', as(kim))).json();
  assert.deepEqual([...new Set(kimSees.map(s => s.project))].sort(), ['open']);
  assert.equal((await fetch(host.remote + '/api/session?id=' + encodeURIComponent('pi:--home-h-Projects-secret--/2026-09-20T10-00-00-000Z_01a0secret000000000000000000000000.jsonl'), as(kim))).status, 403);
  const kimMe = await (await fetch(host.remote + '/api/users', as(kim))).json();
  assert.equal(kimMe.me.scope, 'guest');
  assert.equal(kimMe.canManage, false);
  // The link is spent.
  assert.equal((await fetch(link2.link)).status, 410);

  // Removing Sam drops the grants and the peer.
  const removed = await (await post(host.local + '/api/users/remove', { id: sam.id })).json();
  assert.equal(removed.removed, sam.id);
  assert.equal((await (await fetch(host.local + '/api/sync/peers')).json()).peers.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(host.home, 'notes', 'chattering', 'access.json'), 'utf8')).rules['project:open']?.listed?.['user:' + sam.id], undefined);
});

test('a guest install with no public address pushes its side instead', { skip: !lanIp() && 'no LAN address' }, async t => {
  const ip = lanIp();
  const host = await boot(t, { label: 'host2', publicUrlFor: p => `http://${ip}:${p}`, sessions: (dir, home) => {
    fs.mkdirSync(path.join(home, 'Projects', 'open'), { recursive: true });
    sessionFile(path.join(dir, '--home-h-Projects-open--'), '01a0open00000000000000000000000000', path.join(home, 'Projects', 'open'), 'the open plan');
  } });
  const guest = await boot(t, { label: 'laptop', publicUrlFor: () => '', sessions: (dir, home) => {
    fs.mkdirSync(path.join(home, 'Projects', 'open'), { recursive: true });
    sessionFile(path.join(dir, '--home-g-Projects-open--'), '01a0lap000000000000000000000000000', path.join(home, 'Projects', 'open'), 'laptop work');
  } });
  await until(async () => (await (await fetch(host.local + '/api/sessions')).json()).length === 1);
  await until(async () => (await (await fetch(guest.local + '/api/sessions')).json()).length === 1);
  const invited = await (await post(host.local + '/api/invites', { project: 'open', right: 'act', name: 'Sam' })).json();
  const joined = await (await post(guest.local + '/api/sync/join-remote', { link: invited.link, folder: path.join(guest.home, 'Projects', 'open') })).json();
  assert.equal(joined.ok, true, JSON.stringify(joined));
  assert.equal(joined.reachableFromThem, false);
  const hostPeers = await (await fetch(host.local + '/api/sync/peers')).json();
  assert.equal(hostPeers.peers[0].reachable, false);
  // The join's own sync pulled the host's conversation and pushed the laptop's.
  const hostList = await (await fetch(host.local + '/api/sessions')).json();
  assert.ok(hostList.some(s => s.key.startsWith('mirror:') && s.title === 'laptop work'), hostList.map(s => s.key).join(','));
  const guestList = await (await fetch(guest.local + '/api/sessions')).json();
  assert.ok(guestList.some(s => s.key.startsWith('mirror:') && s.title === 'the open plan'));
  assert.equal(new Set(guestList.map(s => s.project)).size, 1, 'one project on the laptop, the local folder and the mirrors together');
  // A read-only guest cannot push.
  const ro = await (await post(host.local + '/api/invites', { project: 'open', right: 'see', name: 'Kim' })).json();
  const kimJoin = await (await post(host.remote + '/api/sync/join', { invite: new URL(ro.link).searchParams.get('invite'), name: 'Kim' })).json();
  const pushed = await fetch(host.remote + '/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + kimJoin.credential }, body: JSON.stringify({ project: kimJoin.projects[0].id, items: [] }) });
  assert.equal(pushed.status, 403);
});
