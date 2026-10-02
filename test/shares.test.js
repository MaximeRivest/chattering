'use strict';
// Shared links (design/92): the store and its secrets, then a real server
// with a real visitor: the gate, the pictures rule, the live text reaching
// the file, a viewer who cannot write, a name nobody can fake, and links
// that end at once; then the page in a real browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { ShareStore, createShareGate, makeBudget } = require('../shares.js');
const yjs = require('../vendor/yjs-server/13.6.29/yjs-server.cjs');
const { chromiumBinary, chromiumAvailable } = require('./helpers/chromium.js');

const { Y, syncProtocol, awarenessProtocol, encoding, decoding } = yjs;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const until = async (fn, label, ms = 10000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timeout: ' + label); await sleep(25); } };

test('the store: ids fit a host name, links can be copied again, a new link ends the old one and its sessions', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shares-')));
  try {
    let now = 1_000_000;
    const opts = { file: path.join(dir, 'shares.json'), keyFile: path.join(dir, 'key'), now: () => now };
    const a = new ShareStore(opts);
    if (process.platform !== 'win32') assert.equal(fs.statSync(opts.keyFile).mode & 0o777, 0o600);
    const s = a.create({ path: '/tmp/x/notes.md', role: 'edit', createdBy: 'u_me' });
    assert.match(s.id, /^[a-z2-7]{16}$/);
    const secret = a.secretOf(s);
    assert.match(secret, /^[A-Za-z0-9_-]{22}$/);
    // After a restart: the same link, the same session.
    const b = new ShareStore(opts);
    assert.equal(b.secretOf(b.get(s.id)), secret);
    assert.equal(b.verifySecret(s.id, secret).id, s.id);
    assert.equal(b.verifySecret(s.id, secret.slice(0, -1) + (secret.endsWith('A') ? 'B' : 'A')), null);
    assert.equal(b.verifySecret('aaaaaaaaaaaaaaaa', secret), null);
    const sess = b.issueSession(b.get(s.id));
    assert.equal(b.readSession(s.id, sess.value).visitorId, sess.visitorId);
    assert.equal(b.readSession('aaaaaaaaaaaaaaaa', sess.value), null, 'a session opens its own share only');
    const [body, mac] = sess.value.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), s: 'bbbbbbbbbbbbbbbb' })).toString('base64url') + '.' + mac;
    assert.equal(b.readSession('bbbbbbbbbbbbbbbb', forged), null);
    // A new link: the old secret and its sessions stop.
    b.change(s.id, { newSecret: true });
    assert.equal(b.verifySecret(s.id, secret), null);
    assert.equal(b.readSession(s.id, sess.value), null);
    assert.notEqual(b.secretOf(b.get(s.id)), secret);
    // Expiry and revocation.
    const t = b.create({ path: '/tmp/x/b.md', role: 'view', createdBy: 'u_me', expiresAt: now + 1000 });
    const ts = b.secretOf(t);
    assert.ok(b.verifySecret(t.id, ts));
    now += 1001;
    assert.equal(b.verifySecret(t.id, ts), null, 'expired');
    assert.throws(() => b.create({ path: '/tmp/x/c.md', role: 'view', createdBy: 'u_me', expiresAt: now - 1 }), /future/);
    assert.throws(() => b.create({ path: '/tmp/x/c.md', role: 'own', createdBy: 'u_me' }), /view or edit/);
    b.revoke(s.id);
    assert.equal(b.active(s.id), null);
    assert.equal(new ShareStore(opts).active(s.id), null, 'revocation is saved');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a visitor budget: a burst closes, the next minute opens again', () => {
  const b = makeBudget({ bytes: 100, perMs: 50 });
  assert.equal(b.take(60), true);
  assert.equal(b.take(60), false);
});

