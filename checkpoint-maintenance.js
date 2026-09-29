'use strict';
// Keeping saved file history within its disk budget (design/81).
//
// 1. Compaction: each folder's private repository is repacked from what the
//    metadata still refers to. Git stores successive versions of a file as
//    differences, so this alone usually shrinks a store more than tenfold,
//    and every object nothing refers to any more is dropped.
// 2. Retention: only if the store is still above 80% of its budget, the
//    oldest history is removed, a quarter of what may be removed at a time,
//    until it is below 60%. Never removed: the last day, the newest snapshot
//    of each folder and each file, and anything a review with a person's
//    comments, ticks or sent feedback points at.
// 3. The metadata database gives the freed space back to the disk.
//
// Captures run in several processes at once. A folder's repository is only
// changed destructively under its exclusive lease, which waits until that
// folder's captures finish and holds new ones off (checkpoint-store.js).
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { cleanGitEnv, removedMessage, packList, MB } = require('./checkpoint-store');
const { compactDatabase } = require('./sqlite-compact');

const KEEP_MS = () => Math.max(1, Number(process.env.CHATTERING_CHECKPOINT_KEEP_HOURS || 24)) * 3600000;
const SHARE_PER_ROUND = 0.25;
const needsCompaction = r => r.pending_objects + r.pending_snapshots >= 1000 || r.pending_bytes >= 32 * MB
  || (r.packed_at === 0 && r.pending_objects + r.pending_snapshots > 0);
const HEX40 = /^[0-9a-f]{40}$/, HEX64 = /^[0-9a-f]{64}$/;
const tick = () => new Promise(r => setImmediate(r));

