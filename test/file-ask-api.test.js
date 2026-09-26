'use strict';
// The ask box's server side on a real server: where an ask goes, and what
// goes along with it (the brief of file-ask.js, the recent edits as diffs,
// the switches). Sending needs a real pi; file-ask.test.js covers the log.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const NOTEBOOK = '---\nrat:\n  python:\n    dependencies: [numpy]\n---\n\n# Analysis\n\nThe mean is computed below.\n\n```python\nimport numpy as np\nx = np.arange(10)\n```\n';

async function boot(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'file-ask-'));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  const repo = path.join(home, 'Projects', 'analysis');
  fs.mkdirSync(repo, { recursive: true });
  const doc = path.join(repo, 'notebook.md');
  fs.writeFileSync(doc, NOTEBOOK);
  // A repository with a commit: the scan lists checkouts that have a HEAD.
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '-qm', 'notebook']]) {
    assert.equal(spawnSync('git', args, { cwd: repo }).status, 0, 'git ' + args[0]);
  }
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port; await new Promise(r => s.close(r));
  let log = '';
  const env = { ...process.env, HOME: home, PORT: String(port), CHATTERING_TLS_PORT: '0',
    CHATTERING_HOST: '127.0.0.1', CHATTERING_LAN: '', CHATTERING_TOKEN: '', CHATTERING_PUBLIC_URL: '', CHATTERING_NO_WATCH: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, '.cache', 'chattering'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent };
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(base + '/api/settings')).ok) break; } catch {} await sleep(50); }
  // Saves go to files of known repositories: wait for the first scan.
  for (let i = 0; i < 200; i++) {
    try { if (((await (await fetch(base + '/api/git/repos')).json()).repos || []).some(r => (r.root || r.path || r) === repo)) break; } catch {}
    await sleep(50);
  }
  return { base, home, doc, log: () => log };
}

test('what goes along with an ask: the file, the brief with the notebook\u2019s rat commands, the recent edits as a diff', async t => {
  const s = await boot(t);
  // The person edits the notebook in the editor: a recorded save.
  const read = await (await fetch(s.base + '/api/file/read?path=' + encodeURIComponent(s.doc))).json();
  const edited = NOTEBOOK.replace('The mean is computed below.', 'The mean and the spread are computed below.');
  const saved = await (await post(s.base, '/api/doc/save', { path: s.doc, baseSha: read.sha, text: edited, actor: 'human', input: 'keyboard' })).json();
  assert.equal(saved.ok, true, JSON.stringify(saved) + s.log());

  const target = await (await fetch(s.base + '/api/files/ask-target?path=' + encodeURIComponent(s.doc))).json();
  assert.equal(target.error, undefined, target.error);
  assert.equal(target.edits, 1, 'the save is a recent edit');
  assert.deepEqual(target.history, []);

  const preview = await (await post(s.base, '/api/files/ask-preview', { path: s.doc, target: 'new', line: 9 })).json();
  assert.equal(preview.error, undefined, preview.error);
  assert.equal(preview.target, 'new');
  const text = preview.text;
  assert.match(text, /## Attached files[\s\S]*## This request comes from the file’s ask box/, 'the brief comes last, next to the request');
  assert.match(text, /cursor is on line 9/);
  assert.match(text, new RegExp('`rat run --doc ' + s.doc.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + " py '<code>'`"));
  assert.match(text, /add it there, then run `rat ensure /, 'the notebook declares its environment');
  assert.match(text, /### Recent changes to this file \(last 24 h, newest first\)\n\nWhere the user is[\s\S]*, in the editor · \+1 −1 lines\n\n(`{3,})diff\n@@ [^\n]+\n[\s\S]*-The mean is computed below\.\n\+The mean and the spread are computed below\./);
  assert.doesNotMatch(text, /## analysis\n/, 'the project memory stays out unless asked for');

  // The switches: without the recent edits.
  const lean = await (await post(s.base, '/api/files/ask-preview', { path: s.doc, target: 'new', line: 9, include: { edits: false } })).json();
  assert.doesNotMatch(lean.text, /### Recent changes to this file \(last 24 h/);
  assert.ok(lean.tokens < preview.tokens);

  // An empty request is refused before anything starts.
  const missing = await (await post(s.base, '/api/files/ask', { path: s.doc, prompt: '  ' })).json();
  assert.match(missing.error, /write what should change/);
});

test('what became of AI proposals is kept: a command with its prompt version, an ask; each person reads their own', async t => {
  const s = await boot(t);
  const report = { kind: 'command', path: s.doc, mode: 'review', decision: 'rejected', command: 'grammar', label: 'Fix grammar', target: 'The mean is computed below.',
    answers: [{ text: 'The mean is computed here.', model: 'p/m', status: 'ready' }], shown: 0, model: 'p/m',
    review: { decision: 'rejected', how: 'reviewed', hunks: [{ before: 'a\n', proposed: 'b\n', final: 'a\n', decision: 'rejected' }], ms: 5 } };
  const posted = await (await post(s.base, '/api/ai-feedback', report)).json();
  assert.equal(posted.ok, true, JSON.stringify(posted));
  const ask = await (await post(s.base, '/api/ai-feedback', { kind: 'ask', path: s.doc, mode: 'apply', decision: 'applied', prompt: 'shorter', jobId: 'run:none', diff: '@@ -1 +1 @@' })).json();
  assert.equal(ask.ok, true);
  assert.equal((await post(s.base, '/api/ai-feedback', { kind: 'ask', decision: 'applied' })).status, 400, 'a record names its file');
  assert.equal((await post(s.base, '/api/ai-feedback', { kind: 'nope', path: s.doc, decision: 'applied' })).status, 400);

  const got = await (await fetch(s.base + '/api/ai-feedback?limit=10')).json();
  assert.equal(got.file, path.join(s.home, '.local', 'share', 'chattering', 'ai-feedback.jsonl'));
  assert.equal(got.records.length, 2);
  const [command, asked] = got.records;
  assert.deepEqual([command.kind, command.decision, command.review.hunks[0].final, command.path, command.project], ['command', 'rejected', 'a\n', s.doc, 'analysis']);
  assert.match(command.prompt.catalog, /^[0-9a-f]{12}$/);
  assert.match(command.prompt.task, /^[0-9a-f]{12}$/, 'the grammar command’s own prompt');
  assert.ok(command.user && command.ts && command.id);
  assert.deepEqual([asked.kind, asked.prompt, asked.answer], ['ask', 'shorter', undefined], 'no such run: no answer made up');
});

