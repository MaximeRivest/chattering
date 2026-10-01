'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { command, install } = require('./title-fixture-progress.cjs');
const { spawn } = require('node:child_process');
const { systemEnv, observeChild, probe, stop } = require('./title-fixture-child.cjs');
const { until } = require('./title-api-fixture.cjs');
function observed(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'title-progress-')), file = path.join(root, 'progress.json');
  class Server extends EventEmitter {}
  const cp = { execFileSync() {}, spawnSync() {}, execFile() { return new EventEmitter(); }, spawn() { return new EventEmitter(); }, ...overrides };
  const original = { ...cp }, emit = Server.prototype.emit;
  const restore = install(file, cp, { Server }, { PATH: root, CHATTERING_PI_CLI: path.join(root, 'fake-pi.cjs'), CHATTERING_TITLE_FIXTURE_PROJECT: root });
  t.after(() => { restore(); assert.deepEqual(cp, original); assert.equal(Server.prototype.emit, emit); fs.rmSync(root, { recursive: true, force: true }); });
  return { cp, Server, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('progress command labels disclose no arguments, prompts or URL tokens', () => {
  const env = { CHATTERING_PI_CLI: '/fixture/fake-pi.cjs' };
  assert.equal(command('/node', [env.CHATTERING_PI_CLI, '--system-prompt', 'secret-prompt'], env), 'fake-pi inference');
  assert.equal(command('/git', ['-C', 'private-path', 'rev-parse', '--git-common-dir'], env), 'git rev-parse');
  assert.equal(command('/ps', ['private-session', 'https://localhost/?token=secret'], env), 'ps');
});

test('progress persists a synchronous operation before it blocks, preserving return and throw identity', t => {
  const sentinel = new Error('original failure'); let context;
  const fixture = observed(t, { execFileSync(...args) {
    assert.equal(fixture.read().pending[0].operation, 'execFileSync git config');
    assert.deepEqual(args, ['git', ['config', '--global', 'user.name'], { timeout: 2000 }]);
    assert.equal(this, context); return 'unchanged stdout';
  }, spawnSync() { throw sentinel; } });
  context = fixture.cp;
  assert.equal(fixture.cp.execFileSync('git', ['config', '--global', 'user.name'], { timeout: 2000 }), 'unchanged stdout');
  assert.throws(() => fixture.cp.spawnSync('ps', []), error => error === sentinel);
  assert.deepEqual(fixture.read().pending, []);
  assert.equal(fixture.read().events.at(-1).event, 'throw');
  assert.equal(fixture.read().preflight.projectHasGit, false);
  assert.equal(fixture.read().preflight.git, null);
});

test('progress awaits the actual execFile callback, not an earlier child close, without changing callback values', t => {
  const child = new EventEmitter(), options = { timeout: 5000 }; let actualCallback;
  const fixture = observed(t, { execFile(file, args, opts, callback) {
    assert.equal(file, 'node'); assert.deepEqual(args, ['fake']); assert.equal(opts, options);
    actualCallback = callback; return child;
  } });
  const error = new Error('original'); let answered = false;
  assert.equal(fixture.cp.execFile('node', ['fake'], options, function (err, stdout, stderr) {
    assert.equal(this, child); assert.equal(err, error); assert.equal(stdout, 'original stdout'); assert.equal(stderr, 'original stderr'); answered = true;
  }), child);
  child.emit('close', 1);
  assert.equal(fixture.read().pending.length, 1); assert.equal(answered, false);
  actualCallback.call(child, error, 'original stdout', 'original stderr');
  assert.equal(answered, true); assert.deepEqual(fixture.read().pending, []);
  assert.equal(fixture.read().events.at(-1).event, 'callback');
});

test('progress diagnoses a real child blocked in execFileSync before an IPC timeout', { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'title-progress-child-'));
  const home = path.join(root, 'home'), tmp = path.join(root, 'tmp'), file = path.join(root, 'progress.json'), release = path.join(root, 'release');
  fs.mkdirSync(home); fs.mkdirSync(tmp);
  const inner = `const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);}},10);`;
  const code = `require(${JSON.stringify(require.resolve('./title-fixture-progress.cjs'))});
process.on('message', p=>{if(p.operation==='block')require('node:child_process').execFileSync(process.execPath,['-e',${JSON.stringify(inner)}]);process.send({id:p.id,value:'ok'});});`;
  const env = { ...systemEnv(), HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home,
    APPDATA: home, LOCALAPPDATA: home, CHATTERING_TITLE_FIXTURE_PROGRESS: file };
  const child = spawn(process.execPath, ['-e', code], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const state = observeChild(child, [], { progressFile: file });
  t.after(async () => { fs.writeFileSync(release, 'release'); await stop(state); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(await probe(state, 'ready'), 'ok');
  const blocked = probe(state, 'block'); blocked.catch(() => {});
  try {
    await until(() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).pending.some(item => item.operation.startsWith('execFileSync ')); } catch { return false; } }, 'actual synchronous command started', 1000);
    await assert.rejects(probe(state, 'entered', 50), error => {
      assert.match(error.message, /probe entered: Error: IPC reply timed out/);
      assert.match(error.message, /exit=null closed=false/);
      assert.match(error.message, /"pending":\[\{"id":\d+,"operation":"execFileSync node/);
      assert.match(error.message, /"ageMs":\d+/);
      return true;
    });
  } finally { fs.writeFileSync(release, 'release'); }
  assert.equal(await blocked, 'ok');
  assert.equal(await probe(state, 'after-release'), 'ok');
});

test('progress observes real HTTP completion, preserving dispatch and removing query credentials', t => {
  const fixture = observed(t), server = new fixture.Server(), response = new EventEmitter();
  response.statusCode = 202;
  const request = { method: 'POST', url: '/api/rescan?token=private' };
  let received;
  server.on('request', (...args) => { received = args; });
  assert.equal(server.emit('request', request, response), true);
  assert.deepEqual(received, [request, response]);
  assert.equal(fixture.read().pending[0].operation, 'HTTP POST /api/rescan');
  assert.ok(!JSON.stringify(fixture.read()).includes('private'));
  response.emit('finish'); response.emit('close');
  assert.deepEqual(fixture.read().pending, []);
  assert.equal(fixture.read().events.at(-1).event, 'finish');
  assert.equal(fixture.read().events.at(-1).code, 202);
});