function run(args, { cwd, input, timeout = 30 * 60000, lines } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: cleanGitEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // Background work: let the person's own programs go first.
    try { os.setPriority(child.pid, 10); } catch {}
    const out = [], err = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.stdout.on('data', b => out.push(b));
    child.stderr.on('data', b => { if (err.length < 8) err.push(b); });
    child.stdin.on('error', () => {});
    if (lines) { for (const l of lines) child.stdin.write(l + '\n'); child.stdin.end(); } else child.stdin.end(input);
    child.on('close', code => { clearTimeout(timer); code ? reject(Error(Buffer.concat(err).toString().trim().slice(0, 500) || 'git ' + args[1] + ' failed')) : resolve(Buffer.concat(out)); });
  });
}
// Which of these objects exist in the repository.
async function present(repo, oids) {
  if (!oids.length) return new Set();
  const out = await run(['--git-dir=' + repo, 'cat-file', '--batch-check=%(objectname)'], { lines: oids });
  return new Set(out.toString().split('\n').filter(l => HEX40.test(l)));
}
// Packs every object reachable from the given commits and blobs, without
// walking commit parents (older checkpoints were chained; the chain is not
// history anyone asked to keep). Returns the new pack's name, or ''.
function packObjects(repo, starts, { honorKeep = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!starts.length) return resolve('');
    const threads = Math.max(1, Math.min(4, (os.availableParallelism?.() || os.cpus().length) - 1));
    const list = spawn('git', ['--git-dir=' + repo, 'rev-list', '--objects', '--no-walk', '--stdin'], { env: cleanGitEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const pack = spawn('git', ['--git-dir=' + repo, '-c', 'pack.threads=' + threads, '-c', 'pack.windowMemory=128m',
      'pack-objects', '-q', '--non-empty', ...(honorKeep ? ['--honor-pack-keep'] : []), path.join(repo, 'objects', 'pack', 'pack')],
    { env: cleanGitEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    for (const c of [list, pack]) try { os.setPriority(c.pid, 10); } catch {}
    const errors = [], out = [];
    let settled = false, closed = 0;
    const done = error => {
      if (settled) return;
      if (error) { settled = true; clearTimeout(timer); list.kill(); pack.kill(); return reject(error); }
      if (++closed < 2) return;
      settled = true; clearTimeout(timer);
      const name = Buffer.concat(out).toString().trim();
      resolve(HEX40.test(name) ? name : '');
    };
    const timer = setTimeout(() => done(Error('Packing saved history took over 30 minutes')), 30 * 60000);
    list.stderr.on('data', b => errors.push(b)); pack.stderr.on('data', b => errors.push(b));
    list.stdin.on('error', () => {}); pack.stdin.on('error', () => {});
    list.stdout.pipe(pack.stdin);
    pack.stdout.on('data', b => out.push(b));
    list.on('error', done); pack.on('error', done);
    list.on('close', code => code ? done(Error('Listing saved history failed: ' + Buffer.concat(errors).toString().trim().slice(0, 300))) : done());
    pack.on('close', code => code ? done(Error('Packing saved history failed: ' + Buffer.concat(errors).toString().trim().slice(0, 300))) : done());
    for (const s of starts) list.stdin.write(s + '\n');
    list.stdin.end();
  });
}
// Object ids in a version 2 pack index.
function packIndex(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0xff744f63 || b.readUInt32BE(4) !== 2) throw Error('Unexpected pack index format');
  const count = b.readUInt32BE(8 + 255 * 4), start = 8 + 256 * 4, ids = new Array(count);
  for (let i = 0; i < count; i++) ids[i] = b.toString('hex', start + i * 20, start + i * 20 + 20);
  return ids;
}
async function sizeOf(dir) {
  let total = 0;
  const walk = async d => {
    for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir);
  return total;
}
function liveStarts(db, root) {
  return [...new Set([
    ...db.prepare('SELECT commit_hash AS o FROM checkpoint_snapshots WHERE root=?').all(root).map(r => r.o),
    ...db.prepare('SELECT DISTINCT oid AS o FROM checkpoint_target_versions WHERE root=? AND oid IS NOT NULL').all(root).map(r => r.o),
  ].filter(o => HEX40.test(o)))];
}

// Repack one folder's repository from what the metadata still refers to.
async function compactRoot(store, root, hold, report) {
  const repo = store.repo(root), db = store.db;
  if (!fs.existsSync(path.join(repo, 'HEAD'))) {
    db.prepare('UPDATE checkpoint_roots SET packed_at=?, pending_bytes=0, pending_objects=0, pending_snapshots=0, disk_bytes=0 WHERE root=?').run(Date.now(), root);
    return;
  }
  const home = path.dirname(repo), packDir = path.join(repo, 'objects', 'pack');
  const before = await sizeOf(home);
  // 1. The big pack, while captures continue.
  const first = liveStarts(db, root), have = await present(repo, first);
  const missing = first.length - have.size;
  const name = await packObjects(repo, first.filter(o => have.has(o)));
  const keep = name && path.join(packDir, `pack-${name}.keep`);
  if (keep) fs.writeFileSync(keep, 'chattering maintenance\n');
  let trash = null, ex = null;
  try {
    // 2. The short exclusive step: pack what was captured meanwhile, then
    // swap. Every object a row or snapshot needs is in the kept packs now.
    ex = await store.lease(root, 'exclusive');
    if (!ex) { report.errors.push(`${root}: captures did not pause; compaction postponed`); return; }
    if (!hold.held() || !ex.held()) throw Error('Maintenance lease lost; nothing removed');
    const firstSet = new Set(first);
    const later = liveStarts(db, root).filter(o => !firstSet.has(o));
    const laterHave = await present(repo, later);
    const extra = await packObjects(repo, later.filter(o => laterHave.has(o)), { honorKeep: true });
    const kept = [name, extra].filter(Boolean);
    const packed = new Set(kept.flatMap(n => packIndex(path.join(packDir, `pack-${n}.idx`))));
    const dead = db.prepare('SELECT oid FROM checkpoint_objects WHERE root=?').all(root).filter(r => !packed.has(r.oid)).map(r => r.oid);
    let packBytes = 0;
    for (const n of kept) for (const ext of ['pack', 'idx', 'rev']) packBytes += (await fsp.stat(path.join(packDir, `pack-${n}.${ext}`)).catch(() => ({ size: 0 }))).size;
    if (!ex.held()) throw Error('Maintenance lease lost; nothing removed');
    // Rows first: a row must never outlive its object.
    db.exec('BEGIN IMMEDIATE');
    try {
      const del = db.prepare('DELETE FROM checkpoint_objects WHERE root=? AND oid=?');
      for (const oid of dead) del.run(root, oid);
      db.prepare(`UPDATE checkpoint_roots SET generation=generation+1, packed_at=?, pending_bytes=0, pending_objects=0, pending_snapshots=0, disk_bytes=? WHERE root=?`).run(Date.now(), packBytes, root);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    trash = path.join(home, 'trash-' + crypto.randomUUID());
    await fsp.mkdir(trash);
    const move = async (from, label) => { try { await fsp.rename(from, path.join(trash, label)); } catch {} };
    const objects = path.join(repo, 'objects');
    for (const e of await fsp.readdir(objects)) if (/^[0-9a-f]{2}$/.test(e)) await move(path.join(objects, e), e);
    const keptFiles = new Set(kept.flatMap(n => ['pack', 'idx', 'rev'].map(ext => `pack-${n}.${ext}`)));
    // Windows cannot move a pack another reader has open; it stays, whole
    // and duplicated, until the next compaction.
    for (const e of await fsp.readdir(packDir)) if (!keptFiles.has(e) && (e.startsWith('pack-') || e.startsWith('tmp_'))) await move(path.join(packDir, e), 'pack.' + e);
    // Refs from before design/81; nothing is kept alive by refs any more.
    await move(path.join(repo, 'refs', 'target-blobs'), 'target-blobs');
    await move(path.join(repo, 'refs', 'heads', 'checkpoints'), 'checkpoints-ref');
    await move(path.join(repo, 'packed-refs'), 'packed-refs');
    // No capture of this folder runs: every temporary index is abandoned.
    for (const e of await fsp.readdir(home)) if (e.startsWith('index-')) await move(path.join(home, e), e);
    const after = await sizeOf(repo);
    db.prepare('UPDATE checkpoint_roots SET disk_bytes=? WHERE root=?').run(after, root);
    report.compacted.push({ root, beforeMB: +(before / MB).toFixed(1), afterMB: +(after / MB).toFixed(1), unreferenced: dead.length, missing });
  } finally {
    if (keep) await fsp.rm(keep, { force: true });
    ex?.release();
    for (const e of await fsp.readdir(home).catch(() => [])) if (e.startsWith('trash-')) await fsp.rm(path.join(home, e), { recursive: true, force: true }).catch(() => {});
  }
}

// What people pinned by working on a review: its comments, ticks and sent
// feedback make its saved versions theirs, so they outlive the budget.
function humanReferences(db) {
  const out = { snapshots: new Set(), targets: new Set(), archive: new Set() };
  let queue;
  try {
    queue = db.prepare('SELECT review AS id FROM change_comments UNION SELECT review FROM change_reviewed WHERE checked=1 UNION SELECT review FROM change_deliveries').all().map(r => r.id);
    for (const c of db.prepare('SELECT body FROM change_comments').all()) collect(JSON.parse(c.body), out);
  } catch { return out; } // no review has ever been opened here
  const seen = new Set(), get = db.prepare('SELECT body FROM change_reviews WHERE id=?');
  while (queue.length) {
    const id = queue.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const row = get.get(id);
    if (!row) continue;
    const body = JSON.parse(row.body);
    collect(body, out);
    // A combined, repaired or follow-up review stands on the reviews it names.
    for (const k of ['original', 'followup', 'repairOf', 'parentReview']) if (typeof body[k] === 'string') queue.push(body[k]);
    for (const a of body.agents || []) if (typeof a.review === 'string') queue.push(a.review);
  }
  return out;
}
function collect(value, out) {
  if (Array.isArray(value)) { for (const v of value) collect(v, out); return; }
  if (!value || typeof value !== 'object') return;
  if (value.kind === 'checkpoint' && typeof value.snapshot === 'string') out.snapshots.add(value.snapshot);
  if (value.kind === 'target' && value.version != null) out.targets.add(Number(value.version));
  if (value.kind === 'archive' && value.version != null) out.archive.add(Number(value.version));
  for (const k of ['base', 'head', 'before', 'after']) if (typeof value[k] === 'string' && HEX64.test(value[k])) out.snapshots.add(value[k]);
  for (const v of Object.values(value)) if (v && typeof v === 'object') collect(v, out);
}

// The oldest quarter of what may be removed, per folder.
function planRemoval(store, { now, keepMs }) {
  const db = store.db, floor = now - keepMs, pinned = humanReferences(db);
  const snaps = db.prepare('SELECT s.id, s.root, COALESCE(MAX(b.finished),0) AS last FROM checkpoint_snapshots s LEFT JOIN checkpoint_boundaries b ON b.snapshot=s.id GROUP BY s.id').all();
  const newest = new Map();
  for (const s of snaps) if (!newest.has(s.root) || s.last > newest.get(s.root).last) newest.set(s.root, s);
  const targets = db.prepare(`SELECT v.id, v.root, v.path, MAX(v.at, COALESCE(MAX(b.finished),0)) AS last FROM checkpoint_target_versions v
    LEFT JOIN checkpoint_target_links l ON l.version=v.id LEFT JOIN checkpoint_boundaries b ON b.id=l.boundary GROUP BY v.id`).all();
  const newestTarget = new Map();
  for (const t of targets) { const k = t.root + '\0' + t.path; if (!newestTarget.has(k) || t.id > newestTarget.get(k)) newestTarget.set(k, t.id); }
  const candidates = [
    ...snaps.filter(s => s.last < floor && !pinned.snapshots.has(s.id) && newest.get(s.root) !== s).map(s => ({ kind: 'snapshot', ...s })),
    ...targets.filter(t => t.last < floor && !pinned.targets.has(t.id) && newestTarget.get(t.root + '\0' + t.path) !== t.id).map(t => ({ kind: 'target', ...t })),
  ].sort((a, b) => a.last - b.last);
  if (!candidates.length) return null;
  const cutoff = candidates[Math.max(0, Math.ceil(candidates.length * SHARE_PER_ROUND) - 1)].last;
  const byRoot = new Map();
  for (const c of candidates) {
    if (c.last > cutoff) break;
    if (!byRoot.has(c.root)) byRoot.set(c.root, { snapshots: [], targets: [] });
    byRoot.get(c.root)[c.kind === 'snapshot' ? 'snapshots' : 'targets'].push(c.id);
  }
  return { before: cutoff + 1, byRoot };
}
function removeRows(db, root, { snapshots, targets }, before) {
  const note = removedMessage(before);
  db.exec('BEGIN IMMEDIATE');
  try {
    const tomb = db.prepare('INSERT OR REPLACE INTO checkpoint_removed VALUES (?,?)');
    const unlink = db.prepare("UPDATE checkpoint_boundaries SET snapshot=NULL, error=CASE WHEN error='' THEN ? ELSE error END WHERE snapshot=?");
    const drop = db.prepare('DELETE FROM checkpoint_snapshots WHERE id=? AND root=?');
    for (const id of snapshots) { tomb.run(id, before); unlink.run(note, id); drop.run(id, root); }
    const untarget = db.prepare("UPDATE checkpoint_target_links SET version=NULL, error=CASE WHEN error='' THEN ? ELSE error END WHERE version=?");
    const dropTarget = db.prepare('DELETE FROM checkpoint_target_versions WHERE id=? AND root=?');
    for (const id of targets) { tomb.run('target:' + id, before); untarget.run(note, id); dropTarget.run(id, root); }
    db.prepare('UPDATE checkpoint_roots SET generation=generation+1 WHERE root=?').run(root);
    // Whole-conversation reviews remember their agents' reviews by the
    // number of saved steps; those steps have changed.
    try { db.exec('DELETE FROM conversation_review_agents'); } catch {}
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
async function retain(store, hold, report, { now, keepMs }) {
  for (let round = 0; round < 16; round++) {
    const u = store.usage();
    if (u.total <= u.low) break;
    const plan = planRemoval(store, { now, keepMs });
    if (!plan) { report.protectedOverBudget = true; break; }
    for (const [root, sel] of plan.byRoot) {
      const ex = await store.lease(root, 'exclusive');
      if (!ex) { report.errors.push(`${root}: captures did not pause; removal postponed`); continue; }
      try {
        if (!hold.held() || !ex.held()) throw Error('Maintenance lease lost; nothing removed');
        removeRows(store.db, root, sel, plan.before);
      } finally { ex.release(); }
      report.removed.snapshots += sel.snapshots.length; report.removed.targets += sel.targets.length;
      report.removed.before = plan.before;
      await compactRoot(store, root, hold, report);
    }
    await shrinkMetadata(store, hold, report);
  }
  store.setMeta('protected-over-budget', report.protectedOverBudget ? '1' : '0');
}

// Snapshots from before design/81 kept their whole file list in the
// metadata, duplicating their Git tree. Each is checked against its tree;
// only a list that matches exactly is replaced by the unsaved-file entries.
async function migrateManifests(store, hold, report) {
  const db = store.db;
  let cursor = store.meta('manifest-migration') || '';
  if (cursor === 'done') return;
  const next = db.prepare('SELECT id, root, tree, manifest FROM checkpoint_snapshots WHERE format=1 AND id>? ORDER BY id LIMIT 100');
  const update = db.prepare('UPDATE checkpoint_snapshots SET manifest=?, format=2 WHERE id=? AND format=1');
  for (;;) {
    const rows = next.all(cursor);
    if (!rows.length) break;
    const changes = [];
    for (const row of rows) {
      const listed = JSON.parse(row.manifest), saved = listed.filter(f => f.oid);
      let files;
      try { files = (await store.reader(row.root).files(row.tree)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)); }
      catch { report.unverified++; continue; }
      const same = files.length === saved.length && files.every((f, i) => f.path === saved[i].path && f.oid === saved[i].oid && f.mode === saved[i].mode);
      if (same) changes.push([packList(listed.filter(f => !f.oid)), row.id]); else report.unverified++;
    }
    if (!hold.held()) throw Error('Maintenance lease lost');
    db.exec('BEGIN IMMEDIATE');
    try { for (const c of changes) update.run(...c); store.setMeta('manifest-migration', rows.at(-1).id); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
    report.migrated += changes.length;
    cursor = rows.at(-1).id;
    await tick();
  }
  store.setMeta('manifest-migration', 'done');
}

// Give freed database pages back to the disk. The first time converts the
// file to incremental vacuuming, which rewrites it once; captures pause for
// that (seconds), in a worker thread so this process keeps answering.
async function shrinkMetadata(store, hold, report) {
  const db = store.db, page = db.prepare('PRAGMA page_size').get().page_size;
  const free = db.prepare('PRAGMA freelist_count').get().freelist_count * page;
  const incremental = db.prepare('PRAGMA auto_vacuum').get().auto_vacuum === 2;
  if (free < (incremental ? 8 : 64) * MB) return;
  const file = path.join(store.dir, 'metadata.sqlite');
  const before = db.prepare('PRAGMA page_count').get().page_count * page;
  if (incremental) await compactDatabase(file, { mode: 'incremental' });
  else {
    const ex = await store.lease('*', 'exclusive');
    if (!ex) { report.errors.push('metadata: captures did not pause; shrinking postponed'); return; }
    try { if (hold.held()) await compactDatabase(file, { mode: 'convert' }); } finally { ex.release(); }
  }
  const after = db.prepare('PRAGMA page_count').get().page_count * page;
  report.metadata = { beforeMB: +(before / MB).toFixed(1), afterMB: +(after / MB).toFixed(1) };
}

async function maintain(store, { now = Date.now(), keepMs = KEEP_MS(), force = false } = {}) {
  const hold = await store.lease('*', 'maintain');
  if (!hold) return { skipped: 'Another process is already tidying saved history' };
  const report = { started: now, migrated: 0, unverified: 0, compacted: [], removed: { snapshots: 0, targets: 0, before: null }, errors: [] };
  try {
    const start = store.usage();
    report.beforeMB = +(start.total / MB).toFixed(1);
    await migrateManifests(store, hold, report);
    for (const r of store.db.prepare('SELECT * FROM checkpoint_roots ORDER BY root').all()) {
      if (!force && !needsCompaction(r) && start.total < start.high) continue;
      try { await compactRoot(store, r.root, hold, report); }
      catch (e) { report.errors.push(`${r.root}: ${e.message}`); if (!hold.held()) throw e; }
    }
    await shrinkMetadata(store, hold, report);
    const u = store.usage();
    if (u.total >= u.high) await retain(store, hold, report, { now, keepMs });
    else store.setMeta('protected-over-budget', '0');
    report.afterMB = +(store.usage().total / MB).toFixed(1);
    report.limitMB = Math.round(store.usage().limit / MB);
    report.finished = Date.now();
    store.setMeta('last-maintenance', JSON.stringify(report));
    return report;
  } finally { hold.release(); }
}

module.exports = { maintain, needsCompaction, humanReferences, planRemoval, packIndex, KEEP_MS };
