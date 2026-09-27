'use strict';
// End a test's server and remove its home: wait until the process has
// exited before deleting, and retry the delete. Killing and deleting in
// one breath races the dying process (ENOTEMPTY on Linux; on Windows a
// file still open cannot be removed at all).
const fs = require('node:fs');

function exited(child, ms) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
async function stopAndRemove(child, dir, { graceMs = 3000 } = {}) {
  if (child && child.exitCode === null && child.signalCode === null) {
    // Windows: the whole tree (Chrome's helpers hold its profile open).
    if (process.platform === 'win32') { try { require('../../processes.js').stopTree(child.pid); } catch {} }
    else { try { child.kill('SIGKILL'); } catch {} }
    await exited(child, graceMs);
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
    // Windows answers EPERM, not EBUSY, for a folder a dying process still
    // holds: retried like the others (rmSync itself retries only some codes).
    for (let i = 0; ; i++) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); return; }
      catch (e) { if (i >= 20 || !['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(e.code)) throw e; await new Promise(r => setTimeout(r, 250)); }
    }
  }
}
module.exports = { stopAndRemove, exited };
