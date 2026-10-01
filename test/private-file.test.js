'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { assertPrivateFileSync, ensurePrivateFileSync, writePrivateFileSync } = require('../private-file');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "private 'file-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Given permissive key storage, When OS protection is established and read back, Then insecure access is rejected and owner access remains', t => {
  const file = path.join(fixture(t), 'key.json');
  fs.writeFileSync(file, 'synthetic key'); fs.chmodSync(file, 0o644);
  // Windows must reject the default inherited DACL, not POSIX mode bits.
  assert.throws(() => assertPrivateFileSync(file));
  ensurePrivateFileSync(file); assertPrivateFileSync(file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic key');
  writePrivateFileSync(file, 'replacement'); assertPrivateFileSync(file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'replacement');
});

test('Given multiply-linked key storage, When protection is requested, Then it fails before altering the other link', t => {
  const dir = fixture(t), file = path.join(dir, 'key'), alias = path.join(dir, 'alias');
  fs.writeFileSync(file, 'synthetic key'); fs.linkSync(file, alias);
  assert.throws(() => ensurePrivateFileSync(file), /singly linked/);
  assert.equal(fs.readFileSync(alias, 'utf8'), 'synthetic key');
});

test('Given Windows cannot establish or verify a DACL, When a key is saved, Then no secret bytes are written and no temporary file is left', t => {
  const dir = fixture(t), file = path.join(dir, 'key'); let writes = 0, queried = false;
  const context = { module: { exports: {} }, __dirname: path.dirname(require.resolve('../private-file')), Buffer, process: { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } }, require(name) {
    if (name === 'node:fs') return { ...fs, writeFileSync() { writes++; assert.fail('secret written before security verification'); } };
    if (name === 'node:child_process') return { execFileSync(_exe, args) {
      queried = true;
      const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
      assert.ok(script.includes('[ChatteringPrivateFile]::Write'));
      assert.deepEqual(fs.readdirSync(dir), [], 'no permissively inherited file is created by the JS caller');
      throw new Error('synthetic ACL readback failed');
    } };
    return require(name);
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../private-file'), 'utf8'), context);
  assert.throws(() => context.module.exports.writePrivateFileSync(file, 'synthetic secret'), /ACL readback failed/);
  assert.equal(queried, true); assert.equal(writes, 0); assert.deepEqual(fs.readdirSync(dir), []);
});

test('Given an OS security failure while opening existing credentials, When Anywhere loads them, Then the failure is not hidden as an empty store', () => {
  for (const name of ['anywhere-home', 'anywhere-link']) {
    const { Module } = require('node:module');
    const file = require.resolve('../' + name), fixture = new Module(file, module);
    fixture.require = spec => spec === './private-file' ? { readPrivateFileSync() { throw new Error('synthetic security denial'); } } : spec.startsWith('.') ? require(path.resolve(path.dirname(file), spec)) : require(spec);
    fixture._compile(fs.readFileSync(file, 'utf8'), file);
    const create = fixture.exports.createAnywhereHome || fixture.exports.createAnywhereLinks;
    assert.throws(() => create({ dataDir: '/synthetic/never-read' }), /security denial/);
  }
});
