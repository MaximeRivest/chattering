'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const vm = require('node:vm');
const { derive } = require('../live-file-marks');
const { blameLine, parseBlame } = require('../live-file-services');

test('review markers and saved-line provenance are independent', () => {
  const data = derive({ baseline: 'before\nsame', original: 'after\nsame', text: 'after\nlocal\nsame', label: 'since review' });
  assert.deepEqual(data.marks.map(m => [m.line, m.cls]), [[1, 'lf-modified'], [2, 'lf-modified']]);
  assert.deepEqual([...data.origins], [0, 1, 0, 2]);
  assert.match(data.marks[0].title, /since review/);
  const saved = derive({ baseline: 'before\nsame', original: 'after\nlocal\nsame', text: 'after\nlocal\nsame' });
  assert.equal(saved.marks.length, 2);
  assert.deepEqual([...saved.origins], [0, 1, 2, 3]);
});
test('deletions mark surviving lines, and undo removes change markers', () => {
  const data = derive({ baseline: 'a\nb\nc', original: 'a\nb\nc', text: 'a\nc' });
  assert.equal(data.marks[0].line, 2); assert.equal(data.marks[0].cls, 'lf-deleted');
  assert.match(data.marks[0].title, /above this line/);
  assert.equal(data.origins[2], 3);
  assert.equal(derive({ baseline: 'a\nb\nc', original: 'a\nb\nc', text: 'a\nb\nc' }).marks.length, 0);
  assert.equal(derive({ baseline: 'gone', original: 'gone', text: '' }).marks[0].line, 1);
  assert.equal(derive({ baseline: '', original: '', text: 'new' }).marks[0].cls, 'lf-added');
});
test('annotation budgets fail softly without attempting huge diffs', () => {
  assert.match(derive({ baseline: '', original: '', text: 'x'.repeat(2 * 1024 * 1024 + 1) }).unavailable, /paused/);
  assert.match(derive({ baseline: '', original: '', text: '\n'.repeat(50001) }).unavailable, /paused/);
});
test('recovery drafts retain their save version and saving preserves the review baseline', async () => {
  const stored = new Map();
  const context = vm.createContext({ sessionStorage: { setItem: (k, v) => stored.set(k, v), removeItem: k => stored.delete(k) }, errToast() {} });
  vm.runInContext(await fs.readFile(require.resolve('../live-file.js'), 'utf8'), context);
  assert.equal(context.liveLanguage('/project/src/file.mts'), 'typescript');
  assert.equal(context.liveLanguage('/project/Dockerfile'), 'dockerfile');
  assert.equal(context.liveLanguage('/project/LICENSE'), 'text');
  const ws = { path: '/file.js', editor: { getContent: () => 'newer typing' }, live: { sha: 'old-sha', original: 'old text', baseline: 'review baseline', blame: new Map(), refresh() {} } };
  context.liveFileStash(ws);
  assert.equal(JSON.parse(stored.get('chattering.draft:/file.js')).sha, 'old-sha');
  context.liveFileSaved(ws, 'submitted text', 'new-sha');
  context.liveFileStash(ws);
  const draft = JSON.parse(stored.get('chattering.draft:/file.js'));
  assert.equal(draft.sha, 'new-sha'); assert.equal(draft.text, 'newer typing');
  assert.equal(ws.live.baseline, 'review baseline');
});
test('Git attribution keeps uncommitted authors unknown', () => {
  const commit = 'a'.repeat(40);
  const data = parseBlame(`${commit} 1 1 1\nauthor Person\nauthor-time 123\nsummary Original change\n\tcode`);
  assert.equal(data.author, 'Person'); assert.equal(data.commit, commit); assert.equal(data.time, 123000);
  assert.equal(parseBlame('0'.repeat(40) + ' 1 1 1\nauthor Not Committed Yet').kind, 'uncommitted');
  assert.equal(parseBlame('invalid').kind, 'unknown');
});
test('line attribution uses supplied disk text, never reconstructed transcript line numbers', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'live-file-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'code.js'); await fs.writeFile(file, 'const original = 1;\n');
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=test@example.test', 'commit', '-m', 'First version']);
  const before = await blameLine(file, 'const original = 1;\n', 1);
  assert.equal(before.kind, 'git'); assert.equal(before.author, 'Fixture');
  const changed = await blameLine(file, 'const changed = 2;\n', 1);
  assert.equal(changed.kind, 'uncommitted');
  await assert.rejects(blameLine(file, 'one line', 9), /Invalid line/);
});
