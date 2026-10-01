'use strict';
// End a test's server and remove its home: wait until the process has
// exited before deleting, and retry the delete. Killing and deleting in
// one breath races the dying process (ENOTEMPTY on Linux; on Windows a
// file still open cannot be removed at all).
const fs = require('node:fs');

function exited(child, ms) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer); child.removeListener('exit', onExit);
      if (error) reject(error); else resolve();
    };
    const onExit = () => finish();
    const timer = setTimeout(() => finish(new Error(`process ${child.pid || '(controlled child)'} exit was not observed within ${ms} ms`)), ms);
    child.once('exit', onExit);
  });
}
async function stopAndRemove(child, dir, { graceMs = 3000 } = {}) {
  if (child && child.exitCode === null && child.signalCode === null) {
    // Subscribe before any stop request. Expiry is uncertainty, not exit.
    const joined = exited(child, graceMs);
    joined.catch(() => {}); // retain rejection while the bounded stop command runs
    let stopError;
    // Windows: taskkill ends the tree, but a failed tree request must not
    // silently leave our directly owned child alive. Keep the event loop free
    // to observe its exit while taskkill runs, then use its native kill handle.
    if (process.platform === 'win32' && Number.isSafeInteger(child.pid) && child.pid > 0) {
      const taskkill = process.env.SystemRoot ? require('node:path').join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill';
      // Reserve half of the existing exit window for native fallback and
      // its exit notification; a tree-stop timeout must not consume it all.
      const treeMs = Math.max(1, Math.floor(graceMs / 2));
      await new Promise(resolve => require('node:child_process').execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: treeMs }, error => { stopError = error; resolve(); }));
    }
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch (error) { stopError = error; }
    }
    try { await joined; }
    catch (error) { if (stopError) error.cause = stopError; throw error; }
  }
  // Linear backoff, about twenty seconds at most: a Pi worker takes a few
  // seconds to notice its server is gone, and Chrome's crash reporter can
  // outlive the browser writing into its profile.
  // Detached helpers outlive their server by design (delegated work
  // survives a restart): end whatever still runs from inside this home.
  if (dir) {
    try {
      const P = require('../../processes.js');
      for (const p of P.list()) if (p.pid !== process.pid && p.argv.some(a => a.includes(dir))) P.stopTree(p.pid, 'SIGKILL');
    } catch {}
    // Windows answers EPERM, not EBUSY, for a folder a dying process (or a
    // virus scan) still holds: retried like the others, for about twenty
    // seconds by the clock. Node 24's rm does not retry by itself on every
    // code, so the count of attempts says nothing about the time.
    const until = Date.now() + 60000;
    for (;;) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); return; }
      catch (e) {
        if (!['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(e.code)) throw e;
        if (Date.now() > until) {
          // Say what is still there and who holds it: the next fix starts from that.
          let left = [];
          try { left = fs.readdirSync(dir, { recursive: true }).slice(0, 15); } catch {}
          let holders = [];
          try { holders = require('../../processes.js').list().filter(p => p.argv.some(a => a.includes(dir))).map(p => p.argv.join(' ').slice(0, 160)); } catch {}
          e.message += `\nstill in the folder: ${left.join(', ') || '(nothing listed)'}\nprocesses naming it: ${holders.join(' | ') || 'none'}`;
          throw e;
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }
}
module.exports = { stopAndRemove, exited };
