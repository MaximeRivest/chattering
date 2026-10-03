'use strict';
// Public addresses (design/92): the relay reads only the name in a TLS hello
// and pipes bytes; the home gets its certificate from an ACME authority
// through the relay and ends TLS itself. With Pebble (Let's Encrypt's test
// server) when it is installed: `nix shell nixpkgs#pebble nixpkgs#openssl`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createRelay } = require('../anywhere/relay.js');
const { createSite, readSni, readProxyV2, validName } = require('../anywhere/site.js');
const { createSiteHome } = require('../site-home.js');
const P = require('../anywhere/protocol.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const until = async (fn, label, ms = 30000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timeout: ' + label); await sleep(50); } };
const which = bin => { const r = spawnSync('sh', ['-c', 'command -v ' + bin]); return r.status === 0 ? r.stdout.toString().trim() : null; };

function proxyV2(ip, port = 50000) {
  const sig = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
  const body = Buffer.alloc(12);
  ip.split('.').forEach((n, i) => body[i] = Number(n));
  [127, 0, 0, 1].forEach((n, i) => body[4 + i] = n);
  body.writeUInt16BE(port, 8); body.writeUInt16BE(443, 10);
  return Buffer.concat([sig, Buffer.from([0x21, 0x11, 0x00, 12]), body]);
}
// A real ClientHello, as a browser's TLS stack sends it.
async function captureHello(servername) {
  const srv = net.createServer();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const got = new Promise(r => srv.once('connection', s => { let b = Buffer.alloc(0); s.on('data', c => { b = Buffer.concat([b, c]); if (b.length > 100) { r(b); s.destroy(); } }); }));
  const c = tls.connect({ port: srv.address().port, host: '127.0.0.1', servername, rejectUnauthorized: false });
  c.on('error', () => {});
  const hello = await got; c.destroy(); srv.close();
  return hello;
}

test('the relay reads the name of a TLS hello, a PROXY header, and checks names', async () => {
  const hello = await captureHello('maxime.rockfrog.site');
  assert.equal(readSni(hello), 'maxime.rockfrog.site');
  assert.equal(readSni(hello.subarray(0, 20)), null, 'needs more bytes');
  assert.equal(readSni(Buffer.from('GET / HTTP/1.1\r\n\r\n')), false);
  const h = proxyV2('203.0.113.7');
  assert.deepEqual(readProxyV2(Buffer.concat([h, hello])), { ip: '203.0.113.7', size: 28 });
  assert.equal(readProxyV2(h.subarray(0, 10)), null);
  assert.equal(readProxyV2(hello), false);
  for (const ok of ['maxime', 'a1b', 'jardin-des-collines']) assert.ok(validName(ok), ok);
  for (const bad of ['ab', 'www', 'admin', 'xn--abc', '-abc', 'abc-', 'a--b', 'A'.repeat(31), 'Maxime', 'max.ime']) assert.ok(!validName(bad), bad);
  const site = createSite({ domain: 'rockfrog.site' });
  assert.equal(site.nameOfHost('maxime.rockfrog.site'), 'maxime');
  assert.equal(site.nameOfHost('abc123.maxime.rockfrog.site:443'), 'maxime');
  assert.equal(site.nameOfHost('rockfrog.site'), null);
  assert.equal(site.nameOfHost('maxime.rockfrog.site.evil.com'), null);
  site.close();
});

async function makeHomeKey() {
  const pair = await P.subtle().generateKey(P.ECDSA, true, ['sign', 'verify']);
  const spki = new Uint8Array(await P.subtle().exportKey('spki', pair.publicKey));
  const homeId = await P.homeIdOf(spki);
  return async () => ({ homeId, spki, sign: b => P.sign(pair.privateKey, b) });
}

