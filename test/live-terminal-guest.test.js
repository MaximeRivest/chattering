'use strict';
// A guest continuing a conversation in an agent's own program (design/91):
// Pi, inside their walls (design/53), on the project shared with them; not
// Claude Code or Codex (they sign in as the owner); "stop their work" ends
// it. A real server with bubblewrap, a real guest from an invite link.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const sandbox = require('../sandbox.js');
const { terminalDeps } = require('../harness/terminal/deps');

const root = path.join(__dirname, '..');
const bwrap = sandbox.findBwrap();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '0.0.0.0', () => { const p = s.address().port; s.close(() => r(p)); }); });
function lanIp() { for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (!n.internal && n.family === 'IPv4' && !n.address.startsWith('172.')) return n.address; return null; }
const until = async (fn, what, ms = 15000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(100); } };
const line = o => JSON.stringify(o) + '\n';
const cookieOf = r => (r.headers.get('set-cookie') || '').split(';')[0];
// The home sits under the real home, as for guest-walls: the walls hide the
// home and bind the project back at its real path.
const TMP_ROOT = path.join(os.homedir(), '.cache', 'chattering-test-homes');
const skip = terminalDeps().error || (!lanIp() && 'no LAN address') || (!bwrap && 'bubblewrap is not installed here');

test('a guest: Pi in its own program, inside their walls; not Claude Code; stopped with their work', { skip, timeout: 120000 }, async t => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const home = fs.mkdtempSync(path.join(TMP_ROOT, 'live-guest-'));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(agent, 'auth.json'), '{}'); fs.writeFileSync(path.join(agent, 'settings.json'), '{}');
  const open = path.join(home, 'Projects', 'open'); fs.mkdirSync(open, { recursive: true });
  const id = '01a0f000-0000-7000-8000-0000000000c1';
  const dir = path.join(agent, 'sessions', sandbox.piSessionDirName(open)); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `2026-09-21T10-00-00-000Z_${id}.jsonl`), line({ type: 'session', version: 3, id, timestamp: '2026-09-21T10:00:00.000Z', cwd: open })
    + line({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-09-21T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'the open plan' }] } })
    + line({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-09-21T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], provider: 'test', model: 'test' } }));
  const cdir = path.join(home, '.claude', 'projects', open.replace(/[^a-zA-Z0-9]/g, '-')); fs.mkdirSync(cdir, { recursive: true });
  const cid = '11111111-2222-4333-8444-5555555555c1';
  fs.writeFileSync(path.join(cdir, cid + '.jsonl'), line({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: cid, cwd: open, timestamp: '2026-09-21T10:00:00Z', message: { role: 'user', content: 'claude plan' } }));
  require('./helpers/first-run').answerFirstRun(home);
  const port = await freePort();
  registerConsole(port, 'install-tok');
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    CHATTERING_HOST: '', CHATTERING_LAN: '1', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: 'install-tok', CHATTERING_BWRAP: bwrap, CHATTERING_NO_CGROUP: '1',
    CHATTERING_PI_CLI: path.join(__dirname, 'fixtures', 'fake-pi-live.js'), FAKE_AGENT_DELAY: '200', CHATTERING_PREVIEW_PORT: '0', CHATTERING_PREVIEW_TLS_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const local = 'http://127.0.0.1:' + port, remote = 'http://' + lanIp() + ':' + port;
  await until(async () => { try { return (await (await fetch(local + '/api/sessions')).json()).length === 2; } catch { return false; } }, 'the server', 30000).catch(e => { throw new Error(e.message + '\n' + log.slice(-2000)); });
  const post = (url, body, cookie) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const invited = await (await post(local + '/api/invites', { project: 'open', right: 'act', name: 'Sam' })).json();
  const sam = cookieOf(await fetch(remote + '/invite/claim', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ invite: new URL(invited.link).searchParams.get('invite'), name: 'Sam' }) }));
  const keys = (await (await fetch(remote + '/api/sessions', { headers: { Cookie: sam } })).json()).map(s => s.key);
  const piKey = keys.find(k => k.startsWith('pi:')), claudeKey = keys.find(k => k.startsWith('claude:'));
  assert.ok(piKey && claudeKey, JSON.stringify(keys));

  // What Sam is offered: Pi, not Claude Code (with the reason).
  const st = await (await fetch(remote + '/api/live-terminal/status', { headers: { Cookie: sam } })).json();
  assert.equal(st.refusals.pi, null);
  assert.match(st.refusals.claude, /signs in as this computer's owner/);
  assert.equal(st.args, undefined, 'the owner\'s options are not shown to a guest');
  const claudePage = await (await fetch(remote + '/api/session?id=' + encodeURIComponent(claudeKey), { headers: { Cookie: sam } })).json();
  assert.deepEqual([claudePage.liveTerminal.use, claudePage.liveTerminal.offer], [false, false]);
  const refused = await post(remote + '/api/live-terminal/start', { id: claudeKey }, sam);
  assert.equal(refused.status, 403); assert.match((await refused.json()).error, /signs in as this computer's owner/);
  assert.equal((await post(remote + '/api/live-terminal/settings', { record: false }, sam)).status, 403);

  // Pi: started inside their walls.
  const started = await post(remote + '/api/live-terminal/start', { id: piKey }, sam);
  assert.equal(started.status, 200, JSON.stringify(await started.clone().json()) + log.slice(-1500));
  const walled = await until(() => require('../processes.js').list().find(p => p.argv.some(a => /bwrap/.test(a)) && p.argv.some(a => a.endsWith('fake-pi-live.js'))), 'Pi inside bubblewrap')
    .catch(async e => { const ps = require('../processes.js').list().filter(p => p.argv.some(a => /fake-pi-live|bwrap/.test(a))).map(p => p.argv.join(' ').slice(0, 300)); const recs = []; const walk = d => { try { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, f.name); if (f.isDirectory()) walk(q); else if (f.name.endsWith('.cast.gz')) recs.push(q); } } catch {} }; walk(home);
      const shown = recs.map(f => require('../harness/terminal/recorder').readRecording(f).events.filter(x => x[1] === 'o').map(x => x[2]).join('')).join('\n---\n');
      throw new Error(e.message + '\nPRINTED: ' + JSON.stringify(shown.slice(0, 1500)) + '\n' + ps.join('\n') + '\n' + log.slice(-500) + '\n' + JSON.stringify(await (await fetch(local + '/api/live-terminal/status?id=' + encodeURIComponent(piKey))).json())); });
  assert.ok(walled.argv.includes('--tmpfs') && walled.argv.includes(home), 'the home hidden: ' + walled.argv.join(' ').slice(0, 300));
  // Sam types and sends through the socket; the reply is in Pi's file.
  const ws = new WebSocket(remote.replace('http', 'ws') + '/api/live-terminal/ws?id=' + encodeURIComponent(piKey), { headers: { Cookie: sam } });
  const state = {}, answers = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.t === 'patch') Object.assign(state, m.set); else if (answers.has(m.seq)) answers.get(m.seq)(m); };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.send(JSON.stringify({ t: 'hello', clientId: 'sam-device-0001', name: 'Sam' }));
  await until(() => state.composer && state.mode === 'compose', 'Pi\'s box');
  const ans = await new Promise(r => { answers.set(1, r); ws.send(JSON.stringify({ t: 'submit', text: 'from the guest', seq: 1 })); });
  assert.equal(ans.t, 'done', JSON.stringify(ans));
  const file = fs.readdirSync(dir).map(f => path.join(dir, f)).find(f => f.includes(id));
  await until(() => /Done: from the guest/.test(fs.readFileSync(file, 'utf8')), 'the reply written in the project\'s session folder');
  ws.close();

  // "Stop their work": the program ends.
  const people = await (await fetch(local + '/api/users')).json();
  const samUser = people.users.find(u => u.name === 'Sam');
  const stopped = await (await post(local + '/api/users/stop', { id: samUser.id })).json();
  assert.ok(stopped.stopped >= 1, JSON.stringify(stopped));
  await until(async () => !(await (await fetch(local + '/api/live-terminal/status?id=' + encodeURIComponent(piKey))).json()).running, 'ended with their work', 15000).catch(e => { throw new Error(e.message + ' ' + JSON.stringify(stopped)); });
});
