'use strict';
// Which model a conversation the frog starts, sends to or starts fresh
// answers with, when the frog names none (design/102). It must be the one
// the person's own new conversation would use (their last pick), never pi's
// default: on 2026-10-24 and 2026-10-26 pi's default (anthropic/…) was out
// of usage, so every frog start failed at once and worked after "go" from
// the web, which sends the last pick. Pi's runs are stood in for.
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const TEST_TOKEN = 'test-install-token';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const pause = ms => new Promise(r => setTimeout(r, ms));

test('the frog starts, sends and starts fresh with the person\'s pick, not pi\'s default', { timeout: 60000 }, async t => {
  const root = path.join(__dirname, '..'), home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.homedir(), '.frog-model-test-')));
  let server;
  t.after(async () => {
    if (server && server.exitCode === null) { const gone = new Promise(r => server.once('exit', r)); server.kill('SIGTERM'); await gone; }
    await require('./helpers/cleanup.js').stopAndRemove(null, home);
  });
  const agent = path.join(home, '.pi/agent'), cache = path.join(home, 'cache');
  const work = path.join(home, 'Projects', 'spin');
  fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(cache); fs.mkdirSync(agent, { recursive: true });
  // Pi's own default: the one that was out of usage.
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-opus-4-8' }) + '\n');
  const calls = path.join(home, 'runs.jsonl');
  const preload = path.join(home, 'fake-model.cjs');
  fs.writeFileSync(preload, `
if (process.argv[1] === ${JSON.stringify(path.join(root, 'server.js'))}) {
  const fs = require('node:fs'), crypto = require('node:crypto');
  const sdk = require(${JSON.stringify(path.join(root, 'pisdk.js'))});
  sdk.piHeadlessRun = (target, options) => {
    fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ file: target.sessionPath, message: options.message, model: options.provider ? options.provider + '/' + options.modelId : null }) + '\\n');
    const append = row => {
      const entries = fs.readFileSync(target.sessionPath, 'utf8').trim().split('\\n').map(JSON.parse);
      const last = entries.at(-1);
      fs.appendFileSync(target.sessionPath, JSON.stringify({ id: crypto.randomUUID().slice(0, 8), parentId: last.type === 'session' ? null : last.id, timestamp: new Date().toISOString(), ...row }) + '\\n');
      if (row.message) { options.onEvent({ type: 'message_start', message: row.message }); options.onEvent({ type: 'message_end', message: row.message }); }
    };
    append({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: options.message }] } });
    // Answered by what it was told to use; pi's default when told nothing.
    const [provider, model] = options.provider ? [options.provider, options.modelId] : ['anthropic', 'claude-opus-4-8'];
    let doneResolve; const done = new Promise(r => { doneResolve = r; });
    setTimeout(() => { append({ type: 'message', message: { role: 'assistant', provider, model, content: [{ type: 'text', text: 'Done.' }], stopReason: 'stop' } }); doneResolve(); }, 40);
    return { done, abort: async () => doneResolve() };
  };
}
`);
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  registerConsole(port, TEST_TOKEN);
  let log = '';
  require('./helpers/first-run.js').answerFirstRun(home);
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env,
    ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TOKEN: TEST_TOKEN, CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1',
    CHATTERING_NO_FILE_HISTORY: '1', CHATTERING_NO_CHECKPOINTS: '1', CHATTERING_DISABLE_NETWORK_RECOVERY: '1',
    CHATTERING_CACHE_DIR: cache, CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, NODE_OPTIONS: '--require=' + preload,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  const base = 'http://127.0.0.1:' + port;
  const call = async (route, body, method = 'POST') => {
    const r = await fetch(base + route, body ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) } : { signal: AbortSignal.timeout(10000) });
    return { status: r.status, ...(await r.json()) };
  };
  const waitFor = async (predicate, what) => {
    for (let i = 0; i < 400; i++) { try { const v = await predicate(); if (v) return v; } catch {} await pause(50); }
    assert.fail('Timed out: ' + what + '\n' + log.slice(-4000));
  };
  const runFor = message => waitFor(() => fs.existsSync(calls) && fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).find(r => r.message === message), 'a run for ' + message);
  await waitFor(async () => (await fetch(base + '/api/sessions')).ok, 'the server');

  // The person's own pick, as the web's draft remembers it.
  const pick = await call('/api/models/last', { models: [{ provider: 'claude-code', modelId: 'claude-opus-5-5' }] }, 'PUT');
  assert.equal(pick.status, 200, JSON.stringify(pick));
  const draft = await call('/api/conversation/draft-defaults');
  if (draft.status === 200) assert.deepEqual(draft.models, [{ provider: 'claude-code', modelId: 'claude-opus-5-5' }], 'the web\'s new conversation starts with it');

  // start_conversation with no model: the pick.
  const started = await call('/api/frog/start', { folder: work, prompt: 'Look at the spin model.' });
  assert.equal(started.status, 200, JSON.stringify(started));
  assert.equal(started.runError, undefined);
  const first = await runFor('Look at the spin model.');
  assert.equal(first.model, 'claude-code/claude-opus-5-5', 'the first run uses the person\'s pick');
  const key = 'pi:' + path.relative(path.join(agent, 'sessions'), first.file);
  await pause(800); // the stand-in run ends after 40 ms

  // A conversation whose last run went out on pi's default, then the
  // person picked another in its menu: the frog's send follows the menu.
  const menu = await call('/api/conversation/models', { id: key, models: [{ provider: 'openai-codex', modelId: 'gpt-6.1-sol' }] }, 'PUT');
  assert.equal(menu.status, 200, JSON.stringify(menu));
  const sent = await call('/api/frog/send', { id: started.id, text: 'And the loss?' });
  assert.equal(sent.status, 200, JSON.stringify(sent));
  assert.equal((await runFor('And the loss?')).model, 'openai-codex/gpt-6.1-sol', 'a send uses the model its menu shows');
  await pause(500);

  // fresh_start: the old conversation's menu, carried and used.
  const fresh = await call('/api/frog/fresh', { id: started.id, message: 'Go on from here.' });
  assert.equal(fresh.status, 200, JSON.stringify(fresh));
  assert.equal((await runFor('Go on from here.')).model, 'openai-codex/gpt-6.1-sol', 'a fresh start keeps its model');
});