test('with Pebble: a name, a certificate through the relay, visitors through the relay, TLS ending at home', { timeout: 120000 }, async t => {
  const pebble = which('pebble'), chall = which('pebble-challtestsrv'), openssl = which('openssl');
  if (!pebble || !chall || !openssl) return t.skip('pebble, pebble-challtestsrv and openssl are needed (nix shell nixpkgs#pebble nixpkgs#openssl)');
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'site-')));
  const procs = [];
  const homes = [];
  let relay;
  t.after(async () => {
    for (const h of homes) h.stop();
    if (relay) relay.close();
    for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // Pebble's own API needs https: a throwaway certificate for it.
  spawnSync(openssl, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', path.join(dir, 'api.key'), '-out', path.join(dir, 'api.crt')], { stdio: 'ignore' });
  const [httpPort, sitePort, acmePort, mgmtPort, dnsPort, challMgmt] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort(), freePort()]);
  fs.writeFileSync(path.join(dir, 'pebble.json'), JSON.stringify({ pebble: { listenAddress: '127.0.0.1:' + acmePort, managementListenAddress: '127.0.0.1:' + mgmtPort,
    certificate: path.join(dir, 'api.crt'), privateKey: path.join(dir, 'api.key'), httpPort, tlsPort: 5001, ocspResponderURL: '', externalAccountBindingRequired: false } }));
  let pebbleLog = '';
  procs.push(spawn(chall, ['-defaultIPv4', '127.0.0.1', '-defaultIPv6', '', '-dns01', '127.0.0.1:' + dnsPort, '-http01', '', '-https01', '', '-tlsalpn01', '', '-doh', '', '-management', '127.0.0.1:' + challMgmt], { stdio: 'ignore' }));
  const pb = spawn(pebble, ['-config', path.join(dir, 'pebble.json'), '-dnsserver', '127.0.0.1:' + dnsPort], { env: { ...process.env, PEBBLE_VA_NOSLEEP: '1', PEBBLE_WFE_NONCEREJECT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  pb.stdout.on('data', b => pebbleLog += b); pb.stderr.on('data', b => pebbleLog += b);
  procs.push(pb);
  const apiCa = fs.readFileSync(path.join(dir, 'api.crt'));
  await until(() => new Promise(r => { const q = https.get({ host: '127.0.0.1', port: acmePort, path: '/dir', ca: apiCa }, s => { s.resume(); r(s.statusCode === 200); }); q.on('error', () => r(false)); }), 'pebble', 20000);

  // The relay, with public addresses under rockfrog.test.
  const invitedIds = new Set();
  const site = createSite({ domain: 'rockfrog.test', namesFile: path.join(dir, 'names.json'), invited: id => invitedIds.has(id) });
  relay = createRelay({ env: {}, site });
  await new Promise(r => relay.server.listen(httpPort, '127.0.0.1', r));
  await new Promise(r => site.tcp.listen(sitePort, '127.0.0.1', r));

  const seen = [];
  const handler = (req, res) => {
    seen.push({ ip: req.socket.visitorIp, host: req.headers.host });
    if (req.url === '/big') { const big = crypto.randomBytes(3 * 1024 * 1024); res.writeHead(200, { 'Content-Length': big.length, 'X-Sha': crypto.createHash('sha256').update(big).digest('hex') }); return res.end(big); }
    if (req.method === 'POST') { const h = crypto.createHash('sha256'); let n = 0; req.on('data', c => { h.update(c); n += c.length; }); req.on('end', () => { res.end(JSON.stringify({ n, sha: h.digest('hex') })); }); return; }
    res.end('hello from home, visitor ' + req.socket.visitorIp + ', for ' + req.headers.host);
  };
  const mkHome = async (name, sub) => {
    const homeKey = await makeHomeKey();
    const home = createSiteHome({ dataDir: path.join(dir, sub), relayUrl: () => 'http://127.0.0.1:' + httpPort, wanted: () => true, desiredName: () => name, homeKey,
      handler, acmeDirectory: `https://127.0.0.1:${acmePort}/dir`, acmeCa: apiCa, ctCheck: false, heartbeatMs: 2000 });
    homes.push(home);
    return { home, homeId: (await homeKey()).homeId };
  };

  // Not invited: the name is refused, in words.
  const a = await mkHome('maxime', 'a');
  a.home.sync();
  await until(() => a.home.status().phase === 'refused', 'refused');
  assert.match(a.home.status().error, /by invitation/);
  // Invited: the name, then a certificate whose HTTP-01 check passed through the relay.
  invitedIds.add(a.homeId);
  a.home.stop();
  const b = await mkHome('maxime', 'b');
  invitedIds.add(b.homeId);
  b.home.sync();
  await until(() => b.home.status().phase === 'ready', 'ready: ' + JSON.stringify(b.home.status()) + '\n' + pebbleLog.slice(-1500), 60000);
  const st = b.home.status();
  assert.equal(st.url, 'https://maxime.rockfrog.test');
  assert.ok(st.certificate.notAfter > Date.now());
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'names.json'), 'utf8')).names.maxime, b.homeId);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'b', 'site.json'), 'utf8'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'b', 'site.json')).mode & 0o777, 0o600);
  assert.match(saved.certs['maxime.rockfrog.test'].key, /PRIVATE KEY/);
  // Another invited computer cannot take the name.
  const c = await mkHome('maxime', 'c');
  invitedIds.add(c.homeId);
  c.home.sync();
  await until(() => c.home.status().phase === 'refused', 'taken');
  assert.match(c.home.status().error, /taken/);
  c.home.stop();

  // The authority's root, to check the chain like a browser would.
  const root = await new Promise((res, rej) => https.get({ host: '127.0.0.1', port: mgmtPort, path: '/roots/0', rejectUnauthorized: false }, s => { let d = ''; s.on('data', x => d += x); s.on('end', () => res(d)); }).on('error', rej));

  // A visitor, as HAProxy hands them over: PROXY v2, then their TLS.
  const visit = (servername, ip, fn) => new Promise((resolve, reject) => {
    const raw = net.connect(sitePort, '127.0.0.1', () => {
      raw.write(proxyV2(ip));
      const s = tls.connect({ socket: raw, servername, ca: root, ALPNProtocols: ['http/1.1'] });
      s.on('error', reject);
      s.on('secureConnect', () => fn(s, resolve, reject));
    });
    raw.on('error', reject);
  });
  const get = (s, req) => new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    s.on('data', d => { buf = Buffer.concat([buf, d]); });
    s.on('end', () => resolve(buf));
    s.on('error', reject);
    s.write(req);
  });
  const res1 = await visit('maxime.rockfrog.test', '203.0.113.7', async (s, done) => {
    assert.equal(s.authorized, true, 'the certificate checks out against the authority: ' + s.authorizationError);
    assert.equal(s.getPeerCertificate().subjectaltname, 'DNS:maxime.rockfrog.test');
    done((await get(s, 'GET / HTTP/1.1\r\nHost: maxime.rockfrog.test\r\nConnection: close\r\n\r\n')).toString());
  });
  assert.match(res1, /hello from home, visitor 203\.0\.113\.7, for maxime\.rockfrog\.test/);
  // Large both ways: nothing lost, nothing stuck.
  const big = await visit('maxime.rockfrog.test', '203.0.113.8', async (s, done) => done(await get(s, 'GET /big HTTP/1.1\r\nHost: maxime.rockfrog.test\r\nConnection: close\r\n\r\n')));
  const sep = big.indexOf('\r\n\r\n'), head = big.subarray(0, sep).toString(), body = big.subarray(sep + 4);
  assert.equal(body.length, 3 * 1024 * 1024);
  assert.equal(crypto.createHash('sha256').update(body).digest('hex'), /x-sha: ([0-9a-f]+)/i.exec(head)[1]);
  const upload = crypto.randomBytes(2 * 1024 * 1024);
  const up = await visit('maxime.rockfrog.test', '203.0.113.9', async (s, done) => done((await get(s, Buffer.concat([Buffer.from(`POST /u HTTP/1.1\r\nHost: maxime.rockfrog.test\r\nContent-Length: ${upload.length}\r\nConnection: close\r\n\r\n`), upload]))).toString()));
  assert.equal(JSON.parse(up.slice(up.indexOf('\r\n\r\n') + 4)).sha, crypto.createHash('sha256').update(upload).digest('hex'));
  // Several at once.
  const many = await Promise.all([...Array(12)].map((_, i) => visit('maxime.rockfrog.test', '198.51.100.' + i, async (s, done) => done((await get(s, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).toString()))));
  assert.ok(many.every((r, i) => r.includes('visitor 198.51.100.' + i)));
  // A name nobody has, or no name: the connection just closes.
  const closes = servername => new Promise(resolve => {
    const raw = net.connect(sitePort, '127.0.0.1', () => {
      raw.write(proxyV2('203.0.113.1'));
      const s = tls.connect({ socket: raw, servername, rejectUnauthorized: false });
      s.on('error', () => resolve(true)); s.on('close', () => resolve(true)); s.on('secureConnect', () => resolve(false));
    });
  });
  assert.equal(await closes('nobody.rockfrog.test'), true);
  assert.equal(await closes('maxime.example.com'), true);
  // The relay never held the certificate's key.
  assert.ok(!fs.readdirSync(dir).some(f => /key/.test(f) && f !== 'api.key'));

  // The home goes away: its address stops at once.
  b.home.stop();
  await until(() => !relay.site.homes.has(b.homeId), 'the relay forgets the home');
  assert.equal(await closes('maxime.rockfrog.test'), true);
});

