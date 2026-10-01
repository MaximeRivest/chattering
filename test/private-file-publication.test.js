'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { Module } = require('node:module');
function fixture(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d;
}
function storage(fake = fs) {
  const file = require.resolve('../private-file'), m = new Module(file, module);
  m.require = spec => spec === 'node:fs' ? fake : require(spec);
  m._compile(fs.readFileSync(file, 'utf8'), file); return m.exports;
}
// This is a POSIX source/OS check, not a Windows DACL check. On Windows,
// the locked destination and cleanup tests run actual NTFS operations instead.
if (process.platform !== 'win32') {
  test('Given an attacker-writable publication directory and an existing credential, When staging would be substituted between check and rename, Then refusal occurs before staging and the original identity survives', t => {
    const parent = fixture(t), file = path.join(parent, 'key');
    fs.writeFileSync(file, 'existing identity', { mode: 0o600 }); fs.chmodSync(parent, 0o777);
    let raced = false;
    const api = storage({ ...fs, renameSync(from, to) {
      raced = true; fs.unlinkSync(from); fs.writeFileSync(from, 'attacker identity', { mode: 0o600 });
      fs.renameSync(from, to);
    } });
    let failure; try { api.writePrivateFileSync(file, 'new identity'); } catch (e) { failure = e; }
    assert.equal(fs.readFileSync(file, 'utf8'), 'existing identity', 'a post-rename check is too late to preserve the credential');
    assert.ok(failure, 'unsafe parent must be refused');
    assert.equal(raced, false, 'no publication may be attempted');
    assert.deepEqual(fs.readdirSync(parent), ['key'], 'no staging file in the unsafe directory');
    assert.equal(fs.statSync(parent).mode & 0o777, 0o777, 'do not chmod shared directories');
  });
  test('Given a protected publication directory replaceable through an unsafe ancestor, When writing credentials, Then ancestor refusal preserves the existing identity', t => {
    const outer = fixture(t), parent = path.join(outer, 'private'); fs.mkdirSync(parent, { mode: 0o700 });
    const file = path.join(parent, 'key'); fs.writeFileSync(file, 'existing identity', { mode: 0o600 });
    fs.chmodSync(outer, 0o777);
    assert.throws(() => storage().writePrivateFileSync(file, 'replacement'), /publication|directory/i);
    assert.equal(fs.readFileSync(file, 'utf8'), 'existing identity');
    assert.deepEqual(fs.readdirSync(parent), ['key']);
    assert.equal(fs.statSync(outer).mode & 0o777, 0o777);
  });
  test('Given an alias to an unsafe publication directory, When publication is requested, Then refusal leaves both credential and alias untouched', t => {
    const outer = fixture(t), parent = path.join(outer, 'private'), alias = path.join(outer, 'alias');
    fs.mkdirSync(parent, { mode: 0o700 }); fs.symlinkSync(parent, alias);
    const file = path.join(parent, 'key'); fs.writeFileSync(file, 'existing identity', { mode: 0o600 });
    fs.chmodSync(parent, 0o777);
    assert.throws(() => storage().writePrivateFileSync(path.join(alias, 'key'), 'replacement'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'existing identity');
    assert.equal(fs.readlinkSync(alias), parent); assert.deepEqual(fs.readdirSync(parent), ['key']);
  });
  test('Given a trusted publication chain and missing private descendants, When writing, Then only new owner-controlled directories are created and the existing parent mode stays unchanged', t => {
    const parent = fixture(t); fs.chmodSync(parent, 0o755);
    const file = path.join(parent, 'new', 'child', 'key'), oldMask = process.umask(0o022);
    try { storage().writePrivateFileSync(file, 'identity'); } finally { process.umask(oldMask); }
    assert.equal(fs.readFileSync(file, 'utf8'), 'identity');
    assert.equal(fs.statSync(parent).mode & 0o777, 0o755);
    for (const dir of [path.join(parent, 'new'), path.dirname(file)]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });
}


test('Given Windows reports a primary write failure and failed erasure, When the actual JS adapter propagates it, Then primary cause and retained-state details survive', t => {
  const parent = fixture(t), file = path.join(parent, 'key');
  const failure = { message: 'primary publication failure', nativeErrorCode: 32, retainTemporaryState: true, temporaryFile: file + '.retained.tmp', cleanupFailure: 'erase failed' };
  const vm = require('node:vm'), context = { module: { exports: {} }, __dirname: path.dirname(require.resolve('../private-file')), Buffer,
    process: { platform: 'win32', env: { SystemRoot: 'C:\Windows' } }, require(spec) {
      if (spec === 'node:child_process') return { execFileSync() { return 'ERROR:' + Buffer.from(JSON.stringify(failure)).toString('base64'); } };
      return require(spec);
    } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../private-file'), 'utf8'), context);
  assert.throws(() => context.module.exports.writePrivateFileSync(file, 'new identity'), e => {
    assert.equal(e.message, failure.message); assert.equal(e.nativeErrorCode, 32);
    assert.equal(e.retainTemporaryState, true); assert.equal(e.temporaryFile, failure.temporaryFile);
    assert.equal(e.cleanupFailure, 'erase failed'); return true;
  });
});
