'use strict';
// Rename, duplicate and delete in the Files browser (file-ops.js): never
// outside the root, never over an existing name, and delete is restorable.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ops = require('../file-ops.js');
const store = require('../open-files-store.js');

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'file-ops-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  await fs.mkdir(path.join(root, 'docs', 'deep'), { recursive: true });
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, 'report.md'), 'report');
  await fs.writeFile(path.join(root, 'other.md'), 'other');
  await fs.writeFile(path.join(root, 'docs', 'deep', 'a.txt'), 'a');
  await fs.writeFile(path.join(root, 'sketch.ink.svg'), '<svg/>');
  await fs.mkdir(path.join(base, 'outside'));
  await fs.writeFile(path.join(base, 'outside', 'secret'), 'secret');
  return { base, root, trash: path.join(base, 'trash') };
}
const read = p => fs.readFile(p, 'utf8');
const gone = async p => assert.equal(await fs.lstat(p).catch(e => e.code), 'ENOENT');

test('names: one entry in one folder, portable where it must be', () => {
  assert.equal(ops.checkName('  notes.md '), 'notes.md');
  for (const bad of ['', '   ', '.', '..', 'a/b', 'x\0y', '.git', 'é'.repeat(200)]) assert.throws(() => ops.checkName(bad), undefined, JSON.stringify(bad));
  assert.equal(ops.checkName('a\\b', { windows: false }), 'a\\b');
  for (const bad of ['a\\b', 'a:b', 'what?', 'end.', 'CON', 'nul.txt']) assert.throws(() => ops.checkName(bad, { windows: true }), undefined, bad);
});

test('rename stays in its folder and never replaces another file', async t => {
  const { root } = await fixture(t);
  const out = await ops.renameEntry(root, 'report.md', 'final.md');
  assert.equal(out.rel, 'final.md');
  assert.equal(await read(path.join(root, 'final.md')), 'report');
  await gone(path.join(root, 'report.md'));
  await assert.rejects(ops.renameEntry(root, 'final.md', 'other.md'), /already exists/);
  assert.equal(await read(path.join(root, 'other.md')), 'other', 'the existing file is untouched');
  const folder = await ops.renameEntry(root, 'docs/deep', 'shallow');
  assert.equal(folder.rel, 'docs/shallow');
  assert.equal(await read(path.join(root, 'docs', 'shallow', 'a.txt')), 'a');
  assert.equal((await ops.renameEntry(root, 'other.md', 'other.md')).changed, false);
});

test('a change of case alone is a rename, also where the disk ignores case', async t => {
  const { root } = await fixture(t);
  await ops.renameEntry(root, 'report.md', 'Report.md');
  assert.deepEqual((await fs.readdir(root)).filter(n => /^report\.md$/i.test(n)), ['Report.md']);
});

test('nothing outside the root, not the root itself, not .git', async t => {
  const { root, base } = await fixture(t);
  await fs.symlink(path.join(base, 'outside'), path.join(root, 'out-link'));
  await assert.rejects(ops.renameEntry(root, '../outside/secret', 'x'), /outside/);
  await assert.rejects(ops.renameEntry(root, 'out-link/secret', 'x'), /outside/, 'a linked folder leading out');
  await assert.rejects(ops.renameEntry(root, '.', 'x'), /outside|Choose/);
  await assert.rejects(ops.renameEntry(root, '', 'x'), /Choose/);
  await assert.rejects(ops.duplicateEntry(root, '.git'), /Git/);
  await assert.rejects(ops.renameEntry(root, 'missing.md', 'x'), /no longer exists/);
  assert.equal(await read(path.join(base, 'outside', 'secret')), 'secret');
});

test('a link is renamed or duplicated as a link, never its target', async t => {
  const { root, base } = await fixture(t);
  await fs.symlink(path.join(base, 'outside'), path.join(root, 'out-link'));
  const copy = await ops.duplicateEntry(root, 'out-link');
  assert.equal(await fs.readlink(copy.to), path.join(base, 'outside'));
  await ops.renameEntry(root, 'out-link', 'renamed-link');
  assert.ok((await fs.lstat(path.join(root, 'renamed-link'))).isSymbolicLink());
  assert.deepEqual(await fs.readdir(path.join(base, 'outside')), ['secret']);
});

