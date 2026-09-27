'use strict';
// Tests for fileledger.js: schema, dedupe window, session grouping, queries.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const L = require('../fileledger.js');

function tmpDb() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chattering-ledger-')));
  return path.join(dir, 'files.db');
}

const T0 = Date.parse('2026-09-01T10:00:00Z');
const MIN = 60000;
const FILE = path.resolve('/home/u/Projects/demo/src/app.js'); // resolved as the ledger stores it (a drive letter on Windows)
const DOC = '/home/u/Projects/demo/README.md';

const ai = (i, ts, extra = {}) => ({ id: 'ai:' + i, ts, path: FILE, project: 'demo', repo_root: '/home/u/Projects/demo', producer: 'ai-edit', actor: 'ai', outcome: 'applied', added: 3, removed: 1, chars: 120, conv_key: 'pi:one', ...extra });
const human = (i, ts, extra = {}) => ({ id: 'doc:' + i, ts, path: DOC, project: 'demo', repo_root: '/home/u/Projects/demo', producer: 'editor-save', actor: 'human', added: 1, removed: 0, chars: 30, input: 'keyboard', ...extra });

test('grouping: one AI session per conversation × file, gap sessions for humans, commits apart', () => {
  const events = [
    ai(1, T0), ai(2, T0 + 2 * MIN), ai(3, T0 + 90 * MIN), // same conversation, far apart: still one session
    ai(4, T0 + 5 * MIN, { conv_key: 'pi:two', id: 'ai:4' }),
    { id: 'git:abc', ts: T0 + 100 * MIN, path: FILE, producer: 'git-commit', actor: 'git', commit_hash: 'abc', added: 4, removed: 1 },
    human(1, T0), human(2, T0 + 3 * MIN), human(3, T0 + 30 * MIN),
  ].map(L.normalizeEvent);
  const { sessions, commits } = L.groupSessions(events);
  const aiOnes = sessions.filter(s => s.actor === 'ai');
  assert.strictEqual(aiOnes.length, 2);
  const one = aiOnes.find(s => s.convKey === 'pi:one');
  assert.strictEqual(one.n, 3);
  assert.strictEqual(one.start, T0);
  assert.strictEqual(one.end, T0 + 90 * MIN);
  assert.strictEqual(one.chars, 360);
  assert.strictEqual(one.approx, false);
  const humans = sessions.filter(s => s.actor === 'human');
  assert.strictEqual(humans.length, 2, 'a 27-minute gap splits a human session');
  assert.strictEqual(commits.length, 1);
  assert.strictEqual(commits[0].hash, 'abc');
  assert.ok(one.bins.length >= 1 && one.bins.reduce((a, b) => a + b, 0) === 360);
});

test('magnitude: chars when known, lines × 40 flagged approx otherwise', () => {
  assert.deepStrictEqual(L.magnitudeOf({ chars: 55 }), { value: 55, approx: false });
  assert.deepStrictEqual(L.magnitudeOf({ added: 2, removed: 1 }), { value: 120, approx: true });
  const { sessions } = L.groupSessions([L.normalizeEvent({ id: 'w:1', ts: T0, path: FILE, producer: 'watch', added: 2, removed: 0 })]);
  assert.strictEqual(sessions[0].actor, 'external');
  assert.strictEqual(sessions[0].approx, true);
});

test('failed attempts never add magnitude', () => {
  const { sessions } = L.groupSessions([L.normalizeEvent(ai(1, T0, { outcome: 'failed' })), L.normalizeEvent(ai(2, T0 + MIN))]);
  assert.strictEqual(sessions[0].chars, 120);
  assert.strictEqual(sessions[0].failed, 1);
  assert.strictEqual(sessions[0].n, 2);
});

test('fromDiffEvent maps a mined transcript event', () => {
  const row = L.fromDiffEvent({ id: 'h1', key: 'pi:k', path: FILE, ts: '2026-09-01T10:00:00Z', kind: 'edit', outcome: 'applied', oldText: 'ab', newText: 'abcd', callId: 'c1', stats: { oldChars: 2, newChars: 4, oldLines: 1, newLines: 1 } }, { repoRoot: '/r', project: 'demo' });
  assert.strictEqual(row.id, 'ai:h1');
  assert.strictEqual(row.producer, 'ai-edit');
  assert.strictEqual(row.chars, 6);
  assert.strictEqual(row.project, 'demo');
  const shell = L.fromDiffEvent({ id: 'h2', key: 'pi:k', path: FILE, ts: '2026-09-01T10:00:00Z', kind: 'shell', outcome: 'unknown', stats: {} });
  assert.strictEqual(shell.producer, 'ai-shell');
  assert.strictEqual(shell.outcome, 'attempted');
  assert.strictEqual(shell.chars, null);
});

