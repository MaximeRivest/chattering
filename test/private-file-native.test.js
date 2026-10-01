'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { capture, nativeRequest } = require('./private-file-bootstrap-helper');
function native(file, body, extra) {
  const { exe, args, options } = nativeRequest(file, body, extra);
  return execFileSync(exe, args, options).trim();
}
const { readPrivateFileSync, writePrivateFileSync, assertPrivateFileSync } = require('../private-file');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-key-object-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'key');
}

test('Given actual native key storage, When published bytes are read through an alias and a second link is added, Then security is checked against the acquired object', t => {
  const file = fixture(t);
  writePrivateFileSync(file, 'synthetic private key');
  assertPrivateFileSync(file);
  const alias = path.join(path.dirname(file), '.', path.basename(file));
  assert.equal(readPrivateFileSync(alias), 'synthetic private key');
  if (process.platform === 'win32') assert.equal(readPrivateFileSync(file.toUpperCase()), 'synthetic private key');
  fs.linkSync(file, file + '.other');
  assert.throws(() => readPrivateFileSync(file), /singly linked|regular/);
});

test('Given native exclusive Windows handles or POSIX no-follow descriptors, When aliases and retained readers challenge key security, Then insecure access fails closed', t => {
  const file = fixture(t);
  if (process.platform !== 'win32') {
    writePrivateFileSync(file, 'synthetic private key');
    fs.symlinkSync(file, file + '.alias');
    assert.throws(() => readPrivateFileSync(file + '.alias'), { code: 'ELOOP' });
    fs.chmodSync(file, 0o644);
    assert.throws(() => assertPrivateFileSync(file), /0600/);
    return;
  }
  // Execute the production C# helper against actual NTFS objects. This branch
  // must run natively before integration; a Linux adapter does NOT execute it.
  const out = native(file, String.raw`
    $s = [ChatteringPrivateFile]::Open($file, $true);
    try {
      [ChatteringPrivateFile]::Check($s);
      $denied = $false;
      try { $reader = [System.IO.FileStream]::new($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite); $reader.Dispose() } catch { $e = $_.Exception; while ($null -ne $e.InnerException) { $e = $e.InnerException }; if (($e.HResult -band 65535) -ne 32) { throw }; $denied = $true }
      if (!$denied) { throw 'Retained reader exclusion failed' };
      $denied = $false;
      try { [System.IO.File]::Move($file, $file + '.replacement') } catch { $e = $_.Exception; while ($null -ne $e.InnerException) { $e = $e.InnerException }; if (($e.HResult -band 65535) -ne 32) { throw }; $denied = $true }
      if (!$denied) { throw 'Acquired object could be replaced' };
      $acl = $s.GetAccessControl();
      $everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0');
      $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow));
      $s.SetAccessControl($acl);
      $rejected = $false;
      try { [ChatteringPrivateFile]::Check($s) } catch { $e = $_.Exception; while ($null -ne $e.InnerException) { $e = $e.InnerException }; if (!$e.Message.Contains('owner-only')) { throw }; $rejected = $true }
      if (!$rejected) { throw 'Actual Everyone ACE negative control accepted' };
      [ChatteringPrivateFile]::Protect($s);
      [ChatteringPrivateFile]::Check($s);
    } finally { $s.Dispose() }
    # A previously acquired reader cannot survive the exclusive legacy read.
    $reader = [System.IO.FileStream]::new($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite);
    try {
      $denied = $false;
      try { [ChatteringPrivateFile]::Read($file) } catch { $e = $_.Exception; while ($null -ne $e.InnerException) { $e = $e.InnerException }; if (!($e -is [System.ComponentModel.Win32Exception]) -or $e.NativeErrorCode -ne 32) { throw }; $denied = $true }
      if (!$denied) { throw 'Preexisting retained handle did not block protection/read' }
    } finally { $reader.Dispose() }
    [Console]::Write('NATIVE-CONTROLS-OK');`);
  assert.equal(out.trim(), 'NATIVE-CONTROLS-OK');
  assertPrivateFileSync(file);
});


test('Given an existing empty key file, When the native reader opens it, Then empty bytes are not confused with initial-open absence', t => {
  const file = fixture(t);
  assert.equal(readPrivateFileSync(file), null);
  writePrivateFileSync(file, '');
  assert.equal(readPrivateFileSync(file), '');
});


