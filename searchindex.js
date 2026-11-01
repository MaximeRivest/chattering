'use strict';
// searchindex.js — FTS5-backed work-memory search (a derived cache).
//
// One row per searchable unit: a conversation title, one message, or one
// markdown section (note / epic / project memory). The database lives under
// ~/.cache/chattering and can be deleted at any time; the next boot rebuilds it
// from the session caches and the notes tree. Queries never scan the caches.
//
// Node 22 ships SQLite with FTS5 (node:sqlite). No new dependency.

const path = require('path');

// Bump when the unit layout or the ranking inputs change: the whole
// database drops and rebuilds on the next boot.
const SCHEMA_VERSION = 1;

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {}

// Snippet marker bytes. The client escapes the snippet, then turns these
// into <mark> … </mark>. They can never appear in real transcript text.
const MARK_OPEN = '\u0001';
const MARK_CLOSE = '\u0002';

// Relevance: what a human wrote outranks what a tool printed.
const ROLE_WEIGHT = { user: 2.0, assistant: 1.5, thinking: 1.0, tool: 0.9, toolresult: 0.6 };
const KIND_WEIGHT = { title: 5.0, note: 3.0, epic: 3.0, memory: 3.0 };

// Cap one unit's indexed text. Pasted briefings can reach hundreds of KB;
// the head carries the meaning and the cap keeps the index bounded.
const UNIT_TEXT_CAP = 16000;

const PREFIX_MIN = 3;

const FILTER_FIELDS = new Set(['project', 'role', 'source', 'type', 'kind', 'after', 'before', 'path']);

// Split a raw query into { terms, phrases, filters }.
// Grammar: bare words AND together; "quoted phrases" match exactly;
// field:value (project:, role:, source:, type:, after:, before:, path:) filter.
function parseQuery(raw) {
  const filters = {};
  const phrases = [];
  const terms = [];
  const trailing = !/\s$/.test(raw); // no trailing space → last term is still being typed
  let rest = String(raw);
  rest = rest.replace(/(\w+):("[^"]*"|\S+)/g, (m, field, value) => {
    field = field.toLowerCase();
    if (!FILTER_FIELDS.has(field)) return m; // not an operator: keep as text
    filters[field === 'kind' ? 'type' : field] = value.replace(/^"|"$/g, '');
    return ' ';
  });
  rest = rest.replace(/"([^"]*)"/g, (m, p) => {
    if (p.trim()) phrases.push(p.trim());
    return ' ';
  });
  for (const t of rest.split(/\s+/)) if (t) terms.push(t);
  return { terms, phrases, filters, prefixLast: trailing };
}

