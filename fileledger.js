'use strict';
// fileledger.js — the file edit ledger (design/33-files-mode.md §4).
//
// One row per recorded change to one file: an agent's edit / write / shell
// mutation mined from a transcript, a save or commit made in the Chattering
// editor, a Git commit, or a write seen by the filesystem watcher. The
// ledger is a derived cache under ~/.cache/chattering (node:sqlite, like the
// search index): delete it and the next boot rebuilds it from transcripts,
// Git, and the editor's own provenance log.
//
// Truth rules carried here:
// · attempted / applied / failed stay separate (outcome);
// · the actor is `human` only when the Chattering editor made the change,
//   `ai` when a transcript records it, `git` for commits, and `external`
//   for anything the watcher saw that nothing explains — never "you";
// · a watcher event within the dedupe window of an agent or editor event
//   is the same change seen twice and is dropped;
// · magnitude is characters when the producer knows them, else lines × 40
//   and flagged approx.

const path = require('path');

const SCHEMA_VERSION = 2;

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {}

const PRODUCERS = new Set(['ai-edit', 'ai-write', 'ai-shell', 'editor-save', 'editor-commit', 'git-commit', 'watch', 'working']);
const ACTORS = new Set(['ai', 'human', 'git', 'external']);
const OUTCOMES = new Set(['attempted', 'applied', 'failed']);

// A watcher event this close to an explained change is that change.
// Agent timestamps are the tool-call time; the write lands a little later,
// so the window is asymmetric: long after, short before.
const DEDUPE_BEFORE_MS = 3000;
const DEDUPE_AFTER_MS = 20000;

// Human and external events closer than this belong to one edit session.
const SESSION_GAP_MS = 10 * 60 * 1000;
const CHARS_PER_LINE = 40;

const DOC_EXT = /\.(md|markdown|qmd|rmd|mdx|txt|rst|org|tex|ipynb)$/i;
function fileKind(p) { return DOC_EXT.test(String(p || '')) ? 'docs' : 'code'; }

function magnitudeOf(ev) {
  if (Number.isFinite(ev.chars) && ev.chars !== null) return { value: Math.max(1, Math.abs(ev.chars)), approx: false };
  const lines = (Number(ev.added) || 0) + (Number(ev.removed) || 0);
  return { value: Math.max(1, lines * CHARS_PER_LINE), approx: true };
}

// Group one file's events into edit sessions (design §3.3):
// · ai: one session per conversation (conversation × file);
// · human / external: gap-based, per actor;
// · git commits are returned apart, never merged.
function groupSessions(events, { gapMs = SESSION_GAP_MS } = {}) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)));
  const commits = [];
  const sessions = [];
  const open = new Map(); // group key -> session
  for (const ev of sorted) {
    if (ev.actor === 'git') {
      commits.push({ id: ev.id, ts: ev.ts, hash: ev.commit_hash, added: ev.added, removed: ev.removed });
      continue;
    }
    // Human sessions are per person: two people editing the same file are
    // two sessions, each with its user.
    const groupKey = ev.actor === 'ai' ? 'ai:' + (ev.conv_key || '?') : ev.actor === 'human' && ev.user_id ? 'human:' + ev.user_id : ev.actor;
    let session = open.get(groupKey);
    if (session && ev.actor !== 'ai' && ev.ts - session.end > gapMs) session = null;
    if (!session) {
      session = {
        id: groupKey + ':' + ev.ts, actor: ev.actor, start: ev.ts, end: ev.ts,
        added: 0, removed: 0, chars: 0, approx: false, n: 0, failed: 0,
        convKey: ev.actor === 'ai' ? ev.conv_key || null : null,
        userId: ev.actor === 'human' ? ev.user_id || null : null,
        firstEventId: ev.id, lastEventId: ev.id, events: [],
      };
      sessions.push(session);
      open.set(groupKey, session);
    }
    session.end = Math.max(session.end, ev.ts);
    session.lastEventId = ev.id;
    session.n++;
    if (ev.outcome === 'failed') { session.failed++; session.events.push({ ts: ev.ts, mag: 0, failed: true }); continue; }
    const mag = magnitudeOf(ev);
    session.added += Number(ev.added) || 0;
    session.removed += Number(ev.removed) || 0;
    session.chars += mag.value;
    if (mag.approx) session.approx = true;
    session.events.push({ ts: ev.ts, mag: mag.value });
  }
  for (const s of sessions) {
    s.bins = binsFor(s);
    delete s.events;
  }
  return { sessions: collapseForkTwins(sessions), commits };
}

