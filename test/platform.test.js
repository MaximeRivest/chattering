'use strict';
// platform.js and runtime.js, on whatever system runs the tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../platform.js');
const R = require('../runtime.js');

test('containment: inside, the folder itself, not a sibling that shares a prefix', () => {
  const root = path.resolve(os.tmpdir(), 'proj');
  assert.equal(P.isInside(path.join(root, 'a', 'b.txt'), root), true);
  assert.equal(P.isInside(root, root), true);
  assert.equal(P.isInside(root + 'x', root), false);
  assert.equal(P.isInside(path.dirname(root), root), false);
  assert.equal(P.isInside(path.join(root, '..', 'other'), root), false, 'resolved before comparing');
  if (P.CASE_INSENSITIVE) assert.equal(P.isInside(path.join(root.toUpperCase(), 'A'), root), true, 'letter case does not matter where the disk ignores it');
});

test('PATH: this system\'s name and separator, deduplicated', () => {
  const key = P.pathKey(process.env);
  const env = P.withPath({ [key]: 'x' }, ['/a', '/b', '/a']);
  assert.equal(env[P.pathKey(env)], ['/a', '/b'].join(path.delimiter));
  assert.equal(Object.keys(env).filter(k => k.toUpperCase() === 'PATH').length, 1, 'one PATH entry, never PATH beside Path');
  assert.ok(P.findOnPath(path.basename(process.execPath, path.extname(process.execPath)), { ...process.env, [P.pathKey()]: path.dirname(process.execPath) }), 'node is found where it is');
});

test('folders: an existing Linux-named folder stays; otherwise the system\'s own', () => {
  const home = path.join(os.tmpdir(), 'nohome');
  const none = P.appDirs({}, home, () => false);
  if (P.IS_WIN) assert.match(none.config, /AppData[\\/]Roaming[\\/]Chattering$/);
  else if (P.IS_MAC) assert.match(none.config, /Library\/Application Support\/Chattering$/);
  else assert.equal(none.config, path.join(home, '.config', 'chattering'));
  const legacy = P.appDirs({}, home, p => p === path.join(home, '.config', 'chattering'));
  assert.equal(legacy.config, path.join(home, '.config', 'chattering'), 'an install that has it keeps it, on every system');
  assert.equal(P.appDirs({ CHATTERING_DATA_DIR: '/x/y' }, home, () => false).data, '/x/y');
  assert.equal(none.notes, path.join(home, 'notes', 'chattering'));
});

test('portable keys: forward slashes out, native paths back', () => {
  const native = ['a', 'b', 'c.jsonl'].join(path.sep);
  assert.equal(P.toPortable(native), 'a/b/c.jsonl');
  assert.equal(P.fromPortable('a/b/c.jsonl'), native);
});

test('Pi: found, started as node + its cli.js, sessions named as Pi names them', () => {
  const found = R.locatePi({ fresh: true });
  if (!found) return; // no Pi here: the tests needing it say so themselves
  const cmd = R.piCommand(['--version']);
  const entry = cmd.args[R.piNodeArgs().length]; // after node's own (--require win-hide on Windows)
  assert.ok(fs.existsSync(entry) && /cli\.js$/.test(entry), 'Pi\'s own entry, not a shim');
  // Pi's own rule, on this system's paths.
  if (process.platform === 'win32') assert.equal(R.piSessionDirName('C:\\Users\\x\\p'), '--C--Users-x-p--');
  else assert.equal(R.piSessionDirName('/home/x/Projects/p'), '--home-x-Projects-p--');
  assert.equal(R.piSessionDirName('C:\\Users\\x\\p').includes(':'), false, 'no colon in a folder name on any system');
  assert.equal(R.PI_TESTED_VERSION, require('../runtime/package.json').dependencies['@earendil-works/pi-coding-agent']);
});

test('sound and opening files: each system has its command, or says it has none', () => {
  const play = P.audioPlayCommand('x.wav');
  if (P.IS_MAC) assert.equal(play.file, 'afplay');
  if (P.IS_WIN) assert.match(play.file, /powershell/i);
  const open = P.openCommand(path.join(os.tmpdir(), 'a b & c.txt'));
  if (P.IS_MAC) assert.deepEqual(open.args, [path.join(os.tmpdir(), 'a b & c.txt')], 'a path is one argument, never a shell string');
  if (P.IS_WIN) assert.equal(open.file, 'explorer.exe');
});