// Build the FTS5 MATCH expression. Every term and phrase must match (AND);
// with any: true, one is enough (OR), and bm25 ranks units holding more of
// them, and rarer ones, first (the context finder's "related to your
// message", where a whole draft can never match word for word).
function matchExpr({ terms, phrases, prefixLast }, { any = false } = {}) {
  const q = s => '"' + s.replace(/"/g, '""') + '"';
  const parts = phrases.map(q);
  terms.forEach((t, i) => {
    const last = i === terms.length - 1;
    // A word still being typed matches as a beginning from 3 letters: two
    // letters ("co") expand to thousands of words, a search of seconds.
    parts.push(q(t) + (last && prefixLast && t.length >= PREFIX_MIN && !any ? '*' : ''));
  });
  return parts.join(any ? ' OR ' : ' ');
}

function tsFromMs(ms) {
  const n = Number(ms);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}

// Markdown kind from its path inside the notes tree.
function mdKind(relFile) {
  if (relFile.startsWith('epics' + path.sep) || relFile.startsWith('epics/')) return 'epic';
  if (relFile.startsWith('projects' + path.sep) || relFile.startsWith('projects/')) return 'memory';
  return 'note';
}

// Split a markdown document into heading-bounded sections.
// Returns [{ heading, text }]; the first section may have no heading.
function mdSections(text) {
  const lines = String(text).split('\n');
  const out = [];
  let cur = { heading: null, body: [] };
  for (const line of lines) {
    const m = line.match(/^#{1,4}\s+(.*)/);
    if (m) {
      if (cur.body.join('').trim() || cur.heading) out.push(cur);
      cur = { heading: m[1].trim(), body: [line] };
    } else cur.body.push(line);
  }
  if (cur.body.join('').trim() || cur.heading) out.push(cur);
  return out.map(s => ({ heading: s.heading, text: s.body.join('\n').trim() })).filter(s => s.text);
}

class SearchIndex {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    const v = this.db.prepare('PRAGMA user_version').get().user_version;
    if (v !== SCHEMA_VERSION) {
      this.db.exec('DROP TABLE IF EXISTS units_fts; DROP TABLE IF EXISTS units; DROP TABLE IF EXISTS srcs;');
      this.db.exec(`
        CREATE TABLE srcs (src TEXT PRIMARY KEY, sig TEXT NOT NULL);
        CREATE TABLE units (
          id INTEGER PRIMARY KEY,
          src TEXT NOT NULL,
          kind TEXT NOT NULL,      -- title | message | note | epic | memory
          key TEXT,                -- conversation key (conversation units)
          file TEXT,               -- notes-relative path (markdown units)
          idx INTEGER,             -- message index in the cached messages array
          role TEXT,
          ts TEXT,
          off INTEGER NOT NULL DEFAULT 0,
          project TEXT,
          source TEXT,
          path TEXT,               -- file path a tool call touched
          title TEXT,              -- document › section heading (markdown)
          text TEXT NOT NULL
        );
        CREATE INDEX units_src ON units(src);
        CREATE VIRTUAL TABLE units_fts USING fts5(text, content='units', content_rowid='id', tokenize='unicode61');
      `);
      this.db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
    }
    // Semantic push ledger: which source signature the GPU stage has seen.
    // Separate from srcs so lexical and semantic sync advance independently.
    this.db.exec('CREATE TABLE IF NOT EXISTS semsync (src TEXT PRIMARY KEY, sig TEXT NOT NULL)');
    this._insUnit = this.db.prepare(
      `INSERT INTO units (src, kind, key, file, idx, role, ts, off, project, source, path, title, text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this._insFts = this.db.prepare('INSERT INTO units_fts(rowid, text) VALUES (?, ?)');
    this._delFts = this.db.prepare("INSERT INTO units_fts(units_fts, rowid, text) VALUES ('delete', ?, ?)");
    this._sigOf = this.db.prepare('SELECT sig FROM srcs WHERE src = ?');
    this._putSig = this.db.prepare('INSERT INTO srcs (src, sig) VALUES (?, ?) ON CONFLICT(src) DO UPDATE SET sig = excluded.sig');
  }

  close() { try { this.db.close(); } catch {} }

  // Writes wait while the full-text index is checked or rebuilt by another
  // connection (search-worker.js): a write in the middle of a rebuild would
  // delete a row the index does not hold yet, which is what damages it.
  // They are kept in order and done on release; a put that returned false
  // meanwhile is done then, so nothing is lost.
  hold() { if (!this.held) this.held = []; }
  release() {
    const queue = this.held || [];
    this.held = null;
    let failed = 0;
    for (const [name, args] of queue) { try { this[name](...args); } catch { failed++; } }
    return { replayed: queue.length, failed };
  }

  hasCurrent(src, sig) {
    const row = this._sigOf.get(src);
    return !!row && row.sig === sig;
  }

  _removeSrc(src) {
    const rows = this.db.prepare('SELECT id, text FROM units WHERE src = ?').all(src);
    for (const r of rows) this._delFts.run(r.id, r.text);
    this.db.prepare('DELETE FROM units WHERE src = ?').run(src);
  }

  _add(unit) {
    const text = String(unit.text || '').slice(0, UNIT_TEXT_CAP);
    if (!text.trim()) return;
    const info = this._insUnit.run(
      unit.src, unit.kind, unit.key || null, unit.file || null,
      unit.idx == null ? null : unit.idx, unit.role || null, unit.ts || null,
      unit.off ? 1 : 0, unit.project || null, unit.source || null,
      unit.path || null, unit.title || null, text);
    this._insFts.run(info.lastInsertRowid, text);
  }

  static conversationSig(entry) { return `${SCHEMA_VERSION}:${entry.mtimeMs}:${entry.size}`; }

  // Replace every unit of one conversation. entry needs: mtimeMs, size,
  // title, source, lastTs and a computed .project. Returns false when the
  // stored signature already matches (nothing to do).
  putConversation(key, entry, messages) {
    if (this.held) { this.held.push(['putConversation', [...arguments]]); return false; }
    const src = 'conv:' + key;
    const sig = SearchIndex.conversationSig(entry);
    if (this.hasCurrent(src, sig)) return false;
    this.db.exec('BEGIN');
    try {
      this._removeSrc(src);
      const base = { src, key, project: entry.project || null, source: entry.source || null };
      this._add({ ...base, kind: 'title', ts: entry.lastTs || null, text: entry.title || '' });
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!m || !m.text) continue;
        this._add({ ...base, kind: 'message', idx: i, role: m.role, ts: m.ts || null, off: !!m.off, path: m.path || null, text: m.text });
      }
      this._putSig.run(src, sig);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return true;
  }

  removeConversation(key) { this.removeSrc('conv:' + key); }

  // Re-attribute one source's units after a project fold or unfold. The
  // project column is baked in at put time; this fixes it without a reindex.
  setProject(src, project) {
    if (this.held) { this.held.push(['setProject', [...arguments]]); return false; }
    return this.db.prepare(
      'UPDATE units SET project = ? WHERE src = ? AND project IS NOT ?')
      .run(project || null, src, project || null).changes;
  }

  removeSrc(src) {
    if (this.held) { this.held.push(['removeSrc', [...arguments]]); return false; }
    this.db.exec('BEGIN');
    try {
      this._removeSrc(src);
      this.db.prepare('DELETE FROM srcs WHERE src = ?').run(src);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // Replace every unit of one markdown document (note / epic / memory).
  putMarkdown(relFile, text, stat) {
    if (this.held) { this.held.push(['putMarkdown', [...arguments]]); return false; }
    const src = 'md:' + relFile;
    const sig = `${SCHEMA_VERSION}:${stat.mtimeMs}:${stat.size}`;
    if (this.hasCurrent(src, sig)) return false;
    const kind = mdKind(relFile);
    const docTitle = (String(text).match(/^#\s+(.*)$/m) || [])[1] || path.basename(relFile, '.md');
    this.db.exec('BEGIN');
    try {
      this._removeSrc(src);
      const ts = tsFromMs(stat.mtimeMs);
      for (const sec of mdSections(text)) {
        const title = sec.heading && sec.heading !== docTitle ? docTitle + ' › ' + sec.heading : docTitle;
        this._add({ src, kind, file: relFile, ts, title, text: sec.text });
      }
      this._putSig.run(src, sig);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return true;
  }

  // All stored source signatures with a prefix ('conv:' or 'md:').
  listSrcs(prefix) {
    const out = new Map();
    for (const r of this.db.prepare("SELECT src, sig FROM srcs WHERE src LIKE ? || '%'").all(prefix)) {
      out.set(r.src.slice(prefix.length), r.sig);
    }
    return out;
  }

  stats() {
    return {
      units: this.db.prepare('SELECT count(*) AS n FROM units').get().n,
      sources: this.db.prepare('SELECT count(*) AS n FROM srcs').get().n,
    };
  }

  // ---- semantic stage support ----
  // Semantic unit ids: '<src>|t' (title), '<src>|m<idx>' (message),
  // '<src>|s<ordinal>' (markdown section). '<src>|' removes a whole source.

  // Units of one source, shaped for the GPU stage. Human text only by
  // default: tool output brings noise per embedding dollar.
  listUnits(src, opts = {}) {
    const roles = opts.roles || ['user', 'assistant'];
    const out = [];
    let ord = 0;
    for (const r of this.db.prepare('SELECT * FROM units WHERE src = ? ORDER BY id').all(src)) {
      const sid = r.kind === 'title' ? src + '|t'
        : r.kind === 'message' ? src + '|m' + r.idx
        : src + '|s' + (ord++);
      if (r.kind === 'message' && !roles.includes(r.role)) continue;
      out.push({
        id: sid,
        text: r.text,
        meta: {
          kind: r.kind, key: r.key || undefined, file: r.file || undefined,
          idx: r.idx == null ? undefined : r.idx, role: r.role || undefined,
          ts: r.ts || undefined, off: r.off ? true : undefined,
          project: r.project || undefined, source: r.source || undefined,
          title: r.title || undefined, snip: r.text.slice(0, 240),
        },
      });
    }
    return out;
  }

  // What the GPU stage still needs: sources to push and sources to drop.
  semanticPending(limit = 200) {
    const push = this.db.prepare(
      `SELECT s.src, s.sig FROM srcs s LEFT JOIN semsync m ON m.src = s.src
       WHERE m.sig IS NULL OR m.sig != s.sig LIMIT ?`).all(limit);
    const drop = this.db.prepare(
      `SELECT m.src FROM semsync m LEFT JOIN srcs s ON s.src = m.src
       WHERE s.src IS NULL LIMIT ?`).all(limit).map(r => r.src);
    return { push, drop };
  }

  semanticMark(src, sig) {
    if (this.held) { this.held.push(['semanticMark', [...arguments]]); return false; }
    this.db.prepare('INSERT INTO semsync (src, sig) VALUES (?, ?) ON CONFLICT(src) DO UPDATE SET sig = excluded.sig').run(src, sig);
  }

  semanticDrop(src) {
    if (this.held) { this.held.push(['semanticDrop', [...arguments]]); return false; }
    this.db.prepare('DELETE FROM semsync WHERE src = ?').run(src);
  }

  // Forget all push marks: the next sync re-pushes every source. Used when
  // the remote target (URL or namespace) changes.
  semanticResetSync() {
    if (this.held) { this.held.push(['semanticResetSync', [...arguments]]); return false; }
    this.db.exec('DELETE FROM semsync');
  }

  semanticStats() {
    return {
      synced: this.db.prepare('SELECT count(*) AS n FROM semsync').get().n,
      total: this.db.prepare('SELECT count(*) AS n FROM srcs').get().n,
    };
  }

  // Ranked, grouped search (searchDb below), on this connection. The
  // server asks its worker instead (search-worker.js): this is the fallback
  // and the tests' way in.
  search(rawQ, opts = {}) { return searchDb(this.db, rawQ, opts); }
  sizes(srcs) { return sourceSizes(this.db, srcs); }
}


// ---- snippets -------------------------------------------------------------
// The words of a query as the index's tokenizer sees them (unicode61:
// letters and digits, case and accents folded), to find and mark them in a
// unit's text. Phrases mark word by word.
const fold = s => { let out = ''; for (const ch of String(s)) { const f = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(); out += f.length === ch.length ? f : ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch; } return out; };
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function snippetWords(parsed) {
  const words = [];
  parsed.terms.forEach((t, i) => {
    for (const w of fold(t).split(/[^\p{L}\p{N}]+/u).filter(Boolean)) words.push({ w, prefix: i === parsed.terms.length - 1 && parsed.prefixLast && t.length >= PREFIX_MIN });
  });
  for (const p of parsed.phrases) for (const w of fold(p).split(/[^\p{L}\p{N}]+/u).filter(Boolean)) words.push({ w, prefix: false });
  return words;
}
const SNIPPET_CHARS = 180;
// About 18 words around the first match, matches marked, ' … ' where cut.
function makeSnippet(text, words) {
  const src = String(text || '');
  if (!words.length) return src.slice(0, SNIPPET_CHARS).replace(/\s+/g, ' ');
  const folded = fold(src);
  const re = new RegExp('(?<![\\p{L}\\p{N}])(?:' + words.map(x => escRe(x.w) + (x.prefix ? '[\\p{L}\\p{N}]*' : '(?![\\p{L}\\p{N}])')).join('|') + ')', 'gu');
  const hits = [];
  for (const m of folded.matchAll(re)) { hits.push([m.index, m.index + m[0].length]); if (hits.length > 60) break; }
  let from = 0;
  if (hits.length) from = Math.max(0, hits[0][0] - Math.floor(SNIPPET_CHARS / 3));
  if (from > 0) { const sp = src.indexOf(' ', from); if (sp > 0 && sp < hits[0][0]) from = sp + 1; }
  let to = Math.min(src.length, from + SNIPPET_CHARS);
  if (to < src.length) { const sp = src.lastIndexOf(' ', to); if (sp > from + SNIPPET_CHARS / 2 && (!hits.length || sp >= hits[0][1])) to = sp; }
  let out = '', at = from;
  for (const [a, b] of hits) {
    if (b <= from || a >= to) continue;
    out += src.slice(at, Math.max(at, a)) + MARK_OPEN + src.slice(Math.max(a, at), Math.min(b, to)) + MARK_CLOSE;
    at = Math.min(b, to);
  }
  out += src.slice(at, to);
  return ((from > 0 ? ' … ' : '') + out + (to < src.length ? ' … ' : '')).replace(/\s+/g, ' ');
}

// How many matches a search counts before it says "more than". Counting
// every match of a common word (300,000 for "the") cost more than the
// search itself, for a number nobody reads past four digits.
const COUNT_CAP = 10000;
// Rows ranked before grouping. Groups are built from the best-ranked
// units; a conversation whose only hits rank below this is not listed.
const RANK_ROWS = 2000;

// Ranked, grouped search on any connection (the server's worker reads with
// its own; tests use the writer's).
// opts: { limit (groups), offset (groups), boostProject, any (OR the words),
//   kinds: ['title','message','memory','note','epic'] (unit kinds),
//   roles: message roles kept, memoryDir: 'projects/<slug>/' (with a
//   project: filter, the project's memory documents match too),
//   exclude: [conversation keys], snippets (default true) }
// Returns { total, totalCapped, groupCount, kindCounts, groups: [{ kind,
//   key|file, title, project, source, score, matchCount, matches: [{ i,
//   role, ts, off, snippet, title }] }] }
function searchDb(db, rawQ, opts = {}) {
  const parsed = parseQuery(rawQ);
  const expr = matchExpr(parsed, { any: !!opts.any });
  if (!expr) return { total: 0, totalCapped: false, groupCount: 0, kindCounts: {}, groups: [] };
  const f = parsed.filters;
  const where = ['units_fts MATCH ?'];
  const args = [expr];
  if (f.project) {
    if (opts.memoryDir) { where.push("(u.project = ? OR (u.kind = 'memory' AND u.file LIKE ? || '%'))"); args.push(f.project, opts.memoryDir); }
    else { where.push('u.project = ?'); args.push(f.project); }
  }
  if (f.role) { where.push('u.role = ?'); args.push(f.role); }
  if (f.source) { where.push('u.source = ?'); args.push(f.source); }
  if (f.type) {
    if (f.type === 'conversation') where.push("u.kind IN ('title','message')");
    else { where.push('u.kind = ?'); args.push(f.type); }
  }
  if (Array.isArray(opts.kinds) && opts.kinds.length) {
    where.push('u.kind IN (' + opts.kinds.map(() => '?').join(',') + ')'); args.push(...opts.kinds);
  }
  if (Array.isArray(opts.roles) && opts.roles.length) {
    where.push("(u.kind != 'message' OR u.role IN (" + opts.roles.map(() => '?').join(',') + '))'); args.push(...opts.roles);
  }
  if (Array.isArray(opts.exclude) && opts.exclude.length) {
    where.push('(u.key IS NULL OR u.key NOT IN (' + opts.exclude.map(() => '?').join(',') + '))'); args.push(...opts.exclude);
  }
  if (f.after) { where.push('u.ts >= ?'); args.push(f.after); }
  if (f.before) { where.push('u.ts <= ?'); args.push(f.before); }
  if (f.path) { where.push("u.path LIKE '%' || ? || '%'"); args.push(f.path); }
  const cond = where.join(' AND ');
  let rows, counted, ranking = 'relevance';
  try {
    counted = db.prepare(
      `SELECT count(*) AS n FROM (SELECT 1 FROM units_fts JOIN units u ON u.id = units_fts.rowid WHERE ${cond} LIMIT ${COUNT_CAP + 1})`).get(...args).n;
    // Ranking every match of a very common word ("the": 300,000) costs
    // seconds and tells little: then the newest matches are ranked (units
    // are numbered in the order they were indexed), and the answer says so.
    if (counted > COUNT_CAP) ranking = 'recent';
    rows = db.prepare(
      `SELECT u.id, u.kind, u.key, u.file, u.idx, u.role, u.ts, u.off, u.project, u.source, u.title,
              bm25(units_fts) AS b
       FROM units_fts JOIN units u ON u.id = units_fts.rowid
       WHERE ${cond} ORDER BY ${ranking === 'recent' ? 'units_fts.rowid DESC' : 'rank'} LIMIT ${RANK_ROWS}`).all(...args);
  } catch (e) {
    // An unfinished quote or operator misuse must not 500 the API.
    if (/fts5|syntax/i.test(e.message) && !isCorruption(e)) return { total: 0, totalCapped: false, groupCount: 0, kindCounts: {}, groups: [], error: 'bad query' };
    throw e;
  }
  const now = Date.now();
  const groups = new Map();
  for (const r of rows) {
    const weight = r.kind === 'message' ? (ROLE_WEIGHT[r.role] || 1) : (KIND_WEIGHT[r.kind] || 1);
    let score = -r.b * weight;
    const age = r.ts ? Math.max(0, (now - Date.parse(r.ts)) / 86400000) : 365;
    score *= 1 + 0.25 * Math.exp(-age / 14);              // fresh work matters a bit more
    if (opts.boostProject && r.project === opts.boostProject) score *= 1.2;
    if (r.off) score *= 0.9;                               // off the active branch path
    const gid = r.key ? 'c:' + r.key : 'f:' + r.file;
    let g = groups.get(gid);
    if (!g) {
      g = {
        kind: r.key ? 'conversation' : r.kind,
        key: r.key || undefined, file: r.file || undefined,
        title: r.title || null, project: r.project || null, source: r.source || null,
        score: 0, matchCount: 0, matches: [],
      };
      groups.set(gid, g);
    }
    g.matchCount++;
    g.score = Math.max(g.score, score);
    if (g.matches.length < 3) {
      g.matches.push({
        id: r.id,
        i: r.idx == null ? undefined : r.idx,
        role: r.kind === 'title' ? 'title' : (r.role || r.kind),
        ts: r.ts || null, off: !!r.off, title: r.title || undefined,
        snippet: '',
      });
    }
    if (!g.title && r.title) g.title = r.title;
  }
  const list = [...groups.values()];
  for (const g of list) g.score += 0.05 * Math.log(1 + g.matchCount); // breadth helps a little
  list.sort((a, b) => b.score - a.score);
  const kindCounts = {};
  for (const g of list) kindCounts[g.kind] = (kindCounts[g.kind] || 0) + 1;
  const offset = Math.max(0, opts.offset || 0);
  const limit = Math.max(1, Math.min(100, opts.limit || 40));
  const page = list.slice(offset, offset + limit);
  // Snippets for what is returned only, cut here from the units' text:
  // SQLite's snippet() expands a word beginning again for every unit (17 s
  // for 90 snippets of "co*"), this costs a millisecond.
  if (opts.snippets !== false) {
    const ids = page.flatMap(g => g.matches.map(m => m.id));
    if (ids.length) {
      const text = new Map(db.prepare(`SELECT id, text FROM units WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(r => [r.id, r.text]));
      const words = snippetWords(parsed);
      for (const g of page) for (const m of g.matches) m.snippet = makeSnippet(text.get(m.id) || '', words);
    }
  }
  for (const g of page) for (const m of g.matches) delete m.id;
  return { total: Math.min(counted, COUNT_CAP), totalCapped: counted > COUNT_CAP, ranking, groupCount: list.length, kindCounts, groups: page };
}

