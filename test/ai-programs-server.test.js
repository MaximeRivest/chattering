'use strict';
// Chattering's AI programs in the real server (design/74), with a fake Pi:
// a retitle is a FunctAI call on the settings model, logged with its
// conversation; renaming that title afterwards is recorded as the call's
// correction; the Programs pages list it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOKEN = 'ai-programs-token';

// A Pi (started as Pi is: node + file, CHATTERING_PI_CLI) that records the
// system message (--system-prompt, a file) and the user message (standard
// input), then answers with ~/answer.txt as Pi's JSON events.
function fakePi(home) {
  const cli = path.join(home, 'bin', 'fake-pi.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const sp = args.indexOf('--system-prompt');
const system = sp >= 0 ? fs.readFileSync(args[sp + 1], 'utf8') : '';
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(path.join(home, 'pi-calls.jsonl'))}, JSON.stringify({ args, system, input }) + '\\n');
const answer = fs.readFileSync(${JSON.stringify(path.join(home, 'answer.txt'))}, 'utf8');
process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: answer }], stopReason: 'stop',
  provider: 'fake', model: 'fake-1', timestamp: Date.now(), usage: { input: 40, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 46 } } }) + '\\n');
`);
  return {
    cli,
    answer: text => fs.writeFileSync(path.join(home, 'answer.txt'), text),
    calls: () => { try { return fs.readFileSync(path.join(home, 'pi-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } },
  };
}

test('a retitle is a logged AI program; renaming its title corrects that call', { timeout: 60000 }, async t => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-programs-server-')));
  const agent = path.join(home, '.pi', 'agent');
  const sessions = path.join(agent, 'sessions', 'fixture');
  fs.mkdirSync(sessions, { recursive: true });
  const work = path.join(home, 'work');
  fs.mkdirSync(work);
  fs.writeFileSync(path.join(sessions, 'login.jsonl'), [
    { type: 'session', version: 3, id: 'login', cwd: work },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-09-27T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'The login redirects forever after signing in.' }] } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-09-27T10:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }] } },
    { type: 'message', id: 'u2', parentId: 'a1', timestamp: '2026-09-27T10:01:00Z', message: { role: 'user', content: [{ type: 'text', text: 'It started when we moved the auth callback.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  require('./helpers/first-run.js').answerFirstRun(home);
  const pi = fakePi(home);
  pi.answer('<label>\nAuth loop\n</label>\n<title>\nFix login callback redirect loop\n</title>');
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r));
  registerConsole(port, TOKEN);
  const env = { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), CHATTERING_PI_CLI: pi.cli, PORT: String(port), CHATTERING_TLS_PORT: '0',
    CHATTERING_HOST: '127.0.0.1', CHATTERING_LAN: '', CHATTERING_TOKEN: TOKEN, CHATTERING_PUBLIC_URL: '', CHATTERING_NO_WATCH: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, '.cache', 'chattering'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent };
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  const key = 'pi:fixture/login.jsonl';
  for (let i = 0; i < 400; i++) {
    try { if ((await (await fetch(base + '/api/sessions')).json()).some(x => x.key === key)) break; } catch {}
    await sleep(50);
  }
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // The retitle: one Pi call, the program's layout, the typed answer.
  const res = await post('/api/conversation/retitle', { id: key });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out) + log);
  assert.deepEqual([out.title, out.timelineTitle], ['Fix login callback redirect loop', 'Auth loop']);
  const [call] = pi.calls();
  assert.match(call.system, /^Function: conversation_title\n\nName the actual work of one AI work conversation/);
  assert.equal(call.input, '<opening_user_messages>\n[\n  "The login redirects forever after signing in.",\n  "It started when we moved the auth callback."\n]\n</opening_user_messages>\n');
  for (const flag of ['-p', '--no-session', '--no-tools', '--no-extensions', '--no-context-files']) assert.ok(call.args.includes(flag), flag);

  // It is in the FunctAI log, with its conversation.
  const logDir = env.FUNCTAI_LOG_CALLS;
  const lines = () => fs.readdirSync(logDir).flatMap(d => fs.readdirSync(path.join(logDir, d)).flatMap(f => fs.readFileSync(path.join(logDir, d, f), 'utf8').trim().split('\n').map(JSON.parse)));
  const rec = lines().find(r => r.functai_call);
  assert.equal(rec.program.name, 'conversation_title');
  assert.equal(rec.program.module, 'chattering');
  assert.deepEqual(rec.caller, { kind: 'chattering', conversation: key });
  assert.deepEqual(rec.outputs, { label: 'Auth loop', title: 'Fix login callback redirect loop' });

  // A person renames it: the call's correction, by that person, from an edit.
  const renamed = await post('/api/conversation/title', { id: key, title: 'Debug the OAuth callback redirect' });
  assert.equal(renamed.status, 200);
  const rating = lines().find(r => r.functai_rating);
  assert.ok(rating, 'the rename is recorded');
  assert.deepEqual({ call: rating.call, verdict: rating.verdict, answer: rating.answer, origin: rating.origin, by: rating.by },
    { call: rec.id, verdict: 'wrong', answer: 'Debug the OAuth callback redirect', origin: 'edit', by: os.userInfo().username });
  // A second rename corrects nothing more: the title is the person's now.
  await post('/api/conversation/title', { id: key, title: 'OAuth callback loop' });
  assert.equal(lines().filter(r => r.functai_rating).length, 1);

  // The Programs pages list it, judged.
  const list = await (await fetch(base + '/api/programs')).json();
  const p = list.programs.find(x => x.name === 'conversation_title');
  assert.equal(p.module, 'chattering');
  assert.deepEqual(p.inputs, ['opening_user_messages']);
  assert.equal(p.ratings.wrong, 1);

  // The usage ledger names the program.
  const usage = fs.readFileSync(path.join(home, '.cache', 'chattering', 'internal-usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(usage.at(-1).chatteringPurpose, 'conversation_title');
});
