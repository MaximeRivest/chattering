'use strict';
// A folder named in a transcript or linked from a document opens as the
// Files browser at that folder, on any device. The server names where:
// the project and repository root that contain it, and the path inside
// that root, or null when no browsable root contains it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
function extract(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return source.slice(a, b); }

async function fixture(t) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'folder-open-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const repo = path.join(home, 'Projects', 'repo');
  await fsp.mkdir(path.join(repo, 'docs', 'adr'), { recursive: true });
  await fsp.mkdir(path.join(repo, 'vendor', 'nested', 'src'), { recursive: true });
  await fsp.mkdir(path.join(home, 'elsewhere'), { recursive: true });
  await fsp.symlink(path.join(repo, 'docs'), path.join(home, 'docs-link'));
  const real = await fsp.realpath(repo);
  const nested = path.join(real, 'vendor', 'nested');
  const ctx = vm.createContext({
    path, fsp,
    projectOfPath: abs => (abs.startsWith(real) ? 'repo' : null),
    projectMetaFor: project => (project === 'repo' ? { project, cwd: real, entries: [] } : null),
    projectGitRepositories: async () => [nested],
  });
  vm.runInContext(extract('async function folderBrowseLocation(', '\nasync function pathInfoResponse('), ctx);
  return { ctx, home, real, nested };
}

// Objects made inside the vm context have that context's prototypes; Node
// 24 counts that as a difference, so results are compared as plain data.
const plain = o => JSON.parse(JSON.stringify(o));

test('a folder inside a project names the project, its root and the path inside it', async t => {
  const { ctx, real } = await fixture(t);
  assert.deepEqual(plain(await ctx.folderBrowseLocation(path.join(real, 'docs', 'adr'))), { project: 'repo', root: real, dir: 'docs/adr' });
  assert.deepEqual(plain(await ctx.folderBrowseLocation(real)), { project: 'repo', root: real, dir: '' }, 'the root itself browses at its top');
});

test('a nested repository browses as itself: the deepest root wins', async t => {
  const { ctx, real, nested } = await fixture(t);
  assert.deepEqual(plain(await ctx.folderBrowseLocation(path.join(nested, 'src'))), { project: 'repo', root: nested, dir: 'src' });
  assert.deepEqual(plain(await ctx.folderBrowseLocation(path.join(real, 'vendor'))), { project: 'repo', root: real, dir: 'vendor' }, 'above the nested repository, the outer root');
});

test('a symlinked folder is browsed at its real place', async t => {
  const { ctx, home, real } = await fixture(t);
  assert.deepEqual(plain(await ctx.folderBrowseLocation(path.join(home, 'docs-link', 'adr'))), { project: 'repo', root: real, dir: 'docs/adr' });
});

test('a folder outside every project, or outside its project roots, has no in-app view', async t => {
  const { ctx, home } = await fixture(t);
  assert.equal(await ctx.folderBrowseLocation(path.join(home, 'elsewhere')), null);
});

test('the app opens the Files browser at the named place and says so when there is none', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
  const start = app.indexOf('function openFolderInApp('), end = app.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, 'openFolderInApp in app.html');
  const opened = [], errors = [];
  const ctx = vm.createContext({ showFilesBrowser: (project, opts) => opened.push({ project, ...opts }), errToast: m => errors.push(m), viewKind: 'conversation', activeRel: 'conv-1' });
  vm.runInContext(app.slice(start, end + 2), ctx);
  const browse = { project: 'repo', root: '/home/u/repo', dir: 'docs/adr' };
  assert.equal(ctx.openFolderInApp({ kind: 'directory', browse }, { key: 'conv-1' }), true);
  assert.equal(ctx.openFolderInApp({ kind: 'directory', browse }, { key: 'other' }), true);
  assert.deepEqual(opened, [
    { project: 'repo', root: '/home/u/repo', dir: 'docs/adr', conv: 'conv-1' },
    { project: 'repo', root: '/home/u/repo', dir: 'docs/adr', conv: '' },
  ]);
  assert.equal(ctx.openFolderInApp({ kind: 'directory', browse: null, hostActions: false }), false);
  assert.equal(ctx.openFolderInApp({ kind: 'directory', browse: null, hostActions: true }, { quiet: true }), false);
  assert.deepEqual(errors, ['this folder is outside every project — use Show in folder on the server']);
});
