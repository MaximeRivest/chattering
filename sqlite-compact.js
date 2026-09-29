'use strict';
// Gives a SQLite database's free pages back to the disk, in a worker thread:
// node:sqlite is synchronous, and a VACUUM of a large file would otherwise
// freeze the server for seconds.
//   mode 'convert':     one full VACUUM that also switches the file to
//                       incremental auto-vacuum (possible in WAL mode).
//   mode 'incremental': releases the free pages of an already converted file.
const { Worker } = require('node:worker_threads');
const CODE = `
const { DatabaseSync } = require('node:sqlite');
const { workerData, parentPort } = require('node:worker_threads');
const db = new DatabaseSync(workerData.file);
try {
  db.exec('PRAGMA busy_timeout=60000');
  if (workerData.mode === 'convert') { db.exec('PRAGMA auto_vacuum=INCREMENTAL'); db.exec('VACUUM'); }
  else db.exec('PRAGMA incremental_vacuum');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  parentPort.postMessage({ ok: true });
} catch (e) { parentPort.postMessage({ error: e.message }); }
finally { db.close(); }`;
function compactDatabase(file, { mode = 'incremental' } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(CODE, { eval: true, workerData: { file, mode } });
    let answer = null;
    worker.once('message', m => { answer = m; });
    worker.once('error', reject);
    worker.once('exit', () => (answer?.ok ? resolve() : reject(Error(answer?.error || 'Database compaction stopped'))));
  });
}
module.exports = { compactDatabase };
