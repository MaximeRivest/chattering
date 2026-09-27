'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CheckpointStore, git } = require('../checkpoint-store');
const { ChangeReviews } = require('../change-reviews');
const { checkpointExtension } = require('../checkpoint-extension');
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoints-')));
  const root = path.join(dir, 'work'); await fs.mkdir(root);
  await git(['init'], { cwd: root });
  await fs.writeFile(path.join(root, 'a & b.txt'), 'one\ntwo\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'secret\n');
  await fs.writeFile(path.join(root, 'secret'), 'must not capture');
  await git(['add', '.'], { cwd: root });
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'initial'], { cwd: root });
  const store = new CheckpointStore(path.join(dir, 'private'));
  t.after(async () => { store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const meta = { session: '/session.jsonl', run: 'run', call: 'call', tool: 'edit' };
  return { store, root, meta, reviews: new ChangeReviews(store) };
}
test('private checkpoints preserve staged changes, HEAD, raw bytes, modes and ignored files', async t => {
  const { store, root, meta } = await fixture(t);
  await fs.writeFile(path.join(root, 'a & b.txt'), 'staged'); await git(['add', '.'], { cwd: root });
  const head = (await git(['rev-parse', 'HEAD'], { cwd: root })).toString();
  const staged = await fs.readFile(path.join(root, '.git/index'));
  const a = await store.capture(root, { ...meta, phase: 'before' }); assert.equal(a.error, '');
  await fs.writeFile(path.join(root, 'a & b.txt'), 'after\n');
  // Windows allows no line break in a name and keeps no executable bit.
  const unix = process.platform !== 'win32', odd = unix ? 'new\nname.txt' : 'new name, #1.txt';
  await fs.writeFile(path.join(root, odd), 'new');
  await fs.chmod(path.join(root, 'a & b.txt'), 0o755);
  const b = await store.capture(root, { ...meta, phase: 'after' }); assert.equal(b.error, '');
  assert.equal((await store.content(a.snapshot, 'a & b.txt')).text, 'staged');
  assert.equal((await store.content(b.snapshot, 'a & b.txt')).text, 'after\n');
  assert.equal((await store.content(b.snapshot, odd)).text, 'new');
  if (unix) assert.equal(store.snapshot(b.snapshot).manifest.find(f => f.path === 'a & b.txt').mode, '100755');
  assert.ok(!store.snapshot(b.snapshot).manifest.some(f => f.path === 'secret'));
  assert.equal(store.diff(a.snapshot, b.snapshot).length, 2);
  assert.deepEqual(await fs.readFile(path.join(root, '.git/index')), staged);
  assert.equal((await git(['rev-parse', 'HEAD'], { cwd: root })).toString(), head);
  const c = await store.capture(root, meta); assert.equal(c.snapshot, b.snapshot, 'identical snapshot should reuse storage');
});
test('deletion and unsupported files are distinct; symlinks never copy targets', async t => {
  const { store, root, meta } = await fixture(t);
  const a = await store.capture(root, { ...meta, phase: 'before' });
  await fs.unlink(path.join(root, 'a & b.txt'));
  await fs.symlink('/etc/passwd', path.join(root, 'link'));
  await fs.writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
  const b = await store.capture(root, { ...meta, phase: 'after' });
  assert.equal(b.error, '');
  assert.equal((await store.content(b.snapshot, 'a & b.txt')).absent, true);
  assert.match((await store.content(b.snapshot, 'link')).unavailable, /Symlink/);
  assert.match((await store.content(b.snapshot, 'binary')).unavailable, /Binary/);
  assert.equal(store.diff(a.snapshot, b.snapshot).length, 3);
});
test('reviews are pinned; comments bind to recorded code; live edits and delivery retries are explicit', async t => {
  const { store, root, meta, reviews } = await fixture(t);
  await store.capture(root, { ...meta, phase: 'before' });
  await fs.writeFile(path.join(root, 'a & b.txt'), 'one\nchanged\n');
  await store.capture(root, { ...meta, phase: 'after' });
  const r = reviews.create({ key: 'key', session: meta.session, project: 'p', calls: ['call'] });
  assert.equal(r.coverage, true); assert.equal(r.files.length, 1);
  const comment = await reviews.comment(r.id, { path: 'a & b.txt', side: 'next', line: 2, text: 'Use a clearer name', suggestion: 'better' });
  assert.equal(comment.quote, 'changed');
  await assert.rejects(reviews.comment(r.id, { path: 'a & b.txt', line: 100, text: 'bad anchor' }), /valid range/);
  await fs.writeFile(path.join(root, 'a & b.txt'), 'human edit\n');
  const file = await reviews.file(r.id, 'a & b.txt');
  assert.equal(file.next.text, 'one\nchanged\n'); assert.equal(file.changedSince, true);
  reviews.mark(r.id, 'a & b.txt', true); assert.deepEqual(reviews.get(r.id).reviewed, ['a & b.txt']);
  const preview = await reviews.prepare(r.id, 'target', 'Please address this review');
  assert.match(preview.message, /changed on disk/); assert.match(preview.message, /human edit/); assert.match(preview.message, /better/);
  assert.equal(reviews.claim(preview.token).message, preview.message);
  assert.throws(() => reviews.claim(preview.token), /already submitted/);
  reviews.finish(preview.token, 'sent', { key: 'target' });
  assert.equal(reviews.get(r.id).deliveries[0].status, 'sent');
  assert.equal(reviews.create({ key: 'key', session: meta.session, project: 'p', calls: ['call'] }).id, r.id);
  await assert.rejects(reviews.file(r.id, '../secret'), /not in this/);
});
test('missing tool boundaries never fabricate a complete review', async t => {
  const { reviews, meta } = await fixture(t);
  const r = reviews.create({ key: 'key', session: meta.session, project: 'p', calls: ['old'], knownPaths: ['/old/file'] });
  assert.equal(r.coverage, false); assert.equal(r.base, null);
  await reviews.comment(r.id, { path: '/old/file', text: 'Please inspect this file' });
  await assert.rejects(reviews.file(r.id, '/old/file'), /no complete/);
});
test('follow-up reviews retain their original and can form a combined comparison', async t => {
  const { store, root, meta, reviews } = await fixture(t);
  await store.capture(root, { ...meta, phase: 'before' });
  await fs.writeFile(path.join(root, 'a & b.txt'), 'first edit');
  await store.capture(root, { ...meta, phase: 'after' });
  const original = reviews.create({ key: 'key', session: meta.session, project: 'p', calls: ['call'] });
  const second = { ...meta, run: 'second', call: 'followup', review: original.id };
  await store.capture(root, { ...second, phase: 'before' });
  await fs.writeFile(path.join(root, 'a & b.txt'), 'review addressed');
  await store.capture(root, { ...second, phase: 'after' });
  const followup = reviews.create({ key: 'key', session: meta.session, project: 'p', calls: ['followup'] });
  assert.equal(followup.parentReview, original.id);
  const combined = reviews.combine(original.id, followup.id);
  const file = await reviews.file(combined.id, 'a & b.txt');
  assert.equal(file.old.text, 'one\ntwo\n'); assert.equal(file.next.text, 'review addressed');
  assert.equal(reviews.get(original.id).followups[0].id, followup.id);
});
test('awaited hooks skip only known built-in readers, capture failures and overlaps without blocking tools', async () => {
  const handlers = new Map(), captures = [], notices = [];
  let release;
  const store = { capture: async (_cwd, meta) => { captures.push(meta); if (meta.call === 'one' && meta.phase === 'before') await new Promise(r => release = r); return { snapshot: 's' }; } };
  checkpointExtension({ on: (name, fn) => handlers.set(name, fn), getAllTools: () => [{ name: 'read', sourceInfo: { source: 'builtin' } }, { name: 'grep', sourceInfo: { source: 'extension' } }] }, { store, allowLoose: true });
  const ctx = { cwd: '/tmp', sessionManager: { getSessionFile: () => '/session' }, ui: { notify: s => notices.push(s) } };
  await handlers.get('before_agent_start')({ prompt: 'work' }, ctx);
  await handlers.get('tool_call')({ toolName: 'read', toolCallId: 'read' }, ctx);
  let ready = false;
  const before = handlers.get('tool_call')({ toolName: 'edit', toolCallId: 'one' }, ctx).then(() => ready = true);
  await new Promise(r => setImmediate(r)); assert.equal(ready, false); release(); await before;
  await handlers.get('tool_call')({ toolName: 'grep', toolCallId: 'two' }, ctx);
  await handlers.get('tool_result')({ toolName: 'edit', toolCallId: 'one', isError: true }, ctx);
  assert.ok(captures.find(c => c.call === 'one' && c.phase === 'after-error').overlapping);
  assert.ok(captures.some(c => c.call === 'two')); assert.ok(!captures.some(c => c.call === 'read'));
  store.capture = async () => { throw Error('disk full'); };
  assert.equal(await handlers.get('tool_call')({ toolName: 'bash', toolCallId: 'fail' }, ctx), undefined);
  assert.match(notices[0], /disk full/);
});

test('separate checkpoint writers can initialize and publish the same workspace concurrently', async t => {
  const { store, root, meta } = await fixture(t);
  // Closed here, before the fixture removes the folder: Windows cannot delete an open database.
  const other = new CheckpointStore(store.dir);
  try {
    const pair = await Promise.all([store.capture(root, { ...meta, phase: 'before' }), other.capture(root, { ...meta, run: 'other', call: 'other', phase: 'before' })]);
    assert.deepEqual(pair.map(p => p.error), ['', '']);
    assert.equal(pair[0].snapshot, pair[1].snapshot);
    assert.equal((await store.content(pair[0].snapshot, 'a & b.txt')).text, 'one\ntwo\n');
    await fs.writeFile(path.join(root, 'a & b.txt'), 'concurrent result');
    const done = await other.capture(root, { ...meta, run: 'other', call: 'other', phase: 'after' });
    assert.equal(done.error, '');
    assert.ok(other.boundaries(meta.session, ['other']).some(b => b.overlapping));
  } finally { other.close(); }
});

test('non-Git workspaces respect .gitignore without creating a working .git directory', async t => {
  const { store, root, meta } = await fixture(t);
  await fs.rm(path.join(root, '.git'), { recursive: true, force: true });
  const captured = await store.capture(root, meta);
  assert.equal(captured.error, '');
  assert.ok(!store.snapshot(captured.snapshot).manifest.some(f => f.path === 'secret'));
  await assert.rejects(fs.stat(path.join(root, '.git')), { code: 'ENOENT' });
});

test('delivery sends the preview exactly once and preserves uncertainty rather than retrying', async t => {
  const { reviews, meta } = await fixture(t);
  const r = reviews.create({ key: 'key', session: meta.session, project: 'p', calls: ['old'] });
  const preview = await reviews.prepare(r.id, 'target', 'Please check this');
  let sends = 0, release;
  const sending = reviews.deliver(preview.token, async packet => { sends++; assert.equal(packet.message, preview.message); await new Promise(r => release = r); return { key: packet.target }; });
  await assert.rejects(reviews.deliver(preview.token, async () => { sends++; }), /already submitted/);
  release(); await sending; assert.equal(sends, 1);
  const next = await reviews.prepare(r.id, 'target', 'Another review');
  await assert.rejects(reviews.deliver(next.token, async () => { throw Error('connection lost'); }), /could not be confirmed/);
  assert.equal(reviews.get(r.id).deliveries.find(d => d.id === next.token).status, 'uncertain');
  await assert.rejects(reviews.deliver(next.token, async () => { sends++; }), /already submitted/);
  assert.equal(sends, 1);
});

test('artifact folders are versioned with their binary assets, even when ignored or in a loose folder', async t => {
  const { store, root, meta } = await fixture(t);
  const site = path.join(root, 'site'); await fs.mkdir(site);
  await fs.appendFile(path.join(root, '.gitignore'), 'site/\n');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255]);
  await fs.writeFile(path.join(site, 'index.html'), '<h1>one</h1>');
  await fs.writeFile(path.join(site, 'frog.png'), png);
  const before = await store.capture(root, { ...meta, phase: 'after' });
  assert.equal(store.snapshot(before.snapshot).manifest.some(f => f.path.startsWith('site/')), false, 'ignored folders stay out until declared');
  const { scope } = await store.addArtifactScope(root, site);
  assert.equal(scope, await fs.realpath(site));
  const a = await store.capture(root, { ...meta, call: 'c1', phase: 'after' });
  const files = store.snapshot(a.snapshot).manifest.filter(f => f.path.startsWith('site/'));
  assert.deepEqual(files.map(f => f.path), ['site/frog.png', 'site/index.html']);
  assert.ok(files.every(f => f.oid), JSON.stringify(files));
  assert.deepEqual(await store.blob(a.root, files[0].oid), png);
  assert.deepEqual(store.boundariesByCalls(['c1']).map(b => b.snapshot), [a.snapshot]);
  // A loose (target-only) capture still scans the declared folders, and only them.
  await fs.writeFile(path.join(site, 'index.html'), '<h1>two</h1>');
  const b = await store.capture(root, { ...meta, call: 'c2', phase: 'after', targetOnly: true });
  assert.deepEqual(store.snapshot(b.snapshot).manifest.map(f => f.path), ['site/frog.png', 'site/index.html']);
  await assert.rejects(store.addArtifactScope(root, os.tmpdir()), /outside/);
});
