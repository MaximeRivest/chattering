#!/usr/bin/env node
'use strict';
// Run every test file on its own, a few at a time, each with a time limit,
// and print each file's whole report as soon as it finishes (design/70).
// One `node --test` over everything hides which file hangs and cuts its
// details off when CI stops the job; here a stuck file is named, stopped
// (with everything it started), and the rest go on.
//   node scripts/test-each.js [file…]   TEST_JOBS=4  TEST_FILE_TIMEOUT_S=420
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const processes = require('../processes.js');

const ROOT = path.join(__dirname, '..');
const files = process.argv.length > 2 ? process.argv.slice(2)
  : fs.readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join('test', f));
const jobs = Math.max(1, Number(process.env.TEST_JOBS) || 4);
const limitMs = (Number(process.env.TEST_FILE_TIMEOUT_S) || 420) * 1000;
const results = [];

function runOne(file) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', file], { cwd: ROOT, env: process.env, detached: process.platform !== 'win32' });
    let out = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; processes.stopTree(child.pid, 'SIGKILL'); }, limitMs);
    child.on('close', code => {
      clearTimeout(timer);
      const secs = Math.round((Date.now() - t0) / 1000);
      const count = k => Number((out.match(new RegExp('^ℹ ' + k + ' (\\d+)', 'm')) || [])[1] || 0);
      const r = { file, code, secs, timedOut, pass: count('pass'), fail: count('fail'), skipped: count('skipped') };
      results.push(r);
      const status = timedOut ? `TIMED OUT after ${secs}s` : code === 0 ? `ok (${r.pass} passed${r.skipped ? ', ' + r.skipped + ' skipped' : ''}, ${secs}s)` : `FAILED (${r.fail} failed, ${secs}s)`;
      process.stdout.write(`\n=== ${file}: ${status}\n`);
      if (code !== 0 || timedOut || r.skipped) process.stdout.write(out.replace(/\s+$/, '') + '\n');
      resolve();
    });
  });
}

(async () => {
  const queue = [...files];
  await Promise.all(Array.from({ length: jobs }, async () => { while (queue.length) await runOne(queue.shift()); }));
  const bad = results.filter(r => r.code !== 0 || r.timedOut);
  const sum = k => results.reduce((n, r) => n + r[k], 0);
  process.stdout.write(`\n${results.length} files · ${sum('pass')} tests passed · ${sum('fail')} failed · ${sum('skipped')} skipped · ${bad.length} file(s) not ok\n`);
  for (const r of bad) process.stdout.write(`  ✖ ${r.file}${r.timedOut ? ' (timed out)' : ''}\n`);
  process.exit(bad.length ? 1 : 0);
})();
