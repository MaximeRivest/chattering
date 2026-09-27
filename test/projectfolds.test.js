'use strict';
// Tests for projectfolds.js: raw names, fold resolution, alias mutations,
// remote normalization, and fold suggestions.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  LOOSE_PROJECT, isLooseCwd, rawProjectOf, canonicalize, flattenMap, foldAlias, unfold,
  dismissKey, normalizeRemote, suggestPairs,
} = require('../projectfolds.js');

test('rawProjectOf: /Projects/ segment wins, else last part', () => {
  assert.strictEqual(rawProjectOf('/home/u/Projects/chattering'), 'chattering');
  assert.strictEqual(rawProjectOf('/home/u/Projects/chattering/sub/dir'), 'chattering');
  assert.strictEqual(rawProjectOf('/home/u/work/thing/'), 'thing');
  assert.strictEqual(rawProjectOf('C:\\Users\\u\\Projects\\win'), 'win');
  assert.strictEqual(rawProjectOf(''), LOOSE_PROJECT);
  assert.strictEqual(rawProjectOf(null), LOOSE_PROJECT);
});

test('rawProjectOf: /projects/ matches case-insensitively, like isLooseCwd', () => {
  assert.strictEqual(rawProjectOf('/home/u/projects/foo/sub'), 'foo');
  assert.strictEqual(rawProjectOf('/home/u/PROJECTS/foo'), 'foo');
  assert.strictEqual(isLooseCwd('/home/u/projects'), true);
});

test('isLooseCwd: general launch and temporary folders stay out of projects', () => {
  assert.strictEqual(isLooseCwd('/home/u'), true);
  assert.strictEqual(isLooseCwd('/home/u/Projects'), true);
  assert.strictEqual(isLooseCwd('/tmp/pi-run/session'), true);
  assert.strictEqual(isLooseCwd('C:\\Users\\u'), true);
  assert.strictEqual(isLooseCwd('C:\\Users\\u\\AppData\\Local\\Temp\\agent'), true);
  assert.strictEqual(isLooseCwd('/home/u/Projects/real'), false);
  assert.strictEqual(isLooseCwd('/home/u/work/real'), false);
});

test('isLooseCwd: the macOS scratch folder is temporary on every host, in both of its spellings', () => {
  // A conversation recorded on a Mac may be read on a Linux host whose
  // tmpdir is /tmp; the layout itself must be recognised, like AppData\Temp.
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = '/tmp';
  try {
    assert.strictEqual(isLooseCwd('/var/folders/ab/xyz_w9/T/pi-run'), true, 'the $TMPDIR spelling');
    assert.strictEqual(isLooseCwd('/private/var/folders/ab/xyz_w9/T/pi-run'), true, 'the resolved cwd spelling');
    assert.strictEqual(isLooseCwd('/private/var/folders/ab/xyz_w9/T'), true);
    assert.strictEqual(isLooseCwd('/var/folders/ab/xyz_w9/C/caches'), false, 'the sibling cache folder is not scratch');
    assert.strictEqual(isLooseCwd('/var/folders/ab/xyz_w9/Tools/real'), false);
    assert.strictEqual(isLooseCwd('/Users/u/Projects/real'), false);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
  }
});

test('isLooseCwd: the platform temporary directory is temporary wherever TMPDIR puts it', () => {
  const os = require('node:os');
  // The variable this system reads for its temp folder: TMPDIR on Unix,
  // TEMP and TMP on Windows.
  const vars = process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR'];
  const saved = vars.map(v => process.env[v]);
  const setTmp = value => { for (const v of vars) process.env[v] = value; };
  try {
    setTmp('/var/folders/ab/xyz/T');
    assert.strictEqual(isLooseCwd('/var/folders/ab/xyz/T/pi-run/session'), true, 'macOS scratch');
    assert.strictEqual(isLooseCwd('/var/folders/ab/xyz/T'), true);
    assert.strictEqual(isLooseCwd('/var/folders/ab/xyz/Tools/real'), false, 'a sibling that merely shares the prefix');
    setTmp('/home/u/.local/state/scratch/');
    assert.strictEqual(isLooseCwd('/home/u/.local/state/scratch/agent'), true, 'trailing slash ignored');
    assert.strictEqual(isLooseCwd('/home/u/work/real'), false);
    // A TMPDIR at or above the home folder must not make every project loose.
    setTmp(os.homedir());
    assert.strictEqual(isLooseCwd(os.homedir() + '/work/real'), false);
    setTmp('/');
    assert.strictEqual(isLooseCwd('/home/u/work/real'), false);
  } finally {
    vars.forEach((v, i) => { if (saved[i] === undefined) delete process.env[v]; else process.env[v] = saved[i]; });
  }
});

