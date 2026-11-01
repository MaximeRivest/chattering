'use strict';
// search-service.js — the server's side of search-worker.js (design/110).
//
// - search() and sizes() run on the worker's thread, never the server's.
// - The full-text index is checked once at start, and whenever a search
//   reports damage. A damaged index is rebuilt from its units table while
//   the server's writes are held (searchindex.js hold/release), so nothing
//   written meanwhile is lost or damages it again.
// - During a rebuild, searches answer at once that it is under way and how
//   far (state()), instead of waiting or returning half the matches.
// - If the rebuild does not cure it (the table itself is damaged), the
//   owner's onUnrepairable() drops the file and indexes again from the
//   conversation caches.
// - Without worker threads (or if the worker cannot start), the writer's
//   own connection answers, as before: slower for everyone, never absent.
const path = require('node:path');

function createSearchService({ dbPath, writer, log = console.log, onUnrepairable = null, Worker = safeWorker() } = {}) {
  let worker = null, seq = 0, closed = false, failures = 0;
  const pending = new Map();
  let repairing = null;        // { done, total, startedAt, reason }
  let lastRepair = null;       // { at, ok, ms, units, reason, error? }
  let checking = null;         // the start check, while it runs

  function start() {
    if (!Worker || closed) return;
    try {
      worker = new Worker(path.join(__dirname, 'search-worker.js'), { workerData: { dbPath } });
    } catch (e) { log('search worker unavailable, searching on the main thread: ' + e.message); worker = null; return; }
    worker.on('message', msg => {
      if (msg.event === 'repair') { if (repairing) { repairing.done = msg.done; repairing.total = msg.total; } return; }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (!pending.size && worker) worker.unref();
      if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(msg.error), { corrupt: !!msg.corrupt }));
    });
    worker.on('error', e => log('search worker error: ' + e.message));
    worker.on('exit', code => {
      const was = worker;
      worker = null;
      for (const [id, p] of pending) { pending.delete(id); p.reject(new Error('the search worker stopped')); }
      // Writes held for a repair the worker can no longer finish go through.
      if (repairing && writer) { writer.release(); repairing = null; }
      if (closed || !was) return;
      if (++failures > 5) { log('search worker keeps stopping (' + code + '); searching on the main thread'); return; }
      log('search worker stopped (' + code + '); starting it again');
      setTimeout(start, 500 * failures);
    });
    worker.unref();
  }

  function call(op, args, { channel = null, signal = null } = {}) {
    if (!worker) return null;
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const p = { resolve, reject, signal };
      if (signal) {
        if (signal.aborted) return reject(abortError());
        p.onAbort = () => { if (worker) worker.postMessage({ op: 'cancel', args: id }); };
        signal.addEventListener('abort', p.onAbort, { once: true });
      }
      pending.set(id, p);
      // An idle worker never keeps the process alive; one with work does.
      worker.ref();
      worker.postMessage({ id, op, args, channel });
    });
  }

  function repairState() {
    if (!repairing) return null;
    const pct = repairing.total ? Math.floor(100 * repairing.done / repairing.total) : 0;
    return { done: repairing.done, total: repairing.total, percent: pct, startedAt: repairing.startedAt,
      message: `The search index is being repaired (${pct}%). Search works again in a minute or two.` };
  }

  async function search(q, opts = {}, how = {}) {
    if (repairing) return { total: 0, totalCapped: false, groupCount: 0, kindCounts: {}, groups: [], repairing: repairState(), error: repairState().message };
    const viaWorker = call('search', { q, opts }, how);
    try {
      const out = viaWorker ? await viaWorker : inline(q, opts);
      return out;
    } catch (e) {
      if (e.corrupt) {
        repair('a search found it damaged: ' + e.message);
        return { total: 0, totalCapped: false, groupCount: 0, kindCounts: {}, groups: [], repairing: repairState(), error: (repairState() || {}).message || 'The search index is damaged; repairing it.' };
      }
      throw e;
    }
  }
  function inline(q, opts) {
    const t0 = Date.now();
    const out = writer.search(q, opts);
    out.tookMs = Date.now() - t0;
    return out;
  }

  async function sizes(srcs) {
    if (repairing) return writer ? writer.sizes(srcs) : {};
    const viaWorker = call('sizes', { srcs });
    return viaWorker ? viaWorker : writer.sizes(srcs);
  }

  // Check once, at start. Writes wait the few seconds it takes (the check
  // takes the write lock).
  async function check() {
    if (!worker || checking || repairing) return checking;
    checking = (async () => {
      const t0 = Date.now();
      writer.hold();
      let r;
      try { r = await call('check', {}); }
      catch (e) { r = { ok: false, error: e.message, corrupt: isCorruptionText(e.message) }; }
      finally { writer.release(); }
      if (r.ok) log(`search index checked in ${Date.now() - t0} ms: sound`);
      else if (r.corrupt) { log('search index damaged (' + r.error + '); repairing'); repair('the start check: ' + r.error); }
      else log('search index check failed: ' + r.error);
      return r;
    })().finally(() => { checking = null; });
    return checking;
  }

  async function repair(reason) {
    if (repairing || !worker) return;
    repairing = { done: 0, total: 0, startedAt: Date.now(), reason };
    writer.hold();
    let r;
    try { r = await call('repair', {}); }
    catch (e) { r = { ok: false, error: e.message }; }
    const replay = writer.held ? writer.release() : { replayed: 0, failed: 0 };
    repairing = null;
    lastRepair = { at: Date.now(), ok: !!r.ok, ms: r.ms, units: r.units, reason, ...(r.ok ? {} : { error: r.error }) };
    if (r.ok) log(`search index repaired: ${r.units} passages in ${Math.round(r.ms / 1000)} s (${replay.replayed} writes made meanwhile applied)`);
    else {
      log('search index repair did not cure it: ' + r.error);
      if (onUnrepairable) onUnrepairable(r.error);
    }
  }

  function state() {
    return { worker: !!worker, repairing: repairState(), lastRepair, checking: !!checking };
  }

  // The writer changed (the file was dropped and made again): the worker
  // reads the new file.
  function reopen(newWriter) {
    writer = newWriter;
    if (worker) { const w = worker; worker = null; w.terminate().catch(() => {}); }
    failures = 0;
    start();
  }

  function close() {
    closed = true;
    if (worker) worker.terminate().catch(() => {});
    worker = null;
  }

  start();
  return { search, sizes, check, repair, state, reopen, close };
}

function safeWorker() {
  try { return require('node:worker_threads').Worker; } catch { return null; }
}
const isCorruptionText = s => /malformed|corrupt/i.test(String(s || ''));
function abortError() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }

module.exports = { createSearchService };
