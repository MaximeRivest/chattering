'use strict';
// Windows uses one native handle for CREATE_NEW security, ACLs, identity,
// bytes and rename. POSIX uses the same acquired fd for stat/chmod/read/write.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const BUDGET = 1024 * 1024;

function windowsOperation(file, operation, bytes) {
  const root = process.env.SystemRoot || process.env.windir;
  if (!root) throw new Error('Windows system directory unavailable; cannot establish key security');
  const source = fs.readFileSync(path.join(__dirname, 'private-file-windows.cs'));
  const actions = {
    read: "[Console]::Write([ChatteringPrivateFile]::ReadEncoded($file))",
    assert: "if ([ChatteringPrivateFile]::Inspect($file, $false)) { [Console]::Write('OK') } else { [Console]::Write('ABSENT') }",
    ensure: "if ([ChatteringPrivateFile]::Inspect($file, $true)) { [Console]::Write('OK') } else { [Console]::Write('ABSENT') }",
    write: "[ChatteringPrivateFile]::Write($file, [Convert]::FromBase64String($request.bytes)); [Console]::Write('OK')",
  };
  // Pipe code, filename and bytes, not an oversized -EncodedCommand or secret argv.
  const script = "$ErrorActionPreference = 'Stop'; $request = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8).ReadToEnd() | ConvertFrom-Json; " +
    "Add-Type -TypeDefinition ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($request.source))); $file = $request.file; try { " + actions[operation] + " } catch { " +
    "$e = $_.Exception; while (($e -is [System.Management.Automation.MethodInvocationException] -or $e -is [System.Reflection.TargetInvocationException]) -and $null -ne $e.InnerException) { $e = $e.InnerException }; " +
    "$code = $null; if ($e -is [System.ComponentModel.Win32Exception]) { $code = $e.NativeErrorCode }; " +
    "$detail = @{ message = $e.Message; nativeErrorCode = $code; retainTemporaryState = [bool]$e.Data['RetainTemporaryState']; temporaryFile = $e.Data['TemporaryFile']; cleanupFailure = $e.Data['CleanupFailure'] } | ConvertTo-Json -Compress; " +
    "[Console]::Write('ERROR:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($detail))) }";
  const input = JSON.stringify({ source: source.toString('base64'), file: path.resolve(file), bytes: bytes?.toString('base64') });
  const result = execFileSync(path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeout: 15000, windowsHide: true, input, encoding: 'utf8', maxBuffer: 2 * BUDGET, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  if (result.startsWith('ERROR:')) {
    const failure = JSON.parse(Buffer.from(result.slice(6), 'base64').toString('utf8'));
    const error = new Error(failure.message);
    error.nativeErrorCode = failure.nativeErrorCode;
    if (failure.retainTemporaryState === true) {
      error.retainTemporaryState = true; error.temporaryFile = failure.temporaryFile;
      error.cleanupFailure = failure.cleanupFailure;
    }
    throw error;
  }
  if (operation === 'read' && result.startsWith('DATA:')) return Buffer.from(result.slice(5), 'base64').toString('utf8');
  if (result === 'ABSENT' && operation === 'read') return null;
  if (result === 'ABSENT') throw Object.assign(new Error('Key storage absent'), { code: 'ENOENT' });
  if (result !== 'OK' || operation === 'read') throw new Error('Invalid native key-storage result');
}
function regularHandle(fd) {
  const st = fs.fstatSync(fd);
  if (!st.isFile() || st.nlink !== 1) throw new Error('Key storage must be a singly linked regular file');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('Key storage has a foreign owner');
  return st;
}
function secureHandle(fd, protect) {
  regularHandle(fd);
  if (protect) fs.fchmodSync(fd, 0o600);
  const st = regularHandle(fd);
  if ((st.mode & 0o777) !== 0o600) throw new Error('Key storage must have mode 0600');
  return st;
}
function withHandle(file, protect, missing, use) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (e) { if (missing && e.code === 'ENOENT') return null; throw e; }
  try { return use(fd, secureHandle(fd, protect)); }
  finally { fs.closeSync(fd); }
}
function readPrivateFileSync(file) {
  if (process.platform === 'win32') return windowsOperation(file, 'read');
  return withHandle(file, true, true, (fd, st) => {
    if (st.size > BUDGET) throw new Error('Key storage exceeds budget');
    return fs.readFileSync(fd, 'utf8');
  });
}
function assertPrivateFileSync(file) {
  if (process.platform === 'win32') return windowsOperation(file, 'assert');
  withHandle(file, false, false, () => {});
}
function ensurePrivateFileSync(file) {
  if (process.platform === 'win32') return windowsOperation(file, 'ensure');
  withHandle(file, true, false, () => {});
}
// Publication uses path rename, so checks AFTER rename are only diagnostics.
// Prove an owner-controlled, symlink-free directory chain BEFORE staging.
// Trust / as the namespace anchor, root/current-user ancestors, and sticky
// shared ancestors only when the next entry is root/current-user owned.
// Concurrent same-uid/privileged permission or path changes, and namespace/
// mount changes are outside this contract. Existing writable directories are refused, never chmodded.
function publicationDirectory(directory) {
  if (typeof process.getuid !== 'function') throw new Error('Publication directory owner unavailable');
  const uid = process.getuid(), root = path.parse(directory).root;
  const entries = [root];
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean))
    entries.push(path.join(entries.at(-1), part));
  const handles = [];
  const close = () => { for (const fd of handles.reverse()) fs.closeSync(fd); };
  try {
    for (let i = 0; i < entries.length; i++) {
      const dir = entries[i], final = i === entries.length - 1;
      let fd;
      try { fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); }
      catch (e) {
        if (e.code !== 'ENOENT' || i === 0) throw new Error('Unsafe publication directory or alias: ' + dir, { cause: e });
        // The preceding acquired directory already passed the ownership and
        // write checks. Only NEW directories get mode 0700, atomically.
        try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (create) { if (create.code !== 'EEXIST') throw create; }
        fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      }
      handles.push(fd);
      const st = fs.fstatSync(fd);
      if (!st.isDirectory() || (i > 0 && st.uid !== uid && st.uid !== 0) || (final && st.uid !== uid))
        throw new Error('Unsafe publication directory owner: ' + dir);
      if ((st.mode & 0o022) && (final || !(st.mode & 0o1000)))
        throw new Error('Unsafe writable publication directory: ' + dir);
    }
    return close;
  } catch (e) { close(); throw e; }
}
function writePrivateFileSync(file, bytes) {
  // Resolve existing parent aliases once (macOS /var -> /private/var), then
  // publish using only the canonical path checked below. Missing descendants
  // are appended to the canonical existing ancestor and created securely.
  function canonicalFile(input) {
    let directory = path.dirname(path.resolve(input));
    const missing = [];
    for (;;) {
      try { return path.join(fs.realpathSync.native(directory), ...missing, path.basename(input)); }
      catch (e) {
        if (e.code !== 'ENOENT' || directory === path.dirname(directory)) throw e;
        missing.unshift(path.basename(directory)); directory = path.dirname(directory);
      }
    }
  }
  bytes = Buffer.from(bytes);
  if (bytes.length > BUDGET) throw new Error('Key storage exceeds budget');
  if (process.platform === 'win32') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return windowsOperation(file, 'write', bytes);
  }
  file = canonicalFile(file);
  const closeDirectories = publicationDirectory(path.dirname(file));
  const tmp = file + '.' + randomUUID() + '.tmp';
  let fd;
  try { fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
  catch (e) { closeDirectories(); throw e; }
  const matches = st => { const own = fs.fstatSync(fd); return own.dev === st.dev && own.ino === st.ino; };
  try {
    secureHandle(fd, true);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    if (!matches(fs.lstatSync(tmp))) throw new Error('Key staging pathname was replaced');
    fs.renameSync(tmp, file);
    if (!matches(fs.lstatSync(file))) throw new Error('Published key pathname was replaced');
    secureHandle(fd, false);
  } finally {
    try { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); }
    finally { closeDirectories(); }
  }
}
module.exports = { assertPrivateFileSync, ensurePrivateFileSync, readPrivateFileSync, writePrivateFileSync };