test('the whole way: Chattering turns on its public address, a browser opens a shared link through the relay and edits the file', { timeout: 180000 }, async t => {
  const pebble = which('pebble'), chall = which('pebble-challtestsrv'), openssl = which('openssl');
  const { chromiumBinary, chromiumAvailable, CHROMIUM_TEST_FLAGS } = require('./helpers/chromium.js');
  if (!pebble || !chall || !openssl) return t.skip('pebble, pebble-challtestsrv and openssl are needed (nix shell nixpkgs#pebble nixpkgs#openssl)');
  if (!chromiumAvailable()) return t.skip('chromium is not installed');
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'site-app-')));
  const procs = [];
  let relay, server, browser, cdp;
  const stop = async child => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000); await exited; clearTimeout(timer);
  };
  t.after(async () => {
    cdp?.close();
    await require('./helpers/cleanup.js').stopAndRemove(browser, null);
    await stop(server);
    if (relay) relay.close();
    for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
    await require('./helpers/cleanup.js').stopAndRemove(null, home);
  });
  spawnSync(openssl, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', path.join(home, 'api.key'), '-out', path.join(home, 'api.crt')], { stdio: 'ignore' });
  const [httpPort, sitePort, acmePort, mgmtPort, dnsPort, challMgmt, port, previewPort] = await Promise.all([...Array(8)].map(freePort));
  fs.writeFileSync(path.join(home, 'pebble.json'), JSON.stringify({ pebble: { listenAddress: '127.0.0.1:' + acmePort, managementListenAddress: '127.0.0.1:' + mgmtPort,
    certificate: path.join(home, 'api.crt'), privateKey: path.join(home, 'api.key'), httpPort, tlsPort: 5001, ocspResponderURL: '', externalAccountBindingRequired: false } }));
  procs.push(spawn(chall, ['-defaultIPv4', '127.0.0.1', '-defaultIPv6', '', '-dns01', '127.0.0.1:' + dnsPort, '-http01', '', '-https01', '', '-tlsalpn01', '', '-doh', '', '-management', '127.0.0.1:' + challMgmt], { stdio: 'ignore' }));
  procs.push(spawn(pebble, ['-config', path.join(home, 'pebble.json'), '-dnsserver', '127.0.0.1:' + dnsPort], { env: { ...process.env, PEBBLE_VA_NOSLEEP: '1', PEBBLE_WFE_NONCEREJECT: '0' }, stdio: 'ignore' }));
  const apiCa = fs.readFileSync(path.join(home, 'api.crt'));
  await until(() => new Promise(r => { const q = https.get({ host: '127.0.0.1', port: acmePort, path: '/dir', ca: apiCa }, s => { s.resume(); r(s.statusCode === 200); }); q.on('error', () => r(false)); }), 'pebble', 20000);
  const site = createSite({ domain: 'rockfrog.test', namesFile: path.join(home, 'names.json'), invited: () => true });
  relay = createRelay({ env: {}, site });
  await new Promise(r => relay.server.listen(httpPort, '127.0.0.1', r));
  await new Promise(r => site.tcp.listen(sitePort, '127.0.0.1', r));

  // Chattering, with a project holding a document, pointed at this relay.
  const agent = path.join(home, '.pi/agent'), sessions = path.join(agent, 'sessions/fixture'), work = path.join(home, 'work');
  fs.mkdirSync(sessions, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: work });
  const doc = path.join(work, 'plan.md');
  fs.writeFileSync(doc, '# Plan\n\nFrom the computer.\n');
  fs.writeFileSync(path.join(sessions, 'chat.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'fixture', cwd: work }) + '\n' +
    JSON.stringify({ type: 'message', id: 'q1', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n');
  require('./helpers/first-run.js').answerFirstRun(home);
  const { appDir } = require('./helpers/home-env.js');
  const cfg = appDir(home, 'config');
  fs.mkdirSync(cfg, { recursive: true });
  const settingsFile = path.join(cfg, 'settings.json');
  const prev = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) : {};
  fs.writeFileSync(settingsFile, JSON.stringify({ ...prev, anywhere: { relay: 'http://127.0.0.1:' + httpPort } }));
  const token = 'site-app-token', auth = { Authorization: 'Bearer ' + token }, base = 'http://127.0.0.1:' + port;
  let log = '';
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_PREVIEW_PORT: String(previewPort),
    CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_TOKEN: token, CHATTERING_NO_SYNC: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'),
    CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    CHATTERING_ACME_DIRECTORY: `https://127.0.0.1:${acmePort}/dir`, CHATTERING_ACME_CA_FILE: path.join(home, 'api.crt') }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  await until(async () => { try { return (await (await fetch(base + '/api/sessions', { headers: auth })).json()).some(s => s.key === 'pi:fixture/chat.jsonl'); } catch { return false; } }, 'the server\n' + log);
  const api = async (p, body) => { const r = await fetch(base + p, body ? { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: auth }); return { status: r.status, body: await r.json().catch(() => null) }; };

  assert.equal((await api('/api/public-links', { on: true, name: 'admin' })).status, 400, 'a kept name');
  assert.equal((await api('/api/public-links', { on: true, name: 'maxime' })).status, 200);
  await until(async () => (await api('/api/public-links')).body.phase === 'ready', 'the public address is ready\n' + JSON.stringify((await api('/api/public-links')).body) + '\n' + log.slice(-2000), 60000);
  assert.equal((await api('/api/public-links')).body.url, 'https://maxime.rockfrog.test');
  const share = (await api('/api/shares', { path: doc, role: 'edit' })).body.share;
  const link = share.links[0];
  assert.equal(link.where, 'public');
  assert.match(link.url, new RegExp(`^https://maxime\\.rockfrog\\.test/s/${share.id}/#`));

  // Nothing but shared links answers on the public address.
  const leafPem = JSON.parse(fs.readFileSync(path.join(appDir(home, 'data'), 'site.json'), 'utf8')).certs['maxime.rockfrog.test'].cert;
  const spki = crypto.createHash('sha256').update(new crypto.X509Certificate(leafPem).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const raw = await new Promise((resolve, reject) => {
    const s = tls.connect({ port: sitePort, host: '127.0.0.1', servername: 'maxime.rockfrog.test', rejectUnauthorized: false }, () => {
      let b = ''; s.on('data', d => b += d); s.on('end', () => resolve(b));
      s.write('GET /api/sessions HTTP/1.1\r\nHost: maxime.rockfrog.test\r\nAuthorization: Bearer ' + token + '\r\nConnection: close\r\n\r\n');
    });
    s.on('error', reject);
  });
  assert.match(raw, /^HTTP\/1\.1 404/, 'the app is not on the public address, even with its token');
  assert.match(raw, /strict-transport-security/i);

  // A visitor's browser, which resolves the name to the relay.
  browser = spawn(chromiumBinary(), [...CHROMIUM_TEST_FLAGS, '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run',
    `--host-resolver-rules=MAP maxime.rockfrog.test:443 127.0.0.1:${sitePort}`, '--ignore-certificate-errors-spki-list=' + spki,
    '--user-data-dir=' + path.join(home, 'browser'), '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let out = ''; const timer = setTimeout(() => reject(Error(out)), 10000);
    browser.stderr.on('data', b => { out += b; const m = out.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
  });
  cdp = new WebSocket(endpoint); await new Promise(res => cdp.onopen = res);
  let id = 0; const pending = new Map(), problems = [];
  cdp.onmessage = e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}, sessionId) => new Promise(res => { pending.set(++id, res); cdp.send(JSON.stringify({ id, method, params, sessionId })); });
  const target = await send('Target.createTarget', { url: 'about:blank' });
  const sid = (await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })).result.sessionId;
  await send('Runtime.enable', {}, sid); await send('Page.enable', {}, sid);
  const evaluate = async expression => { const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid); return out.result?.result?.value; };
  const waitFor = (expression, label) => until(async () => await evaluate(`(()=>{try{return !!(${expression})}catch{return false}})()`), label + '\n' + problems.join('\n') + '\n' + log.slice(-1500), 30000);
  await send('Page.navigate', { url: link.url }, sid);
  await waitFor(`document.getElementById('nameInput')`, 'the page, through the relay');
  await evaluate(`document.getElementById('nameInput').value = 'Lin'; document.querySelector('#nameForm button[type=submit]').click(); 1`);
  await waitFor(`document.querySelector('#doc .cm-content') && document.getElementById('state').textContent === 'Live'`, 'the live document, through the relay');
  assert.equal(await evaluate('location.protocol + "//" + location.host'), 'https://maxime.rockfrog.test');
  await evaluate(`(() => { const c = document.querySelector('#doc .cm-content'); c.focus(); const s = getSelection(); s.selectAllChildren(c); s.collapseToEnd(); return 1; })()`);
  await send('Input.insertText', { text: '\nLin typed this from far away.\n' }, sid);
  await until(() => fs.readFileSync(doc, 'utf8').includes('Lin typed this from far away.'), 'the edit reaches the file\n' + problems.join('\n'), 20000);
  assert.deepEqual(problems, []);
  // A publication: its own address under the computer's, its own
  // certificate (asked for through the relay), its own files.
  const pubDir = path.join(work, 'game');
  fs.mkdirSync(pubDir, { recursive: true });
  fs.writeFileSync(path.join(pubDir, 'index.html'), '<!doctype html><h1>A GAME, PUBLISHED</h1>');
  const pub = (await api('/api/shares', { kind: 'publication', type: 'site', path: pubDir, slug: 'game', access: 'public' })).body.share;
  assert.ok(pub && pub.slug === 'game', JSON.stringify(pub));
  await until(async () => ((await api('/api/shares?published=' + encodeURIComponent(pubDir))).body.shares[0].links[0] || {}).where === 'public', 'the publication\u2019s certificate\n' + log.slice(-1500), 60000);
  const pubRoot = await new Promise((res, rej) => https.get({ host: '127.0.0.1', port: mgmtPort, path: '/roots/0', rejectUnauthorized: false }, s => { let d = ''; s.on('data', x => d += x); s.on('end', () => res(d)); }).on('error', rej));
  const gamePage = await new Promise((resolve, reject) => {
    const s = tls.connect({ port: sitePort, host: '127.0.0.1', servername: 'game.maxime.rockfrog.test', ca: pubRoot }, () => {
      if (!s.authorized) return reject(new Error('not authorized: ' + s.authorizationError));
      const san = s.getPeerCertificate().subjectaltname;
      let b = ''; s.on('data', d => b += d); s.on('end', () => resolve({ san, body: b }));
      s.write('GET / HTTP/1.1\r\nHost: game.maxime.rockfrog.test\r\nConnection: close\r\n\r\n');
    });
    s.on('error', reject);
  });
  assert.equal(gamePage.san, 'DNS:game.maxime.rockfrog.test', 'its own certificate, for its own address only');
  assert.match(gamePage.body, /A GAME, PUBLISHED/);
  assert.match(gamePage.body, /x-chattering-fingerprint: [0-9a-f]{64}/i);
  // The computer's own address does not answer as the publication, and the other way round.
  assert.doesNotMatch(raw, /A GAME/);

  // The owner turns the address off: the relay forgets this computer.
  await api('/api/public-links', { on: false });
  await until(() => relay.site.homes.size === 0, 'the relay connection closes');
});
