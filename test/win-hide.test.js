'use strict';
// On Windows no program Chattering or its agents start opens a window
// (win-hide.js, design/70). The argument handling is checked everywhere; on
// Windows, whether a started program really has a visible console window.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { withHidden, install } = require('../win-hide.js');

const H = { windowsHide: true };
test('every call shape gets windowsHide, and an explicit answer is kept', () => {
  const f = () => {};
  assert.deepEqual(withHidden(['git']), ['git', H]);
  assert.deepEqual(withHidden(['git', ['status']]), ['git', ['status'], H]);
  assert.deepEqual(withHidden(['git', ['status'], { cwd: '/x' }]), ['git', ['status'], { cwd: '/x', windowsHide: true }]);
  assert.deepEqual(withHidden(['git', ['status'], f]), ['git', ['status'], H, f]);
  assert.deepEqual(withHidden(['git', f]), ['git', H, f]);
  assert.deepEqual(withHidden(['git', { cwd: '/x' }, f]), ['git', { cwd: '/x', windowsHide: true }, f]);
  assert.deepEqual(withHidden(['git', null, { cwd: '/x' }, f]), ['git', null, { cwd: '/x', windowsHide: true }, f]);
  assert.deepEqual(withHidden(['git', undefined, undefined, f]), ['git', undefined, H, f]);
  assert.deepEqual(withHidden(['echo hi'], { afterArgs: false }), ['echo hi', H]);
  assert.deepEqual(withHidden(['echo hi', f], { afterArgs: false }), ['echo hi', H, f]);
  assert.deepEqual(withHidden(['echo hi', { cwd: '/x' }], { afterArgs: false }), ['echo hi', { cwd: '/x', windowsHide: true }]);
  assert.deepEqual(withHidden(['chrome', ['--app=x'], { windowsHide: false }]), ['chrome', ['--app=x'], { windowsHide: false }], 'a window asked for stays');
});

test('patched, every way of starting a program still works, promisified included', async () => {
  // A private copy of child_process, patched here on any system.
  const cp = { ...require('node:child_process') };
  const seen = [];
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']) {
    const real = cp[name];
    cp[name] = Object.assign(function (...a) { seen.push([name, a.find(x => x && typeof x === 'object' && !Array.isArray(x))?.windowsHide]); return real.apply(this, a); },
      real[require('node:util').promisify.custom] ? { [require('node:util').promisify.custom]: (...a) => { seen.push([name + '/promise', a.find(x => x && typeof x === 'object' && !Array.isArray(x))?.windowsHide]); return real[require('node:util').promisify.custom](...a); } } : {});
  }
  assert.equal(install(cp), true);
  assert.equal(install(cp), false, 'once');
  const node = process.execPath;
  assert.equal(cp.execFileSync(node, ['-e', 'process.stdout.write("a")'], { encoding: 'utf8' }), 'a');
  assert.equal(cp.spawnSync(node, ['-e', 'process.stdout.write("b")'], { encoding: 'utf8' }).stdout, 'b');
  const { stdout } = await require('node:util').promisify(cp.execFile)(node, ['-e', 'process.stdout.write("c")']);
  assert.equal(stdout, 'c', 'promisified execFile still resolves { stdout, stderr }');
  await new Promise((res, rej) => cp.execFile(node, ['-e', '1'], e => e ? rej(e) : res()));
  await new Promise(res => cp.spawn(node, ['-e', '1']).on('exit', res));
  assert.ok(seen.length >= 5 && seen.every(([, hide]) => hide === true), JSON.stringify(seen));
});

