'use strict';
// search-worker.js — the search index's reader, on a thread of its own
// (design/110).
//
// SQLite in Node is synchronous: a search on the server's thread stopped
// every other request until it finished (0.2 s for a common word, seconds
// when cold). Here a search only occupies this thread. The server's thread
// keeps the one writer (searchindex.js); this thread reads with its own
// connection, which WAL lets run beside the writer without either waiting.
//
// It also checks and repairs the full-text index, with a short-lived
// writer of its own, while the server holds its writes (search-service.js).
//
// Messages in:  { id, op: 'search'|'sizes'|'check'|'repair'|'cancel', args, channel }
// Messages out: { id, ok, result } | { id, ok: false, error, corrupt }
//               { event: 'repair', done, total }   (progress)
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { searchDb, sourceSizes, isCorruption, ftsCheck, ftsRepairStart, ftsRepairStep } = require('./searchindex.js');

const dbPath = workerData.dbPath;
let reader = null;
const statements = new Map();
// Statements are prepared once per text: the shapes repeat (a filter set,
// a number of ids), and preparing an FTS query is not free.
function readDb() {
  if (!reader) {
    reader = new DatabaseSync(dbPath, { readOnly: true });
    try { reader.exec('PRAGMA busy_timeout = 2000'); } catch {}
  }
  return {
    prepare(sql) {
      let st = statements.get(sql);
      if (!st) {
        st = reader.prepare(sql);
        statements.set(sql, st);
        if (statements.size > 300) statements.delete(statements.keys().next().value);
      }
      return st;
    },
  };
}
function resetReader() {
  statements.clear();
  try { if (reader) reader.close(); } catch {}
  reader = null;
}
function writeDb() {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000');
  return db;
}

const queue = [];
let draining = false;
parentPort.on('message', msg => {
  if (msg.op === 'cancel') {
    const at = queue.findIndex(m => m.id === msg.args);
    if (at >= 0) { const [gone] = queue.splice(at, 1); reply(gone.id, { ok: true, result: { cancelled: true } }); }
    return;
  }
  queue.push(msg);
  if (!draining) { draining = true; setImmediate(drain); }
});

function reply(id, out) { parentPort.postMessage({ id, ...out }); }

async function drain() {
  while (queue.length) {
    const msg = queue.shift();
    // Someone typing sends a search per pause: only the newest of one
    // channel (a panel, a person) is worth running.
    if (msg.channel && queue.some(m => m.channel === msg.channel && m.op === msg.op)) {
      reply(msg.id, { ok: true, result: { superseded: true } });
      continue;
    }
    try {
      reply(msg.id, { ok: true, result: await run(msg) });
    } catch (e) {
      if (isCorruption(e)) resetReader();
      reply(msg.id, { ok: false, error: e.message, corrupt: isCorruption(e) });
    }
    // Let new messages in (and stale ones be dropped) between tasks.
    await new Promise(r => setImmediate(r));
  }
  draining = false;
}

async function run({ op, args = {} }) {
  if (op === 'search') {
    const t0 = Date.now();
    const out = searchDb(readDb(), args.q, args.opts || {});
    out.tookMs = Date.now() - t0;
    return out;
  }
  if (op === 'sizes') return sourceSizes(readDb(), args.srcs);
  if (op === 'check') {
    const db = writeDb();
    try { return ftsCheck(db); } finally { db.close(); }
  }
  if (op === 'repair') return repair();
  throw new Error('unknown search worker operation: ' + op);
}

async function repair() {
  const t0 = Date.now();
  const db = writeDb();
  try {
    const { total } = ftsRepairStart(db);
    let after = 0, done = 0;
    parentPort.postMessage({ event: 'repair', done, total });
    for (;;) {
      const last = ftsRepairStep(db, after, 20000);
      if (last == null) break;
      done += db.prepare('SELECT count(*) AS n FROM units WHERE id > ? AND id <= ?').get(after, last).n;
      after = last;
      parentPort.postMessage({ event: 'repair', done, total });
      await new Promise(r => setImmediate(r));
    }
    // Many small steps leave many index segments; one merge makes the
    // index as fast to search as a fresh build.
    db.exec("INSERT INTO units_fts(units_fts) VALUES ('optimize')");
    const check = ftsCheck(db);
    resetReader();
    return { ...check, units: total, ms: Date.now() - t0 };
  } finally { db.close(); }
}