test('duplicate names its copy beside the original, keeping the ending', async t => {
  const { root } = await fixture(t);
  assert.equal((await ops.duplicateEntry(root, 'report.md')).rel, 'report copy.md');
  assert.equal((await ops.duplicateEntry(root, 'report.md')).rel, 'report copy 2.md');
  assert.equal(await read(path.join(root, 'report copy 2.md')), 'report');
  assert.equal((await ops.duplicateEntry(root, 'sketch.ink.svg')).rel, 'sketch copy.ink.svg', 'still a handwritten note');
  const folder = await ops.duplicateEntry(root, 'docs');
  assert.equal(folder.rel, 'docs copy');
  assert.equal(await read(path.join(root, 'docs copy', 'deep', 'a.txt')), 'a');
  assert.equal(ops.copyName('.env', false), '.env copy');
  assert.equal(ops.copyName('v1.2', true), 'v1.2 copy');
  assert.equal(ops.copyName('a.tar.gz', false, 3), 'a copy 3.tar.gz');
});

test('duplicating a folder too large to copy by a click is refused, and leaves nothing', async t => {
  const { root } = await fixture(t);
  await assert.rejects(ops.duplicateEntry(root, 'docs', { maxEntries: 1 }), /more than/);
  await assert.rejects(ops.duplicateEntry(root, 'docs', { maxBytes: 0 }), /MB/);
  await gone(path.join(root, 'docs copy'));
});

test('delete moves to Recently deleted; restore puts it back, beside anything now there', async t => {
  const { root, trash } = await fixture(t);
  const bin = ops.createTrash(trash);
  const r = await bin.put(path.join(root, 'docs'), { project: 'p', root, openFiles: [{ path: path.join(root, 'docs', 'deep', 'a.txt'), project: 'p', at: 5 }] });
  await gone(path.join(root, 'docs'));
  assert.equal(r.directory, true);
  const listed = await bin.list(x => x.project === 'p');
  assert.deepEqual(listed.map(x => x.id), [r.id]);
  assert.equal((await bin.list(x => x.project === 'q')).length, 0);
  const back = await bin.restore(r.id, async rec => rec.from);
  assert.equal(back.to, path.join(root, 'docs'));
  assert.equal(back.renamed, false);
  assert.equal(await read(path.join(root, 'docs', 'deep', 'a.txt')), 'a');
  assert.equal((await bin.list()).length, 0);
  await assert.rejects(bin.restore(r.id, async rec => rec.from), /no longer kept/);

  const f = await bin.put(path.join(root, 'report.md'), { project: 'p' });
  await fs.writeFile(path.join(root, 'report.md'), 'new one');
  const again = await bin.restore(f.id, async rec => rec.from);
  assert.equal(again.to, path.join(root, 'report (restored).md'));
  assert.equal(again.renamed, true);
  assert.equal(await read(path.join(root, 'report.md')), 'new one', 'never overwritten');
  assert.equal(await read(again.to), 'report');
});

test('Recently deleted keeps items for its retention, then removes them for good', async t => {
  const { root, trash } = await fixture(t);
  let clock = 1_000_000;
  const bin = ops.createTrash(trash, { retainMs: 1000, now: () => clock });
  await bin.put(path.join(root, 'report.md'), { project: 'p' });
  clock += 500;
  assert.equal((await bin.purge()), 0);
  clock += 1000;
  assert.equal(await bin.purge(), 1);
  assert.deepEqual(await fs.readdir(trash), []);
});

test('kept open files follow a rename and leave with a delete', () => {
  const state = store.createState();
  store.keep(state, { path: '/r/docs/a.md', project: 'p' }, 10);
  store.keep(state, { path: '/r/docs-other/b.md', project: 'p' }, 20);
  store.keep(state, { path: '/r/docs', project: 'p' }, 30);
  assert.equal(store.move(state, '/r/docs', '/r/notes', '/', 40), true);
  assert.deepEqual(state.files.map(f => f.path).sort(), ['/r/docs-other/b.md', '/r/notes', '/r/notes/a.md']);
  assert.equal(store.move(state, '/r/none', '/r/x', '/', 50), false);
  const gone = store.closeUnder(state, '/r/notes', '/', 60);
  assert.deepEqual(gone.map(f => f.path).sort(), ['/r/notes', '/r/notes/a.md']);
  assert.deepEqual(state.files.map(f => f.path), ['/r/docs-other/b.md']);
  assert.ok(state.rev >= 60);
});
