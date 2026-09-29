'use strict';
// Durable observations, separate from the rebuildable activity index.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const MAX_FILE_BYTES = 2 * 1024 * 1024;
class FileArchive {
  constructor(filename, { budget = 512 * 1024 * 1024 } = {}) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(filename), 0o700);
    this.db = new DatabaseSync(filename);
    fs.chmodSync(filename, 0o600);
    this.budget = budget;
    this.error = null;
    this.db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS archive_blobs (sha TEXT PRIMARY KEY, content BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS archive_versions (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL, ts INTEGER NOT NULL,
        sha TEXT, state TEXT NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS archive_events (event TEXT PRIMARY KEY, path TEXT NOT NULL, before_id INTEGER, after_id INTEGER);
      CREATE INDEX IF NOT EXISTS archive_path ON archive_versions(path, id);
      CREATE INDEX IF NOT EXISTS archive_time ON archive_versions(path, ts, id);
      CREATE INDEX IF NOT EXISTS archive_sha ON archive_versions(sha);
      CREATE TABLE IF NOT EXISTS archive_removed (id INTEGER PRIMARY KEY, before INTEGER NOT NULL);`);
    this.filename = filename;
  }
  // Pages holding data. Freed pages are reused before the file grows, so
  // they do not count against the budget even before they are given back.
  used() {
    const p = n => this.db.prepare('PRAGMA ' + n).get()[n];
    return (p('page_count') - p('freelist_count')) * p('page_size');
  }
  // Oldest first, like saved checkpoints (design/81): above 80% of the
  // budget, remove the oldest quarter of what may go until below 60%. Kept:
  // the last day, each file's newest version, and versions a review with a
  // person's work points at (`protect`).
  async retain({ now = Date.now(), keepMs = 24 * 3600000, protect = new Set(), high = 0.8, low = 0.6 } = {}) {
    const report = { removed: 0, before: null, protectedOverBudget: false };
    if (this.used() < this.budget * high) return report;
    for (let round = 0; round < 16 && this.used() > this.budget * low; round++) {
      const newest = new Set(this.db.prepare('SELECT MAX(id) AS id FROM archive_versions GROUP BY path').all().map(r => r.id));
      const candidates = this.db.prepare('SELECT id, ts FROM archive_versions WHERE ts<? ORDER BY ts, id').all(now - keepMs).filter(r => !newest.has(r.id) && !protect.has(r.id));
      if (!candidates.length) { report.protectedOverBudget = true; break; }
      const cutoff = candidates[Math.max(0, Math.ceil(candidates.length / 4) - 1)].ts, chosen = candidates.filter(r => r.ts <= cutoff);
      for (let i = 0; i < chosen.length; i += 1000) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const tomb = this.db.prepare('INSERT OR REPLACE INTO archive_removed VALUES (?, ?)');
          const sha = this.db.prepare('SELECT sha FROM archive_versions WHERE id=?'), drop = this.db.prepare('DELETE FROM archive_versions WHERE id=?');
          const orphan = this.db.prepare('DELETE FROM archive_blobs WHERE sha=? AND NOT EXISTS (SELECT 1 FROM archive_versions WHERE sha=?)');
          for (const { id } of chosen.slice(i, i + 1000)) {
            const s = sha.get(id)?.sha; tomb.run(id, cutoff + 1); drop.run(id);
            if (s) orphan.run(s, s);
          }
          this.db.exec('COMMIT');
        } catch (e) { this.db.exec('ROLLBACK'); throw e; }
        await new Promise(r => setImmediate(r));
      }
      report.removed += chosen.length; report.before = cutoff + 1;
    }
    await this.shrink();
    if (this.used() + 8192 <= this.budget) this.error = null;
    return report;
  }
  // Give free pages back to the disk (see sqlite-compact.js).
  async shrink() {
    const p = n => this.db.prepare('PRAGMA ' + n).get()[n];
    const free = p('freelist_count') * p('page_size'), incremental = p('auto_vacuum') === 2;
    if (free < (incremental ? 8 : 64) * 1024 * 1024) return;
    await require('./sqlite-compact').compactDatabase(this.filename, { mode: incremental ? 'incremental' : 'convert' });
  }
  observe(file, { text = null, state = 'present', actor = 'unknown', source = 'watch', ts = Date.now(), reason = '' } = {}) {
    file = path.resolve(file);
    if (!['present', 'deleted', 'unavailable'].includes(state)) throw new Error('Invalid archive state');
    if (state === 'present' && (typeof text !== 'string' || Buffer.byteLength(text) > MAX_FILE_BYTES || text.includes('\0'))) {
      state = 'unavailable'; reason = 'Binary, unreadable, or larger than 2 MiB'; text = null;
    }
    const sha = state === 'present' ? crypto.createHash('sha256').update(text).digest('hex') : null;
    const last = this.db.prepare('SELECT * FROM archive_versions WHERE path = ? ORDER BY id DESC LIMIT 1').get(file);
    if (last && last.sha === sha && last.state === state && last.reason === reason) return last;
    const packed = sha && !this.db.prepare('SELECT 1 FROM archive_blobs WHERE sha = ?').get(sha) ? gzipSync(text) : null;
    if (this.used() + (packed?.length || 0) + 8192 > this.budget) {
      this.error = 'File history is full. The oldest versions are being removed to make room; this version was not saved.';
      throw new Error(this.error);
    }
    // A backwards wall-clock adjustment must not put a new observation before
    // an older observation of the same file. IDs order equal timestamps.
    ts = Math.max(Math.trunc(ts), last?.ts || 0);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (packed) this.db.prepare('INSERT OR IGNORE INTO archive_blobs VALUES (?, ?)').run(sha, packed);
      const out = this.db.prepare('INSERT INTO archive_versions(path, ts, sha, state, actor, source, reason) VALUES (?, ?, ?, ?, ?, ?, ?)').run(file, ts, sha, state, actor, source, reason);
      this.db.exec('COMMIT'); this.error = null;
      return { id: Number(out.lastInsertRowid), path: file, ts, sha, state, actor, source, reason };
    } catch (e) { this.db.exec('ROLLBACK'); this.error = e.message; throw e; }
  }
  versions(file, limit = 2000) {
    return this.db.prepare('SELECT * FROM archive_versions WHERE path = ? ORDER BY id DESC LIMIT ?').all(path.resolve(file), limit).reverse();
  }
  around(file, from, to) {
    file = path.resolve(file);
    const before = this.db.prepare("SELECT * FROM archive_versions WHERE path=? AND ts<? ORDER BY ts DESC,id DESC LIMIT 1").get(file, from);
    const during = this.db.prepare("SELECT * FROM archive_versions WHERE path=? AND ts>=? AND ts<=? ORDER BY ts DESC,id DESC LIMIT 2000").all(file, from, to).reverse();
    return before ? [before, ...during] : during;
  }
  version(file, id) {
    return this.db.prepare('SELECT * FROM archive_versions WHERE path = ? AND id = ?').get(path.resolve(file), id);
  }
  snapshot(file, id) {
    const row = this.db.prepare('SELECT v.*, b.content FROM archive_versions v LEFT JOIN archive_blobs b ON b.sha = v.sha WHERE v.path = ? AND v.id = ?').get(path.resolve(file), id);
    if (!row) {
      const gone = this.db.prepare('SELECT before FROM archive_removed WHERE id = ?').get(id);
      throw new Error(gone ? `Removed to free space (saved history from before ${new Date(gone.before).toISOString().slice(0, 10)} was cleared)` : 'Saved version not found for this file');
    }
    if (row.state === 'unavailable') throw new Error(row.reason || 'Contents were not captured');
    return { content: row.state === 'deleted' ? '' : gunzipSync(row.content, { maxOutputLength: MAX_FILE_BYTES }).toString('utf8'), exact: true, method: row.state === 'deleted' ? 'observed deletion' : 'saved observation', state: row.state, sha: row.sha };
  }
  latestId(file) {
    return this.db.prepare('SELECT id FROM archive_versions WHERE path = ? ORDER BY id DESC LIMIT 1').get(path.resolve(file))?.id || null;
  }
  link(event, file, before, after) {
    this.db.prepare('INSERT OR REPLACE INTO archive_events VALUES (?, ?, ?, ?)').run(event, path.resolve(file), before || null, after || null);
  }
  reference(event, file) {
    const row = this.db.prepare('SELECT before_id, after_id FROM archive_events WHERE event = ? AND path = ?').get(event, path.resolve(file));
    return row ? { fromVersion: row.before_id ? 'saved:' + row.before_id : null, toVersion: row.after_id ? 'saved:' + row.after_id : null } : {};
  }
  close() { this.db.close(); }
}
module.exports = { FileArchive, MAX_FILE_BYTES };