test('ledger: dedupe window drops watcher echoes in both arrival orders', () => {
  const ledger = L.openFileLedger(tmpDb());
  if (!ledger) return; // no node:sqlite on this runtime
  // Explanation first, watcher echo second.
  ledger.put(ai(1, T0));
  assert.strictEqual(ledger.put({ id: 'w:1', ts: T0 + 800, path: FILE, producer: 'watch', added: 3, removed: 1 }), 0);
  // Watcher first, explanation later (transcript indexed after the write).
  ledger.put({ id: 'w:2', ts: T0 + 10 * MIN, path: FILE, producer: 'watch', added: 3, removed: 1 });
  ledger.put(ai(2, T0 + 10 * MIN - 500));
  const t = ledger.touched(FILE);
  assert.strictEqual(t.events, 2, 'two AI rows, no watch rows');
  assert.ok(t.sessions.every(s => s.actor === 'ai'));
  // A lone write far from any explanation stays, as external.
  ledger.put({ id: 'w:3', ts: T0 + 60 * MIN, path: FILE, producer: 'watch', added: 1, removed: 1 });
  assert.strictEqual(ledger.touched(FILE).sessions.some(s => s.actor === 'external'), true);
  ledger.close();
});

test('ledger: conversation versions are idempotent and stale rows go', () => {
  const ledger = L.openFileLedger(tmpDb());
  if (!ledger) return;
  ledger.putConversation('pi:one', 'v1', [ai(1, T0), ai(2, T0 + MIN)]);
  assert.strictEqual(ledger.conversationVersion('pi:one'), 'v1');
  ledger.putConversation('pi:one', 'v2', [ai(1, T0)]);
  assert.strictEqual(ledger.touched(FILE).events, 1);
  assert.strictEqual(ledger.conversationVersion('pi:one'), 'v2');
  ledger.dropConversation('pi:one');
  assert.strictEqual(ledger.touched(FILE).events, 0);
  ledger.close();
});

test('ledger: timeline groups by project, caps rows, filters by kind and actor', () => {
  const ledger = L.openFileLedger(tmpDb());
  if (!ledger) return;
  ledger.put([ai(1, T0), human(1, T0 + MIN), human(2, T0 + 2 * MIN),
    { id: 'git:x', ts: T0 + 3 * MIN, path: FILE, project: 'demo', producer: 'git-commit', actor: 'git', commit_hash: 'x', added: 1, removed: 0 },
    { id: 'ai:other', ts: T0, path: '/home/u/Projects/other/a.py', project: 'other', producer: 'ai-write', added: 10, removed: 0, chars: 400, conv_key: 'pi:o' },
  ]);
  const all = ledger.timeline({ from: T0 - MIN, to: T0 + 10 * MIN });
  assert.deepStrictEqual(all.projects.map(p => p.project), ['demo', 'other']);
  const demo = all.projects[0];
  assert.strictEqual(demo.rows.length, 2);
  const code = demo.rows.find(r => r.path === FILE);
  assert.strictEqual(code.kind, 'code');
  assert.strictEqual(code.commits.length, 1);
  assert.strictEqual(code.rel, 'src/app.js');
  const docs = ledger.timeline({ from: T0 - MIN, to: T0 + 10 * MIN, kind: 'docs' });
  assert.strictEqual(docs.projects[0].rows.length, 1);
  assert.strictEqual(docs.projects[0].rows[0].kind, 'docs');
  const capped = ledger.timeline({ from: T0 - MIN, to: T0 + 10 * MIN, project: 'demo', capPerProject: 1 });
  assert.strictEqual(capped.projects[0].rows.length, 1);
  assert.strictEqual(capped.projects[0].more, 1);
  const humansOnly = ledger.timeline({ from: T0 - MIN, to: T0 + 10 * MIN, actor: 'human' });
  assert.ok(humansOnly.projects.every(p => p.rows.every(r => r.sessions.every(s => s.actor === 'human'))));
  // Outside the window: nothing.
  assert.strictEqual(ledger.timeline({ from: T0 + 60 * MIN, to: T0 + 70 * MIN }).projects.length, 0);
  ledger.close();
});

test('ledger: activity badge, ridge, remap', () => {
  const ledger = L.openFileLedger(tmpDb());
  if (!ledger) return;
  ledger.put([human(1, T0), human(2, T0 + MIN, { outcome: 'failed' })]);
  const a = ledger.activitySince(DOC, T0 - 1);
  assert.strictEqual(a.events, 1);
  assert.deepStrictEqual(a.actors, ['human']);
  assert.strictEqual(ledger.activitySince(DOC, T0 + 5 * MIN), null);
  const ridge = ledger.projectRidge('demo');
  assert.strictEqual(ridge.items.length, 1);
  ledger.remapProject('demo', 'demo-main');
  assert.deepStrictEqual(ledger.projects(), ['demo-main']);
  ledger.close();
});
