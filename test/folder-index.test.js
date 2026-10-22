'use strict';
// Folder search (folder-index.js and searchFolders in server.js): what the
// walk keeps, how matches rank, and what each folder means for a purpose.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const plain = x => JSON.parse(JSON.stringify(x)); // out of the vm's realm
const { createFolderIndex, scoreText, displayOf, depthPenalty } = require('../folder-index.js');

const mk = (...parts) => { const p = path.join(...parts); fs.mkdirSync(p, { recursive: true }); return p; };

test('scoreText: every word in order, letters may be skipped; names, word starts and runs rank higher', () => {
  assert.equal(scoreText('~/Documents/thesis', 'xyz'), null);
  assert.equal(scoreText('~/Documents/thesis', 'thesis xyz'), null, 'every word must match');
  const exact = scoreText('~/Projects/os', 'os').score;
  const inside = scoreText('~/Projects/photos', 'os').score;
  assert.ok(exact > inside, 'an exact name beats letters inside a name');
  const prefix = scoreText('~/Projects/chattering', 'chat').score;
  const scattered = scoreText('~/Projects/cheap-hat', 'chat').score;
  assert.ok(prefix > scattered, 'a run beats scattered letters');
  const boundary = scoreText('~/x/dspy-compat-probe', 'comp').score;
  const middle = scoreText('~/x/decompose', 'comp').score;
  assert.ok(boundary > middle, 'a word start beats the middle of a word');
  const both = scoreText('~/Documents/school/2025/thesis', 'sch thes');
  assert.ok(both, 'words match anywhere in the path, any order');
  assert.deepEqual(both.hl.map(i => '~/Documents/school/2025/thesis'[i]).join(''), 'schthes');
  assert.ok(scoreText('~/Projects/Étude', 'étu'), 'any alphabet');
  assert.ok(depthPenalty(1) === 0 && depthPenalty(5) > depthPenalty(3));
  assert.ok(scoreText('~/Documents', 'Doc').score > scoreText('~/docmaker', 'Doc').score, 'smart case: a typed capital prefers that capital');
  assert.ok(scoreText('~/docmaker', 'doc').score >= scoreText('~/Documents', 'doc').score, 'lowercase ignores case');
});

test('the walk keeps working folders and skips hidden, dependency, cache and deep code folders', async t => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-index-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  mk(home, 'Documents', 'school', 'thesis');
  mk(home, '.config', 'app');
  mk(home, 'web', 'node_modules', 'left-pad');
  fs.writeFileSync(path.join(mk(home, 'build-cache'), 'CACHEDIR.TAG'), 'Signature: 8a477f597d28d172789f06886806bc55');
  fs.writeFileSync(path.join(mk(home, 'venv'), 'pyvenv.cfg'), 'home = /usr/bin');
  mk(home, 'Projects', 'repo', '.git');
  mk(home, 'Projects', 'repo', 'docs', 'site', 'deep', 'deeper');
  mk(home, 'a', 'b', 'c', 'd', 'e');
  const idx = createFolderIndex({ home, maxDepth: 4 });
  await idx.ensure();
  const shown = new Set(idx.items().map(i => displayOf(i.abs, home)));
  for (const want of ['~/Documents/school/thesis', '~/Projects/repo', '~/Projects/repo/docs/site', '~/web', '~/a/b/c/d']) assert.ok(shown.has(want), want);
  for (const not of ['~/.config', '~/web/node_modules', '~/build-cache', '~/venv', '~/Projects/repo/docs/site/deep', '~/a/b/c/d/e']) assert.ok(!shown.has(not), not);
  assert.equal(idx.items().find(i => i.abs === path.join(home, 'Projects', 'repo')).git, true);
  assert.equal(idx.ready, true);
  idx.add(path.join(home, 'New'));
  assert.ok(idx.items().some(i => i.abs === path.join(home, 'New')));
  idx.remove(path.join(home, 'Documents'));
  assert.ok(!idx.items().some(i => i.abs.startsWith(path.join(home, 'Documents'))));
});

function server(t) {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'folder-search-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const slice = source.slice(source.indexOf('// ---- folder search'), source.indexOf('function describeStartFolder('));
  const rawProjectOf = cwd => { const m = cwd.match(/\/Projects\/([^/]+)/); return m ? m[1] : path.basename(cwd); };
  const b = vm.createContext({
    fs, fsp: fs.promises, path, os: { homedir: () => home }, folderIndexLib: require('../folder-index.js'), WeakMap,
    NOTES_DIR: path.join(home, 'notes', 'chattering'), CACHE_DIR: path.join(home, '.cache', 'chattering'), DIRS: { data: path.join(home, 'data'), config: path.join(home, 'config') },
    // Only the home folder itself and ~/Projects are too general here.
    foldsLib: { isLooseCwd: c => c === home || c === path.join(home, 'Projects') },
    LOOSE_PROJECT: 'Loose conversations', index: {}, createdProjects: {}, conversationProjects: {},
    canonicalProjectName: x => x, expandHomePath: x => x.replace(/^~(?=$|\/)/, home),
  });
  b.projectNameOf = cwd => b.foldsLib.isLooseCwd(cwd) ? 'Loose conversations' : rawProjectOf(cwd);
  b.projectOfEntry = entry => b.projectNameOf(entry.cwd);
  b.projectRootFromEntries = (name, entries) => (b.createdProjects[name] && b.createdProjects[name].cwd) || (entries[0] && entries[0].entry.cwd) || null;
  // As in the server: a folder with conversations is a project, by name.
  b.projectMetaFor = name => {
    const rec = b.createdProjects[name];
    if (rec) return { cwd: rec.cwd, entries: [] };
    const entries = Object.values(b.index).filter(e => b.projectNameOf(e.cwd) === name);
    return entries.length ? { cwd: entries[0].cwd, entries } : null;
  };
  vm.runInContext(slice, b);
  return { b, home };
}

