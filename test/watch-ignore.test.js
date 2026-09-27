'use strict';
// The watcher asks git, in batches, which changed paths it ignores.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createIgnoreOracle, isIgnoreRulesPath } = require('../watch-ignore');

function repo(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-ignore-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, '.gitignore'), '/outputs/\n*.log\n');
  fs.mkdirSync(path.join(root, 'outputs', 'run', 'traces'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'));
  return root;
}
// Counts the git processes the oracle starts.
function countingSpawn() {
  const calls = [];
  return { calls, spawnImpl: (cmd, args, opts) => { calls.push(args); return spawn(cmd, args, opts); } };
}

test('git decides: ignored folders and files, with or without the file on disk', async t => {
  const root = repo(t);
  const oracle = createIgnoreOracle(root);
  t.after(() => oracle.close());
  const ask = rel => oracle.isIgnored(rel);
  assert.deepEqual(await Promise.all([
    ask('outputs/'), ask('outputs/run/traces/new-file.jsonl'), ask('debug.log'), ask('src/'), ask('src/main.js'), ask('.gitignore'),
  ]), [true, true, true, false, false, false]);
});

test('a burst costs one git process; answers are cached until the rules change', async t => {
  const root = repo(t);
  const { calls, spawnImpl } = countingSpawn();
  const oracle = createIgnoreOracle(root, { spawnImpl });
  t.after(() => oracle.close());
  const rels = Array.from({ length: 500 }, (_, i) => `outputs/run/traces/${i}.jsonl`).concat(['src/a.js', 'src/a.js']);
  const answers = await Promise.all(rels.map(rel => oracle.isIgnored(rel)));
  assert.equal(calls.length, 1, 'one process for the whole burst');
  assert.equal(answers.filter(Boolean).length, 500);
  assert.equal(answers.at(-1), false);
  assert.equal(await oracle.isIgnored('outputs/run/traces/7.jsonl'), true);
  assert.equal(calls.length, 1, 'cached');
  fs.writeFileSync(path.join(root, '.gitignore'), '*.log\n');
  oracle.rulesChanged();
  assert.equal(await oracle.isIgnored('outputs/run/traces/7.jsonl'), false, 'the new rules apply');
  assert.equal(calls.length, 2);
});

test('outside a repository nothing is ignored and git is asked once', async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-ignore-plain-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { calls, spawnImpl } = countingSpawn();
  const oracle = createIgnoreOracle(dir, { spawnImpl });
  assert.equal(await oracle.isIgnored('outputs/x'), false);
  assert.equal(await oracle.isIgnored('other/y'), false);
  assert.equal(calls.length, 1);
});

test('ignore rule files are recognized', () => {
  assert.equal(isIgnoreRulesPath('.gitignore'), true);
  assert.equal(isIgnoreRulesPath('sub/dir/.gitignore'), true);
  assert.equal(isIgnoreRulesPath('src/gitignore.js'), false);
});

test('the project watcher never watches a folder git ignores', async t => {
  const root = repo(t);
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const a = source.indexOf('function watchRepoTree('), b = source.indexOf('\nasync function ensureProjectFileWatch(', a);
  assert.ok(a >= 0 && b > a);
  const box = vm.createContext({ fs, path, WATCH_SKIP_DIRS: new Set(['.git', 'node_modules']), WATCH_DIR_CAP: 2500 });
  vm.runInContext(source.slice(a, b), box);
  const seen = [];
  const oracle = createIgnoreOracle(root);
  const watcher = box.watchRepoTree(root, rel => seen.push(rel), { ignored: oracle });
  t.after(() => watcher.close());
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(400); // the walk asks git about each folder, then watches
  const count = watcher.count();
  assert.equal(count, 2, 'the root and src; not outputs or anything below it');
  fs.writeFileSync(path.join(root, 'outputs', 'run', 'traces', 'x.jsonl'), '{}');
  fs.writeFileSync(path.join(root, 'src', 'main.js'), 'x');
  await sleep(300);
  assert.ok(seen.includes('src/main.js'));
  assert.ok(!seen.some(rel => rel.startsWith('outputs/')), seen.join(', '));
});
