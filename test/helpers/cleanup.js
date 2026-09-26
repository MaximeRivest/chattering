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
    try { child.kill('SIGKILL'); } catch {}
    await exited(child, graceMs);
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
module.exports = { stopAndRemove, exited };
