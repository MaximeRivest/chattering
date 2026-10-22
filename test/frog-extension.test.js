'use strict';
// The frog's tools as Pi loads them (design/102): each calls its
// server route with the install token, an error comes back as the server's
// own sentence, and the workspace note is added before a message only in
// the frog mode and only when it changed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const packageDir = require('./helpers/pi-package.js').piPackageForTests() || path.join(__dirname, 'no-pi-package-here');
const loaderPath = path.join(packageDir, 'dist/core/extensions/loader.js');

test('the frog extension calls its routes and notes the workspace only in its mode', { skip: !fs.existsSync(loaderPath) && 'no Pi package' }, async t => {
  const hits = [];
  let workspace = 'Working (1):\n- bigspin [01a149bb] · bigspin · tool · bash · 5 min';
  let cut = '';
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    hits.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/frog/workspace') return res.end(JSON.stringify({ text: workspace }));
    if (req.url === '/api/frog/interrupted') { const text = cut; cut = ''; return res.end(JSON.stringify({ text })); }
    if (req.url === '/api/frog/send') return res.end(JSON.stringify({ sent: true, id: '01a149bb', title: 'bigspin', project: 'bigspin' }));
    res.statusCode = 404; res.end(JSON.stringify({ error: 'No conversation has the id "zz".' }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const saved = { port: process.env.CHATTERING_PORT, token: process.env.CHATTERING_TOKEN, jiti: process.env.JITI_FS_CACHE };
  process.env.CHATTERING_PORT = String(srv.address().port);
  process.env.CHATTERING_TOKEN = 'install-token';
  process.env.JITI_FS_CACHE = 'false';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-ext-'));
  t.after(() => {
    srv.close(); fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [['CHATTERING_PORT', saved.port], ['CHATTERING_TOKEN', saved.token], ['JITI_FS_CACHE', saved.jiti]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
  const loaded = await loadExtensions([path.resolve(__dirname, '../extensions/frog.ts')], dir);
  assert.deepEqual(loaded.errors, []);
  const ext = loaded.extensions[0];
  const mode = JSON.parse(fs.readFileSync(path.join(__dirname, '../extensions/modes/frog.json'), 'utf8'));
  for (const name of mode.tools.filter(n => !['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'artifact', 'show'].includes(n) && !n.startsWith('chattering_'))) {
    assert.ok(ext.tools.has(name), 'the mode lists a tool the extension does not have: ' + name);
  }
  const modesSource = fs.readFileSync(path.join(__dirname, '../extensions/modes.ts'), 'utf8');
  for (const name of ext.tools.keys()) assert.ok(modesSource.includes(JSON.stringify(name)), name + ' must be opt-in in modes.ts, or every conversation gets it');

  const ctx = { cwd: dir };
  const call = (name, params) => ext.tools.get(name).definition.execute('call', params, new AbortController().signal, undefined, ctx);
  const sent = await call('send_to_conversation', { id: '01a149bb', text: 'Run one more epoch' });
  assert.equal(sent.details.project, 'bigspin');
  const last = hits.at(-1);
  assert.deepEqual([last.method, last.url, last.auth, last.body], ['POST', '/api/frog/send', 'Bearer install-token', { id: '01a149bb', text: 'Run one more epoch' }]);
  await assert.rejects(call('read_conversation', { id: 'zz' }), /No conversation has the id "zz"/);
  const ws = await call('workspace', {});
  assert.match(ws.content[0].text, /^Working \(1\)/, 'the workspace reads as text, not JSON');

  const hook = () => ext.handlers.get('before_agent_start')[0]({ type: 'before_agent_start', prompt: 'who is working?' }, ctx);
  loaded.runtime.getActiveTools = () => ['read', 'bash'];
  const before = hits.length;
  assert.equal(await hook(), undefined, 'another mode gets no note');
  assert.equal(hits.length, before, 'and costs no request');
  loaded.runtime.getActiveTools = () => mode.tools;
  const note = await hook();
  assert.equal(note.message.customType, 'frog-workspace');
  assert.equal(note.message.display, false);
  assert.match(note.message.content, /bigspin \[01a149bb\]/);
  assert.equal(await hook(), undefined, 'unchanged: not added again');
  workspace = 'Working (0).';
  assert.match((await hook()).message.content, /Working \(0\)/);
  // Its reading was cut off: the note comes first, once, even when the
  // workspace has not changed.
  cut = 'The person cut off your last reply while it was being read aloud.\nThey did not hear: "And third, bigspin."';
  const told = (await hook()).message.content;
  assert.match(told, /^Read aloud \(from Chattering, not said by the person\):\nThe person cut off/);
  assert.doesNotMatch(told, /Workspace at/);
  assert.equal(await hook(), undefined, 'said once');
});
