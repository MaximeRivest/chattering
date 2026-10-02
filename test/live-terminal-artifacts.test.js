'use strict';
// Artifacts from Claude Code in Chattering (design/91): its calls to
// Chattering's own tools (mcp__chattering__artifact / show, through
// harness/terminal/chattering-mcp.js) are artifacts as Pi's are; a page it
// published to claude.ai with its own Artifact tool is shown from a copy
// kept per publish (its scratch file disappears), titled from the page,
// with its claude.ai address. And the tools server speaks MCP.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'artifacts-test-token', AUTH = { Authorization: 'Bearer ' + TOKEN };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('the tools server: initialize, its two tools, artifact checks the file, show the size', { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'page.html'), '<h1>hi</h1>');
  const child = spawn(process.execPath, [path.join(ROOT, 'harness', 'terminal', 'chattering-mcp.js')], { cwd: dir, env: { ...process.env, CHATTERING_PORT: '1', CHATTERING_SESSION: '' } });
  t.after(() => child.kill());
  let buf = ''; const got = new Map();
  child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); got.set(m.id, m); } });
  const call = async (id, method, params) => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); for (let i = 0; i < 100 && !got.has(id); i++) await sleep(30); return got.get(id); };
  assert.equal((await call(1, 'initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'chattering');
  assert.deepEqual((await call(2, 'tools/list')).result.tools.map(x => x.name), ['artifact', 'show']);
  const ok = await call(3, 'tools/call', { name: 'artifact', arguments: { path: 'page.html', title: 'Hi' } });
  assert.match(ok.result.content[0].text, /Opened "Hi" .*page\.html/);
  const none = await call(4, 'tools/call', { name: 'artifact', arguments: { path: 'nope.html' } });
  assert.equal(none.result.isError, true); assert.match(none.result.content[0].text, /Nothing at/);
  assert.match((await call(5, 'tools/call', { name: 'show', arguments: { html: '<b>x</b>', title: 'X' } })).result.content[0].text, /Shown inline/);
});

test('a Claude Code conversation: Chattering\'s artifact and widget, and its claude.ai page kept and titled', { timeout: 60000 }, async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-artifacts-')));
  const work = path.join(home, 'work'); fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'game.html'), '<title>Game</title><h1>game</h1>');
  const scratch = path.join(home, 'scratch'); fs.mkdirSync(scratch);
  const page = path.join(scratch, 'viewer-check.html');
  const html = '<title>Artifact Viewer Check</title><h1>check</h1>';
  const dir = path.join(home, '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-')); fs.mkdirSync(dir, { recursive: true });
  const sid = '11111111-2222-4333-8444-5555555555d1';
  let n = 0;
  const entry = (type, content) => ({ type, uuid: 'e' + (++n), parentUuid: n > 1 ? 'e' + (n - 1) : null, sessionId: sid, cwd: work, timestamp: `2026-10-01T10:00:${String(n).padStart(2, '0')}Z`, message: { role: type, ...(type === 'assistant' ? { model: 'claude-fixture' } : {}), content } });
  const use = (id, name, input) => entry('assistant', [{ type: 'tool_use', id, name, input }]);
  const result = (id, text) => entry('user', [{ type: 'tool_result', tool_use_id: id, content: text }]);
  fs.writeFileSync(path.join(dir, sid + '.jsonl'), [
    entry('user', 'make things'),
    use('toolu_a1', 'mcp__chattering__artifact', { path: 'game.html', title: 'The game' }), result('toolu_a1', 'Opened "The game" in Chattering\'s artifact panel.'),
    use('toolu_w1', 'mcp__chattering__show', { html: '<b>chart</b>', title: 'A chart' }), result('toolu_w1', 'Shown inline.'),
    use('toolu_wr', 'Write', { file_path: page, content: html }), result('toolu_wr', 'File created successfully'),
    use('toolu_p1', 'Artifact', { file_path: page, icon: 'check', description: 'A test page' }), result('toolu_p1', `Published ${page} at https://claude.ai/artifact/25oMfGtDfvtbX6FtJxWjdC (Version 1)`),
    entry('assistant', [{ type: 'text', text: 'done' }]),
  ].map(JSON.stringify).join('\n') + '\n');
  // The scratch folder is cleared before Chattering reads it: the copy comes from the Write.
  fs.rmSync(scratch, { recursive: true });
  require('./helpers/first-run').answerFirstRun(home);
  const port = await freePort();
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, ...require('./helpers/home-env').homeEnv(home),
    PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_NO_WATCH: '1', CHATTERING_NO_SYNC: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_TOKEN: TOKEN,
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    CHATTERING_PREVIEW_PORT: '0', CHATTERING_PREVIEW_TLS_PORT: '0', PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  let key = null;
  for (let i = 0; i < 200 && !key; i++) { try { key = ((await (await fetch(base + '/api/sessions', { headers: AUTH })).json()).find(s => s.key.startsWith('claude:')) || {}).key; } catch {} if (!key) await sleep(100); }
  assert.ok(key, log.slice(-1500));
  const d = await (await fetch(base + '/api/session?id=' + encodeURIComponent(key), { headers: AUTH })).json();
  const arts = d.messages.filter(m => m.artifact).map(m => ({ name: m.name, ...m.artifact }));
  assert.deepEqual(arts.map(a => [a.name, a.kind]), [['artifact', 'files'], ['show', 'widget'], ['Artifact', 'files']]);
  assert.equal(arts[0].title, 'The game');
  const pub = arts[2];
  assert.equal(pub.title, 'Artifact Viewer Check', 'titled from the page');
  assert.equal(pub.url, 'https://claude.ai/artifact/25oMfGtDfvtbX6FtJxWjdC');
  assert.equal(pub.publishedBy, 'Claude Code');
  assert.ok(!pub.missing);
  assert.equal(fs.readFileSync(pub.path, 'utf8'), html, 'the copy is the page as published');
  assert.equal(fs.statSync(pub.path).mode & 0o777, 0o600);
  // The widget's HTML is served from the conversation, as for Pi.
  const w = d.messages.find(m => m.artifact && m.artifact.kind === 'widget');
  const wd = await (await fetch(base + `/api/artifacts/widget?id=${encodeURIComponent(key)}&entry=${encodeURIComponent(w.eid)}&call=toolu_w1`, { headers: AUTH })).json();
  assert.equal(wd.html, '<b>chart</b>');
  // In the conversation's list of artifacts, both files.
  const list = (await (await fetch(base + '/api/sessions', { headers: AUTH })).json()).find(s => s.key === key);
  assert.equal(list.artifacts.filter(a => !a.widget).length, 2, JSON.stringify(list.artifacts));
});
