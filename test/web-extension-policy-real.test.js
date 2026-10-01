'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { homeEnv } = require('./helpers/home-env.js');

test('hermetic pinned SDK production engine and real RPC discovery contract', { timeout: 90000 }, async t => {
  // Only owned TMPDIR scratch is writable; source may be mounted read-only.
  // No inherited HOME, XDG, credentials, agent dir or project settings.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'chattering-web-policy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), tmp = path.join(root, 'tmp');
  for (const dir of [home, tmp, path.join(root, 'xdg-runtime')]) fs.mkdirSync(dir, { mode: 0o700 });
  // Keep HOME out of the child's temp root: projectfolds deliberately ignores
  // a TMPDIR containing HOME. The project is genuinely loose on every host.
  const project = path.join(tmp, 'project');
  // Resolve the installed native Git before clearing the environment. Only its
  // executable directory (not the operator's whole PATH) reaches the child.
  const gitName = process.platform === 'win32' ? 'git.exe' : 'git';
  const gitOnPath = (process.env.PATH || '').split(path.delimiter).filter(dir => path.isAbsolute(dir))
    .map(dir => path.join(dir, gitName)).find(file => {
      try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
    });
  assert.ok(gitOnPath, 'native Git must already be installed on PATH');
  const git = fs.realpathSync.native(gitOnPath);
  const system = process.platform === 'win32' ? Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(SystemRoot|windir|ComSpec|PATHEXT)$/i.test(key))) : {};
  const nativeTools = process.platform === 'win32'
    ? [path.join(process.env.SystemRoot || process.env.SYSTEMROOT, 'System32')]
    : ['/usr/bin', '/bin'];
  const env = { ...system, ...homeEnv(home),
    PATH: [...new Set([path.dirname(process.execPath), path.dirname(git), ...nativeTools])].join(path.delimiter),
    TMPDIR: tmp, TMP: tmp, TEMP: tmp, WEB_POLICY_GIT: git,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig'), GIT_TERMINAL_PROMPT: '0',
    JITI_FS_CACHE: 'false',
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_CACHE_HOME: path.join(root, 'xdg-cache'), XDG_DATA_HOME: path.join(root, 'xdg-data'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'), XDG_RUNTIME_DIR: path.join(root, 'xdg-runtime'),
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
  assert.equal(evidence.looseUnscopedCapture, false);
  assert.deepEqual(evidence.checkpointArtifactFiles, ['fixture-artifact/widget.html']);
  assert.equal(evidence.sentinelContexts, 3);
  t.diagnostic(result.stdout.trim());
});
