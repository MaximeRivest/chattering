'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileArchive, MAX_FILE_BYTES } = require('../file-archive');
function fixture(t, options) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'file-archive-')));
  const filename = path.join(dir, 'history', 'versions.sqlite');
  const archive = new FileArchive(filename, options);
  t.after(() => { try { archive.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  return { archive, filename, file: path.join(dir, 'example.md') };
}
test('saved versions persist, deduplicate blobs, and do not depend on the activity cache', t => {
  const { archive, filename, file } = fixture(t);
  const a = archive.observe(file, { text: 'first', ts: 10 });
  assert.equal(archive.observe(file, { text: 'first', ts: 20 }).id, a.id);
  const b = archive.observe(file, { text: 'second', ts: 30, actor: 'human', source: 'editor save' });
  archive.observe(file + '.copy', { text: 'first' });
  assert.equal(archive.db.prepare('SELECT COUNT(*) AS n FROM archive_blobs').get().n, 2);
  archive.link('event', file, a.id, b.id);
  archive.close();
  const reopened = new FileArchive(filename);
  try {
    assert.equal(reopened.snapshot(file, a.id).content, 'first');
    assert.equal(reopened.snapshot(file, b.id).content, 'second');
    assert.deepEqual(reopened.reference('event', file), { fromVersion: 'saved:' + a.id, toVersion: 'saved:' + b.id });
    assert.deepEqual(reopened.reference('event', file + '.copy'), {});
    assert.throws(() => reopened.snapshot(file + '.copy', a.id), /not found/);
    if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600); // Unix permission bits; Windows keeps it private by the folder's access list
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.dirname(filename)).mode & 0o777, 0o700); // Unix permission bits; Windows keeps it private by the folder's access list
  } finally { reopened.close(); }
});
test('deletion, recreation and uncaptured contents are distinct states', t => {
  const { archive, file } = fixture(t);
  archive.observe(file, { text: 'old' });
  const gone = archive.observe(file, { state: 'deleted' });
  const recreated = archive.observe(file, { text: '' });
  const binary = archive.observe(file, { text: '\0binary' });
  assert.equal(archive.snapshot(file, gone.id).state, 'deleted');
  assert.equal(archive.snapshot(file, recreated.id).state, 'present');
  assert.equal(archive.snapshot(file, recreated.id).content, '');
  assert.equal(binary.state, 'unavailable');
  assert.throws(() => archive.snapshot(file, binary.id), /Binary/);
  assert.equal(archive.observe(file, { text: 'x'.repeat(MAX_FILE_BYTES + 1) }).state, 'unavailable');
});
test('storage exhaustion reports a gap without deleting existing versions', t => {
  const { archive, file } = fixture(t);
  const a = archive.observe(file, { text: 'keep me' });
  archive.budget = 1;
  assert.throws(() => archive.observe(file, { text: 'new' }), /limit reached/);
  assert.equal(archive.snapshot(file, a.id).content, 'keep me');
  assert.equal(archive.versions(file).length, 1);
  assert.match(archive.error, /not captured/);
});
test('timestamps never regress and equal times retain observation order', t => {
  const { archive, file } = fixture(t);
  archive.observe(file, { text: 'a', ts: 20 });
  archive.observe(file, { text: 'b', ts: 10 });
  const rows = archive.versions(file);
  assert.deepEqual(rows.map(r => r.ts), [20, 20]);
  assert.ok(rows[1].id > rows[0].id);
});
