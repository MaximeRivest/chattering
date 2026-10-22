'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function setup(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'project-create-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const b = vm.createContext({ fs, fsp: fs.promises, path, crypto, process, platform: require('../platform.js'), LOOSE_PROJECT: 'Loose conversations', createdProjects: {},
    expandHomePath: x => x, foldsLib: { rawProjectOf: x => x }, canonicalProjectName: x => x,
    saveCreatedProjects() {}, gitCalls: 0, agents: 0, vouches: [], titles: {}, projectTitles: {}, saveProjectTitles() {},
    projectMemoryPaths: x => ({ dir: path.join(root, 'memory'), intent: path.join(root, 'memory', 'intent.md') }),
  });
  b.projectMetaFor = x => b.createdProjects[x];
  b.gitText = async () => { b.gitCalls++; };
  b.startProjectConversation = async () => { b.agents++; return {}; };
  b.vouchApply = async x => { b.vouches.push(x); };
  b.setProjectTitle = (project, title, manual) => { b.titles[project] = title; b.projectTitles[project] = { title, manual }; return { project, title, manual }; };
  vm.runInContext(source.slice(source.indexOf('async function createProject(body)'), source.indexOf('// "Create area" mirrors the project birth ritual')), b);
  return { b, root };
}
test('explicit create normalizes names, never writes legacy intent or starts agents', async t => {
  const { b, root } = setup(t);
  b.foldsLib = { rawProjectOf: x => path.basename(x) };
  const r = await b.createProject({ operation: 'create', name: 'hello world', parent: root, git: false, intent: 'ignored', firstPrompt: 'ignored' });
  assert.equal(r.cwd, path.join(root, 'hello-world'));
  assert.ok(fs.statSync(r.cwd).isDirectory());
  assert.equal(b.agents, 0); assert.equal(b.vouches.length, 0); assert.equal(b.gitCalls, 0);
  assert.equal(fs.existsSync(path.join(root, 'memory')), false);
  assert.equal(r.title, 'hello world', 'the name as typed becomes the display title');
  assert.equal(b.titles['hello-world'], 'hello world');
});
test('create accepts names in any alphabet, NFC, and keeps a plain name untitled', async t => {
  const { b, root } = setup(t);
  b.foldsLib = { rawProjectOf: x => path.basename(x) };
  const decomposed = 'E\u0301tude'; // É typed as E + combining accent
  const r = await b.createProject({ operation: 'create', name: decomposed, parent: root, git: false });
  assert.equal(r.cwd, path.join(root, '\u00c9tude'));
  assert.equal(r.title, null, 'folder and name agree: no separate title');
  const cjk = await b.createProject({ operation: 'create', name: '项目 二', parent: root, git: false });
  assert.equal(path.basename(cjk.cwd), '项目-二');
  for (const name of ['-lead', '.hidden', 'a/b', 'x\u0000y', 'semi;colon']) await assert.rejects(b.createProject({ operation: 'create', parent: root, name }));
});
test('setup saves an optional purpose as a reviewed human document, and keeps one already there', async t => {
  const { b, root } = setup(t);
  const r = await b.createProject({ operation: 'create', name: 'with-purpose', parent: root, git: false, purpose: '  Write the thesis.\r\n' });
  assert.equal(r.purpose, true); assert.equal(r.warning, null);
  assert.equal(fs.readFileSync(path.join(root, 'memory', 'intent.md'), 'utf8'), 'Write the thesis.\n');
  assert.equal(b.vouches.length, 1); assert.equal(b.agents, 0);
  const dir = path.join(root, 'existing-folder'); fs.mkdirSync(dir);
  const added = await b.createProject({ operation: 'add', path: dir, purpose: 'Something else' });
  assert.equal(added.purpose, false); assert.match(added.warning, /already had a purpose/);
  assert.equal(fs.readFileSync(path.join(root, 'memory', 'intent.md'), 'utf8'), 'Write the thesis.\n');
  await assert.rejects(b.createProject({ operation: 'create', name: 'too-long', parent: root, purpose: 'x'.repeat(20001) }), /too long/);
  assert.equal(fs.existsSync(path.join(root, 'too-long')), false, 'a rejected purpose touches nothing');
});
test('undo removes what setup made, and only that', async t => {
  const { b, root } = setup(t);
  b.foldsLib = { rawProjectOf: x => path.basename(x) };
  // Fresh folder with an unborn Git repository: removed entirely.
  b.gitText = async cwd => { fs.mkdirSync(path.join(cwd, '.git', 'refs', 'heads'), { recursive: true }); fs.writeFileSync(path.join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n'); };
  const fresh = await b.createProject({ operation: 'create', name: 'My Thesis', parent: root, purpose: 'p' });
  const out = b.undoProjectSetup('My-Thesis');
  assert.equal(out.folderRemoved, true);
  assert.equal(fs.existsSync(fresh.cwd), false);
  assert.equal(b.createdProjects['My-Thesis'], undefined);
  assert.equal(fs.existsSync(path.join(root, 'memory', 'intent.md')), false, 'the purpose does not return with a namesake');
  assert.equal(b.projectTitles['My-Thesis'], undefined);
  // A folder that gained a file is the person's: kept, and said so.
  const used = await b.createProject({ operation: 'create', name: 'used', parent: root, git: false });
  fs.writeFileSync(path.join(used.cwd, 'notes.md'), 'mine');
  const kept = b.undoProjectSetup('used');
  assert.equal(kept.folderRemoved, false); assert.match(kept.folderKept, /files/);
  assert.equal(fs.readFileSync(path.join(used.cwd, 'notes.md'), 'utf8'), 'mine');
  // A repository with a commit is the person's too.
  const committed = await b.createProject({ operation: 'create', name: 'committed', parent: root });
  fs.writeFileSync(path.join(committed.cwd, '.git', 'refs', 'heads', 'main'), 'abc\n');
  assert.equal(b.undoProjectSetup('committed').folderRemoved, false);
  assert.ok(fs.existsSync(committed.cwd));
  // An added folder is never touched.
  const mine = path.join(root, 'mine'); fs.mkdirSync(mine);
  await b.createProject({ operation: 'add', path: mine });
  assert.equal(b.undoProjectSetup('mine').folderRemoved, false);
  assert.ok(fs.existsSync(mine));
  // Once conversations exist, undo refuses.
  await b.createProject({ operation: 'create', name: 'busy', parent: root, git: false });
  const realMeta = b.projectMetaFor;
  b.projectMetaFor = x => x === 'busy' ? { entries: [{}] } : realMeta(x);
  assert.throws(() => b.undoProjectSetup('busy'), /has conversations/);
  assert.throws(() => b.undoProjectSetup('nope'), /no longer/);
});
test('add preserves exact Unicode and spaces and never mutates the directory', async t => {
  const { b, root } = setup(t);
  const dir = path.join(root, ' café 项目 '); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'keep'), 'unchanged');
  const before = fs.statSync(dir).mtimeMs;
  const results = await Promise.allSettled([1, 2].map(() => b.createProject({ operation: 'add', path: dir, git: true, intent: 'ignored', firstPrompt: 'ignored' })));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'fulfilled').value.cwd, dir);
  assert.deepEqual(fs.readdirSync(dir), ['keep']); assert.equal(fs.readFileSync(path.join(dir, 'keep'), 'utf8'), 'unchanged');
  assert.equal(fs.statSync(dir).mtimeMs, before);
  assert.equal(b.gitCalls, 0); assert.equal(b.agents, 0); assert.equal(b.vouches.length, 0);
  await assert.rejects(b.createProject({ operation: 'add', path: path.join(root, 'missing') }));
});
test('create rejects invalid paths and existing targets; concurrent create has one winner', async t => {
  const { b, root } = setup(t);
  for (const name of ['../escape', '.', '', 'a/b']) await assert.rejects(b.createProject({ operation: 'create', parent: root, name }));
  await assert.rejects(b.createProject({ operation: 'create', parent: path.join(root, 'missing'), name: 'child' }));
  fs.mkdirSync(path.join(root, 'existing'));
  fs.writeFileSync(path.join(root, 'file'), 'keep');
  fs.symlinkSync(path.join(root, 'absent'), path.join(root, 'link'));
  for (const name of ['existing', 'file', 'link']) await assert.rejects(b.createProject({ operation: 'create', parent: root, name }));
  await assert.rejects(b.createProject({ operation: 'add', path: path.join(root, 'file') }));
  const results = await Promise.allSettled([1, 2].map(() => b.createProject({ operation: 'create', parent: root, name: 'race' })));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(b.gitCalls, 1);
  await assert.rejects(b.createProject({ operation: 'typo', name: 'oops', parent: root }));
});
test('explicit setup rejects relative and general folders', async t => {
  const { b, root } = setup(t);
  await assert.rejects(b.createProject({ operation: 'add', path: '.' }), /full folder path/);
  await assert.rejects(b.createProject({ operation: 'create', parent: '.', name: 'new' }), /full parent folder path/);
  b.foldsLib = require('../projectfolds');
  await assert.rejects(b.createProject({ operation: 'add', path: root }), /Choose a project folder/);
});
test('setup reports Git failure without losing the saved project', async t => {
  const { b, root } = setup(t);
  b.gitText = async () => { throw new Error('Git failed'); };
  const out = await b.createProject({ operation: 'create', parent: root, name: 'git-failure' });
  assert.match(out.warning, /Git/);
  assert.ok(b.createdProjects[out.project]);
});
test('registry failure leaves files safe and permits adding the created folder later', async t => {
  const { b, root } = setup(t);
  b.saveCreatedProjects = () => { throw new Error('disk full'); };
  await assert.rejects(b.createProject({ operation: 'create', parent: root, name: 'retry' }), /Use Add existing folder/);
  assert.equal(Object.keys(b.createdProjects).length, 0);
  assert.ok(fs.statSync(path.join(root, 'retry')).isDirectory());
  b.saveCreatedProjects = () => {};
  const out = await b.createProject({ operation: 'add', path: path.join(root, 'retry') });
  assert.equal(out.adopted, true);
});
test('legacy creation still supports recursive parents, intent and first prompt', async t => {
  const { b, root } = setup(t);
  await b.createProject({ name: 'legacy', parent: path.join(root, 'new'), intent: 'purpose', firstPrompt: 'go' });
  assert.equal(b.agents, 1); assert.equal(b.vouches.length, 1); assert.equal(b.gitCalls, 1);
});
test('purpose routes save, vouch and read without agents', async t => {
  const { b, root } = setup(t);
  b.createdProjects.demo = {};
  const start = source.indexOf("    } else if (u.pathname === '/api/project/purpose'");
  const end = source.indexOf("    } else if (u.pathname === '/api/project/create'", start);
  vm.runInContext('async function route(req, res, u) { if (false) {} ' + source.slice(start + 6, end) + ' } }', b);
  b.json = (_res, status, value) => { b.response = { status, value }; };
  const req = (method, body) => ({ method, async *[Symbol.asyncIterator]() { yield JSON.stringify(body); } });
  const u = { pathname: '/api/project/purpose', searchParams: new URLSearchParams('project=demo') };
  await b.route(req('GET'), {}, u); assert.equal(b.response.value.intent, '');
  await b.route(req('POST', { project: 'demo', intent: 'Human purpose', baseText: '' }), {}, u);
  assert.equal(b.response.status, 200); assert.equal(b.vouches.length, 1);
  await b.route(req('GET'), {}, u); assert.equal(b.response.value.intent, 'Human purpose\n');
  await b.route(req('POST', { project: 'demo', intent: 'stale edit', baseText: '' }), {}, u);
  assert.equal(b.response.status, 400);
  assert.equal(fs.readFileSync(path.join(root, 'memory', 'intent.md'), 'utf8'), 'Human purpose\n');
  await b.route(req('POST', { project: 'demo', intent: 'Human purpose\n', baseText: 'Human purpose\n' }), {}, u);
  assert.equal(b.response.status, 200);
  assert.equal(fs.readFileSync(path.join(root, 'memory', 'intent.md'), 'utf8'), 'Human purpose\n');
  await b.route(req('POST', { project: 'demo', intent: '', baseText: 'Human purpose\n' }), {}, u);
  assert.equal(b.response.status, 200);
  assert.equal(fs.readFileSync(path.join(root, 'memory', 'intent.md'), 'utf8'), '');
  assert.equal(b.agents, 0);
  await b.route(req('POST', { project: 'unknown', intent: 'no' }), {}, u); assert.equal(b.response.status, 404);
});
