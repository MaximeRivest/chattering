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
test('installed SDK: same-model rewrite, saved hidden request, identical context prefix on the next turn', {
  skip: !available && 'Pi is unavailable', timeout: 60000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.homedir(), '.pisdk-rewrite-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agent = path.join(root, '.pi', 'agent'); await fs.mkdir(agent, { recursive: true });
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'one', defaultThinkingLevel: 'off' }));
  const env = { HOME: root, PATH: process.env.PATH, PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent,
    PI_OFFLINE: '1', JITI_FS_CACHE: 'false', NODE_NO_WARNINGS: '1' };
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(__dirname, 'fixtures/pisdk-rewrite-probe.cjs')], { env, timeout: 55000, maxBuffer: 2 * 1024 * 1024 });
  assert.deepEqual(JSON.parse(stdout.trim().split('\n').at(-1)), { verified: true, requests: 3 });
});
