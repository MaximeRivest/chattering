'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const available = !!require('./helpers/pi-package').piPackageForTests();
test('real Pi provider and extension completions run inside one SDK worker without a model call', {
  skip: !available && 'Installed Pi is unavailable', timeout: 60000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.homedir(), '.pi-composer-test-'));
  t.after(() => require('./helpers/cleanup').stopAndRemove(null, root));
  const agent = path.join(root, '.pi/agent'); await fs.mkdir(agent, { recursive: true });
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'one', defaultThinkingLevel: 'off' }));
  const env = { ...require('./helpers/home-env').systemEnv(), ...require('./helpers/home-env').homeEnv(root), PATH: process.env.PATH,
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, PI_OFFLINE: '1', JITI_FS_CACHE: 'false', NODE_NO_WARNINGS: '1', FIXTURE_REQUEST_MARKER: path.join(root, 'model-requests') };
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(__dirname, 'fixtures/pi-composer-probe.cjs')], { env, timeout: 55000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(JSON.parse(stdout.trim().split('\n').at(-1)).modelCalls, 0);
});
