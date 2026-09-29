'use strict';
// The providers the key proxy offers guests carry each model's own API. One provider can serve several
// (OpenRouter lists Anthropic models in the Anthropic format, the rest in OpenAI's); giving the whole
// provider the first model's format sent every guest request to a path the provider does not have
// (found 2026-09-29: every OpenRouter model answered a guest "404 Not Found").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createKeyProxy } = require('../keyproxy.js');

test('guest providers keep each model\'s API; the provider takes its most common one', { timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyproxy-catalog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({ providers: { mixed: {
    baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'fixture-key',
    models: [{ id: 'one-anthropic', api: 'anthropic-messages' }, { id: 'two' }, { id: 'three' }] } } }));
  const proxy = createKeyProxy({ forkWorker: (file, opts) => fork(file, [], { ...opts, env: { ...process.env, PI_CODING_AGENT_DIR: dir } }) });
  t.after(() => proxy.stop());
  const mixed = (await proxy.providers()).find(p => p.id === 'mixed');
  assert.ok(mixed, 'the provider is offered');
  assert.equal(mixed.api, 'openai-completions', 'most common API, not the first model\'s');
  const byId = Object.fromEntries(mixed.models.map(m => [m.id, m.api]));
  assert.equal(byId['one-anthropic'], 'anthropic-messages');
  assert.equal(byId.two, 'openai-completions');
});
