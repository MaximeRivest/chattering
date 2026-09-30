'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const net = require('node:net'), http = require('node:http');
const { spawn } = require('node:child_process'), { EventEmitter } = require('node:events');
const { systemEnv, sanitize, observeChild, within, request, probe, stop } = require('./title-fixture-child.cjs');
const { until } = require('./title-api-fixture.cjs');

function mini(t, code, secrets = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'title-fixture-child-'));
  const home = path.join(root, 'home'), tmp = path.join(root, 'tmp');
  fs.mkdirSync(home); fs.mkdirSync(tmp);
  const env = { ...systemEnv(), HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home,
    APPDATA: home, LOCALAPPDATA: home };
  const child = spawn(process.execPath, ['-e', code], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const state = observeChild(child, secrets);
  t.after(async () => { await stop(state); fs.rmSync(root, { recursive: true, force: true }); });
  return state;
}
async function listen(t, server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }));
  return 'http://127.0.0.1:' + server.address().port;
}

test('fixture Windows environment contains only system executables, not inherited user paths or secrets', () => {
  const result = systemEnv('win32', { SystemRoot: 'C:\\Windows', PATH: 'user-provider', HOME: 'real-home', TOKEN: 'secret' }, 'D:\\node\\node.exe');
  assert.deepEqual(result, { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: 'D:\\node;C:\\Windows\\System32;C:\\Windows' });
  assert.deepEqual(systemEnv('linux', { PATH: 'user-provider' }), { PATH: '/usr/bin:/bin' });
  assert.throws(() => systemEnv('win32', {}), /SystemRoot/);
});

test('fixture diagnostics remove URL credentials, all query values, fragments and bearer tokens', () => {
  const clean = sanitize('secret Bearer other-secret https://user:pass@localhost/api/session?id=private-id&token=url-secret#fragment-secret', ['secret']);
  for (const privateText of ['user:', 'pass@', 'private-id', 'url-secret', 'fragment-secret', 'other-secret']) assert.ok(!clean.includes(privateText), clean);
  assert.match(clean, /localhost\/api\/session\?id=/);
  assert.match(clean, /Bearer \[redacted\]/);
  assert.ok(!sanitize('secret', ['secret']).includes('secret'));
});

test('fixture reset failure captures request path, separate stderr and real child exit, sanitized', { timeout: 5000 }, async t => {
  const state = mini(t, `process.stderr.write('crash marker https://localhost/?token=hidden#also-hidden\\n'); process.exit(17);`);
  await within(state.done, 2000);
  const base = await listen(t, net.createServer(socket => socket.destroy()));
  await assert.rejects(request(state, base + '/api/project/title?token=request-secret', { method: 'POST' }), error => {
    assert.match(error.message, /POST http:\/\/127\.0\.0\.1:\d+\/api\/project\/title/);
    assert.match(error.message, /child stderr \(tail\):\ncrash marker/);
    assert.match(error.message, /exit=\{"code":17,"signal":null\} closed=true/);
    assert.ok(!error.message.includes('hidden') && !error.message.includes('request-secret'), error.message);
    return true;
  });
});

test('fixture request bounds a server that never responds, preserving diagnostic URL', { timeout: 5000 }, async t => {
  const state = mini(t, `setInterval(()=>{},1000);`);
  const base = await listen(t, http.createServer(() => {}));
  await assert.rejects(within(request(state, base + '/api/rescan', { method: 'POST' }, 50), 1500), /Title fixture POST .*\/api\/rescan: TimeoutError/);
});

test('fixture IPC timeout removes listeners; later probes still succeed', { timeout: 5000 }, async t => {
  const state = mini(t, `process.on('message', p => { if(p.operation==='echo') process.send({id:p.id,value:'ok'}); });`);
  assert.equal(await probe(state, 'echo'), 'ok');
  const counts = ['message', 'close', 'error'].map(event => state.child.listenerCount(event));
  await assert.rejects(probe(state, 'ignored', 50), /probe ignored: Error: IPC reply timed out/);
  assert.deepEqual(['message', 'close', 'error'].map(event => state.child.listenerCount(event)), counts);
  assert.equal(await probe(state, 'echo'), 'ok');
});

test('fixture IPC rejects promptly with stderr and exit if the child dies before replying', { timeout: 5000 }, async t => {
  const state = mini(t, `process.on('message', () => { process.stderr.write('probe crash\\n'); process.exit(19); });`);
  await assert.rejects(probe(state, 'crash'), error => {
    assert.match(error.message, /probe crash/);
    assert.match(error.message, /exit=\{"code":19,"signal":null\} closed=true/);
    assert.match(error.message, /probe crash\n/);
    return true;
  });
  await assert.rejects(probe(state, 'after-close'), /Child IPC unavailable/);
});

test('fixture stop waits for close after signal exit and is safe to repeat', async () => {
  // Simulates exitCode=null, signalCode=SIGTERM followed by delayed stdio close.
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.pid = 123; child.kill = () => { throw new Error('must not re-kill an exited child'); };
  const state = observeChild(child);
  child.emit('exit', null, 'SIGTERM');
  let removed = false;
  const cleanup = stop(state, 100).then(() => { removed = true; });
  await Promise.resolve(); assert.equal(removed, false);
  child.stderr.emit('data', Buffer.from('last stderr before close'));
  child.emit('close', null, 'SIGTERM');
  await cleanup;
  assert.equal(removed, true); assert.match(state.log(), /last stderr/);
  await stop(state);
});

test('fixture condition deadline includes awaited predicates, not just polling sleeps', async () => {
  await assert.rejects(within(until(() => new Promise(() => {}), 'never replies', 30), 1000), /never replies: Timed out after/);
});
