'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

test('hermetic pinned SDK production engine and real RPC discovery contract', { timeout: 90000 }, async t => {
  // Only owned TMPDIR scratch is writable; source may be mounted read-only.
  // No inherited HOME, XDG, credentials, agent dir or project settings.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'chattering-web-policy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The outer harness supplies an isolated writable HOME outside its logical
  // /tmp. All backing storage is still owned host TMPDIR scratch. Never use a
  // real operator HOME: outside that fixture, require a caller-owned projection.
  const parentHome = os.homedir();
  assert.ok(process.env.USERPROFILE === parentHome && process.env.XDG_RUNTIME_DIR &&
    !require('../projectfolds.js').isLooseCwd(path.join(parentHome, 'work/project')),
    'run this fixture in a clean namespace HOME outside TMPDIR (common run-suite.py)');
  const home = fs.mkdtempSync(path.join(parentHome, 'chattering-web-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, 'work/project');
  const env = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: root,
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_CACHE_HOME: path.join(root, 'xdg-cache'), XDG_DATA_HOME: path.join(root, 'xdg-data'),
    PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_AGENT_DIR: path.join(root, 'legacy-not-used'),
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    CHATTERING_PORT: '1', CHATTERING_CHECKPOINT_DIR: path.join(root, 'checkpoints'),
    CHATTERING_DATA_DIR: path.join(root, 'app-data'), CHATTERING_CONFIG_DIR: path.join(root, 'app-config'), CHATTERING_CACHE_DIR: path.join(root, 'app-cache'),
    WEB_POLICY_PROJECT: project,
    WEB_POLICY_LOG: path.join(root, 'fixture.jsonl'), WEB_POLICY_RELEASE: path.join(root, 'release') };
  const result = await new Promise((resolve, reject) => execFile(process.execPath,
    [path.join(__dirname, 'helpers/web-policy-real.cjs'), root],
    { env, cwd: root, timeout: 80000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stdout + '\n' + stderr + '\n' + error.message)); else resolve({ stdout, stderr });
    }));
  const evidence = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(evidence.sdk, '0.87.1');
  assert.equal(evidence.unanticipatedExtensionErrors, 0);
  assert.equal(evidence.expectedStartupErrors, 2);
  assert.equal(evidence.expectedRuntimeErrors, 1);
  assert.equal(evidence.expectedAmbientLoadErrors, 1);
  assert.equal(evidence.runtimeDisposals, 10);
  assert.equal(evidence.runtimeRecovery, 'dispose-before-healthy-prompt');
  assert.equal(evidence.checkpointsPreserved, true);
  assert.equal(evidence.sentinelContexts, 3);
  t.diagnostic(result.stdout.trim());
});
