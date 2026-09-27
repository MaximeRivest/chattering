'use strict';
// records.js: the agent-facing read API. A real FTS index, a fake server
// index, and a temp notes tree. Every op is checked for its text shape:
// short ids, follow-up commands, trust labels, bounds.
// Dates print in local time; the expectations below are written in UTC.
process.env.TZ = 'UTC';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { openSearchIndex } = require('../searchindex.js');
const R = require('../records.js');

const KEY_A = 'pi:--home-me-Projects-alpha--/2026-08-20T09-00-00-000Z_0a1b2c3d-1111-7000-8000-000000000001.jsonl';
const KEY_B = 'pi:--home-me-Projects-alpha--/2026-08-25T09-00-00-000Z_9f8e7d6c-2222-7000-8000-000000000002.jsonl';
const KEY_C = 'claude:-home-me-Projects-beta/5e5e5e5e-3333-4000-8000-000000000003.jsonl';
const SESSIONS_BASE = '/home/me/.pi/agent/sessions';

function build(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chattering-records-')));
  const notesDir = path.join(dir, 'notes');
  const sessDir = path.join(dir, 'sessions');
  fs.mkdirSync(path.join(notesDir, 'projects', 'alpha-1234'), { recursive: true });
  fs.mkdirSync(sessDir);
  const noteA = path.join(notesDir, '2026-08-20-flux-capacitor.md');
  fs.writeFileSync(noteA, '# Flux capacitor fix\n\n## Decision\nWe replaced the capacitor wiring.\n');
  const intent = path.join(notesDir, 'projects', 'alpha-1234', 'intent.md');
  fs.writeFileSync(intent, '# alpha — intent\n\nBuild a reliable flux capacitor.\n');
  const overview = path.join(notesDir, 'projects', 'alpha-1234', 'overview.md');
  fs.writeFileSync(overview, '# alpha — overview\n\nOne module, two tests.\n');

  const msgsA = [
    { role: 'user', text: 'the flux capacitor breaks on boot', ts: '2026-08-20T09:00:00Z' },
    { role: 'thinking', text: 'Let me look at the wiring.', ts: '2026-08-20T09:00:30Z' },
    { role: 'assistant', text: 'I will inspect the capacitor wiring now.', ts: '2026-08-20T09:01:00Z' },
    { role: 'tool', name: 'bash', text: 'grep -r capacitor src/', ts: '2026-08-20T09:02:00Z' },
    { role: 'toolresult', text: 'src/flux.js: capacitor overflow in charge()', ts: '2026-08-20T09:03:00Z' },
    { role: 'user', text: 'ok fix it and add a test', ts: '2026-08-20T09:04:00Z' },
    { role: 'assistant', text: 'Done. The wiring is replaced and the test passes. '.repeat(120), ts: '2026-08-20T09:10:00Z' },
  ];
  const msgsB = [
    { role: 'user', text: 'plan the deployment of the time circuits', ts: '2026-08-25T09:00:00Z' },
    { role: 'assistant', text: 'Deploy in three steps: stage, verify, switch.', ts: '2026-08-25T09:01:00Z' },
  ];
  const msgsC = [
    { role: 'user', text: 'write docs for beta', ts: '2026-08-26T09:00:00Z' },
    { role: 'assistant', text: 'Docs written. The capacitor page is new.', ts: '2026-08-26T09:01:00Z' },
  ];
  const entries = {
    [KEY_A]: { title: 'Fix the flux capacitor', timelineTitle: 'Fix the flux capacitor', source: 'pi', cwd: '/home/me/Projects/alpha',
      firstTs: '2026-08-20T09:00:00Z', lastTs: '2026-08-20T09:10:00Z', userCount: 2, realUserCount: 2, assistantCount: 2,
      notePath: noteA, notedAt: 2000, mtimeMs: 1000 },
    [KEY_B]: { title: 'Deploy time circuits', source: 'pi', cwd: '/home/me/Projects/alpha/deploy',
      firstTs: '2026-08-25T09:00:00Z', lastTs: '2026-08-25T09:01:00Z', userCount: 1, realUserCount: 1, assistantCount: 1 },
    [KEY_C]: { title: 'Beta docs', source: 'claude', cwd: '/home/me/Projects/beta',
      firstTs: '2026-08-26T09:00:00Z', lastTs: '2026-08-26T09:01:00Z', userCount: 1, realUserCount: 1, assistantCount: 1 },
  };
  const msgs = { [KEY_A]: msgsA, [KEY_B]: msgsB, [KEY_C]: msgsC };
  const cachePathFor = key => path.join(sessDir, key.replace(/[:\/\\]/g, '__') + '.json');
  for (const [k, e] of Object.entries(entries)) {
    fs.writeFileSync(cachePathFor(k), JSON.stringify({ key: k, ...e, messages: msgs[k] }));
  }
  const projectOf = cwd => cwd.includes('/alpha') ? 'alpha' : (cwd.includes('/beta') ? 'beta' : '?');
  const idx = openSearchIndex(path.join(dir, 'search.db'));
  assert.ok(idx, 'node:sqlite with FTS5 must be available');
  for (const [k, e] of Object.entries(entries)) idx.putConversation(k, { ...e, project: projectOf(e.cwd) }, msgs[k]);
  idx.putMarkdown('2026-08-20-flux-capacitor.md', fs.readFileSync(noteA, 'utf8'), fs.statSync(noteA));

  const epics = { ep1: { id: 'ep1', title: 'Capacitor saga', abstract: 'Two sessions on the capacitor.', updatedAt: Date.parse('2026-08-26'), notePath: path.join(notesDir, 'epics', 'ep1.md'), sessionIds: [KEY_A, KEY_B] } };
  const live = new Set();
  const semantic = { enabled: false, hits: [] };
  const records = R.createRecords({
    fsp,
    index: () => entries, epics: () => epics, cachePathFor,
    // As the server's: keys use / on every system (platform.toPortable).
    keyForSessionPath: p => { const rel = require('../platform.js').toPortable(path.relative(SESSIONS_BASE, p)); return entries['pi:' + rel] ? 'pi:' + rel : null; },
    projectNameOf: cwd => projectOf(cwd || ''),
    projectMetaFor: name => ['alpha', 'beta'].includes(name) ? { cwd: '/home/me/Projects/' + name, entries: Object.entries(entries).filter(([, e]) => projectOf(e.cwd) === name).map(([key, entry]) => ({ key, entry })), epics: [] } : null,
    projectMemoryIndex: () => [
      { name: 'alpha', title: null, cwd: '/home/me/Projects/alpha', conversations: 2, docs: { overview: true, intent: true, environment: false, status: false } },
      { name: 'beta', title: 'Beta docs', cwd: '/home/me/Projects/beta', conversations: 1, docs: { overview: false, intent: false, environment: false, status: false } },
    ],
    projectMemoryDocument: async (project, kind) => {
      if (project !== 'alpha') throw new Error('no');
      const p = path.join(notesDir, 'projects', 'alpha-1234', kind + '.md');
      return { project, kind, path: p, text: await fsp.readFile(p, 'utf8') };
    },
    areaMemoryDocument: async () => { throw new Error('none'); },
    epicMemoryDocument: async () => { throw new Error('none'); },
    declaredAreasFor: name => name === 'alpha' ? { deploy: {} } : {},
    trustLabel: p => p === intent ? '[vouched]' : '[unverified]',
    existingEvidenceFor: async data => data.key === KEY_A ? { text: 'Card: wiring replaced.', kind: 'card', source: 'cached-evidence-card', outdated: false } : null,
    searchIdx: () => idx,
    semanticEnabled: () => semantic.enabled,
    semFetch: async () => ({ hits: semantic.hits }),
    semNs: () => 'test',
    semanticGroups: hits => hits.map(h => ({ kind: 'conversation', key: h.key, title: null, project: 'alpha', score: h.score, matchCount: 1, semantic: true, matches: [{ i: 1, role: 'assistant', snippet: h.snip, semantic: true }] })),
    runningKeys: () => live,
    notesDir, port: 7433,
    now: () => Date.parse('2026-09-01T00:00:00Z'),
  });
  t.after(() => { idx.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { records, entries, live, semantic, notesDir, noteA, intent };
}

test('shortId: pi and claude file names', () => {
  assert.equal(R.shortId(KEY_A), '0a1b2c3d');
  assert.equal(R.shortId(KEY_C), '5e5e5e5e');
  assert.equal(R.shortId('pi:x/odd-name.jsonl'), 'odd-name');
});

test('sinceToIso: durations and dates', () => {
  const now = Date.parse('2026-09-01T00:00:00Z');
  assert.equal(R.sinceToIso('30d', now), '2026-08-02T00:00:00.000Z');
  assert.equal(R.sinceToIso('2w', now), '2026-08-18T00:00:00.000Z');
  assert.equal(R.sinceToIso('2026-08-01', now), '2026-08-01T00:00:00.000Z');
  assert.equal(R.sinceToIso('', now), null);
  assert.throws(() => R.sinceToIso('soon', now), /bad --since/);
});

test('bound cuts on a line and says how much is left', () => {
  const text = Array.from({ length: 50 }, (_, i) => 'line ' + i).join('\n');
  const out = R.bound(text, 100, 'Page.');
  assert.ok(out.length < text.length);
  assert.match(out, /\[output cut at 100 chars; \d+ more\] Page\.$/);
  assert.equal(R.bound('short', 100), 'short');
});

test('search: ranked hits with short ids, follow-up commands, notes and filters', async t => {
  const { records, live } = build(t);
  const out = await records.run('search', { q: 'capacitor', dir: '/home/me/Projects/alpha' });
  assert.match(out.text, /^search "capacitor" · \d+ passages in 3 records · lexical/);
  assert.match(out.text, /\[conversation\] alpha · 2026-08-20 · Fix the flux capacitor · id 0a1b2c3d/);
  assert.match(out.text, /→ chattering show 0a1b2c3d --at \d/);
  assert.match(out.text, /note: .*flux-capacitor\.md \[unverified\] → chattering note 0a1b2c3d/);
  assert.match(out.text, /\[note\] .*Flux capacitor fix \[unverified\]/);
  assert.match(out.text, /→ chattering note '2026-08-20-flux-capacitor\.md'/);
  assert.ok(out.text.includes('«capacitor»'), 'matched words are marked');
  assert.ok(!out.text.includes('\u0001'), 'no raw marker bytes');

  // The project boost puts alpha first; a project filter drops beta entirely.
  const alpha = await records.run('search', { q: 'capacitor', project: 'alpha' });
  assert.ok(!alpha.text.includes('5e5e5e5e'), 'beta conversation filtered out');
  assert.match(alpha.text, /in alpha ·/);

  // Roles, since, exclusion, paging.
  const users = await records.run('search', { q: 'capacitor', role: 'user' });
  assert.ok(!users.text.includes('#2 assistant'));
  const recent = await records.run('search', { q: 'capacitor', since: '4d' });
  assert.match(recent.text, /since 2026-08-28/);
  assert.ok(!recent.text.includes('[conversation]'), 'old conversations drop out; the freshly written note stays');
  const excl = await records.run('search', { q: 'capacitor', exclude: '0a1b2c3d' });
  assert.ok(!excl.text.includes('id 0a1b2c3d'));
  const byPath = await records.run('search', { q: 'capacitor', excludePath: SESSIONS_BASE + '/' + KEY_A.slice(3) });
  assert.ok(!byPath.text.includes('id 0a1b2c3d'), 'a session file path excludes its own conversation');
  const page = await records.run('search', { q: 'capacitor', limit: 1 });
  assert.match(page.text, /more records → chattering search 'capacitor' --offset 1/);
  const page2 = await records.run('search', { q: 'capacitor', limit: 1, offset: 1 });
  assert.ok(page2.groups.length === 1 && page2.groups[0] !== page.groups[0]);

  // A live agent on a conversation is marked.
  live.add(KEY_A);
  const withLive = await records.run('search', { q: 'capacitor' });
  assert.match(withLive.text, /id 0a1b2c3d · LIVE/);
  live.clear();

  // The last word prefix-matches by default (no stemming in the index);
  // prefix=false asks for whole words only.
  const prefix = await records.run('search', { q: 'capaci' });
  assert.ok(prefix.groups.length > 0);
  const whole = await records.run('search', { q: 'capaci', prefix: 'false' });
  assert.match(whole.text, /No results/);

  await assert.rejects(records.run('search', { q: 'x' }), /at least 2 characters/);
});

test('search: semantic hits ride after lexical hits and are marked', async t => {
  const { records, semantic } = build(t);
  semantic.enabled = true;
  semantic.hits = [{ key: KEY_B, score: 0.9, snip: 'stage, verify, switch' }, { key: KEY_A, score: 0.8, snip: 'dup' }];
  const out = await records.run('search', { q: 'capacitor' });
  assert.match(out.text, /lexical \+ semantic/);
  assert.match(out.text, /Deploy time circuits · id 9f8e7d6c · ~semantic/);
  assert.equal(out.text.split('id 0a1b2c3d').length, 2, 'a semantic duplicate of a lexical hit is not repeated');
  const off = await records.run('search', { q: 'capacitor', semantic: 'false' });
  assert.match(off.text, /· lexical ·/);
  assert.ok(!off.text.includes('~semantic'));
});

test('show: outline, zoom, range, tail, roles, bounds, id resolution', async t => {
  const { records } = build(t);
  const outline = await records.run('show', { id: '0a1b2c3d' });
  assert.match(outline.text, /^Fix the flux capacitor\nid 0a1b2c3d · alpha · pi · 2026-08-20/);
  assert.match(outline.text, /7 messages: 2 user, 1 thinking, 2 assistant, 1 tool, 1 toolresult/);
  assert.match(outline.text, /note .*flux-capacitor\.md \[unverified\] → chattering note 0a1b2c3d/);
  assert.match(outline.text, /epics: Capacitor saga \(ep1\)/);
  assert.match(outline.text, /record: AI transcript/);
  assert.match(outline.text, /outline: 2 user turns/);
  assert.match(outline.text, /#0 \d\d:\d\d  the flux capacitor breaks on boot/);
  assert.match(outline.text, /#5 \d\d:\d\d  ok fix it and add a test/);
  assert.match(outline.text, /last assistant #6:/);

  const zoom = await records.run('show', { id: KEY_A, at: 3, context: 1 });
  assert.match(zoom.text, /messages #2–#4 of 0–6 \(all roles\)/);
  assert.match(zoom.text, /#3 \d\d:\d\d tool bash\ngrep -r capacitor src\//);
  assert.match(zoom.text, /#4 \d\d:\d\d result\nsrc\/flux\.js/);
  assert.match(zoom.text, /earlier: chattering show 0a1b2c3d --from 0 --to 1 --roles all\s+later: chattering show 0a1b2c3d --from 5 --to 6 --roles all/);

  const range = await records.run('show', { id: '0a1b2c3d', from: 0, to: 4 });
  assert.match(range.text, /user \+ assistant; add --roles all/);
  assert.ok(!range.text.includes('tool bash'), 'tools hidden without --roles all');
  const tail = await records.run('show', { id: '0a1b2c3d', last: 1 });
  assert.match(tail.text, /messages #6–#6/);

  const tight = await records.run('show', { id: '0a1b2c3d', last: 1, max: 700 });
  assert.match(tight.text, /\[output cut at 700 chars; \d+ more\] Narrow with/);

  // Path, substring, ambiguity, miss.
  const byPath = await records.run('show', { id: SESSIONS_BASE + '/' + KEY_A.slice(3) });
  assert.equal(byPath.key, KEY_A);
  const bySub = await records.run('show', { id: '000000000002' });
  assert.equal(bySub.key, KEY_B);
  await assert.rejects(records.run('show', { id: 'Projects-alpha' }), /matches 2 conversations[\s\S]*9f8e7d6c[\s\S]*0a1b2c3d/);
  await assert.rejects(records.run('show', { id: 'nothing-here' }), /no conversation matches/);
});

test('conversations, projects, notes, note, epics, epic, evidence, here', async t => {
  const { records, noteA, intent } = build(t);
  const convs = await records.run('conversations', { dir: '/home/me/Projects/alpha' });
  assert.match(convs.text, /^conversations · alpha · 2 total, newest 2/);
  assert.match(convs.text, /9f8e7d6c  2026-08-25 \d\d:\d\d  Deploy time circuits  \(1 user turns\)/);
  assert.match(convs.text, /0a1b2c3d .* \(2 user turns · note\)/);
  const all = await records.run('conversations', { dir: '/tmp/nowhere' });
  assert.match(all.text, /all projects · 3 total/);
  const paged = await records.run('conversations', { limit: 1 });
  assert.match(paged.text, /2 more → chattering conversations --limit 2/);
  const since = await records.run('conversations', { since: '2026-08-26' });
  assert.match(since.text, /1 total/);

  const projects = await records.run('projects', { dir: '/home/me/Projects/beta' });
  assert.match(projects.text, /^projects · 2 · this folder → beta/);
  assert.match(projects.text, /alpha  2 conversations  memory: overview intent  \/home\/me\/Projects\/alpha/);
  assert.match(projects.text, /beta — Beta docs  1 conversations  memory: none/);

  const notes = await records.run('notes', {});
  assert.match(notes.text, /distilled notes · all projects · 1/);
  assert.match(notes.text, /0a1b2c3d  2026-08-20  Fix the flux capacitor  \[unverified\]  alpha\n    .*flux-capacitor\.md/);

  const note = await records.run('note', { id: '0a1b2c3d' });
  assert.match(note.text, new RegExp('^' + noteA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\[unverified\\]\ndistilled from 0a1b2c3d'));
  assert.match(note.text, /We replaced the capacitor wiring/);
  const byFile = await records.run('note', { id: '2026-08-20-flux-capacitor.md' });
  assert.equal(byFile.file, noteA);
  await assert.rejects(records.run('note', { id: '9f8e7d6c' }), /has no distilled note.*chattering show 9f8e7d6c/);
  await assert.rejects(records.run('note', { id: '/etc/passwd.md' }), /note files must live under/);
  await assert.rejects(records.run('note', { id: '../../etc/passwd.md' }), /note files must live under/);

  const epics = await records.run('epics', { project: 'alpha' });
  assert.match(epics.text, /epics · alpha · 1\n\nep1  2026-08-26  Capacitor saga  \(2 conversations\) \[unverified\]\n    Two sessions/);
  const epic = await records.run('epic', { id: 'ep1' });
  assert.match(epic.text, /epic ep1 · Capacitor saga/);
  assert.match(epic.text, /\n\nTwo sessions on the capacitor\.\n/, 'a missing epic note falls back to the abstract');
  assert.match(epic.text, /conversations \(2\):\n  0a1b2c3d/);
  assert.match(epic.text, /epic map: chattering memory --epic ep1/);

  const ev = await records.run('evidence', { id: '0a1b2c3d' });
  assert.match(ev.text, /cached-evidence-card · evidence card \(AI-written, unverified\)\n\nCard: wiring replaced\./);
  const noEv = await records.run('evidence', { id: '9f8e7d6c' });
  assert.match(noEv.text, /no evidence card or note yet .* chattering show 9f8e7d6c/);

  const here = await records.run('here', { dir: '/home/me/Projects/alpha' });
  assert.match(here.text, /^Deploy time circuits\nid 9f8e7d6c · alpha · 2 sessions under this folder/);
  assert.match(here.text, /user #0\nplan the deployment/);
  assert.match(here.text, /web http:\/\/localhost:7433\/#pi%3A/);
  const nowhere = await records.run('here', { dir: '/nowhere' });
  assert.match(nowhere.text, /No sessions found/);

  const mem = await records.run('memory', { project: 'alpha' });
  assert.match(mem.text, /^project memory · alpha\nareas: deploy \(add --area REL/);
  assert.match(mem.text, new RegExp('## intent · .*intent\\.md \\[vouched\\]'));
  assert.match(mem.text, /## overview · .* \[unverified\]/);
  assert.ok(!mem.text.includes('## status'), 'missing kinds are skipped');
  const one = await records.run('memory', { dir: '/home/me/Projects/alpha', kind: 'intent' });
  assert.ok(one.text.includes(intent) && !one.text.includes('## overview'));
  const none = await records.run('memory', { project: 'beta' });
  assert.match(none.text, /No memory documents yet \(1 conversations on record\)/);
  await assert.rejects(records.run('memory', { project: 'alpha', kind: 'plans' }), /unknown memory kind/);
  await assert.rejects(records.run('memory', { project: 'alpha', area: 'nope' }), /not a declared area of alpha \(areas: deploy\)/);
  await assert.rejects(records.run('memory', { dir: '/tmp/none' }), /no project given/);
  await assert.rejects(records.run('memory', { epic: 'zzz' }), /no epic "zzz"/);
});

test('help and unknown ops', async t => {
  const { records } = build(t);
  const help = await records.run('help');
  assert.match(help.text, /chattering search "<query>"/);
  await assert.rejects(records.run('nope', {}), /unknown records op "nope"\. Ops: help, search, show/);
});