// What a source would weigh if attached: for a conversation, its user and
// assistant text on the active path (count and characters); for a markdown
// document, its sections. Characters, not tokens: the caller estimates.
// A unit's text is capped at UNIT_TEXT_CAP, so a pasted briefing counts at
// its cap: a lower bound, which the exact preview corrects.
function sourceSizes(db, srcs) {
  const out = {};
  const list = [...new Set((srcs || []).filter(s => typeof s === 'string'))].slice(0, 200);
  if (!list.length) return out;
  const marks = list.map(() => '?').join(',');
  for (const r of db.prepare(
    `SELECT src, count(*) AS n, sum(length(text)) AS chars FROM units
     WHERE src IN (${marks}) AND ((kind = 'message' AND role IN ('user','assistant') AND off = 0) OR kind IN ('memory','note','epic'))
     GROUP BY src`).all(...list)) out[r.src] = { units: r.n, chars: r.chars || 0 };
  return out;
}

// SQLite's words for a damaged file or index.
const isCorruption = e => /malformed|corrupt|SQLITE_CORRUPT/i.test(String(e && (e.message || e.code) || e));

// ---- repair (search-worker.js runs it, with the server's writes held) ----
// The full-text index is rebuilt from the units table, which is the truth
// it was built from. In steps, so its progress can be told and a shutdown
// does not wait for the whole of it.
function ftsCheck(db) {
  try { db.prepare("INSERT INTO units_fts(units_fts, rank) VALUES ('integrity-check', 1)").run(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message, corrupt: isCorruption(e) }; }
}
function ftsRepairStart(db) {
  db.exec("INSERT INTO units_fts(units_fts) VALUES ('delete-all')");
  return { total: db.prepare('SELECT count(*) AS n FROM units').get().n };
}
// Index the next `n` units after id `after`; returns the last id done, or
// null when there were none left.
function ftsRepairStep(db, after, n = 20000) {
  const last = db.prepare('SELECT max(id) AS m FROM (SELECT id FROM units WHERE id > ? ORDER BY id LIMIT ?)').get(after, n).m;
  if (last == null) return null;
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO units_fts(rowid, text) SELECT id, text FROM units WHERE id > ? AND id <= ? ORDER BY id').run(after, last);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return last;
}

function openSearchIndex(dbPath) {
  if (!DatabaseSync) return null;
  try {
    return new SearchIndex(dbPath);
  } catch (e) {
    console.error('search index unavailable:', e.message);
    return null;
  }
}

module.exports = { openSearchIndex, SearchIndex, searchDb, makeSnippet, snippetWords, PREFIX_MIN, sourceSizes, isCorruption, ftsCheck, ftsRepairStart, ftsRepairStep, parseQuery, matchExpr, mdSections, mdKind, MARK_OPEN, MARK_CLOSE, COUNT_CAP };
