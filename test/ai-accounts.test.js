'use strict';
// Connecting an AI (design/73), with Pi's real sign-in code and a model
// server that speaks the OpenAI-compatible protocol (helpers/fake-openai).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('../ai-accounts.js');
const { fakeOpenAI } = require('./helpers/fake-openai.js');
const pi = require('./helpers/pi-package.js').piPackageForTests();
const skip = !pi && 'Pi is not installed; the AI accounts need its sign-in code';

async function setup(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-accounts-')));
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(null, dir));
  let changes = 0;
  const ai = A.createAiAccounts({ agentDir: dir, authPath: path.join(dir, 'auth.json'), modelsPath: path.join(dir, 'models.json'), settingsPath: path.join(dir, 'settings.json'),
    onChange: () => { changes++; }, env: { ...process.env, PI_OFFLINE: '1', ...(pi ? { CHATTERING_PI_PACKAGE_DIR: pi } : {}) } });
  return { dir, ai, changes: () => changes };
}
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 50)); } };

test('addresses of model servers: normalized, named by kind or host', () => {
  assert.equal(A.normalizeBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/v1');
  assert.equal(A.normalizeBaseUrl(' http://localhost:1234/v1/ '), 'http://localhost:1234/v1');
  assert.equal(A.normalizeBaseUrl('https://gpu.example.org/v1/chat/completions?x=1'), 'https://gpu.example.org/v1');
  assert.throws(() => A.normalizeBaseUrl('file:///etc/passwd'), /http/);
  assert.throws(() => A.normalizeBaseUrl('not an address'), /address/);
  assert.equal(A.serverName('http://127.0.0.1:11434/v1', new Set()), 'ollama');
  assert.equal(A.serverName('http://localhost:1234/v1', new Set()), 'lm-studio');
  assert.equal(A.serverName('http://127.0.0.1:8080/v1', new Set()), 'local', 'a server on this computer, not named after 127.0.0.1');
  assert.equal(A.serverName('https://gpu.example.org/v1', new Set(['gpu-example-org'])), 'gpu-example-org-2');
});

test('a newcomer: nothing connected, the usual choices offered', { skip, timeout: 60000 }, async t => {
  const { ai } = await setup(t);
  const s = await ai.summary();
  assert.equal(s.ready, false);
  assert.deepEqual(s.available, []);
  const anthropic = s.providers.find(p => p.id === 'anthropic');
  assert.ok(anthropic.oauth && anthropic.oauth.subscription, 'Claude plans sign in');
  assert.ok(anthropic.apiKey, 'and keys work');
  assert.ok(s.providers.find(p => p.id === 'openai-codex').oauth, 'ChatGPT plans sign in');
});

test('a model server: found by its address, becomes the default, and answers', { skip, timeout: 90000 }, async t => {
  const { ai, dir, changes } = await setup(t);
  const server = await fakeOpenAI({ models: ['small-model', 'big-model'], reply: 'Ready when you are!', apiKey: 'server-key' });
  t.after(() => server.close());
  await assert.rejects(ai.addServer({ baseUrl: server.baseUrl }), /refused the key/);
  await assert.rejects(ai.addServer({ baseUrl: 'http://127.0.0.1:9/v1' }), /Nothing answered/);
  const added = await ai.addServer({ baseUrl: server.baseUrl.replace(/\/v1$/, ''), apiKey: 'server-key' });
  assert.deepEqual(added.models, ['small-model', 'big-model']);
  assert.deepEqual(added.default, { provider: added.name, model: 'small-model' });
  assert.ok(changes() > 0, 'the server is told the models changed');
  const models = JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8'));
  assert.equal(models.providers[added.name].baseUrl, server.baseUrl);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(settings.defaultModel, 'small-model');
  const s = await ai.summary();
  assert.equal(s.ready, true);
  assert.deepEqual(s.servers.map(x => [x.name, x.hasKey]), [[added.name, true]]);
  const reply = await ai.test();
  assert.equal(reply.text, 'Ready when you are!');
  assert.equal(server.requests.at(-1).body.model, 'small-model');
  // Adding the same address again updates it rather than adding a twin.
  assert.equal((await ai.addServer({ baseUrl: server.baseUrl, apiKey: 'server-key' })).name, added.name);
  ai.removeServer(added.name);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'models.json'), 'utf8')).providers, {});
});