// A y-websocket client in Node, with the headers a browser would send.
function client(url, headers) {
  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  const ws = new WebSocket(url, { headers });
  ws.binaryType = 'arraybuffer';
  const send = enc => { if (ws.readyState === 1) ws.send(encoding.toUint8Array(enc)); };
  const state = { synced: false, closed: null };
  ws.onmessage = ev => {
    const dec = decoding.createDecoder(new Uint8Array(ev.data));
    const type = decoding.readVarUint(dec);
    if (type === 0) {
      const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0);
      const sub = syncProtocol.readSyncMessage(dec, enc, ydoc, ws);
      if (sub === syncProtocol.messageYjsSyncStep2) state.synced = true;
      if (encoding.length(enc) > 1) send(enc);
    } else if (type === 1) awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), ws);
  };
  ws.onclose = ev => { state.closed = ev.code; };
  const ready = new Promise((res, rej) => {
    ws.onopen = () => { const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); syncProtocol.writeSyncStep1(enc, ydoc); send(enc); res(); };
    ws.onerror = () => rej(new Error('ws error'));
  });
  ydoc.on('update', (update, origin) => { if (origin === ws) return; const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 0); syncProtocol.writeUpdate(enc, update); send(enc); });
  awareness.on('update', ({ added, updated, removed }) => { const enc = encoding.createEncoder(); encoding.writeVarUint(enc, 1); encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, added.concat(updated, removed))); send(enc); });
  return { ydoc, awareness, ws, ready, state, text: () => ydoc.getText('content').toString(), close: () => { try { ws.close(); } catch {} awareness.destroy(); ydoc.destroy(); } };
}

