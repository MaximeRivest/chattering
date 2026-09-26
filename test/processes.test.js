'use strict';
// processes.js on the system running the tests: listing, identity across
// a process's life, stopping a tree; and the Windows command-line reading
// on every system.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const P = require('../processes.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; }

test('this system can list processes and tell one apart from a reused pid', { timeout: 60000 }, async () => {
  assert.equal(P.reliable, true, 'Linux, macOS and Windows are supported');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'processes-test-marker'], { stdio: 'ignore' });
  try {
    assert.ok(await until(() => P.list().some(p => p.pid === child.pid && p.argv.includes('processes-test-marker'))), 'the child is listed with its arguments');
    const first = P.identity(child.pid);
    assert.ok(first && first.start, 'a live process has an identity');
    assert.deepEqual(P.identity(child.pid), first, 'the identity is stable while it lives');
  } finally { child.kill(); }
  await new Promise(r => child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r));
  assert.ok(await until(() => P.identity(child.pid) === null), 'a process that ended has no identity');
});

test('stopTree ends a detached process and the process it started', { timeout: 60000 }, async () => {
  // A parent that starts a grandchild and prints its pid.
  const script = "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});console.log(c.pid);setTimeout(()=>{},60000)";
  const parent = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const grandchild = await new Promise(r => parent.stdout.once('data', d => r(Number(String(d).trim()))));
  assert.ok(P.identity(grandchild), 'the grandchild runs');
  assert.equal(P.stopTree(parent.pid, 'SIGTERM'), true);
  assert.ok(await until(() => P.identity(parent.pid) === null && P.identity(grandchild) === null), 'both are gone');
});

test('Windows command lines split as the C runtime splits them', () => {
  const s = P.splitWindowsCommandLine;
  assert.deepEqual(s('"C:\\Program Files\\nodejs\\node.exe" C:\\x\\cli.js --session "C:\\a b\\s.jsonl"'), ['C:\\Program Files\\nodejs\\node.exe', 'C:\\x\\cli.js', '--session', 'C:\\a b\\s.jsonl']);
  assert.deepEqual(s('a\\\\"b c"'), ['a\\b c'], 'an even run of backslashes before a quote halves');
  assert.deepEqual(s('a\\"b'), ['a"b'], 'an odd run escapes the quote');
  assert.deepEqual(s('  x   ""  y '), ['x', '', 'y'], 'an empty quoted argument is kept');
  assert.deepEqual(P.parseWinList('12\t4\tnode.exe cli.js --mode rpc\r\n13\t4\t\r\nbad line\n'), [{ pid: 12, ppid: 4, argv: ['node.exe', 'cli.js', '--mode', 'rpc'] }]);
});
