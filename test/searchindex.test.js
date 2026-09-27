'use strict';
// Tests for searchindex.js: schema, incremental updates, ranking, operators.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { openSearchIndex, SearchIndex, parseQuery, matchExpr, mdSections, mdKind } = require('../searchindex.js');

function tmpDb() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chattering-search-')));
  return path.join(dir, 'search.db');
}

const ENTRY = { mtimeMs: 111, size: 222, title: 'Fix the flux capacitor', source: 'pi', lastTs: '2026-08-20T10:00:00Z', project: 'chattering' };
const MSGS = [
  { role: 'user', text: 'the flux capacitor breaks on boot', ts: '2026-08-20T09:00:00Z' },
  { role: 'assistant', text: 'I will inspect the capacitor wiring now.', ts: '2026-08-20T09:01:00Z' },
  { role: 'tool', name: 'Bash', text: 'grep -r capacitor src/', ts: '2026-08-20T09:02:00Z', path: '/tmp/project/src/flux.js' },
  { role: 'toolresult', text: 'src/flux.js: capacitor overflow in charge()', ts: '2026-08-20T09:03:00Z' },
  { role: 'user', text: 'an offline branch idea about capacitors', ts: '2026-08-20T09:04:00Z', off: true },
];

test('query parsing: terms, phrases, operators', () => {
  const p = parseQuery('project:chattering role:user "exact phrase" flux capa');
  assert.deepStrictEqual(p.filters, { project: 'chattering', role: 'user' });
  assert.deepStrictEqual(p.phrases, ['exact phrase']);
  assert.deepStrictEqual(p.terms, ['flux', 'capa']);
  const m = matchExpr(p);
  assert.ok(m.includes('"exact phrase"'));
  assert.ok(m.includes('"capa"*'), 'last term prefix-matches while typing: ' + m);
  // A trailing space commits the last term: no prefix star.
  assert.ok(!matchExpr(parseQuery('flux capa ')).includes('*'));
});

test('markdown helpers: kinds and sections', () => {
  assert.strictEqual(mdKind('2026-01-01-thing.md'), 'note');
  assert.strictEqual(mdKind('epics/abc.md'), 'epic');
  assert.strictEqual(mdKind('projects/x/intent.md'), 'memory');
  const secs = mdSections('# Doc title\nintro text\n\n## Part two\nmore text');
  assert.strictEqual(secs.length, 2);
  assert.strictEqual(secs[0].heading, 'Doc title');
  assert.strictEqual(secs[1].heading, 'Part two');
});

test('index, search, rank, and group', () => {
  const idx = openSearchIndex(tmpDb());
  assert.ok(idx, 'node:sqlite with FTS5 must be available');
  assert.strictEqual(idx.putConversation('pi:a.jsonl', ENTRY, MSGS), true);
  // Same signature: a second put is a no-op.
  assert.strictEqual(idx.putConversation('pi:a.jsonl', ENTRY, MSGS), false);

  const out = idx.search('capacitor');
  assert.strictEqual(out.groups.length, 1);
  const g = out.groups[0];
  assert.strictEqual(g.kind, 'conversation');
  assert.strictEqual(g.key, 'pi:a.jsonl');
  assert.ok(g.matchCount >= 5, 'title + messages all match');
  // The title unit outranks tool output inside the group's passages.
  assert.strictEqual(g.matches[0].role, 'title');
  // Human text outranks tool results.
  const roles = g.matches.map(m => m.role);
  assert.ok(roles.indexOf('user') < roles.indexOf('toolresult') || !roles.includes('toolresult'));
  // Snippets carry the marker bytes around the matched word.
  assert.ok(g.matches[0].snippet.includes('\u0001'));
  idx.close();
});

test('AND semantics, phrases, and prefix', () => {
  const idx = openSearchIndex(tmpDb());
  idx.putConversation('pi:a.jsonl', ENTRY, MSGS);
  assert.strictEqual(idx.search('capacitor unicorn').total, 0, 'all words must match');
  assert.ok(idx.search('capacitor boot').total >= 1, 'words may span a unit');
  assert.strictEqual(idx.search('"wiring inspect"').total, 0, 'phrase order matters');
  assert.ok(idx.search('"inspect the capacitor wiring"').total >= 1);
  assert.ok(idx.search('capaci').total >= 1, 'the last term prefix-matches');
  idx.close();
});

test('operators filter: role, source, type, path, after', () => {
  const idx = openSearchIndex(tmpDb());
  idx.putConversation('pi:a.jsonl', ENTRY, MSGS);
  idx.putMarkdown('2026-08-20-capacitor-note.md', '# Capacitor findings\nthe capacitor was the problem', { mtimeMs: Date.parse('2026-08-21T00:00:00Z'), size: 10 });
  assert.ok(idx.search('capacitor role:user').groups[0].matches.every(m => m.role === 'user'));
  assert.strictEqual(idx.search('capacitor source:claude').total, 0);
  const notesOnly = idx.search('capacitor type:note');
  assert.strictEqual(notesOnly.groups.length, 1);
  assert.strictEqual(notesOnly.groups[0].kind, 'note');
  assert.strictEqual(notesOnly.groups[0].file, '2026-08-20-capacitor-note.md');
  assert.ok(idx.search('capacitor path:flux.js').total >= 1);
  assert.strictEqual(idx.search('capacitor after:2026-08-21').groups.filter(g => g.kind === 'conversation').length, 0);
  idx.close();
});

test('off-path messages carry their flag', () => {
  const idx = openSearchIndex(tmpDb());
  idx.putConversation('pi:a.jsonl', ENTRY, MSGS);
  const g = idx.search('offline branch idea role:user').groups[0];
  assert.strictEqual(g.matches[0].off, true);
  idx.close();
});

