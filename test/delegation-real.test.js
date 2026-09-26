'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const D = require('../delegation');
let pi;
// Workers start the Pi the app would run (runtime.js).
pi = require('./helpers/pi-package.js').piPackageForTests();
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('real Pi runner persists a valid mode contract and blocks a changed snapshot before provider work', {
  skip: !pi && 'Pi is not installed; real runner validation is blocked', timeout: 45000,
}, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-real-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const agent = path.join(home, '.pi', 'agent'); await fs.mkdir(agent, { recursive: true });
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'one', defaultThinkingLevel: 'off', retry: { enabled: true, maxRetries: 2, baseDelayMs: 50 } }));
  const parent = path.join(home, 'parent.jsonl');
  await fs.writeFile(parent, JSON.stringify({ type: 'session', version: 3, id: randomUUID(), cwd: home }) + '\n' + JSON.stringify({ type: 'message', id: 'launch', parentId: null, message: { role: 'user', content: 'Fixture parent' } }) + '\n');
  const root = path.join(home, 'records'), marker = path.join(home, 'requests.txt');
  const env = { ...require('./helpers/home-env.js').systemEnv(), ...require('./helpers/home-env.js').homeEnv(home), PATH: process.env.PATH, PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    PI_OFFLINE: '1', JITI_FS_CACHE: 'false', NODE_NO_WARNINGS: '1', FIXTURE_REQUEST_MARKER: marker };
  const options = { root, env, supervision: 'detached', // the runtime's Pi (runtime.js), extra arguments after it
    piArgs: ['--no-extensions', '-e', path.join(__dirname, 'fixtures/pisdk-probe.ts')],
    modeExtensionPath: path.resolve(__dirname, '../extensions/modes.ts') };
  const mode = { key: 'fixture-task', label: 'Fixture task', opener: 'Perform the fixture.', tools: ['bash'] };
  const spec = { title: 'Real Pi fixture', role: 'tester', prompt: 'capture environment', cwd: home,
    model: 'fixture/one', thinking: 'off', mode, tools: mode.tools, parentSessionPath: parent, parentEntryId: 'launch', delivery: 'none' };
  const done = async id => {
    for (let i = 0; i < 400; i++) { const task = await D.getDelegation(id, { root }); if (['succeeded', 'failed', 'cancelled', 'lost'].includes(task.status)) return task; await sleep(40); }
    await D.controlDelegation(id, 'cancel', { root }); throw new Error('Runner fixture timeout');
  };
  const first = await D.launchDelegation(spec, options);
  const result = await done(first.id);
  assert.equal(result.status, 'succeeded', result.error);
  assert.equal(result.modeVerification.sha256, D.modeSha256(mode));
  assert.equal(result.review, 'unreviewed');
  assert.ok((await fs.readFile(marker, 'utf8')).includes('request'));
  await fs.unlink(marker);
  const recovery = await D.launchDelegation({ ...spec, prompt: 'Reply without tools.' }, {
    ...options, env: { ...env, FIXTURE_RETRY_ONCE: '1' },
  });
  const recovered = await done(recovery.id);
  assert.equal(recovered.status, 'succeeded', recovered.error);
  assert.equal(recovered.result.summary, 'Fixture reply.');
  assert.equal(recovered.result.parseProblems, 0);
  assert.equal((await fs.readFile(marker, 'utf8')).trim().split('\n').length, 2);
  const retryEvents = await fs.readFile(recovery.eventLogPath, 'utf8');
  assert.match(retryEvents, /auto_retry_start/);
  assert.match(retryEvents, /auto_retry_end/);
  assert.doesNotMatch(retryEvents, /failure-signalled|failure-kill/);
  await fs.unlink(marker);
  const second = await D.launchDelegation(spec, { ...options, env: { ...env, FIXTURE_MUTATE_MODE: '1' } });
  const rejected = await done(second.id);
  assert.equal(rejected.status, 'failed');
  assert.match(rejected.error, /mode|snapshot|abort|contract/i);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('real Pi worker stopped by a usage limit continues on the same session with another model', {
  skip: !pi && 'Pi is not installed; real runner validation is blocked', timeout: 60000,
}, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-resume-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const agent = path.join(home, '.pi', 'agent'); await fs.mkdir(agent, { recursive: true });
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'one', defaultThinkingLevel: 'off', retry: { enabled: true, maxRetries: 1, baseDelayMs: 20 } }));
  const parent = path.join(home, 'parent.jsonl');
  await fs.writeFile(parent, JSON.stringify({ type: 'session', version: 3, id: randomUUID(), cwd: home }) + '\n' + JSON.stringify({ type: 'message', id: 'launch', parentId: null, message: { role: 'user', content: 'Fixture parent' } }) + '\n');
  const root = path.join(home, 'records');
  const env = { ...require('./helpers/home-env.js').systemEnv(), ...require('./helpers/home-env.js').homeEnv(home), PATH: process.env.PATH, PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    PI_OFFLINE: '1', JITI_FS_CACHE: 'false', NODE_NO_WARNINGS: '1', FIXTURE_LIMIT_MODEL: 'one', FIXTURE_ECHO_HISTORY: '1' };
  const options = { root, env, supervision: 'detached', // the runtime's Pi (runtime.js), extra arguments after it
    piArgs: ['--no-extensions', '-e', path.join(__dirname, 'fixtures/pisdk-probe.ts')],
    modeExtensionPath: path.resolve(__dirname, '../extensions/modes.ts') };
  const mode = { key: 'fixture-task', label: 'Fixture task', opener: 'Perform the fixture.', tools: ['bash'] };
  const spec = { title: 'Limited worker', role: 'tester', prompt: 'Reply without tools.', cwd: home,
    model: 'fixture/one', thinking: 'off', mode, tools: mode.tools, parentSessionPath: parent, parentEntryId: 'launch', delivery: 'none' };
  const done = async id => {
    for (let i = 0; i < 600; i++) { const task = await D.getDelegation(id, { root }); if (['succeeded', 'failed', 'cancelled', 'lost'].includes(task.status)) return task; await sleep(40); }
    await D.controlDelegation(id, 'cancel', { root }); throw new Error('Runner fixture timeout');
  };
  const task = await D.launchDelegation(spec, options);
  const stopped = await done(task.id);
  assert.equal(stopped.status, 'failed', stopped.error);
  assert.equal(stopped.failure.kind, 'usage-limit');
  assert.ok(stopped.leafId, 'the stop records where the session ended');
  // Same model would fail again under this fixture; the parent chooses another one.
  const resumed = await D.resumeDelegation(task.id, { model: 'fixture/two', parentSessionPath: parent, instructions: 'Keep going.' }, options);
  assert.equal(resumed.attempt, 2);
  const finished = await done(task.id);
  assert.equal(finished.status, 'succeeded', finished.error);
  assert.equal(finished.model, 'fixture/two');
  assert.equal(finished.modeVerification.status, 'verified');
  assert.ok(finished.modeVerification.snapshots >= 2, 'each attempt saved its mode contract');
  // Pi loaded the first attempt: the original prompt and the resume prompt are both user messages it saw.
  assert.equal(finished.result.summary, 'Fixture reply after 2 user messages.');
  const header = JSON.parse((await fs.readFile(task.sessionPath, 'utf8')).split('\n')[0]);
  assert.equal(header.id, task.id);
  await assert.rejects(D.resumeDelegation(task.id, {}, options), /Only failed or lost/);
});