// These are actual NTFS tests, not emulated POSIX lock behavior. They are
// declared on Windows; Linux runs do not establish either native result.
if (process.platform === 'win32') {
  test('Given the dispatched bootstrap, When the native PowerShell parser examines every operation, Then no command AST or parse error can trigger module autoload', t => {
    const file = fixture(t);
    const scripts = ['read', 'assert', 'ensure', 'write'].map(operation => capture(operation, file).script);
    assert.equal(native(file, String.raw`
      foreach ($script in $request.scripts) {
        $tokens = $null; $errors = $null;
        $ast = [System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$errors);
        if ($errors.Length -ne 0) { throw 'Production bootstrap syntax errors' };
        $commands = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true);
        if ($commands.Count -ne 0) { throw 'Production bootstrap invokes a command' }
      }
      [Console]::Write('NO-CMDLET-AUTOLOAD');`, { scripts }), 'NO-CMDLET-AUTOLOAD');
  });

  test('Given completely fresh Windows HOME/AppData/TEMP, When actual dispatch performs the initial absent read, Then it finishes within the unchanged overall 15-second deadline without compiler residue', t => {
    const file = fixture(t), root = path.dirname(file);
    const home = path.join(root, 'home'), appData = path.join(home, 'AppData', 'Roaming');
    const localAppData = path.join(home, 'AppData', 'Local'), temp = path.join(root, 'compiler-temp');
    for (const dir of [appData, localAppData, temp]) fs.mkdirSync(dir, { recursive: true });
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData, TEMP: temp, TMP: temp };
    const child = `const assert = require('node:assert/strict');
      const { readPrivateFileSync } = require(process.argv[1]);
      assert.equal(readPrivateFileSync(process.argv[2]), null);
      process.stdout.write('COLD-READ-OK');`;
    const started = performance.now();
    const out = execFileSync(process.execPath, ['-e', child, require.resolve('../private-file'), file],
      { env, timeout: 15000, windowsHide: true, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(out, 'COLD-READ-OK');
    assert.ok(performance.now() - started < 15000, 'overall cold read deadline, not a timeout per retry');
    assert.equal(fs.existsSync(file), false, 'absence must not create credential storage');
    assert.deepEqual(fs.readdirSync(temp), [], 'no executable compiler cache or temporary residue');
  });

  const seedAndLock = String.raw`
    [ChatteringPrivateFile]::Write($file, [System.Text.Encoding]::UTF8.GetBytes('existing identity'));
    $locked = [ChatteringPrivateFile]::Open($file, $false);
    try {`;
  const unchangedTarget = String.raw`
    $locked.Position = 0; $saved = [System.IO.MemoryStream]::new(); $locked.CopyTo($saved);
    if ([System.Text.Encoding]::UTF8.GetString($saved.ToArray()) -ne 'existing identity') { throw 'Existing credential overwritten' };`;
  test('Given a native Windows locked destination, When publication fails, Then original credential survives and no staging residue remains', t => {
    const file = fixture(t);
    assert.equal(native(file, seedAndLock + String.raw`
      $primary = $null;
      try { [ChatteringPrivateFile]::Write($file, [System.Text.Encoding]::UTF8.GetBytes('replacement identity')) }
      catch { $primary = $_.Exception; while ($null -ne $primary.InnerException) { $primary = $primary.InnerException } }
      if (!($primary -is [System.ComponentModel.Win32Exception]) -or $primary.NativeErrorCode -ne 32) { throw 'Original sharing failure not preserved' };
      if ($primary.Data['RetainTemporaryState']) { throw 'Erasure unexpectedly failed' };
      if ([System.IO.Directory]::GetFiles([System.IO.Path]::GetDirectoryName($file), 'key.*.tmp').Length -ne 0) { throw 'Staging residue remains' };
      ` + unchangedTarget + String.raw`
    } finally { $locked.Dispose() }
    [Console]::Write('LOCKED-PUBLICATION-OK');`), 'LOCKED-PUBLICATION-OK');
    assert.equal(readPrivateFileSync(file), 'existing identity');
  });
  test('Given a real native publication failure and injected erasure failure, When the production writer unwinds, Then primary failure is preserved and protected retained state is reported', t => {
    const file = fixture(t);
    assert.equal(native(file, seedAndLock + String.raw`
      $erase = [System.Action[System.IO.FileStream]]{ param($stream) throw [System.IO.IOException]::new('injected erasure failure') };
      $method = [ChatteringPrivateFile].GetMethod('WriteWithCleanup', [System.Reflection.BindingFlags]'NonPublic,Static');
      $arguments = [object[]]::new(3); $arguments[0] = $file; $arguments[1] = [System.Text.Encoding]::UTF8.GetBytes('replacement identity'); $arguments[2] = $erase;
      $primary = $null;
      try { $method.Invoke($null, $arguments) }
      catch { $primary = $_.Exception; while ($null -ne $primary.InnerException) { $primary = $primary.InnerException } }
      if (!($primary -is [System.ComponentModel.Win32Exception]) -or $primary.NativeErrorCode -ne 32) { throw 'Erasure masked primary failure' };
      if (!$primary.Data['RetainTemporaryState'] -or !$primary.Data['CleanupFailure'].Contains('injected erasure failure')) { throw 'Retained-state diagnosis missing' };
      $temporary = $primary.Data['TemporaryFile'];
      $left = @([System.IO.Directory]::GetFiles([System.IO.Path]::GetDirectoryName($file), 'key.*.tmp'));
      if ($left.Length -ne 1 -or $left[0] -ne $temporary) { throw 'Retained-state path is wrong' };
      if (![ChatteringPrivateFile]::Inspect($temporary, $false)) { throw 'Retained file is not protected' };
      ` + unchangedTarget + String.raw`
    } finally { $locked.Dispose() }
    [Console]::Write('RETAINED-PRIMARY-OK');`), 'RETAINED-PRIMARY-OK');
    assert.equal(readPrivateFileSync(file), 'existing identity');
  });
}
