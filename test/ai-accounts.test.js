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
  const id = ai.startLogin('anthropic', 'oauth');
  const state = await until(() => { const s = ai.loginState(id); return s.prompt && s.events.some(e => e.type === 'auth_url') && s; });
  assert.match(state.events.find(e => e.type === 'auth_url').url, /^https:\/\/claude\.ai\/oauth\/authorize\?/);
  assert.equal(state.prompt.type, 'manual_code');
  assert.equal(ai.cancel(id), true);
  const over = await until(() => { const s = ai.loginState(id); return s.status !== 'running' && s; });
  assert.equal(over.status, 'cancelled');
  assert.throws(() => ai.startLogin('anthropic', 'magic'), /how to sign in/);
  assert.throws(() => ai.startLogin('../x', 'oauth'), /provider/);
});
