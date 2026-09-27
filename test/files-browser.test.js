'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { browse, safePath, activityQuery } = require('../files-browser-server');
const { FileLedger } = require('../fileledger');

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'files-browser-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'docs'));
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.writeFile(path.join(root, 'README.md'), '# Hello');
  await fs.writeFile(path.join(root, 'docs', 'a & b.md'), 'first\nneedle here\nlast');
  await fs.writeFile(path.join(root, 'node_modules', 'hidden'), 'needle');
  await fs.writeFile(path.join(root, 'binary'), Buffer.from([0, 110, 101, 101, 100, 108, 101]));
  return root;
}

test('browse folder entries, README and literal names; do not show dependency folders', async t => {
  const root = await fixture(t);
  const d = await browse(root);
  assert.equal(d.readme, path.join(root, 'README.md'));
  assert.equal(d.entries[0].name, 'docs');
  assert.ok(!d.entries.some(e => e.name === 'node_modules'));
  const folder = await browse(root, { dir: 'docs' });
  assert.deepEqual(folder.entries.map(e => e.rel), ['docs/a & b.md']);
});
test('recursive name/content search returns line matches, skips binary and dependency contents', async t => {
  const root = await fixture(t);
  const names = await browse(root, { q: 'a & b' });
  assert.equal(names.entries.length, 1);
  const content = await browse(root, { q: 'needle', contents: true });
  assert.equal(content.entries.length, 1);
  assert.equal(content.entries[0].line, 2);
  assert.equal(content.entries[0].snippet, 'needle here');
});
test('reject traversal and escaping symlinks; never follow links in search', async t => {
  const root = await fixture(t);
  await fs.symlink(os.tmpdir(), path.join(root, 'escape'));
  await assert.rejects(safePath(root, '..'), /outside/);
  await assert.rejects(browse(root, { dir: 'escape' }), /outside/);
  const d = await browse(root, { q: 'needle', contents: true });
  assert.equal(d.entries.length, 1);
});
test('large result sets are explicitly marked incomplete', async t => {
  const root = await fixture(t);
  await Promise.all(Array.from({ length: 305 }, (_, i) => fs.writeFile(path.join(root, 'f' + i), '')));
  const d = await browse(root);
  assert.equal(d.entries.length, 300);
  assert.equal(d.truncated, true);
});
test('activity is scoped, ordered, capped, and never reclassifies unknown writes', async t => {
  const root = await fixture(t);
  const ledger = new FileLedger(path.join(root, 'ledger.db'));
  t.after(() => ledger.close());
  for (const [id, ts, actor, conv_key, project, outcome] of [
    ['a', 10, 'ai', 'c1', 'p', 'applied'], ['b', 20, 'human', null, 'p', 'applied'],
    ['c', 30, 'external', null, 'p', 'applied'], ['d', 40, 'ai', 'c2', 'other', 'applied'],
    ['e', 50, 'ai', 'c1', 'p', 'failed'],
  ]) ledger.put({ id, ts, actor, conv_key, project, outcome, path: path.join(root, id), producer: actor === 'external' ? 'watch' : 'editor-save' });
  const all = activityQuery(ledger.db, 'p', { from: 0, limit: 2 });
  assert.deepEqual(all.events.map(e => e.id), ['c', 'b']); assert.equal(all.truncated, true);
  assert.deepEqual(activityQuery(ledger.db, 'p', { from: 0, conv: 'c1' }).events.map(e => e.id), ['a']);
  assert.deepEqual(activityQuery(ledger.db, 'p', { from: 0, actor: 'human' }).events.map(e => e.id), ['b']);
  assert.equal(activityQuery(ledger.db, 'p', { from: 0, to: 25 }).events.length, 2);
});
test('client range and route helpers preserve conversation, folders and special characters', async () => {
  const context = vm.createContext({ URLSearchParams, Date, Map, console, setInterval() {}, document: { addEventListener() {} } });
  vm.runInContext(await fs.readFile(path.join(__dirname, '../files-browser.js'), 'utf8'), context);
  const s = { project: 'a & b', conv: 'c%1', root: '/tmp/x', dir: 'docs/a & b', mode: 'changes', range: 'conversation', count: 20, actor: '' };
  const hash = context.fbHash(s);
  assert.deepEqual(JSON.parse(decodeURIComponent(hash.slice(7))), s);
  assert.equal(context.fbActivityParams(s).get('conv'), 'c%1');
  assert.equal(context.fbActivityParams({ ...s, range: 'last', count: 7 }).get('limit'), '7');
  assert.throws(() => context.fbActivityParams({ ...s, range: 'custom', from: 'bad date' }), /valid time range/);
});