test('a real server: the gate, pictures, live edits on disk, viewers, names, ending a link', { timeout: 120000 }, async t => {
  const root = path.join(__dirname, '..'), home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shares-srv-')));
  const agent = path.join(home, '.pi/agent'), sessions = path.join(agent, 'sessions/fixture'), work = path.join(home, 'work');
  const docs = path.join(work, 'docs'), other = path.join(work, 'private');
  fs.mkdirSync(sessions, { recursive: true }); fs.mkdirSync(path.join(docs, 'img'), { recursive: true }); fs.mkdirSync(other, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: work });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(docs, 'notes.md'), '# Plan\n\nFirst line.\n\n![frog](img/frog.png)\n');
  fs.writeFileSync(path.join(docs, 'img', 'frog.png'), png);
  fs.writeFileSync(path.join(docs, 'secrets.txt'), 'not a picture');
  fs.writeFileSync(path.join(other, 'private.png'), png);
  fs.symlinkSync(path.join(other, 'private.png'), path.join(docs, 'img', 'leak.png'));
  fs.writeFileSync(path.join(sessions, 'chat.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'fixture', cwd: work }) + '\n' +
    JSON.stringify({ type: 'message', id: 'q1', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n');

  let server, browser, cdp;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer);
  };
  const clients = [];
  t.after(async () => { for (const c of clients) c.close(); cdp?.close(); await require('./helpers/cleanup.js').stopAndRemove(browser, null); await stop(server); await require('./helpers/cleanup.js').stopAndRemove(null, home); });

  const port = await freePort(), previewPort = await freePort();
  const base = 'http://127.0.0.1:' + port, pv = 'http://127.0.0.1:' + previewPort, token = 'share-test-token', auth = { Authorization: 'Bearer ' + token };
  let log = '';
  require('./helpers/first-run.js').answerFirstRun(home);
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_PREVIEW_PORT: String(previewPort),
    CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_TOKEN: token, CHATTERING_NO_SYNC: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'),
    CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    try { ready = (await (await fetch(base + '/api/sessions', { headers: auth })).json()).some(s => s.key === 'pi:fixture/chat.jsonl'); } catch {}
    if (!ready) await sleep(100);
  }
  assert.ok(ready, log);
  const api = async (p, body) => { const r = await fetch(base + p, body ? { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: auth }); return { status: r.status, body: await r.json().catch(() => null) }; };

  // ---- the owner shares a document --------------------------------------
  const doc = path.join(docs, 'notes.md');
  assert.equal((await api('/api/shares', { path: path.join(docs, 'secrets.txt'), role: 'view' })).status, 400, 'only Markdown documents');
  assert.equal((await api('/api/shares', { path: '/etc/passwd', role: 'view' })).status, 400, 'only files of a project');
  let made = await api('/api/shares', { path: doc, role: 'edit' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const share = made.body.share;
  assert.equal(share.role, 'edit');
  const local = share.links.find(l => l.where === 'local');
  assert.ok(local, JSON.stringify(share.links));
  const secret = local.url.split('#')[1];
  assert.match(local.url, new RegExp(`/s/${share.id}/#`));
  assert.equal((await api('/api/shares?path=' + encodeURIComponent(doc))).body.shares.length, 1);

  // ---- the page and the gate --------------------------------------------
  let r = await fetch(pv + '/s/' + share.id + '/');
  const page = await r.text();
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self';/);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(r.headers.get('set-cookie'), null);
  assert.equal(await (await fetch(pv + '/s/aaaaaaaaaaaaaaaa/')).text(), page, 'an unknown share looks the same');
  const open = (body, headers = {}) => fetch(pv + '/s/' + share.id + '/open', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await open({ secret: 'x'.repeat(22) })).status, 404);
  assert.equal((await open({ secret }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'another site cannot open it');
  assert.equal((await open({})).status, 401);
  r = await open({ secret });
  assert.equal(r.status, 200);
  const info = await r.json();
  assert.equal(info.title, 'notes.md');
  assert.equal(info.role, 'edit');
  assert.equal(info.fileName, 'notes.md');
  assert.ok(!JSON.stringify(info).includes(work), 'the visitor never learns where the file is');
  const setCookie = r.headers.get('set-cookie');
  assert.match(setCookie, new RegExp(`^chattering_share_${share.id}=`));
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, new RegExp(`Path=/s/${share.id}/`));
  const cookie = setCookie.split(';')[0];
  // Reopening without the '#' part works with the session.
  assert.equal((await open({}, { Cookie: cookie })).status, 200);

  // ---- pictures: beside the document only, and only pictures --------------
  const asset = src => fetch(pv + '/s/' + share.id + '/asset?src=' + encodeURIComponent(src), { headers: { Cookie: cookie } });
  r = await asset('img/frog.png');
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
  assert.equal((await fetch(pv + '/s/' + share.id + '/asset?src=img/frog.png')).status, 401, 'no session, no picture');
  assert.equal((await asset('../private/private.png')).status, 404, 'outside the folder');
  assert.equal((await asset('img/leak.png')).status, 404, 'a link leading outside');
  assert.equal((await asset('secrets.txt')).status, 404, 'not a picture');
  assert.equal((await asset(path.join(other, 'private.png'))).status, 404, 'an absolute path');
  assert.equal((await asset('file:///etc/passwd')).status, 404);

  // ---- live: a visitor edits, the file follows; names are the server's ------
  const wsUrl = `ws://127.0.0.1:${previewPort}/s/${share.id}/collab?name=Ada`;
  const origin = `http://127.0.0.1:${previewPort}`;
  const evil = client(wsUrl, { Cookie: cookie, Origin: 'https://evil.example' }), bare = client(wsUrl, { Origin: origin });
  clients.push(evil, bare);
  await assert.rejects(evil.ready, 'another site cannot open the socket');
  await assert.rejects(bare.ready, 'no session, no socket');
  const ada = client(wsUrl, { Cookie: cookie, Origin: origin }); clients.push(ada);
  await ada.ready;
  await until(() => ada.state.synced && ada.text().includes('First line.'), 'the text arrives');
  // She claims to be Maxime: everyone sees her as herself, via the link.
  ada.awareness.setLocalStateField('user', { id: 'u_owner', name: 'Maxime', color: '#000000' });
  ada.ydoc.getText('content').insert(ada.text().indexOf('First line.'), 'Ada was here. ');
  await until(() => fs.readFileSync(doc, 'utf8').includes('Ada was here. First line.'), 'the edit reaches the file', 15000);

  // A viewer: same live text, cannot write.
  const viewShare = (await api('/api/shares', { path: doc, role: 'view' })).body.share;
  const vSecret = viewShare.links.find(l => l.where === 'local').url.split('#')[1];
  r = await fetch(pv + '/s/' + viewShare.id + '/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: vSecret }) });
  assert.equal(r.status, 200);
  const vCookie = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(pv + '/s/' + share.id + '/asset?src=img/frog.png', { headers: { Cookie: vCookie } })).status, 401, 'one share\u2019s session opens no other');
  const bob = client(`ws://127.0.0.1:${previewPort}/s/${viewShare.id}/collab?name=Bob`, { Cookie: vCookie, Origin: origin }); clients.push(bob);
  await bob.ready;
  await until(() => bob.state.synced && bob.text().includes('Ada was here.'), 'the viewer sees the live text');
  const names = () => [...bob.awareness.getStates().values()].map(s => s.user && s.user.name).filter(Boolean);
  await until(() => names().includes('Ada (via link)'), 'Ada shows as herself');
  assert.ok(!names().includes('Maxime'), 'nobody can take another name: ' + names());
  bob.ydoc.getText('content').insert(0, 'BOB WRITES ');
  ada.ydoc.getText('content').insert(ada.text().length, '\nMore from Ada.\n');
  await until(() => fs.readFileSync(doc, 'utf8').includes('More from Ada.'), 'later edits land', 15000);
  await sleep(600);
  assert.ok(!fs.readFileSync(doc, 'utf8').includes('BOB WRITES'), 'a viewer\u2019s edits are dropped');
  assert.ok(!ada.text().includes('BOB WRITES'));

  // An agent (or the owner) writes the file: visitors see it live.
  fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8') + '\nWritten on the computer.\n');
  await until(() => ada.text().includes('Written on the computer.'), 'a change on disk reaches visitors', 15000);

  // The view link becomes an edit link: its people are disconnected to
  // reconnect with the new role.
  assert.equal((await api('/api/shares/change', { id: viewShare.id, role: 'edit' })).status, 200);
  await until(() => bob.state.closed === 4403, 'the viewer is told the link changed');

  // ---- ending a link ------------------------------------------------------
  assert.equal((await api('/api/shares/revoke', { id: share.id })).status, 200);
  await until(() => ada.state.closed === 4403, 'a turned-off link closes its live connections');
  assert.equal((await open({ secret })).status, 404);
  assert.equal((await asset('img/frog.png')).status, 401);
  assert.equal((await api('/api/shares?path=' + encodeURIComponent(doc))).body.shares.length, 1, 'the turned-off link is not listed');
  // A new link for the other share: the old one stops.
  const before = (await api('/api/shares?path=' + encodeURIComponent(doc))).body.shares[0];
  const oldUrl = before.links.find(l => l.where === 'local').url;
  const after = (await api('/api/shares/change', { id: viewShare.id, newSecret: true })).body.share;
  assert.notEqual(after.links.find(l => l.where === 'local').url, oldUrl);
  assert.equal((await fetch(pv + '/s/' + viewShare.id + '/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: vSecret }) })).status, 404);

  // ---- in a browser: the owner makes a link, a visitor uses it ----------------
  if (!chromiumAvailable()) return t.skip('chromium is not installed');
  browser = spawn(chromiumBinary(), [...require('./helpers/chromium.js').CHROMIUM_TEST_FLAGS, '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(Error(out)), 10000);
    browser.stderr.on('data', b => { out += b; const m = out.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
  });
  cdp = new WebSocket(endpoint); await new Promise(res => cdp.onopen = res);
  let id = 0; const pending = new Map(), problems = new Map();
  const problem = (sidOf, text) => { if (!problems.has(sidOf)) problems.set(sidOf, []); problems.get(sidOf).push(text); };
  cdp.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') problem(m.sessionId, m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && /Content Security Policy|Refused/.test(m.params.entry.text)) problem(m.sessionId, m.params.entry.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problem(m.sessionId, m.params.args.map(a => a.value || a.description).join(' '));
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(res => { pending.set(++id, res); cdp.send(JSON.stringify({ id, method, params, sessionId })); });
  const tab = async () => {
    const target = await send('Target.createTarget', { url: 'about:blank' });
    const sid = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
    await send('Runtime.enable', {}, sid); await send('Page.enable', {}, sid); await send('Log.enable', {}, sid);
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, sid);
    const evaluate = async expression => {
      const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid);
      assert.ok(!out.result?.exceptionDetails, JSON.stringify(out.result?.exceptionDetails));
      return out.result?.result?.value;
    };
    const waitFor = (expression, label) => until(async () => await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`), label + '\n' + (problems.get(sid) || []).join('\n') + '\n' + log.slice(-1500), 20000);
    return { sid, evaluate, waitFor };
  };

  // The owner: the document's Share button, a new edit link, copied.
  const owner = await tab();
  await send('Page.navigate', { url: `http://localhost:${port}/?token=${token}` }, owner.sid);
  await owner.waitFor(`typeof openLiveFile === 'function' && typeof SharesUI === 'object' && sessions.length`, 'the app');
  await owner.evaluate(`openLiveFile(${JSON.stringify(doc)}, { project: 'work' }); 1`);
  await owner.waitFor(`document.getElementById('liveShare')`, 'the Share button');
  await owner.evaluate(`document.getElementById('liveShare').click(); 1`);
  await owner.waitFor(`document.getElementById('shCreate')`, 'the Share dialog');
  assert.match(await owner.evaluate(`document.querySelector('.sh-ui .dialog').textContent`), /Share “notes\.md”/);
  await owner.evaluate(`document.getElementById('shNewRole').value = 'edit'; document.getElementById('shCreate').click(); 1`);
  await owner.waitFor(`document.querySelector('.sh-ui-row .sh-ui-url') && /\\/s\\/[a-z2-7]{16}\\/#/.test(document.querySelector('.sh-ui-row .sh-ui-url').value)`, 'the new link in the dialog');
  assert.match(await owner.evaluate(`document.querySelector('.sh-ui-row select').value`), /^edit$/);
  const uiShareId = await owner.evaluate(`document.querySelector('.sh-ui-row').dataset.id`);
  const link = (await api('/api/shares?path=' + encodeURIComponent(doc))).body.shares.find(s => s.id === uiShareId).links.find(l => l.where === 'local').url;
  assert.deepEqual(problems.get(owner.sid) || [], [], 'the app shows no errors');

  // The visitor.
  const visitor = await tab();
  const { evaluate, waitFor } = visitor;
  await send('Page.navigate', { url: link }, visitor.sid);
  await waitFor(`document.getElementById('nameInput')`, 'the name question');
  assert.match(await evaluate(`document.getElementById('card').textContent`), /shared “notes\.md” with you/);
  await evaluate(`document.getElementById('nameInput').value = 'Grace'; document.querySelector('#nameForm button[type=submit]').click(); 1`);
  await waitFor(`document.querySelector('#doc .cm-content') && document.getElementById('state').textContent === 'Live'`, 'the live document');
  assert.match(await evaluate(`document.getElementById('sub').textContent`), /you can edit/);
  await waitFor(`[...document.querySelectorAll('#doc img')].some(i => i.naturalWidth > 0 && /\\/asset\\?src=img%2Ffrog\\.png/.test(i.src))`, 'the picture through the share');
  // Typing in the page reaches the file on the computer.
  await evaluate(`(() => { const c = document.querySelector('#doc .cm-content'); c.focus(); const s = getSelection(); s.selectAllChildren(c); s.collapseToEnd(); return 1; })()`);
  await send('Input.insertText', { text: '\nGrace typed this.\n' }, visitor.sid);
  await until(() => fs.readFileSync(doc, 'utf8').includes('Grace typed this.'), 'the browser edit reaches the file\n' + (problems.get(visitor.sid) || []).join('\n'), 15000);
  // The owner's dialog counts her; the owner turns the link off from it.
  await owner.evaluate(`SharesUI.open(${JSON.stringify(doc)}, 'notes.md'); 1`);
  await owner.waitFor(`/1 person here now/.test(document.querySelector('.sh-ui-row[data-id="${uiShareId}"]')?.textContent || '')`, 'the dialog says someone is here');
  await owner.evaluate(`window.confirm = () => true; document.querySelector('.sh-ui-row[data-id="${uiShareId}"] [data-act="revoke"]').click(); 1`);
  await waitFor(`/This link has ended/.test(document.getElementById('card').textContent)`, 'the page says the link ended');
  assert.deepEqual((problems.get(visitor.sid) || []).filter(p => !/WebSocket connection to .* failed|Failed to load resource/.test(p)), [], 'no script errors, nothing the page policy refused');
});
