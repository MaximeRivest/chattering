'use strict';
// /api/speech/stream is carried to the speech service's /stream, with the
// one thing the page may ask of it: interim=<ms>, a preview during speech
// as well as at pauses (app.html). Nothing else of the page's query passes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const TOKEN = 'speech-proxy-token';
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }

test('the speech stream reaches the service with interim, and only it', { timeout: 60000 }, async t => {
  const lines = [];
  const service = net.createServer(socket => {
    let got = '';
    socket.on('data', b => {
      got += b;
      if (!got.includes('\r\n\r\n')) return;
      lines.push(got.split('\r\n')[0]);
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    });
    socket.on('error', () => {});
  });
  await new Promise(r => service.listen(0, '127.0.0.1', r));
  t.after(() => service.close());

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-proxy-'));
  const agent = path.join(home, '.pi', 'agent');
  fs.mkdirSync(path.join(agent, 'sessions'), { recursive: true });
  require('./helpers/first-run.js').answerFirstRun(home);
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home),
    PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: TOKEN, CHATTERING_NO_WATCH: '1', CHATTERING_NO_SYNC: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, SPEECH_URL: 'http://127.0.0.1:' + service.address().port } });
  let log = ''; child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    if (i > 200) assert.fail('server did not start\n' + log);
    await new Promise(r => setTimeout(r, 100));
  }

  const open = query => new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/speech/stream' + query, headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Authorization: 'Bearer ' + TOKEN } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(); });
    req.on('response', res => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.end();
  });
  const seen = async query => {
    const before = lines.length;
    await open(query);
    for (let i = 0; i < 100 && lines.length === before; i++) await new Promise(r => setTimeout(r, 20));
    return lines[before];
  };
  assert.equal(await seen(''), 'GET /stream HTTP/1.1');
  assert.equal(await seen('?interim=700'), 'GET /stream?interim=700 HTTP/1.1');
  assert.equal(await seen('?interim=700&model=x'), 'GET /stream?interim=700 HTTP/1.1', 'only interim passes');
  assert.equal(await seen('?interim=7%20HTTP/1.1%0d%0aX:%201'), 'GET /stream HTTP/1.1', 'a number or nothing');
  assert.equal(await seen('?model=x'), 'GET /stream HTTP/1.1');
});
