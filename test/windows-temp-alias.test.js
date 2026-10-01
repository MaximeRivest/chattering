'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

test('Given Windows short temp names, When Made receives the native long name, Then only descendants are scratch', () => {
  const short = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp';
  const long = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp';
  const disk = () => short; disk.native = () => long;
  const platform = { IS_WIN: true, realFolder: disk.native, isInside(child, parent) {
    const rel = path.win32.relative(parent.toLowerCase(), child.toLowerCase());
    return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !path.win32.isAbsolute(rel));
  } };
  const context = { module: { exports: {} }, require(name) {
    if (name === 'node:fs') return { ...fs, realpathSync: disk };
    if (name === 'node:os') return { tmpdir: () => short };
    if (name === 'node:path') return path.win32;
    if (name === './platform.js') return platform;
    return name.startsWith('.') ? require(path.resolve(__dirname, '..', name)) : require(name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../made.js'), 'utf8'), context);
  const { isScratch } = context.module.exports;
  assert.equal(isScratch(long + '\\probe.txt'), true);
  assert.equal(isScratch(short + '\\probe.txt'), true);
  assert.equal(isScratch(long + '-project\\probe.txt'), false);
});
