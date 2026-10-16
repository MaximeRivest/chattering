'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { deflateSync, deflateRawSync, inflateRawSync } = require('node:zlib');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { sensitive, permittedLocal } = require('./task-locations');
const SKIP = new Set(['.git', 'node_modules', '.venv', '.direnv', 'target', '__pycache__']);
const READ_ONLY = new Set(['read', 'ls', 'find', 'grep']);
const ARTIFACT_FILE_MAX = 25 * 1024 * 1024;
// What one capture may hold (design/36, design/101): files considered, and
// bytes of the files it saves. Checked before anything is read.
const FILES_MAX = 20000, BYTES_MAX = 200 * 1024 * 1024, TEXT_MAX = 2 * 1024 * 1024;
// An artifact folder is saved whole while it stays this small; past it,
// only its page and the files the page uses. A page brings at most this.
const FOLDER_FILES_MAX = 1000, FOLDER_BYTES_MAX = 50 * 1024 * 1024, FOLDER_RECHECK_MS = 5 * 60000;
const PAGE_FILES_MAX = 300, PAGE_BYTES_MAX = 50 * 1024 * 1024, PAGE_DEPTH = 3;
// All artifacts of a folder together, per capture: the most recently shown
// come first. Leaves the rest of BYTES_MAX to the project's own files.
const ARTIFACTS_BYTES_MAX = 100 * 1024 * 1024;
// Artifacts declared longer ago than this are no longer followed at every
// step; showing one again follows it again.
const ARTIFACT_DAYS = 30;
const PAGE_ENTRIES = ['index.html', 'index.htm', 'deck.json', 'index.md', 'README.md'];
const READS_REFS = /\.(?:html?|svg|css|md|markdown|m?js)$/i;
// Outside artifacts only text is saved: these are known not to be.
const BINARY = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|tiff?|wav|mp3|ogg|flac|m4a|mp4|webm|mov|mkv|pdf|zip|gz|tgz|bz2|xz|zst|7z|tar|sqlite3?|db|(?:sqlite3?|db)-(?:journal|wal|shm)|pyc|woff2?|ttf|otf|so|dylib|dll|exe|bin|npy|npz|pt|pth|ckpt|safetensors|onnx|parquet|arrow|feather|pkl|pickle|h5|hdf5)$/i;
const LOG = /\.log(?:\.\d+)?$/i;
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const blobId = b => crypto.createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
const platform = require('./platform.js');
const { GitObjectReader } = require('./git-objects');
const inside = (root, p) => platform.isInside(p, root);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
// How long a lease lives without renewal (design/81). A capture renews its
// lease while it runs; a crashed process's lease simply expires.
const LEASE_TTL = { capture: 120000, exclusive: 60000, maintain: 300000 };
const MB = 1024 * 1024;
// Everything the store keeps on disk counts: Git storage and the metadata
// database. Maintenance starts at HIGH and removes the oldest history down
// to LOW, so saving never has to stop while old history is still there.
const HIGH = 0.8, LOW = 0.6;
const dateOf = ms => new Date(ms).toISOString().slice(0, 10);
const removedMessage = before => `Removed to free space (saved history from before ${dateOf(before)} was cleared)`;
// The unsaved-file list of a snapshot, as stored: compressed, since the same
// long lists (a folder of video frames) repeat in every snapshot.
const packList = list => deflateRawSync(Buffer.from(JSON.stringify(list)));
const unpackList = stored => JSON.parse(typeof stored === 'string' ? stored : inflateRawSync(stored).toString('utf8'));
// Relative file names a page, style, script or document mentions: quoted
// names with an extension, unquoted attributes, CSS url(), srcset and
// Markdown links. Over-matching is harmless (a name is kept only if such a
// file exists); at most 500 per file.
function references(text) {
  const out = new Set();
  const take = raw => {
    if (out.size >= 500) return;
    let s = String(raw).trim().replace(/[?#].*$/, '');
    if (!s || s.startsWith('/') || s.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(s) || !/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(s)) return;
    try { s = decodeURIComponent(s); } catch {}
    out.add(s);
  };
  for (const m of text.matchAll(/["'`]([^"'`\s<>]{1,300})["'`]/g)) take(m[1]);
  for (const m of text.matchAll(/\b(?:src|href|poster|data)\s*=\s*([^\s"'`=<>]+)/gi)) take(m[1]);
  for (const m of text.matchAll(/url\(\s*([^"'()\s]+)\s*\)/gi)) take(m[1]);
  for (const m of text.matchAll(/srcset\s*=\s*["']([^"']+)["']/gi)) for (const part of m[1].split(',')) take(part.trim().split(/\s+/)[0]);
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+)/g)) take(m[1]);
  return [...out];
}
const statOf = file => { try { return fs.lstatSync(file); } catch { return null; } };
const tick = () => new Promise(r => setImmediate(r));
const mbText = n => n >= 1024 * 1024 ? Math.round(n / (1024 * 1024)) + ' MB' : Math.ceil(n / 1024) + ' KB';
const resolveReference = (from, ref) => { try { return path.resolve(path.dirname(from), ref); } catch { return null; } };
// Raised when a capture passes its deadline or its step is stopped.
function checker(deadline, budget, signal) {
  return () => {
    if (signal?.aborted) throw Object.assign(Error('Stopped with the step'), { stopped: true });
    if (Date.now() > deadline) throw Object.assign(Error(slowMessage(budget)), { slow: true });
  };
}
const seconds = ms => (ms >= 10000 ? Math.round(ms / 1000) : Math.round(ms / 100) / 10) + ' s';
const slowMessage = budget => `Saving took longer than ${seconds(budget)}, so it was skipped rather than keep the agent waiting (the next step reuses what was done)`;
// Resolves to null once prior settled; to a reason if the deadline or the
// signal came first.
function waitTurn(prior, deadline, signal, budget) {
  return new Promise(resolve => {
    let timer = null;
    const finish = value => { clearTimeout(timer); signal?.removeEventListener?.('abort', stop); resolve(value); };
    const stop = () => finish({ message: 'Stopped with the step', stopped: true });
    if (signal?.aborted) return stop();
    signal?.addEventListener?.('abort', stop, { once: true });
    timer = setTimeout(() => finish({ message: slowMessage(budget) }), Math.max(0, deadline - Date.now()));
    prior.then(() => finish(null), () => finish(null));
  });
}
function largest(sizes) {
  const [name, size] = [...sizes].sort((a, b) => b[1] - a[1])[0] || [];
  return name ? { name, size } : null;
}
function tooManyFiles(paths, limit = FILES_MAX) {
  const counts = new Map();
  for (const p of paths) { const s = String(p).split(/[\\/]/); const top = s.length > 1 ? s[0] + '/' : s[0]; counts.set(top, (counts.get(top) || 0) + 1); }
  const top = largest(counts);
  return `This project has more than ${limit.toLocaleString('en-US')} files to save` + (top && top.size > limit / 4 ? ` (${top.size.toLocaleString('en-US')} in ${top.name})` : '');
}
function tooManyBytes(total, byFolder, limit = BYTES_MAX) {
  const top = largest(byFolder);
  return `This project has ${mbText(total)} of files to save, more than the ${mbText(limit)} limit` + (top && top.size > limit / 4 ? ` (${mbText(top.size)} in ${top.name})` : '');
}
function budgetBytes() {
  const mb = Number(process.env.CHATTERING_CHECKPOINT_MB || 1024);
  return Number.isFinite(mb) && mb > 0 ? mb * MB : 0;
}
function cleanGitEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: require('./platform.js').gitNothingPaths().config, GIT_TERMINAL_PROMPT: '0', ...extra };
}
function git(args, { cwd, input, env, timeout = 15000, max = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=' + require('./platform.js').gitNothingPaths().hooks, '-c', 'core.fsmonitor=false', '-c', 'core.fsync=committed', ...args], { cwd, env: cleanGitEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = []; let bytes = 0, failure;
    const timer = setTimeout(() => { failure = Error('Checkpoint Git operation timed out'); child.kill('SIGKILL'); }, timeout);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.stdout.on('data', b => { bytes += b.length; if (bytes > max) { failure = Error('Checkpoint output limit exceeded'); child.kill('SIGKILL'); } else out.push(b); });
    child.stderr.on('data', b => { if (err.length < 8) err.push(b); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
    child.on('close', code => { clearTimeout(timer); if (failure || code) reject(failure || Error(Buffer.concat(err).toString().slice(0, 2000) || 'Checkpoint Git operation failed')); else resolve(Buffer.concat(out)); });
  });
}
class CheckpointStore {
  constructor(dir = process.env.CHATTERING_CHECKPOINT_DIR || path.join(require('./platform.js').appDirs().data, 'checkpoints'), options = {}) {
    this.dir = path.resolve(dir); fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); this.dir = fs.realpathSync.native(this.dir); fs.chmodSync(this.dir, 0o700);
    this.db = new DatabaseSync(path.join(this.dir, 'metadata.sqlite'));
    fs.chmodSync(path.join(this.dir, 'metadata.sqlite'), 0o600);
    this.db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS checkpoint_snapshots(id TEXT PRIMARY KEY, root TEXT NOT NULL, commit_hash TEXT NOT NULL, tree TEXT NOT NULL, manifest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoint_boundaries(id INTEGER PRIMARY KEY, root TEXT NOT NULL, session TEXT NOT NULL, run TEXT NOT NULL, call TEXT NOT NULL, tool TEXT NOT NULL, phase TEXT NOT NULL, started INTEGER NOT NULL, finished INTEGER NOT NULL, snapshot TEXT, error TEXT NOT NULL, overlapping INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS checkpoint_calls ON checkpoint_boundaries(session,call,id);
      CREATE TABLE IF NOT EXISTS checkpoint_runs(run TEXT PRIMARY KEY, session TEXT NOT NULL, review TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoint_objects(root TEXT NOT NULL, oid TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(root,oid));
      CREATE TABLE IF NOT EXISTS checkpoint_target_versions(id INTEGER PRIMARY KEY, root TEXT NOT NULL, path TEXT NOT NULL, oid TEXT, state TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS checkpoint_target_path ON checkpoint_target_versions(root,path,id);
      CREATE TABLE IF NOT EXISTS checkpoint_targets(boundary INTEGER NOT NULL, location TEXT NOT NULL, version INTEGER, error TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS checkpoint_target_boundary ON checkpoint_targets(boundary);
      CREATE TABLE IF NOT EXISTS checkpoint_target_links(boundary INTEGER NOT NULL, location TEXT NOT NULL, version INTEGER, error TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS checkpoint_target_link_boundary ON checkpoint_target_links(boundary);
      CREATE TABLE IF NOT EXISTS checkpoint_scopes(root TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(root,path));
      CREATE TABLE IF NOT EXISTS artifact_scopes(root TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(root,path));
      CREATE TABLE IF NOT EXISTS artifact_entries(root TEXT NOT NULL, path TEXT NOT NULL, folder INTEGER NOT NULL, declared INTEGER NOT NULL, PRIMARY KEY(root,path));
      CREATE INDEX IF NOT EXISTS checkpoint_call_only ON checkpoint_boundaries(call,id);
      CREATE INDEX IF NOT EXISTS checkpoint_root_time ON checkpoint_boundaries(root,started);
      CREATE INDEX IF NOT EXISTS checkpoint_boundary_snapshot ON checkpoint_boundaries(snapshot);
      CREATE INDEX IF NOT EXISTS checkpoint_target_link_version ON checkpoint_target_links(version);
      CREATE TABLE IF NOT EXISTS checkpoint_leases(token TEXT PRIMARY KEY, root TEXT NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoint_roots(root TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0, packed_at INTEGER NOT NULL DEFAULT 0, disk_bytes INTEGER NOT NULL DEFAULT 0,
        pending_bytes INTEGER NOT NULL DEFAULT 0, pending_objects INTEGER NOT NULL DEFAULT 0, pending_snapshots INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS checkpoint_removed(id TEXT PRIMARY KEY, before INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoint_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.migrateSchema(options.owner);
    this.queues = new Map(); this.cache = new Map(); this.ready = new Map();
    this.snapshots = new Map(); this.readers = new Map();
    this.roots = new Map(); this.folderVerdicts = new Map(); this.references = new Map();
    // Tests lower these; nothing else should.
    this.limits = { files: FILES_MAX, bytes: BYTES_MAX, artifactBytes: ARTIFACTS_BYTES_MAX, ...options.limits };
    this.workTrees = new Map(); this.lastSnapshot = new Map(); this.gate = Promise.resolve();
    // The server maintains; a Pi worker only saves (and says when it cannot).
    this.autoMaintain = (options.autoMaintain ?? !!options.owner) && process.env.CHATTERING_CHECKPOINT_MAINTENANCE !== '0';
    this.soon = null;
  }
  // Columns added after the first release. Two processes may open the store
  // at once, so the check and the change happen in one write transaction.
  // Only the server upgrades a store that already holds history: a Pi
  // worker loads code from disk and may be newer than the server that
  // started it, whose own code still reads and writes the old layout.
  migrateSchema(owner) {
    const has = (table, column) => this.db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
    if (has('checkpoint_snapshots', 'format') && has('checkpoint_objects', 'added') && this.meta('roots-counted')) return;
    const holdsHistory = this.db.prepare('SELECT 1 FROM checkpoint_snapshots LIMIT 1').get() || this.db.prepare('SELECT 1 FROM checkpoint_objects LIMIT 1').get();
    if (!owner && holdsHistory) { this.db.close(); throw Error('Saved file history is being upgraded; it resumes once Chattering has restarted'); }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // format 1: the full file list is stored here. format 2: only the files
      // that could not be saved; the rest is the snapshot's Git tree.
      if (!has('checkpoint_snapshots', 'format')) this.db.exec('ALTER TABLE checkpoint_snapshots ADD COLUMN format INTEGER NOT NULL DEFAULT 1');
      if (!has('checkpoint_objects', 'added')) this.db.exec('ALTER TABLE checkpoint_objects ADD COLUMN added INTEGER NOT NULL DEFAULT 0');
      if (!this.meta('roots-counted')) {
        // Everything saved before this version is unmeasured, loose storage.
        this.db.exec(`INSERT OR IGNORE INTO checkpoint_roots(root) SELECT DISTINCT root FROM checkpoint_objects UNION SELECT DISTINCT root FROM checkpoint_snapshots;
          UPDATE checkpoint_roots SET pending_bytes=(SELECT COALESCE(SUM(bytes),0) FROM checkpoint_objects o WHERE o.root=checkpoint_roots.root),
            pending_objects=(SELECT COUNT(*) FROM checkpoint_objects o WHERE o.root=checkpoint_roots.root),
            pending_snapshots=(SELECT COUNT(*) FROM checkpoint_snapshots s WHERE s.root=checkpoint_roots.root) WHERE packed_at=0;`);
        this.setMeta('roots-counted', '1');
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  meta(key) { return this.db.prepare('SELECT value FROM checkpoint_meta WHERE key=?').get(key)?.value ?? null; }
  setMeta(key, value) { this.db.prepare('INSERT INTO checkpoint_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }
  // Bytes on disk: each repository as measured when it was last packed, plus
  // what was written since, plus the metadata database file.
  usage() {
    const repos = this.db.prepare('SELECT COALESCE(SUM(disk_bytes+pending_bytes),0) AS n FROM checkpoint_roots').get().n;
    const pages = this.db.prepare('PRAGMA page_count').get().page_count * this.db.prepare('PRAGMA page_size').get().page_size;
    const limit = budgetBytes();
    return { repos, metadata: pages, total: repos + pages, limit, high: limit * HIGH, low: limit * LOW };
  }
  fullMessage(u = this.usage()) {
    const stuck = this.meta('protected-over-budget') === '1';
    return `Saved file history is full (${Math.round(u.total / MB)} of ${Math.round(u.limit / MB)} MB). ` + (stuck
      ? 'What is left is protected (the last day, and reviews with your comments); raise CHATTERING_CHECKPOINT_MB to keep saving.'
      : 'The oldest history is being removed to make room.');
  }
  // Cross-process coordination through the shared database (design/81).
  // capture: many at once per folder; blocked while an exclusive lease holds.
  // exclusive: waits until the folder's captures finish, then holds them off.
  // maintain: one maintainer at a time for the whole store; never waits.
  async lease(root, kind, { wait = 60000, check = () => {} } = {}) {
    const token = crypto.randomUUID(), ttl = LEASE_TTL[kind], start = Date.now();
    for (;;) {
      const now = Date.now();
      let ok = false;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM checkpoint_leases WHERE expires<?').run(now);
        const blocked = kind === 'maintain'
          ? this.db.prepare("SELECT 1 FROM checkpoint_leases WHERE kind='maintain' LIMIT 1").get()
          : this.db.prepare("SELECT 1 FROM checkpoint_leases WHERE kind='exclusive' AND (root=? OR root='*' OR ?='*') LIMIT 1").get(root, root);
        if (!blocked) { this.db.prepare('INSERT INTO checkpoint_leases VALUES (?,?,?,?)').run(token, root, kind, now + ttl); ok = true; }
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
      if (ok) break;
      if (kind === 'maintain') return null;
      if (Date.now() - start > wait) throw Error('Saved file history is being tidied; this step was not saved');
      check();
      await sleep(Math.min(50, Math.max(1, wait - (Date.now() - start))));
    }
    const renew = setInterval(() => { try { this.db.prepare('UPDATE checkpoint_leases SET expires=? WHERE token=?').run(Date.now() + ttl, token); } catch {} }, ttl / 4);
    renew.unref?.();
    const handle = {
      token, root, kind,
      release: () => { clearInterval(renew); try { this.db.prepare('DELETE FROM checkpoint_leases WHERE token=?').run(token); } catch {} },
      // Destructive steps re-check before acting: a lease lost to a clock
      // jump or a long stall must not delete anything.
      held: () => !!this.db.prepare('SELECT 1 FROM checkpoint_leases WHERE token=? AND expires>=?').get(token, Date.now()),
    };
    if (kind !== 'exclusive') return handle;
    for (;;) {
      const busy = this.db.prepare("SELECT 1 FROM checkpoint_leases WHERE kind='capture' AND (root=? OR ?='*') AND expires>=? LIMIT 1").get(root, root, Date.now());
      if (!busy) return handle;
      if (Date.now() - start > wait * 2) { handle.release(); return null; }
      await sleep(50);
    }
  }
  // A process's file-fingerprint cache for one folder. Maintenance bumps the
  // folder's generation whenever it removes saved objects; the cache is
  // dropped then, so a remembered object id is never reused after removal.
  rootCache(root) {
    const generation = this.db.prepare('SELECT generation FROM checkpoint_roots WHERE root=?').get(root)?.generation || 0;
    let entry = this.cache.get(root);
    if (!entry || entry.generation !== generation) { entry = { generation, files: new Map() }; this.cache.set(root, entry); }
    return entry.files;
  }
  reader(root) {
    let r = this.readers.get(root);
    if (r) { this.readers.delete(root); this.readers.set(root, r); return r; }
    r = new GitObjectReader(this.repo(root), cleanGitEnv());
    this.readers.set(root, r);
    if (this.readers.size > 8) { const [oldest, reader] = this.readers.entries().next().value; reader.close(); this.readers.delete(oldest); }
    return r;
  }
  maintain(options) { return require('./checkpoint-maintenance').maintain(this, options); }
  // Start maintenance shortly, once, in the background. Another process may
  // already be doing it; the maintain lease makes the second attempt a no-op.
  maintainSoon() {
    if (!this.autoMaintain || this.soon || this.closed) return;
    this.soon = setTimeout(() => {
      this.maintain().catch(e => console.error('History maintenance:', e.message)).finally(() => { this.soon = null; });
    }, 1000);
    this.soon.unref?.();
  }
  needsMaintenance(root) {
    const u = this.usage();
    if (u.total >= u.high) return true;
    const r = this.db.prepare('SELECT * FROM checkpoint_roots WHERE root=?').get(root);
    return !!r && require('./checkpoint-maintenance').needsCompaction(r);
  }
  repo(root) { return path.join(this.dir, hash(root), 'objects.git'); }
  async root(cwd) {
    cwd = await fsp.realpath(cwd);
    try { return await fsp.realpath((await git(['rev-parse', '--show-toplevel'], { cwd })).toString().trim()); } catch { return cwd; }
  }
  async init(root) {
    if (this.ready.has(root)) return this.ready.get(root);
    const work = (async () => {
      const repo = this.repo(root); await fsp.mkdir(path.dirname(repo), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(path.join(repo, 'HEAD'))) {
        const temp = repo + '.init-' + crypto.randomUUID();
        try {
          await git(['init', '--bare', '--object-format=sha1', temp]);
          // Losing the race to another writer is fine: its rename was whole.
          // Unix says EEXIST or ENOTEMPTY, Windows EPERM; the published
          // repository is the answer either way.
          try { await platform.renameRetry(temp, repo); } catch (e) { if (!fs.existsSync(path.join(repo, 'HEAD'))) throw e; }
        } finally { await fsp.rm(temp, { recursive: true, force: true }); }
      }
      return repo;
    })();
    this.ready.set(root, work); try { return await work; } catch (e) { this.ready.delete(root); throw e; }
  }
  // Every file a capture considers, as workspace-relative path → whether it
  // is saved as part of an artifact (binary allowed, larger files). Bounded
  // before anything is read: the Git listing, the approved scopes, and for
  // each artifact either its small folder or its page and what the page uses
  // (design/101). notes: what was left out on purpose, for the person.
  async enumerate(root, { artifactsOnly = false, check = () => {} } = {}) {
    const listed = new Map(), notes = [];
    const add = (full, artifact) => {
      const rel = path.relative(root, full).split(path.sep).join('/');
      listed.set(rel, !!listed.get(rel) || artifact);
    };
    if (!artifactsOnly) {
      const args = (await this.isWorkTree(root)) ? ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
        : ['--git-dir=' + this.repo(root), '--work-tree=' + root, 'ls-files', '-z', '--others', '--exclude-standard'];
      // Never fall back to an unfiltered filesystem walk after an enumeration
      // failure: that could silently capture ignored secrets or build output.
      for (const rel of (await git(args, { cwd: root })).toString('utf8').split('\0')) if (rel) listed.set(rel, false);
      if (listed.size > this.limits.files) throw Error(tooManyFiles([...listed.keys()], this.limits.files));
    }
    check();
    if (!artifactsOnly) for (const scope of this.scopes(root)) {
      const real = await fsp.realpath(scope).catch(() => null);
      if (real !== scope || !inside(root, real)) continue;
      const walked = await this.walk(real, { files: this.limits.files - listed.size, check });
      if (walked.over) throw Error(tooManyFiles([...listed.keys(), ...walked.files.map(f => path.relative(root, f))], this.limits.files));
      for (const f of walked.files) add(f, false);
    }
    // Artifacts share one allowance per capture, the most recently shown
    // first: a folder that does not fit is saved as its page, and an
    // artifact whose page does not fit either is left out.
    let room = this.limits.artifactBytes;
    const counted = new Set();
    const cost = sizes => { let n = 0; for (const [f, size] of sizes) if (!counted.has(f)) n += size; return n; };
    const take = sizes => { room -= cost(sizes); for (const [f] of sizes) { counted.add(f); add(f, true); } };
    const allowance = `the ${mbText(this.limits.artifactBytes)} kept per step for artifacts is used by ones shown more recently`;
    const entries = this.artifactEntries(root).sort((a, b) => b.declared - a.declared || (a.path < b.path ? -1 : 1));
    for (const entry of entries) {
      const real = await fsp.realpath(entry.path).catch(() => null);
      if (real !== entry.path || !inside(root, real)) continue;
      const rel = path.relative(root, real).split(path.sep).join('/') || '.';
      let page = null, entryFile = real;
      if (entry.folder) {
        const folder = await this.folderFiles(real, check);
        if (!folder.over && cost(folder.sizes) <= room) { take(folder.sizes); continue; }
        entryFile = PAGE_ENTRIES.map(name => path.join(real, name)).find(f => statOf(f)?.isFile());
        if (entryFile) page = await this.pageFiles(root, entryFile, check);
        const why = folder.over ? `too large to save whole: ${folder.over}` : allowance;
        if (page && cost(page.sizes) <= room) { take(page.sizes); notes.push({ path: rel + '/', text: `only ${path.basename(entryFile)} and the files it uses are saved (${why})` }); }
        else notes.push({ path: rel + '/', text: `not saved (${page ? allowance : why})` });
        continue;
      }
      page = await this.pageFiles(root, real, check);
      if (cost(page.sizes) > room) { notes.push({ path: rel, text: `not saved (${allowance})` }); continue; }
      take(page.sizes);
      if (page.cut) notes.push({ path: rel, text: page.cut });
    }
    if (listed.size > this.limits.files) throw Error(tooManyFiles([...listed.keys()], this.limits.files));
    return { listed, notes };
  }
  // Whether the folder is a Git work tree, remembered for a minute.
  async isWorkTree(root) {
    const known = this.workTrees.get(root);
    if (known && Date.now() - known.at < 60000) return known.normal;
    const normal = await git(['rev-parse', '--is-inside-work-tree'], { cwd: root }).then(b => b.toString().trim() === 'true').catch(() => false);
    this.workTrees.set(root, { normal, at: Date.now() });
    return normal;
  }
  // Regular files under a folder, never the store, symlinks or protected
  // paths, stopping as soon as a limit is passed (over says which). With a
  // byte limit, each file's size too (files over 25 MiB and logs count 0:
  // they are not saved).
  async walk(dir, { files: maxFiles = FILES_MAX, bytes: maxBytes = Infinity, check = () => {} } = {}) {
    const files = [], sizes = new Map(); let bytes = 0, over = '', seen = 0;
    const visit = async d => {
      let entries;
      try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (over) return;
        if ((++seen & 255) === 0) { check(); await tick(); }
        if (SKIP.has(e.name)) continue;
        const full = path.join(d, e.name);
        // The store never saves itself, whatever folder was declared around it.
        if (inside(this.dir, full) || sensitive(full)) continue;
        if (e.isDirectory()) { await visit(full); continue; }
        if (!e.isFile()) continue;
        if (files.length >= maxFiles) { over = `more than ${maxFiles.toLocaleString('en-US')} files`; return; }
        files.push(full);
        if (maxBytes === Infinity) continue;
        const size = LOG.test(e.name) ? 0 : statOf(full)?.size ?? 0;
        sizes.set(full, size > ARTIFACT_FILE_MAX ? 0 : size);
        bytes += sizes.get(full);
        if (bytes > maxBytes) { over = `more than ${mbText(maxBytes)}`; return; }
      }
    };
    await visit(dir);
    return { files, sizes, bytes, over };
  }
  // An artifact folder is saved whole while it is small. A folder found too
  // large is not walked again for a while: folders rarely shrink, and a
  // declaration clears the verdict.
  async folderFiles(dir, check) {
    const known = this.folderVerdicts.get(dir);
    if (known && Date.now() - known.at < FOLDER_RECHECK_MS) return known;
    const verdict = { ...(await this.walk(dir, { files: FOLDER_FILES_MAX, bytes: FOLDER_BYTES_MAX, check })), at: Date.now() };
    if (verdict.over) {
      this.folderVerdicts.set(dir, { files: [], sizes: new Map(), over: verdict.over, at: verdict.at });
      if (this.folderVerdicts.size > 500) this.folderVerdicts.delete(this.folderVerdicts.keys().next().value);
    } else this.folderVerdicts.delete(dir);
    return verdict;
  }
  // A page and the files it names (pictures, styles, scripts, data, frames),
  // followed a few levels: what a person sees when the page is shown.
  // References are read from the text, not by running the page, so a file
  // whose name is assembled by a script is not found.
  async pageFiles(root, entry, check = () => {}) {
    const sizes = new Map(); let bytes = 0, cut = '';
    const eligible = full => {
      if (!inside(root, full) || inside(this.dir, full) || sensitive(full)) return null;
      if (path.relative(root, full).split(path.sep).some(p => SKIP.has(p))) return null;
      const st = statOf(full);
      if (!st || !st.isFile() || st.size > ARTIFACT_FILE_MAX) return null;
      try { return fs.realpathSync.native(full) === full ? st : null; } catch { return null; }
    };
    const first = eligible(entry);
    if (!first) return { sizes, cut };
    sizes.set(entry, first.size); bytes = first.size;
    const queue = [[entry, first, 0]];
    while (queue.length) {
      const [file, stat, depth] = queue.shift();
      check();
      if (depth >= PAGE_DEPTH || !(READS_REFS.test(file) || (depth === 0 && /\.json$/i.test(file)))) continue;
      for (const ref of await this.referencesOf(file, stat)) {
        const full = resolveReference(file, ref);
        if (!full || sizes.has(full)) continue;
        if (sizes.size >= PAGE_FILES_MAX) { cut = `it uses more than ${PAGE_FILES_MAX} files; the rest are not saved`; break; }
        const st = eligible(full);
        if (!st) continue;
        if (bytes + st.size > PAGE_BYTES_MAX) { cut = `the files it uses pass ${mbText(PAGE_BYTES_MAX)}; the rest are not saved`; continue; }
        bytes += st.size; sizes.set(full, st.size);
        queue.push([full, st, depth + 1]);
      }
    }
    return { sizes, files: [...sizes.keys()], cut };
  }
  async referencesOf(file, stat) {
    if (stat.size > TEXT_MAX) return [];
    const fingerprint = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const known = this.references.get(file);
    if (known?.fingerprint === fingerprint) return known.refs;
    const refs = references(await fsp.readFile(file, 'utf8').catch(() => ''));
    this.references.set(file, { fingerprint, refs });
    if (this.references.size > 4000) this.references.delete(this.references.keys().next().value);
    return refs;
  }
  // The root of a folder, remembered for a minute.
  rootOf(cwd) {
    const known = this.roots.get(cwd);
    if (known && Date.now() - known.at < 60000) return known.root;
    const root = this.root(cwd);
    this.roots.set(cwd, { root, at: Date.now() });
    root.catch(() => { if (this.roots.get(cwd)?.root === root) this.roots.delete(cwd); });
    return root;
  }
  // options: budget (ms) or deadline (epoch ms) for the whole capture,
  // waiting included; signal stops it (the step was stopped). Past either,
  // the capture gives up and records the step as not saved: the caller is
  // never held longer than it asked (design/101).
  async capture(cwd, meta = {}, { budget = 15000, deadline = Date.now() + budget, signal } = {}) {
    // Captures of one process reach their folder's queue in the order they
    // were asked for: each finds its root after the one asked before it, so
    // a step's end is always saved before the next step's start.
    const found = this.gate.then(() => this.rootOf(cwd));
    this.gate = found.catch(() => {});
    const root = await found, prior = this.queues.get(root) || Promise.resolve();
    const job = { skip: false };
    const work = prior.catch(() => {}).then(() => job.skip ? null : this.captureRoot(root, meta, { deadline, budget, signal }));
    this.queues.set(root, work);
    const done = () => { if (this.queues.get(root) === work) this.queues.delete(root); };
    work.then(done, done);
    const turn = await waitTurn(prior, deadline, signal, budget);
    if (turn) {
      job.skip = true;
      if (this.nothingToSave(root, meta)) return null;
      return this.recordCapture(root, meta, Date.now(), null, turn.message, { stopped: !!turn.stopped });
    }
    return work;
  }
  // A loose folder (home, temp) with no artifact and no named file: nothing
  // of it is saved, and no step is recorded.
  nothingToSave(root, meta) { return !!meta.targetOnly && !meta.targets?.length && !this.artifactEntries(root).length; }
  async captureRoot(root, meta, { deadline = Date.now() + 15000, budget = 15000, signal } = {}) {
    if (this.nothingToSave(root, meta)) return null;
    const started = Date.now(); let error = '', lease = null, stopped = false;
    const check = checker(deadline, budget, signal);
    try { check(); lease = await this.lease(root, 'capture', { wait: Math.max(0, deadline - Date.now()), check }); } catch (e) { error = e.message; stopped = !!e.stopped; }
    // The lease is held until the boundary row names what was saved: until
    // then, maintenance could not tell the new rows from abandoned ones.
    try { return await this.recordCapture(root, meta, started, lease, error, { stopped, check }); }
    finally {
      lease?.release();
      try { if (this.needsMaintenance(root)) this.maintainSoon(); } catch {}
    }
  }
  async recordCapture(root, meta, started, lease, error, { stopped = false, check = () => {} } = {}) {
    let snapshot = null, targets = [], notes = [];
    if (lease) {
      targets = await this.captureTargets(root, meta.targets || []);
      const artifactsOnly = !!meta.targetOnly && this.artifactEntries(root).length > 0;
      if (!meta.targetOnly || artifactsOnly) {
        try { ({ snapshot, notes } = await this.scan(root, { artifactsOnly, check })); }
        catch (e) { error = e.message; stopped = !!e.stopped; }
      }
    }
    if (meta.run && meta.review) this.db.prepare('INSERT OR IGNORE INTO checkpoint_runs VALUES (?,?,?)').run(meta.run, meta.session || '', meta.review);
    const active = this.db.prepare(`SELECT 1 FROM checkpoint_boundaries b WHERE b.root=? AND b.phase='before' AND b.started>? AND NOT (b.session=? AND b.run=? AND b.call=?) AND NOT EXISTS (SELECT 1 FROM checkpoint_boundaries e WHERE e.session=b.session AND e.run=b.run AND e.call=b.call AND e.id>b.id AND e.phase IN ('after','after-error','settled-incomplete')) LIMIT 1`).get(root, started - 86400000, meta.session || '', meta.run || '', meta.call || '');
    const insert = this.db.prepare(`INSERT INTO checkpoint_boundaries(root,session,run,call,tool,phase,started,finished,snapshot,error,overlapping) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const finished = Date.now();
    // One scan can stand for several boundaries at the same moment: the
    // steps a stopped run left open end where the run settles.
    for (const extra of meta.rows || []) insert.run(root, meta.session || '', meta.run || '', extra.call || '', extra.tool || '', extra.phase, started, finished, snapshot?.id || null, error, extra.overlapping ? 1 : 0);
    const row = insert.run(root, meta.session || '', meta.run || '', meta.call || '', meta.tool || '', meta.phase || 'observation', started, finished, snapshot?.id || null, error, meta.overlapping || active ? 1 : 0);
    const id = Number(row.lastInsertRowid);
    for (const target of targets) this.db.prepare('INSERT INTO checkpoint_target_links VALUES (?,?,?,?)').run(id, JSON.stringify(target.location), target.version, target.error);
    return { id, root, snapshot: snapshot?.id || null, error, stopped, notes, targetErrors: targets.filter(t => t.error && !t.location.soft).map(t => t.error) };
  }
  // Two passes: every candidate is looked at (lstat only) and the limits are
  // checked before a single file is read, so a folder too large to save
  // costs a listing, not 200 MB of reading and storing. Then only files
  // whose fingerprint changed are read. Work done before a deadline is kept
  // in the fingerprint cache, so the next capture continues from there.
  async scan(root, { artifactsOnly = false, check = () => {} } = {}) {
    // A whole-workspace scan lists everything under the root, so the root
    // must not hold the store. An artifacts-only scan (a loose folder such as
    // home, which does hold it) walks only the declared folders, and that
    // walk skips the store itself.
    if (!artifactsOnly && inside(root, this.dir)) throw Error('Checkpoint storage must be outside the captured workspace');
    const repo = await this.init(root), manifest = [], todo = [];
    const { listed, notes } = await this.enumerate(root, { artifactsOnly, check });
    const u = this.usage();
    if (!(u.limit > 0) || u.total >= u.limit) throw Error(this.fullMessage(u));
    let total = 0, n = 0;
    const byFolder = new Map();
    // lstat without the thread pool: one call costs microseconds, a round
    // trip through the event loop far more on a busy machine. The loop
    // yields every 256 files so the agent's own work is not held.
    for (const rel of [...listed.keys()].sort()) {
      if ((++n & 255) === 0) { check(); await tick(); }
      if (rel.split('/').some(p => SKIP.has(p))) continue;
      if (sensitive(rel)) { manifest.push({ path: rel, unavailable: 'Protected sensitive path' }); continue; }
      const full = path.resolve(root, rel);
      if (!inside(root, full)) throw Error('Checkpoint path escaped the workspace');
      let stat;
      try { stat = fs.lstatSync(full); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue; throw e; }
      if (stat.isDirectory()) { manifest.push({ path: rel, unavailable: 'Nested repository/directory entry' }); continue; }
      // Inside an artifact, pictures, fonts, sounds and documents are part of
      // what the person sees, so they are versioned too (up to 25 MiB each,
      // within the same storage budget). Logs never are: they change at every
      // step and nobody reviews them.
      const artifact = listed.get(rel);
      const maxBytes = artifact ? ARTIFACT_FILE_MAX : TEXT_MAX;
      if (LOG.test(rel)) { manifest.push({ path: rel, unavailable: 'Log file' }); continue; }
      if (!artifact && BINARY.test(rel)) { manifest.push({ path: rel, unavailable: 'Binary artifact; use its current-file preview' }); continue; }
      if (!stat.isFile() || stat.size > maxBytes) { manifest.push({ path: rel, unavailable: artifact ? 'Symlink, special file, or file over 25 MiB' : 'Symlink, special file, or file over 2 MiB' }); continue; }
      total += stat.size;
      const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) + '/' : rel;
      byFolder.set(top, (byFolder.get(top) || 0) + stat.size);
      todo.push({ rel, full, stat, artifact, maxBytes });
    }
    if (total > this.limits.bytes) throw Error(tooManyBytes(total, byFolder, this.limits.bytes));
    const cache = this.rootCache(root);
    for (const { rel, full, stat, artifact, maxBytes } of todo) {
      check();
      const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`;
      const cached = cache.get(full);
      let oid = cached?.fingerprint === fingerprint ? cached.oid : null;
      if (!oid) {
        // A folder on the path swapped for a link since the listing would
        // change the file's identity, so the fingerprint above would not
        // match: checking the real path on a miss is enough.
        if (!inside(root, await fsp.realpath(full).catch(() => full))) { manifest.push({ path: rel, unavailable: 'Symlink, special file, or file over 2 MiB' }); continue; }
        let handle;
        try { handle = await fsp.open(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); }
        catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        let bytes, changed = false;
        try {
          const buffer = Buffer.alloc(stat.size + 1); let size = 0;
          while (size < buffer.length) { const r = await handle.read(buffer, size, buffer.length - size, size); if (!r.bytesRead) break; size += r.bytesRead; }
          bytes = buffer.subarray(0, size); const after = await handle.stat();
          changed = bytes.length > maxBytes || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size || after.ctimeMs !== stat.ctimeMs;
        } finally { await handle.close(); }
        // A file being written while it is read (a growing output) is not
        // saved this time; the rest of the step is.
        if (changed) { manifest.push({ path: rel, unavailable: 'Changing while it was being saved' }); continue; }
        if (!artifact && (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes))) { manifest.push({ path: rel, unavailable: 'Binary or non-UTF-8 contents' }); continue; }
        oid = await this.storeBlob(root, bytes);
        cache.set(full, { fingerprint, oid });
        if (cache.size > 40000) cache.delete(cache.keys().next().value);
      }
      manifest.push({ path: rel, oid, mode: stat.mode & 0o111 ? '100755' : '100644' });
    }
    check();
    manifest.sort(byPath);
    // Nothing changed since this process last saved the folder (a step's
    // end and the next step's start, usually): the same snapshot, without
    // building the same tree again. Maintenance may have removed it since.
    const json = JSON.stringify(manifest), last = this.lastSnapshot.get(root);
    if (last && last.json === json) {
      const same = this.db.prepare('SELECT id, root, commit_hash, tree FROM checkpoint_snapshots WHERE id=?').get(last.id);
      if (same) return { snapshot: same, notes };
    }
    const index = path.join(path.dirname(repo), 'index-' + crypto.randomUUID());
    const env = { GIT_INDEX_FILE: index }, args = ['--git-dir=' + repo];
    const remember = snapshot => {
      this.lastSnapshot.set(root, { json, id: snapshot.id });
      if (this.lastSnapshot.size > 32) this.lastSnapshot.delete(this.lastSnapshot.keys().next().value);
      return { snapshot, notes };
    };
    try {
      // A missing index file is an empty index.
      await git([...args, 'update-index', '-z', '--index-info'], { env, input: manifest.filter(f => f.oid).map(f => `${f.mode} ${f.oid}\t${f.path}\0`).join('') });
      const tree = (await git([...args, 'write-tree'], { env })).toString().trim();
      const id = hash(root + '\0' + tree + '\0' + json);
      const existing = this.db.prepare('SELECT id, root, commit_hash, tree FROM checkpoint_snapshots WHERE id=?').get(id);
      if (existing) return remember(existing);
      // One commit per snapshot, without a parent: nothing but the metadata
      // row keeps a snapshot, so removing old history is removing rows.
      const commit = (await git([...args, 'commit-tree', tree], { input: 'Workspace checkpoint\n', env: { GIT_AUTHOR_NAME: 'Workspace', GIT_AUTHOR_EMAIL: 'workspace@localhost', GIT_COMMITTER_NAME: 'Workspace', GIT_COMMITTER_EMAIL: 'workspace@localhost' } })).toString().trim();
      // Stored: only what the tree cannot say (files that were not saved).
      const extra = packList(manifest.filter(f => !f.oid));
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (this.db.prepare('INSERT OR IGNORE INTO checkpoint_snapshots(id,root,commit_hash,tree,manifest,format) VALUES (?,?,?,?,?,2)').run(id, root, commit, tree, extra).changes)
          this.db.prepare('INSERT INTO checkpoint_roots(root,pending_snapshots) VALUES (?,1) ON CONFLICT(root) DO UPDATE SET pending_snapshots=pending_snapshots+1').run(root);
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
      return remember({ id, root, commit_hash: commit, tree });
    } finally { await fsp.rm(index, { force: true }); }
  }
  // Snapshots never change, so each is read once and kept for a while.
  snapshot(id) {
    let work = this.snapshots.get(id);
    if (work) { this.snapshots.delete(id); this.snapshots.set(id, work); return work; }
    work = this.loadSnapshot(id);
    this.snapshots.set(id, work);
    if (this.snapshots.size > 64) this.snapshots.delete(this.snapshots.keys().next().value);
    work.catch(() => { if (this.snapshots.get(id) === work) this.snapshots.delete(id); });
    return work;
  }
  async loadSnapshot(id) {
    const row = this.db.prepare('SELECT id, root, commit_hash, tree, manifest, format FROM checkpoint_snapshots WHERE id=?').get(id);
    if (!row) {
      const gone = this.db.prepare('SELECT before FROM checkpoint_removed WHERE id=?').get(String(id));
      throw Error(gone ? removedMessage(gone.before) : 'Checkpoint not found');
    }
    const { format, manifest, ...rest } = row;
    if (format !== 2) return { ...rest, manifest: JSON.parse(manifest) };
    const stored = unpackList(manifest);
    const files = await this.reader(row.root).files(row.tree);
    return { ...rest, manifest: files.concat(stored).sort(byPath) };
  }
  boundaries(session, calls) {
    if (!calls.length) return [];
    return this.db.prepare(`SELECT * FROM checkpoint_boundaries WHERE session=? AND call IN (${calls.map(() => '?').join(',')}) ORDER BY id`).all(session, ...calls);
  }
  async content(snapshot, rel) {
    const s = await this.snapshot(snapshot), item = s.manifest.find(f => f.path === rel);
    if (!item) return { text: '', absent: true, oid: null };
    if (item.unavailable) return { unavailable: item.unavailable, oid: null };
    return { text: (await git(['--git-dir=' + this.repo(s.root), 'cat-file', 'blob', item.oid], { max: 2 * 1024 * 1024 })).toString('utf8'), oid: item.oid };
  }
  // Steps of any conversation in one folder during a stretch of time, for
  // telling what a step changed from what ran beside it (design/88).
  boundariesBetween(root, from, to) {
    return this.db.prepare("SELECT id, root, session, run, call, tool, phase, started, finished, snapshot, error FROM checkpoint_boundaries WHERE root=? AND started BETWEEN ? AND ? AND call != '' ORDER BY id").all(root, from, to);
  }
  // What only the metadata row knows of each snapshot: its Git tree and the
  // files it could not save (binary, too large), which are not in the tree.
  snapshotHeads(ids) {
    const out = new Map(), list = [...new Set(ids.filter(Boolean))];
    for (let i = 0; i < list.length; i += 400) {
      const part = list.slice(i, i + 400);
      for (const row of this.db.prepare(`SELECT id, root, tree, manifest, format FROM checkpoint_snapshots WHERE id IN (${part.map(() => '?').join(',')})`).all(...part)) {
        const listed = row.format === 2 ? unpackList(row.manifest) : JSON.parse(row.manifest);
        out.set(row.id, { id: row.id, root: row.root, tree: row.tree, unsaved: new Map(listed.filter(f => f.unavailable).map(f => [f.path, f.unavailable])) });
      }
    }
    return out;
  }
  // Many pairs of trees of one folder compared by one Git process: for each
  // pair, the files that differ with both object ids and the lines added and
  // removed (null for binary). pairs: [[treeA, treeB]]; the result is keyed
  // 'treeA treeB'. Identical trees are not asked about.
  async diffTrees(root, pairs) {
    const out = new Map(), wanted = [];
    for (const [a, b] of pairs) {
      const k = a + ' ' + b;
      if (out.has(k)) continue;
      out.set(k, []);
      if (a !== b) wanted.push(k);
    }
    if (!wanted.length) return out;
    const raw = (await git(['--git-dir=' + this.repo(root), 'diff-tree', '--stdin', '-r', '-z', '--raw', '--numstat', '--no-renames', '--no-ext-diff'],
      { input: wanted.join('\n') + '\n', timeout: 120000, max: 256 * 1024 * 1024 })).toString('utf8');
    let at = 0, current = null;
    const byPath = new Map();
    const header = /^([0-9a-f]{40}) ([0-9a-f]{40})\n/;
    while (at < raw.length) {
      const head = header.exec(raw.slice(at, at + 82));
      if (head) { current = out.get(head[1] + ' ' + head[2]) || null; byPath.clear(); at += head[0].length; continue; }
      const end = raw.indexOf('\0', at);
      if (end < 0) break;
      const token = raw.slice(at, end); at = end + 1;
      if (token[0] === ':') {
        const [, , oldOid, newOid, status] = token.slice(1).split(' ');
        const stop = raw.indexOf('\0', at), file = raw.slice(at, stop); at = stop + 1;
        const zero = /^0+$/;
        const item = { path: file, status: status[0], old: zero.test(oldOid) ? null : oldOid, next: zero.test(newOid) ? null : newOid, add: null, del: null, binary: false };
        if (current) { current.push(item); byPath.set(file, item); }
      } else {
        const tab = token.indexOf('\t'), tab2 = token.indexOf('\t', tab + 1);
        const item = byPath.get(token.slice(tab2 + 1));
        if (!item) continue;
        const add = token.slice(0, tab), del = token.slice(tab + 1, tab2);
        if (add === '-') item.binary = true;
        else { item.add = Number(add); item.del = Number(del); }
      }
    }
    return out;
  }
  async diff(base, head) {
    const [a, b] = await Promise.all([this.snapshot(base), this.snapshot(head)]);
    if (a.root !== b.root) throw Error('Cannot compare different workspaces');
    const old = new Map(a.manifest.map(f => [f.path, f])), next = new Map(b.manifest.map(f => [f.path, f]));
    return [...new Set([...old.keys(), ...next.keys()])].sort().filter(p => JSON.stringify(old.get(p)) !== JSON.stringify(next.get(p))).map(p => ({ path: p, old: old.get(p) || null, next: next.get(p) || null, unavailable: old.get(p)?.unavailable || next.get(p)?.unavailable || null }));
  }
  // Invariant (design/81): an object row exists only for an object that is
  // on disk, loose or packed. The file is written before its row; both are
  // removed together by maintenance while no capture of the folder runs.
  async storeBlob(root, bytes) {
    const repo = await this.init(root), oid = blobId(bytes), dest = path.join(repo, 'objects', oid.slice(0, 2), oid.slice(2));
    const known = () => this.db.prepare('SELECT 1 FROM checkpoint_objects WHERE root=? AND oid=?').get(root, oid);
    if (known()) return oid;
    const packed = deflateSync(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
    const full = () => { const u = this.usage(); return !(u.limit > 0) || u.total + packed.length > u.limit ? u : null; };
    const early = full();
    if (early) { this.maintainSoon(); throw Error(this.fullMessage(early)); }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const temp = dest + '.' + crypto.randomUUID();
    try {
      const f = await fsp.open(temp, 'wx', 0o600);
      try { await f.writeFile(packed); await f.sync(); } finally { await f.close(); }
      try { await fsp.link(temp, dest); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      require('./platform.js').syncDirSync(path.dirname(dest)); // nothing to do on Windows, which journals the link
    } finally { await fsp.rm(temp, { force: true }); }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!known()) {
        // A refused object stays as an unreferenced file; the next
        // maintenance removes it with every other unreferenced object.
        const over = full();
        if (over) throw Object.assign(Error(this.fullMessage(over)), { full: true });
        this.db.prepare('INSERT INTO checkpoint_objects(root,oid,bytes,added) VALUES (?,?,?,?)').run(root, oid, packed.length, Date.now());
        this.db.prepare('INSERT INTO checkpoint_roots(root,pending_bytes,pending_objects) VALUES (?,?,1) ON CONFLICT(root) DO UPDATE SET pending_bytes=pending_bytes+excluded.pending_bytes, pending_objects=pending_objects+1').run(root, packed.length);
      }
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); if (e.full) this.maintainSoon(); throw e; }
    return oid;
  }
  async recordTarget(root, file, text, state) {
    const oid = state === 'deleted' ? null : await this.storeBlob(root, Buffer.from(text));
    const last = this.db.prepare('SELECT * FROM checkpoint_target_versions WHERE root=? AND path=? ORDER BY id DESC LIMIT 1').get(root, file);
    if (last && last.oid === oid && last.state === state) return last.id;
    return Number(this.db.prepare('INSERT INTO checkpoint_target_versions(root,path,oid,state,at) VALUES (?,?,?,?,?)').run(root, file, oid, state, Date.now()).lastInsertRowid);
  }
  async targetContent(file, version, storage = 'git') {
    if (storage === 'legacy') {
      this._legacyTargets ||= new DatabaseSync(path.join(this.dir, 'targets.sqlite'), { readOnly: true });
      const value = require('./file-archive').FileArchive.prototype.snapshot.call({ db: this._legacyTargets }, file, version);
      return { text: value.content, absent: value.state === 'deleted', oid: value.state === 'deleted' ? null : blobId(Buffer.from(value.content)) };
    }
    const row = this.db.prepare('SELECT * FROM checkpoint_target_versions WHERE path=? AND id=?').get(file, version);
    if (!row) {
      const gone = this.db.prepare('SELECT before FROM checkpoint_removed WHERE id=?').get('target:' + version);
      throw Error(gone ? removedMessage(gone.before) : 'Target version not found for this file');
    }
    if (row.state === 'deleted') return { text: '', absent: true, oid: null };
    return { text: (await git(['--git-dir=' + this.repo(row.root), 'cat-file', 'blob', row.oid], { max: 2 * 1024 * 1024 })).toString('utf8'), oid: row.oid };
  }
  async captureTargets(root, locations) {
    const result = [];
    for (const loc of locations.slice(0, 32)) {
      if (loc.host !== 'local' || !loc.path) continue;
      const file = path.resolve(loc.path); let version = null, error = '';
      try {
        if (sensitive(file) || !permittedLocal(file, root) || inside(this.dir, file) || file.split(path.sep).some(p => SKIP.has(p))) throw Error('Protected target: ' + file);
        let text, state = 'present';
        try {
          const stat = await fsp.lstat(file);
          if (!stat.isFile() || stat.size > 2 * 1024 * 1024 || await fsp.realpath(file) !== file) throw Error('Target is not an eligible regular text file');
          const h = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
          try {
            const bytes = Buffer.alloc(stat.size + 1); let n = 0;
            while (n < bytes.length) { const r = await h.read(bytes, n, bytes.length - n, n); if (!r.bytesRead) break; n += r.bytesRead; }
            const after = await h.stat();
            if (after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || n !== stat.size) throw Error('Target changed during capture');
            const data = bytes.subarray(0, n);
            if (data.includes(0) || !Buffer.from(data.toString('utf8')).equals(data)) throw Error('Binary target: preview available, text history not captured');
            text = data.toString('utf8');
          } finally { await h.close(); }
        } catch (e) { if (e.code !== 'ENOENT') throw e; state = 'deleted'; }
        version = await this.recordTarget(root, file, text, state);
      } catch (e) { error = e.message; }
      result.push({ location: loc, version, error });
    }
    return result;
  }
  targetVersion(id) { return this.db.prepare('SELECT id, root, path, oid, state FROM checkpoint_target_versions WHERE id=?').get(id) || null; }
  targets(boundary) {
    return [...this.db.prepare("SELECT *, 'git' AS storage FROM checkpoint_target_links WHERE boundary=?").all(boundary),
      ...this.db.prepare("SELECT *, 'legacy' AS storage FROM checkpoint_targets WHERE boundary=?").all(boundary)]
      .map(r => ({ ...r, location: JSON.parse(r.location) }));
  }
  // A folder inside the store, or one that contains it (home, ~/.local):
  // either way, saving it would mean the store saving itself.
  overlapsStore(folder) { return inside(this.dir, folder) || inside(folder, this.dir); }
  scopes(root) { return this.db.prepare('SELECT path FROM checkpoint_scopes WHERE root=? ORDER BY path').all(root).map(r => r.path); }
  // Artifacts (design/67, design/101), saved at every capture with their
  // pictures and fonts: a file with what it uses, or a folder, whole while
  // it is small. Folders recorded before design/101 (artifact_scopes) count
  // as folders until the server converts them.
  artifactEntries(root) {
    const since = Date.now() - ARTIFACT_DAYS * 86400000;
    const rows = this.db.prepare('SELECT path, folder, declared FROM artifact_entries WHERE root=? AND declared>=? ORDER BY path').all(root, since)
      .map(r => ({ path: r.path, folder: !!r.folder, declared: r.declared }));
    const known = new Set(rows.map(r => r.path));
    for (const r of this.db.prepare('SELECT path FROM artifact_scopes WHERE root=? ORDER BY path').all(root)) if (!known.has(r.path)) rows.push({ path: r.path, folder: true, declared: 0, legacy: true });
    return rows;
  }
  artifactScopes(root) { return this.artifactEntries(root).map(e => e.path); }
  // Declares what the artifact tool showed. Returns how it is saved: whole
  // (a small folder), or its page and the files the page uses.
  async declareArtifact(cwd, target) {
    const root = await this.root(cwd), real = await fsp.realpath(target);
    if (!inside(root, real)) throw Error('The artifact is outside this conversation\'s workspace');
    const stat = await fsp.stat(real), folder = stat.isDirectory();
    if (sensitive(real) || (folder ? this.overlapsStore(real) : inside(this.dir, real)) || path.relative(root, real).split(path.sep).some(p => SKIP.has(p)))
      throw Error(folder ? 'This folder cannot be versioned' : 'This file cannot be versioned');
    if (!folder && !stat.isFile()) throw Error('Only a file or a folder can be versioned');
    this.db.prepare('INSERT INTO artifact_entries VALUES (?,?,?,?) ON CONFLICT(root,path) DO UPDATE SET folder=excluded.folder, declared=excluded.declared').run(root, real, folder ? 1 : 0, Date.now());
    this.folderVerdicts.delete(real);
    const out = { root, scope: real, folder, whole: !folder, over: '', entry: folder ? '' : real };
    if (folder) {
      const v = await this.folderFiles(real);
      out.whole = !v.over; out.over = v.over;
      if (v.over) for (const name of PAGE_ENTRIES) if ((await fsp.lstat(path.join(real, name)).catch(() => null))?.isFile()) { out.entry = path.join(real, name); break; }
    }
    return out;
  }
  async addArtifactScope(cwd, folder) {
    if (!(await fsp.stat(folder)).isDirectory()) throw Error('An artifact scope must be a folder');
    return this.declareArtifact(cwd, folder);
  }
  // Folders recorded before design/101 became artifacts because a file in
  // them was shown, so each saved everything beside that file. They become
  // what was actually declared there: declared(folder) lists the artifacts
  // conversations showed (absolute paths, with when). A folder nobody is
  // known to have shown is dropped. Owner only, once.
  async convertLegacyScopes(declared) {
    const rows = this.db.prepare('SELECT root, path FROM artifact_scopes').all();
    let kept = 0, dropped = 0;
    const shown = [];
    if (rows.length) for (const d of declared) {
      const real = await fsp.realpath(d.path).catch(() => null);
      const stat = real && await fsp.stat(real).catch(() => null);
      if (stat && (stat.isFile() || stat.isDirectory())) shown.push({ path: real, folder: stat.isDirectory(), at: d.at || Date.now() });
    }
    for (const { root, path: folder } of rows) {
      const found = shown.filter(s => (s.path === folder || path.dirname(s.path) === folder) && inside(root, s.path));
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const f of found) this.db.prepare('INSERT INTO artifact_entries VALUES (?,?,?,?) ON CONFLICT(root,path) DO UPDATE SET declared=MAX(declared,excluded.declared)').run(root, f.path, f.folder ? 1 : 0, f.at);
        this.db.prepare('DELETE FROM artifact_scopes WHERE root=? AND path=?').run(root, folder);
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
      if (found.length) kept++; else dropped++;
    }
    return { folders: rows.length, kept, dropped };
  }
  // Boundaries by tool call id alone: a parallel answer's calls ran in a fork
  // file that was later folded into the conversation.
  boundariesByCalls(calls) {
    if (!calls.length) return [];
    const out = [];
    for (let i = 0; i < calls.length; i += 400) {
      const part = calls.slice(i, i + 400);
      out.push(...this.db.prepare(`SELECT * FROM checkpoint_boundaries WHERE call IN (${part.map(() => '?').join(',')}) ORDER BY id`).all(...part));
    }
    return out.sort((a, b) => a.id - b.id);
  }
  async blob(root, oid) {
    if (!/^[0-9a-f]{40}$/.test(oid)) throw Error('Invalid object id');
    return git(['--git-dir=' + this.repo(root), 'cat-file', 'blob', oid], { max: ARTIFACT_FILE_MAX + 1024 });
  }
  revokeScope(root, scope) { this.db.prepare('DELETE FROM checkpoint_scopes WHERE root=? AND path=?').run(root, path.resolve(scope)); return this.scopes(root); }
  async approveScope(root, scope) {
    root = await fsp.realpath(root); scope = await fsp.realpath(scope);
    if (scope === root || !inside(root, scope) || sensitive(scope) || this.overlapsStore(scope) || scope.split(path.sep).some(p => SKIP.has(p))) throw Error('Choose an eligible subfolder inside this workspace');
    if (!(await fsp.stat(scope)).isDirectory()) throw Error('Capture scope must be a folder');
    this.db.prepare('INSERT OR IGNORE INTO checkpoint_scopes VALUES (?,?)').run(root, scope);
    return this.scopes(root);
  }
  close() {
    this.closed = true; clearTimeout(this.soon);
    for (const r of this.readers.values()) r.close();
    this.readers.clear(); this._legacyTargets?.close(); this.db.close();
  }
}
module.exports = { CheckpointStore, READ_ONLY, git, blobId, cleanGitEnv, removedMessage, packList, unpackList, references, ARTIFACT_FILE_MAX, FOLDER_FILES_MAX, FOLDER_BYTES_MAX, PAGE_FILES_MAX, HIGH, LOW, MB };
