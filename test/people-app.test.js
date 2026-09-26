'use strict';
// Two people in one browser engine (two isolated contexts), one server on
// its LAN address: sign-in, the header chip, presence, the shared compose
// box with carets, the shared file editor, and a project hidden from one
// of them. Skipped without chromium or a LAN address.
const test = require('node:test');
const { registerConsole, consoleFetch: fetch } = require('./helpers/console-fetch.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { chromiumBinary } = require('./helpers/chromium.js');

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) if (!n.internal && n.family === 'IPv4' && !n.address.startsWith('172.')) return n.address;
  return null;
}

test('two people share a machine: sign-in, presence, one compose box, one file, a hidden project', { timeout: 90000 }, async t => {
  const chromium = chromiumBinary();
  if (spawnSync(chromium, ['--version']).error) return t.skip('chromium is not installed');
  if (!lanIp()) return t.skip('no LAN address');
  const root = path.join(__dirname, '..'), home = fs.mkdtempSync(path.join(os.homedir(), '.people-app-test-'));
  let server, browser, ws;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 3000);
    try { await exited; } finally { clearTimeout(timeout); }
  };
  t.after(async () => { ws?.close(); await stop(browser); await stop(server); fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const agent = path.join(home, '.pi/agent');
  const work = path.join(home, 'Projects', 'shared'), secretWork = path.join(home, 'Projects', 'secret');
  fs.mkdirSync(path.join(work, 'notes'), { recursive: true }); fs.mkdirSync(secretWork, { recursive: true });
  fs.writeFileSync(path.join(work, 'notes', 'plan.md'), '# Plan\n\nfirst line\n');
  fs.writeFileSync(path.join(work, 'code.js'), 'const a = 1;\n');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Initial files']]) {
    const result = spawnSync('git', args, { cwd: work }); assert.equal(result.status, 0, String(result.stderr));
  }
  const msg = (id, parentId, role, text, ts = '2026-09-01T12:00:00Z') => ({ type: 'message', id, parentId, timestamp: ts, message: { role, content: [{ type: 'text', text }], model: 'fixture' } });
  const write = (dir, name, cwd, first) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name + '.jsonl'), [{ type: 'session', version: 3, id: name, cwd }, msg('p', null, 'user', first), msg('a', 'p', 'assistant', 'An answer.')].map(JSON.stringify).join('\n') + '\n'); };
  write(path.join(agent, 'sessions', 'shared'), 'chat', work, 'What should we build?');
  write(path.join(agent, 'sessions', 'secret'), 'hidden', secretWork, 'The surprise party');
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '0.0.0.0', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  let serverLog = '';
  registerConsole(port, 'install-tok');
  require('./helpers/first-run.js').answerFirstRun(home); // no first-run modal over the page
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '', CHATTERING_LAN: '1', CHATTERING_TOKEN: 'install-tok', CHATTERING_PUBLIC_URL: '', CHATTERING_NO_WATCH: '0', CHATTERING_NO_LEDGER: '0', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => serverLog += b); server.stderr.on('data', b => serverLog += b);
  const base = 'http://' + lanIp() + ':' + port, key = 'pi:shared/chat.jsonl';
  let indexed = false;
  for (let i = 0; i < 150; i++) {
    try { const rows = await (await fetch('http://127.0.0.1:' + port + '/api/sessions')).json(); if (rows.some(s => s.key === key) && rows.length === 2) { indexed = true; break; } } catch {}
    if (server.exitCode != null) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(indexed, serverLog);
  // Lilly exists before the browsers open.
  const added = await (await fetch('http://127.0.0.1:' + port + '/api/users/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Lilly' }) })).json();
  assert.ok(added.inviteLink, JSON.stringify(added));
  const lillyToken = new URL(added.inviteLink).searchParams.get('token');

  browser = spawn(chromium, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(Error(log)), 10000);
    browser.stderr.on('data', b => { log += b; const m = log.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    browser.on('error', reject);
  });
  ws = new WebSocket(endpoint); await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(), exceptions = [];
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  // One person = one browser context (its own cookies).
  async function person(signInUrl) {
    const ctx = await send('Target.createBrowserContext');
    const target = await send('Target.createTarget', { url: 'about:blank', browserContextId: ctx.result.browserContextId });
    const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true }), sid = attached.result.sessionId;
    await send('Runtime.enable', {}, sid);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sid);
    const evaluate = async expression => {
      const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
      assert.ok(!out.result?.exceptionDetails, expression + '\n' + JSON.stringify(out.result));
      return out.result?.result?.value;
    };
    const go = async url => { await send('Page.navigate', { url }, sid); };
    const until = async (expr, ms = 8000) => { const t0 = Date.now(); for (;;) { let v = null; try { v = await evaluate(expr); } catch {} if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + expr + '\n' + exceptions.join('\n') + '\n' + serverLog.slice(-2000)); await new Promise(r => setTimeout(r, 60)); } };
    await go(signInUrl);
    await until('document.readyState === "complete" && location.search === ""');
    return { evaluate, go, until };
  }
  const owner = await person(base + '/?token=install-tok');
  const lilly = await person(base + '/?token=' + encodeURIComponent(lillyToken));

  // The header chip names each person, and shows the other one arriving.
  await owner.until('window.chatteringMe && window.chatteringMe.role === "owner"');
  await lilly.until('window.chatteringMe && window.chatteringMe.name === "Lilly"');
  // Quiet self-presence: my own bubble is the settings button; the people
  // button shows only the others.
  await owner.until('document.querySelector("#peopleBtn.has-others .user-bubble:not(.me)")');
  assert.equal(await owner.evaluate('document.querySelector("#settingsBtn .user-bubble.me").textContent'), await owner.evaluate('window.chatteringMe.glyph'));
  assert.equal(await lilly.evaluate('document.querySelector("#settingsBtn .user-bubble.me").textContent'), 'L');
  assert.equal(await owner.evaluate('document.querySelectorAll("#peopleBtn .user-bubble.me").length'), 0);

  // Both open the same conversation; Lilly types; the owner's box follows,
  // with Lilly's name over her caret and "typing" in the header.
  await owner.go(base + '/#' + encodeURIComponent(key));
  await lilly.go(base + '/#' + encodeURIComponent(key));
  await owner.until('document.querySelector("#agentText") && composeShare && composeShare.name === "compose:' + key + '"');
  await lilly.until('document.querySelector("#agentText") && composeShare && composeShare.name === "compose:' + key + '"');
  await lilly.evaluate(`const ta = document.querySelector('#agentText'); ta.focus(); ta.value = 'Lilly says: build a garden'; ta.setSelectionRange(ta.value.length, ta.value.length); ta.dispatchEvent(new Event('input', { bubbles: true })); true`);
  await owner.until(`document.querySelector('#agentText').value === 'Lilly says: build a garden'`);
  await owner.until(`document.querySelector('#composePeople .collab-people-label')?.textContent.includes('Lilly')`);
  await owner.until(`document.querySelector('.collab-caret .collab-caret-name')?.textContent === 'Lilly'`);
  await owner.until(`!document.querySelector('#convPresence').hidden && document.querySelector('#convPresence').textContent.includes('Lilly')`);
  // The owner adds to the same sentence at the front; both converge.
  await owner.evaluate(`const ta = document.querySelector('#agentText'); ta.focus(); ta.setSelectionRange(0, 0); ta.value = 'Maxime agrees. ' + ta.value; ta.dispatchEvent(new Event('input', { bubbles: true })); true`);
  await lilly.until(`document.querySelector('#agentText').value === 'Maxime agrees. Lilly says: build a garden'`);
  // The shared text survives a re-render of the composer.
  await owner.evaluate('renderConv("preserve")');
  await owner.until(`document.querySelector('#agentText').value === 'Maxime agrees. Lilly says: build a garden' && composeShare && composeShare.ta === document.querySelector('#agentText')`);

  // The file editor: one text, cursors, disk follows.
  const file = path.join(work, 'code.js');
  const fileHash = '#file&p=shared&focus&path=' + file;
  await owner.go(base + '/' + fileHash);
  await lilly.go(base + '/' + fileHash);
  try { await owner.until('!!(fileWs && fileWs.collab && fileWs.editor)'); }
  catch (e) { throw new Error(e.message + '\nstate: ' + JSON.stringify(await owner.evaluate('({ kind: viewKind, ws: fileWs && { path: fileWs.path, kind: fileWs.kind, collab: !!fileWs.collab, editor: !!fileWs.editor, ro: fileWs.readOnly }, status: document.querySelector("#docStatus")?.textContent, me: !!window.chatteringMe, join: typeof collabJoin })'))); }
  await lilly.until('!!(fileWs && fileWs.collab && fileWs.editor)');
  assert.equal(await owner.evaluate(`document.querySelector('#fwSave').disabled`), false, 'Save on a shared file means "write it now"');
  await lilly.evaluate("fileWs.editor.view.dispatch({ changes: { from: fileWs.editor.view.state.doc.length, insert: 'const lilly = 2;\\n' } }); true");
  await owner.until("fileWs.editor.getContent() === 'const a = 1;\\nconst lilly = 2;\\n'");
  for (let i = 0; i < 100 && fs.readFileSync(file, 'utf8') !== 'const a = 1;\nconst lilly = 2;\n'; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(fs.readFileSync(file, 'utf8'), 'const a = 1;\nconst lilly = 2;\n', 'the disk follows the shared text');
  // An agent's write on disk lands in both editors without losing the owner's caret line.
  fs.writeFileSync(file, '// by an agent\nconst a = 1;\nconst lilly = 2;\n');
  await owner.until(`fileWs.editor.getContent().startsWith('// by an agent')`, 12000);
  await lilly.until(`fileWs.editor.getContent().startsWith('// by an agent')`, 12000);
  assert.ok((await owner.evaluate(`document.querySelector('#docStatus').textContent`)).includes('Shared'));

  // Hiding "secret": Lilly's lists drop it, the owner keeps it.
  await owner.go(base + '/#project=secret');
  await owner.until(`!document.querySelector('#shareBtn').hidden`);
  await owner.evaluate(`postJson('/api/access', { project: 'secret', mode: 'listed' })`);
  await lilly.go(base + '/');
  await lilly.until(`sessions.length === 1 && sessions[0].project === 'shared'`);
  await owner.go(base + '/');
  await owner.until(`sessions.length === 2`);
  assert.equal(await lilly.evaluate(`fetch('/api/project?name=secret').then(r => r.json()).then(d => d.error)`), 'This project is not shared with you.');
  // The "mine" filter: Lilly wrote nothing recorded; the owner owns the rest.
  assert.equal(await lilly.evaluate(`sessions.filter(s => sessionInvolves(s, window.chatteringMe.id)).length`), 0);
  assert.equal(await owner.evaluate(`sessions.filter(s => sessionInvolves(s, window.chatteringMe.id)).length`), 2);
  // Settings → people: the owner manages, Lilly only sees herself and her own link button.
  await owner.go(base + '/#settings=people');
  await owner.until(`document.querySelectorAll('#setPeopleList .person-row').length === 2`);
  assert.equal(await owner.evaluate(`!!document.querySelector('#setPersonAdd')`), true);
  assert.equal(await owner.evaluate(`document.querySelectorAll('#setPeopleList .person-row [data-act=remove]').length`), 1, 'only Lilly can be removed');
  await lilly.go(base + '/#settings=people');
  await lilly.until(`document.querySelectorAll('#setPeopleList .person-row').length === 2`);
  assert.equal(await lilly.evaluate(`!!document.querySelector('#setPersonAdd')`), false);
  assert.equal(await lilly.evaluate(`document.querySelectorAll('#setPeopleList [data-act=invite]').length`), 1, 'a member makes links only for herself');
  await lilly.go(base + '/#settings=model');
  await lilly.until(`!!document.querySelector('.settings-pane .set-readonly')`);
  // The share dialog on the conversation, opened by the owner.
  await owner.go(base + '/#' + encodeURIComponent(key));
  await owner.until(`!document.querySelector('#shareBtn').hidden`);
  await owner.evaluate(`openShareDialog()`);
  await owner.until(`!!document.querySelector('.share-dialog select[data-subject="user:' + window.chatteringMe.id.replace(window.chatteringMe.id, '') + '"]') || document.querySelectorAll('.share-dialog select[data-subject]').length === 1`);
  assert.equal(await owner.evaluate(`document.querySelector('.share-dialog h3').textContent`), 'Who can see this conversation');
  await owner.evaluate(`document.querySelector('#shareClose').click(); true`);

  // ---- the people panel: where Lilly is, "go", and following her ----
  // Lilly opens the shared conversation; the owner, on the home page, sees
  // her in the people button, opens the panel, and goes where she is.
  await owner.go(base + '/');
  await lilly.go(base + '/#' + encodeURIComponent(key));
  await lilly.until('viewKind === "conversation" && activeRel === ' + JSON.stringify(key));
  await owner.until(`peopleOthersHere().some(p => p.route === 'conversation:' + ${JSON.stringify(key)})`);
  await owner.evaluate('togglePeoplePanel(true); true');
  await owner.until(`document.querySelector('#peoplePanel .pp-row b')?.textContent === 'Lilly'`);
  assert.match(await owner.evaluate(`document.querySelector('#peoplePanel .pp-row .hint').textContent`), /reading · “/);
  await owner.evaluate(`document.querySelector('#peoplePanel [data-pp=go]').click(); true`);
  await owner.until('viewKind === "conversation" && activeRel === ' + JSON.stringify(key));
  assert.equal(await owner.evaluate('!!document.querySelector("#peoplePanel")'), false, 'go closes the panel');

  // Follow: Lilly moves to the file; the owner arrives there by himself.
  await owner.evaluate(`peopleStartFollowing(peopleOthersHere().find(p => p.user.name === 'Lilly')); true`);
  await owner.until(`document.querySelector('#followChip')?.textContent.includes('following Lilly')`);
  await lilly.go(base + '/' + fileHash);
  await lilly.until('!!(fileWs && fileWs.editor)');
  await owner.until('viewKind === "file" && fileWs && fileWs.path === ' + JSON.stringify(file), 12000);
  assert.ok(await owner.evaluate('!!peopleFollow'), 'arriving by follow keeps following');
  // The file head and the file rows mark her presence.
  await owner.until(`[...document.querySelectorAll('.live-file-head [data-presence-file]')].some(el => !el.hidden && el.textContent.includes('L'))`);
  // Lilly moves her cursor: the owner's editor follows her line.
  await lilly.evaluate(`fileWs.editor.gotoLine(3); peopleEditorTick(); true`);
  await owner.until('peopleOthersHere().find(p => p.user.name === "Lilly")?.position?.line === 3', 8000);
  await owner.until('fileWs && fileWs.editor && fileWs.editor.selection().line === 3', 8000);
  // The owner navigates on his own: following ends.
  await owner.go(base + '/');
  await owner.until('viewKind !== "file"');
  await owner.until('!peopleFollow && !document.querySelector("#followChip")');
  // The project page says who is in the project right now.
  await owner.go(base + '/#project=shared');
  await owner.until(`document.querySelector('#pHereNow') && !document.querySelector('#pHereNow').hidden && document.querySelector('#pHereNow').textContent.includes('Lilly')`, 8000);
  // And what she did here: the file she saved by hand, opening on click.
  await owner.until(`document.querySelector('#pPeopleDid') && !document.querySelector('#pPeopleDid').hidden && document.querySelector('#pPeopleDid .pdid-person[open] .pdid-name')?.textContent === 'Lilly'`, 12000);
  assert.match(await owner.evaluate(`document.querySelector('#pPeopleDid .pdid-counts').textContent`), /1 file/);
  assert.match(await owner.evaluate(`document.querySelector('#pPeopleDid [data-file]').textContent`), /code\.js[\s\S]*saved by hand/);
  await owner.evaluate(`document.querySelector('#pPeopleDid [data-file]').click(); true`);
  await owner.until('viewKind === "file" && fileWs && fileWs.path === ' + JSON.stringify(file), 12000);
  // Lilly's own project page: the owner saved nothing recorded, so nothing to show — and never herself.
  await lilly.go(base + '/#project=shared');
  await lilly.until(`document.querySelector('#pHereNow') && document.querySelector('#pTitleBig')`, 8000);
  await new Promise(r => setTimeout(r, 800));
  assert.equal(await lilly.evaluate(`document.querySelector('#pPeopleDid').hidden`), true);

  assert.deepEqual(exceptions.filter(e => !/ResizeObserver/.test(e)), [], 'no uncaught errors in either browser');
});
