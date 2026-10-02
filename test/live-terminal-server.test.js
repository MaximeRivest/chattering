'use strict';
// Conversations continued in their agent's own program, end to end, with
// no model call: a real server and terminal holder, and a stand-in that
// draws and writes like Claude Code, Pi and Codex
// (fixtures/fake-terminal-agent.js). For each agent: continue an existing
// conversation, type and send through the program's own box, every message
// once in Chattering's view, one writer (Chattering's own runs refuse while
// the program holds the conversation), back to Chattering's box, a message
// after the program ended starts it again; a new conversation of each from
// the draft's route; the program outlives a restart of the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { terminalDeps } = require('../harness/terminal/deps');
const fx = require('./helpers/codex-fixtures');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-terminal-agent.js');
const skip = terminalDeps().error || (process.platform === 'win32' ? 'a Unix pseudoterminal' : false);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOKEN = 'live-terminal-test-token', AUTH = { Authorization: 'Bearer ' + TOKEN };
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const trace = process.env.LT_TRACE ? m => process.stderr.write(`[${new Date().toISOString().slice(17, 23)}] ${m}\n`) : () => {};
async function until(fn, what, ms = 15000) {
  trace('waiting: ' + what); const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out: ' + what); await sleep(60); } }

function setup() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-terminal-')));
  // A project folder (Projects/zoo): guests are invited to projects.
  const work = path.join(home, 'Projects', 'zoo'); fs.mkdirSync(work, { recursive: true });
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  for (const style of ['claude', 'codex']) {
    fs.writeFileSync(path.join(bin, style), `#!/bin/sh\nFAKE_AGENT_STYLE=${style} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o755 });
  }
  // Pi's stand-in: the interactive program; asked for its models (as
  // Chattering does), it has none and says so at once.
  fs.writeFileSync(path.join(bin, 'pi.js'), `if (process.argv.includes('--list-models')) process.exit(0);\nprocess.env.FAKE_AGENT_STYLE = 'pi'; require(${JSON.stringify(FAKE)});\n`);
  // One existing conversation of each agent, in the same folder.
  const claudeDir = path.join(home, '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(claudeDir, { recursive: true });
  const cid = '11111111-2222-4333-8444-555555555555';
  fs.writeFileSync(path.join(claudeDir, cid + '.jsonl'), [
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: cid, cwd: work, timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'Explain the kestrel parser' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: cid, cwd: work, timestamp: '2026-09-01T10:00:05Z', message: { role: 'assistant', model: 'claude-fixture', content: [{ type: 'text', text: 'It reads kestrels.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const agent = path.join(home, '.pi', 'agent');
  const piDir = path.join(agent, 'sessions', require('../runtime.js').piSessionDirName(work)); fs.mkdirSync(piDir, { recursive: true });
  const pid = '01a0f000-0000-7000-8000-0000000000b1';
  fs.writeFileSync(path.join(piDir, '2026-09-01T10-00-00-000Z_' + pid + '.jsonl'), [
    { type: 'session', version: 3, id: pid, timestamp: '2026-09-01T10:00:00.000Z', cwd: work },
    { type: 'message', id: 'm1', parentId: null, timestamp: '2026-09-01T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Count the owls' }] } },
    { type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-09-01T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Three owls.' }], provider: 'test', model: 'test' } },
  ].map(JSON.stringify).join('\n') + '\n');
  fx.writeCodexHome(home, work);
  require('./helpers/first-run').answerFirstRun(home);
  return { home, work, bin, agent };
}

async function boot(t, s, { port, lan = false } = {}) {
  port = port || await freePort();
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ...require('./helpers/home-env').homeEnv(s.home),
    PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_HOST: lan ? '' : '127.0.0.1', CHATTERING_LAN: lan ? '1' : '', CHATTERING_PUBLIC_URL: '', CHATTERING_NO_WATCH: '1', CHATTERING_NO_SYNC: '1', CHATTERING_NO_LEDGER: '1',
    CHATTERING_CACHE_DIR: path.join(s.home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(s.home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(s.home, 'delegations'),
    PI_CODING_AGENT_DIR: s.agent, PI_AGENT_DIR: s.agent, CODEX_HOME: path.join(s.home, '.codex'), CHATTERING_NO_CGROUP: '1',
    CHATTERING_CLAUDE: path.join(s.bin, 'claude'), CHATTERING_CODEX: path.join(s.bin, 'codex'), CHATTERING_PI_CLI: path.join(s.bin, 'pi.js'),
    FAKE_AGENT_DELAY: '300', FAKE_AGENT_LOG: path.join(s.home, 'agent-log.jsonl'), CHATTERING_DISABLE_NETWORK_RECOVERY: '1', CHATTERING_TOKEN: TOKEN, CHATTERING_PREVIEW_PORT: '0', CHATTERING_PREVIEW_TLS_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => { log += b; if (process.env.LT_DEBUG) process.stderr.write(b); });
  t.after(() => require('./helpers/cleanup').stopAndRemove(child, s.home));
  const base = 'http://127.0.0.1:' + port;
  await until(async () => { try { return (await (await fetch(base + '/api/sessions', { headers: AUTH })).json()).length >= 3; } catch { return false; } }, 'the server and its index', 30000)
    .catch(e => { throw new Error(e.message + '\n' + log.slice(-3000)); });
  return { child, base, port, log: () => log };
}

const api = (base, p, body) => (trace((body === undefined ? 'GET ' : 'POST ') + p), fetch(base + p, body === undefined ? { headers: AUTH } : { method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() })));

// A page's connection to a conversation's program.
async function device(base, key, name = 'test') {
  const ws = new WebSocket(base.replace('http', 'ws') + '/api/live-terminal/ws?id=' + encodeURIComponent(key), { headers: AUTH });
  const state = {}, answers = new Map(); let seq = 0;
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.t === 'patch') Object.assign(state, m.set); else if (answers.has(m.seq)) { answers.get(m.seq)(m); answers.delete(m.seq); } };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.send(JSON.stringify({ t: 'hello', clientId: name + '-' + Math.random().toString(16).slice(2, 10), name }));
  const ask = m => new Promise(r => { trace('ask ' + JSON.stringify(m)); const n = ++seq; answers.set(n, r); ws.send(JSON.stringify({ ...m, seq: n })); });
  // Keys and text are confirmed by the screen, not answered.
  const send = m => { trace('send ' + JSON.stringify(m)); ws.send(JSON.stringify({ ...m, seq: ++seq })); };
  return { ws, state, ask, send, until: (fn, what, ms) => until(() => fn(state), what, ms), close: () => ws.close() };
}

const keyOf = async (base, source) => (await api(base, '/api/sessions')).body.find(s => s.key.startsWith(source + ':') && !/fork|early|legacy/.test(s.key) && (source !== 'codex' || s.title !== 'imported')).key;
const textOf = async (base, key) => { await api(base, '/api/rescan', {}); const r = await api(base, '/api/session?id=' + encodeURIComponent(key)); return r.body.messages ? r.body.messages.map(m => m.text || '').join('\n') : ''; };

test('continue, type, send, one writer, back to Chattering\'s box, restart on the next message: Claude Code, Pi, Codex', { skip, timeout: 180000 }, async t => {
  const s = setup();
  const srv = await boot(t, s);
  const sessions = (await api(srv.base, '/api/sessions')).body;
  for (const source of ['claude', 'pi', 'codex']) {
    const key = sessions.find(x => x.key.startsWith(source + ':') && (source !== 'codex' || /parrot|owl/i.test(JSON.stringify(x)))).key;
    let page = (await api(srv.base, '/api/session?id=' + encodeURIComponent(key))).body;
    assert.ok(page.liveTerminal, source + ': the page knows about its program');
    if (source === 'claude') assert.equal(page.liveTerminal.use, true, 'Claude Code: its program by default');
    else assert.deepEqual([page.liveTerminal.use, page.liveTerminal.offer], [false, true], source + ': offered, Chattering\'s box by default');

    const started = await api(srv.base, '/api/live-terminal/start', { id: key });
    assert.equal(started.status, 200, source + ': ' + JSON.stringify(started.body) + srv.log().slice(-2000));
    const d = await device(srv.base, key);
    await d.until(st => st.composer && st.mode === 'compose', source + ': its box');
    // Chattering's own replies refuse while the program holds the conversation.
    if (source !== 'claude') {
      const web = await api(srv.base, '/api/node/send', { id: key, prompt: 'from the web box' });
      assert.equal(web.status, 409, source + ': one writer — ' + JSON.stringify(web.body));
    }
    d.send({ t: 'text', text: 'hel' });
    await d.until(st => st.composer.text === 'hel', source + ': typed into its own editor');
    const a = await d.ask({ t: 'submit', text: 'continue the ' + source + ' story' });
    assert.equal(a.t, 'done', JSON.stringify(a));
    await until(async () => /Done: continue the/.test(await textOf(srv.base, key)), source + ': the reply in Chattering\'s view');
    const text = await textOf(srv.base, key);
    assert.equal(text.split('Done: continue the ' + source + ' story').length - 1, 1, source + ': the reply once');
    page = (await api(srv.base, '/api/session?id=' + encodeURIComponent(key))).body;
    assert.equal(page.liveTerminal.running, true);
    d.close();

    // Back to Chattering's box (Pi, Codex): the program ends first.
    if (source !== 'claude') {
      const back = await api(srv.base, '/api/live-terminal/stop', { id: key, back: true });
      assert.equal(back.body.ok, true);
      assert.deepEqual([back.body.live.use, back.body.live.offer, back.body.live.running], [false, true, false]);
    } else await api(srv.base, '/api/live-terminal/stop', { id: key });
    // A message after it ended: it starts again from the file.
    const again = await api(srv.base, '/api/live-terminal/send', { id: key, text: 'and once more' });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    await until(async () => /Done: and once more/.test(await textOf(srv.base, key)), source + ': restarted and answered');
    await api(srv.base, '/api/live-terminal/stop', { id: key, back: true });
  }
});

test('a new conversation of each agent, from the draft\'s route', { skip, timeout: 120000 }, async t => {
  const s = setup();
  const srv = await boot(t, s);
  // The owner's options reach the program, for that run (settings → agents).
  await api(srv.base, '/api/live-terminal/settings', { args: { claude: ['--permission-mode', 'default'] } });
  // Pi and Codex start in their program when chosen ("choose"); turned off, never.
  for (const harness of ['claude', 'pi', 'codex']) {
    const out = await api(srv.base, '/api/live-terminal/new', { harness, folder: s.work });
    assert.equal(out.status, 200, harness + ': ' + JSON.stringify(out.body));
    assert.match(out.body.key, /^live:/);
    const d = await device(srv.base, out.body.key, 'laptop');
    await d.until(st => st.composer && st.mode === 'compose', harness + ': its box');
    const a = await d.ask({ t: 'submit', text: 'a new ' + harness + ' conversation' });
    assert.equal(a.t, 'done', JSON.stringify(a));
    const st = await until(async () => { const x = (await api(srv.base, '/api/live-terminal/status?id=' + encodeURIComponent(out.body.key))).body; return x.resolvedKey && x.indexed && x; }, harness + ': its file found');
    assert.ok(st.resolvedKey.startsWith(harness + ':'), st.resolvedKey);
    await until(async () => /Done: a new/.test(await textOf(srv.base, st.resolvedKey)), harness + ': the first reply in its view');
    // The same program under the conversation's own key now.
    assert.equal((await api(srv.base, '/api/live-terminal/status?id=' + encodeURIComponent(st.resolvedKey))).body.running, true);
    d.close();
    await api(srv.base, '/api/live-terminal/stop', { id: st.resolvedKey });
  }
  const started = fs.readFileSync(path.join(s.home, 'agent-log.jsonl'), 'utf8').split('\n').filter(l => l.startsWith('{"argv"')).map(l => JSON.parse(l).argv);
  assert.ok(started.some(a => a.includes('--session-id') && a.slice(-2).join(' ') === '--permission-mode default'), JSON.stringify(started));
  // Turned off in settings: refused.
  await api(srv.base, '/api/live-terminal/settings', { agents: { codex: 'off' } });
  assert.equal((await api(srv.base, '/api/live-terminal/new', { harness: 'codex', folder: s.work })).status, 409);
});

test('a program outlives a restart of the server: same screen, same box, the reply arrives', { skip, timeout: 120000 }, async t => {
  const s = setup();
  let srv = await boot(t, s);
  const key = await keyOf(srv.base, 'claude');
  assert.equal((await api(srv.base, '/api/live-terminal/start', { id: key })).status, 200);
  let d = await device(srv.base, key);
  await d.until(st => st.composer && st.mode === 'compose', 'its box');
  d.send({ t: 'text', text: 'half a thought' });
  await d.until(st => st.composer.text === 'half a thought', 'typed');
  d.close();
  // The server stops (as on an update) and starts again.
  srv.child.kill('SIGTERM');
  await new Promise(r => srv.child.once('exit', r));
  srv = await boot(t, s, { port: srv.port });
  const st = await until(async () => { const x = (await api(srv.base, '/api/live-terminal/status?id=' + encodeURIComponent(key))).body; return x.running && x; }, 'attached again');
  assert.equal(st.recovered, true);
  d = await device(srv.base, key);
  await d.until(x => x.composer && x.composer.text === 'half a thought', 'the same box, with what was typed');
  // And one writer still holds: Chattering's own run refuses.
  const a = await d.ask({ t: 'submit', text: 'half a thought, finished' });
  assert.equal(a.t, 'done', JSON.stringify(a));
  await until(async () => /Done: half a thought, finished/.test(await textOf(srv.base, key)), 'the reply after the restart');
  d.close();
  await api(srv.base, '/api/live-terminal/stop', { id: key });
});

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (!n.internal && n.family === 'IPv4' && !n.address.startsWith('172.')) return n.address;
  return null;
}
// Who may continue a conversation in its agent's program (design/91 and the
// audit's F19): it runs as this machine's account, with its sign-in to the
// agent. The owner and the household's members (who already run agents as
// the account) may; a member walled by per-person isolation and a guest may
// not, on the routes or the socket.
test('who may: the owner and a household member; not a walled member, not a guest', { skip: skip || (!lanIp() && 'no LAN address'), timeout: 120000 }, async t => {
  const s = setup();
  const srv = await boot(t, s, { lan: true });
  const remote = 'http://' + lanIp() + ':' + srv.port;
  const cookieOf = r => (r.headers.get('set-cookie') || '').split(';')[0];
  const as = (cookie, p, body) => (trace('as ' + p), fetch(remote + p, body === undefined ? { headers: { Cookie: cookie } } : { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) }));
  const socket = cookie => new Promise(resolve => { trace('socket');
    const ws = new WebSocket(remote.replace('http', 'ws') + '/api/live-terminal/ws?id=' + encodeURIComponent(key), { headers: { Cookie: cookie } });
    ws.onopen = () => { ws.close(); resolve('open'); }; ws.onerror = () => resolve('refused');
  });
  const key = await keyOf(srv.base, 'claude');
  // The owner (signed in from the network with the install token).
  const owner = cookieOf(await fetch(remote + '/?token=' + TOKEN, { redirect: 'manual' }));
  assert.equal((await as(owner, '/api/live-terminal/start', { id: key })).status, 200);
  assert.equal(await socket(owner), 'open');
  // A household member.
  const added = await (await as(owner, '/api/users/add', { name: 'Lilly' })).json();
  const lilly = cookieOf(await fetch(remote + '/?token=' + encodeURIComponent(new URL(added.inviteLink).searchParams.get('token')), { redirect: 'manual' }));
  const st = await (await as(lilly, '/api/live-terminal/status')).json();
  assert.deepEqual(st.refusals, { claude: null, pi: null, codex: null }, 'a household member may, every agent');
  assert.equal(await socket(lilly), 'open');
  assert.equal((await (await as(lilly, '/api/session?id=' + encodeURIComponent(key))).json()).liveTerminal.use, true);
  // A guest, invited to the project.
  const project = (await api(srv.base, '/api/sessions')).body.find(x => x.key === key).project;
  const invited = await (await as(owner, '/api/invites', { project, right: 'act', name: 'Sam' })).json();
  assert.ok(invited.link, JSON.stringify(invited));
  const sam = cookieOf(await fetch(remote + '/invite/claim', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ invite: new URL(invited.link).searchParams.get('invite'), name: 'Sam' }) }));
  for (const p of ['/api/live-terminal/start', '/api/live-terminal/send', '/api/live-terminal/new', '/api/live-terminal/stop']) {
    const r = await as(sam, p, { id: key, text: 'hi', harness: 'claude', folder: s.work });
    assert.equal(r.status, 403, 'a guest: ' + p);
  }
  assert.equal(await socket(sam), 'refused', 'a guest: the socket');
  const samPage = await (await as(sam, '/api/session?id=' + encodeURIComponent(key))).json();
  assert.ok(!samPage.liveTerminal || (!samPage.liveTerminal.use && !samPage.liveTerminal.offer), 'a guest is not offered it');
  // Per-person walls: the member is walled too.
  trace('get settings');
  const cur = (await (await fetch(srv.base + '/api/settings', { headers: AUTH })).json()).settings;
  trace('put settings');
  assert.equal((await fetch(srv.base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...AUTH }, body: JSON.stringify({ ...cur, isolation: 'per-person' }) })).status, 200);
  assert.equal((await as(lilly, '/api/live-terminal/start', { id: key })).status, 403, 'a walled member: not Claude Code');
  const walledSt = await (await as(lilly, '/api/live-terminal/status')).json();
  assert.match(walledSt.refusals.claude, /signs in as this computer's owner/);
  assert.match(walledSt.refusals.codex, /signs in as this computer's owner/);
  assert.equal(await socket(lilly), 'refused', 'a walled member: the socket');
  // Settings are the owner's.
  assert.equal((await as(lilly, '/api/live-terminal/settings', { record: false })).status, 403);
  await api(srv.base, '/api/live-terminal/stop', { id: key });
});

test('switched off for every agent: no strip, nothing offered, nothing starts', { skip, timeout: 60000 }, async t => {
  const s = setup();
  const srv = await boot(t, s);
  const off = await api(srv.base, '/api/live-terminal/settings', { agents: { claude: 'off', pi: 'off', codex: 'off' } });
  assert.deepEqual(off.body.agents, { claude: 'off', pi: 'off', codex: 'off' });
  for (const source of ['claude', 'pi', 'codex']) {
    const key = await keyOf(srv.base, source);
    const page = (await api(srv.base, '/api/session?id=' + encodeURIComponent(key))).body;
    assert.deepEqual([page.liveTerminal.use, page.liveTerminal.offer], [false, false], source);
    assert.equal((await api(srv.base, '/api/live-terminal/start', { id: key })).status, 409, source);
    assert.equal((await api(srv.base, '/api/live-terminal/send', { id: key, text: 'x' })).status, 404, source);
  }
  // Kept across a restart of the settings file's reader.
  assert.equal((await api(srv.base, '/api/live-terminal/status')).body.agents.claude, 'off');
});