test('search ranks for the purpose: free folders to add, places for projects, folders conversations ran in', async t => {
  const { b, home } = server(t);
  const thesis = mk(home, 'Documents', 'thesis');
  mk(thesis, '.git');
  const other = mk(home, 'Documents', 'thesis-old');
  const proj = mk(home, 'Projects', 'chattering');
  const elsewhere = mk(home, 'backup', 'chattering');
  const inside = mk(proj, 'docs');
  b.createdProjects.chattering = { cwd: proj };
  b.createdProjects.second = { cwd: mk(home, 'Projects', 'second') };
  b.index['pi:a'] = { cwd: other, lastTs: new Date().toISOString() };
  b.index['pi:b'] = { cwd: other, lastTs: new Date().toISOString() };
  mk(home, 'notes', 'chattering', 'projects', 'thesis-memory');
  await b.folderIndexNow().ensure();

  const add = await b.searchFolders('thes', 'add');
  assert.ok(!add.results.some(r => r.path.includes('notes')), "Chattering's own data is never offered");
  assert.equal(add.mode, 'search');
  assert.equal(add.results[0].path, thesis, 'a free Git folder named like the query comes first');
  assert.equal(add.results[0].git, true);
  const status = p => (add.results.find(r => r.path === p) || {}).status;
  const chat = await b.searchFolders('chattering', 'add');
  const st = p => (chat.results.find(r => r.path === p) || {});
  assert.equal(st(proj).status, 'project');
  assert.equal(st(elsewhere).status, 'taken', 'the name is a project elsewhere');
  assert.match(st(elsewhere).root, /Projects\/chattering$/);
  assert.equal((await b.searchFolders('docs', 'add')).results.find(r => r.path === inside).status, 'inside');
  assert.ok(status(thesis));

  assert.equal(status(other), 'project', 'conversations made it a project');
  const run = await b.searchFolders('thes', 'run');
  assert.equal(run.results[0].path, other, 'for a conversation, where conversations ran wins');
  assert.equal(run.results[0].conversations, 2);

  const suggestAdd = await b.searchFolders('', 'add');
  assert.equal(suggestAdd.mode, 'suggest');
  assert.equal(suggestAdd.results[0].section, 'Git repositories not in Chattering yet');
  assert.equal(suggestAdd.results[0].path, thesis);
  assert.ok(!suggestAdd.results.some(r => r.path === proj), 'projects are not suggested for adding');
  const suggestParent = await b.searchFolders('', 'parent');
  assert.equal(suggestParent.results[0].path, path.join(home, 'Projects'));
  assert.equal(suggestParent.results[0].projectsInside, 2, 'where most projects live comes first');
  assert.equal(suggestParent.results[0].section, 'Where your projects are');
  const suggestRun = await b.searchFolders('', 'run');
  assert.equal(suggestRun.results[0].path, other);
});

test('a typed path lists what is inside, matched by what follows the last slash', async t => {
  const { b, home } = server(t);
  mk(home, 'Documents', 'Thesis'); mk(home, 'Documents', 'taxes'); mk(home, 'Documents', '.hidden'); mk(home, 'Documents', 'node_modules');
  fs.writeFileSync(path.join(home, 'Documents', 'file.txt'), 'x');
  const all = await b.searchFolders('~/Documents/', 'add');
  assert.equal(all.mode, 'path');
  assert.equal(all.results[0].self, true, 'the folder itself comes first');
  assert.deepEqual(plain(all.results.slice(1).map(r => r.name)), ['taxes', 'Thesis'], 'folders only, no hidden or dependency folders, by name');
  const some = await b.searchFolders('~/Documents/ths', 'add');
  assert.deepEqual(plain(some.results.map(r => r.name)), ['Thesis']);
  assert.deepEqual(some.results[0].hl.map(i => some.results[0].display[i]).join(''), 'Ths');
  const hidden = await b.searchFolders('~/Documents/.h', 'add');
  assert.deepEqual(plain(hidden.results.map(r => r.name)), ['.hidden'], 'a typed dot shows hidden folders');
  const missing = await b.searchFolders('~/Nope/', 'add');
  assert.match(missing.error, /No folder at ~\/Nope/);
});
