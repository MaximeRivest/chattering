'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

test('Given the production Windows native storage dependency, When the actual release file filter selects assets, Then the dependency is shipped', () => {
  const root = path.join(__dirname, '..');
  const storage = fs.readFileSync(path.join(root, 'private-file.js'), 'utf8');
  const args = storage.match(/fs.readFileSync\(path.join\(__dirname, ([^)]+)\)\)/)[1];
  const native = vm.runInNewContext('path.join(' + args + ')', { path });
  assert.ok(fs.existsSync(path.join(root, native)), 'native dependency exists');
  const release = fs.readFileSync(path.join(root, 'scripts/build-release.js'), 'utf8');
  const start = release.indexOf('const SKIP ='), stop = release.indexOf('const files =', start);
  const skip = vm.runInNewContext(release.slice(start, stop) + '\nSKIP');
  assert.equal(skip.some(rule => rule.test(native)), false, 'the real release selector must not omit the production security helper');
});
