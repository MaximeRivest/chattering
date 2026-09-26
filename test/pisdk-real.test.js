'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
let available = false;
available = !!require('./helpers/pi-package.js').piPackageForTests();

test('real SDK in isolated processes: environment, tool execution, dialogs, idle callbacks and custom persistence', {
  skip: !available && 'Pi executable is unavailable; real SDK integration is not validated', timeout: 60000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.homedir(), '.pisdk-real-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agent = path.join(root, '.pi', 'agent'); await fs.mkdir(agent, { recursive: true });
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'one', defaultThinkingLevel: 'off' }));
  // No inherited credentials, user settings, extensions, or provider endpoints.
  const env = { ...require('./helpers/home-env.js').systemEnv(), ...require('./helpers/home-env.js').homeEnv(root), PATH: process.env.PATH, PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    PI_OFFLINE: '1', JITI_FS_CACHE: 'false', NODE_NO_WARNINGS: '1', FIXTURE_CHECKPOINT_WRITE: '1', FIXTURE_SPEED_STREAM: '1' };
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.join(__dirname, 'fixtures/pisdk-probe.cjs')], { env, timeout: 55000, maxBuffer: 2 * 1024 * 1024 });
  assert.ok(!stderr.includes('AssertionError'), stderr);
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(result.callbacks, 1);
  assert.equal(result.customMessagePersisted, true);
  assert.equal(result.toolCheckpointsVerified, true);
  assert.notEqual(result.isolatedPids[0], result.isolatedPids[1]);
});
