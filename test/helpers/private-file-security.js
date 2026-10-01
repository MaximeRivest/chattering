'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
// Independent native security observation, not the production assertion.
function assertPrivate(file) {
  if (process.platform !== 'win32') return assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'owner-only POSIX permissions');
  const script = `$ErrorActionPreference = 'Stop'; $f = [System.IO.FileInfo]::new('${file.replace(/'/g, "''")}'); $a = $f.GetAccessControl(); $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; $rules = @($a.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); if (!$a.AreAccessRulesProtected -or $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1) { throw 'Not owner-only' }; $r = $rules[0]; if ($r.IdentityReference.Value -ne $sid.Value -or $r.IsInherited -or $r.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $r.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'Unexpected access rule' }`;
  execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 15000, windowsHide: true });
}
module.exports = { assertPrivate };
