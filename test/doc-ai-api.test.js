'use strict';
// Local requests sign in like every client (design/69): the test server's
// install token, sent by consoleFetch on 127.0.0.1 and set as the browser's cookie.
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const TEST_TOKEN = 'test-install-token';
// /api/doc/ai and /api/doc/ai-accept on a real server, with a fake `pi`
// that streams a scripted answer and records how it was called.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A Pi (started as Pi is: node + file, CHATTERING_PI_CLI) that records its arguments and attached file, then streams the
// text of $FAKE_PI_ANSWER (or sleeps, for "slow") as pi's JSON events.
function fakePi(home) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const file = args.find(a => a.startsWith('@'));
fs.appendFileSync(${JSON.stringify(path.join(home, 'pi-calls.jsonl'))}, JSON.stringify({ args, input: file ? fs.readFileSync(file.slice(1), 'utf8') : '' }) + '\\n');
const answer = fs.readFileSync(${JSON.stringify(path.join(home, 'answer.txt'))}, 'utf8');
if (answer === 'slow') { setTimeout(() => {}, 60000); return; }
const out = e => process.stdout.write(JSON.stringify(e) + '\\n');
for (const delta of answer.match(/.{1,6}/gs) || []) out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: answer }], provider: 'fake', model: 'fake-1', timestamp: Date.now(),
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } } } });
`;
  fs.writeFileSync(path.join(bin, 'fake-pi.js'), script);
  return {
    bin, cli: path.join(bin, 'fake-pi.js'),
    answer: text => fs.writeFileSync(path.join(home, 'answer.txt'), text),
    calls: () => { try { return fs.readFileSync(path.join(home, 'pi-calls.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } },
  };
}

async function boot(t) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'doc-ai-')));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  const pi = fakePi(home);
  pi.answer('');
  // Documents save inside a known repository: a project under ~/Projects,
  // there before the server's first repository scan.
  const repo = path.join(home, 'Projects', 'essays');
  fs.mkdirSync(repo, { recursive: true });
  const doc = path.join(repo, 'essay.md');
  fs.writeFileSync(doc, '');
  // The scan lists checkouts that have a HEAD: one commit.
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-qm', 'essay']]) {
    assert.equal(spawnSync('git', args, { cwd: repo }).status, 0, 'git ' + args[0]);
  }
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r));
  registerConsole(port, TEST_TOKEN);
  let log = '';
  const env = { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), CHATTERING_PI_CLI: pi.cli, PORT: String(port), CHATTERING_TLS_PORT: '0',
    CHATTERING_HOST: '127.0.0.1', CHATTERING_LAN: '', CHATTERING_TOKEN: TEST_TOKEN, CHATTERING_PUBLIC_URL: '', CHATTERING_NO_WATCH: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, '.cache', 'chattering'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent };
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(base + '/api/settings')).ok) break; } catch {} await sleep(50); }
  return { base, home, pi, doc, log: () => log };
}

const post = (base, p, body, signal) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
async function ndjson(res) {
  const events = [];
  for (const line of (await res.text()).split('\n')) if (line.trim()) events.push(JSON.parse(line));
  return events;
}
const TEXT = '# Essay\n\nTheir going to the store.\n';
const grammarRequest = doc => ({
  doc, command: 'grammar',
  request: { command: 'grammar', scope: 'prose', instruction: '', target: { from: 9, to: 34, text: 'Their going to the store.' },
    block: { type: 'prose', text: 'Their going to the store.' }, document: TEXT },
});

test('a command streams its answer from a tool-less model call; an accepted edit is recorded as the AI\u2019s', async t => {
  const s = await boot(t);
  fs.writeFileSync(s.doc, TEXT);

  const status = await (await fetch(s.base + '/api/doc/ai')).json();
  assert.equal(status.available, true);
  assert.ok(status.model);

  s.pi.answer("They're going to the store.");
  const res = await post(s.base, '/api/doc/ai', grammarRequest(s.doc));
  assert.match(res.headers.get('content-type'), /ndjson/);
  const events = await ndjson(res);
  assert.ok(events.filter(e => e.type === 'delta').length > 1, 'the answer streamed');
  assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), "They're going to the store.");
  assert.deepEqual([events.at(-1).type, events.at(-1).text], ['done', "They're going to the store."]);

  const call = s.pi.calls().at(-1);
  for (const flag of ['--no-tools', '--no-session', '--no-extensions', '--no-context-files']) assert.ok(call.args.includes(flag), flag);
  assert.equal(call.args[call.args.indexOf('--thinking') + 1], 'off', 'a grammar fix needs no reasoning');
  assert.match(call.input, /<target-[0-9a-f]{12}>\nTheir going to the store.\n<\/target-[0-9a-f]{12}>/);
  assert.match(call.args.at(-1), /Correct the grammar/);
  const usage = fs.readFileSync(path.join(s.home, '.cache', 'chattering', 'internal-usage.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
  assert.equal(usage.chatteringPurpose, 'ai-command');

  // Accepting: the notice, then the save that writes exactly that text.
  const after = "# Essay\n\nThey're going to the store.\n";
  assert.equal((await (await post(s.base, '/api/doc/ai-accept', { doc: s.doc, command: 'grammar', model: 'fake/fake-1', text: after })).json()).ok, true);
  const saved = await (await post(s.base, '/api/doc/save', { path: s.doc, text: after, actor: 'human', input: 'keyboard' })).json();
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const edits = fs.readFileSync(path.join(s.home, 'notes', 'chattering', 'doc-edits.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const last = edits.at(-1);
  assert.deepEqual([last.actor, last.input, last.ai.command, last.ai.model], ['ai', 'ai-edit', 'grammar', 'fake/fake-1']);

  // A notice for text that is not what gets saved (the person typed on)
  // does not claim the save: that save is the person's.
  await post(s.base, '/api/doc/ai-accept', { doc: s.doc, command: 'grammar', model: 'm', text: after + 'x' });
  await post(s.base, '/api/doc/save', { path: s.doc, text: after + 'yz', actor: 'human', input: 'keyboard' });
  const human = fs.readFileSync(path.join(s.home, 'notes', 'chattering', 'doc-edits.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
  assert.deepEqual([human.actor, human.input, human.ai], ['human', 'keyboard', undefined]);
});

test('only known commands on the document they name; stopping frees the call', async t => {
  const s = await boot(t);
  fs.writeFileSync(s.doc, TEXT);
  assert.match((await (await post(s.base, '/api/doc/ai', { ...grammarRequest(s.doc), command: 'prompt-me' })).json()).error, /unknown AI command/);
  const mismatch = grammarRequest(s.doc);
  mismatch.request.target.text = 'something else';
  assert.match((await (await post(s.base, '/api/doc/ai', mismatch)).json()).error, /does not match/);
  assert.match((await (await post(s.base, '/api/doc/ai', { ...grammarRequest(path.join(s.home, 'nope.md')) })).json()).error, /not found/);
  const huge = await post(s.base, '/api/doc/ai-accept', { doc: s.doc, command: 'grammar', text: 'x'.repeat(17 * 1024 * 1024) });
  assert.equal(huge.status, 413);

  // Three slow calls, stopped by the page: each frees its slot.
  s.pi.answer('slow');
  for (let round = 0; round < 2; round++) {
    const stops = [0, 1, 2].map(() => new AbortController());
    const pending = stops.map(c => post(s.base, '/api/doc/ai', grammarRequest(s.doc), c.signal).catch(() => null));
    await sleep(700);
    stops.forEach(c => c.abort());
    await Promise.all(pending);
    await sleep(300);
  }
  s.pi.answer("They're going to the store.");
  const events = await ndjson(await post(s.base, '/api/doc/ai', grammarRequest(s.doc)));
  assert.equal(events.at(-1).type, 'done', 'stopped calls did not keep their slots');
});

test('source files: their own commands and prompt; an accepted edit saved later is the AI\u2019s, or the person\u2019s when their typing went along', async t => {
  const s = await boot(t);
  const file = path.join(path.dirname(s.doc), 'calc.py');
  const CODE = 'def add(a, b):\n    return a + b\n';
  fs.writeFileSync(file, CODE);
  const target = { from: 0, to: CODE.length - 1, text: CODE.slice(0, -1) };
  const request = command => ({ doc: file, command, request: { command, scope: 'code', instruction: '', target, block: { type: 'code', language: 'python', text: target.text }, document: CODE } });

  assert.match((await (await post(s.base, '/api/doc/ai', request('markdown'))).json()).error, /kind of file/);
  s.pi.answer('def add(a: int, b: int) -> int:\n    return a + b');
  const events = await ndjson(await post(s.base, '/api/doc/ai', request('types')));
  assert.equal(events.at(-1).type, 'done', JSON.stringify(events.at(-1)));
  assert.match(s.pi.calls().at(-1).args.at(-1), /^You are editing part of a python file/);

  const edits = () => fs.readFileSync(path.join(s.home, 'notes', 'chattering', 'doc-edits.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  // Accepted with nothing unsaved; saved later with Save: the AI's edit.
  const after = 'def add(a: int, b: int) -> int:\n    return a + b\n';
  assert.equal((await (await post(s.base, '/api/doc/ai-accept', { doc: file, command: 'types', model: 'fake/fake-1', text: after, until: 'save', mixed: false })).json()).ok, true);
  assert.equal((await (await post(s.base, '/api/file/save', { path: file, text: after })).json()).ok, true);
  assert.deepEqual([edits().at(-1).actor, edits().at(-1).input, edits().at(-1).ai.command, edits().at(-1).ai.mixed], ['ai', 'ai-edit', 'types', undefined]);
  // Accepted over unsaved typing: the save stays the person's, with the AI's part noted.
  const typed = after + '\n# mine\n';
  await post(s.base, '/api/doc/ai-accept', { doc: file, command: 'comments', model: 'fake/fake-1', text: typed, until: 'save', mixed: true });
  await post(s.base, '/api/file/save', { path: file, text: typed });
  assert.deepEqual([edits().at(-1).actor, edits().at(-1).ai.command, edits().at(-1).ai.mixed], ['human', 'comments', true]);
});

