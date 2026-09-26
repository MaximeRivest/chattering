'use strict';
// Tests for agentpath.js: the PATH handed to agent shells. Regression
// coverage for the bug where sw/bin was prepended on every session (PATH
// grew to 150+ entries) and the unwrapped sudo shadowed the setuid one.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { agentPath, WRAPPERS, SW_BIN } = require('../agentpath.js');

// Pretend we are on a NixOS box with both user dirs present, regardless
// of the machine running the tests.
const HOME = '/home/tester';
const LOCAL = `${HOME}/.local/bin`;
const NVM = `${HOME}/.nvm/versions/node/v22.23.1/bin`;
const nixos = new Set([LOCAL, NVM, WRAPPERS, SW_BIN]);
// A NixOS machine whatever runs the tests: its separator and folders. The
// node folder stands in for the one running Chattering (NVM here).
const opts = { home: HOME, platform: 'linux', nodeDir: NVM, exists: d => nixos.has(d) };
const ap = p => agentPath(p, opts);
const idx = (p, d) => p.split(':').indexOf(d);
const has = (p, d) => idx(p, d) >= 0;

test('inserts wrappers when the inherited PATH lacks it', () => {
  const p = ap(`${SW_BIN}:/usr/bin:/bin`);
  assert.ok(has(p, WRAPPERS));
  assert.ok(idx(p, WRAPPERS) < idx(p, SW_BIN));
});

test('undefined and empty input still yield wrappers before sw/bin', () => {
  for (const input of [undefined, '', null]) {
    const p = ap(input);
    assert.ok(has(p, WRAPPERS), `missing wrappers for ${JSON.stringify(input)}`);
    assert.ok(idx(p, WRAPPERS) < idx(p, SW_BIN));
    assert.ok(has(p, '/usr/bin'), 'fallback base dirs present');
  }
});

test('fixes wrong order without disturbing unrelated dirs', () => {
  const p = ap(`/a:${SW_BIN}:/b:${WRAPPERS}:/c`);
  assert.ok(idx(p, WRAPPERS) < idx(p, SW_BIN));
  assert.ok(idx(p, '/a') < idx(p, '/b') && idx(p, '/b') < idx(p, '/c'));
});

test('already-correct order is preserved', () => {
  const p = ap(`/opt/x/bin:${WRAPPERS}:${SW_BIN}:/usr/bin`);
  assert.deepStrictEqual(p.split(':'), [LOCAL, NVM, '/opt/x/bin', WRAPPERS, SW_BIN, '/usr/bin']);
});

test('user dirs come first, and only if they exist', () => {
  assert.ok(ap('/usr/bin').startsWith(`${LOCAL}:${NVM}:`));
  const noNvm = agentPath('/usr/bin', { ...opts, exists: d => d !== NVM && nixos.has(d) });
  assert.ok(!has(noNvm, NVM));
  assert.ok(noNvm.startsWith(`${LOCAL}:`));
});

test('system dirs that do not exist are not added', () => {
  const plain = agentPath('/usr/bin:/bin', { ...opts, exists: () => false });
  assert.strictEqual(plain, '/usr/bin:/bin');
});

test('dedupes a bloated PATH and every dir appears once', () => {
  const bloated = Array(50).fill(`${SW_BIN}:/snap/bin:${WRAPPERS}`).join(':') + ':/usr/bin';
  const p = ap(bloated);
  const parts = p.split(':');
  assert.strictEqual(parts.length, new Set(parts).size, 'duplicates remain');
  assert.ok(parts.length <= 6, `too many entries: ${parts.length}`);
  assert.ok(idx(p, WRAPPERS) < idx(p, SW_BIN));
});

test('idempotent: agentPath(agentPath(x)) === agentPath(x)', () => {
  const inputs = [
    undefined,
    `${SW_BIN}:/usr/bin`,
    `/a:${SW_BIN}:/b:${WRAPPERS}:/c`,
    Array(50).fill(`${SW_BIN}:/snap/bin:${WRAPPERS}`).join(':'),
    `${WRAPPERS}:${SW_BIN}`,
  ];
  for (const input of inputs) {
    const once = ap(input);
    assert.strictEqual(ap(once), once, `not stable for ${JSON.stringify(input)}`);
  }
});

test('ignores empty segments', () => {
  const p = ap(`::/usr/bin::${SW_BIN}::`);
  assert.ok(!p.split(':').includes(''));
});

// End-to-end on a real NixOS host: a shell spawned under the produced PATH
// must resolve the setuid sudo. Skipped elsewhere.
test('sudo resolves to the setuid wrapper on NixOS', { skip: !fs.existsSync(`${WRAPPERS}/sudo`) }, () => {
  const env = { PATH: agentPath(`${SW_BIN}:/usr/bin`) };
  const which = execFileSync('bash', ['-c', 'command -v sudo'], { env }).toString().trim();
  assert.strictEqual(which, `${WRAPPERS}/sudo`);
});

test('Windows: its separator, no NixOS folders, case-insensitive duplicates, the node folder first', () => {
  const node = 'C:\\Program Files\\nodejs';
  const p = agentPath('C:\\Windows\\system32;c:\\windows\\SYSTEM32\\;C:\\Tools', { platform: 'win32', home: 'C:\\Users\\t', nodeDir: node, exists: () => true });
  assert.deepStrictEqual(p.split(';'), [node, 'C:\\Windows\\system32', 'C:\\Tools']);
  assert.strictEqual(agentPath(p, { platform: 'win32', home: 'C:\\Users\\t', nodeDir: node, exists: () => true }), p, 'idempotent');
});
