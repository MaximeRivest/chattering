'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shellPath } = require('./helpers/shell-path');
const { shellCommands } = require('../task-locations');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real inference source with Win32 path rules on any host;
// this does not simulate a native Windows filesystem or access control.
function windowsLocations() {
  const source = fs.readFileSync(path.join(__dirname, '../task-locations.js'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => {
    if (name === 'node:path') return path.win32;
    if (name === './platform.js') return { IS_WIN: true };
    return require(name);
  } }, { filename: 'task-locations.js (Win32 path rules)' });
  return module.exports;
}
const windows = windowsLocations();

for (const file of ['C:\\Users\\fixture\\tmpish\\probe.txt', 'C:\\Users\\fixture person\\tmpish\\probe.txt', '/owned/fixture person/probe.txt']) {
  test(`Given the fixture output path ${JSON.stringify(file)}, When it is recorded in a shell redirect, Then its literal identity is preserved`, () => {
    const command = `echo x > ${shellPath(file)}`;
    assert.deepEqual(shellCommands(command)[0].words, ['echo', 'x', '>', file], 'a path must not lose backslashes or split at spaces');
  });
  test(`Given Win32 location rules and the fixture path ${JSON.stringify(file)}, When the real source infers its output, Then it resolves the same local file`, () => {
    const cwd = 'C:\\work';
    const result = windows.inspectShell(`echo x > ${shellPath(file)}`, { host: 'local', cwd });
    assert.equal(result.locations.length, 1, 'one literal local output');
    assert.equal(result.locations[0].host, 'local');
    // Rooted paths resolve on the host's current drive; a fully named
    // drive (the actual Windows fixture case) remains that same drive.
    assert.equal(result.locations[0].path, path.win32.resolve(file));
    assert.equal(result.locations[0].reason, '');
  });
}