test('canonicalize: aliases beat auto, chains resolve, pins stop', () => {
  const auto = { 'foo-wt-x': 'foo' };
  assert.strictEqual(canonicalize('foo-wt-x', {}, auto), 'foo');
  assert.strictEqual(canonicalize('foo', {}, auto), 'foo');
  // A manual fold on top of an auto fold: wt → foo → bar.
  assert.strictEqual(canonicalize('foo-wt-x', { foo: 'bar' }, auto), 'bar');
  // A self-alias pins the name against the auto fold.
  assert.strictEqual(canonicalize('foo-wt-x', { 'foo-wt-x': 'foo-wt-x' }, auto), 'foo-wt-x');
  // A cycle must not loop forever.
  assert.ok(typeof canonicalize('a', { a: 'b', b: 'a' }, {}) === 'string');
});

test('flattenMap: only changed names appear', () => {
  const map = flattenMap(['x', 'wt', 'foo'], { foo: 'bar' }, { wt: 'foo' });
  assert.deepStrictEqual(map, { wt: 'bar', foo: 'bar' });
});

test('foldAlias: sets, re-points, un-redirects the target, flips cleanly', () => {
  const store = { aliases: { old: 'a' }, dismissed: [dismissKey('a', 'b')] };
  foldAlias(store, 'a', 'b');
  // old landed on a; it must follow into b. The dismissed pair clears.
  assert.deepStrictEqual(store.aliases, { old: 'b', a: 'b' });
  assert.deepStrictEqual(store.dismissed, []);
  // Flip: fold b back into a.
  foldAlias(store, 'b', 'a');
  assert.strictEqual(canonicalize('b', store.aliases, {}), 'a');
  assert.strictEqual(canonicalize('old', store.aliases, {}), 'a');
  assert.throws(() => foldAlias(store, 'x', 'x'));
  assert.throws(() => foldAlias(store, '', 'y'));
});

test('unfold: drops the alias; pins when an auto fold still applies', () => {
  const store = { aliases: { wt: 'foo', other: 'foo' }, dismissed: [] };
  unfold(store, 'other', {});
  assert.strictEqual(store.aliases.other, undefined);
  unfold(store, 'wt', { wt: 'foo' });
  assert.strictEqual(store.aliases.wt, 'wt'); // pinned: stays its own project
  assert.strictEqual(canonicalize('wt', store.aliases, { wt: 'foo' }), 'wt');
});

test('normalizeRemote: ssh and https forms become one key', () => {
  const a = normalizeRemote('git@github.com:User/Repo.git');
  const b = normalizeRemote('https://github.com/user/repo.git');
  const c = normalizeRemote('https://github.com/user/repo/');
  assert.strictEqual(a, 'github.com/user/repo');
  assert.strictEqual(a, b);
  assert.strictEqual(a, c);
  assert.strictEqual(normalizeRemote(''), '');
});

test('suggestPairs: remote match, name prefix, direction, dismissed', () => {
  const counts = { chattering: 50, 'chattering-v2': 3, unrelated: 9 };
  const remotes = { chattering: ['github.com/u/chattering'], 'chattering-v2': ['github.com/u/chattering'] };
  const out = suggestPairs(counts, remotes, []);
  assert.strictEqual(out.length, 1); // one suggestion per pair, remote wins
  assert.strictEqual(out[0].from, 'chattering-v2'); // smaller folds into bigger
  assert.strictEqual(out[0].into, 'chattering');
  assert.strictEqual(out[0].reason, 'same git remote');
  // Prefix-only evidence (no shared remote).
  const p = suggestPairs({ foo: 5, 'foo-wt-x': 1 }, {}, []);
  assert.deepStrictEqual(p, [{ from: 'foo-wt-x', into: 'foo', reason: 'name prefix' }]);
  // Short bases stay quiet; dismissed pairs never return.
  assert.deepStrictEqual(suggestPairs({ ai: 5, 'ai-x': 1 }, {}, []), []);
  assert.deepStrictEqual(suggestPairs({ foo: 5, 'foo-wt-x': 1 }, {}, [dismissKey('foo', 'foo-wt-x')]), []);
});

test('suggestPairs precision: star groups and git-refuted name twins', () => {
  // One remote group of three suggests two folds into the biggest member.
  const counts = { big: 40, wt1: 2, wt2: 1 };
  const remotes = { big: ['gh/u/big'], wt1: ['gh/u/big'], wt2: ['gh/u/big'] };
  const star = suggestPairs(counts, remotes, []);
  assert.strictEqual(star.length, 2);
  assert.ok(star.every(s => s.into === 'big'));
  // A name-prefix pair with two different known remotes never appears.
  const refuted = suggestPairs(
    { dspy: 10, 'dspy-community': 5 },
    { dspy: ['gh/a/dspy'], 'dspy-community': ['gh/b/dspy-community'] }, []);
  assert.deepStrictEqual(refuted, []);
  // Without remote knowledge on one side, the prefix hint survives.
  const kept = suggestPairs({ lm15: 3, 'lm15-dev': 9 }, { 'lm15-dev': ['gh/u/lm15'] }, []);
  assert.deepStrictEqual(kept, [{ from: 'lm15', into: 'lm15-dev', reason: 'name prefix' }]);
});
