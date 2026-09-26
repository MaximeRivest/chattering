'use strict';
// extensions/records.ts loads in Pi's real extension loader and turns tool
// calls into GET /api/records/<op> requests. A fake server records what
// arrives; the tools must pass cwd, self-exclusion, and print the server text.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const packageDir = require('./helpers/pi-package.js').piPackageForTests() || path.join(__dirname, 'no-pi-package-here');
const loaderPath = path.join(packageDir, 'dist/core/extensions/loader.js');
const available = fs.existsSync(loaderPath);

async function setup(t) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push({ op: u.pathname.replace('/api/records/', ''), params: Object.fromEntries(u.searchParams) });
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname.endsWith('/show') && u.searchParams.get('id') === 'missing') {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'no conversation matches "missing"', text: 'error: no conversation matches "missing"' }));
    }
    res.end(JSON.stringify({ text: `ok ${u.pathname.split('/').pop()} ${u.searchParams.get('q') || u.searchParams.get('id') || ''}`.trim(), total: 1 }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const savedPort = process.env.CHATTERING_PORT, savedJiti = process.env.JITI_FS_CACHE;
  process.env.CHATTERING_PORT = String(port);
  process.env.JITI_FS_CACHE = 'false';
  const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
  const loaded = await loadExtensions([path.resolve(__dirname, '../extensions/records.ts')], process.cwd());
  assert.deepEqual(loaded.errors, []);
  const ext = loaded.extensions[0];
  const ctx = { cwd: '/home/me/Projects/alpha', sessionManager: { getSessionFile: () => '/home/me/.pi/agent/sessions/x/self.jsonl' } };
  const call = (name, params) => ext.tools.get(name).definition.execute('tool-call', params, new AbortController().signal, undefined, ctx);
  t.after(() => {
    server.close();
    if (savedPort === undefined) delete process.env.CHATTERING_PORT; else process.env.CHATTERING_PORT = savedPort;
    if (savedJiti === undefined) delete process.env.JITI_FS_CACHE; else process.env.JITI_FS_CACHE = savedJiti;
  });
  return { ext, call, calls };
}

test('records tools: five tools, correct ops and parameters', { skip: !available && 'pi-coding-agent package not found' }, async t => {
  const { ext, call, calls } = await setup(t);
  assert.deepEqual([...ext.tools.keys()].sort(), ['chattering_list', 'chattering_memory', 'chattering_read', 'chattering_search', 'chattering_show']);

  const s = await call('chattering_search', { q: 'flux capacitor', since: '30d', limit: 5 });
  assert.equal(s.content[0].text, 'ok search flux capacitor');
  assert.equal(s.details.total, 1);
  assert.deepEqual(calls.at(-1), { op: 'search', params: { q: 'flux capacitor', since: '30d', limit: '5', dir: '/home/me/Projects/alpha', excludePath: '/home/me/.pi/agent/sessions/x/self.jsonl' } });

  await call('chattering_show', { id: 'abc12345', at: 4, context: 2 });
  assert.deepEqual(calls.at(-1), { op: 'show', params: { id: 'abc12345', at: '4', context: '2' } });

  await call('chattering_memory', { kind: 'intent' });
  assert.deepEqual(calls.at(-1), { op: 'memory', params: { kind: 'intent', dir: '/home/me/Projects/alpha' } });

  await call('chattering_read', { what: 'evidence', id: 'abc12345' });
  assert.deepEqual(calls.at(-1), { op: 'evidence', params: { id: 'abc12345' } });
  await call('chattering_read', { what: 'note', id: '2026-08-20-x.md' });
  assert.equal(calls.at(-1).op, 'note');

  await call('chattering_list', { what: 'conversations', since: '2w' });
  assert.deepEqual(calls.at(-1), { op: 'conversations', params: { since: '2w', dir: '/home/me/Projects/alpha' } });
  await call('chattering_list', { what: 'projects', project: 'all' });
  assert.deepEqual(calls.at(-1), { op: 'projects', params: {} });

  await assert.rejects(call('chattering_show', { id: 'missing' }), /no conversation matches "missing"/);
});

test('records tools: a dead server gives a start instruction', { skip: !available && 'pi-coding-agent package not found' }, async t => {
  const { call } = await setup(t);
  const closed = http.createServer();
  await new Promise(r => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port;
  await new Promise(r => closed.close(r));
  const saved = process.env.CHATTERING_PORT;
  process.env.CHATTERING_PORT = String(port);
  try {
    await assert.rejects(call('chattering_search', { q: 'anything' }), /not answering on port \d+ .*systemctl --user start chattering/);
  } finally { process.env.CHATTERING_PORT = saved; }
});
