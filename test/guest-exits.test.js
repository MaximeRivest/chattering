'use strict';
// What leaves the server for a guest: a real server, a real invite, and
// the ways a guest could reach past their one project — the owner's
// token, a forged machine, raw transcripts, the records API, the live
// event stream. Each must be closed; the household must not notice.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');

const root = path.join(__dirname, '..');
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
const until = async (fn, ms = 10000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };
const cookieOf = r => (r.headers.get('set-cookie') || '').split(';')[0];
const post = (url, body, cookie) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });

// Everything a live stream carries for `cookie` until `stop` resolves.
function listen(url, cookie) {
  const ctrl = new AbortController();
  let text = '';
  const done = (async () => {
    try {
      const r = await globalThis.fetch(url + '/api/events', { headers: { Cookie: cookie }, signal: ctrl.signal });
      const reader = r.body.getReader();
      for (;;) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString('utf8'); }
    } catch {}
  })();
  return { text: () => text, stop: async () => { ctrl.abort(); await done; return text; } };
}

test('a guest cannot reach past their project through any exit', { skip: !lanIp() && 'no LAN address' }, async t => {
  // Not under /tmp: folders there are loose, not projects.
  const testHomes = path.join(os.homedir(), '.cache', 'chattering-test-homes');
  fs.mkdirSync(testHomes, { recursive: true });
  const home = fs.mkdtempSync(path.join(testHomes, 'exits-'));
  const agent = path.join(home, '.pi', 'agent');
  const open = path.join(home, 'Projects', 'open'), secret = path.join(home, 'Projects', 'secret');
  fs.mkdirSync(open, { recursive: true }); fs.mkdirSync(secret, { recursive: true });
  fs.writeFileSync(path.join(open, 'README.md'), 'open project\n');
  fs.writeFileSync(path.join(secret, 'plan.md'), 'the zebra plan\n');
  const dirName = cwd => '--' + cwd.replace(/^\//, '').replace(/[/\\:]/g, '-') + '--';
  const sess = (cwd, id, text) => {
    const dir = path.join(agent, 'sessions', dirName(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `2026-09-26T10-00-00-000Z_${id}.jsonl`);
    fs.writeFileSync(f, line({ type: 'session', version: 3, id, timestamp: '2026-09-26T10:00:00.000Z', cwd })
      + line({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-09-26T10:00:01.000Z', message: { role: 'user', content: text } })
      + line({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-09-26T10:00:02.000Z', message: { role: 'assistant', content: 'ok', model: 'test' } }));
    return f;
  };
  sess(open, '01a0open00000000000000000000000000', 'the open plan');
  const secretFile = sess(secret, '01a0secret000000000000000000000000', 'the zebra plan');
  const port = await freePort(), tlsPort = await freePort();
  registerConsole(port, 'install-tok');
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(tlsPort),
    CHATTERING_NO_WATCH: '0', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'),
    CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    CHATTERING_HOST: '', CHATTERING_LAN: '1', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: 'install-tok' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const local = 'http://127.0.0.1:' + port, remote = 'http://' + lanIp() + ':' + port;
  const list = await until(async () => { try { const l = await (await fetch(local + '/api/sessions')).json(); return l.length === 2 && l; } catch { return false; } }, 20000);
  const secretKey = (list.find(e => e.project === 'secret') || assert.fail(JSON.stringify(list.map(e => [e.project, e.cwd])))).key;
  const openKey = list.find(e => e.project === 'open').key;

  // The owner signs in from the network, invites Sam to `open`, adds Lilly to the household.
  const ownerCookie = cookieOf(await fetch(remote + '/?token=install-tok', { redirect: 'manual' }));
  const invited = await (await post(local + '/api/invites', { project: 'open', right: 'act', name: 'Sam' })).json();
  assert.ok(invited.link, JSON.stringify(invited));
  const sam = cookieOf(await fetch(remote + '/invite/claim', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ invite: new URL(invited.link).searchParams.get('invite'), name: 'Sam' }) }));
  const samMe = await (await fetch(remote + '/api/users', { headers: { Cookie: sam } })).json();
  assert.equal(samMe.me.scope, 'guest');
  const added = await (await post(local + '/api/users/add', { name: 'Lilly' })).json();
  const lilly = cookieOf(await fetch(remote + '/?token=' + encodeURIComponent(new URL(added.inviteLink).searchParams.get('token')), { redirect: 'manual' }));
  const get = (p, cookie) => fetch(remote + p, { headers: { Cookie: cookie } });

  // DNS rebinding: a page whose name was pointed at this machine sends its
  // own name as Host. Refused before anything else, even with the owner's
  // credential, on plain requests and on sockets alike.
  const http = require('node:http');
  const raw = (host, headers = {}) => new Promise(resolve => http.get({ host: '127.0.0.1', port: Number(new URL(local).port), path: '/api/users', headers: { host, Authorization: 'Bearer install-tok', ...headers } }, r => { r.resume(); resolve(r.statusCode); }).on('error', () => resolve(0)));
  assert.equal(await raw('evil.example:' + new URL(local).port), 421, 'a foreign name is refused');
  assert.equal(await raw('127.0.0.1:' + new URL(local).port), 200, 'an address is ours');
  assert.equal(await raw(os.hostname()), 200, 'this machine\'s own name is ours');
  assert.equal(await raw('evil.example', { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }), 421, 'and on a socket');

  // The owner's token is not in anything a guest or a member reads.
  for (const who of [sam, lilly]) {
    const settings = await (await get('/api/settings', who)).text();
    assert.doesNotMatch(settings, /install-tok/, 'the connect links carry the owner\'s token');
  }
  assert.match(await (await get('/api/settings', ownerCookie)).text(), /install-tok/, 'the owner still gets their links');

  // A guest cannot register a machine whose key would sign them in as anyone.
  const forged = await post(remote + '/api/machines/register', { name: 'evil', url: 'http://10.9.9.9:1', token: 'x', publicKey: 'A'.repeat(44) }, sam);
  assert.equal(forged.status, 403);
  assert.equal((await post(remote + '/api/machines/register', { name: 'evil', url: 'http://10.9.9.9:1', token: 'x' }, lilly)).status, 403, 'nor can a member');

  // Records, raw transcripts, notes, agents: not for a guest.
  for (const p of ['/api/transcript/raw?id=' + encodeURIComponent(secretKey) + '&i=0', '/api/records/search?q=zebra', '/api/notes', '/api/agents/active', '/api/here?dir=' + encodeURIComponent(secret), '/api/nobody-decided']) {
    const r = await get(p, sam);
    assert.equal(r.status, 403, p + ' → ' + r.status);
    assert.doesNotMatch(await r.text(), /zebra/, p);
  }
  // A conversation named in the query is checked before the handler.
  assert.equal((await get('/api/conversation/context?id=' + encodeURIComponent(secretKey), sam)).status, 403);
  assert.equal((await get('/api/conversation/context?id=' + encodeURIComponent(openKey), sam)).status, 200);
  // The shared project still works for Sam.
  assert.deepEqual((await (await get('/api/sessions', sam)).json()).map(e => e.project), ['open']);
  // The household is not affected: Lilly reads what she read before.
  assert.equal((await get('/api/transcript/raw?id=' + encodeURIComponent(secretKey) + '&i=0', lilly)).status, 200);
  assert.equal((await get('/api/records/search?q=zebra', lilly)).status, 200);

  // The live stream: a change to the secret conversation reaches the owner, never Sam.
  const samStream = listen(remote, sam), ownerStream = listen(remote, ownerCookie);
  await until(() => samStream.text().includes('"hello"') && ownerStream.text().includes('"hello"'));
  fs.appendFileSync(secretFile, line({ type: 'message', id: 'm3', parentId: 'm2', timestamp: '2026-09-26T10:01:00.000Z', message: { role: 'user', content: 'zebra again' } }));
  await until(() => ownerStream.text().includes(secretKey), 15000).catch(() => { throw new Error('the owner never saw the update; the watcher did not fire\n' + log.slice(-1500)); });
  await new Promise(r => setTimeout(r, 500));
  const samSaw = await samStream.stop(); await ownerStream.stop();
  assert.doesNotMatch(samSaw, /zebra|01a0secret/, 'the guest\'s stream carries nothing about the secret project');
  assert.doesNotMatch(await (await get('/api/jobs', sam)).text(), /01a0secret/);
  assert.doesNotMatch(await (await get('/api/recent-files', sam)).text(), /Projects\/secret/);
});
