'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { Module } = require('node:module');
function dir(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'key-races-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function source(name, overrides) {
  const file = require.resolve('../' + name), m = new Module(file, module);
  m.require = spec => overrides[spec] || (spec.startsWith('.') ? require(path.resolve(path.dirname(file), spec)) : require(spec));
  m._compile(fs.readFileSync(file, 'utf8'), file); return m.exports;
}
for (const name of ['anywhere-home', 'anywhere-link']) {
  test(`Given corrupt ${name} credentials, When they load, Then corruption is fatal rather than resetting identity`, t => {
    const d = dir(t), file = path.join(d, name === 'anywhere-home' ? 'anywhere.json' : 'anywhere-links.json');
    fs.writeFileSync(file, '{corrupt', { mode: 0o600 });
    const api = source(name, {}), create = api.createAnywhereHome || api.createAnywhereLinks;
    assert.throws(() => create({ dataDir: d, enabled: () => false }), /JSON|corrupt|Unexpected|property/i);
  });
  test(`Given denied ${name} credential reads, When they load, Then access failure is fatal rather than resetting identity`, t => {
    const d = dir(t), file = path.join(d, name === 'anywhere-home' ? 'anywhere.json' : 'anywhere-links.json');
    fs.writeFileSync(file, '{}', { mode: 0o600 });
    const error = Object.assign(new Error('synthetic read denied'), { code: 'EACCES' });
    const fake = { ...fs, readFileSync(target, ...args) { if (typeof target === 'number' || target === file) throw error; return fs.readFileSync(target, ...args); } };
    const storage = source('private-file', { 'node:fs': fake });
    if (process.platform === 'win32') storage.readPrivateFileSync = () => { throw error; }; // native denial controls live in private-file-native.test.js
    const api = source(name, { fs: fake, './private-file': storage }), create = api.createAnywhereHome || api.createAnywhereLinks;
    assert.throws(() => create({ dataDir: d, enabled: () => false }), e => e === error);
  });
}
test('Given a link pathname is replaced or removed after acquisition, When credentials are read, Then the acquired object supplies the identity or the operation fails closed', t => {
  if (process.platform === 'win32') {
    const d = dir(t), file = path.join(d, 'anywhere-links.json');
    require('../private-file').writePrivateFileSync(file, JSON.stringify({ links: [{ id: 'original' }] }));
    const fake = { ...fs, readFileSync(target, ...args) {
      if (target === file) assert.fail('credential pathname reopened after handle verification');
      return fs.readFileSync(target, ...args);
    } };
    const storage = source('private-file', { 'node:fs': fake });
    const api = source('anywhere-link', { fs: fake, './private-file': storage });
    assert.ok(api.createAnywhereLinks({ dataDir: d }).find('original'));
    // Actual Windows replacement/retained-reader exclusions are exercised by
    // private-file-native.test.js using the production C# acquired handle.
    return;
  }
  for (const replacement of ['replace', 'remove']) {
    const d = dir(t), file = path.join(d, 'anywhere-links.json');
    fs.writeFileSync(file, JSON.stringify({ links: [{ id: 'original' }] }), { mode: 0o600 });
    let swapped = false;
    const swap = () => { if (swapped) return; swapped = true; fs.renameSync(file, file + '.old'); if (replacement === 'replace') fs.writeFileSync(file, JSON.stringify({ links: [{ id: 'attacker' }] }), { mode: 0o644 }); };
    const fake = { ...fs, openSync(target, ...args) { const fd = fs.openSync(target, ...args); if (target === file) swap(); return fd; }, readFileSync(target, ...args) { if (target === file) swap(); return fs.readFileSync(target, ...args); } };
    const storage = source('private-file', { 'node:fs': fake }), api = source('anywhere-link', { fs: fake, './private-file': storage });
    const links = api.createAnywhereLinks({ dataDir: d, rtc: { error: 'not used' }, authorize: () => false });
    assert.equal(swapped, true);
    assert.ok(links.find('original'), 'the verified acquired file, never a later pathname replacement or empty reset');
    assert.equal(links.find('attacker'), null);
  }
});
test('Given Windows atomic creation is required, When saving a key, Then the JS adapter never opens a permissively inherited file before invoking native secure creation', t => {
  const d = dir(t), file = path.join(d, 'key'); let insecureOpen = false;
  // Reload actual source with a controlled Windows platform, not an OS ACL proof.
  const vm = require('node:vm'), context = { module: { exports: {} }, __dirname: path.dirname(require.resolve('../private-file')), Buffer,
    process: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } }, require(spec) {
      if (spec === 'node:fs') return { ...fs, openSync(...args) { insecureOpen = true; return fs.openSync(...args); } };
      if (spec === 'node:child_process') return { execFileSync() { return 'OK'; } };
      return require(spec);
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../private-file'), 'utf8'), context);
  context.module.exports.writePrivateFileSync(file, 'synthetic secret');
  assert.equal(insecureOpen, false, 'a pre-protection handle could retain read access forever');
});


test('Given the real native helper source, When the Windows adapter launches PowerShell, Then bootstrap length stays below Windows process limits', t => {
  const vm = require('node:vm'), d = dir(t); let called = false;
  const context = { module: { exports: {} }, __dirname: path.dirname(require.resolve('../private-file')), Buffer,
    process: { platform: 'win32', env: { SystemRoot: 'C:\Windows' } }, require(spec) {
      if (spec === 'node:child_process') return { execFileSync(_exe, args) {
        called = true;
        assert.ok(args.join(' ').length < 10000, 'code/payload must not overflow the 32767-character CreateProcess limit');
        return 'OK';
      } };
      return require(spec);
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../private-file'), 'utf8'), context);
  context.module.exports.writePrivateFileSync(path.join(d, 'key'), 'synthetic secret');
  assert.equal(called, true);
});


test('Given ENOENT occurs after credential acquisition rather than at initial open, When the link store loads, Then the error is propagated rather than resetting identity', t => {
  const d = dir(t), file = path.join(d, 'anywhere-links.json');
  fs.writeFileSync(file, JSON.stringify({ links: [] }), { mode: 0o600 });
  const error = Object.assign(new Error('synthetic post-acquisition ENOENT'), { code: 'ENOENT' });
  const fake = { ...fs, readFileSync(target, ...args) { if (target === file || typeof target === 'number') throw error; return fs.readFileSync(target, ...args); } };
  const storage = source('private-file', { 'node:fs': fake });
  if (process.platform === 'win32') storage.readPrivateFileSync = () => { throw error; };
  const api = source('anywhere-link', { fs: fake, './private-file': storage });
  assert.throws(() => api.createAnywhereLinks({ dataDir: d }), e => e === error);
});
