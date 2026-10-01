'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the actual made source with Win32 path rules and deterministic
// short/long/case aliases. This is not native Windows filesystem proof.
function windowsMade() {
  const directory = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(directory, 'made.js'), 'utf8');
  const platform = fs.readFileSync(path.join(directory, 'platform.js'), 'utf8');
  const containment = platform.slice(platform.indexOf('function isInside('), platform.indexOf('function samePath('));
  assert.match(containment, /path\.relative/);
  // Supply a deterministic current drive for rooted paths in this simulation.
  const windowsPath = { ...path.win32, resolve: (...args) => path.win32.resolve('C:\\work', ...args) };
  const isInside = vm.runInNewContext(containment + '\nisInside', { path: windowsPath, sameCase: p => p.toLowerCase() });
  const module = { exports: {} }, context = { module, exports: module.exports, require: name => {
    if (name === 'node:path') return windowsPath;
    if (name === 'node:os') return { tmpdir: () => 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp' };
    if (name === 'node:fs') return { realpathSync: () => 'C:\\Users\\RUNNERADMIN\\AppData\\Local\\Temp' };
    if (name === './platform.js') return { IS_WIN: true, isInside };
    return require(name.startsWith('./') ? path.join(directory, name) : name);
  } };
  vm.runInNewContext(source + '\nthis.fixtureWithin = within;', context, { filename: 'made.js (Win32 path rules)' });
  const predicates = [...source.matchAll(/const scratchOf = ([^\n]+);/g)];
  assert.equal(predicates.length, 1, 'exactly one actual project scratch predicate');
  return { ...module.exports, within: context.fixtureWithin,
    scratchOf: (root, file) => vm.runInNewContext('(' + predicates[0][1] + ')(file)', {
      scratch: module.exports.isScratch, home: root, within: context.fixtureWithin, file,
    }) };
}
const made = windowsMade();

for (const file of [
  'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\job\\probe.txt',
  'c:/users/runneradmin/appdata/local/temp/job/probe.txt',
  'c:\\users\\runner~1\\appdata\\local\\temp\\job\\probe.txt',
]) test(`Given a native temporary path alias ${JSON.stringify(file)}, When the actual summary classifies scratch, Then it recognizes the same temporary tree`, () => {
  assert.equal(made.isScratch(file), true);
});

for (const file of [
  'C:\\Users\\runneradmin\\AppData\\Local\\Temporary\\probe.txt',
  'D:\\Users\\runneradmin\\AppData\\Local\\Temp\\probe.txt',
  'C:\\Users\\runneradmin\\Projects\\probe.txt',
  'C:\\tmp\\product.png',
  'C:\\var\\tmp\\product.png',
]) test(`Given a non-temporary sibling or different root ${JSON.stringify(file)}, When scratch is classified, Then it remains product`, () => {
  assert.equal(made.isScratch(file), false);
});

test('Given a project inside the configured temporary tree, When its actual scratch predicate runs, Then own files are retained and external scratch is excluded', () => {
  const root = 'C:\\Users\\RUNNERADMIN\\AppData\\Local\\Temp\\Project';
  const own = 'c:/users/runneradmin/appdata/local/temp/project/output.txt';
  const outside = root + '-neighbor\\probe.txt';
  assert.equal(made.isScratch(own), true, 'the precondition really is temporary storage');
  assert.equal(made.scratchOf(root, own), false, 'the project overrides scratch classification');
  assert.equal(made.scratchOf(root, outside), true, 'a neighboring project is not ours');
});

test('Given equal roots or traversal to a sibling, When native lexical containment runs, Then only the owned root is included', () => {
  assert.equal(made.within('C:\\Temp\\Project', 'c:/temp/project'), true);
  assert.equal(made.within('C:\\Temp\\Project', 'C:\\Temp\\Project\\..\\outside.txt'), false);
  assert.equal(made.within('C:\\Temp\\Project', 'C:\\Temp\\Project-neighbor\\output.txt'), false);
  assert.equal(made.within('D:\\Delegations\\Job', 'd:/delegations/job/output.txt'), true);
});
