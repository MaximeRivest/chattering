'use strict';
// design/110: the context finder's pieces that need no server: depths'
// text, a draft's words, the summaries' store, the search's snippets, and
// the search worker (its repair of a damaged index above all).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cf = require('../context-finder.js');
const { openSearchIndex, makeSnippet, snippetWords, parseQuery, matchExpr, searchDb } = require('../searchindex.js');
const { createSearchService } = require('../search-service.js');

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-finder-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const estimate = s => Math.ceil(Buffer.byteLength(String(s)) / 2);

test('a draft\u2019s words: no common words, the longer first, no duplicates', () => {
  const w = cf.draftKeywords('Now build phase 0 from the study, starting with the index repair and the search.db repair');
  assert.ok(w.includes('search.db') && w.includes('repair') && w.includes('index'));
  for (const common of ['now', 'the', 'from', 'with', '0']) assert.ok(!w.includes(common), common);
  assert.equal(w.filter(x => x === 'repair').length, 1);
  assert.ok(w.indexOf('search.db') < w.indexOf('index'), 'longer words first');
});

test('a conversation\u2019s messages: user and assistant text on the active path, setup left out, places kept', () => {
  const msgs = [{ role: 'user', text: 'BOOT' }, { role: 'user', text: 'fix it' }, { role: 'tool', text: 'ls' }, { role: 'assistant', text: 'done' }, { role: 'assistant', text: 'old', off: true }, { role: 'assistant', text: '  ' }];
  const list = cf.chatMessages(msgs, { isBootstrap: t => t === 'BOOT' });
  assert.deepEqual(list.map(m => [m.i, m.role, m.text]), [[1, 'user', 'fix it'], [3, 'assistant', 'done']]);
});

test('too large: the beginning (a quarter) and the end, the middle marked as left out', () => {
  const list = Array.from({ length: 40 }, (_, i) => ({ i, role: i % 2 ? 'assistant' : 'user', text: 'x'.repeat(200) }));
  const { kept, omitted } = cf.headAndTail(list, 1000, estimate);
  assert.ok(omitted > 0);
  const cut = kept.findIndex(m => m.omitted);
  assert.ok(cut > 0 && cut < kept.length - 1, 'the marker sits between head and tail');
  assert.equal(kept[0].i, 0); assert.equal(kept.at(-1).i, 39);
  assert.equal(kept.filter(m => !m.omitted).length + omitted, 40);
  assert.deepEqual(cf.headAndTail(list.slice(0, 3), 1000, estimate).omitted, 0);
});

test('links say what a source is and how to read it, without its text', () => {
  const t = cf.chatLinkText({ title: 'Frog memory', id: '01a14a81', project: 'chattering', firstTs: '2026-10-17T10:00:00Z', lastTs: '2026-10-18T10:00:00Z', count: 349, gist: 'make the frog remember' });
  assert.match(t, /chattering show 01a14a81/); assert.match(t, /349 messages/); assert.match(t, /2026-10-17 → 2026-10-18/);
  const d = cf.docLinkText({ label: 'chattering · intent', file: '/n/intent.md', tokens: 296500, updatedAt: '2026-10-30T00:00:00Z', outline: cf.outlineOf('# A\n## B\ntext\n### C'), command: 'chattering memory chattering intent' });
  assert.match(d, /296,500 tokens/); assert.match(d, /- A\n.*- B\n.*- C/s); assert.match(d, /chattering memory chattering intent/);
});

test('summaries are kept per version, the newest few', t => {
  const store = cf.createSummaryStore(tmp(t), { keep: 2 });
  assert.equal(store.latest('k'), null);
  store.put('k', '1:10', { text: 'one', at: 1 });
  store.put('k', '2:20', { text: 'two', at: 2 });
  store.put('k', '3:30', { text: 'three', at: 3 });
  assert.equal(store.get('k', '1:10'), null, 'the oldest went');
  assert.equal(store.get('k', '2:20').text, 'two');
  assert.equal(store.latest('k').v, '3:30');
  assert.equal(cf.versionOf({ mtimeMs: 12.6, size: 40 }), '13:40');
});

test('snippets: around the first match, every match marked, accents and case folded', () => {
  const words = snippetWords(parseQuery('energie repair'));
  const s = makeSnippet('Some long preamble '.repeat(20) + 'then the Énergie module needs a REPAIR soon, and more repair later.', words);
  assert.match(s, /^ … /);
  assert.match(s, /\u0001Énergie\u0002/); assert.match(s, /\u0001REPAIR\u0002/); assert.match(s, /\u0001repair\u0002/);
  // A word being typed matches as a beginning from three letters only.
  assert.match(matchExpr(parseQuery('rep')), /"rep"\*/);
  assert.doesNotMatch(matchExpr(parseQuery('re')), /\*/);
  assert.equal(matchExpr(parseQuery('alpha beta'), { any: true }), '"alpha" OR "beta"');
});