// Forks copy the root chain of a conversation, so the same tool calls sit
// in several session files. Identical AI sessions (same span, count, and
// magnitude) on one file are one piece of work: keep the first key, list
// the twins. The client can still reach every branch through the tree.
function collapseForkTwins(sessions) {
  const seen = new Map();
  const out = [];
  for (const s of sessions) {
    if (s.actor !== 'ai') { out.push(s); continue; }
    const sig = [s.start, s.end, s.n, s.chars, s.added, s.removed].join(':');
    const twin = seen.get(sig);
    if (twin) { (twin.twins = twin.twins || []).push(s.convKey); continue; }
    seen.set(sig, s);
    out.push(s);
  }
  return out;
}

// The violin profile: magnitude per time bin across the session span.
function binsFor(session) {
  const span = session.end - session.start;
  const n = Math.max(1, Math.min(24, Math.round(span / 60000)));
  const bins = new Array(n).fill(0);
  for (const e of session.events) {
    const i = span > 0 ? Math.min(n - 1, Math.floor((e.ts - session.start) / span * n)) : 0;
    bins[i] += e.mag;
  }
  return bins;
}

class FileLedger {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    if (v !== SCHEMA_VERSION) {
      this.db.exec('DROP TABLE IF EXISTS file_events; DROP TABLE IF EXISTS meta;');
      this.db.exec(`
        CREATE TABLE file_events (
          id TEXT PRIMARY KEY,
          ts INTEGER NOT NULL,
          path TEXT NOT NULL,
          repo_root TEXT NOT NULL DEFAULT '',
          project TEXT NOT NULL DEFAULT '',
          producer TEXT NOT NULL,
          actor TEXT NOT NULL,
          outcome TEXT NOT NULL DEFAULT 'applied',
          added INTEGER NOT NULL DEFAULT 0,
          removed INTEGER NOT NULL DEFAULT 0,
          chars INTEGER,
          sha_after TEXT,
          conv_key TEXT,
          call_id TEXT,
          commit_hash TEXT,
          input TEXT,
          src_version TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX file_events_path_ts ON file_events(path, ts);
        CREATE INDEX file_events_ts ON file_events(ts);
        CREATE INDEX file_events_project_ts ON file_events(project, ts);
        CREATE INDEX file_events_conv ON file_events(conv_key);
        CREATE INDEX file_events_repo_commit ON file_events(repo_root, commit_hash);
        CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
      `);
      this.db.exec('PRAGMA user_version=' + SCHEMA_VERSION);
    }
    // Who made a human edit (users.js id). Added as a nullable column so
    // an existing ledger keeps its rows: editor saves are not rebuildable.
    if (!this.db.prepare('PRAGMA table_info(file_events)').all().some(c => c.name === 'user_id')) {
      this.db.exec('ALTER TABLE file_events ADD COLUMN user_id TEXT');
    }
    this._groupCache = new Map();
    this._projectVersion = new Map();
    this.stmts = {
      put: this.db.prepare(`INSERT INTO file_events (id, ts, path, repo_root, project, producer, actor, outcome, added, removed, chars, sha_after, conv_key, call_id, commit_hash, input, src_version, user_id)
        VALUES (@id, @ts, @path, @repo_root, @project, @producer, @actor, @outcome, @added, @removed, @chars, @sha_after, @conv_key, @call_id, @commit_hash, @input, @src_version, @user_id)
        ON CONFLICT(id) DO UPDATE SET ts=excluded.ts, path=excluded.path, repo_root=excluded.repo_root, project=excluded.project, producer=excluded.producer, actor=excluded.actor, outcome=excluded.outcome, added=excluded.added, removed=excluded.removed, chars=excluded.chars, sha_after=excluded.sha_after, conv_key=excluded.conv_key, call_id=excluded.call_id, commit_hash=excluded.commit_hash, input=excluded.input, src_version=excluded.src_version, user_id=excluded.user_id`),
      near: this.db.prepare(`SELECT id FROM file_events WHERE path = ? AND ts BETWEEN ? AND ? AND actor IN ('ai','human') LIMIT 1`),
      dropWatchNear: this.db.prepare(`DELETE FROM file_events WHERE path = ? AND producer = 'watch' AND ts BETWEEN ? AND ?`),
      convVersion: this.db.prepare('SELECT src_version FROM file_events WHERE conv_key = ? LIMIT 1'),
      dropConvStale: this.db.prepare('DELETE FROM file_events WHERE conv_key = ? AND src_version <> ?'),
      dropConv: this.db.prepare('DELETE FROM file_events WHERE conv_key = ?'),
      metaGet: this.db.prepare('SELECT v FROM meta WHERE k = ?'),
      metaSet: this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
      window: this.db.prepare(`SELECT * FROM file_events WHERE ts BETWEEN ? AND ? ORDER BY ts`),
      projectsIn: this.db.prepare(`SELECT project, MAX(ts) AS ts FROM file_events WHERE ts BETWEEN ? AND ? GROUP BY project`),
      windowProject: this.db.prepare(`SELECT * FROM file_events WHERE project = ? AND ts BETWEEN ? AND ? ORDER BY ts`),
      byPath: this.db.prepare('SELECT * FROM file_events WHERE path = ? ORDER BY ts'),
      byProject: this.db.prepare('SELECT * FROM file_events WHERE project = ? ORDER BY ts'),
      recentPath: this.db.prepare('SELECT * FROM file_events WHERE path = ? AND ts >= ? ORDER BY ts'),
      projects: this.db.prepare('SELECT DISTINCT project FROM file_events'),
      remap: this.db.prepare('UPDATE file_events SET project = ? WHERE project = ?'),
      count: this.db.prepare('SELECT COUNT(*) AS n FROM file_events'),
      latestByProject: this.db.prepare('SELECT project, MAX(ts) AS ts FROM file_events GROUP BY project'),
      paths: this.db.prepare('SELECT DISTINCT path FROM file_events WHERE project = ?'),
      convPaths: this.db.prepare('SELECT DISTINCT path FROM file_events WHERE conv_key = ?'),
    };
  }

  close() { try { this.db.close(); } catch {} }

  // Bumps on every write: response caches key on it.
  get version() { return this._version || 0; }
  _bumpProject(name) { this._projectVersion.set(name || '', (this._projectVersion.get(name || '') || 0) + 1); }

  // Normalise and store. Returns the number of rows written (watch rows
  // explained by a nearby agent or editor event are dropped, so it can be
  // less than events.length).
  put(events) {
    let n = 0;
    const list = Array.isArray(events) ? events : [events];
    const tx = this.db.prepare('BEGIN'); const end = this.db.prepare('COMMIT');
    tx.run();
    try {
      for (const raw of list) {
        const ev = normalizeEvent(raw);
        if (!ev) continue;
        if (ev.producer === 'watch' || ev.producer === 'working') {
          const hit = this.stmts.near.get(ev.path, ev.ts - DEDUPE_AFTER_MS, ev.ts + DEDUPE_BEFORE_MS);
          if (hit) continue;
        }
        if (ev.actor === 'ai' || ev.actor === 'human') {
          // The explanation arrived after the watcher saw the write.
          this.stmts.dropWatchNear.run(ev.path, ev.ts - DEDUPE_BEFORE_MS, ev.ts + DEDUPE_AFTER_MS);
        }
        this.stmts.put.run(ev);
        n++;
        this._bumpProject(ev.project);
      }
    } finally { end.run(); }
    if (n) this._version = (this._version || 0) + 1;
    return n;
  }

  // Transcript producer: idempotent per conversation version.
  conversationVersion(convKey) {
    const row = this.stmts.convVersion.get(convKey);
    return row ? row.src_version : null;
  }
  putConversation(convKey, version, events) {
    const stale = this.stmts.dropConvStale.run(convKey, version);
    if (stale && stale.changes) this._groupCache.clear();
    this._version = (this._version || 0) + 1;
    return this.put(events.map(e => ({ ...e, conv_key: convKey, src_version: version })));
  }
  dropConversation(convKey) { this.stmts.dropConv.run(convKey); this._groupCache.clear(); this._version = (this._version || 0) + 1; }
  conversationPaths(convKey) { return this.stmts.convPaths.all(convKey).map(r => r.path); }

  meta(k) { const r = this.stmts.metaGet.get(k); return r ? r.v : null; }
  setMeta(k, v) { this.stmts.metaSet.run(k, String(v)); }

  count() { return this.stmts.count.get().n; }
  projects() { return this.stmts.projects.all().map(r => r.project); }
  remapProject(from, to) { this.stmts.remap.run(to, from); this._groupCache.clear(); this._bumpProject(to); }
  latestByProject() { const out = {}; for (const r of this.stmts.latestByProject.all()) out[r.project] = r.ts; return out; }
  projectPaths(project) { return this.stmts.paths.all(project).map(r => r.path); }

  // Home chart: sessions per file per project inside a time window.
  // Grouping is cached per project on that project's own write counter,
  // so an agent busy in one project regroups one project, not forty.
  // Conversation keys are sent once, in `convs`; sessions carry an index.
  timeline({ from, to, project = '', kind = 'all', actor = '', capPerProject = 40, keep = null } = {}) {
    const names = project ? [project] : this.stmts.projectsIn.all(from, to).map(r => r.project);
    const projects = [];
    const convs = [];
    const convIndex = new Map();
    const convRef = key => {
      if (!key) return null;
      let i = convIndex.get(key);
      if (i === undefined) { i = convs.length; convs.push(key); convIndex.set(key, i); }
      return i;
    };
    for (const name of names) {
      const ck = [name, from, to, kind, actor, capPerProject].join('\0');
      const pv = this._projectVersion.get(name) || 0;
      const cached = this._groupCache.get(ck);
      let entry;
      if (cached && cached.pv === pv && cached.keep === keep) entry = cached.entry;
      else {
        entry = this._groupProject(name, { from, to, kind, actor, capPerProject, keep });
        this._groupCache.set(ck, { pv, keep, entry });
        if (this._groupCache.size > 400) this._groupCache.delete(this._groupCache.keys().next().value);
      }
      if (!entry) continue;
      projects.push({ ...entry, rows: entry.rows.map(row => ({ ...row, sessions: row.sessions.map(x => ({ ...x, conv: convRef(x.convKey), convKey: undefined })) })) });
    }
    projects.sort((a, b) => b.latest - a.latest);
    return { from, to, projects, convs };
  }

  _groupProject(name, { from, to, kind, actor, capPerProject, keep }) {
    const rows = this.stmts.windowProject.all(name, from, to);
    const files = new Map();
    let dropped = 0;
    for (const r of rows) {
      if (kind !== 'all' && fileKind(r.path) !== kind) continue;
      if (keep && !keep(r.path, r.project)) { dropped++; continue; }
      if (actor && r.actor !== actor && !(actor === 'human' && r.actor === 'git')) continue;
      let f = files.get(r.path);
      if (!f) { f = { path: r.path, repoRoot: r.repo_root, events: [] }; files.set(r.path, f); }
      f.events.push(r);
    }
    if (!files.size) return null;
    const list = [];
    for (const f of files.values()) {
      const { sessions, commits } = groupSessions(f.events);
      const latest = Math.max(...f.events.map(e => e.ts));
      const magnitude = sessions.reduce((s, x) => s + x.chars, 0) + commits.length * CHARS_PER_LINE;
      list.push({
        path: f.path, repoRoot: f.repoRoot, rel: relOf(f.path, f.repoRoot), kind: fileKind(f.path), latest, magnitude,
        // The chart's diet: no ids the client can rebuild, short hashes.
        sessions: sessions.map(x => ({ actor: x.actor, start: x.start, end: x.end, added: x.added, removed: x.removed, chars: x.chars, approx: x.approx, n: x.n, failed: x.failed, convKey: x.convKey, first: x.firstEventId, last: x.lastEventId, twins: x.twins ? x.twins.length : 0, bins: x.bins.map(Math.round) })),
        commits: commits.map(c => ({ ts: c.ts, hash: c.hash, added: c.added, removed: c.removed })),
      });
    }
    list.sort((a, b) => b.latest - a.latest || b.magnitude - a.magnitude);
    const latest = list.length ? list[0].latest : 0;
    return { project: name, latest, rows: list.slice(0, capPerProject), more: Math.max(0, list.length - capPerProject), files: list.length, outside: dropped };
  }

  // One file: every session and commit, newest first.
  touched(p, { limit = 200 } = {}) {
    const rows = this.stmts.byPath.all(path.resolve(p));
    const { sessions, commits } = groupSessions(rows);
    sessions.sort((a, b) => b.end - a.end);
    commits.sort((a, b) => b.ts - a.ts);
    return { path: path.resolve(p), sessions: sessions.slice(0, limit), commits: commits.slice(0, limit), events: rows.length };
  }

  // Recent raw events for one file (the composer bundle, the tree badges).
  recent(p, sinceMs) { return this.stmts.recentPath.all(path.resolve(p), sinceMs); }

  // Activity summary for one file since a time: the 24 h badge.
  activitySince(p, sinceMs) {
    const rows = this.recent(p, sinceMs).filter(r => r.outcome !== 'failed');
    if (!rows.length) return null;
    return {
      events: rows.length,
      added: rows.reduce((s, r) => s + (r.added || 0), 0),
      removed: rows.reduce((s, r) => s + (r.removed || 0), 0),
      latestTs: Math.max(...rows.map(r => r.ts)),
      actors: [...new Set(rows.map(r => r.actor))],
    };
  }

  // The project masthead: sessions of every file, no cap.
  projectRidge(project) {
    const rows = this.stmts.byProject.all(project);
    const byPath = new Map();
    for (const r of rows) { if (!byPath.has(r.path)) byPath.set(r.path, []); byPath.get(r.path).push(r); }
    const items = [];
    for (const [p, evs] of byPath) {
      const { sessions, commits } = groupSessions(evs);
      for (const s of sessions) items.push({ path: p, rel: relOf(p, evs[0].repo_root), ...s });
      for (const c of commits) items.push({ path: p, rel: relOf(p, evs[0].repo_root), actor: 'git', start: c.ts, end: c.ts, hash: c.hash, added: c.added, removed: c.removed, chars: 0, n: 1, bins: [1] });
    }
    items.sort((a, b) => a.start - b.start);
    return { project, items };
  }
}

