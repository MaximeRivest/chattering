'use strict';
// The server's list of files kept open (open-files-store.js, design/77).
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../open-files-store.js');
const policy = require('../policy.js');

test('keeping adds a file once, newest first, and never moves a kept one', () => {
  const s = S.createState();
  assert.equal(S.keep(s, { path: '/p/a.md', project: 'p' }, 1000), true);
  assert.equal(S.keep(s, { path: '/p/b.py', project: 'p' }, 1000), true, 'same millisecond: still after the newest');
  assert.deepEqual(s.files.map(f => f.path), ['/p/b.py', '/p/a.md']);
  assert.ok(s.files[0].at > s.files[1].at);
  const rev = s.rev;
  assert.equal(S.keep(s, { path: '/p/a.md', project: 'p' }, 5000), false, 'kept already: nothing changes');
  assert.deepEqual(s.files.map(f => f.path), ['/p/b.py', '/p/a.md']);
  assert.equal(s.rev, rev);
});

test('a kept file learns its project once; relative paths and junk are refused', () => {
  const s = S.createState();
  S.keep(s, { path: '/x/n.md' }, 1000);
  assert.equal(S.keep(s, { path: '/x/n.md', project: 'x' }, 2000), true);
  assert.equal(s.files[0].project, 'x');
  assert.equal(S.keep(s, { path: '/x/n.md', project: 'y' }, 3000), false, 'a project is not replaced');
  for (const bad of [{ path: 'rel/a.md' }, { path: '' }, { path: '/a\0b' }, null, { path: 42 }]) assert.equal(S.keep(s, bad), false);
  assert.equal(S.keep(s, { path: 'C:\\Users\\a\\b.md' }, 4000), true, 'a Windows path is absolute');
});

test('close lets go; restore puts a file back in its own place, never in the future', () => {
  const s = S.createState();
  S.keep(s, { path: '/a' }, 1000); S.keep(s, { path: '/b' }, 2000); S.keep(s, { path: '/c' }, 3000);
  const b = s.files.find(f => f.path === '/b');
  assert.equal(S.close(s, '/b', 4000), true);
  assert.equal(S.close(s, '/b', 4000), false);
  assert.equal(S.restore(s, b, 5000), true);
  assert.deepEqual(s.files.map(f => f.path), ['/c', '/b', '/a']);
  assert.equal(S.restore(s, b, 5000), false, 'already there');
  assert.equal(S.restore(s, { path: '/later', at: 9e15 }, 6000), true);
  assert.equal(s.files[0].at, 6000);
});

test('the revision grows with every change, across a reload, with the clock', () => {
  const s = S.createState();
  S.keep(s, { path: '/a' }, 1000);
  const r1 = s.rev;
  S.close(s, '/a', 1000);
  assert.ok(s.rev > r1, 'two changes in one millisecond still order');
  const again = S.normalize(JSON.parse(JSON.stringify(s)));
  assert.equal(again.rev, s.rev);
  S.keep(again, { path: '/b' }, 500);
  assert.ok(again.rev > s.rev, 'a clock behind the saved revision does not go back');
});

test('a saved list is cleaned and capped', () => {
  const files = [{ path: '/dup', at: 5 }, { path: '/dup', at: 4 }, { path: 'rel', at: 3 }, { path: '/noat' }];
  for (let i = 0; i < S.MAX_FILES + 10; i++) files.push({ path: '/f' + i, at: 100 + i });
  const s = S.normalize({ files });
  assert.equal(s.files.length, S.MAX_FILES);
  assert.equal(s.files[0].path, '/f' + (S.MAX_FILES + 9), 'newest first');
  assert.ok(!s.files.some(f => f.path === 'rel' || f.path === '/noat'));
  assert.deepEqual(S.normalize(null), S.createState());
});

test('the list goes to the household only, and only files each person may see', () => {
  const ev = { type: 'open-files', rev: 7, files: [{ path: '/mine/a.md', at: 1 }, { path: '/theirs/b.md', at: 2 }] };
  const person = (member, sees) => ({ all: false, member, key: () => true, project: () => true, path: p => sees.some(s => p.startsWith(s)) });
  assert.equal(policy.eventView(ev, person(false, ['/mine'])), null, 'a guest gets none of it');
  assert.deepEqual(policy.eventView(ev, person(true, ['/mine'])), { type: 'open-files', rev: 7, files: [{ path: '/mine/a.md', at: 1 }] });
  assert.equal(policy.routeEntry('GET', '/api/open-files').level, 'member', 'a guest keeps their list in the browser');
  assert.equal(policy.routeEntry('POST', '/api/open-files').level, 'member');
});
