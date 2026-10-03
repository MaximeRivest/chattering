'use strict';
// A conversation shared by link (design/92): read in Chattering's own page,
// read only, live or a snapshot, with what looks like a secret hidden, and
// nothing of the computer reachable through it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromiumBinary, chromiumAvailable, CHROMIUM_TEST_FLAGS } = require('./helpers/chromium.js');
const { redactText } = require('../shares.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const until = async (fn, label, ms = 20000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timeout: ' + label); await sleep(50); } };

test('secrets: the common shapes are hidden, code that names them is not', () => {
  const found = [];
  const out = redactText([
    'export GODADDY_API_KEY="AZzFGinAfB6_R9zVMKGrTY6GUpmrJqMQWq"',
    'Authorization: sso-key ABCDEFGHIJKLMNOPQRST:xyzxyzxyzxyz',
    'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'https://me:hunter22@example.com/x',
    '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----',
    'const TOKEN = process.env.TOKEN;',
    "const TOKEN = 'artifact-test-token';",
    'we talked about api keys and passwords',
  ].join('\n'), found);
  assert.doesNotMatch(out, /AZzFGin|ABCDEFGHIJ|sk-ant|ghp_|hunter22|MIIEv/);
  assert.match(out, /const TOKEN = process\.env\.TOKEN;/);
  assert.match(out, /artifact-test-token/);
  assert.match(out, /api keys and passwords/);
  assert.equal(found.length, 6);
});

