'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../snippets.js');

function tmpdir() { return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'snip-'))); }

test('frontmatter: flat keys, quoted values, body without leading blank lines', () => {
  const { meta, body } = S.parseFrontmatter('---\ndescription: "Say: hi"\nkind: snippet\nargument-hint: \'<x>\'\n---\n\nHello $1\n');
  assert.equal(meta.description, 'Say: hi');
  assert.equal(meta.kind, 'snippet');
  assert.equal(meta['argument-hint'], '<x>');
  assert.equal(body, 'Hello $1\n');
});

test('frontmatter: none means the whole text is the body', () => {
  const { meta, body } = S.parseFrontmatter('plain text');
  assert.deepEqual(meta, {});
  assert.equal(body, 'plain text');
});

test('serialize round-trips through the parser', () => {
  const text = S.serializeSnippet({ description: 'be brief: no fluff', kind: 'snippet', body: 'Keep it short.\n' });
  const { meta, body } = S.parseFrontmatter(text);
  assert.equal(meta.description, 'be brief: no fluff');
  assert.equal(meta.kind, 'snippet');
  assert.equal(body, 'Keep it short.\n');
});

test('names become pi-safe file names', () => {
  assert.equal(S.sanitizeName('Be Brief!'), 'be-brief');
  assert.equal(S.sanitizeName('  --x--  '), 'x');
  assert.equal(S.sanitizeName('a_b-c9'), 'a_b-c9');
});

test('list merges global and project, project shadows global, kind defaults to template', async () => {
  const g = tmpdir(), p = tmpdir();
  fs.writeFileSync(path.join(g, 'brief.md'), '---\nkind: snippet\n---\nBe brief.\n');
  fs.writeFileSync(path.join(g, 'review.md'), '---\ndescription: Review staged changes\n---\nReview `git diff --cached`.\n');
  fs.mkdirSync(path.join(p, '.pi', 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(p, '.pi', 'prompts', 'brief.md'), '---\nkind: snippet\n---\nBe brief, project style.\n');
  const out = S.listSnippets({ cwd: p, globalDir: g, uses: { [path.join(p, '.pi', 'prompts', 'brief.md')]: { n: 4, at: 5 } } });
  assert.equal(out.projectDir, path.join(p, '.pi', 'prompts'));
  const brief = out.items.find(s => s.name === 'brief');
  assert.equal(brief.scope, 'project');
  assert.equal(brief.body, 'Be brief, project style.\n');
  assert.equal(brief.uses, 4);
  const review = out.items.find(s => s.name === 'review');
  assert.equal(review.kind, 'template');
  assert.equal(review.description, 'Review staged changes');
});

test('the home directory is never a project folder', () => {
  assert.equal(S.projectDirFor(os.homedir()), null);
  assert.equal(S.listSnippets({ cwd: os.homedir(), globalDir: tmpdir() }).projectDir, null);
});

test('ranking: prefix beats substring beats description; empty query orders by use', () => {
  const items = [
    { name: 'remind', description: 'x', uses: 1, lastUsed: 0 },
    { name: 'brief', description: 'a reminder to be short', uses: 9, lastUsed: 0 },
    { name: 'xremx', description: '', uses: 0, lastUsed: 0 },
  ];
  assert.deepEqual(S.rankSnippets(items, 'rem').map(s => s.name), ['remind', 'xremx', 'brief']);
  assert.deepEqual(S.rankSnippets(items, '').map(s => s.name), ['brief', 'remind', 'xremx']);
  assert.deepEqual(S.rankSnippets(items, 'zzz').map(s => s.name), []);
});

test('create writes a file, refuses a silent overwrite, allows an explicit one', async () => {
  const dir = path.join(tmpdir(), 'nested', 'prompts');
  const made = await S.createSnippet({ dir, name: 'Be Brief', body: 'Be brief.', description: 'short' });
  assert.equal(made.name, 'be-brief');
  assert.ok(fs.existsSync(made.path));
  await assert.rejects(() => S.createSnippet({ dir, name: 'be-brief', body: 'x' }), e => e.code === 'EXISTS');
  await S.createSnippet({ dir, name: 'be-brief', body: 'Be very brief.', overwrite: true });
  assert.equal(S.parseFrontmatter(fs.readFileSync(made.path, 'utf8')).body, 'Be very brief.\n');
  await assert.rejects(() => S.createSnippet({ dir, name: 'ok', body: '   ' }), /empty/);
  await assert.rejects(() => S.createSnippet({ dir, name: '!!!', body: 'x' }), /name/);
});

test('use counts live in the cache file, not in the snippet', async () => {
  const file = path.join(tmpdir(), 'uses.json');
  const p = '/x/.pi/prompts/a.md';
  await S.bumpUse(file, p);
  const u = await S.bumpUse(file, p);
  assert.equal(u.n, 2);
  assert.equal(S.loadUses(file)[p].n, 2);
});

test('snippet paths: the global folder and any .pi/prompts folder', () => {
  const g = '/home/u/.pi/agent/prompts';
  assert.equal(S.isSnippetPath(g + '/a.md', g), true);
  assert.equal(S.isSnippetPath('/proj/.pi/prompts/a.md', g), true);
  assert.equal(S.isSnippetPath('/proj/prompts/a.md', g), false);
  assert.equal(S.isSnippetPath('/proj/.pi/prompts/a.txt', g), false);
});

test('project trust follows pi: nearest ancestor entry in trust.json', () => {
  const root = tmpdir();
  const trust = path.join(root, 'trust.json');
  const proj = path.join(root, 'proj'), sub = path.join(proj, 'area'), other = path.join(root, 'other');
  fs.mkdirSync(sub, { recursive: true }); fs.mkdirSync(other);
  fs.writeFileSync(trust, JSON.stringify({ [fs.realpathSync.native(proj)]: true, [fs.realpathSync.native(root)]: false }));
  assert.equal(S.projectTrusted(proj, trust), true);
  assert.equal(S.projectTrusted(sub, trust), true);
  assert.equal(S.projectTrusted(other, trust), false);
  assert.equal(S.listSnippets({ cwd: sub, globalDir: tmpdir(), trustFile: trust }).projectTrusted, true);
});
