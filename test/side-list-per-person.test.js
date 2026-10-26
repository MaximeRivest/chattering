'use strict';
// The side list is each person's own (2026-10-26). Two people on one
// install: the household's old shared list is split by who typed in each
// conversation, and from then on what one opens, closes, pins or groups
// never shows in the other's list, on any of their devices.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const { homeEnv, appDir } = require('./helpers/home-env.js');
const agentread = require('../agentread.js');

const root = path.join(__dirname, '..');
const line = o => JSON.stringify(o) + '\n';
async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r));
  return port;
}
// A conversation; `by` names who typed in it (an author entry), or nobody.
function conversation(sessions, id, by) {
  const dir = path.join(sessions, '--work--');
  fs.mkdirSync(dir, { recursive: true });
  const author = by ? line({ type: 'custom', customType: 'chattering-author', id: 'a1', parentId: null, timestamp: '2026-10-20T10:00:00.500Z', data: { v: 1, user: { id: by, name: by }, input: 'keyboard' } }) : '';
  fs.writeFileSync(path.join(dir, `2026-10-20T10-00-00-000Z_${id}.jsonl`), line({ type: 'session', version: 3, id, timestamp: '2026-10-20T10:00:00.000Z', cwd: '/work' }) + author
    + line({ type: 'message', id: 'm1', parentId: by ? 'a1' : null, timestamp: '2026-10-20T10:00:01.000Z', message: { role: 'user', content: 'hello ' + id } })
    + line({ type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-10-20T10:00:02.000Z', message: { role: 'assistant', content: 'ok', model: 'test' } }));
  return 'pi:--work--/2026-10-20T10-00-00-000Z_' + id + '.jsonl';
}

test('split: each person keeps the conversations they typed in; nobody\u2019s go to the owner; reads stay for all', () => {
  const s = agentread.createState(1000);
  Object.assign(s, { opened: { a: 2000, b: 2000, c: 2000, d: 2000 }, pinned: { b: 1 }, dismissed: { d: 3000 }, read: { a: 2500, b: 2500 },
    groups: { gR: { name: 'recorn', order: 0, folded: false }, gX: { name: 'x', order: 1, folded: false } }, member: { b: 'gR', a: 'gX' } });
  const out = agentread.splitByPerson(s, { people: ['max', 'lil'], fallback: 'max', personsOf: k => ({ a: ['max'], b: ['lil'], c: ['max', 'lil'] }[k] || []) });
  assert.deepEqual(Object.keys(out.max.opened).sort(), ['a', 'c', 'd']);
  assert.deepEqual(Object.keys(out.lil.opened).sort(), ['b', 'c']);
  assert.deepEqual(out.lil.pinned, { b: 1 });
  assert.deepEqual(Object.values(out.lil.groups).map(g => g.name), ['recorn']);
  assert.deepEqual(Object.values(out.max.groups).map(g => g.name), ['x']);
  assert.deepEqual(out.lil.read, s.read, 'what was read stays read, for everyone');
  assert.equal(out.max.dismissed.d, 3000, 'a closed one stays closed, and restorable, in its owner\u2019s list');
});

test('two people, two lists (conversations, open files, recent files), on a real server; the old shared lists split on first start', { timeout: 120000 }, async t => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'side-list-')));
  const agent = path.join(home, '.pi', 'agent'), sessions = path.join(agent, 'sessions');
  const keys = { max: conversation(sessions, '01a0max0000000000000000000000000000', 'u_max'), lil: conversation(sessions, '01a0lil0000000000000000000000000000', 'u_lil'),
    nobody: conversation(sessions, '01a0nob0000000000000000000000000000', null), fresh: conversation(sessions, '01a0new0000000000000000000000000000', 'u_max') };
  // The roster, with a link for Lilly, and the household's old list.
  const lilSecret = 'lilly-secret-for-the-test';
  const config = appDir(home, 'config'), notes = path.join(home, 'notes', 'chattering');
  fs.mkdirSync(config, { recursive: true }); fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(config, 'users.json'), JSON.stringify({ v: 1, users: [
    { id: 'u_max', name: 'Max', role: 'owner', credentials: [] },
    { id: 'u_lil', name: 'Lilly', role: 'member', credentials: [{ id: 'c1', kind: 'invite', hash: crypto.createHash('sha256').update(lilSecret).digest('hex') }] }] }));
  const old = agentread.createState(Date.parse('2026-10-01'));
  Object.assign(old, { opened: { [keys.max]: Date.now(), [keys.lil]: Date.now(), [keys.nobody]: Date.now() }, groups: { gRecorn: { name: 'recorn', order: 0, folded: false } }, member: { [keys.lil]: 'gRecorn' } });
  fs.writeFileSync(path.join(notes, 'agent-read.json'), JSON.stringify(old));
  // The household's old recent files: one person's open (who, not recorded)
  // and what agents touched in each one's conversation.
  const at = Date.now() - 60000;
  fs.writeFileSync(path.join(notes, 'recent-files.json'), JSON.stringify({ version: 2, dismissed: {}, files: [
    { path: '/work/someone-opened.md', actor: 'human', at, project: '', kind: 'opened' },
    { path: '/work/max-agent.py', actor: 'agent', at, project: '', kind: 'edited', key: keys.max },
    { path: '/work/lil-agent.py', actor: 'agent', at, project: '', kind: 'edited', key: keys.lil }] }));

  // Interrupted runs: Lilly's (who asked is known), and an older record of
  // nobody's of a conversation only Max typed in.
  fs.mkdirSync(path.join(home, 'cache'), { recursive: true });
  const rec = (id, key, user) => ({ id, key, user, title: id, model: null, reason: 'Claude Code request failed (400)', version: 'v', kind: 'error', eligible: false, auto: false, attempts: 0, state: 'pending', createdAt: Date.now(), nextCheckAt: Date.now() + 1e9, goodChecks: 0 });
  fs.writeFileSync(path.join(home, 'cache', 'agent-interruptions.json'), JSON.stringify([rec('run:lil', keys.lil, 'u_lil'), rec('run:old', keys.max, null)]));
  const port = await freePort(), tlsPort = await freePort();
  registerConsole(port, 'install-tok');
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(tlsPort), CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    CHATTERING_HOST: '', CHATTERING_LAN: '', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: 'install-tok' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 300; i++) { try { const r = await fetch(base + '/api/sessions'); if (r.ok && (await r.json()).length === 4) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
  const lilly = { Authorization: 'Bearer ' + lilSecret };
  const listOf = async headers => (await (await fetch(base + '/api/agent-read', { headers: headers || {} })).json());
  const listed = s => Object.keys(s.opened).filter(k => agentread.isListed(s, k, 0)).sort();
  const post = (body, headers) => fetch(base + '/api/agent-read', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) });

  const max0 = await listOf(), lil0 = await listOf(lilly);
  assert.deepEqual(listed(max0), [keys.max, keys.nobody].sort(), 'the owner keeps his and the ones nobody typed in\n' + log.slice(-1500));
  assert.deepEqual(listed(lil0), [keys.lil], 'Lilly keeps hers');
  assert.deepEqual(Object.values(lil0.groups).map(g => g.name), ['recorn']);
  assert.deepEqual(Object.keys(max0.groups), [], 'her group is not his');
  assert.ok(fs.existsSync(path.join(notes, 'agent-read.shared-until-2026-10-26.json')), 'the old list is kept beside');
  assert.ok(!fs.existsSync(path.join(notes, 'agent-read.json')));

  // From now on: what Lilly opens, pins and groups is hers alone.
  assert.ok((await post({ open: [keys.fresh], pin: { [keys.fresh]: true } }, lilly)).ok);
  assert.ok((await post({ grouping: { groups: { gMine: { name: 'mine', order: 1 } }, member: { [keys.fresh]: 'gMine' } } }, lilly)).ok);
  const lil1 = await listOf(lilly), max1 = await listOf();
  assert.ok(listed(lil1).includes(keys.fresh) && lil1.pinned[keys.fresh]);
  assert.ok(!listed(max1).includes(keys.fresh) && !max1.pinned[keys.fresh], 'her open is not in his list');
  assert.ok(!Object.values(max1.groups).some(g => g.name === 'mine'));
  // He closes his; hers is untouched.
  assert.ok((await post({ dismiss: [keys.nobody] })).ok);
  assert.ok(!listed(await listOf()).includes(keys.nobody));
  // Open files: what Lilly keeps open is hers.
  const files = async (route, headers) => (await (await fetch(base + route, { headers: headers || {} })).json()).files.map(f => f.path).sort();
  const keepRes = await fetch(base + '/api/open-files', { method: 'POST', headers: { 'Content-Type': 'application/json', ...lilly }, body: JSON.stringify({ keep: [{ path: '/work/lillys-notes.md' }] }) });
  assert.ok(keepRes.ok, await keepRes.text());
  assert.deepEqual(await files('/api/open-files', lilly), ['/work/lillys-notes.md']);
  assert.deepEqual(await files('/api/open-files'), [], 'not in his');
  // Recent files: what she opens is hers; the agents' follow whose conversation it was.
  assert.ok((await fetch(base + '/api/recent-files', { method: 'POST', headers: { 'Content-Type': 'application/json', ...lilly }, body: JSON.stringify({ path: '/work/she-opened.md' }) })).ok);
  const hers = await files('/api/recent-files', lilly), his = await files('/api/recent-files');
  assert.ok(hers.includes('/work/she-opened.md') && hers.includes('/work/lil-agent.py'), JSON.stringify(hers));
  assert.ok(!hers.includes('/work/someone-opened.md') && !hers.includes('/work/max-agent.py'), JSON.stringify(hers));
  assert.ok(his.includes('/work/someone-opened.md') && his.includes('/work/max-agent.py'), 'old opens of nobody known are the owner\u2019s: ' + JSON.stringify(his));
  assert.ok(!his.includes('/work/she-opened.md') && !his.includes('/work/lil-agent.py'), JSON.stringify(his));
  // Hiding an agents' entry hides it for her alone.
  assert.ok((await fetch(base + '/api/recent-files', { method: 'POST', headers: { 'Content-Type': 'application/json', ...lilly }, body: JSON.stringify({ remove: '/work/lil-agent.py', actor: 'agent' }) })).ok);
  assert.ok(!(await files('/api/recent-files', lilly)).includes('/work/lil-agent.py'));
  // Interrupted runs ("needs attention" rows) are each person's own.
  const interrupted = async headers => (await (await fetch(base + '/api/agents/recovery', { headers: headers || {} })).json()).interrupted.map(r => r.id).sort();
  assert.deepEqual(await interrupted(lilly), ['run:lil']);
  assert.deepEqual(await interrupted(), ['run:old'], 'her stopped run is not in his list (2026-10-26)');
  const notHers = await fetch(base + '/api/agents/recovery', { method: 'POST', headers: { 'Content-Type': 'application/json', ...lilly }, body: JSON.stringify({ id: 'run:old', action: 'dismiss' }) });
  assert.equal(notHers.status, 403, 'nor can she dismiss his');
  // He opens her conversation to look, then closes it: it stays closed when she replies.
  assert.ok((await post({ open: [keys.lil] })).ok);
  assert.ok((await post({ dismiss: [keys.lil] })).ok);
  const after = await listOf();
  assert.ok(!agentread.isListed(after, keys.lil, Date.now() + 365 * 86400000), 'closed for good: a later reply does not bring hers back');
  assert.ok((await post({ dismiss: [keys.max] })).ok);
  assert.ok(agentread.isListed(await listOf(), keys.max, Date.now() + 60000), 'his own comes back with a reply, as before');
  // Each list is saved in its own file, and survives a restart of the reader.
  for (let i = 0; i < 40 && !fs.existsSync(path.join(notes, 'agent-read', 'u_lil.json')); i++) await new Promise(r => setTimeout(r, 100));
  await new Promise(r => setTimeout(r, 1300));
  const onDisk = JSON.parse(fs.readFileSync(path.join(notes, 'agent-read', 'u_lil.json'), 'utf8'));
  assert.ok(onDisk.opened[keys.fresh]);
});
