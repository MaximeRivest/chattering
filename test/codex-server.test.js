'use strict';
// Codex conversations through the real server (design/87): indexed from a
// synthetic ~/.codex, listed, read, searched, drawn as a tree, pictures
// served, and an imported copy linked to its Claude Code original.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch');
const fx = require('./helpers/codex-fixtures');

async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r)); return port;
}

test('Codex conversations are indexed, listed, read, searched and linked to their originals', { timeout: 60000 }, async t => {
  const root = path.join(__dirname, '..');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-server-')));
  const work = path.join(home, 'work', 'zoo'); fs.mkdirSync(work, { recursive: true });
  const files = fx.writeCodexHome(home, work);
  // The Claude Code conversation the Codex desktop app imported.
  const claudeDir = path.join(home, '.claude', 'projects', work.replace(/[\/\\]/g, '-'));
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, '11111111-2222-4333-8444-555555555555.jsonl'), [
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: '11111111-2222-4333-8444-555555555555', cwd: work, timestamp: '2026-09-01T10:00:00Z', message: { role: 'user', content: 'Explain the kestrel parser' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: '11111111-2222-4333-8444-555555555555', cwd: work, timestamp: '2026-09-01T10:00:05Z', message: { role: 'assistant', model: 'claude-fixture', content: [{ type: 'text', text: 'The original, with its tools.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const agent = path.join(home, '.pi', 'agent'); fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  require('./helpers/first-run').answerFirstRun(home);
  const port = await freePort(), token = 'codex-test-token';
  registerConsole(port, token);
  let log = '';
  const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env').homeEnv(home),
    PORT: String(port), CHATTERING_TOKEN: token, CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, CODEX_HOME: path.join(home, '.codex') }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup').stopAndRemove(server, home));
  const base = 'http://127.0.0.1:' + port;
  const key = 'codex:2026/09/20/rollout-2026-09-20T10-00-00-01a0f000-0000-7000-8000-000000000001.jsonl';
  const copyKey = 'codex:2026/09/21/rollout-2026-09-21T09-00-00-01a0f000-0000-7000-8000-000000000004.jsonl';
  let rows = [];
  for (let i = 0; i < 150; i++) {
    try { rows = await (await fetch(base + '/api/sessions')).json(); if (Array.isArray(rows) && rows.some(r => r.key === key) && rows.some(r => r.source === 'claude' && r.codexCopies)) break; } catch {}
    if (server.exitCode != null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const row = rows.find(r => r.key === key);
  assert.ok(row, 'the current Codex conversation is listed\n' + log);
  assert.equal(row.source, 'codex');
  assert.equal(row.title, 'Why does the parrot fixture fail?');
  assert.equal(row.cwd, work);
  assert.equal(row.codex.originator, 'codex-tui');
  assert.equal(row.userCount, 3);
  assert.ok(rows.some(r => r.key.endsWith('a0000000-0000-4000-8000-000000000002.jsonl')), 'early format listed');
  assert.ok(rows.some(r => r.key === 'codex:rollout-2025-07-05-b0000000-0000-4000-8000-000000000003.json'), 'single-document format listed');
  assert.ok(!rows.some(r => r.key === copyKey), 'the imported copy leaves the list');
  const original = rows.find(r => r.source === 'claude');
  assert.deepEqual(original.codexCopies, [copyKey], 'the original names its copy');

  const session = await (await fetch(base + '/api/session?id=' + encodeURIComponent(key))).json();
  assert.equal(session.source, 'codex');
  assert.deepEqual(session.messages.filter(m => m.role === 'user').map(m => m.text), ['Why does the parrot fixture fail?', 'Can you also check the owl fixture?', 'What is left?']);
  assert.ok(session.messages.some(m => m.role === 'tool' && m.name === 'apply_patch'));
  const img = session.messages.find(m => m.role === 'user').images[0];
  const media = await fetch(base + '/api/conversation/media?id=' + encodeURIComponent(key) + '&entry=' + img.entry + '&path=' + img.path);
  assert.equal(media.status, 200); assert.equal(media.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), Buffer.from(fx.PNG, 'base64'));
  // The copy can still be opened directly (it is not deleted, only linked).
  const copy = await (await fetch(base + '/api/session?id=' + encodeURIComponent(copyKey))).json();
  assert.equal(copy.importCopyOf, original.key);

  const tree = await (await fetch(base + '/api/tree?id=' + encodeURIComponent(key))).json();
  assert.ok(!tree.error, JSON.stringify(tree));
  assert.ok(tree.nodes.length >= 5, 'the conversation draws as a tree of words and work');

  let hits = null;
  for (let i = 0; i < 50; i++) {
    hits = await (await fetch(base + '/api/search?q=' + encodeURIComponent('squawk'))).json();
    if (hits.groups && hits.groups.some(g => g.key === key)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(hits.groups.some(g => g.key === key), 'Codex answers are searchable: ' + JSON.stringify(hits).slice(0, 300));
  const kestrel = await (await fetch(base + '/api/search?q=' + encodeURIComponent('kestrel'))).json();
  assert.ok(!kestrel.groups.some(g => g.key === copyKey), 'the copy is not a second search hit');
  assert.ok(kestrel.groups.some(g => g.key === original.key));
  // Codex's file edits (apply_patch) are edits like Pi's: listed with their
  // outcome, and the turn's step can be opened on its change.
  const diffs = await (await fetch(base + '/api/conversation/diffs?id=' + encodeURIComponent(key))).json();
  const parrot = diffs.events.find(e => e.callId === 'call_patch');
  assert.ok(parrot, 'the patch is an edit: ' + JSON.stringify(diffs.events).slice(0, 300));
  assert.equal(parrot.path, path.join(work, 'src/parrot.js'));
  assert.equal(parrot.oldText, 'quack'); assert.equal(parrot.newText, 'squawk');
  assert.equal(parrot.outcome, 'applied'); assert.equal(parrot.agent, 'codex'); assert.equal(parrot.source, 'codex');
  const step = await (await fetch(base + '/api/conversation/file-event?id=' + encodeURIComponent(key) + '&call=call_patch')).json();
  assert.ok(!step.error, JSON.stringify(step).slice(0, 300));
});