function relOf(p, root) {
  if (root && require('./platform.js').isInside(p, root)) return require('./platform.js').toPortable(path.relative(root, p)) || path.basename(p);
  return p.replace(/^\/home\/[^/]+\//, '~/');
}

function normalizeEvent(raw) {
  if (!raw || !raw.id || !raw.path) return null;
  const ts = Number(raw.ts);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const producer = PRODUCERS.has(raw.producer) ? raw.producer : null;
  if (!producer) return null;
  const actor = ACTORS.has(raw.actor) ? raw.actor
    : producer.startsWith('ai-') ? 'ai' : producer.startsWith('editor-') ? 'human' : producer === 'git-commit' ? 'git' : 'external';
  return {
    id: String(raw.id), ts: Math.round(ts), path: path.resolve(String(raw.path)),
    repo_root: raw.repo_root ? String(raw.repo_root) : '', project: raw.project ? String(raw.project) : '',
    producer, actor, outcome: OUTCOMES.has(raw.outcome) ? raw.outcome : 'applied',
    added: Number(raw.added) || 0, removed: Number(raw.removed) || 0,
    chars: Number.isFinite(Number(raw.chars)) && raw.chars !== null && raw.chars !== undefined ? Math.round(Number(raw.chars)) : null,
    sha_after: raw.sha_after ? String(raw.sha_after) : null,
    conv_key: raw.conv_key ? String(raw.conv_key) : null,
    call_id: raw.call_id ? String(raw.call_id) : null,
    commit_hash: raw.commit_hash ? String(raw.commit_hash) : null,
    input: raw.input ? String(raw.input) : null,
    src_version: raw.src_version ? String(raw.src_version) : '',
    user_id: raw.user_id ? String(raw.user_id).slice(0, 80) : null,
  };
}

// Turn one mined transcript diff event (server.js makeDiffEvent shape)
// into a ledger row. Shell mutations carry no text: lines and chars stay 0.
function fromDiffEvent(ev, { repoRoot = '', project = '' } = {}) {
  const ts = Date.parse(ev.ts || '');
  if (!Number.isFinite(ts)) return null;
  const producer = ev.kind === 'write' ? 'ai-write' : ev.kind === 'shell' ? 'ai-shell' : 'ai-edit';
  const stats = ev.stats || {};
  const oldChars = Number(stats.oldChars) || 0, newChars = Number(stats.newChars) || 0;
  const hasText = ev.kind !== 'shell' && (ev.oldText != null || ev.newText != null);
  return {
    id: 'ai:' + ev.id, ts, path: ev.path, repo_root: repoRoot, project: project || ev.project || '',
    producer, actor: 'ai',
    outcome: ev.outcome === 'failed' ? 'failed' : ev.outcome === 'applied' ? 'applied' : 'attempted',
    added: ev.kind === 'write' ? Number(stats.newLines) || 0 : Number(stats.newLines) || 0,
    removed: ev.kind === 'write' ? 0 : Number(stats.oldLines) || 0,
    // Characters touched: what left plus what arrived. A write counts its
    // whole new text (the old one is not recorded).
    chars: hasText ? oldChars + newChars : null,
    conv_key: ev.key, call_id: ev.callId || null,
  };
}

function openFileLedger(dbPath) {
  if (!DatabaseSync) return null;
  try { return new FileLedger(dbPath); }
  catch (e) { console.error('file ledger unavailable:', e.message); return null; }
}

module.exports = {
  openFileLedger, FileLedger, groupSessions, fromDiffEvent, normalizeEvent, fileKind, magnitudeOf,
  SESSION_GAP_MS, DEDUPE_BEFORE_MS, DEDUPE_AFTER_MS, CHARS_PER_LINE,
};
