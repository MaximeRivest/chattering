'use strict';
// Chattering Anywhere through a real TURN server (design/85): when phone and
// computer cannot reach each other directly, coturn carries the packets,
// with the short-lived credentials the relay hands out. The tunnel is the
// same DTLS channel end to end: coturn relays bytes it cannot read, and the
// handshake still proves both ends. Needs coturn (`turnserver`) on PATH:
//   nix shell nixpkgs#coturn -c node --test test/anywhere-turn.test.js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const P = require('../anywhere/protocol.js');
const Client = require('../anywhere/client.js');
const { createRelay } = require('../anywhere/relay.js');
const { createAnywhereHome, loadRtc, iceForNode } = require('../anywhere-home.js');

const ROOT = path.join(__dirname, '..');
const rtc = loadRtc(ROOT);
after(async () => { await new Promise(r => setTimeout(r, 300)); if (rtc.cleanup) rtc.cleanup(); setTimeout(() => process.exit(), 1000); });
const turnserver = String(process.env.PATH || '').split(path.delimiter).map(d => path.join(d, 'turnserver')).find(f => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } });
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
const until = async (fn, label, ms = 15000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) assert.fail('timed out: ' + label); await new Promise(r => setTimeout(r, 50)); } };

test('relayed through coturn when there is no direct path, still end to end', { skip: rtc.error || (!turnserver && 'coturn (turnserver) is not installed'), timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-turn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const turnPort = await freePort();
  const secret = 'turn-' + P.b64u(P.random(12));
  // Credentials the coturn way (use-auth-secret); loopback peers allowed only
  // because both ends of this test are on this machine.
  const coturn = spawn(turnserver, ['-n', '--listening-ip=127.0.0.1', '--relay-ip=127.0.0.1', '--listening-port=' + turnPort, '--use-auth-secret', '--static-auth-secret=' + secret,
    '--realm=anywhere.test', '--allow-loopback-peers', '--no-cli', '--no-tls', '--no-dtls', '--min-port=49160', '--max-port=49200', '--log-file=stdout', '--verbose'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let turnLog = '';
  coturn.stdout.on('data', b => { turnLog += b; });
  t.after(() => coturn.kill('SIGKILL'));
  await new Promise(r => setTimeout(r, 500));

  const app = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('hello through the relay'); });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  // Credentials that last 3 seconds: the home registers, they expire, and
  // only then does the phone call. The call must bring the home fresh ones.
  const relay = createRelay({ env: { TURN_SECRET: secret, TURN_URLS: 'turn:127.0.0.1:' + turnPort + '?transport=udp', TURN_TTL: '3' } });
  await new Promise(r => relay.server.listen(0, '127.0.0.1', r));
  t.after(() => relay.close());
  const relayUrl = 'http://127.0.0.1:' + relay.server.address().port;
  const servers = relay.iceServers();
  assert.deepEqual(iceForNode([{ urls: 'turn:x', username: '1:a', credential: 'b/c+d=' }])[0], { urls: 'turn:x', username: '1%3Aa', credential: 'b%2Fc%2Bd%3D' });

  const home = createAnywhereHome({
    dataDir: dir, appDir: ROOT, relayUrl: () => relayUrl, homeName: () => 'lambda',
    localTarget: () => ({ host: '127.0.0.1', port: app.address().port }),
    issueCredential: () => ({ secret: 's', credentialId: 'c1' }), credentialAlive: () => true, userOf: () => ({ id: 'u1', name: 'Maxime' }),
    relayOnly: true,
  });
  t.after(() => home.stop());
  const code = await home.pair('u1');
  const link = P.readPairingLink(new URL(code.url).hash);
  await until(() => home.status().relayState === 'ready', 'the home on the relay');
  await new Promise(r => setTimeout(r, 4500)); // the home's first credentials have expired
  const key = await P.subtle().generateKey(P.ECDSA, false, ['sign', 'verify']);
  const device = { privateKey: key.privateKey, spki: new Uint8Array(await P.subtle().exportKey('spki', key.publicKey)) };
  const tunnel = await Client.connect({ relay: relayUrl, homeId: link.homeId, device, pairing: { id: link.id, secret: link.secret }, name: 'Phone',
    RTCPeerConnection: rtc.RTCPeerConnection, WebSocket, mapIceServers: iceForNode, relayOnly: true, timeoutMs: 20000 });
  t.after(() => tunnel.close());
  const body = await new Promise((resolve, reject) => {
    const parts = [];
    tunnel.request({ method: 'GET', path: '/' }, { onHead() {}, onChunk: b => parts.push(Buffer.from(b)), onEnd: () => resolve(Buffer.concat(parts)), onError: reject });
  });
  assert.equal(require('node:zlib').gunzipSync(body).toString(), 'hello through the relay');
  // coturn's own account is the proof: the ends signed in with the relay's
  // credentials (read back exactly as the relay wrote them), got addresses
  // on it, and let the other end in. On one machine an end may also reach
  // coturn's reflexive address directly, so at least one side relays.
  // (node-datachannel's statistics name a relayed candidate "srflx", so the
  // path the phone reports is only trusted from a browser.)
  await until(() => /CREATE_PERMISSION processed, success/.test(turnLog), 'coturn let a peer in', 5000);
  const allocated = new Set([...turnLog.matchAll(/user <([^>]+)>: incoming packet ALLOCATE processed, success/g)].map(m => m[1]));
  assert.ok(allocated.size >= 1, 'an allocation on coturn:\n' + turnLog.slice(-1500));
  assert.ok([...allocated].every(u => /^\d{10}:[A-Za-z0-9_-]+$/.test(u)), 'the names coturn read are the relay\'s, decoded: ' + [...allocated]);
  assert.doesNotMatch(turnLog, /\b401\b|Unauthorized|wrong message integrity/i, 'no refused credentials');
});
