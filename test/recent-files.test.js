'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const R = require('../recent-files');
const row = (path, actor, at, project = 'one', kind = actor === 'human' ? 'opened' : 'edited') => ({ path, actor, at, project, kind });

test('legacy human-only history migrates without inventing new timestamps', () => {
  const s = R.normalize({ files: [{ path: '/one/a', at: 10, project: 'one', kind: 'saved' }] });
  assert.equal(s.version, 2);
  assert.equal(s.files[0].actor, 'human'); assert.equal(s.files[0].at, 10);
  assert.equal(s.files[0].kind, 'saved');
  assert.deepEqual(R.normalize([{ path: 'relative', at: 10 }, { path: '/bad', at: -1 }]).files, []);
});

test('filter actor and project before deduplication; newest matching activity wins', () => {
  const s = R.normalize(null);
  R.merge(s, [row('/one/a', 'human', 10), row('/one/a', 'agent', 30), row('/one/b', 'human', 20), row('/two/c', 'agent', 40, 'two')]);
  assert.deepEqual(R.select(s.files, { actor: 'human' }).map(f => [f.path, f.at]), [['/one/b', 20], ['/one/a', 10]]);
  assert.deepEqual(R.select(s.files, { actor: 'agent', project: 'one' }).map(f => f.path), ['/one/a']);
  assert.deepEqual(R.select(s.files, { actor: 'both' }).map(f => f.path), ['/two/c', '/one/a', '/one/b']);
  assert.deepEqual(R.select(s.files, { actor: 'both', project: 'one' }).map(f => f.path), ['/one/a', '/one/b']);
  R.merge(s, [row('/one/a', 'human', 50, 'one', 'saved')]);
  assert.equal(R.select(s.files, { actor: 'both' })[0].actor, 'human');
  assert.equal(R.select(s.files, { actor: 'agent' }).find(f => f.path === '/one/a').at, 30);
});

test('revisits move a file to the top, and old transcript replays do not', () => {
  const s = R.normalize([row('/a', 'human', 100), row('/b', 'human', 110)]);
  R.merge(s, [row('/a', 'human', 120)]);
  assert.deepEqual(R.select(s.files).map(f => f.path), ['/a', '/b']);
  assert.equal(R.merge(s, [row('/a', 'human', 100)]), false);
  assert.equal(R.merge(s, [row('/a', 'human', 120)]), false);
});

test('forget is actor-aware and survives rescanning or restarting; new activity returns', () => {
  let s = R.normalize([row('/a', 'human', 100), row('/a', 'agent', 200)]);
  R.forget(s, '/a', 'agent', 300);
  s = R.normalize(JSON.parse(JSON.stringify(s)));
  assert.equal(R.select(s.files, { actor: 'human' }).length, 1);
  assert.equal(R.merge(s, [row('/a', 'agent', 200)]), false);
  assert.equal(R.select(s.files, { actor: 'agent' }).length, 0);
  R.merge(s, [row('/a', 'agent', 400)]);
  assert.equal(R.select(s.files, { actor: 'agent' }).length, 1);
  R.forget(s, '/a', 'both', 500);
  assert.deepEqual(s.files, []);
  assert.equal(R.merge(s, [row('/a', 'human', 100), row('/a', 'agent', 400)]), false);
});

test('retention is separate per project and actor; repeated old imports are no-ops', () => {
  const s = R.normalize([row('/rare/human', 'human', 1, 'rare'), row('/rare/agent', 'agent', 2, 'rare')]);
  const noisy = Array.from({ length: R.PER_PROJECT + 20 }, (_, i) => row('/busy/' + i, 'agent', i + 10, 'busy'));
  R.merge(s, noisy);
  assert.equal(R.select(s.files, { actor: 'both', project: 'rare' }).length, 2);
  assert.equal(s.files.filter(f => f.project === 'busy').length, R.PER_PROJECT);
  assert.equal(R.merge(s, noisy), false);
});

test('only confirmed named tool operations count, including empty successful results', () => {
  const messages = [];
  const add = (id, name, file, err, ts = '2026-01-01T00:00:00Z') => {
    messages.push({ role: 'tool', id, name, path: file, ts });
    if (err !== null) messages.push({ role: 'toolresult', tid: id, err, text: '', ts });
  };
  add('r', 'read', 'read.md', false);
  add('w', 'Write', '/work/new.md', false);
  add('e', 'functions.edit', 'edit.js', false);
  add('fail', 'edit', 'failed.js', true);
  add('pending', 'write', 'pending.js', null);
  add('shell', 'bash', 'not-proof.js', false);
  const out = R.fromMessages(messages, { key: 'pi:test', project: 'work', resolvePath: p => path.resolve('/work', p) });
  // Resolved as this system resolves (a drive letter on Windows).
  assert.deepEqual(out.map(f => [f.path, f.kind]), [[path.resolve('/work/read.md'), 'read'], [path.resolve('/work/new.md'), 'written'], [path.resolve('/work/edit.js'), 'edited']]);
  assert.ok(out.every(f => f.actor === 'agent' && f.key === 'pi:test' && f.at === Date.parse('2026-01-01T00:00:00Z')));
  assert.deepEqual(R.fromMessages(messages, { resolvePath: () => null }), []);
});

test('live deltas carry only changed paths and preserve unrelated human visits', () => {
  const state = R.normalize([row('/a', 'human', 100), row('/b', 'agent', 110)]);
  const before = state.files;
  R.merge(state, [row('/b', 'agent', 120), row('/c', 'agent', 130)]);
  const delta = R.diff(before, state.files);
  assert.equal(delta.upsert.length, 2);
  assert.deepEqual(delta.remove, []);
  assert.deepEqual(R.applyDelta(before, delta), state.files);
  const keep = state.files;
  R.forget(state, '/b', 'agent', 200);
  const removed = R.diff(keep, state.files);
  assert.deepEqual(removed.remove, [{ actor: 'agent', path: '/b' }]);
  assert.deepEqual(R.applyDelta(keep, removed), state.files);
});

test('timestamp order, not branch/file order, selects the last actual operation', () => {
  const messages = [
    { role: 'tool', id: 'new', name: 'write', path: '/a', ts: '2026-01-02' },
    { role: 'toolresult', tid: 'new', ts: '2026-01-02' },
    { role: 'tool', id: 'old', name: 'read', path: '/a', ts: '2026-01-01', off: true },
    { role: 'toolresult', tid: 'old', ts: '2026-01-01', off: true },
  ];
  assert.equal(R.fromMessages(messages, { resolvePath: p => p })[0].kind, 'written');
});
