'use strict';
// Chattering Anywhere (design/85): a phone reaches its home computer through
// the relay, over an end-to-end encrypted WebRTC channel, as the person
// who paired it. Everything here is real: the relay, the home, WebRTC
// (node-datachannel, the phone side through its browser-shaped polyfill),
// and an HTTP + WebSocket server standing in for Chattering.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const P = require('../anywhere/protocol.js');
const Client = require('../anywhere/client.js');
const { createRelay } = require('../anywhere/relay.js');
const { createAnywhereHome, loadRtc } = require('../anywhere-home.js');
const { acceptWebSocket } = require('../wsserver.js');

const ROOT = path.join(__dirname, '..');
const rtc = loadRtc(ROOT);
// The WebRTC library's threads (RTC poll, SCTP timer) can keep a process
// alive even after its cleanup. The server always ends with process.exit,
// which stops them; so does this file, once its tests have reported
// (process.exit() keeps the exit code the test runner set).
after(async () => { await new Promise(r => setTimeout(r, 300)); if (rtc.cleanup) rtc.cleanup(); setTimeout(() => process.exit(), 1000); });
const skip = rtc.error ? 'node-datachannel is not installed (npm ci --prefix runtime)' : false;
const listen = server => new Promise(res => server.listen(0, '127.0.0.1', () => res(server.address().port)));
const until = async (fn, label, ms = 10000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) assert.fail('timed out: ' + label); await new Promise(r => setTimeout(r, 20)); } };

// Stands in for Chattering: says who asked, streams, echoes, speaks SSE and WebSocket.
function fakeChattering() {
  const seen = [];
  const big = Buffer.alloc(3 * 1024 * 1024 + 17);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 255;
  const server = http.createServer(async (req, res) => {
    seen.push({ url: req.url, headers: req.headers, method: req.method });
    if (req.url === '/who') { res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'x=1' }); return res.end(JSON.stringify({ auth: req.headers.authorization, xff: req.headers['x-forwarded-for'], cookie: req.headers.cookie || null, origin: req.headers.origin || null, host: req.headers.host })); }
    if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(big); }
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:' + server.address().port + '/who' }); return res.end(); }
    if (req.url === '/echo' && req.method === 'POST') { const parts = []; for await (const c of req) parts.push(c); res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(Buffer.concat(parts)); }
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      let n = 0; const t = setInterval(() => { res.write('data: tick ' + (++n) + '\n\n'); if (n === 3) { clearInterval(t); res.end(); } }, 30);
      return;
    }
    res.writeHead(404); res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    seen.push({ url: req.url, headers: req.headers, upgrade: true });
    const c = acceptWebSocket(req, socket, head);
    if (!c) return;
    c.on('message', (m, binary) => c.send(binary ? Buffer.concat([Buffer.from('echo:'), m]) : 'echo:' + m));
  });
  return { server, seen, big };
}

async function newDevice() {
  const pair = await P.subtle().generateKey(P.ECDSA, false, ['sign', 'verify']);
  return { privateKey: pair.privateKey, spki: new Uint8Array(await P.subtle().exportKey('spki', pair.publicKey)) };
}
function gunzipIf(head, bytes) { return head.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(Buffer.from(bytes)) : Buffer.from(bytes); }
// One request through the tunnel, the whole body collected.
function fetchThrough(tunnel, req) {
  return new Promise((resolve, reject) => {
    let head = null; const parts = [];
    const h = tunnel.request(req, {
      onHead: x => { head = x; },
      onChunk: b => { parts.push(Buffer.from(b)); h.consumed(b.length); },
      onEnd: () => resolve({ ...head, body: gunzipIf(head, Buffer.concat(parts)) }),
      onError: reject,
    });
  });
}