function fill(db, n = 50) {
  for (let k = 0; k < n; k++) {
    db.putConversation('k' + k, { mtimeMs: k, size: k, title: 'conversation ' + k, project: k % 2 ? 'odd' : 'even', lastTs: '2026-10-0' + (1 + k % 9) + 'T00:00:00Z' },
      [{ role: 'user', text: 'please repair the index number ' + k }, { role: 'assistant', text: 'repaired index ' + k + ' with zebra' }, { role: 'toolresult', text: 'zebra zebra zebra' }]);
  }
}

test('the finder\u2019s search: kinds, roles, a project\u2019s memory folder, excluded keys, OR for a draft', t => {
  const dir = tmp(t);
  const db = openSearchIndex(path.join(dir, 's.db'));
  t.after(() => db.close());
  fill(db, 6);
  db.putMarkdown('projects/odd-12345678/intent.md', '# Odd intent\n\n## Zebra section\n\nzebra matters here', { mtimeMs: 1, size: 1 });
  db.putMarkdown('projects/even-87654321/intent.md', '# Even intent\n\nzebra too', { mtimeMs: 1, size: 1 });
  // Tool output is not context: only user and assistant messages match.
  const r1 = searchDb(db.db, 'zebra', { kinds: ['title', 'message'], roles: ['user', 'assistant'], limit: 50 });
  assert.equal(r1.groups.length, 6);
  assert.ok(r1.groups.every(g => g.matches.every(m => m.role === 'assistant')));
  // A project filter keeps its conversations and its memory documents.
  const r2 = searchDb(db.db, 'zebra project:odd', { kinds: ['title', 'message', 'memory'], roles: ['user', 'assistant'], memoryDir: 'projects/odd-12345678/', exclude: ['k1'] });
  assert.deepEqual(r2.groups.map(g => g.key || g.file).sort(), ['k3', 'k5', 'projects/odd-12345678/intent.md']);
  assert.equal(r2.groups.find(g => g.file).matches[0].title, 'Odd intent › Zebra section');
  // OR: a draft's words need not all be in one passage.
  const r3 = searchDb(db.db, '"quokka" "zebra"', { any: true, kinds: ['memory'] });
  assert.equal(r3.groups.length, 2);
  assert.equal(r3.totalCapped, false);
});

test('the search worker answers off the main thread, and repairs a damaged index without losing a write', async t => {
  const dir = tmp(t), file = path.join(dir, 's.db');
  const writer = openSearchIndex(file);
  fill(writer, 40);
  // Damage the full-text index the way a copy mid-write does: rows the
  // index holds but the table no longer has.
  writer.db.exec("DELETE FROM units WHERE id IN (SELECT id FROM units ORDER BY id LIMIT 30)");
  const log = [];
  const svc = createSearchService({ dbPath: file, writer, log: m => log.push(m) });
  t.after(() => { svc.close(); writer.close(); });
  const checked = await svc.check();
  assert.equal(checked.ok, false);
  assert.ok(svc.state().repairing || svc.state().lastRepair, 'a repair started');
  // While it runs, a search says so at once, and a write waits for it.
  const during = await svc.search('zebra', {});
  if (svc.state().repairing) assert.match(during.error, /being repaired/);
  writer.putMarkdown('notes/late.md', '# Late\n\nquokka arrives during the repair', { mtimeMs: 5, size: 5 });
  for (let i = 0; i < 400 && svc.state().repairing; i++) await new Promise(r => setTimeout(r, 25));
  assert.equal(svc.state().repairing, null);
  assert.equal(svc.state().lastRepair.ok, true, log.join('\n'));
  const r = await svc.search('quokka', {});
  assert.equal(r.groups.length, 1, 'the write made during the repair was applied');
  const z = await svc.search('repaired index', { limit: 100 });
  assert.ok(z.groups.length >= 30 && z.groups.length <= 40);
  assert.ok(typeof z.tookMs === 'number');
  assert.equal((await svc.check()).ok, true, 'sound afterwards');
  const sizes = await svc.sizes(['conv:k39']);
  assert.ok(sizes['conv:k39'].units === 2 && sizes['conv:k39'].chars > 20, JSON.stringify(sizes));
});

test('a newer search of the same person replaces one still waiting', async t => {
  const dir = tmp(t), file = path.join(dir, 's.db');
  const writer = openSearchIndex(file);
  fill(writer, 5);
  const svc = createSearchService({ dbPath: file, writer, log: () => {} });
  t.after(() => { svc.close(); writer.close(); });
  const [a, b, c] = await Promise.all(['repair', 'repaired', 'zebra'].map(q => svc.search(q, {}, { channel: 'me' })));
  assert.ok([a, b].some(x => x.superseded), 'an older one was dropped');
  assert.ok(c.groups.length > 0, 'the newest ran');
});