test('an API key: asked as a secret, stored by Pi, never shown back', { skip, timeout: 60000 }, async t => {
  const { ai, dir } = await setup(t);
  const id = ai.startLogin('openai', 'api_key');
  const asked = await until(() => ai.loginState(id).prompt);
  assert.equal(asked.type, 'secret');
  const secret = 'sk-test-' + 'x'.repeat(40);
  ai.answer(id, asked.id, secret);
  const done = await until(() => { const s = ai.loginState(id); return s.status !== 'running' && s; });
  assert.equal(done.status, 'done', done.error);
  assert.deepEqual(done.default, { provider: 'openai', model: 'gpt-5.5' }, 'Pi’s own default model for the provider');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).openai.key, secret);
  assert.ok(!JSON.stringify(done).includes(secret), 'the key is not in what the page reads');
  assert.throws(() => ai.answer(id, asked.id, 'again'), /over/);
  await ai.logout('openai');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).openai, undefined);
});

test('a plan sign-in: the address to open and a place to paste, and it can be cancelled', { skip, timeout: 60000 }, async t => {
  const { ai } = await setup(t);
  // Pi 1.0 asks first: this browser, or a code. Each option says which.
  for (const [way, redirect] of [['browser', /^http:\/\/localhost:\d+\/callback$/], ['code', /^https:\/\/[^/]+\/oauth\/code\/callback$/]]) {
    const id = ai.startLogin('anthropic', 'oauth');
    const ask = await until(() => { const s = ai.loginState(id); return s.prompt && s; });
    assert.equal(ask.prompt.type, 'select');
    assert.deepEqual(ask.prompt.options.map(o => o.way).sort(), ['browser', 'code']);
    ai.answer(id, ask.prompt.id, ask.prompt.options.find(o => o.way === way).id);
    const state = await until(() => { const s = ai.loginState(id); return s.prompt && s.events.some(e => e.type === 'auth_url') && s; });
    assert.equal(state.way, way);
    const url = new URL(state.events.find(e => e.type === 'auth_url').url);
    assert.match(url.href, /^https:\/\/claude\.ai\/oauth\/authorize\?/);
    assert.match(url.searchParams.get('redirect_uri'), redirect);
    assert.equal(state.prompt.type, 'manual_code');
    assert.equal(ai.cancel(id), true);
    const over = await until(() => { const s = ai.loginState(id); return s.status !== 'running' && s; });
    assert.equal(over.status, 'cancelled');
  }
  assert.throws(() => ai.startLogin('anthropic', 'magic'), /how to sign in/);
  assert.throws(() => ai.startLogin('../x', 'oauth'), /provider/);
});

test('a helper ends when the server that started it is gone', { skip, timeout: 60000 }, async t => {
  const { dir } = await setup(t);
  const { spawn } = require('node:child_process');
  const http = require('node:http');
  // A model that takes its time: the hello is still waiting when the server dies.
  const slow = http.createServer((req, res) => { if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'slow' }] })); } });
  await new Promise(r => slow.listen(0, '127.0.0.1', r));
  t.after(() => { slow.closeAllConnections(); slow.close(); });
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { slow: { baseUrl: `http://127.0.0.1:${slow.address().port}/v1`, api: 'openai-completions', apiKey: 'none', models: [{ id: 'slow' }] } } }));
  // A stand-in server: the real accounts module, asked for a hello, then killed.
  const parent = spawn(process.execPath, ['-e', `
    const A = require(${JSON.stringify(require.resolve('../ai-accounts.js'))});
    const d = ${JSON.stringify(dir)}, p = require('node:path');
    const ai = A.createAiAccounts({ agentDir: d, authPath: p.join(d, 'auth.json'), modelsPath: p.join(d, 'models.json'), settingsPath: p.join(d, 'settings.json'), env: { ...process.env, PI_OFFLINE: '1' } });
    ai.test('slow', 'slow').catch(() => {});
    setInterval(() => {}, 1000);`], { stdio: 'ignore', env: { ...process.env, ...(pi ? { CHATTERING_PI_PACKAGE_DIR: pi } : {}) } });
  const helpers = () => require('../processes.js').list().filter(p => p.ppid === parent.pid && p.argv.some(a => a.endsWith('ai-accounts-worker.js'))).map(p => p.pid);
  const [helper] = await until(() => { const h = helpers(); return h.length && h; });
  await new Promise(r => setTimeout(r, 1500)); // it is asking the model now
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(alive(helper), 'the helper is waiting for the model');
  parent.kill('SIGKILL');
  try { await until(() => !alive(helper), 10000); }
  finally { try { process.kill(helper, 'SIGKILL'); } catch {} }
});
