'use strict';
// plan-limits-store.js — the hub's own record of plan limits (design/109):
// each pool's state as last merged, the history of its windows, which
// sign-in of which account leads to which pool, and how each reader fared.
// Derived and private to the hub (no token, no address, no account id: pool
// keys are hashes). Deleting the file loses the history, nothing else.
//
// History is kept small: a window's row is written when its numbers change,
// and at most every HEARTBEAT_MS when they do not, for KEEP_DAYS.
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {}
const fs = require('fs');
const path = require('path');

const SCHEMA = 1;
const HEARTBEAT_MS = 15 * 60 * 1000;
const KEEP_DAYS = 180;

function openStore(file) {
  if (!DatabaseSync) return memoryStore();
  // hub-own: the folder of the hub's own plan-limits record (its cache folder)
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
  const v = db.prepare('PRAGMA user_version').get().user_version;
  if (v !== SCHEMA) {
    db.exec('DROP TABLE IF EXISTS readings; DROP TABLE IF EXISTS pools; DROP TABLE IF EXISTS routes; DROP TABLE IF EXISTS checks; DROP TABLE IF EXISTS notices;');
    db.exec('PRAGMA user_version=' + SCHEMA);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS readings (pool TEXT NOT NULL, win TEXT NOT NULL, at INTEGER NOT NULL, used REAL, resets_at INTEGER,
      limited INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, PRIMARY KEY (pool, win, at));
    CREATE INDEX IF NOT EXISTS readings_at ON readings(at);
    CREATE TABLE IF NOT EXISTS pools (pool TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL);
    -- account: '' for this server's own; cred: pi:anthropic, claude:default, codex, …
    CREATE TABLE IF NOT EXISTS routes (account TEXT NOT NULL, cred TEXT NOT NULL, pool TEXT, plan TEXT, plan_label TEXT, seen_at INTEGER NOT NULL,
      PRIMARY KEY (account, cred));
    CREATE TABLE IF NOT EXISTS checks (reader TEXT PRIMARY KEY, at INTEGER NOT NULL, ok INTEGER NOT NULL, code TEXT, message TEXT, last_ok_at INTEGER);
    CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
  `);
  const q = {
    lastRow: db.prepare('SELECT at, used, resets_at, limited FROM readings WHERE pool=? AND win=? ORDER BY at DESC LIMIT 1'),
    insert: db.prepare('INSERT OR REPLACE INTO readings (pool, win, at, used, resets_at, limited, source) VALUES (?,?,?,?,?,?,?)'),
    history: db.prepare('SELECT win, at, used, resets_at AS resetsAt, limited, source FROM readings WHERE pool=? AND at>=? AND at<=? ORDER BY at'),
    historyWin: db.prepare('SELECT at, used, resets_at AS resetsAt, limited, source FROM readings WHERE pool=? AND win=? AND at>=? AND at<=? ORDER BY at'),
    savePool: db.prepare('INSERT OR REPLACE INTO pools (pool, state, updated_at) VALUES (?,?,?)'),
    pools: db.prepare('SELECT pool, state FROM pools'),
    saveRoute: db.prepare('INSERT OR REPLACE INTO routes (account, cred, pool, plan, plan_label, seen_at) VALUES (?,?,?,?,?,?)'),
    routes: db.prepare('SELECT account, cred, pool, plan, plan_label AS planLabel, seen_at AS seenAt FROM routes'),
    dropRoute: db.prepare('DELETE FROM routes WHERE account=? AND cred=?'),
    saveCheck: db.prepare('INSERT OR REPLACE INTO checks (reader, at, ok, code, message, last_ok_at) VALUES (?,?,?,?,?,?)'),
    checks: db.prepare('SELECT reader, at, ok, code, message, last_ok_at AS lastOkAt FROM checks'),
    notice: db.prepare('INSERT OR IGNORE INTO notices (id, at) VALUES (?,?)'),
    prune: db.prepare('DELETE FROM readings WHERE at<?'),
    pruneNotices: db.prepare('DELETE FROM notices WHERE at<?'),
  };
  return {
    // A window's numbers, written when they changed or when the last row is old.
    record(pool, w, at, source) {
      const last = q.lastRow.get(pool, w.id);
      const used = w.usedPercent == null ? null : Math.round(w.usedPercent * 100) / 100;
      const same = last && last.used === used && last.resets_at === (w.resetsAt || null) && !!last.limited === !!w.limited;
      if (same && at - last.at < HEARTBEAT_MS) return false;
      if (last && at < last.at) return false;
      q.insert.run(pool, w.id, at, used, w.resetsAt || null, w.limited ? 1 : 0, source);
      return true;
    },
    history: (pool, from, to, win = null) => (win ? q.historyWin.all(pool, win, from, to) : q.history.all(pool, from, to)).map(r => ({ ...r, limited: !!r.limited })),
    savePool: (pool, state, at) => q.savePool.run(pool, JSON.stringify(state), at),
    pools() { const out = {}; for (const r of q.pools.all()) { try { out[r.pool] = JSON.parse(r.state); } catch {} } return out; },
    saveRoute: (account, cred, r, at) => q.saveRoute.run(account || '', cred, r.poolKey || null, r.plan || null, r.planLabel || null, at),
    routes: () => q.routes.all(),
    dropRoute: (account, cred) => q.dropRoute.run(account || '', cred),
    saveCheck: (reader, c) => q.saveCheck.run(reader, c.at, c.ok ? 1 : 0, c.code || null, c.message || null, c.lastOkAt || null),
    checks() { const out = {}; for (const r of q.checks.all()) out[r.reader] = { ...r, ok: !!r.ok }; return out; },
    // A notice said once (a limit reached, a limit back): true the first time.
    once: (id, at) => q.notice.run(id, at).changes > 0,
    prune(now) { q.prune.run(now - KEEP_DAYS * 86400000); q.pruneNotices.run(now - 30 * 86400000); },
    close: () => db.close(),
  };
}

// Without node:sqlite (an old Node): the same calls, kept in memory for
// this run only. The limits still show; their history starts again.
function memoryStore() {
  const rows = [], pools = {}, routes = new Map(), checks = {}, notices = new Set();
  return {
    record(pool, w, at, source) {
      const last = rows.filter(r => r.pool === pool && r.win === w.id).pop();
      const used = w.usedPercent == null ? null : Math.round(w.usedPercent * 100) / 100;
      if (last && last.used === used && last.resetsAt === (w.resetsAt || null) && last.limited === !!w.limited && at - last.at < HEARTBEAT_MS) return false;
      rows.push({ pool, win: w.id, at, used, resetsAt: w.resetsAt || null, limited: !!w.limited, source });
      return true;
    },
    history: (pool, from, to, win = null) => rows.filter(r => r.pool === pool && r.at >= from && r.at <= to && (!win || r.win === win)).map(({ pool: _p, ...r }) => (win ? (({ win: _w, ...x }) => x)(r) : r)),
    savePool: (pool, state) => { pools[pool] = JSON.parse(JSON.stringify(state)); },
    pools: () => JSON.parse(JSON.stringify(pools)),
    saveRoute: (account, cred, r, at) => routes.set((account || '') + '\n' + cred, { account: account || '', cred, pool: r.poolKey || null, plan: r.plan || null, planLabel: r.planLabel || null, seenAt: at }),
    routes: () => [...routes.values()],
    dropRoute: (account, cred) => routes.delete((account || '') + '\n' + cred),
    saveCheck: (reader, c) => { checks[reader] = { reader, ...c }; },
    checks: () => ({ ...checks }),
    once: id => { if (notices.has(id)) return false; notices.add(id); return true; },
    prune() {},
    close() {},
  };
}

module.exports = { openStore, memoryStore, HEARTBEAT_MS, KEEP_DAYS };
