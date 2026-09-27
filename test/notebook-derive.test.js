'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ND = require('../notebook-derive.js');
const NE = require('../notebook-env.js');

test('shapeReply unwraps one whole-file fence and insists on front matter', () => {
  const nb = '---\ntitle: T\nrat:\n  python:\n    dependencies:\n      - rich\n---\n# T\n\n```python\nimport rich\n```\n';
  assert.equal(ND.shapeReply(nb), nb);
  assert.equal(ND.shapeReply('```markdown\n' + nb.trim() + '\n```'), nb);
  assert.equal(ND.shapeReply('```\n' + nb.trim() + '\n```\n'), nb);
  assert.throws(() => ND.shapeReply('Here is your notebook:\n\n---\ntitle: x\n---\n'), /front matter/);
  assert.throws(() => ND.shapeReply('---\ntitle: never closed\n'), /close/);
});

test('stamp pins the project and records provenance without touching the body', () => {
  const nb = '---\ntitle: Heredoc tools\nrat:\n  python:\n    dependencies:\n      - -e .\n---\n# Heredoc tools\n\ntext\n';
  const out = ND.stamp(nb, { project: '../..', source: { conversation: 'pi:x/y.jsonl', entry: 'e1', created: '2026-09-18T12:00:00Z' } });
  assert.equal(out, '---\ntitle: Heredoc tools\nrat:\n  project: ../..\n  python:\n    dependencies:\n      - -e .\nsource:\n  conversation: "pi:x/y.jsonl"\n  entry: "e1"\n  created: "2026-09-18T12:00:00Z"\n---\n# Heredoc tools\n\ntext\n');
  assert.equal(NE.readScalar(out, ['source', 'entry']), 'e1');
  assert.equal(NE.readScalar(out, ['rat', 'project']), '../..');
  assert.throws(() => ND.stamp('---\nrat: {python: {}}\n---\n', { project: '.', source: {} }), /unexpected shape/);
});

test('slugFor and freshPath give dated, collision-free names', () => {
  const day = new Date('2026-09-18T15:00:00Z');
  assert.equal(ND.slugFor('Heredoc tools: “markers” & probes!', day), '2026-09-18-heredoc-tools-markers-probes');
  assert.equal(ND.slugFor('', day), '2026-09-18-notebook');
  assert.equal(ND.slugFor('Éléphant à Pâques', day), '2026-09-18-elephant-a-paques');
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'slug-')));
  fs.writeFileSync(path.join(dir, 'a.md'), '');
  fs.writeFileSync(path.join(dir, 'a-2.md'), '');
  assert.equal(ND.freshPath(dir, 'a'), path.join(dir, 'a-3.md'));
  assert.equal(ND.freshPath(dir, 'b'), path.join(dir, 'b.md'));
});

test('checkAfter keeps only prerequisites that exist in this conversation', () => {
  const existing = [{ path: '/p/documents/notebooks/2026-09-18-load.md' }];
  const nb = '---\ntitle: x\nrat:\n  after:\n    - ./2026-09-18-load.md\n    - ./made-up.md\n    - 2026-09-18-load.md\n---\n';
  const { kept, dropped } = ND.checkAfter(nb, existing);
  assert.deepEqual(kept, ['./2026-09-18-load.md', '2026-09-18-load.md']);
  assert.deepEqual(dropped, ['./made-up.md']);
  assert.deepEqual(ND.checkAfter('---\ntitle: x\n---\n', existing), { kept: [], dropped: [] });
});

test('listNotebooks reads provenance, titles, headings and dependencies; buildPrompt names them', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nbroot-')));
  const dir = path.join(root, ND.NOTEBOOKS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2026-09-17-load.md'), '---\ntitle: Load the data\nrat:\n  project: ../..\n  python:\n    dependencies:\n      - pandas\nsource:\n  conversation: "pi:a/b.jsonl"\n  entry: "e1"\n---\n# Load the data\n\n## Read the CSV\n\n```python\n# not a heading\nimport pandas\n```\n');
  fs.writeFileSync(path.join(dir, '2026-09-18-other.md'), '---\ntitle: Other\nsource:\n  conversation: "pi:z/z.jsonl"\n  entry: "q"\n---\n');
  fs.writeFileSync(path.join(dir, '.draft-x.md'), '---\ntitle: draft\n---\n');
  const all = ND.listNotebooks(root);
  assert.deepEqual(all.map(n => n.title), ['Load the data', 'Other']);
  const mine = ND.listNotebooks(root, { conversation: 'pi:a/b.jsonl' });
  assert.equal(mine.length, 1);
  assert.deepEqual(mine[0].headings, ['Load the data', 'Read the CSV']);
  assert.deepEqual(mine[0].dependencies, ['pandas']);
  assert.equal(mine[0].source.entry, 'e1');
  assert.deepEqual(ND.listNotebooks(path.join(root, 'nope')), []);

  const prompt = ND.buildPrompt({ projectRoot: root, notebooksDir: dir, existing: mine });
  assert.ok(prompt.startsWith(ND.PROMPT_HEAD));
  assert.match(prompt, /\.\/2026-09-17-load\.md — "Load the data" — sections: Load the data \/ Read the CSV — dependencies: pandas/);
  assert.match(ND.buildPrompt({ projectRoot: root, notebooksDir: dir, existing: [] }), /no earlier notebooks/);
});

test('repairLocalLines replaces a wrong local line only when the environment has exactly one editable package', () => {
  const nb = '---\ntitle: x\nrat:\n  python:\n    dependencies:\n      - "-e ."\n      - websockets\n---\nbody\n';
  const one = ND.repairLocalLines(nb, [{ name: 'lmcc', line: '-e ./python' }]);
  assert.equal(one.text, '---\ntitle: x\nrat:\n  python:\n    dependencies:\n      - "-e ./python"\n      - websockets\n---\nbody\n');
  assert.deepEqual(one.fixed, ['-e . → -e ./python']);
  assert.deepEqual(ND.repairLocalLines(nb, [{ name: 'a', line: '-e ./a' }, { name: 'b', line: '-e ./b' }]).fixed, [], 'two candidates: nothing is guessed');
  assert.deepEqual(ND.repairLocalLines(nb, []).fixed, []);
  const right = '---\nrat:\n  python:\n    dependencies:\n      - -e ./python\n---\n';
  assert.deepEqual(ND.repairLocalLines(right, [{ name: 'lmcc', line: '-e ./python' }]), { text: right, fixed: [] });
});

test('buildPrompt tells the model where the project\u0027s own packages really live', () => {
  const p = ND.buildPrompt({ projectRoot: '/p', notebooksDir: '/p/documents/notebooks', editable: [{ name: 'lmcc', line: '-e ./python' }] });
  assert.match(p, /`-e \.\/python` \(lmcc\)\. Do not write "-e \." unless it is listed here/);
  assert.match(ND.buildPrompt({ projectRoot: '/p', notebooksDir: '/p/documents/notebooks', projectPackage: 'dspy' }), /"dspy": write "-e \."/);
  assert.match(ND.buildPrompt({ projectRoot: '/p', notebooksDir: '/p/documents/notebooks' }), /not a Python package: do not write "-e \."/);
});
