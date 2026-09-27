'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileAskBrief, notebookFacts, formatAgo, fenceFor, AskLog } = require('../file-ask.js');
const { RUN_LANGS } = require('../notebook-env.js');

test('a notebook is a Markdown file with cells rat runs, or a rat header', () => {
  const nb = '---\ntitle: T\nrat:\n  python:\n    dependencies: [numpy]\n---\n\n# A\n\n```python\nx = 1\n```\n\n```output\n1\n```\n\n```bash\nls\n```\n';
  assert.deepEqual(notebookFacts(nb, RUN_LANGS), { runtimes: ['py', 'sh'], cells: 2, header: true });
  assert.deepEqual(notebookFacts('---\nrat:\n  project: ..\n---\nprose only\n', RUN_LANGS), { runtimes: [], cells: 0, header: true });
  assert.equal(notebookFacts('# Essay\n\n```mermaid\ngraph TD\n```\n', RUN_LANGS), null, 'a diagram is not a cell');
  assert.equal(notebookFacts('````md\n```python\nnot a cell: inside a longer fence\n```\n````\n', RUN_LANGS), null);
});

test('the brief says where the request points, how to edit, and when to stop', () => {
  const brief = fileAskBrief({ path: '/p/essay.md', selection: { range: [3, 9] } });
  assert.match(brief, /^## This request comes from the file’s ask box \(Ctrl\+K\)/);
  assert.match(brief, /editing `\/p\/essay\.md`/);
  assert.match(brief, /selected lines 3–9: .* mean the selection/);
  assert.match(fileAskBrief({ path: '/p/a.md', selection: { range: [4, 4] } }), /selected text on line 4/);
  assert.match(brief, /edit tool: exact old text to new text/);
  assert.match(brief, /Stay in this file/);
  assert.match(brief, /one or two sentences/);
  assert.doesNotMatch(brief, /rat notebook|Recent changes|Earlier requests/, 'nothing optional without its facts');
  assert.match(fileAskBrief({ path: '/p/a.py', selection: { line: 12 } }), /cursor is on line 12/);
});

test('a notebook brief names the exact rat commands for its kernel', () => {
  const brief = fileAskBrief({ path: '/p/nb.md', notebook: { runtimes: ['py', 'sh'], header: true } });
  assert.match(brief, /`rat run --doc \/p\/nb\.md py '<code>'` \(this notebook’s runtimes: py, sh\)/);
  assert.match(brief, /`rat look --doc \/p\/nb\.md py`/);
  assert.match(brief, /Never write or edit one by hand/);
  assert.match(brief, /add it there, then run `rat ensure \/p\/nb\.md`\. Never `pip install`/);
  assert.match(fileAskBrief({ path: '/p/nb.md', notebook: { runtimes: [], header: false } }), /declare it in front matter .*`rat ensure \/p\/nb\.md`/);
});

test('recent edits come as diffs in a fence their text cannot close; earlier asks as one line each', () => {
  const diff = '@@ -1,1 +1,1 @@\n-```\n+````';
  const brief = fileAskBrief({
    path: '/p/a.md',
    edits: { since: 'last 24 h', items: [
      { ago: 180000, who: 'Maxime, in the editor', added: 1, removed: 1, diff, omitted: 2 },
      { ago: 3600000, who: 'an agent, in this conversation', added: 4, removed: 0, diff: null, omitted: 0 },
    ] },
    asks: [{ ago: 600000, prompt: 'shorter intro', where: 'in “Essay”', outcome: 'the agent changed +3 −8 lines' }],
  });
  assert.match(brief, /### Recent changes to this file \(last 24 h, newest first\)/);
  assert.match(brief, /- 3 min ago · Maxime, in the editor · \+1 −1 lines\n\n`````diff\n@@ -1,1 \+1,1 @@\n-```\n\+````\n`````\n\(2 more changed places not shown\)/);
  assert.match(brief, /- 1 h ago · an agent, in this conversation · \+4 −0 lines(\n|$)/);
  assert.match(brief, /- 10 min ago, in “Essay”: “shorter intro” → the agent changed \+3 −8 lines/);
  assert.equal(fenceFor('no ticks'), '```');
});

test('ago reads in the unit a person would say', () => {
  assert.deepEqual([40e3, 12 * 60e3, 3 * 3600e3, 3 * 86400e3].map(formatAgo), ['40 s', '12 min', '3 h', '3 d']);
});

test('the ask log keeps the recent asks per file, bounded, across restarts', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ask-log-')));
  try {
    const file = path.join(dir, 'asks.json');
    const log = new AskLog(file);
    for (let i = 0; i < 15; i++) log.record('/p/a.md', { ts: 1000 + i, prompt: 'ask ' + i + '\n  spaced', key: i % 2 ? 'k1' : 'k2' });
    log.record('/p/b.md', { ts: 5000, prompt: 'x'.repeat(1000), key: 'k1' });
    const again = new AskLog(file);
    const a = again.recent('/p/a.md');
    assert.equal(a.length, 12, 'at most twelve per file');
    assert.equal(a.at(-1).prompt, 'ask 14 spaced', 'whitespace collapsed');
    assert.deepEqual(again.recent('/p/a.md', { limit: 2, exceptKey: 'k2' }).map(x => x.ts), [1011, 1013]);
    assert.deepEqual(again.recent('/p/a.md', { since: 1013 }).map(x => x.ts), [1013, 1014]);
    assert.equal(again.recent('/p/b.md')[0].prompt.length, 600);
    assert.deepEqual(again.recent('/p/none.md'), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a selection inside lines rides along as its exact text', () => {
  const brief = fileAskBrief({ path: '/p/a.md', selection: { range: [2, 2], text: 'this `word`' } });
  assert.match(brief, /selected text on line 2: .*\n  The selection, exactly:\n\n```\nthis `word`\n```/);
});
