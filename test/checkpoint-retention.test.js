'use strict';
// Saved file history within its disk budget (design/81): compact storage,
// oldest-first removal, what is never removed, and safety with captures
// running in other processes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { CheckpointStore, git, unpackList } = require('../checkpoint-store');
const { ChangeReviews } = require('../change-reviews');
const { packIndex } = require('../checkpoint-maintenance');
const { FileArchive } = require('../file-archive');
const DAY = 86400000;
const { fixtureCleanup } = require('./helpers/fixture-cleanup');

async function fixture(t, { mb } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'retention-')));
  const root = path.join(dir, 'work'); await fs.mkdir(root);
  await git(['init'], { cwd: root });
  await fs.writeFile(path.join(root, 'notes.md'), 'first\n');
  await fs.writeFile(path.join(root, 'picture.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
  const previous = process.env.CHATTERING_CHECKPOINT_MB;
  if (mb) process.env.CHATTERING_CHECKPOINT_MB = String(mb);
  const store = new CheckpointStore(path.join(dir, 'private'), { autoMaintain: false });
  const cleanup = fixtureCleanup(t, async () => {
    if (mb) { if (previous === undefined) delete process.env.CHATTERING_CHECKPOINT_MB; else process.env.CHATTERING_CHECKPOINT_MB = previous; }
    await fs.rm(dir, { recursive: true, force: true });
  });
  cleanup.add(() => store.close());
  let n = 0;
  const capture = async (extra = {}) => {
    const call = 'call-' + (++n);
    const r = await store.capture(root, { session: '/s.jsonl', run: 'run', call, tool: 'edit', phase: 'after', ...extra });
    assert.equal(r.error, '');
    return { ...r, call };
  };
  return { dir, root, store, capture, cleanup, reviews: new ChangeReviews(store) };
}
const loose = async repo => (await fs.readdir(path.join(repo, 'objects'))).filter(e => /^[0-9a-f]{2}$/.test(e)).length;
const age = (store, boundary, when) => store.db.prepare('UPDATE checkpoint_boundaries SET started=?, finished=? WHERE id=?').run(when, when, boundary);
// Text that does not compress: one megabyte of saved history per version.
const noise = kb => crypto.randomBytes(kb * 512).toString('hex');

test('a snapshot stores only the files it could not save; the rest is read back from its Git tree', async t => {
  const { store, root, capture } = await fixture(t);
  await fs.mkdir(path.join(root, 'a/b'), { recursive: true });
  await fs.writeFile(path.join(root, 'a/b/deep.txt'), 'deep');
  await fs.writeFile(path.join(root, 'a.b'), 'dot sorts between a and a/');
  const { snapshot } = await capture();
  const row = store.db.prepare('SELECT format, manifest FROM checkpoint_snapshots WHERE id=?').get(snapshot);
  assert.equal(row.format, 2);
  assert.deepEqual(unpackList(row.manifest), [{ path: 'picture.png', unavailable: 'Binary artifact; use its current-file preview' }]);
  const { manifest } = await store.snapshot(snapshot);
  assert.deepEqual(manifest.map(f => f.path), ['a.b', 'a/b/deep.txt', 'notes.md', 'picture.png'], 'one list, in the order the scan made it');
  assert.equal(manifest.find(f => f.path === 'notes.md').mode, '100644');
  assert.equal((await store.content(snapshot, 'a/b/deep.txt')).text, 'deep');
  assert.match((await store.content(snapshot, 'picture.png')).unavailable, /Binary/);
});

test('older full file lists are replaced only after they match their tree exactly', async t => {
  const { store, capture, root } = await fixture(t);
  const a = await capture();
  await fs.writeFile(path.join(root, 'notes.md'), 'second\n');
  const b = await capture();
  // Rewrite both as the previous version stored them; spoil the second.
  for (const [id, spoil] of [[a.snapshot, false], [b.snapshot, true]]) {
    const full = (await store.loadSnapshot(id)).manifest;
    if (spoil) full[0] = { ...full[0], oid: '0'.repeat(40) };
    store.db.prepare('UPDATE checkpoint_snapshots SET format=1, manifest=? WHERE id=?').run(JSON.stringify(full), id);
  }
  store.db.prepare("DELETE FROM checkpoint_meta WHERE key='manifest-migration'").run();
  const expected = (await store.loadSnapshot(a.snapshot)).manifest;
  const report = await store.maintain();
  assert.equal(report.migrated, 1); assert.equal(report.unverified, 1);
  assert.equal(store.db.prepare('SELECT format FROM checkpoint_snapshots WHERE id=?').get(a.snapshot).format, 2);
  assert.equal(store.db.prepare('SELECT format FROM checkpoint_snapshots WHERE id=?').get(b.snapshot).format, 1, 'a list that disagrees with its tree is kept as it is');
  assert.deepEqual((await store.loadSnapshot(a.snapshot)).manifest, expected);
});

test('compaction packs what is referenced, drops what nothing refers to, and ends the old ref chains', async t => {
  const { store, root, capture } = await fixture(t);
  const versions = [];
  for (let i = 0; i < 6; i++) {
    await fs.writeFile(path.join(root, 'notes.md'), 'line\n'.repeat(2000) + 'version ' + i + '\n');
    versions.push(await capture({ targets: [{ host: 'local', path: path.join(root, 'notes.md'), id: 'notes' }] }));
  }
  const repo = store.repo(await store.root(root));
  // What a previous version left: a commit chain and refs pinning a blob no
  // snapshot uses, plus a stray object and an abandoned temporary index.
  const stray = (await git(['--git-dir=' + repo, 'hash-object', '-w', '--stdin'], { input: 'only an old ref points here' })).toString().trim();
  const tree = (await git(['--git-dir=' + repo, 'mktree'], { input: `100644 blob ${stray}\told.txt\n` })).toString().trim();
  const old = (await git(['--git-dir=' + repo, 'commit-tree', tree], { input: 'old\n', env: { GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@x', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' } })).toString().trim();
  await git(['--git-dir=' + repo, 'update-ref', 'refs/heads/checkpoints', old]);
  await git(['--git-dir=' + repo, 'update-ref', 'refs/target-blobs/' + stray, stray]);
  await fs.writeFile(path.join(path.dirname(repo), 'index-abandoned'), 'x');
  const orphan = await store.storeBlob(await store.root(root), Buffer.from('saved but never used'));
  const generation = store.db.prepare('SELECT generation FROM checkpoint_roots').get().generation;
  const cacheBefore = store.rootCache(await store.root(root));
  assert.ok(await loose(repo) > 0);

  const report = await store.maintain({ force: true });
  assert.deepEqual(report.errors, []);
  assert.equal(await loose(repo), 0, 'no loose objects remain');
  const packs = (await fs.readdir(path.join(repo, 'objects', 'pack'))).filter(f => f.endsWith('.pack'));
  assert.equal(packs.length, 1);
  for (const v of versions) assert.match((await store.content(v.snapshot, 'notes.md')).text, /version/);
  const target = store.db.prepare('SELECT id FROM checkpoint_target_versions ORDER BY id DESC LIMIT 1').get();
  assert.match((await store.targetContent(path.join(root, 'notes.md'), target.id)).text, /version 5/);
  await assert.rejects(store.blob(await store.root(root), stray));
  await assert.rejects(store.blob(await store.root(root), orphan));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM checkpoint_objects WHERE oid=?').get(orphan).n, 0, 'the row goes with its object');
  assert.ok(!fsSync.existsSync(path.join(repo, 'refs', 'target-blobs')));
  assert.ok(!fsSync.existsSync(path.join(path.dirname(repo), 'index-abandoned')));
  const r = store.db.prepare('SELECT * FROM checkpoint_roots').get();
  assert.equal(r.generation, generation + 1);
  assert.equal(r.pending_objects, 0);
  assert.ok(r.disk_bytes > 0 && r.disk_bytes < 200000, 'six near-identical versions pack into little space: ' + r.disk_bytes);
  assert.notEqual(store.rootCache(await store.root(root)), cacheBefore, 'remembered object ids are forgotten after objects were removed');
  // Saving continues normally on top of the packed store.
  await fs.writeFile(path.join(root, 'notes.md'), 'after compaction\n');
  const next = await capture();
  assert.equal((await store.content(next.snapshot, 'notes.md')).text, 'after compaction\n');
  assert.deepEqual(packIndex(path.join(repo, 'objects', 'pack', packs[0].replace('.pack', '.idx'))).sort(),
    (await git(['--git-dir=' + repo, 'show-index'], { input: await fs.readFile(path.join(repo, 'objects', 'pack', packs[0].replace('.pack', '.idx'))) })).toString().trim().split('\n').map(l => l.split(' ')[1]).sort());
});

test('above its budget, the oldest history goes first; the last day, the newest snapshot and reviewed work stay', async t => {
  const { store, root, capture, reviews } = await fixture(t, { mb: 64 });
  const now = Date.now(), steps = [];
  for (let i = 0; i < 8; i++) {
    await fs.writeFile(path.join(root, 'notes.md'), noise(512));
    steps.push(await capture());
    age(store, steps[i].id, now - (20 - i) * DAY);
  }
  // A review a person commented on, over the oldest pair of steps.
  store.db.prepare("UPDATE checkpoint_boundaries SET phase='before', call='reviewed' WHERE id=?").run(steps[0].id);
  store.db.prepare("UPDATE checkpoint_boundaries SET call='reviewed' WHERE id=?").run(steps[1].id);
  const reviewed = await reviews.create({ key: 'k', session: '/s.jsonl', project: 'p', calls: ['reviewed'] });
  assert.equal(reviewed.coverage, true);
  await reviews.comment(reviewed.id, { path: 'notes.md', text: 'keep this' });
  await fs.writeFile(path.join(root, 'notes.md'), 'today\n');
  const today = await capture();

  // The budget shrinks below what is kept (as when someone lowers it).
  process.env.CHATTERING_CHECKPOINT_MB = String(Math.ceil(store.usage().total / 1024 / 1024 / 0.9 * 10) / 10);
  const before = store.usage();
  assert.ok(before.total > before.high, 'the fixture starts over budget');
  const report = await store.maintain({ now });
  const after = store.usage();
  assert.ok(after.total <= after.low, `back under 60%: ${after.total} of ${after.limit}`);
  assert.ok(report.removed.snapshots > 0);
  assert.equal(report.protectedOverBudget, undefined);
  const exists = id => !!store.db.prepare('SELECT 1 FROM checkpoint_snapshots WHERE id=?').get(id);
  assert.ok(exists(steps[0].snapshot) && exists(steps[1].snapshot), 'the commented review keeps its versions');
  assert.ok(exists(today.snapshot), 'the last day stays');
  const gone = steps.slice(2).filter(s => !exists(s.snapshot));
  assert.ok(gone.length > 0);
  assert.deepEqual(gone, steps.slice(2, 2 + gone.length), 'removal goes strictly oldest first');
  await assert.rejects(store.content(gone[0].snapshot, 'notes.md'), /Removed to free space \(saved history from before \d{4}-\d\d-\d\d/);
  const boundary = store.db.prepare('SELECT snapshot, error FROM checkpoint_boundaries WHERE id=?').get(gone[0].id);
  assert.equal(boundary.snapshot, null); assert.match(boundary.error, /Removed to free space/);
  assert.equal((await reviews.file(reviewed.id, 'notes.md')).next.text.length, 512 * 1024);
});

test('when everything left is protected, it says so instead of removing recent work', async t => {
  const { store, root, capture } = await fixture(t, { mb: 1 });
  for (let i = 0; i < 3; i++) { await fs.writeFile(path.join(root, 'notes.md'), noise(400)); await capture(); }
  const report = await store.maintain();
  assert.equal(report.protectedOverBudget, true);
  assert.equal(report.removed.snapshots, 0);
  await fs.writeFile(path.join(root, 'notes.md'), noise(400));
  const refused = await store.capture(root, { session: '/s.jsonl', run: 'r', call: 'refused', tool: 'edit', phase: 'after' });
  assert.match(refused.error, /Saved file history is full .* protected .* CHATTERING_CHECKPOINT_MB/);
});

test('an exclusive lease waits for a running capture and holds new captures off', async t => {
  const { store, root, capture, cleanup } = await fixture(t);
  const other = new CheckpointStore(store.dir, { autoMaintain: false });
  cleanup.add(() => other.close());
  const key = await store.root(root);
  const running = await other.lease(key, 'capture');
  let granted = false;
  const exclusive = store.lease(key, 'exclusive').then(h => { granted = true; return h; });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(granted, false, 'maintenance waits for the capture in the other process');
  running.release();
  const held = await exclusive;
  assert.ok(held && held.held());
  let captured = false;
  const pending = capture().then(r => { captured = true; return r; });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(captured, false, 'a new capture waits while the folder is being tidied');
  held.release();
  assert.ok((await pending).snapshot);
  assert.equal(await store.lease('*', 'maintain').then(h => { const again = other.lease('*', 'maintain'); return again.then(x => { h.release(); return x; }); }), null, 'one maintainer at a time');
});

test('per-file history keeps each file\u2019s newest version, the last day and pinned versions; removed ones say why', async t => {
  const dir = fsSync.realpathSync.native(fsSync.mkdtempSync(path.join(os.tmpdir(), 'archive-retention-')));
  const archive = new FileArchive(path.join(dir, 'versions.sqlite'));
  t.after(() => { archive.close(); fsSync.rmSync(dir, { recursive: true, force: true }); });
  const now = Date.now(), file = path.join(dir, 'a.md'), other = path.join(dir, 'b.md');
  const versions = [];
  for (let i = 0; i < 12; i++) versions.push(archive.observe(file, { text: noise(64) + i, ts: now - (30 - i) * DAY }));
  const lone = archive.observe(other, { text: 'only version', ts: now - 40 * DAY });
  const recent = archive.observe(file, { text: 'today', ts: now - 3600000 });
  archive.budget = Math.ceil(archive.used() / 0.9);
  const report = await archive.retain({ now, protect: new Set([versions[0].id]) });
  assert.ok(report.removed > 0);
  assert.ok(archive.used() <= archive.budget * 0.6);
  assert.equal(archive.snapshot(file, versions[0].id).content.slice(-1), '0', 'pinned by a review');
  assert.equal(archive.snapshot(other, lone.id).content, 'only version', 'a file\u2019s newest version stays, however old');
  assert.equal(archive.snapshot(file, recent.id).content, 'today');
  assert.throws(() => archive.snapshot(file, versions[1].id), /Removed to free space/);
  assert.equal(archive.observe(file, { text: 'saving works again' }).state, 'present');
});

test('only the server upgrades a store that already holds history', async t => {
  const { store, capture, cleanup } = await fixture(t);
  await capture();
  // As a store written by the previous version: no new columns yet.
  store.db.exec(`ALTER TABLE checkpoint_snapshots DROP COLUMN format; ALTER TABLE checkpoint_objects DROP COLUMN added; DELETE FROM checkpoint_meta;`);
  assert.throws(() => new CheckpointStore(store.dir), /being upgraded; it resumes once Chattering has restarted/);
  const owner = new CheckpointStore(store.dir, { owner: true, autoMaintain: false });
  cleanup.add(() => owner.close());
  assert.ok(owner.db.prepare('PRAGMA table_info(checkpoint_snapshots)').all().some(c => c.name === 'format'));
  const worker = new CheckpointStore(store.dir, { autoMaintain: false });
  worker.close();
});
