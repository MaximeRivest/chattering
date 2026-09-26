'use strict';
// A guest on a real server: what they can run, and where the walls are.
// Boots the server on a throwaway HOME reachable on the LAN address with
// bubblewrap available, invites a guest with `act` on one project, and
// runs commands as them through the same routes the browser uses.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const sandbox = require('../sandbox.js');

const root = path.join(__dirname, '..');
const bwrap = sandbox.findBwrap();
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
const post = (url, body, cookie) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = r => (r.headers.get('set-cookie') || '').split(';')[0];
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 100)); } };

// The throwaway HOME sits under the real home: the sandbox mounts the real
// home as tmpfs and binds the project back in at its true path, so the
// project must live somewhere the sandbox can name.
const TMP_ROOT = path.join(os.homedir(), '.cache', 'chattering-test-homes');

test('a guest runs commands only inside the project, and cannot reach the machine or the API as the owner', { skip: (!lanIp() && 'no LAN address') || (!bwrap && 'bubblewrap is not installed here') }, async t => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const home = fs.mkdtempSync(path.join(TMP_ROOT, 'walls-'));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(agent, 'auth.json'), '{}');
  fs.writeFileSync(path.join(agent, 'settings.json'), '{}');
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'id_test'), 'PRIVATE KEY MATERIAL');
  const open = path.join(home, 'Projects', 'open'), secret = path.join(home, 'Projects', 'secret');
  fs.mkdirSync(open, { recursive: true }); fs.mkdirSync(secret, { recursive: true });
  fs.writeFileSync(path.join(open, 'README.md'), 'open project\n');
  fs.writeFileSync(path.join(secret, 'plan.md'), 'the secret plan\n');
  const sess = (dir, id, cwd, text) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `2026-09-21T10-00-00-000Z_${id}.jsonl`, ), line({ type: 'session', version: 3, id, timestamp: '2026-09-21T10:00:00.000Z', cwd }) + line({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-09-21T10:00:01.000Z', message: { role: 'user', content: text } }) + line({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-09-21T10:00:02.000Z', message: { role: 'assistant', content: 'ok', model: 'test' } })); };
  sess(path.join(agent, 'sessions', sandbox.piSessionDirName(open)), '01a0open00000000000000000000000000', open, 'the open plan');
  sess(path.join(agent, 'sessions', sandbox.piSessionDirName(secret)), '01a0secret000000000000000000000000', secret, 'the secret plan');
  const port = await freePort(), tlsPort = await freePort();
  registerConsole(port, 'install-tok');
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(tlsPort), CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    CHATTERING_HOST: '', CHATTERING_LAN: '1', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: 'install-tok', CHATTERING_BWRAP: bwrap, CHATTERING_NO_CGROUP: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const local = 'http://127.0.0.1:' + port, remote = 'http://' + lanIp() + ':' + port;
  await until(async () => { try { return (await (await fetch(local + '/api/sessions')).json()).length === 2; } catch { return false; } }, 20000);

  // The owner invites Sam to `open` with the right to act; Sam claims it in the browser.
  const invited = await (await post(local + '/api/invites', { project: 'open', right: 'act', name: 'Sam' })).json();
  assert.ok(invited.link, JSON.stringify(invited));
  const claim = await fetch(remote + '/invite/claim', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ invite: new URL(invited.link).searchParams.get('invite'), name: 'Sam' }) });
  const sam = cookieOf(claim);
  const me = await (await fetch(remote + '/api/users', { headers: { Cookie: sam } })).json();
  assert.equal(me.me.scope, 'guest');
  assert.equal(me.walls.available, true, 'the server found bubblewrap');

  // Run-bash as Sam: inside the project it works; the secrets of the machine do not exist.
  const run = async (cmd, cwd = open) => (await (await post(remote + '/api/exec', { cmd, cwd }, sam)).json());
  const ls = await run('cat README.md && pwd');
  assert.equal(ls.code, 0, JSON.stringify(ls) + '\n' + log.slice(-2000));
  assert.match(ls.out, /open project/);
  assert.match(ls.out, new RegExp(open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the project sits at its real path inside');
  const ssh = await run('cat ~/.ssh/id_test; cat ' + path.join(secret, 'plan.md') + '; ls ~/Projects; cat ~/.pi/agent/auth.json');
  assert.doesNotMatch(ssh.out, /PRIVATE KEY MATERIAL|the secret plan/);
  assert.match(ssh.out, /No such file/);
  assert.match(ssh.out, /"anthropic"|\{\}|guest/, 'the guest sees its own pi directory, not the owner\'s');
  const write = await run('echo "by sam" > sam.txt && git init -q . && git add sam.txt && git -c commit.gpgsign=false commit -q -m "sam" && git log --format=%an%x20%ae -1');
  assert.equal(write.code, 0, write.out);
  assert.match(write.out, /Sam u_[0-9a-f]+@chattering/, 'commits carry the guest\'s identity');
  assert.equal(fs.readFileSync(path.join(open, 'sam.txt'), 'utf8').trim(), 'by sam', 'and land on the real disk');
  // A cwd outside the project is refused before anything runs.
  const outside = await post(remote + '/api/exec', { cmd: 'ls', cwd: secret }, sam);
  assert.equal(outside.status, 403);
  const nowhere = await post(remote + '/api/exec', { cmd: 'ls', cwd: home }, sam);
  assert.equal(nowhere.status, 403);

  // From inside the walls, the API answers as Sam — never as the owner.
  const who = await run(`curl -s http://127.0.0.1:${port}/api/users; echo; curl -s -H "Authorization: Bearer $CHATTERING_TOKEN" http://127.0.0.1:${port}/api/users`);
  assert.match(who.out, /sign in first/, 'no credential, no identity, even from this machine');
  assert.match(who.out, /"name":"Sam"/, 'with its own token, the guest');
  assert.doesNotMatch(who.out.split('\n').slice(1).join('\n'), /"tier":"console"/);
  const listed = await run(`curl -s -H "Authorization: Bearer $CHATTERING_TOKEN" http://127.0.0.1:${port}/api/sessions`);
  assert.doesNotMatch(listed.out, /secret plan/, 'the records tools inside the walls see only the shared project');
  assert.match(listed.out, /open plan/);

  // The desktop is out of reach: no terminal, no xdg-open.
  const term = await post(remote + '/api/conversation/act', { id: 'pi:' + sandbox.piSessionDirName(open) + '/2026-09-21T10-00-00-000Z_01a0open00000000000000000000000000.jsonl' }, sam);
  assert.equal(term.status, 403, await term.text());

  // The owner's kill switch stops what Sam runs.
  const slow = post(remote + '/api/exec', { cmd: 'sleep 30; echo done', cwd: open }, sam);
  await new Promise(r => setTimeout(r, 600));
  const stopped = await (await post(local + '/api/users/stop', { id: me.me.id })).json();
  assert.ok(stopped.stopped >= 1, JSON.stringify(stopped));
  const slowOut = await (await slow).json();
  assert.doesNotMatch(slowOut.out, /done/);

  // Attached context is gated too: a file outside the project never reaches a prompt.
  const preview = await (await post(remote + '/api/conversation/context-preview', { context: [{ type: 'file', path: path.join(secret, 'plan.md') }, { type: 'file', path: path.join(open, 'README.md') }] }, sam)).json();
  const previewText = JSON.stringify(preview);
  assert.doesNotMatch(previewText, /secret plan/);
  assert.match(previewText, /open project/);

  // The project page tells the owner what Sam did here: the commit above,
  // by the sandbox's email. Sam's own page never lists Sam.
  const did = await (await fetch(local + '/api/project/people?name=open')).json();
  const samDid = (did.people || []).find(p => p.user.name === 'Sam');
  assert.ok(samDid, JSON.stringify(did));
  assert.equal(samDid.counts.commits, 1);
  assert.equal(samDid.commits[0].subject, 'sam');
  assert.equal(samDid.user.scope, 'guest');
  const samSees = await (await fetch(remote + '/api/project/people?name=open', { headers: { Cookie: sam } })).json();
  assert.ok(!(samSees.people || []).some(p => p.user.name === 'Sam'), 'other people only');
  const denied = await fetch(remote + '/api/project/people?name=secret', { headers: { Cookie: sam } });
  assert.equal(denied.status, 403);
});