test('a conversation shared by link: the owner makes it, a visitor reads it in Chattering\u2019s page, live and as a snapshot', { timeout: 180000 }, async t => {
  if (!chromiumAvailable()) return t.skip('chromium is not installed');
  const root = path.join(__dirname, '..'), home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'share-conv-')));
  const agent = path.join(home, '.pi/agent'), sessions = path.join(agent, 'sessions/fixture'), work = path.join(home, 'work');
  fs.mkdirSync(sessions, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: work });
  let clock = 0;
  const ts = () => new Date(Date.UTC(2026, 8, 17, 12, 0, clock++)).toISOString();
  const user = (id, parentId, text) => ({ type: 'message', id, parentId, timestamp: ts(), message: { role: 'user', content: [{ type: 'text', text }] } });
  const assistant = (id, parentId, content) => ({ type: 'message', id, parentId, timestamp: ts(), message: { role: 'assistant', model: 'm', provider: 'p', content } });
  const result = (id, parentId, callId, text) => ({ type: 'message', id, parentId, timestamp: ts(), message: { role: 'toolResult', toolCallId: callId, toolName: 'bash', content: [{ type: 'text', text }], isError: false } });
  const file = path.join(sessions, 'bend.jsonl');
  const lines = [
    { type: 'session', version: 3, id: 'fixture', cwd: work },
    user('q1', null, 'can i do operator overloading in bend?'),
    assistant('a1', 'q1', [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'cat ~/.bashrc' } }]),
    result('r1', 'a1', 'c1', 'export PATH=$HOME/bin\nexport GODADDY_API_KEY="AZzFGinAfB6_R9zVMKGrTY6GUpmrJqMQWq"\n<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>'),
    assistant('a2', 'r1', [{ type: 'text', text: 'Yes: **Bend** has no operator overloading, but you can define `add` for your type.\n\n| lang | ms |\n|---|---|\n| Bend | 54 |' }]),
  ];
  fs.writeFileSync(file, lines.map(JSON.stringify).join('\n') + '\n');
  let server, browser, cdp;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer);
  };
  t.after(async () => { cdp?.close(); await require('./helpers/cleanup.js').stopAndRemove(browser, null); await stop(server); await require('./helpers/cleanup.js').stopAndRemove(null, home); });

  const port = await freePort(), previewPort = await freePort();
  const base = 'http://127.0.0.1:' + port, pv = 'http://localhost:' + previewPort, token = 'share-conv-token', auth = { Authorization: 'Bearer ' + token };
  let log = '';
  require('./helpers/first-run.js').answerFirstRun(home);
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_PREVIEW_PORT: String(previewPort),
    CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_TOKEN: token, CHATTERING_NO_SYNC: '1', CHATTERING_NO_PUBLIC_LINKS: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'),
    CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  const key = 'pi:fixture/bend.jsonl';
  await until(async () => { try { return (await (await fetch(base + '/api/sessions', { headers: auth })).json()).some(s => s.key === key); } catch { return false; } }, 'the server\n' + log);
  const api = async (p, body) => { const r = await fetch(base + p, body ? { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: auth }); return { status: r.status, body: await r.json().catch(() => null) }; };

  // ---- the browser: owner and visitors ----
  browser = spawn(chromiumBinary(), [...CHROMIUM_TEST_FLAGS, '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(Error(out)), 10000);
    browser.stderr.on('data', b => { out += b; const m = out.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
  });
  cdp = new WebSocket(endpoint); await new Promise(res => cdp.onopen = res);
  let id = 0; const pending = new Map(), problems = new Map();
  const problem = (sid, text) => { if (!problems.has(sid)) problems.set(sid, []); problems.get(sid).push(text); };
  cdp.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') problem(m.sessionId, m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && /Content Security Policy|Refused/.test(m.params.entry.text)) problem(m.sessionId, m.params.entry.text);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(res => { pending.set(++id, res); cdp.send(JSON.stringify({ id, method, params, sessionId })); });
  const tab = async () => {
    const target = await send('Target.createTarget', { url: 'about:blank', newWindow: true });
    const sid = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
    await send('Runtime.enable', {}, sid); await send('Page.enable', {}, sid); await send('Log.enable', {}, sid); await send('Network.enable', {}, sid);
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
    const evaluate = async expression => {
      const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
      assert.ok(!out.result?.exceptionDetails, JSON.stringify(out.result?.exceptionDetails));
      return out.result?.result?.value;
    };
    const waitFor = (expression, label) => until(async () => await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`), label + '\n' + (problems.get(sid) || []).join('\n') + '\n' + log.slice(-1500));
    return { sid, evaluate, waitFor, go: url => send('Page.navigate', { url }, sid) };
  };

  // The owner: the conversation's "who can see this" → Share by link.
  const owner = await tab();
  await owner.go(`http://localhost:${port}/?token=${token}#${encodeURIComponent(key)}`);
  await owner.waitFor(`current && current.key === ${JSON.stringify(key)} && document.querySelector('#conversationTranscript .msg') && !document.getElementById('shareBtn').hidden`, 'the conversation and its share button');
  await owner.evaluate(`document.getElementById('shareBtn').click(); 1`);
  await owner.waitFor(`document.getElementById('shareByLink')`, 'the Share by link entry');
  await owner.evaluate(`document.getElementById('shareByLink').click(); 1`);
  await owner.waitFor(`document.getElementById('shNewMode') && /Found 1 secret value: in a tool.s output, message 3/.test(document.querySelector('.sh-ui .dialog').textContent)`, 'the dialog says what it found');
  assert.match(await owner.evaluate(`document.querySelector('.sh-ui .dialog').textContent`), /hidden.*from people with the link/);
  await owner.evaluate(`document.getElementById('shNewMode').value = 'live'; document.getElementById('shCreate').click(); 1`);
  await owner.waitFor(`document.querySelector('.sh-ui-row select[data-act="mode"]')`, 'the live link');
  const liveId = await owner.evaluate(`document.querySelector('.sh-ui-row').dataset.id`);
  await owner.evaluate(`document.getElementById('shNewMode').value = 'snapshot'; document.getElementById('shCreate').click(); 1`);
  await owner.waitFor(`document.querySelectorAll('.sh-ui-row').length === 2`, 'the snapshot link');
  assert.match(await owner.evaluate(`document.querySelector('.sh-ui .dialog').textContent`), /a copy from .* update the copy/);
  assert.deepEqual(problems.get(owner.sid) || [], []);
  const shares = (await api('/api/shares?key=' + encodeURIComponent(key))).body.shares;
  const live = shares.find(s => s.id === liveId), snap = shares.find(s => s.id !== liveId);
  assert.equal(live.mode, 'live'); assert.equal(snap.mode, 'snapshot'); assert.equal(snap.role, 'view');
  const linkOf = s => s.links.find(l => l.where === 'local').url;

  // ---- a visitor of the live link ----
  const v = await tab();
  await v.go(linkOf(live));
  await v.waitFor(`location.pathname.endsWith('/view') && document.querySelectorAll('#conversationTranscript .msg').length >= 3`, 'the conversation in the viewer');
  await v.waitFor(`document.getElementById('viewerBar')`, 'the bar');
  const page = JSON.parse(await v.evaluate(`JSON.stringify({
    text: document.getElementById('conversationTranscript').textContent,
    composer: !!document.getElementById('agentText'),
    side: !!document.getElementById('side') && getComputedStyle(document.getElementById('side')).display !== 'none',
    actions: [...document.querySelectorAll('.msg-actions')].some(e => getComputedStyle(e).display !== 'none'),
    bar: document.getElementById('viewerBar').textContent,
    table: !!document.querySelector('#conversationTranscript table'),
    pwned: window.__pwned || 0,
    hash: location.hash,
  })`));
  assert.match(page.text, /operator overloading in bend/);
  assert.match(page.bar, /Shared by .* read only/);
  assert.match(page.bar, /Live/);
  assert.equal(page.composer, false, 'no composer');
  assert.equal(page.side, false, 'no side list');
  assert.equal(page.actions, false, 'no actions on messages');
  assert.equal(page.table, true, 'drawn by Chattering\u2019s reader');
  assert.equal(page.hash, '#shared', 'the page knows it by "shared", not its file');
  // The step with the secret, opened: the value is hidden; nothing ran.
  await v.evaluate(`document.querySelector('#conversationTranscript .tool-group > summary, #conversationTranscript [data-gkey] summary, #conversationTranscript .steps-fold summary, #conversationTranscript button.steps-toggle')?.click(); 1`);
  const raw = await (await fetch(pv + '/s/' + live.id + '/api/session', { headers: { Cookie: await cookieOf(v) } })).text();
  assert.doesNotMatch(raw, /AZzFGinAfB6/, 'the secret never leaves');
  assert.match(JSON.parse(raw).messages.find(m => m.role === 'toolresult').text, /GODADDY_API_KEY="\[hidden: looks like a secret\]"/);
  assert.ok(!raw.includes(key) && !raw.includes('bend.jsonl'), 'nor the conversation\u2019s file');
  assert.equal(await v.evaluate('window.__pwned || 0'), 0, 'text in a conversation never runs');
  // Nothing that changes anything reaches the computer.
  const vCookie = await cookieOf(v);
  for (const [p, m] of [['/api/conversation/send', 'POST'], ['/api/node/send', 'POST'], ['/api/session', 'POST'], ['/api/file/save', 'POST'], ['/api/path/read', 'GET']])
    assert.equal((await fetch(pv + '/s/' + live.id + p, { method: m, headers: { Cookie: vCookie, 'Content-Type': 'application/json' }, body: m === 'POST' ? '{}' : undefined })).status, 404, p);
  // Asking for another conversation by its name gets this one, and only this one.
  const other = await (await fetch(pv + '/s/' + live.id + '/api/session?id=' + encodeURIComponent('pi:fixture/other.jsonl'), { headers: { Cookie: vCookie } })).json();
  assert.equal(other.key, 'shared');
  assert.equal((await fetch(pv + '/api/sessions', { headers: { Cookie: vCookie } })).status, 404, 'the app\u2019s own routes do not exist on the share address');
  assert.equal((await fetch(pv + '/s/' + live.id + '/view')).status, 401, 'no session, no viewer');
  const viewer = await fetch(pv + '/s/' + live.id + '/view', { headers: { Cookie: vCookie } });
  assert.match(viewer.headers.get('content-security-policy'), /script-src 'self' 'sha256-/);
  assert.doesNotMatch(viewer.headers.get('content-security-policy'), /unsafe-inline'[^;]*script|script-src[^;]*unsafe/);
  assert.equal((await fetch(pv + '/sw.js')).status, 404, 'no service worker on the share address');

  // Live: a new message appears.
  fs.appendFileSync(file, JSON.stringify(user('q2', 'a2', 'and SIMD, LIVE QUESTION?')) + '\n' + JSON.stringify(assistant('a3', 'q2', [{ type: 'text', text: 'LIVE ANSWER about SIMD.' }])) + '\n');
  await v.waitFor(`document.getElementById('conversationTranscript').textContent.includes('LIVE ANSWER about SIMD.')`, 'the live update');

  // ---- a visitor of the snapshot: as it was ----
  const w = await tab();
  await w.go(linkOf(snap));
  await w.waitFor(`location.pathname.endsWith('/view') && document.querySelectorAll('#conversationTranscript .msg').length >= 3 && document.getElementById('viewerBar')`, 'the snapshot');
  assert.doesNotMatch(await w.evaluate(`document.getElementById('conversationTranscript').textContent`), /LIVE ANSWER/);
  assert.match(await w.evaluate(`document.getElementById('viewerBar').textContent`), /A copy from/);
  // The owner updates the copy: a new visit shows the new messages.
  await api('/api/shares/change', { id: snap.id, refreshSnapshot: true });
  await w.go(linkOf(snap));
  await w.waitFor(`document.getElementById('conversationTranscript')?.textContent.includes('LIVE ANSWER about SIMD.')`, 'the updated copy');

  // ---- the owner turns the live link off: its reader is told ----
  await api('/api/shares/revoke', { id: live.id });
  await v.waitFor(`/This link has ended/.test(document.body.textContent)`, 'the live reader is told the link ended');
  assert.equal((await fetch(pv + '/s/' + live.id + '/api/session', { headers: { Cookie: vCookie } })).status, 401);
  for (const tb of [v, w]) assert.deepEqual((problems.get(tb.sid) || []).filter(p => !/Failed to load resource/.test(p)), [], 'no script errors, nothing refused by the page policy');

  async function cookieOf(tb) {
    const out = await send('Storage.getCookies', {});
    return (out.result.cookies || []).filter(c => /chattering_share_/.test(c.name)).map(c => c.name + '=' + c.value).join('; ');
  }
});
