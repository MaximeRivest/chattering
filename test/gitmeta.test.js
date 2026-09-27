'use strict';
// gitmeta.js reads git's on-disk files instead of spawning git. The tests
// build real repositories with the git binary, then check that the file
// reader agrees with git's own answers (rev-parse, branch, remote, worktree).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const gm = require('../gitmeta.js');

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gitmeta-')));

function makeRepo() {
  const root = tmp();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-q', '-m', 'first');
  return root;
}

test('parsePackedRefs and parseRemoteUrl handle the documented formats', () => {
  const packed = gm.parsePackedRefs('# pack-refs with: peeled fully-peeled sorted \n' +
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main\n' +
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb refs/tags/v1\n^cccccccccccccccccccccccccccccccccccccccc\n');
  assert.strictEqual(packed.get('refs/heads/main'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.strictEqual(packed.get('refs/tags/v1'), 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  const cfg = '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@x:u/up.git\n[remote "origin"]\n\t# comment\n\turl = https://github.com/u/r.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n';
  assert.strictEqual(gm.parseRemoteUrl(cfg), 'https://github.com/u/r.git');
  assert.strictEqual(gm.parseRemoteUrl(cfg, 'upstream'), 'git@x:u/up.git');
  assert.strictEqual(gm.parseRemoteUrl('[core]\n\tbare = false\n'), '');
});

test('findGitRoot walks up like rev-parse --show-toplevel', async () => {
  const root = makeRepo();
  const deep = path.join(root, 'x', 'y');
  fs.mkdirSync(deep, { recursive: true });
  assert.strictEqual(await gm.findGitRoot(deep), root);
  assert.strictEqual(await gm.findGitRoot(root), root);
  assert.strictEqual(await gm.findGitRoot(tmp()), '');
});

test('readHead matches git for loose refs, packed refs, and a detached HEAD', async () => {
  const root = makeRepo();
  assert.deepStrictEqual(await gm.readHead(root), { branch: 'main', head: git(root, 'rev-parse', 'HEAD') });
  git(root, 'pack-refs', '--all');
  assert.ok(!fs.existsSync(path.join(root, '.git', 'refs', 'heads', 'main')), 'ref is packed');
  assert.deepStrictEqual(await gm.readHead(root), { branch: 'main', head: git(root, 'rev-parse', 'HEAD') });
  git(root, 'checkout', '-q', '--detach');
  assert.deepStrictEqual(await gm.readHead(root), { branch: null, head: git(root, 'rev-parse', 'HEAD') });
  const empty = tmp();
  git(empty, 'init', '-q', '-b', 'main');
  assert.deepStrictEqual(await gm.readHead(empty), { branch: 'main', head: '' });
});

test('readRemoteUrl reads config without git', async () => {
  const root = makeRepo();
  assert.strictEqual(await gm.readRemoteUrl(root), '');
  git(root, 'remote', 'add', 'origin', 'https://example.com/u/r.git');
  assert.strictEqual(await gm.readRemoteUrl(root), 'https://example.com/u/r.git');
});

test('worktrees: readHead, readRemoteUrl, and listWorktrees see through the .git file', async () => {
  const root = makeRepo();
  git(root, 'remote', 'add', 'origin', 'https://example.com/u/r.git');
  const wt = path.join(tmp(), 'feature');
  git(root, 'worktree', 'add', '-q', '-b', 'feature', wt);
  assert.deepStrictEqual(await gm.readHead(wt), { branch: 'feature', head: git(wt, 'rev-parse', 'HEAD') });
  assert.strictEqual(await gm.readRemoteUrl(wt), 'https://example.com/u/r.git');
  assert.strictEqual(await gm.findGitRoot(path.join(wt)), wt);
  const expected = git(root, 'worktree', 'list', '--porcelain').split('\n')
    .filter(l => l.startsWith('worktree ')).map(l => path.resolve(l.slice(9))).sort(); // native, as listWorktrees answers (git writes / on Windows)
  assert.deepStrictEqual((await gm.listWorktrees(root)).sort(), expected);
  assert.deepStrictEqual((await gm.listWorktrees(wt)).sort(), expected);
  // A worktree whose folder is gone is skipped, never thrown.
  fs.rmSync(wt, { recursive: true, force: true });
  assert.deepStrictEqual(await gm.listWorktrees(root), [root]);
});

test('findGitRoot: a missing directory answers nothing, like git -C', async () => {
  const root = makeRepo();
  assert.strictEqual(await gm.findGitRoot(path.join(root, 'gone', 'deeper')), '');
  fs.writeFileSync(path.join(root, 'file'), 'x');
  assert.strictEqual(await gm.findGitRoot(path.join(root, 'file')), '');
});

test('findGitRoot resolves symlinks like git (physical path)', async () => {
  const root = makeRepo();
  const link = path.join(tmp(), 'link');
  fs.symlinkSync(root, link);
  assert.strictEqual(await gm.findGitRoot(path.join(link, 'x')), '');
  fs.mkdirSync(path.join(root, 'x'));
  assert.strictEqual(await gm.findGitRoot(path.join(link, 'x')), fs.realpathSync.native(root));
  assert.strictEqual(await gm.findGitRoot(link), fs.realpathSync.native(root));
});