async function world(t, { turn = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = fakeChattering();
  const appPort = await listen(app.server);
  t.after(() => app.server.close());
  const relay = createRelay({ env: turn ? { TURN_SECRET: 's3cret', TURN_URLS: 'turn:127.0.0.1:3478' } : {} });
  const relayPort = await listen(relay.server);
  t.after(() => relay.close());
  const relayUrl = 'http://127.0.0.1:' + relayPort;
  const creds = new Map(); // credentialId → { userId, secret }
  let n = 0;
  const changes = [];
  const home = createAnywhereHome({
    dataDir: dir, appDir: ROOT,
    relayUrl: () => relayUrl,
    homeName: () => 'lambda',
    localTarget: () => ({ host: '127.0.0.1', port: appPort }),
    issueCredential: (userId, label) => { const id = 'c' + (++n), secret = 'secret-' + n; creds.set(id, { userId, secret, label }); return { secret, credentialId: id }; },
    credentialAlive: (userId, id) => creds.has(id) && creds.get(id).userId === userId,
    revokeCredential: (userId, id) => creds.delete(id),
    userOf: id => ({ id, name: id === 'u1' ? 'Maxime' : 'Lilly' }),
    onChange: () => changes.push(home.status()),
  });
  t.after(() => home.stop());
  const tunnels = [];
  t.after(() => tunnels.forEach(x => x.close()));
  const phone = async (o) => {
    const tunnel = await Client.connect({ relay: relayUrl, RTCPeerConnection: rtc.RTCPeerConnection, WebSocket, name: 'Pixel 8 · Chrome', timeoutMs: 15000, ...o });
    tunnels.push(tunnel);
    return tunnel;
  };
  return { dir, app, relay, relayUrl, home, creds, phone, changes };
}

test('the handshake, the frames, the pairing link', { skip }, async () => {
  const mux = [];
  const a = { readyState: 'open', bufferedAmount: 0, sent: [], send(f) { this.sent.push(f); }, addEventListener() {} };
  const m = new P.Mux(a, (type, stream, bytes) => mux.push({ type, stream, bytes }));
  const big = new Uint8Array(40000).map((_, i) => i & 255);
  a.bufferedAmount = P.HIGH_WATER; // the channel is full: everything waits
  m.send(P.T.RES_BODY, 3, big);
  m.send(P.T.RES_BODY, 5, new Uint8Array([1, 2, 3]));
  m.send(P.T.CTRL, 0, { t: 'ping' });
  assert.equal(a.sent.length, 0);
  assert.equal(m.waiting(3), big.length);
  a.bufferedAmount = 0;
  m.pump();
  assert.equal(P.parse(a.sent[0]).stream, 0, 'the ping goes first');
  assert.equal(a.sent.length, 5, 'three pieces of the big message, the small one, the ping');
  assert.ok(a.sent.every(f => f.length <= P.FRAME), 'no frame over 16 KiB');
  // Streams take turns: stream 5's message is not stuck behind all of stream 3.
  const order = a.sent.map(f => P.parse(f).stream);
  assert.ok(order.indexOf(5) < order.lastIndexOf(3), 'turns: ' + order);
  for (const f of a.sent) m.receive(f);
  const whole = mux.find(x => x.stream === 3);
  assert.deepEqual([...whole.bytes], [...big], 'joined back whole');
  assert.equal(P.json(mux.find(x => x.stream === 0).bytes).t, 'ping');

  const link = P.pairingLink('https://anywhere.example/', { homeId: 'AAAAAAAAAAAAAAAAAAAAAA', id: 'pairpairpair', secret: 'SSSSSSSSSSSSSSSSSSSSSS', name: 'lambda' });
  assert.equal(link, 'https://anywhere.example/#pair=AAAAAAAAAAAAAAAAAAAAAA.pairpairpair.SSSSSSSSSSSSSSSSSSSSSS&n=lambda');
  assert.deepEqual(P.readPairingLink(new URL(link).hash), { homeId: 'AAAAAAAAAAAAAAAAAAAAAA', id: 'pairpairpair', secret: 'SSSSSSSSSSSSSSSSSSSSSS', name: 'lambda' });
  assert.equal(P.readPairingLink('#pair=a.b'), null);
  assert.equal(P.readPairingLink('#pair=../x.y.z'), null);
  assert.equal(P.fingerprint('v=0\r\na=fingerprint:sha-256 ab:cd\r\n'), 'AB:CD');
  assert.equal(P.deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'), 'iPhone · Safari');
  assert.equal(P.deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36'), 'Pixel 8 · Chrome');
});

test('a phone pairs, then comes back, as its person, over an encrypted channel', { skip, timeout: 60000 }, async t => {
  const w = await world(t);
  await until(() => w.home.status().relayState === 'off', 'no relay while nothing is paired');
  assert.equal(w.relay.homes.size, 0, 'a home with no phone stays away from the relay');

  const pairing = await w.home.pair('u1');
  const link = P.readPairingLink(new URL(pairing.url).hash);
  assert.equal(link.name, 'lambda');
  assert.ok(pairing.url.startsWith(w.relayUrl + '/#pair='), pairing.url);
  await until(() => w.home.status().relayState === 'ready', 'the home registers while a code shows');

  const device = await newDevice();
  const statuses = [];
  const tunnel = await w.phone({ homeId: link.homeId, device, pairing: { id: link.id, secret: link.secret }, onStatus: s => statuses.push(s) });
  assert.deepEqual(statuses, ['relay', 'connecting', 'securing']);
  assert.equal(tunnel.home.name, 'lambda');
  assert.equal(tunnel.user.name, 'Maxime');
  assert.match(tunnel.device, /^d/);
  assert.equal(w.home.pairingState(pairing.id).paired.name, 'Pixel 8 · Chrome');
  assert.equal([...w.creds.values()][0].label, 'Pixel 8 · Chrome · anywhere');
  assert.equal(fs.statSync(path.join(w.dir, 'anywhere.json')).mode & 0o777, 0o600, 'the home keeps its keys to itself');

  // Requests arrive as the person, marked forwarded; the phone chooses none of it.
  const who = await fetchThrough(tunnel, { method: 'GET', path: '/who', headers: { Cookie: 'stolen=1', Authorization: 'Bearer forged', 'X-Forwarded-For': '1.2.3.4', Origin: 'https://evil.example', Accept: 'application/json' } });
  assert.equal(who.status, 200);
  const body = JSON.parse(who.body);
  assert.equal(body.auth, 'Bearer secret-1');
  assert.equal(body.xff, 'anywhere');
  assert.equal(body.cookie, null);
  assert.equal(body.origin, null);
  assert.equal(who.headers['set-cookie'], undefined, 'cookies stay home');
  assert.equal(who.headers['content-encoding'], 'gzip', 'text is compressed for the trip');
  const redirect = await fetchThrough(tunnel, { method: 'GET', path: '/redirect' });
  assert.equal(redirect.headers.location, '/who', 'a redirect to the home itself stays a path');

  // A large body arrives whole, paced by what the phone takes.
  const big = await fetchThrough(tunnel, { method: 'GET', path: '/big' });
  assert.equal(big.body.length, w.app.big.length);
  assert.ok(big.body.equals(w.app.big), 'every byte');
  // Bodies go up too.
  const up = Buffer.alloc(700 * 1024, 'x');
  const echo = await fetchThrough(tunnel, { method: 'POST', path: '/echo', headers: { 'Content-Type': 'text/plain' }, body: up });
  assert.equal(echo.body.length, up.length);
  // A live stream is not held back by compression.
  const events = await fetchThrough(tunnel, { method: 'GET', path: '/events' });
  assert.equal(events.headers['content-encoding'], undefined);
  assert.match(events.body.toString(), /tick 1[\s\S]*tick 3/);
  // Several at once share the channel.
  const many = await Promise.all(Array.from({ length: 12 }, () => fetchThrough(tunnel, { method: 'GET', path: '/who' })));
  assert.ok(many.every(r => r.status === 200));

  // WebSockets: text and binary, as the person.
  const got = [];
  await new Promise((resolve, reject) => {
    const s = tunnel.socket('/ws?x=1', [], {
      onOpen: () => { s.sendText('hi'); s.sendBinary(new Uint8Array([1, 2])); },
      onText: x => { got.push(x); },
      onBinary: b => { got.push([...b]); if (got.length === 2) { s.close(); resolve(); } },
      onClose: (code, why) => reject(new Error('closed ' + code + ' ' + why)),
    });
  });
  assert.deepEqual(got, ['echo:hi', [101, 99, 104, 111, 58, 1, 2]]);
  const up2 = w.app.seen.find(s => s.upgrade);
  assert.equal(up2.headers.authorization, 'Bearer secret-1');
  assert.equal(up2.headers['x-forwarded-for'], 'anywhere');

  assert.ok(await tunnel.ping() >= 0);
  assert.ok(['direct', 'relay'].includes(await tunnel.path()));
  tunnel.close();

  // The code worked once.
  await assert.rejects(w.phone({ homeId: link.homeId, device: await newDevice(), pairing: { id: link.id, secret: link.secret } }), e => e.code === 'refused' && e.why === 'pairing-expired');

  // Back again with its own key, no code.
  const again = await w.phone({ homeId: link.homeId, device: { ...device, id: tunnel.device } });
  assert.equal(JSON.parse((await fetchThrough(again, { method: 'GET', path: '/who' })).body).auth, 'Bearer secret-1');
  await until(() => w.home.status().devices[0].online, 'the settings page sees it online');

  // Another key claiming that phone's id proves nothing.
  await assert.rejects(w.phone({ homeId: link.homeId, device: { ...(await newDevice()), id: tunnel.device } }), e => e.code === 'refused' && e.why === 'bad-signature');

  // Removed on the computer: the open connection ends, and it cannot return.
  const lost = new Promise(r => again.onLost(r));
  w.home.forget(tunnel.device);
  assert.match(await lost, /removed/);
  assert.equal(w.creds.size, 0, 'its credential is revoked with it');
  await until(() => w.home.status().relayState === 'off', 'nothing paired, the home leaves the relay');
  await assert.rejects(w.phone({ homeId: link.homeId, device: { ...device, id: tunnel.device }, wait: false }), e => e.code === 'offline');
  // While a code shows, the home is there, and says the phone is gone.
  const next = await w.home.pair('u1');
  await until(() => w.home.status().relayState === 'ready', 'back for the new code');
  await assert.rejects(w.phone({ homeId: link.homeId, device: { ...device, id: tunnel.device } }), e => e.code === 'refused' && e.why === 'unknown');
  w.home.cancelPairing(next.id);
  await until(() => w.home.status().relayState === 'off', 'the code cancelled, the home leaves again');
});

test('a wrong code, a wrong home, a home asleep', { skip, timeout: 60000 }, async t => {
  // It hung once under a heavy parallel run (2026-09-30) and could not be made
  // to again: if it does, the log names the step it was waiting on.
  let step = 'start';
  const at = label => { step = label; };
  const watchdog = setTimeout(() => console.error('[home asleep] still waiting at: ' + step), 55000);
  watchdog.unref();
  t.after(() => clearTimeout(watchdog));
  const w = await world(t);
  const pairing = await w.home.pair('u1');
  const link = P.readPairingLink(new URL(pairing.url).hash);
  await until(() => w.home.status().relayState === 'ready', 'registered');
  await assert.rejects(w.phone({ homeId: link.homeId, device: await newDevice(), pairing: { id: link.id, secret: P.b64u(P.random(16)) } }), e => e.code === 'refused' && e.why === 'bad-code');

  at('another home id');
  // Another home id: nobody answers for it.
  const other = P.b64u(P.random(16));
  await assert.rejects(w.phone({ homeId: other, device: await newDevice(), pairing: { id: link.id, secret: link.secret }, wait: false }), e => e.code === 'offline');

  // A home that is not on the relay yet: the phone waits and connects the
  // moment it arrives.
  const statuses = [];
  w.home.stop();
  at('a second world');
  const w2 = await world(t);
  const p2 = await w2.home.pair('u2');
  const l2 = P.readPairingLink(new URL(p2.url).hash);
  await until(() => w2.home.status().relayState === 'ready', 'registered');
  w2.home.stop();
  at('the home leaving the relay');
  await until(() => ![...w2.relay.homes.values()].some(e => e.conn.role === 'home'), 'gone from the relay');
  const pending = w2.phone({ homeId: l2.homeId, device: await newDevice(), pairing: { id: l2.id, secret: l2.secret }, onStatus: s => statuses.push(s) });
  at('the phone waiting');
  await until(() => statuses.includes('waiting'), 'the phone waits');
  // Same data folder, same key: the computer "wakes up".
  const again = createAnywhereHome({
    dataDir: w2.dir, appDir: ROOT, relayUrl: () => w2.relayUrl, homeName: () => 'lambda',
    localTarget: () => ({ host: '127.0.0.1', port: 1 }),
    issueCredential: () => ({ secret: 's', credentialId: 'c' }), credentialAlive: () => true, userOf: () => null,
  });
  t.after(() => again.stop());
  // A restart forgets pairing codes: the waiting phone is told so.
  at('the home back, a new code');
  const p3 = await again.pair('u2');
  assert.notEqual(p3.id, l2.id);
  at('the waiting phone told the old code expired: ' + JSON.stringify(statuses));
  await assert.rejects(pending, e => e.code === 'refused' && e.why === 'pairing-expired');
  assert.deepEqual(statuses.slice(0, 2), ['relay', 'waiting']);
});

test('the relay: only a key\'s holder registers as a home; TURN credentials coturn accepts', { skip, timeout: 30000 }, async t => {
  const relay = createRelay({ env: { TURN_SECRET: 'topsecret', TURN_URLS: 'turn:relay.example:3478,turns:relay.example:5349?transport=tcp', TURN_TTL: '3600' } });
  const port = await listen(relay.server);
  t.after(() => relay.close());
  const servers = relay.iceServers();
  assert.deepEqual(servers[0], { urls: ['stun:relay.example:3478'] }, 'STUN on the TURN host by default');
  const secretFile = path.join(os.tmpdir(), 'anywhere-turn-' + process.pid);
  fs.writeFileSync(secretFile, 'fromfile\n');
  t.after(() => fs.rmSync(secretFile, { force: true }));
  const fromFile = createRelay({ env: { TURN_SECRET_FILE: secretFile, TURN_URLS: 'turn:x:3478' } }).iceServers()[1];
  assert.equal(fromFile.credential, require('crypto').createHmac('sha1', 'fromfile').update(fromFile.username).digest('base64'), 'the secret read from its file, trimmed');
  const turn = servers[1];
  const [expiry] = turn.username.split(':');
  assert.ok(Number(expiry) > Date.now() / 1000 + 3500);
  assert.equal(turn.credential, require('crypto').createHmac('sha1', 'topsecret').update(turn.username).digest('base64'));

  // A socket claiming someone else's id is refused.
  const real = await P.subtle().generateKey(P.ECDSA, true, ['sign', 'verify']);
  const spki = new Uint8Array(await P.subtle().exportKey('spki', real.publicKey));
  const id = await P.homeIdOf(spki);
  const liar = await P.subtle().generateKey(P.ECDSA, true, ['sign', 'verify']);
  const liarSpki = new Uint8Array(await P.subtle().exportKey('spki', liar.publicKey));
  const closed = await new Promise(res => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/signal');
    ws.onopen = () => ws.send(JSON.stringify({ t: 'home', id, key: P.b64u(liarSpki) }));
    ws.onclose = e => res(e.reason);
  });
  assert.match(closed, /not the key/);
  // The right key but no proof of holding it: refused.
  const noProof = await new Promise(res => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/signal');
    ws.onopen = () => ws.send(JSON.stringify({ t: 'home', id, key: P.b64u(spki) }));
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.t === 'challenge') ws.send(JSON.stringify({ t: 'proof', sig: P.b64u(P.random(64)) })); };
    ws.onclose = e => res(e.reason);
  });
  assert.match(noProof, /proof failed/);
  assert.equal([...relay.homes.values()].filter(e => e.conn.role === 'home').length, 0);

  // The page: the shell for any address, its files under /_anywhere/, nothing else.
  const get = async (p, h = {}) => { const r = await fetch('http://127.0.0.1:' + port + p, { headers: h }); return { status: r.status, type: r.headers.get('content-type'), csp: r.headers.get('content-security-policy'), text: await r.text(), swa: r.headers.get('service-worker-allowed') }; };
  const shell = await get('/c/some/conversation');
  assert.equal(shell.status, 200);
  assert.match(shell.text, /<title>Chattering<\/title>/);
  assert.match(shell.csp, /frame-ancestors 'none'/);
  assert.equal((await get('/sw.js')).swa, '/');
  const links = await get('/.well-known/assetlinks.json');
  assert.equal(links.type, 'application/json');
  assert.equal(JSON.parse(links.text)[0].target.package_name, 'app.rockfrog.chattering');
  assert.equal((await get('/_anywhere/protocol.js')).status, 200);
  assert.equal((await get('/_anywhere/relay.js')).status, 404);
  assert.equal((await get('/_anywhere/..%2frelay.js')).status, 404);
  assert.equal((await get('/x', { 'Sec-Fetch-Dest': 'iframe' })).status, 503, 'never the shell inside itself');
  assert.equal((await get('/healthz')).text, 'ok\n');
  // What scanners send in the first minutes online (one of these ended the
  // process): answered, and the relay is still there after.
  const raw = p => new Promise(resolve => {
    const s = require('net').connect(port, '127.0.0.1', () => s.write('GET ' + p + ' HTTP/1.1\r\nHost: relay\r\nConnection: close\r\n\r\n'));
    let out = ''; s.on('data', d => out += d); s.on('close', () => resolve(out.split('\r\n')[0])); s.on('error', () => resolve('error'));
  });
  for (const p of ['//%2e%2e%2f%2eenv', '//evil.example/x', '///', '//[', '/%', '*', 'http://x/', '/_anywhere/%00', '/%2e%2e/%2e%2e/etc/passwd']) {
    assert.match(await raw(p), /^HTTP\/1\.1 (200|400|404|405)/, p);
  }
  const upgradeOdd = await new Promise(resolve => {
    const s = require('net').connect(port, '127.0.0.1', () => s.write('GET //%2e%2e HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    let out = ''; s.on('data', d => out += d); s.on('close', () => resolve(out.split('\r\n')[0]));
  });
  assert.match(upgradeOdd, /404/);
  assert.equal((await get('/healthz')).text, 'ok\n', 'still up');
});

test('usage: totals per day and month, never who', { skip, timeout: 60000 }, async t => {
  const { createUsage } = require('../anywhere/usage.js');
  // The counting itself, with a clock we move.
  let clock = Date.parse('2026-09-30T23:50:00Z');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-')), 'usage.json');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const u = createUsage({ file, now: () => clock });
  const idA = 'AAAAAAAAAAAAAAAAAAAAAA', idB = 'BBBBBBBBBBBBBBBBBBBBBB';
  u.homeOnline(idA); u.homeOnline(idB); u.homeOffline(); u.homeOnline(idA); // A reconnects: still one computer
  u.call(); u.call(); u.wait();
  let s = u.snapshot();
  assert.deepEqual([s.online, s.today.computers, s.today.peak, s.today.calls, s.today.waits], [2, 2, 2, 2, 1]);
  clock = Date.parse('2026-10-01T00:10:00Z'); // a new day and a new month
  u.homeOnline(idA);
  s = u.snapshot();
  assert.equal(s.today.key, '2026-10-01');
  assert.equal(s.today.computers, 1, 'yesterday\'s computers are not today\'s: the mixes do not carry over');
  assert.equal(s.days[0].key, '2026-09-30');
  assert.equal(s.days[0].computers, 2);
  assert.equal(s.months[0].key, '2026-09');
  u.save();
  const written = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(written, new RegExp(idA + '|' + idB), 'no computer id on disk');
  assert.deepEqual(Object.keys(JSON.parse(written)), ['days', 'months']);
  // A restart the same day resumes the counts, and says so.
  const again = createUsage({ file, now: () => clock });
  const r = again.snapshot();
  assert.equal(r.today.computers, 1);
  assert.equal(r.today.restarts, 1);
  assert.equal(r.days.length, 1);

  // On a live relay: a computer and a phone are counted; the totals are read
  // on the relay's own port only.
  const w = await world(t);
  const pairing = await w.home.pair('u1');
  const link = P.readPairingLink(new URL(pairing.url).hash);
  await until(() => w.home.status().relayState === 'ready', 'registered');
  await w.phone({ homeId: link.homeId, device: await newDevice(), pairing: { id: link.id, secret: link.secret } });
  const live = await (await fetch(w.relayUrl + '/_usage')).json();
  assert.equal(live.online, 1);
  assert.equal(live.today.computers, 1);
  assert.equal(live.today.calls, 1);
  assert.doesNotMatch(JSON.stringify(live), new RegExp(link.homeId), 'no id in the totals');
  assert.equal((await fetch(w.relayUrl + '/_usage', { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status, 404, 'not through the https front');
});

test('a computer links to another: its own local address, private, from anywhere', { skip, timeout: 90000 }, async t => {
  const { createAnywhereLinks } = require('../anywhere-link.js');
  const { iceForNode } = require('../anywhere-home.js');
  const w = await world(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'links-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const portBase = 30000 + Math.floor(Math.random() * 20000);
  const links = createAnywhereLinks({ dataDir: dir, rtc, iceForNode, portBase, deviceName: () => 'XPSwhite · Chattering',
    authorize: req => /(^|;\s*)chattering=me(;|$)/.test(String(req.headers.cookie || '')) });
  t.after(() => links.stop());
  const code = await w.home.pair('u1');
  await until(() => w.home.status().relayState === 'ready', 'registered');
  const link = await links.add(code.url, { by: { id: 'local-me', name: 'Maxime' } });
  assert.equal(link.name, 'lambda');
  assert.equal(link.url, `http://localhost:${portBase}/`);
  assert.equal(link.connected, true);
  assert.equal(fs.statSync(path.join(dir, 'anywhere-links.json')).mode & 0o777, 0o600);
  assert.equal(w.home.status().devices[0].name, 'XPSwhite · Chattering', 'listed there as this computer');

  const base = `http://localhost:${portBase}`;
  const me = { Cookie: 'chattering=me' };
  // The other computer's app, as its person; this computer's cookie stays here.
  const who = await fetch(base + '/who', { headers: me });
  assert.equal(who.status, 200);
  assert.equal((await who.json()).auth, 'Bearer secret-1');
  // Private: no sign-in, another host name, another site.
  assert.equal((await fetch(base + '/who')).status, 401);
  const otherHost = await new Promise(resolve => http.get({ host: '127.0.0.1', port: portBase, path: '/who', headers: { ...me, Host: 'evil.example:' + portBase } }, r => { r.resume(); resolve(r.statusCode); }));
  assert.equal(otherHost, 421, 'a page whose name was pointed at this computer is refused');
  assert.equal((await fetch(base + '/who', { headers: { ...me, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  // Big answers, uploads, a live stream, a WebSocket.
  const big = Buffer.from(await (await fetch(base + '/big', { headers: me })).arrayBuffer());
  assert.ok(big.equals(w.app.big), 'every byte of 3 MB');
  const up = Buffer.alloc(900 * 1024, 'y');
  assert.equal((await (await fetch(base + '/echo', { method: 'POST', headers: { ...me, 'Content-Type': 'text/plain' }, body: up })).text()).length, up.length);
  const events = await (await fetch(base + '/events', { headers: me })).text();
  assert.match(events, /tick 1[\s\S]*tick 3/);
  const echoed = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${portBase}/ws`, { headers: me });
    ws.onopen = () => ws.send('over the link');
    ws.onmessage = e => { resolve(e.data); ws.close(); };
    ws.onerror = () => reject(new Error('websocket failed'));
  });
  assert.equal(echoed, 'echo:over the link');

  // The other computer goes away: a page says so; it comes back: it works.
  w.home.stop();
  await new Promise(r => setTimeout(r, 500));
  const away = await fetch(base + '/who', { headers: { ...me, Accept: 'text/html' } });
  assert.equal(away.status, 503);
  assert.match(await away.text(), /lambda cannot be reached right now/);

  // Removed from the list here: its address closes.
  await links.remove(link.id);
  await assert.rejects(fetch(base + '/who', { headers: me }));
  assert.deepEqual(links.list(), []);
});

test('Given native ICE before SDP, When a phone connects, Then descriptions precede candidate application', { skip, timeout: 30000 }, async t => {
  const w = await world(t);
  const pairing = await w.home.pair('u1');
  const link = P.readPairingLink(new URL(pairing.url).hash);
  await until(() => w.home.status().relayState === 'ready', 'registered');
  const sent = [], received = [];
  let prematureCandidates = 0;
  let localCandidate;
  const gathered = new Promise(resolve => { localCandidate = resolve; });
  class EarlyIce extends rtc.RTCPeerConnection {
    constructor(config) {
      super(config);
      this.addEventListener('icecandidate', e => { if (e.candidate) localCandidate(); });
    }
    async addIceCandidate(candidate) {
      if (!this.remoteDescription.sdp) prematureCandidates++;
      return super.addIceCandidate(candidate);
    }
    async createOffer() {
      const offer = await super.createOffer();
      // Real native gathering completes before the offer is allowed onto the wire.
      await gathered;
      return offer;
    }
  }
  class CandidateFirst extends WebSocket {
    constructor(url) {
      super(url);
      const held = [];
      let reordered = false;
      this.addEventListener('message', ev => {
        const m = JSON.parse(ev.data);
        if (!reordered && m.t === 'signal') {
          held.push(m);
          const answer = held.find(x => x.data.sdp);
          const candidate = held.find(x => x.data.candidate);
          if (!answer || !candidate) return;
          reordered = true;
          // A real answer and candidate, deterministically delivered candidate first.
          for (const x of [candidate, answer, ...held.filter(x => x !== answer && x !== candidate)]) {
            received.push(x.data.candidate ? 'candidate' : 'sdp');
            this.deliver({ data: JSON.stringify(x) });
          }
        } else this.deliver(ev);
      });
    }
    set onmessage(fn) { this.deliver = fn; }
    send(text) {
      const m = JSON.parse(text);
      if (m.t === 'signal') sent.push(m.data.sdp ? 'sdp' : 'candidate');
      return super.send(text);
    }
  }
  const abort = new AbortController();
  t.after(() => abort.abort());
  const tunnel = await w.phone({ homeId: link.homeId, device: await newDevice(),
    pairing: { id: link.id, secret: link.secret }, RTCPeerConnection: EarlyIce, WebSocket: CandidateFirst, signal: abort.signal });
  assert.equal(prematureCandidates, 0, 'no native candidate is applied without remote SDP');
  assert.equal(sent[0], 'sdp', 'the home sees an offer before trickled ICE');
  assert.deepEqual(received.slice(0, 2), ['candidate', 'sdp'], 'the controlled real ordering was exercised');
  assert.equal(tunnel.user.name, 'Maxime', 'the real encrypted pairing still authenticates');
});
