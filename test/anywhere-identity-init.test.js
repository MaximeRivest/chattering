'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { Module } = require('node:module');
function homeFixture(t, failWrite = false) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-init-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const pending = [], writes = []; let imports = 0, seq = 0;
  const protocol = { ...require('../anywhere/protocol'), subtle: () => ({
    generateKey() { const id = ++seq; return new Promise(resolve => pending.push(() => resolve({ privateKey: id, publicKey: id }))); },
    async exportKey(format, id) { return format === 'jwk' ? { d: id } : new Uint8Array([id]).buffer; },
    async importKey(_format, jwk) { imports++; return { d: jwk.d }; },
  }), homeIdOf: async spki => 'home-' + spki[0] };
  const source = require.resolve('../anywhere-home'), m = new Module(source, module);
  const storage = require('../private-file');
  m.require = name => name === './anywhere/protocol.js' ? protocol : name === './private-file' ? { ...storage, writePrivateFileSync(file, bytes) {
    writes.push(JSON.parse(bytes)); if (failWrite) throw new Error('synthetic persistence failure');
    storage.writePrivateFileSync(file, bytes);
  } } : name.startsWith('.') ? require(path.resolve(path.dirname(source), name)) : require(name);
  m._compile(fs.readFileSync(source, 'utf8'), source);
  const home = m.exports.createAnywhereHome({ dataDir, enabled: () => false });
  t.after(() => home.stop());
  return { home, writes, pending, imports: () => imports, file: path.join(dataDir, 'anywhere.json') };
}
test('Given constructor initialization and concurrent homeId requests, When key generation resolves, Then one matched persisted identity is published', async t => {
  const s = homeFixture(t), requests = [s.home.homeId(), s.home.homeId()];
  for (const release of s.pending) release();
  const ids = await Promise.all(requests);
  assert.equal(s.pending.length, 1, 'exactly one generation');
  assert.equal(s.writes.length, 1, 'exactly one persistence');
  assert.equal(s.imports(), 1, 'exactly one import');
  const stored = JSON.parse(fs.readFileSync(s.file, 'utf8')).key;
  assert.equal(stored.jwk.d, Buffer.from(stored.spki, 'base64url')[0], 'private/public pair cannot mix across generations');
  assert.deepEqual(ids, ['home-1', 'home-1']);
});
test('Given persistence fails, When subsequent homeId requests arrive, Then failure stays latched and no volatile identity is returned', async t => {
  const s = homeFixture(t, true), first = assert.rejects(s.home.homeId(), /persistence failure/);
  for (const release of s.pending) release();
  await first;
  await assert.rejects(s.home.homeId(), /persistence failure/);
  assert.equal(s.writes.length, 1); assert.equal(s.imports(), 0);
  assert.equal(fs.existsSync(s.file), false);
});