// ---- Windows: does a started program have a visible console window? -----
// The probe is a PowerShell that writes, into a file, whether its own
// console has a window with the visible style (GetConsoleWindow,
// IsWindowVisible). A process with no console, or a hidden one, writes false.
const win = process.platform === 'win32';
const PROBE = `Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);'
$h = [W.K]::GetConsoleWindow()
Set-Content -Path $env:PROBE_OUT -Value ([bool]($h -ne [System.IntPtr]::Zero -and [W.K]::IsWindowVisible($h)))`;
const powershell = win ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '';
// Run `code` in a Node started the way Chattering's server is (detached: no
// console), with or without win-hide, and read what each probe it starts saw.
async function fromConsoleless(code, { hide }, t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-hide-'));
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(null, dir));
  const script = path.join(dir, 'parent.' + (code.includes('import ') ? 'mjs' : 'cjs'));
  fs.writeFileSync(script, code);
  fs.writeFileSync(path.join(dir, 'probe.ps1'), PROBE);
  const child = spawn(process.execPath, [...(hide ? ['--require', require.resolve('../win-hide.js')] : []), script], {
    detached: true, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, PROBE_DIR: dir, PROBE_PS: powershell, CHATTERING_WIN_HIDE: hide ? '1' : '0' },
  });
  await new Promise(res => child.on('exit', res));
  const out = {};
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.out'))) out[f.replace(/\.out$/, '')] = fs.readFileSync(path.join(dir, f), 'utf8').trim();
  return out;
}
// Each way of starting the probe, waited for; names become result keys.
const STARTS = `
const cp = require('node:child_process'), path = require('node:path');
const run = (name, f) => { const env = { ...process.env, PROBE_OUT: path.join(process.env.PROBE_DIR, name + '.out') }; return f(env); };
const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(process.env.PROBE_DIR, 'probe.ps1')];
(async () => {
  run('spawnSync', env => cp.spawnSync(process.env.PROBE_PS, args, { env }));
  run('execFileSync', env => { try { cp.execFileSync(process.env.PROBE_PS, args, { env }); } catch {} });
  await run('spawn', env => new Promise(r => cp.spawn(process.env.PROBE_PS, args, { env, stdio: 'ignore' }).on('exit', r)));
  await run('execFile', env => new Promise(r => cp.execFile(process.env.PROBE_PS, args, { env }, () => r())));
  // A grandchild: started by the hidden child, as bash starts git.
  await run('grandchild', env => new Promise(r => cp.spawn('cmd.exe', ['/d /s /c "' + ['"' + process.env.PROBE_PS + '"', ...args.slice(0, 5), '"' + args[5] + '"'].join(' ') + '"'], { env, stdio: 'ignore', windowsVerbatimArguments: true }).on('exit', r)));
})();`;

test('Windows: without win-hide a console-less process pops windows (the probe can see them)', { skip: !win && 'Windows only', timeout: 180000 }, async t => {
  const seen = await fromConsoleless(STARTS, { hide: false }, t);
  assert.equal(seen.spawnSync, 'True', 'the probe must be able to see a visible window, or the other tests prove nothing: ' + JSON.stringify(seen));
});

test('Windows: with win-hide nothing started opens a window, grandchildren included', { skip: !win && 'Windows only', timeout: 180000 }, async t => {
  const seen = await fromConsoleless(STARTS, { hide: true }, t);
  assert.deepEqual(seen, { spawnSync: 'False', execFileSync: 'False', spawn: 'False', execFile: 'False', grandchild: 'False' });
});

test('Windows: an ES module importing child_process (as Pi does) is covered too', { skip: !win && 'Windows only', timeout: 120000 }, async t => {
  const seen = await fromConsoleless(`import { spawnSync } from 'node:child_process';
import path from 'node:path';
spawnSync(process.env.PROBE_PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(process.env.PROBE_DIR, 'probe.ps1')], { env: { ...process.env, PROBE_OUT: path.join(process.env.PROBE_DIR, 'esm.out') } });`, { hide: true }, t);
  assert.deepEqual(seen, { esm: 'False' });
});

// Every Node program Chattering starts loads win-hide first, and every Pi
// process gets it with --require: a new program cannot forget.
test('every program Chattering starts loads win-hide before anything else', () => {
  const root = path.join(__dirname, '..');
  const sources = fs.readdirSync(root).filter(f => f.endsWith('.js') || f === 'chattering').filter(f => fs.statSync(path.join(root, f)).isFile());
  const started = new Set(['chattering']);
  for (const f of sources) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const line of text.split('\n')) {
      if (/readFileSync|require\(|statSync|createHash/.test(line)) continue;
      for (const m of line.matchAll(/path\.join\((?:__dirname|APP_DIR), '([\w-]+\.js)'\)/g)) if (m[1] !== 'win-hide.js') started.add(m[1]);
    }
    if (/require\.main === module/.test(text)) started.add(f);
  }
  assert.ok(['server.js', 'launcher.js', 'pisdk-worker.js', 'delegation-supervisor.js', 'ai-accounts-worker.js'].every(f => started.has(f)), [...started].join(', '));
  for (const f of started) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    const first = text.search(/require\(/);
    assert.ok(first >= 0 && text.slice(first).startsWith("require('./win-hide.js')"), `${f} is started as a program: its first require must be ./win-hide.js`);
  }
  const R = require('../runtime.js');
  assert.deepEqual(R.piNodeArgs({ isWin: true }), ['--require', path.join(root, 'win-hide.js')], 'Pi processes on Windows load it');
  assert.deepEqual(R.piNodeArgs({ isWin: false }), []);
  assert.ok(fs.existsSync(R.piNodeArgs({ isWin: true })[1]));
});
