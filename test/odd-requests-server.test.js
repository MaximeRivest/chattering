'use strict';
// Requests the internet sends to anything it finds (design/85: the relay
// met these within minutes of going online): an address that is not a
// valid URL relative to a base ("//%2e%2e%2f.env", "//[", "*") ended the
// Chattering process before sign-in, with every agent run in it. Each is
// answered, as a plain request and as a WebSocket upgrade, and the server
// is still there after.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r)); return port; }

test('odd request lines are answered, never the end of the server', { timeout: 60000 }, async t => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'odd-requests-')));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  const port = await freePort();
  let log = '';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: String(await freePort()), CHATTERING_PREVIEW_PORT: String(await freePort()),
    CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1', CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, CHATTERING_HOST: '', CHATTERING_LAN: '', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: 'install-tok' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  let exited = null;
  child.on('exit', code => { exited = code; });
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  for (let i = 0; ; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/health')).ok) break; } catch {} if (i > 200) assert.fail('no server\n' + log); await new Promise(r => setTimeout(r, 100)); }
  const raw = (target, extra = '') => new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1', () => s.write('GET ' + target + ' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n' + extra + '\r\n'));
    let out = ''; s.on('data', d => out += d); s.on('close', () => resolve(out.split('\r\n')[0])); s.on('error', e => resolve('error ' + e.code));
  });
  const upgrade = 'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n';
  for (const target of ['//%2e%2e%2f%2eenv', '//evil.example/x', '//[', '/%', '*', 'http://x/', '/api/%', '//%2e%2e/api/collab/x']) {
    assert.match(await raw(target), /^HTTP\/1\.1 \d{3}/, target);
    assert.match(await raw(target, upgrade), /^HTTP\/1\.1 \d{3}|^$/, 'upgrade ' + target);
    assert.equal(exited, null, 'the server ended on ' + target + '\n' + log.slice(-1500));
  }
  assert.equal((await fetch('http://127.0.0.1:' + port + '/health')).ok, true, 'still answering');
});
