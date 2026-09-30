'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { webExtensionArgs, parseExtensionArgs, REQUIRED_EXTENSIONS, extensionPolicyFingerprint, createPaletteGeneration } = require('../web-extension-policy.js');

test('minimal/all share exact required paths; optional provider is explicit; terminal args are not changed', () => {
  const minimal = webExtensionArgs({ discovery: 'minimal' });
  assert.equal(minimal[0], '--no-extensions');
  assert.deepEqual(parseExtensionArgs(minimal).extensionPaths, REQUIRED_EXTENSIONS);
  assert.deepEqual(webExtensionArgs({ discovery: 'all' }), minimal.slice(1));
  assert.deepEqual(webExtensionArgs(), minimal.slice(1));
  assert.deepEqual(parseExtensionArgs(webExtensionArgs({ providerExtension: '/authorized/provider.ts' })).extensionPaths,
    [...REQUIRED_EXTENSIONS, '/authorized/provider.ts']);
  assert.throws(() => webExtensionArgs({ discovery: 'none' }), /all or minimal/);
});
test('no-extensions is a boolean loader option, not an extension flag or consumer of the next prompt-mode', () => {
  for (const option of ['--no-extensions', '-ne']) {
    const parsed = parseExtensionArgs([option, '--prompt-mode', 'coding', '--extension', '/a', '--extension=/b', '-e', '/c']);
    assert.equal(parsed.noExtensions, true);
    assert.deepEqual([...parsed.flags], [['prompt-mode', 'coding']]);
    assert.deepEqual(parsed.extensionPaths, ['/a', '/b', '/c']);
  }
  assert.throws(() => parseExtensionArgs(['-e']), /requires a path/);
});
test('fingerprints change for discovery, mode args, canonical agent directory and generation', () => {
  const target = { cwd: path.resolve('test'), extraArgs: webExtensionArgs({ discovery: 'minimal' }) };
  const env = { HOME: '/fixture', PI_CODING_AGENT_DIR: '/agent' };
  const hash = extensionPolicyFingerprint(target, env);
  assert.equal(hash, extensionPolicyFingerprint({ ...target }, { ...env }));
  assert.equal(hash, extensionPolicyFingerprint({ ...target, extraArgs: ['--name', 'startup only', '--no-session', ...target.extraArgs] }, env));
  for (const change of [{ extraArgs: webExtensionArgs({ discovery: 'all' }) }, { extraArgs: [...target.extraArgs, '--prompt-mode', 'plan'] }, { extensionPolicyGeneration: 2 }]) {
    assert.notEqual(hash, extensionPolicyFingerprint({ ...target, ...change }, env));
  }
  assert.notEqual(hash, extensionPolicyFingerprint(target, { ...env, PI_CODING_AGENT_DIR: '/other' }));
});
test('palette generation prevents old in-flight success or failure from changing a new generation', () => {
  const g = createPaletteGeneration();
  const old = g.current();
  g.invalidate();
  const current = g.current();
  assert.equal(g.isCurrent(old), false);
  assert.equal(g.isCurrent(current), true);
});
