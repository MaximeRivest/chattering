'use strict';
// design/109: the Pi extension sends replies' limit headers (and nothing
// else) and refusals to Chattering; quiet replies are thinned, refusals go at once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const packageDir = require('./helpers/pi-package.js').piPackageForTests() || path.join(__dirname, 'no-pi-package-here');
const loaderPath = path.join(packageDir, 'dist/core/extensions/loader.js');

test('replies\u2019 limit headers and refusals reach Chattering, keys never', { skip: !fs.existsSync(loaderPath) && 'Pi is not installed here', timeout: 30000 }, async t => {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => { got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const saved = { CHATTERING_PORT: process.env.CHATTERING_PORT, CHATTERING_TOKEN: process.env.CHATTERING_TOKEN, JITI_FS_CACHE: process.env.JITI_FS_CACHE };
  process.env.CHATTERING_PORT = String(server.address().port);
  process.env.CHATTERING_TOKEN = 'ext-token';
  process.env.JITI_FS_CACHE = 'false';
  t.after(() => { server.close(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-limits-ext-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
  const loaded = await loadExtensions([path.resolve(__dirname, '../extensions/plan-limits.ts')], dir);
  assert.deepEqual(loaded.errors, []);
  const ext = loaded.extensions[0];
  const ctx = { model: { provider: 'claude-code', id: 'claude-opus-5-5' } };
  const hook = (name, event) => ext.handlers.get(name)[0](event, ctx);
  const wait = async n => { for (let i = 0; i < 200 && got.length < n; i++) await new Promise(r => setTimeout(r, 10)); };

  await hook('after_provider_response', { status: 200, headers: { authorization: 'Bearer sk-ant-secret', 'set-cookie': 'c', 'anthropic-ratelimit-unified-5h-utilization': '0.4', 'anthropic-ratelimit-unified-status': 'allowed', 'request-id': 'r' } });
  await wait(1);
  assert.equal(got.length, 1);
  assert.equal(got[0].url, '/api/plan-limits/observe');
  assert.equal(got[0].auth, 'Bearer ext-token');
  assert.deepEqual(got[0].body.headers, { 'anthropic-ratelimit-unified-5h-utilization': '0.4', 'anthropic-ratelimit-unified-status': 'allowed' });
  assert.equal(got[0].body.provider, 'claude-code');
  assert.equal(got[0].body.model, 'claude-opus-5-5');
  assert.ok(!JSON.stringify(got).includes('sk-ant-secret'));
  // A reply without limit headers sends nothing; the next quiet one waits its turn.
  await hook('after_provider_response', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  await hook('after_provider_response', { status: 200, headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.41' } });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(got.length, 1, 'a quiet reply within seconds is held');
  // A refusal goes at once, replacing the held one.
  await hook('after_provider_response', { status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'five_hour' } });
  await wait(2);
  assert.equal(got.length, 2);
  assert.equal(got[1].body.status, 429);
  // A reply that ended in an error says why.
  await hook('message_end', { message: { role: 'assistant', provider: 'claude-code', model: 'claude-opus-5-5', stopReason: 'error', errorMessage: 'Claude AI usage limit reached|1793453400' } });
  await wait(3);
  assert.equal(got[2].body.error, 'Claude AI usage limit reached|1793453400');
  await hook('message_end', { message: { role: 'assistant', stopReason: 'stop', provider: 'x', content: [] } });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(got.length, 3);
});
