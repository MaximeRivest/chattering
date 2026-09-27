'use strict';
// Compaction through Pi's own runtime, both engines, with the fixture
// provider in an isolated home: the summary lands in the session as a
// compaction entry and the conversation goes on from it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
let available = false;
available = !!require('./helpers/pi-package.js').piPackageForTests();

test('compact: both engines write a compaction entry and continue from it', {
  skip: !available && 'Pi executable is unavailable', timeout: 120000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.homedir(), '.compact-real-test-'));
  // The shared cleanup: it ends what still runs from this home (a Pi worker
  // notices a few seconds late) and retries, as Windows cannot delete an
  // open database.
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(null, root));
  const agent = path.join(root, '.pi', 'agent'); await fs.mkdir(agent, { recursive: true });
  // keepRecentTokens 1: a three-message conversation has something to compact.
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'one', defaultThinkingLevel: 'off', compaction: { keepRecentTokens: 1 } }));
  const env = { ...require('./helpers/home-env.js').systemEnv(), ...require('./helpers/home-env.js').homeEnv(root), PATH: process.env.PATH, PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, PI_OFFLINE: '1', JITI_FS_CACHE: 'false', NODE_NO_WARNINGS: '1' };
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(__dirname, 'fixtures/compact-probe.cjs')], { env, timeout: 110000, maxBuffer: 2 * 1024 * 1024 });
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(result.error, undefined, result.error);
  for (const engine of ['sdk', 'rpc']) {
    const r = result[engine];
    assert.ok(r.compaction, engine + ': a compaction entry was written');
    assert.match(r.compaction.summary, /Fixture reply/);
    assert.equal(typeof r.out.tokensBefore, 'number');
    assert.equal(r.replies, 4, engine + ': the conversation continued after compacting');
  }
});
