'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { writePrivateFileSync, readPrivateFileSync } = require('../private-file');
const { assertPrivate } = require('./helpers/private-file-security');

test('Given a trusted directory alias, When a credential is published, Then the canonical protected directory retains its identity', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'private-alias-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'owned'); fs.mkdirSync(directory, { mode: 0o700 });
  const alias = path.join(root, 'alias'); fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const file = path.join(alias, 'key.json');
  writePrivateFileSync(file, 'first identity');
  assert.equal(readPrivateFileSync(path.join(directory, 'key.json')), 'first identity');
  writePrivateFileSync(file, 'second identity');
  assert.equal(readPrivateFileSync(path.join(directory, 'key.json')), 'second identity');
  assertPrivate(path.join(directory, 'key.json'));
});

test('Given a native private file, When its permissions are observed independently, Then security is checked rather than assumed', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'private-observation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'key.json'); writePrivateFileSync(file, 'synthetic'); assertPrivate(file);
  if (process.platform === 'win32') {
    const { execFileSync } = require('node:child_process');
    const script = `$ErrorActionPreference='Stop'; $f=[System.IO.FileInfo]::new('${file.replace(/'/g, "''")}'); $a=$f.GetAccessControl(); $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::Read,[System.Security.AccessControl.AccessControlType]::Allow)); $f.SetAccessControl($a)`;
    execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 15000, windowsHide: true });
  } else fs.chmodSync(file, 0o644);
  assert.throws(() => assertPrivate(file), 'permissive storage cannot pass the independent observer');
});
