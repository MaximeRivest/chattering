'use strict';
// The guard of design/106 (scripts/disk-ratchet.js): every place where the
// hub's own process touches files or starts programs directly is counted,
// and the count of each place may only go down. New work on someone's files
// goes through an actor, so it runs with the right account's rights.
//
// The first tests check the guard itself: a guard that quietly counts
// nothing is worse than none.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ratchet = require('../scripts/disk-ratchet.js');

const whats = (text, file = 'x.js') => ratchet.analyzeFile(file, text).touches.map(t => t.what);

test('the guard sees every way of touching files and starting programs', () => {
  assert.deepEqual(whats(`
    const fs = require('fs'); const fsp = fs.promises; const nfs = require('node:fs/promises');
    const { readFileSync, promises: p2, constants } = require('node:fs');
    const cp = require('child_process'); const { spawn, execFile: run } = require('node:child_process');
    function a() { fs.readFileSync('x'); fsp.stat('x'); nfs.readdir('x'); readFileSync('x'); p2.open('x'); }
    function b() { cp.execFile('git'); spawn('rat'); run('ls'); require('fs').existsSync('y'); require('fs').promises.rm('y'); }
    function c() { return ['a'].filter(fs.existsSync); }
  `), ['fs.readFileSync', 'fsp.stat', 'nfs.readdir', 'readFileSync', 'p2.open', 'cp.execFile', 'spawn', 'run',
    "require('fs').existsSync", "require('fs').promises.rm", 'fs.existsSync']);
});

test('what is not a touch is not counted', () => {
  assert.deepEqual(whats(`
    const fs = require('fs'); const cp = require('child_process');
    // fs.readFileSync in a comment
    const s = 'fs.writeFileSync in a string';
    function a() { return fs.constants.R_OK + (x instanceof fs.Stats) + cp.ChildProcess; }
    const other = { readFileSync: 1 }; other.readFileSync;
  `), []);
});

test('a place is the module, the innermost named function, and the route around it', () => {
  const keys = ratchet.analyzeFile('server.js', `
    const fs = require('fs');
    async function handleRequest(req, res, u) {
      if (u.pathname === '/api/one' && req.method === 'POST') { fs.readFileSync('a'); }
      else if (u.pathname.startsWith('/api/two/')) { [1].map(() => fs.statSync('b')); }
      const save = () => writeFileAtomic('c', 'd');
    }
    async function writeFileAtomic(p, d) { await fs.promises.writeFile(p, d); }
    const later = () => execText('git', []);
  `).touches.map(t => t.key);
  assert.deepEqual(keys, ['server.js › handleRequest › /api/one', 'server.js › handleRequest › /api/two/',
    'server.js › save', 'server.js › writeFileAtomic', 'server.js › later']);
});

test('the hub\u2019s own records are marked with a reason, and only with one', () => {
  const r = ratchet.analyzeFile('x.js', `
    const fs = require('fs');
    function a() {
      // hub-own: the conversation index cache
      fs.readFileSync('index.json');
      fs.readFileSync('someone-else');
    }
    // hub-own: settings, this install's own file
    function b() { fs.readFileSync('s'); fs.writeFileSync('s', ''); }
    function c() {
      // hub-own: x
      fs.readFileSync('no reason given');
    }
  `);
  assert.deepEqual(r.marked.map(m => m.code), ["fs.readFileSync('index.json');", "function b() { fs.readFileSync('s'); fs.writeFileSync('s', ''); }", "function b() { fs.readFileSync('s'); fs.writeFileSync('s', ''); }"]);
  assert.deepEqual(r.touches.map(t => t.code), ["fs.readFileSync('someone-else');", "fs.readFileSync('no reason given');"]);
  assert.equal(r.badMarks.length, 1, 'a mark without a reason is reported, and counts for nothing');
});

test('the baseline may only go down: more is refused, fewer must be locked in', () => {
  const { grew, shrank } = ratchet.compare({ 'a › f': 2, 'b › new': 1, 'c › g': 1 }, { 'a › f': 1, 'c › g': 3, 'd › gone': 1 });
  assert.deepEqual(grew, [{ key: 'a › f', was: 1, now: 2 }, { key: 'b › new', was: 0, now: 1 }]);
  assert.deepEqual(shrank, [{ key: 'c › g', was: 3, now: 1 }, { key: 'd › gone', was: 1, now: 0 }]);
});

test('the hub reads no one\u2019s files in a new place (design/106)', () => {
  const r = ratchet.analyze();
  // The guard looks where it must, and only there.
  for (const f of ['server.js', 'account-files.js', 'preview.js', 'step-changes.js']) assert.ok(r.files.includes(f), f + ' is one of the hub\u2019s modules');
  for (const f of ['person-ops.js', 'account-host.js']) assert.ok(!r.files.includes(f), f + ' runs as the person: not counted');
  assert.ok(Object.keys(r.counts).length > 100, 'the guard sees the hub\u2019s touches');
  assert.deepEqual(r.badMarks, [], 'every hub-own mark says why');
  const { grew, shrank } = ratchet.compare(r.counts);
  const where = grew.map(g => `${g.key}: ${g.was} → ${g.now}\n` + r.touches.filter(t => t.key === g.key).map(t => `    ${t.file}:${t.line}  ${t.code}`).join('\n')).join('\n');
  assert.deepEqual(grew.map(g => g.key), [], `New direct touches of files or programs in the hub:\n${where}\n\n${ratchet.ADVICE}\n\nOnly if neither fits: node scripts/disk-ratchet.js --accept, and say why in the commit.`);
  assert.deepEqual(shrank.map(s => s.key), [], 'Fewer touches than the baseline: well done. Lock it in: node scripts/disk-ratchet.js --update');
});
