'use strict';
// A new install is neutral and quiet (TODO item 2, settings version 2): no
// personal server addresses, and no model call Chattering was not asked
// for until the owner answers the background-AI question. An install that
// ran before keeps exactly what it had. Boots the real server on throwaway
// homes with a fake `pi` that only records how it was called.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r));
  return port;
}

// A Pi (node + file, CHATTERING_PI_CLI) that answers nothing and writes one line per call.
function fakePi(home) {
  const bin = path.join(home, 'bin');
  const log = path.join(home, 'pi-calls.log');
  fs.mkdirSync(bin, { recursive: true });
  const cli = path.join(bin, 'fake-pi.js');
  fs.writeFileSync(cli, `require('fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\n`);
  return { bin, cli, calls: () => { try { return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { return []; } } };
}

// Two recent Claude Code user messages: enough for the timeline labeller
// and the automatic retitle to want a model.
function seedClaudeConversation(home) {
  const dir = path.join(home, '.claude', 'projects', '-tmp-demo');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const line = (i, text) => JSON.stringify({ type: 'user', uuid: 'u' + i, parentUuid: i ? 'u' + (i - 1) : null, sessionId: 's1', cwd: '/tmp/demo', timestamp: new Date(now - (3 - i) * 1000).toISOString(), message: { role: 'user', content: text } });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), [line(0, 'Fix the login bug in the signup form'), line(1, 'Also add a test for it')].join('\n') + '\n');
}

async function boot(t, { prepare } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-install-'));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  const pi = fakePi(home);
  if (prepare) prepare(home);
  const port = await freePort();
  let log = '';
  const env = { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), CHATTERING_PI_CLI: pi.cli, PORT: String(port), CHATTERING_TLS_PORT: '0',
    CHATTERING_HOST: '127.0.0.1', CHATTERING_LAN: '', CHATTERING_TOKEN: '', CHATTERING_PUBLIC_URL: '', CHATTERING_NO_WATCH: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, '.cache', 'chattering'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent };
  for (const k of ['SPEECH_URL', 'KOKORO_URL', 'KOKORO_VOICE', 'REWRITE_URL', 'REWRITE_MODEL']) delete env[k];
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(base + '/api/settings')).ok) break; } catch {}
    await sleep(50);
  }
  for (let i = 0; i < 200 && !/scan done/.test(log); i++) await sleep(50);
  const settingsFile = path.join(require('./helpers/home-env.js').appDir(home, 'config'), 'settings.json');
  return { base, home, pi, log: () => log, savedSettings: () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
}
const getSettings = async base => (await fetch(base + '/api/settings')).json();
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const modelCalls = pi => pi.calls().filter(l => /--mode json/.test(l));

test('a new install is neutral, asks before any background model call, and starts only what was allowed', async t => {
  const s = await boot(t, { prepare: seedClaudeConversation });
  const saved = s.savedSettings();
  assert.equal(saved.settingsVersion, 2, 'the version is written at first start, so the next start is not mistaken for an old install');
  assert.deepEqual(saved.backgroundAi, { decidedAt: null, names: false, memory: false });
  for (const k of ['semanticUrl', 'speechUrl', 'ttsUrl', 'voiceModelUrl']) assert.equal(saved[k], '', k + ' starts empty');
  assert.equal(saved.doneSound, 'chime');
  assert.equal(saved.usePiDefault, true);
  assert.doesNotMatch(JSON.stringify(saved), /100\.86\.|192\.168\./, 'no personal addresses');

  const api = await getSettings(s.base);
  assert.equal(api.conversations, 1);
  assert.equal(api.capabilities.speech.configured, false);
  assert.equal(api.capabilities.tts.configured, false);
  assert.equal(api.capabilities.doneSound, 'chime');

  // The timeline labeller fires 5 s after the scan, the retitle 2 s after
  // indexing. Wait past both: no model call may have happened.
  await sleep(7000);
  assert.deepEqual(modelCalls(s.pi), [], 'no background model call before the owner answered');

  // A general settings save cannot sneak the answer in.
  const put = await fetch(s.base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...api.settings, backgroundAi: { decidedAt: 'x', names: true, memory: true } }) });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).settings.backgroundAi.decidedAt, null);

  // Saying no is a decision too, and still nothing runs.
  let r = await post(s.base, '/api/settings/background-ai', { names: false, memory: false });
  assert.equal(r.status, 200);
  const no = (await r.json()).settings.backgroundAi;
  assert.ok(no.decidedAt && !no.names && !no.memory);
  await sleep(1500);
  assert.deepEqual(modelCalls(s.pi), []);

  // Allowing names starts the waiting titles right away, and only names.
  r = await post(s.base, '/api/settings/background-ai', { names: true });
  const yes = (await r.json()).settings.backgroundAi;
  assert.equal(yes.names, true); assert.equal(yes.memory, false);
  for (let i = 0; i < 60 && !modelCalls(s.pi).length; i++) await sleep(100);
  assert.ok(modelCalls(s.pi).length >= 1, 'the gate was the only thing holding the titles back');
  assert.equal(s.savedSettings().backgroundAi.names, true, 'the answer is saved');
});

test('an install that ran before keeps the values it already used, and background AI stays on', async t => {
  const s = await boot(t, { prepare: home => {
    const cache = path.join(home, '.cache', 'chattering');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'index.json'), '{}');
  } });
  const saved = s.savedSettings();
  assert.equal(saved.settingsVersion, 2);
  assert.equal(saved.provider, 'openai-codex');
  assert.equal(saved.doneSound, 'voice');
  assert.match(saved.speechUrl, /^http:\/\/100\.86\.49\.54:8078$/);
  assert.equal(saved.backgroundAi.decidedAt, 'before-consent');
  assert.equal(saved.backgroundAi.names, true);
  assert.equal(saved.backgroundAi.memory, true);
  const api = await getSettings(s.base);
  assert.equal(api.capabilities.speech.configured, true);
  assert.equal(api.capabilities.tts.configured, true);
});

test('voice routes refuse with a reason when no voice service is set up; bad addresses are refused', async t => {
  const s = await boot(t);
  let r = await fetch(s.base + '/api/speech/transcribe', { method: 'POST', body: Buffer.alloc(6400) });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /not set up/);
  r = await post(s.base, '/api/tts', { text: 'hello' });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /not set up/);

  const cur = (await getSettings(s.base)).settings;
  r = await fetch(s.base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cur, ttsUrl: 'kokoro-box:8880' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /http:\/\//);
  r = await fetch(s.base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cur, ttsUrl: 'http://kokoro-box:8880/', doneSound: 'summary' }) });
  assert.equal(r.status, 200);
  const after = await r.json();
  assert.equal(after.settings.ttsUrl, 'http://kokoro-box:8880');
  assert.equal(after.capabilities.tts.configured, true);
  assert.equal(after.capabilities.doneSound, 'summary', 'a speech mode plays once read-aloud is set up');
});
