'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createAnywhereHome } = require('../anywhere-home');
const { createAnywhereLinks } = require('../anywhere-link');

// Native Windows checks the actual owner SID and DACL, not emulated POSIX
// bits. On Linux this only proves real POSIX permissions and lifecycle.
function assertPrivate(file) {
  if (process.platform !== 'win32') return assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const script = `$f = [System.IO.FileInfo]::new('${file.replace(/'/g, "''")}'); $a = $f.GetAccessControl(); $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; $rules = @($a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); if (!$a.AreAccessRulesProtected -or $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1) { throw 'Not owner-only' }; $r = $rules[0]; if ($r.IdentityReference.Value -ne $sid.Value -or $r.IsInherited -or $r.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $r.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'Unexpected access rule' }`;
  const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  execFileSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("$ErrorActionPreference = 'Stop'; " + script, 'utf16le').toString('base64')], { timeout: 15000, windowsHide: true });
}
function dir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anywhere-private-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Given a stale permissive temporary file, When the home saves its private key, Then the published file is owner-only', async t => {
  const dataDir = dir(t), file = path.join(dataDir, 'anywhere.json');
  fs.writeFileSync(file + '.tmp', 'stale', { mode: 0o666 }); fs.chmodSync(file + '.tmp', 0o666);
  const pair = require('node:crypto').generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const key = { jwk: pair.privateKey.export({ format: 'jwk' }), spki: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') };
  fs.writeFileSync(file, JSON.stringify({ key, devices: [{ id: 'fixture' }] }), { mode: 0o600 });
  const home = createAnywhereHome({ dataDir, enabled: () => false }); t.after(() => home.stop());
  await home.homeId();
  home.forget('fixture');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).key.jwk.d, 'real private key saved');
  assertPrivate(file);
});

test('Given an existing permissive link credential file, When links load and save, Then the stored file is owner-only', async t => {
  const dataDir = dir(t), file = path.join(dataDir, 'anywhere-links.json');
  fs.writeFileSync(file, JSON.stringify({ links: [{ id: 'fixture', key: { jwk: { d: 'synthetic-secret' } } }] }), { mode: 0o666 });
  fs.chmodSync(file, 0o666);
  const links = createAnywhereLinks({ dataDir, rtc: { error: 'not used' }, authorize: () => false });
  assertPrivate(file);
  await links.remove('fixture');
  assertPrivate(file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).links, []);
});
