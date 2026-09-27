'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { sensitive } = require('./task-locations');
const SKIP = new Set(['.git', 'node_modules', '.venv', '.direnv', 'target', '__pycache__']);
const READ_ONLY = new Set(['read', 'ls', 'find', 'grep']);
const ARTIFACT_FILE_MAX = 25 * 1024 * 1024;
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const blobId = b => crypto.createHash('sha1').update(Buffer.from(`blob ${b.length}\0`)).update(b).digest('hex');
const inside = (root, p) => p === root || p.startsWith(root + path.sep);
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
  constructor(dir = process.env.CHATTERING_CHECKPOINT_DIR || path.join(require('./platform.js').appDirs().data, 'checkpoints')) {
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
      CREATE INDEX IF NOT EXISTS checkpoint_call_only ON checkpoint_boundaries(call,id);`);
    this.queues = new Map(); this.cache = new Map(); this.ready = new Map();
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
          try { await require('./platform.js').renameRetry(temp, repo); } catch (e) { if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e; }
        } finally { await fsp.rm(temp, { recursive: true, force: true }); }
      }
      return repo;
    })();
    this.ready.set(root, work); try { return await work; } catch (e) { this.ready.delete(root); throw e; }
  }
  async paths(root, { artifactsOnly = false } = {}) {
    let paths = [];
    if (!artifactsOnly) {
      const normal = await git(['rev-parse', '--is-inside-work-tree'], { cwd: root }).then(b => b.toString().trim() === 'true').catch(() => false);
      const args = normal ? ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
        : ['--git-dir=' + this.repo(root), '--work-tree=' + root, 'ls-files', '-z', '--others', '--exclude-standard'];
      // Never fall back to an unfiltered filesystem walk after an enumeration
      // failure: that could silently capture ignored secrets or build output.
      paths = (await git(args, { cwd: root })).toString('utf8').split('\0').filter(Boolean);
    }
    const visit = async file => {
      if (paths.length > 20000) throw Error('Approved capture scope exceeds the file limit');
      const stat = await fsp.lstat(file).catch(() => null);
      if (!stat || stat.isSymbolicLink() || sensitive(file)) return;
      if (stat.isDirectory()) {
        for (const e of await fsp.readdir(file, { withFileTypes: true })) if (!SKIP.has(e.name)) await visit(path.join(file, e.name));
      } else if (stat.isFile()) paths.push(path.relative(root, file).split(path.sep).join('/'));
    };
    // Approved scopes and artifact folders are walked explicitly: an artifact
    // (design/67) is often build output a .gitignore would hide.
    for (const scope of artifactsOnly ? this.artifactScopes(root) : [...this.scopes(root), ...this.artifactScopes(root)]) {
      const real = await fsp.realpath(scope).catch(() => null);
      if (real === scope && inside(root, real)) await visit(real);
    }
    return paths;
  }
  async capture(cwd, meta = {}) {
    const root = await this.root(cwd), prior = this.queues.get(root) || Promise.resolve();
    const work = prior.catch(() => {}).then(() => this.captureRoot(root, meta));
    this.queues.set(root, work);
    try { return await work; } finally { if (this.queues.get(root) === work) this.queues.delete(root); }
  }
  async captureRoot(root, meta) {
    const started = Date.now(); let snapshot = null, error = '';
    const targets = await this.captureTargets(root, meta.targets || []);
    if (meta.run && meta.review) this.db.prepare('INSERT OR IGNORE INTO checkpoint_runs VALUES (?,?,?)').run(meta.run, meta.session || '', meta.review);
    const artifactsOnly = !!meta.targetOnly && this.artifactScopes(root).length > 0;
    if (!meta.targetOnly || artifactsOnly) try { snapshot = await this.scan(root, started, { artifactsOnly }); } catch (e) { error = e.message; }
    const active = this.db.prepare(`SELECT 1 FROM checkpoint_boundaries b WHERE b.root=? AND b.phase='before' AND b.started>? AND NOT (b.session=? AND b.run=? AND b.call=?) AND NOT EXISTS (SELECT 1 FROM checkpoint_boundaries e WHERE e.session=b.session AND e.run=b.run AND e.call=b.call AND e.id>b.id AND e.phase IN ('after','after-error','settled-incomplete')) LIMIT 1`).get(root, started - 86400000, meta.session || '', meta.run || '', meta.call || '');
    const row = this.db.prepare(`INSERT INTO checkpoint_boundaries(root,session,run,call,tool,phase,started,finished,snapshot,error,overlapping) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(root, meta.session || '', meta.run || '', meta.call || '', meta.tool || '', meta.phase || 'observation', started, Date.now(), snapshot?.id || null, error, meta.overlapping || active ? 1 : 0);
    const id = Number(row.lastInsertRowid);
    for (const target of targets) this.db.prepare('INSERT INTO checkpoint_target_links VALUES (?,?,?,?)').run(id, JSON.stringify(target.location), target.version, target.error);
    return { id, root, snapshot: snapshot?.id || null, error, targetErrors: targets.filter(t => t.error).map(t => t.error) };
  }
  async scan(root, started, { artifactsOnly = false } = {}) {
    if (inside(root, this.dir)) throw Error('Checkpoint storage must be outside the captured workspace');
    const repo = await this.init(root), manifest = [];
    const paths = [...new Set(await this.paths(root, { artifactsOnly }))].sort();
    const artifactDirs = this.artifactScopes(root);
    const inArtifact = full => artifactDirs.some(dir => inside(dir, full));
    if (paths.length > 20000) throw Error('Checkpoint file limit exceeded (20,000)');
    let total = 0;
    const limit = Number(process.env.CHATTERING_CHECKPOINT_MB || 1024) * 1024 * 1024;
    let used = this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM checkpoint_objects').get().n;
    if (!(limit > 0) || used >= limit) throw Error('Checkpoint storage budget reached; existing checkpoints are retained');
    for (const rel of paths) {
      if (rel.split('/').some(p => SKIP.has(p))) continue;
      if (sensitive(rel)) { manifest.push({ path: rel, unavailable: 'Protected sensitive path' }); continue; }
      if (Date.now() - started > 15000) throw Error('Checkpoint scan exceeded 15 seconds');
      const full = path.resolve(root, rel);
      if (!inside(root, full)) throw Error('Checkpoint path escaped the workspace');
      let stat;
      try { stat = await fsp.lstat(full); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (stat.isDirectory()) { manifest.push({ path: rel, unavailable: 'Nested repository/directory entry' }); continue; }
      // Inside an artifact folder, pictures, fonts, sounds and documents are
      // part of what the person sees, so they are versioned too (up to 25 MiB
      // each, within the same storage budget).
      const artifact = inArtifact(full);
      const maxBytes = artifact ? ARTIFACT_FILE_MAX : 2 * 1024 * 1024;
      if (!artifact && /\.(?:png|jpe?g|gif|webp|wav|mp3|ogg|mp4|pdf|zip|gz|sqlite|db|pyc|woff2?|ttf|so|dll|exe)$/i.test(rel)) { manifest.push({ path: rel, unavailable: 'Binary artifact; use its current-file preview' }); continue; }
      if (!stat.isFile() || stat.size > maxBytes || !inside(root, await fsp.realpath(full))) { manifest.push({ path: rel, unavailable: artifact ? 'Symlink, special file, or file over 25 MiB' : 'Symlink, special file, or file over 2 MiB' }); continue; }
      total += stat.size; if (total > 200 * 1024 * 1024) throw Error('Checkpoint workspace exceeds 200 MiB of eligible files');
      const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`;
      const cached = this.cache.get(full);
      let oid = cached?.fingerprint === fingerprint ? cached.oid : null;
      if (!oid) {
        const handle = await fsp.open(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        let bytes;
        try {
          const buffer = Buffer.alloc(stat.size + 1); let size = 0;
          while (size < buffer.length) { const r = await handle.read(buffer, size, buffer.length - size, size); if (!r.bytesRead) break; size += r.bytesRead; }
          bytes = buffer.subarray(0, size); const after = await handle.stat();
          if (bytes.length > maxBytes || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size || after.ctimeMs !== stat.ctimeMs) throw Error('File changed during checkpoint scan: ' + rel);
        } finally { await handle.close(); }
        if (!artifact && (bytes.includes(0) || !Buffer.from(bytes.toString('utf8')).equals(bytes))) { manifest.push({ path: rel, unavailable: 'Binary or non-UTF-8 contents' }); continue; }
        oid = await this.storeBlob(root, bytes);
        this.cache.set(full, { fingerprint, oid });
        if (this.cache.size > 40000) this.cache.delete(this.cache.keys().next().value);
      }
      manifest.push({ path: rel, oid, mode: stat.mode & 0o111 ? '100755' : '100644' });
    }
    const index = path.join(path.dirname(repo), 'index-' + crypto.randomUUID());
    const env = { GIT_INDEX_FILE: index }, args = ['--git-dir=' + repo];
    try {
      await git([...args, 'read-tree', '--empty'], { env });
      await git([...args, 'update-index', '-z', '--index-info'], { env, input: manifest.filter(f => f.oid).map(f => `${f.mode} ${f.oid}\t${f.path}\0`).join('') });
      const tree = (await git([...args, 'write-tree'], { env })).toString().trim();
      const json = JSON.stringify(manifest), id = hash(root + '\0' + tree + '\0' + json);
      const existing = this.db.prepare('SELECT * FROM checkpoint_snapshots WHERE id=?').get(id);
      if (existing) return existing;
      let commit;
      for (let attempt = 0; attempt < 20; attempt++) {
        const parent = await git([...args, 'rev-parse', '--verify', 'refs/heads/checkpoints']).then(b => b.toString().trim()).catch(() => null);
        commit = (await git([...args, 'commit-tree', tree, ...(parent ? ['-p', parent] : [])], { input: 'Workspace checkpoint\n', env: { GIT_AUTHOR_NAME: 'Workspace', GIT_AUTHOR_EMAIL: 'workspace@localhost', GIT_COMMITTER_NAME: 'Workspace', GIT_COMMITTER_EMAIL: 'workspace@localhost' } })).toString().trim();
        try { await git([...args, 'update-ref', 'refs/heads/checkpoints', commit, parent || '0'.repeat(40)]); break; }
        catch (e) { if (attempt === 19) throw e; }
      }
      this.db.prepare('INSERT OR IGNORE INTO checkpoint_snapshots VALUES (?,?,?,?,?)').run(id, root, commit, tree, json);
      return { id, root, commit_hash: commit, tree, manifest: json };
    } finally { await fsp.rm(index, { force: true }); }
  }
  snapshot(id) {
    const row = this.db.prepare('SELECT * FROM checkpoint_snapshots WHERE id=?').get(id);
    if (!row) throw Error('Checkpoint not found');
    return { ...row, manifest: JSON.parse(row.manifest) };
  }
  boundaries(session, calls) {
    if (!calls.length) return [];
    return this.db.prepare(`SELECT * FROM checkpoint_boundaries WHERE session=? AND call IN (${calls.map(() => '?').join(',')}) ORDER BY id`).all(session, ...calls);
  }
  async content(snapshot, rel) {
    const s = this.snapshot(snapshot), item = s.manifest.find(f => f.path === rel);
    if (!item) return { text: '', absent: true, oid: null };
    if (item.unavailable) return { unavailable: item.unavailable, oid: null };
    return { text: (await git(['--git-dir=' + this.repo(s.root), 'cat-file', 'blob', item.oid], { max: 2 * 1024 * 1024 })).toString('utf8'), oid: item.oid };
  }
  diff(base, head) {
    const a = this.snapshot(base), b = this.snapshot(head);
    if (a.root !== b.root) throw Error('Cannot compare different workspaces');
    const old = new Map(a.manifest.map(f => [f.path, f])), next = new Map(b.manifest.map(f => [f.path, f]));
    return [...new Set([...old.keys(), ...next.keys()])].sort().filter(p => JSON.stringify(old.get(p)) !== JSON.stringify(next.get(p))).map(p => ({ path: p, old: old.get(p) || null, next: next.get(p) || null, unavailable: old.get(p)?.unavailable || next.get(p)?.unavailable || null }));
  }
  async storeBlob(root, bytes) {
    const repo = await this.init(root), oid = blobId(bytes), dest = path.join(repo, 'objects', oid.slice(0, 2), oid.slice(2));
    if (this.db.prepare('SELECT 1 FROM checkpoint_objects WHERE root=? AND oid=?').get(root, oid) && fs.existsSync(dest)) return oid;
    const packed = deflateSync(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
    const limit = Number(process.env.CHATTERING_CHECKPOINT_MB || 1024) * 1024 * 1024;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const known = this.db.prepare('SELECT 1 FROM checkpoint_objects WHERE root=? AND oid=?').get(root, oid);
      const used = this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM checkpoint_objects').get().n;
      if (!(limit > 0) || !known && used + packed.length > limit) throw Error('Checkpoint storage budget reached');
      this.db.prepare('INSERT OR IGNORE INTO checkpoint_objects VALUES (?,?,?)').run(root, oid, packed.length);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    const temp = dest + '.' + crypto.randomUUID();
    try {
      const f = await fsp.open(temp, 'wx', 0o600);
      try { await f.writeFile(packed); await f.sync(); } finally { await f.close(); }
      try { await fsp.link(temp, dest); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const directory = await fsp.open(path.dirname(dest), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await fsp.rm(temp, { force: true }); }
    return oid;
  }
  async recordTarget(root, file, text, state) {
    const oid = state === 'deleted' ? null : await this.storeBlob(root, Buffer.from(text));
    const last = this.db.prepare('SELECT * FROM checkpoint_target_versions WHERE root=? AND path=? ORDER BY id DESC LIMIT 1').get(root, file);
    if (last && last.oid === oid && last.state === state) return last.id;
    if (oid) await git(['--git-dir=' + this.repo(root), 'update-ref', 'refs/target-blobs/' + oid, oid]);
    return Number(this.db.prepare('INSERT INTO checkpoint_target_versions(root,path,oid,state,at) VALUES (?,?,?,?,?)').run(root, file, oid, state, Date.now()).lastInsertRowid);
  }
  async targetContent(file, version, storage = 'git') {
    if (storage === 'legacy') {
      this._legacyTargets ||= new DatabaseSync(path.join(this.dir, 'targets.sqlite'), { readOnly: true });
      const value = require('./file-archive').FileArchive.prototype.snapshot.call({ db: this._legacyTargets }, file, version);
      return { text: value.content, absent: value.state === 'deleted', oid: value.state === 'deleted' ? null : blobId(Buffer.from(value.content)) };
    }
    const row = this.db.prepare('SELECT * FROM checkpoint_target_versions WHERE path=? AND id=?').get(file, version);
    if (!row) throw Error('Target version not found for this file');
    if (row.state === 'deleted') return { text: '', absent: true, oid: null };
    return { text: (await git(['--git-dir=' + this.repo(row.root), 'cat-file', 'blob', row.oid], { max: 2 * 1024 * 1024 })).toString('utf8'), oid: row.oid };
  }
  async captureTargets(root, locations) {
    const result = [];
    for (const loc of locations.slice(0, 32)) {
      if (loc.host !== 'local' || !loc.path) continue;
      const file = path.resolve(loc.path); let version = null, error = '';
      try {
        if (sensitive(file) || !(inside(root, file) || inside(os.homedir(), file) || inside(os.tmpdir(), file)) || inside(this.dir, file) || file.split(path.sep).some(p => SKIP.has(p))) throw Error('Protected target: ' + file);
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
  targets(boundary) {
    return [...this.db.prepare("SELECT *, 'git' AS storage FROM checkpoint_target_links WHERE boundary=?").all(boundary),
      ...this.db.prepare("SELECT *, 'legacy' AS storage FROM checkpoint_targets WHERE boundary=?").all(boundary)]
      .map(r => ({ ...r, location: JSON.parse(r.location) }));
  }
  scopes(root) { return this.db.prepare('SELECT path FROM checkpoint_scopes WHERE root=? ORDER BY path').all(root).map(r => r.path); }
  // Artifact folders (design/67): always captured, binary assets included.
  artifactScopes(root) { return this.db.prepare('SELECT path FROM artifact_scopes WHERE root=? ORDER BY path').all(root).map(r => r.path); }
  async addArtifactScope(cwd, folder) {
    const root = await this.root(cwd), scope = await fsp.realpath(folder);
    if (!inside(root, scope)) throw Error('The artifact is outside this conversation\'s workspace');
    if (sensitive(scope) || inside(this.dir, scope) || scope.split(path.sep).some(p => SKIP.has(p))) throw Error('This folder cannot be versioned');
    if (!(await fsp.stat(scope)).isDirectory()) throw Error('An artifact scope must be a folder');
    this.db.prepare('INSERT OR IGNORE INTO artifact_scopes VALUES (?,?)').run(root, scope);
    return { root, scope };
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
    if (scope === root || !inside(root, scope) || sensitive(scope) || inside(this.dir, scope) || scope.split(path.sep).some(p => SKIP.has(p))) throw Error('Choose an eligible subfolder inside this workspace');
    if (!(await fsp.stat(scope)).isDirectory()) throw Error('Capture scope must be a folder');
    this.db.prepare('INSERT OR IGNORE INTO checkpoint_scopes VALUES (?,?)').run(root, scope);
    return this.scopes(root);
  }
  close() { this._legacyTargets?.close(); this.db.close(); }
}
module.exports = { CheckpointStore, READ_ONLY, git, blobId, ARTIFACT_FILE_MAX };
