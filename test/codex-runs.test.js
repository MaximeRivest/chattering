'use strict';
// Running Codex from Chattering, end to end through the real server and a
// stand-in `codex app-server` (test/fixtures/fake-codex.js): menus, a new
// conversation from a draft, follow-ups, approvals answered from the run
// card, access levels, compaction, the composer, a conversation another
// Codex holds, and letting go of the lock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch');
const fx = require('./helpers/codex-fixtures');

async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r)); return port;
}
async function until(fn, label, ms = 15000) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await new Promise(r => setTimeout(r, 50)); }
  assert.fail('Timed out: ' + label + ' · last: ' + JSON.stringify(last).slice(0, 400));
}

async function boot(t, extraEnv = {}) {
  const root = path.join(__dirname, '..');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-')));
  const work = path.join(home, 'work'); fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'notes about owls.md'), 'owls\n'); fs.mkdirSync(path.join(work, 'nests'));
  const files = fx.writeCodexHome(home, work);
  const agent = path.join(home, '.pi', 'agent'); fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  require('./helpers/first-run').answerFirstRun(home);
  const port = await freePort(), token = 'codex-runs-token';
  registerConsole(port, token);
  const requests = path.join(home, 'codex-requests.jsonl');
  let log = '';
  const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env').homeEnv(home),
    PORT: String(port), CHATTERING_TOKEN: token, CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '0',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, CODEX_HOME: path.join(home, '.codex'),
    CHATTERING_CODEX: path.join(__dirname, 'fixtures', 'fake-codex.js'), FAKE_CODEX_LOG: requests, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  t.after(async () => { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); fs.rmSync(home, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + port;
  const existing = 'codex:2026/09/20/rollout-2026-09-20T10-00-00-01a0f000-0000-7000-8000-000000000001.jsonl';
  await until(async () => (await (await fetch(base + '/api/sessions')).json()).some(r => r.key === existing), 'index ready\n' + log);
  const api = async (method, route, body) => {
    const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const job = async id => (await (await fetch(base + '/api/jobs')).json()).find(j => j.id === id);
  const sent = () => fs.existsSync(requests) ? fs.readFileSync(requests, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { home, work, files, base, api, job, sent, existing, log: () => log };
}

test('a Codex conversation starts from a draft, streams, continues, compacts, and lets go of its lock', { timeout: 90000 }, async t => {
  const b = await boot(t);
  const menus = await b.api('GET', '/api/codex/menus?cwd=' + encodeURIComponent(b.work));
  assert.equal(menus.status, 200, JSON.stringify(menus.body));
  assert.deepEqual(menus.body.models.map(m => m.id), ['fake-model', 'fake-mini'], 'hidden models stay hidden');
  assert.deepEqual(menus.body.models[0].efforts.map(e => e.effort), ['low', 'medium', 'high']);
  assert.deepEqual(menus.body.account, { type: 'chatgpt', plan: 'pro' });
  assert.ok(!JSON.stringify(menus.body).includes('private@example.com'), 'the account address never reaches a screen');
  assert.equal(menus.body.limits.primary.usedPercent, 40);
  assert.deepEqual(menus.body.access.map(a => a.id), ['config', 'read-only', 'workspace', 'full']);

  // A draft's first send, with attached context and Codex's own model.
  const start = await b.api('POST', '/api/conversation/start-loose', { harness: 'codex', folder: b.work, prompt: 'Count the owls', models: [{ provider: 'codex', modelId: 'fake-mini' }], thinking: 'low', access: 'workspace',
    context: [{ type: 'note', text: 'Owls nest in the barn.' }] });
  assert.equal(start.status, 200, JSON.stringify(start.body) + b.log());
  const key = start.body.key;
  assert.match(key, /^codex:\d{4}\/\d\d\/\d\d\/rollout-.*\.jsonl$/);
  assert.equal(start.body.harness, 'codex');
  const threadStart = b.sent().find(r => r.method === 'thread/start');
  assert.deepEqual([threadStart.params.model, threadStart.params.sandbox, threadStart.params.approvalPolicy], ['fake-mini', 'workspace-write', 'on-request']);
  assert.match(threadStart.params.developerInstructions, /Owls nest in the barn/, 'attached context reaches Codex as developer instructions');
  assert.equal(b.sent().find(r => r.method === 'turn/start').params.effort, 'low');
  await until(async () => (await b.job(start.body.job.id)).status === 'done', 'first reply');
  let session = await until(async () => { const s = (await b.api('GET', '/api/session?id=' + encodeURIComponent(key))).body; return s.messages && s.messages.some(m => m.role === 'assistant') && s; }, 'first reply indexed');
  assert.deepEqual(session.messages.filter(m => m.role !== 'thinking').map(m => [m.role, m.text]), [['user', 'Count the owls'], ['assistant', 'Fake Codex heard: Count the owls']]);
  assert.deepEqual(session.codexPrefs, { model: 'fake-mini', effort: 'low', access: 'workspace' });
  assert.ok((await b.api('GET', '/api/sessions')).body.some(r => r.key === key && r.source === 'codex'));
  const runJob = await b.job(start.body.job.id);
  assert.equal(runJob.harness, 'codex'); assert.equal(runJob.model, 'codex/fake-mini');

  // A follow-up on the same conversation: the warm Codex is reused.
  const second = await b.api('POST', '/api/node/send', { id: key, prompt: 'And the herons?', models: [{ provider: 'codex', modelId: 'fake-model' }] });
  assert.equal(second.status, 202, JSON.stringify(second.body));
  await until(async () => (await b.job(second.body.job.id)).status === 'done', 'second reply');
  session = await until(async () => { const s = (await b.api('GET', '/api/session?id=' + encodeURIComponent(key))).body; return s.messages.filter(m => m.role === 'assistant').length === 2 && s; }, 'second reply indexed');
  assert.equal(b.sent().filter(r => r.method === 'initialize').length, 2, 'the menus helper and one conversation process: the follow-up reused it');
  assert.equal(b.sent().filter(r => r.method === 'turn/start').at(-1).params.model, 'fake-model');

  // Attached context: given at the start (no second copy), then once again
  // only when it changes.
  assert.ok(!b.sent().some(r => r.method === 'thread/inject_items'), 'the start context is not repeated');
  assert.equal((await b.api('PUT', '/api/conversation/attached-context', { id: key, context: [{ type: 'note', text: 'Herons fish at dawn.' }] })).status, 200);
  const withCtx = await b.api('POST', '/api/node/send', { id: key, prompt: 'Use the new note' });
  await until(async () => { const j = await b.job(withCtx.body.job.id); if (j.status === 'error') throw new Error(j.error); return j.status === 'done'; }, 'reply with new context');
  const injected = b.sent().filter(r => r.method === 'thread/inject_items');
  assert.equal(injected.length, 1);
  assert.match(injected[0].params.items[0].content[0].text, /Herons fish at dawn/);
  assert.equal(injected[0].params.items[0].role, 'developer');
  const again = await b.api('POST', '/api/node/send', { id: key, prompt: 'Same context' });
  await until(async () => (await b.job(again.body.job.id)).status === 'done', 'reply, same context');
  assert.equal(b.sent().filter(r => r.method === 'thread/inject_items').length, 1, 'unchanged context is not given twice');

  // A Pi model cannot answer in Codex.
  const wrong = await b.api('POST', '/api/node/send', { id: key, prompt: 'x', models: [{ provider: 'anthropic', modelId: 'claude' }] });
  assert.equal(wrong.status, 400); assert.match(wrong.body.error, /Codex's own models/);

  // Choices: access and reasoning, kept per conversation.
  assert.equal((await b.api('PUT', '/api/codex/prefs', { id: key, access: 'read-only', effort: 'high' })).status, 200);
  assert.equal((await b.api('PUT', '/api/codex/prefs', { id: key, access: 'root' })).status, 400);
  const third = await b.api('POST', '/api/node/send', { id: key, prompt: 'Read only now' });
  await until(async () => (await b.job(third.body.job.id)).status === 'done', 'third reply');
  const resume = b.sent().filter(r => r.method === 'thread/resume').at(-1);
  assert.deepEqual([resume.params.sandbox, resume.params.approvalPolicy], ['read-only', 'on-request']);
  assert.equal(b.sent().filter(r => r.method === 'turn/start').at(-1).params.effort, 'high');

  // Codex's own compaction.
  const compact = await b.api('POST', '/api/conversation/compact', { id: key });
  assert.equal(compact.status, 200, JSON.stringify(compact.body));
  await until(async () => (await b.api('GET', '/api/session?id=' + encodeURIComponent(key))).body.messages.some(m => m.role === 'event' && m.customType === 'compaction'), 'compaction indexed');

  // The composer: Codex's file search for @, the controls for /.
  const at = await b.api('POST', '/api/node/compose', { id: key, action: 'complete', clientId: 'tab', text: 'see @owl', cursor: 8 });
  assert.equal(at.status, 200, JSON.stringify(at.body));
  assert.deepEqual(at.body.items.map(i => i.value), ['@"notes about owls.md"']);
  const applied = await b.api('POST', '/api/node/compose', { id: key, action: 'apply', clientId: 'tab', text: 'see @owl', cursor: 8, snapshot: at.body.snapshot, itemIndex: 0 });
  assert.deepEqual(applied.body, { text: 'see @"notes about owls.md" ', cursor: 27 });
  const dir = await b.api('POST', '/api/node/compose', { id: key, action: 'complete', clientId: 'tab', text: '@nes', cursor: 4 });
  const dirEdit = await b.api('POST', '/api/node/compose', { id: key, action: 'apply', clientId: 'tab', text: '@nes', cursor: 4, snapshot: dir.body.snapshot, itemIndex: 0 });
  assert.deepEqual(dirEdit.body, { text: '@nests/', cursor: 7 }, 'a folder keeps the search open inside it');
  const slash = await b.api('POST', '/api/node/compose', { id: key, action: 'complete', clientId: 'tab', text: '/mo', cursor: 3 });
  assert.deepEqual(slash.body.items.map(i => i.value), ['/model']);
  const effort = await b.api('POST', '/api/node/compose', { id: key, action: 'complete', clientId: 'tab', text: '/thinking ', cursor: 10 });
  assert.deepEqual(effort.body.items.map(i => i.value), ['low', 'medium', 'high'], 'the levels the chosen model offers');
  const cmds = await b.api('GET', '/api/node/commands?id=' + encodeURIComponent(key));
  assert.deepEqual(cmds.body.commands.map(c => c.name).sort(), ['compact', 'model', 'settings', 'thinking', 'tree']);

  // Fork at the first answer: a new conversation through that turn, one
  // tree with the original. Codex's own thread/fork.
  const now = (await b.api('GET', '/api/session?id=' + encodeURIComponent(key))).body;
  const firstAnswer = now.messages.find(m => m.role === 'assistant');
  const fork = await b.api('POST', '/api/fork', { id: key, node: firstAnswer.eid });
  assert.equal(fork.status, 200, JSON.stringify(fork.body));
  const forkSession = await until(async () => { const x = (await b.api('GET', '/api/session?id=' + encodeURIComponent(fork.body.key))).body; return x.messages && x; }, 'fork indexed');
  assert.deepEqual(forkSession.messages.filter(m => ['user', 'assistant'].includes(m.role)).map(m => m.text), ['Count the owls', 'Fake Codex heard: Count the owls']);
  assert.ok((await b.api('GET', '/api/sessions')).body.find(r => r.key === fork.body.key).title.startsWith('⤔'), 'a fork is marked as one');
  const inFork = await b.api('POST', '/api/node/send', { id: fork.body.key, prompt: 'Branch question' });
  await until(async () => (await b.job(inFork.body.job.id)).status === 'done', 'reply in the fork');
  const forkAfter = await until(async () => { const x = (await b.api('GET', '/api/session?id=' + encodeURIComponent(fork.body.key))).body; return x.messages.filter(m => m.role === 'assistant').length === 2 && x; }, 'fork reply indexed');
  assert.equal(forkAfter.messages.filter(m => m.role === 'user').at(-1).text, 'Branch question');
  const tree = (await b.api('GET', '/api/tree?id=' + encodeURIComponent(key))).body;
  assert.ok(tree.family.some(f => f.key === fork.body.key), 'the fork is in the original\'s family: one tree');
  // Edit a question: a fork through the turn before it, the words handed back.
  const secondQ = now.messages.filter(m => m.role === 'user')[1];
  const edit = await b.api('POST', '/api/fork-edit', { id: key, node: secondQ.eid });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.text, 'And the herons?');
  const editSession = await until(async () => (await b.api('GET', '/api/session?id=' + encodeURIComponent(edit.body.key))).body, 'edit fork');
  assert.deepEqual(editSession.messages.filter(m => m.role === 'user').map(m => m.text), ['Count the owls']);
  // What Codex cannot do is refused with its reason, and nothing is written.
  const before = fs.readFileSync(path.join(b.home, '.codex', 'sessions', key.slice(6)), 'utf8');
  const firstQ = now.messages.find(m => m.role === 'user');
  assert.match((await b.api('POST', '/api/node/regenerate', { id: key, question: firstQ.eid })).body.error, /one line of answers/);
  assert.match((await b.api('POST', '/api/branch', { id: key, node: firstAnswer.eid })).body.error, /one line/);
  assert.match((await b.api('POST', '/api/fork-edit', { id: key, node: firstQ.eid })).body.error, /first question/);
  const fan = await b.api('POST', '/api/node/send', { id: key, prompt: 'x', models: [{ provider: 'codex', modelId: 'fake-model' }, { provider: 'codex', modelId: 'fake-mini' }] });
  assert.match(fan.body.error, /Side-by-side answers need Pi/);
  const i = now.messages.findIndex(m => m.role === 'user');
  const rawEdit = await b.api('POST', '/api/transcript/edit', { id: key, i, text: 'rewritten', baseSha: 'x' });
  assert.equal(rawEdit.status, 409); assert.match(rawEdit.body.error, /does not edit it/);
  assert.equal(fs.readFileSync(path.join(b.home, '.codex', 'sessions', key.slice(6)), 'utf8'), before, 'Codex\'s file is never rewritten');

  // Let go now: the Codex app or terminal can open it at once.
  const released = await b.api('POST', '/api/codex/release', { id: key });
  assert.deepEqual(released.body, { ok: true, released: true });
});

test('approvals are answered from the run card; stop interrupts; a conversation another Codex holds is refused', { timeout: 90000 }, async t => {
  const locked = '01a0f000-0000-7000-8000-000000000001';
  const b = await boot(t, { FAKE_CODEX_APPROVE: '1', FAKE_CODEX_LOCKED: locked });
  // Held by another Codex (the fixture's current conversation).
  const refused = await b.api('POST', '/api/node/send', { id: b.existing, prompt: 'hello' });
  assert.equal(refused.status, 202);
  const failed = await until(async () => { const j = await b.job(refused.body.job.id); return j.status === 'error' && j; }, 'lock refusal');
  assert.match(failed.error, /open in another Codex/);
  // An imported copy is never continued.
  const copyKey = 'codex:2026/09/21/rollout-2026-09-21T09-00-00-01a0f000-0000-7000-8000-000000000004.jsonl';
  const copy = await b.api('POST', '/api/node/send', { id: copyKey, prompt: 'x' });
  assert.equal(copy.status, 400); assert.match(copy.body.error, /copy Codex imported/);

  const start = await b.api('POST', '/api/conversation/start-loose', { harness: 'codex', folder: b.work, prompt: 'Needs a command' });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const ask = await until(async () => { const j = await b.job(start.body.job.id); return j.uiRequests && j.uiRequests[0]; }, 'approval card');
  assert.equal(ask.title, 'Codex wants to run a command');
  assert.match(ask.message, /echo approved-by-fixture/);
  assert.deepEqual(ask.options, ['Allow', 'Allow for this conversation', 'Refuse', 'Refuse and stop']);
  assert.equal((await b.api('POST', '/api/run/ui-response', { jobId: start.body.job.id, id: ask.id, value: 'Allow' })).status, 200);
  await until(async () => (await b.job(start.body.job.id)).status === 'done', 'reply after approval');
  const decision = b.sent().find(r => r.id >= 1000 && r.result);
  assert.deepEqual(decision.result, { decision: 'accept' });
  const s = await until(async () => { const x = (await b.api('GET', '/api/session?id=' + encodeURIComponent(start.body.key))).body; return x.messages.some(m => m.role === 'toolresult') && x; }, 'command indexed');
  assert.ok(s.messages.some(m => m.role === 'tool' && m.text === 'echo approved-by-fixture'));
});

test('stop interrupts a Codex reply and the conversation stays usable', { timeout: 90000 }, async t => {
  const b = await boot(t, { FAKE_CODEX_SLOW: '1' });
  const start = await b.api('POST', '/api/conversation/start-loose', { harness: 'codex', folder: b.work, prompt: 'Take your time' });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  await until(async () => b.sent().some(r => r.method === 'turn/start'), 'reply started');
  await new Promise(r => setTimeout(r, 200));
  const abort = await b.api('POST', '/api/run/abort', { jobId: start.body.job.id });
  assert.ok(abort.status < 300, JSON.stringify(abort.body));
  const done = await until(async () => { const j = await b.job(start.body.job.id); return j.status !== 'running' && j; }, 'stopped');
  assert.equal(done.status, 'done'); assert.match(done.statusText, /stopped/);
  assert.equal(b.sent().filter(r => r.method === 'turn/interrupt').length, 1);
  const s = await until(async () => { const x = (await b.api('GET', '/api/session?id=' + encodeURIComponent(start.body.key))).body; return x.messages && x.messages.some(m => m.role === 'abort') && x; }, 'abort indexed');
  assert.ok(s.messages.some(m => m.role === 'user' && m.text === 'Take your time'));
});

test('the file ask box sends to Codex: Codex\'s own model and reasoning, the brief for that request; a new Codex conversation from the box', { timeout: 90000 }, async t => {
  const b = await boot(t);
  const file = path.join(b.work, 'notes about owls.md');
  // The box remembers a Pi model and level: they are for Pi answers only.
  const ask = await b.api('POST', '/api/files/ask', { path: file, prompt: 'Add a heading', target: b.existing, line: 1,
    models: [{ provider: 'anthropic', modelId: 'claude-fixture' }], thinking: 'off', codexModel: 'fake-mini', codexEffort: 'high' });
  assert.equal(ask.status, 202, JSON.stringify(ask.body) + b.log());
  assert.equal(ask.body.harness, 'codex'); assert.equal(ask.body.key, b.existing);
  await until(async () => (await b.job(ask.body.job.id)).status === 'done', 'the ask\'s reply');
  const turn = b.sent().filter(r => r.method === 'turn/start').at(-1);
  assert.deepEqual([turn.params.model, turn.params.effort], ['fake-mini', 'high'], 'Codex answers with the box\'s Codex choice, not its Pi model');
  const injected = b.sent().filter(r => r.method === 'thread/inject_items').flatMap(r => r.params.items).map(i => i.content[0].text).join('\n\n');
  assert.match(injected, /Instructions from Chattering for the next request only:[\s\S]*ask box/, 'the brief reaches Codex');
  assert.match(injected, /notes about owls\.md/, 'the file joins the attached context');
  // Without Codex choices, the conversation keeps its own.
  const plain = await b.api('POST', '/api/files/ask', { path: file, prompt: 'Now a footer', target: b.existing, models: [{ provider: 'anthropic', modelId: 'claude-fixture' }] });
  assert.equal(plain.status, 202, JSON.stringify(plain.body));
  await until(async () => (await b.job(plain.body.job.id)).status === 'done', 'the plain ask');
  assert.notEqual(b.sent().filter(r => r.method === 'turn/start').at(-1).params.model, 'claude-fixture');

  // A new Codex conversation from the box. (The test's home is a temporary
  // folder, so the file is "loose": it starts where a Pi one would.)
  const doc = file;
  const target = (await b.api('GET', '/api/files/ask-target?path=' + encodeURIComponent(doc))).body;
  assert.equal(target.codexAllowed, true, JSON.stringify(target));
  const fresh = await b.api('POST', '/api/files/ask', { path: doc, prompt: 'Say what owls eat', target: 'new', harness: 'codex', line: 1, codexModel: 'fake-model' });
  assert.equal(fresh.status, 202, JSON.stringify(fresh.body) + b.log());
  assert.equal(fresh.body.created, true); assert.match(fresh.body.key, /^codex:/);
  const started = b.sent().filter(r => r.method === 'thread/start').at(-1);
  assert.ok(started.params.cwd && fs.existsSync(started.params.cwd), 'a real folder: ' + started.params.cwd);
  assert.match(started.params.developerInstructions, /notes about owls\.md[\s\S]*ask box/, 'the file and the brief reach the new Codex conversation');
  await until(async () => (await b.job(fresh.body.job.id)).status === 'done', 'the new conversation\'s reply');
  // The next ask continues it without handing the file over again.
  const again = await b.api('POST', '/api/files/ask', { path: doc, prompt: 'And where they sleep', target: fresh.body.key, line: 1 });
  assert.equal(again.status, 202, JSON.stringify(again.body));
  await until(async () => (await b.job(again.body.job.id)).status === 'done', 'the follow-up ask');
  const items = b.sent().filter(r => r.method === 'thread/inject_items').at(-1).params.items.map(i => i.content[0].text);
  assert.ok(items.every(t => !/^Context the person attached/.test(t)), 'the unchanged file is not given again: ' + JSON.stringify(items).slice(0, 300));
  assert.ok(items.some(t => /next request only/.test(t)), 'the brief is');
});
