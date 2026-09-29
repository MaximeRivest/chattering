'use strict';
// A delegated worker (a separate Pi process) records before/after
// checkpoints for its own tool steps, under its own session file, so its
// edits can be reviewed like a web session's (design/79).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const D = require('../delegation');
const pi = require('./helpers/pi-package.js').piPackageForTests();
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('a delegated worker checkpoints its own write steps', { skip: !pi && 'Pi is not installed', timeout: 60000 }, async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'delegation-cp-')));
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(null, home));
  const agent = path.join(home, '.pi', 'agent'); await fs.mkdir(agent, { recursive: true });
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'one', defaultThinkingLevel: 'off' }));
  const work = path.join(home, 'work'); await fs.mkdir(work);
  execFileSync('git', ['init', '-q'], { cwd: work });
  const parent = path.join(home, 'parent.jsonl');
  await fs.writeFile(parent, JSON.stringify({ type: 'session', version: 3, id: randomUUID(), cwd: work }) + '\n' + JSON.stringify({ type: 'message', id: 'launch', parentId: null, message: { role: 'user', content: 'Fixture parent' } }) + '\n');
  const root = path.join(home, 'records'), checkpoints = path.join(home, 'checkpoints');
  const env = { ...require('./helpers/home-env.js').systemEnv(), ...require('./helpers/home-env.js').homeEnv(home), PATH: process.env.PATH, PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    PI_OFFLINE: '1', JITI_FS_CACHE: 'false', NODE_NO_WARNINGS: '1', FIXTURE_CHECKPOINT_WRITE: '1', CHATTERING_CHECKPOINT_DIR: checkpoints };
  delete env.CHATTERING_NO_CHECKPOINTS;
  const mode = { key: 'fixture-task', label: 'Fixture task', opener: 'Perform the fixture.', tools: ['bash', 'write'] };
  const task = await D.launchDelegation({ title: 'Checkpointed worker', role: 'tester', prompt: 'capture environment', cwd: work,
    model: 'fixture/one', thinking: 'off', mode, tools: mode.tools, parentSessionPath: parent, parentEntryId: 'launch', delivery: 'none' },
  { root, env, supervision: 'detached', piArgs: ['--no-extensions', '-e', path.join(__dirname, 'fixtures/pisdk-probe.ts')],
    modeExtensionPath: path.resolve(__dirname, '../extensions/modes.ts') });
  let done;
  for (let i = 0; i < 600 && !done; i++) { const s = await D.getDelegation(task.id, { root }); if (D.TERMINAL?.has?.(s.status) || ['succeeded', 'failed', 'cancelled', 'lost'].includes(s.status)) done = s; else await sleep(50); }
  assert.equal(done?.status, 'succeeded', done?.error);
  assert.equal(await fs.readFile(path.join(work, 'scratch/probe.txt'), 'utf8'), 'target checkpoint');

  const { CheckpointStore } = require('../checkpoint-store');
  const store = new CheckpointStore(checkpoints);
  t.after(() => store.close());
  const rows = store.boundaries(done.sessionPath, ['env-probe', 'target-probe']);
  const phases = call => rows.filter(r => r.call === call).map(r => r.phase);
  assert.deepEqual(phases('target-probe'), ['before', 'after'], 'the write step has its own before/after pair');
  // The test folder is under the temporary folder, where only a step's named
  // targets are kept (design/67): a shell step names none.
  assert.deepEqual(phases('env-probe'), [], 'a temporary folder is never scanned whole');
  const after = rows.find(r => r.call === 'target-probe' && r.phase === 'after');
  const saved = store.targets(after.id).find(x => x.location.path === path.join(work, 'scratch/probe.txt'));
  assert.ok(saved?.version, 'the written file is saved as it was after the step');
  assert.equal((await store.targetContent(saved.location.path, saved.version, saved.storage)).text, 'target checkpoint');
});