test('incremental update replaces and remove deletes', () => {
  const idx = openSearchIndex(tmpDb());
  idx.putConversation('pi:a.jsonl', ENTRY, MSGS);
  const changed = { ...ENTRY, mtimeMs: 999, title: 'Replaced title about dinosaurs' };
  idx.putConversation('pi:a.jsonl', changed, [{ role: 'user', text: 'only dinosaurs now', ts: '2026-08-20T11:00:00Z' }]);
  assert.strictEqual(idx.search('capacitor').total, 0, 'old units are gone');
  assert.ok(idx.search('dinosaurs').total >= 1);
  idx.removeConversation('pi:a.jsonl');
  assert.strictEqual(idx.search('dinosaurs').total, 0);
  assert.strictEqual(idx.listSrcs('conv:').size, 0);
  idx.close();
});

test('markdown sections index and prune', () => {
  const idx = openSearchIndex(tmpDb());
  idx.putMarkdown('epics/abc.md', '# Epic story\n## Chapter\nthe zeppelin flies', { mtimeMs: 1, size: 2 });
  const g = idx.search('zeppelin').groups[0];
  assert.strictEqual(g.kind, 'epic');
  assert.ok(g.title.includes('Epic story'));
  idx.removeSrc('md:epics/abc.md');
  assert.strictEqual(idx.search('zeppelin').total, 0);
  idx.close();
});

test('a broken query never throws', () => {
  const idx = openSearchIndex(tmpDb());
  idx.putConversation('pi:a.jsonl', ENTRY, MSGS);
  const out = idx.search('"unclosed AND NOT (');
  assert.ok(Array.isArray(out.groups));
  idx.close();
});

test('boostProject raises the matching project', () => {
  const idx = openSearchIndex(tmpDb());
  idx.putConversation('pi:a.jsonl', ENTRY, MSGS);
  idx.putConversation('pi:b.jsonl', { ...ENTRY, project: 'other', title: 'capacitor talk elsewhere' }, MSGS);
  const boosted = idx.search('capacitor', { boostProject: 'other' });
  assert.strictEqual(boosted.groups[0].project, 'other');
  idx.close();
});

test('semantic units: listing, ids, and the push ledger', () => {
  const idx = openSearchIndex(tmpDb());
  idx.putConversation('pi:a.jsonl', ENTRY, MSGS);
  idx.putMarkdown('epics/abc.md', '# Epic\n## Part\nzeppelin text', { mtimeMs: 1, size: 2 });
  // Human text only: title + 3 user/assistant messages (tool rows skipped).
  const units = idx.listUnits('conv:pi:a.jsonl');
  assert.deepStrictEqual(units.map(u => u.id), [
    'conv:pi:a.jsonl|t', 'conv:pi:a.jsonl|m0', 'conv:pi:a.jsonl|m1', 'conv:pi:a.jsonl|m4',
  ]);
  assert.strictEqual(units[0].meta.kind, 'title');
  assert.ok(units[1].meta.snip.includes('flux capacitor'));
  assert.strictEqual(units[3].meta.off, true);
  const mdUnits = idx.listUnits('md:epics/abc.md');
  assert.deepStrictEqual(mdUnits.map(u => u.id), ['md:epics/abc.md|s0', 'md:epics/abc.md|s1']);
  // Ledger: everything pending, then marked, then dropped on source removal.
  let p = idx.semanticPending();
  assert.strictEqual(p.push.length, 2);
  assert.strictEqual(p.drop.length, 0);
  for (const { src, sig } of p.push) idx.semanticMark(src, sig);
  p = idx.semanticPending();
  assert.strictEqual(p.push.length, 0);
  // A changed conversation becomes pending again.
  idx.putConversation('pi:a.jsonl', { ...ENTRY, mtimeMs: 777 }, MSGS);
  assert.strictEqual(idx.semanticPending().push.length, 1);
  // A vanished source appears in drop.
  idx.removeConversation('pi:a.jsonl');
  assert.deepStrictEqual(idx.semanticPending().drop, ['conv:pi:a.jsonl']);
  idx.semanticDrop('conv:pi:a.jsonl');
  assert.strictEqual(idx.semanticPending().drop.length, 0);
  idx.close();
});

test('kindCounts summarize groups by kind', () => {
  const idx = openSearchIndex(tmpDb());
  idx.putConversation('pi:a.jsonl', ENTRY, MSGS);
  idx.putMarkdown('2026-08-20-note.md', '# Note\ncapacitor note text', { mtimeMs: 1, size: 2 });
  idx.putMarkdown('epics/e.md', '# Epic\ncapacitor epic text', { mtimeMs: 1, size: 2 });
  const out = idx.search('capacitor');
  assert.strictEqual(out.kindCounts.conversation, 1);
  assert.strictEqual(out.kindCounts.note, 1);
  assert.strictEqual(out.kindCounts.epic, 1);
  idx.close();
});

test('setProject re-attributes units after a project fold', () => {
  const idx = openSearchIndex(tmpDb());
  if (!idx) return;
  idx.putConversation('pi:one', ENTRY, MSGS);
  assert.strictEqual(idx.search('capacitor project:chattering').total > 0, true);
  const changed = idx.setProject('conv:pi:one', 'merged');
  assert.ok(changed > 0);
  assert.strictEqual(idx.search('capacitor project:chattering').total, 0);
  assert.ok(idx.search('capacitor project:merged').total > 0);
  // Same value again: nothing to do.
  assert.strictEqual(idx.setProject('conv:pi:one', 'merged'), 0);
  idx.close();
});
