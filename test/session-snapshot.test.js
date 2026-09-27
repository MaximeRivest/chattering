'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { readSessionSnapshot, publishSession, forkPiSnapshot } = require('../session-snapshot');
const { loadSdk, piPackageDir } = require('../pisdk-runtime');

async function fixture(t, version = 3) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fork-snapshot-test-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.jsonl');
  const rows = [
    { type: 'session', version, id: 'source-session', timestamp: '2026-09-10T12:00:00Z', cwd: dir },
    { type: 'model_change', id: 'model', parentId: null, provider: 'test', modelId: 'model' },
    { type: 'custom', id: 'mode', parentId: 'model', customType: 'mode-snapshot', data: { mode: 'coding' } },
    { type: 'message', id: 'user', parentId: 'mode', message: { role: 'user', content: 'Original question', timestamp: 1 } },
    { type: 'message', id: 'answer', parentId: 'user', message: { role: 'assistant', content: [{ type: 'text', text: 'Saved answer' }], timestamp: 2 } },
    { type: 'label', id: 'label', parentId: 'answer', targetId: 'answer', label: 'checkpoint' },
    { type: 'message', id: 'next', parentId: 'label', message: { role: 'user', content: 'Keep working', timestamp: 3 } },
  ];
  const raw = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  await fs.writeFile(source, raw);
  return { dir, source, raw, rows };
}
async function native(t) {
  try { piPackageDir(); } catch { t.skip('Native Pi package is not installed'); return null; }
  return (await loadSdk()).SDK.SessionManager;
}

test('snapshot accepts complete records but excludes an unfinished append', async t => {
  const { source, raw } = await fixture(t);
  await fs.appendFile(source, '{"type":"message","id":"unfinished');
  assert.equal(await readSessionSnapshot(source), raw);
  await fs.writeFile(source, raw.trimEnd());
  assert.equal(await readSessionSnapshot(source), raw);
});

test('publication is complete, private, and cannot overwrite another session', async t => {
  const { dir } = await fixture(t), file = path.join(dir, 'fork.jsonl');
  await publishSession(file, 'complete\n');
  assert.equal(await fs.readFile(file, 'utf8'), 'complete\n');
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600); // Unix permission bits; Windows keeps it private by the folder's access list
  await assert.rejects(publishSession(file, 'replacement\n'), { code: 'EEXIST' });
  assert.equal(await fs.readFile(file, 'utf8'), 'complete\n');
  assert.deepEqual((await fs.readdir(dir)).filter(n => n.endsWith('.tmp')), []);
});

test('native forks are independent while the original manager keeps appending', async t => {
  const SM = await native(t); if (!SM) return;
  const { source, raw, dir } = await fixture(t);
  const original = SM.open(source);
  const [a, b] = await Promise.all([forkPiSnapshot(SM, { sessionPath: source }, 'answer'), forkPiSnapshot(SM, { sessionPath: source }, 'next')]);
  assert.notEqual(a.file, b.file); assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(await fs.readFile(source, 'utf8'), raw);
  assert.equal(original.getSessionFile(), source);
  original.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Parent is still working' }], timestamp: 4 });
  assert.match(await fs.readFile(source, 'utf8'), /Parent is still working/);
  for (const result of [a, b]) {
    assert.equal(path.dirname(result.file), dir);
    const fork = SM.open(result.file);
    assert.equal(fork.getHeader().parentSession, source);
    assert.equal(fork.getCwd(), dir);
    assert.equal(fork.getEntry('mode').data.mode, 'coding');
    assert.equal(fork.getLabel('answer'), 'checkpoint');
    assert.doesNotMatch(await fs.readFile(result.file, 'utf8'), /Parent is still working/);
  }
  assert.equal(SM.open(a.file).getEntry('next'), undefined);
  assert.equal(SM.open(b.file).getEntry('next').parentId, 'answer', 'Pi re-chains entries across labels');
  const fork = SM.open(a.file);
  fork.appendMessage({ role: 'user', content: 'Independent fork work', timestamp: 5 });
  assert.doesNotMatch(await fs.readFile(source, 'utf8'), /Independent fork work/);
});

test('migration touches the private snapshot, never the legacy source', async t => {
  const SM = await native(t); if (!SM) return;
  const { source, raw } = await fixture(t, 2);
  const result = await forkPiSnapshot(SM, { sessionPath: source }, 'answer');
  assert.equal(await fs.readFile(source, 'utf8'), raw);
  assert.equal(SM.open(result.file).getHeader().version, 3);
});

test('a user-only fork is published immediately; fork-before keeps the original prompt', async t => {
  const SM = await native(t); if (!SM) return;
  const { source } = await fixture(t);
  const userOnly = await forkPiSnapshot(SM, { sessionPath: source }, 'user');
  assert.equal(SM.open(userOnly.file).getEntry('user').message.content, 'Original question');
  assert.equal(SM.open(userOnly.file).getEntry('answer'), undefined);
  const before = await forkPiSnapshot(SM, { sessionPath: source }, 'next', { before: true });
  assert.equal(before.text, 'Keep working');
  assert.equal(SM.open(before.file).getEntry('next'), undefined);
});

test('missing or cyclic saved history fails without creating a fork', async t => {
  const SM = await native(t); if (!SM) return;
  const { source, dir, rows } = await fixture(t);
  await assert.rejects(forkPiSnapshot(SM, { sessionPath: source }, 'unfinished'), /not saved/);
  rows.find(r => r.id === 'answer').parentId = 'missing';
  await fs.writeFile(source, rows.map(JSON.stringify).join('\n') + '\n');
  await assert.rejects(forkPiSnapshot(SM, { sessionPath: source }, 'answer'), /ancestor is missing/);
  rows.find(r => r.id === 'answer').parentId = 'next';
  await fs.writeFile(source, rows.map(JSON.stringify).join('\n') + '\n');
  await assert.rejects(forkPiSnapshot(SM, { sessionPath: source }, 'answer'), /cycle/);
  assert.deepEqual(await fs.readdir(dir), ['source.jsonl']);
});
