'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { capture } = require('./private-file-bootstrap-helper');

test('Given actual Windows dispatch, When each operation bootstraps, Then only .NET/language syntax compiles stdin source without cmdlet autoload', () => {
  const file = path.resolve("synthetic ' ; $(throw 'injection') key");
  const bytes = "synthetic secret ' ; $(throw 'injection')";
  for (const operation of ['read', 'assert', 'ensure', 'write']) {
    const { script, args, options } = capture(operation, file, bytes);
    assert.doesNotMatch(script, /\b(?:Add-Type|ConvertFrom-Json|ConvertTo-Json|New-Object|Import-Module)\b/i);
    assert.ok(script.includes("$PSModuleAutoLoadingPreference = 'None'"));
    assert.match(script, /Assembly\]::Load\('System.Web.Extensions, Version=4\.0\.0\.0/);
    assert.ok(script.includes('$json.DeserializeObject('));
    assert.ok(script.includes('$json.Serialize(@{'));
    assert.ok(script.includes('[Microsoft.CSharp.CSharpCodeProvider]::new()'));
    assert.ok(script.includes('$parameters.GenerateInMemory = $true'));
    assert.ok(script.includes('$parameters.GenerateExecutable = $false'));
    assert.ok(script.includes("TempFileCollection]::new([System.IO.Path]::GetTempPath(), $false)"));
    for (const reference of ['System.dll', 'System.Core.dll'])
      assert.ok(script.includes("ReferencedAssemblies.Add([System.IO.Path]::Combine($framework, '" + reference + "'))"));
    assert.ok(script.includes('$parameters.TempFiles.Delete(); $provider.Dispose()'));
    assert.ok(script.includes("throw [System.InvalidOperationException]::new('Native key-storage compilation failed')"));
    const request = JSON.parse(options.input);
    assert.equal(request.file, file);
    assert.equal(Buffer.from(request.source, 'base64').toString(), fs.readFileSync(path.join(__dirname, '../private-file-windows.cs'), 'utf8'));
    if (operation === 'write') assert.equal(Buffer.from(request.bytes, 'base64').toString(), bytes);
    assert.equal(args.length, 4);
    assert.equal(script.includes(file), false);
    assert.equal(script.includes(bytes), false);
    assert.equal(options.timeout, 15000);
    assert.equal(options.windowsHide, true);
    assert.equal(options.stdio.join(','), 'pipe,pipe,pipe');
  }
});

test('Given Windows bootstrap timeout or malformed output, When reading an absent-looking path, Then neither is accepted as absence', () => {
  const timeout = Object.assign(new Error('synthetic deadline exceeded'), { code: 'ETIMEDOUT' });
  assert.throws(() => capture('read', undefined, undefined, () => { throw timeout; }), e => e === timeout);
  for (const output of ['', 'OK', 'ERROR:garbled'])
    assert.throws(() => capture('read', undefined, undefined, () => output));
});

test('Given native error serialization, When JS receives Win32/retained-cleanup details, Then the original failure and protected residue diagnosis survive', () => {
  const detail = { message: 'synthetic sharing failure', nativeErrorCode: 32, retainTemporaryState: true,
    temporaryFile: 'synthetic protected stage', cleanupFailure: 'synthetic erasure failure' };
  assert.throws(() => capture('write', undefined, undefined,
    () => 'ERROR:' + Buffer.from(JSON.stringify(detail)).toString('base64')), error => {
    for (const [key, value] of Object.entries(detail)) assert.equal(error[key], value);
    return true;
  });
});
