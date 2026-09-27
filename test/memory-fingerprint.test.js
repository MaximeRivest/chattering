'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fingerprint, upgradeLeaf } = require('../memory-fingerprint.js');
const messages = [{ role: 'user', text: 'Hello', ts: '2026-01-01' }, { role: 'assistant', text: 'Hi', off: true }];
function fixture() {
  return { leaf: { key: 'pi:test', v: 2, builtAt: 123, abstract: 'Keep me', memoryHash: fingerprint(messages, true) },
    entry: { memoryHash: fingerprint(messages) }, cached: { key: 'pi:test', messages } };
}
test('migrates only the fingerprint and retains extraction and timestamp', () => {
  const { leaf, entry, cached } = fixture();
  const result = upgradeLeaf(leaf, entry, cached);
  assert.equal(result.memoryHash, entry.memoryHash);
  assert.equal(result.abstract, leaf.abstract);
  assert.equal(result.builtAt, 123);
  assert.equal(result.fingerprintMigration.from, leaf.memoryHash);
  assert.notEqual(leaf.memoryHash, entry.memoryHash);
  assert.equal(upgradeLeaf(result, entry, cached), result);
});
test('content, time and branch changes remain stale', () => {
  for (const change of [{text:'Changed'}, {ts:'2026-02-01'}, {off:true}]) {
    const { leaf, entry, cached } = fixture();
    cached.messages = [{ ...messages[0], ...change }, messages[1]];
    entry.memoryHash = fingerprint(cached.messages);
    assert.equal(upgradeLeaf(leaf, entry, cached), leaf);
  }
});
test('origin changes, delegated sessions and incomplete evidence are never migrated', () => {
  for (const mutate of [
    f => { f.cached.messages = [{...messages[0], origin:'delegation'}, messages[1]]; f.entry.memoryHash = fingerprint(f.cached.messages); },
    f => { f.entry.delegationId = 'worker'; },
    f => { f.cached.key = 'pi:other'; },
    f => { f.cached.messages = null; },
    f => { f.entry.memoryHash = 'different'; },
    f => { f.leaf.partial = true; },
    f => { f.leaf.v = 1; },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(upgradeLeaf(f.leaf, f.entry, f.cached), f.leaf);
  }
});
test('repair command is dry-run by default, backs up, and is idempotent', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-repair-')));
  try {
    const cache = path.join(home, 'cache');
    const source = path.join(home, '.pi/agent/sessions/test.jsonl');
    fs.mkdirSync(path.dirname(source), {recursive:true});
    fs.writeFileSync(source, 'unchanged transcript');
    const stat = fs.statSync(source), f = fixture();
    f.leaf.key = f.cached.key = 'pi:test.jsonl';
    Object.assign(f.entry, {mtimeMs:stat.mtimeMs, size:stat.size});
    Object.assign(f.cached, f.entry);
    for (const dir of ['sessions', 'memory-leaves']) fs.mkdirSync(path.join(cache, dir), {recursive:true});
    const name = 'pi__test.jsonl.json', leafPath = path.join(cache, 'memory-leaves', name);
    const original = JSON.stringify(f.leaf);
    fs.writeFileSync(leafPath, original);
    fs.utimesSync(leafPath, new Date(0), new Date(0));
    fs.writeFileSync(path.join(cache, 'sessions', name), JSON.stringify(f.cached));
    fs.writeFileSync(path.join(cache, 'index.json'), JSON.stringify({[f.leaf.key]:f.entry}));
    const run = (...args) => JSON.parse(execFileSync(process.execPath,
      [path.resolve(__dirname, '../scripts/repair-memory-fingerprints.js'), ...args],
      {env:{...process.env, ...require('./helpers/home-env.js').homeEnv(home), CHATTERING_CACHE_DIR:cache}, encoding:'utf8'}));
    assert.equal(run().eligible, 1);
    assert.equal(fs.readFileSync(leafPath, 'utf8'), original);
    const result = run('--apply');
    assert.equal(result.repaired, 1);
    assert.equal(fs.readFileSync(path.join(result.backup, name), 'utf8'), original);
    assert.equal(JSON.parse(fs.readFileSync(leafPath)).memoryHash, f.entry.memoryHash);
    assert.equal(run('--apply').repaired, 0);
    fs.writeFileSync(leafPath, original);
    fs.appendFileSync(source, 'new content');
    assert.equal(run('--apply').repaired, 0);
    assert.equal(fs.readFileSync(leafPath, 'utf8'), original);
  } finally { fs.rmSync(home, {recursive:true, force:true}); }
});

test('null origin is compatible; tool-only rows do not affect dialogue hashes', () => {
  const f = fixture();
  f.cached.messages = [...messages.map(m => ({...m, origin:null})), {role:'tool',text:'output'}];
  assert.equal(upgradeLeaf(f.leaf, f.entry, f.cached).memoryHash, f.entry.memoryHash);
});
