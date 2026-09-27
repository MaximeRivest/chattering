'use strict';
// programs.js — AI programs: the FunctAI call log, read, indexed and rated
// (design/74).
//
// FunctAI (Python, TypeScript, …) writes every call of an AI function as one
// line of JSON in a folder, and people's ratings of those calls as lines in
// the same folder (functai contract/calls.md). That folder is the source of
// truth. This module keeps a SQLite index of it in Chattering's cache (one
// row per call and per rating, with the byte range of its line, so the whole
// record is read back only when a person opens it), answers the questions the
// Programs pages ask, computes the rows with known answers exactly as the
// contract says, and appends Chattering's ratings to the log as a writer of
// its own. Deleting the index loses nothing: the next refresh rebuilds it.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const FORMAT = 1;
const SCHEMA = 4; // bump to rebuild every existing index from the log
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CHUNK = 4 * 1024 * 1024;
const FULL_EVERY_MS = 5 * 60 * 1000;
const MIN_REFRESH_MS = 800;

// ---- ids, times, JSON -------------------------------------------------------

// A UUIDv7 (RFC 9562): time-ordered, as FunctAI's own ids.
function newId(nowMs = Date.now()) {
  const b = crypto.randomBytes(16);
  let ms = nowMs;
  for (let i = 5; i >= 0; i--) { b[i] = ms % 256; ms = Math.floor(ms / 256); }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
// The log's time format: RFC 3339 UTC, exactly six fraction digits.
function iso(ms) {
  const d = new Date(ms);
  return d.toISOString().slice(0, 19) + '.' + String(d.getUTCMilliseconds() * 1000).padStart(6, '0') + 'Z';
}
// Canonical JSON (sorted keys), enough to compare values as the contract
// does: equal values give equal text. Numbers and strings are written as
// JSON.stringify writes them, which is ECMAScript's spelling.
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
const sha = text => crypto.createHash('sha256').update(text).digest('hex');

// Wilson's 95% interval for a share of right answers (the range FunctAI's
// evaluate reports for right-or-wrong scores).
function wilson(right, n, z = 1.96) {
  if (!n) return null;
  const p = right / n, z2 = z * z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / d;
  return { score: p, low: Math.max(0, c - h), high: Math.min(1, c + h), n, right };
}
function percentile(sorted, q) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

// ---- what a person reads in a table cell --------------------------------------
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
function valueText(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && '$repr' in v) return String(v.$repr);
  try { return JSON.stringify(v); } catch { return String(v); }
}
function preview(values, max = 600) {
  if (!values || typeof values !== 'object') return '';
  const entries = Object.entries(values);
  if (entries.length === 1) return clip(valueText(entries[0][1]), max);
  return clip(entries.map(([k, v]) => k + ': ' + clip(valueText(v), 280)).join('\n'), max);
}

// ---- the contract's reading rules (contract/calls.md, "Rows with known answers")

const orderKey = (r, key) => String(r[key] ?? '') + '\u0000' + String(r.id ?? '');
const later = (a, b, key) => {
  const ta = String(a[key] ?? ''), tb = String(b[key] ?? '');
  if (ta !== tb) return ta > tb;
  return String(a.id ?? '') > String(b.id ?? '');
};
// For each call, the ratings that count: each person's latest; a withdrawn
// one (verdict null) counts for nothing. Oldest first.
function currentRatings(ratings, by = null) {
  const latest = new Map();
  for (const r of ratings) {
    if (by != null && r.by !== by) continue;
    const key = JSON.stringify([r.call, r.by]);
    const had = latest.get(key);
    if (!had || later(r, had, 'at')) latest.set(key, r);
  }
  const out = new Map();
  for (const r of latest.values()) {
    if (r.verdict !== 'right' && r.verdict !== 'wrong') continue;
    if (!out.has(r.call)) out.set(r.call, []);
    out.get(r.call).push(r);
  }
  for (const list of out.values()) list.sort((a, b) => (later(a, b, 'at') ? 1 : later(b, a, 'at') ? -1 : 0));
  return out;
}
const answerName = call => (call && call.program && call.program.answer) || 'result';
// What one rating says the right values are, or null when it gives none.
function says(rating, call) {
  const answer = answerName(call);
  if (rating.verdict === 'right') {
    const outputs = call && call.outputs;
    return outputs && typeof outputs === 'object' && answer in outputs ? { [answer]: outputs[answer] } : null;
  }
  const values = {};
  if ('answer' in rating) values[answer] = rating.answer;
  for (const [k, v] of Object.entries(rating.outputs || {})) if (!(k in values)) values[k] = v;
  return Object.keys(values).length ? values : null;
}
function ratedRows(calls, ratings, { name, module = null, signature = null, by = null }) {
  const counting = currentRatings(ratings, by);
  const left = { other_signature: 0, no_content: 0, no_answer: 0 };
  const rows = [];
  const mine = [...calls].filter(c => c.program && c.program.name === name && (module == null || c.program.module === module));
  mine.sort((a, b) => (orderKey(a, 'started') < orderKey(b, 'started') ? -1 : orderKey(a, 'started') > orderKey(b, 'started') ? 1 : 0));
  for (const call of mine) {
    const rs = counting.get(call.id);
    if (!rs || !rs.length) continue;
    if (signature != null && call.program.signature !== signature) { left.other_signature++; continue; }
    if (!call.content || !('inputs' in call)) { left.no_content++; continue; }
    const usable = rs.map(r => [r, says(r, call)]).filter(([, v]) => v !== null);
    if (!usable.length) { left.no_answer++; continue; }
    const [rating, values] = usable[usable.length - 1];
    const disputed = new Set(rs.map(r => r.verdict)).size > 1 || new Set(usable.map(([, v]) => canonical(v))).size > 1;
    const answer = answerName(call);
    const row = { ...(call.inputs || {}) };
    if (answer in values) row[answer] = values[answer];
    for (const [k, v] of Object.entries(values)) if (k !== answer) row[k] = v;
    const meta = { call: call.id, version: call.program.version, rating: rating.verdict, rated_by: rating.by,
      origin: rating.origin ?? 'review', sample: rating.sample ?? null, disputed };
    for (let [k, v] of Object.entries(meta)) { while (k in row) k = '_' + k; row[k] = v; }
    rows.push(row);
  }
  return { rows, left_out: left };
}
// One call's standing: right, wrong or disputed (people disagree, or give
// different right answers); open: judged wrong and nobody has said what the
// right answer is.
function ratingState(call, ratings) {
  const rs = currentRatings(ratings).get(call ? call.id : ratings[0] && ratings[0].call) || [];
  if (!rs.length) return null;
  const values = rs.map(r => says(r, call)).filter(v => v !== null).map(canonical);
  const verdicts = new Set(rs.map(r => r.verdict));
  const state = verdicts.size > 1 || new Set(values).size > 1 ? 'disputed' : rs[0].verdict;
  return { state, people: rs.length, open: state === 'wrong' && !values.length ? 1 : 0 };
}

// ---- the log folder, read line by line ------------------------------------------

// Every complete line of `abs` between byte `from` and `to`, with its byte
// range. Returns where the next read starts: after the last newline (a
// partial last line is a writer mid-write; it is read next time).
function readLines(abs, from, to, onLine) {
  const fd = fs.openSync(abs, 'r');
  let pos = from, carry = Buffer.alloc(0);
  try {
    while (pos < to) {
      const want = Math.min(CHUNK, to - pos);
      const buf = Buffer.allocUnsafe(want);
      const got = fs.readSync(fd, buf, 0, want, pos);
      if (!got) break;
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
      const base = pos - carry.length;
      let start = 0, nl;
      while ((nl = chunk.indexOf(10, start)) !== -1) {
        if (nl > start) onLine(chunk.subarray(start, nl), base + start, nl - start);
        start = nl + 1;
      }
      carry = Buffer.from(chunk.subarray(start));
      pos += got;
    }
  } finally { fs.closeSync(fd); }
  return pos - carry.length;
}
function readSlice(abs, offset, length) {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(length);
    const got = fs.readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, got).toString('utf8');
  } finally { fs.closeSync(fd); }
}

// ---- the index ---------------------------------------------------------------------

const CALL_COLUMNS = ['id', 'parent', 'root', 'name', 'module', 'kind', 'version', 'signature', 'answer', 'saved', 'file', 'line',
  'started', 'seconds', 'content', 'truncated', 'error_type', 'error_code', 'error_message', 'model', 'provider',
  'tokens_in', 'tokens_out', 'exchanges', 'cached', 'confidence', 'purpose', 'caller_kind', 'caller', 'caller_ref', 'person', 'host',
  'language', 'functai', 'input_key', 'inputs_preview', 'outputs_preview', 'answer_json', 'search', 'src', 'src_offset', 'src_length'];

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db = new DatabaseSync(file);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version !== SCHEMA) {
    // A derived cache in an older shape: start again from the log.
    db.close();
    for (const f of [file, file + '-wal', file + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }
    db = new DatabaseSync(file);
  }
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, offset INTEGER NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS calls (${CALL_COLUMNS.map(c => c === 'id' ? 'id TEXT PRIMARY KEY' : c).join(', ')});
    CREATE INDEX IF NOT EXISTS calls_program ON calls(name, module, started);
    CREATE INDEX IF NOT EXISTS calls_parent ON calls(parent);
    CREATE INDEX IF NOT EXISTS calls_caller_ref ON calls(caller_ref);
    CREATE TABLE IF NOT EXISTS ratings (id TEXT PRIMARY KEY, call TEXT NOT NULL, at TEXT, by TEXT, verdict TEXT, sample TEXT, raw TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ratings_call ON ratings(call);
    CREATE TABLE IF NOT EXISTS rating_state (call TEXT PRIMARY KEY, state TEXT NOT NULL, people INTEGER NOT NULL, open INTEGER NOT NULL);
    PRAGMA user_version = ${SCHEMA};`);
  return db;
}

function callRow(rec, src, offset, length) {
  const p = rec.program || {};
  const caller = rec.caller && typeof rec.caller === 'object' ? rec.caller : {};
  const proc = rec.process || {};
  const ex = Array.isArray(rec.exchanges) ? rec.exchanges : [];
  const lastReply = [...ex].reverse().find(e => !e.error) || ex[ex.length - 1] || {};
  const content = rec.content !== false;
  const answer = p.answer || 'result';
  let answerJson = null;
  if (content && rec.outputs && typeof rec.outputs === 'object' && answer in rec.outputs) {
    const text = canonical(rec.outputs[answer]);
    if (text.length <= 2000) answerJson = text;
  }
  const purpose = caller.evaluation ? 'evaluation' : caller.optimization ? 'optimization' : caller.kind === 'test' ? 'test' : null;
  const err = rec.error && typeof rec.error === 'object' ? rec.error : null;
  const inputsPreview = content ? preview(rec.inputs) : '';
  const outputsPreview = content ? (rec.outputs ? preview(rec.outputs) : '') : '';
  const search = content ? clip((canonical(rec.inputs || {}) + ' ' + canonical(rec.outputs || {}) + ' ' + (err ? err.message || '' : '')).toLowerCase(), 8000) : '';
  return {
    id: rec.id, parent: rec.parent || null, root: rec.root || rec.id, name: String(p.name), module: String(p.module ?? ''),
    kind: p.kind || 'ai', version: p.version || null, signature: p.signature || null, answer, saved: p.saved || null,
    file: p.file || null, line: Number.isInteger(p.line) ? p.line : null,
    started: String(rec.started || ''), seconds: Number(rec.seconds) || 0, content: content ? 1 : 0, truncated: rec.truncated ? 1 : 0,
    error_type: err ? String(err.type || 'Error') : null, error_code: err && err.code ? String(err.code) : null,
    error_message: err && err.message ? clip(String(err.message), 2000) : null,
    model: rec.model || null, provider: lastReply.provider || null,
    tokens_in: Number(rec.usage && rec.usage.input_tokens) || 0, tokens_out: Number(rec.usage && rec.usage.output_tokens) || 0,
    exchanges: ex.length, cached: ex.filter(e => e.cached).length,
    confidence: typeof rec.confidence === 'number' ? rec.confidence : null,
    purpose, caller_kind: caller.kind ? String(caller.kind) : null, caller: clip(JSON.stringify(caller), 4000),
    // Where it was called from, when a conversation or a notebook said so.
    caller_ref: caller.conversation ? 'conversation:' + caller.conversation : caller.notebook ? 'notebook:' + caller.notebook : null,
    person: caller.user ? String(caller.user) : proc.user ? String(proc.user) : null, host: proc.host || null,
    language: proc.language || null, functai: proc.functai || null,
    input_key: content && rec.inputs ? sha(canonical(rec.inputs)) : null,
    inputs_preview: inputsPreview, outputs_preview: outputsPreview, answer_json: answerJson, search,
    src, src_offset: offset, src_length: length,
  };
}

function createProgramIndex({ folder, dbFile, projectOfPath = () => null, host = os.hostname(), now = () => Date.now() }) {
  const db = openDb(dbFile);
  const insertCall = db.prepare(`INSERT OR REPLACE INTO calls (${CALL_COLUMNS.join(', ')}) VALUES (${CALL_COLUMNS.map(c => '$' + c).join(', ')})`);
  const insertRating = db.prepare('INSERT OR REPLACE INTO ratings (id, call, at, by, verdict, sample, raw) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const setFile = db.prepare('INSERT OR REPLACE INTO files (path, offset, size) VALUES (?, ?, ?)');
  const getFile = db.prepare('SELECT offset, size FROM files WHERE path = ?');
  const hasRatings = db.prepare('SELECT 1 FROM ratings WHERE call = ? LIMIT 1');
  let seq = 0, lastRefresh = 0, lastFull = 0, knownDays = new Set();
  const projectMemo = new Map();
  // Chattering's own file in the log: one per process, never shared.
  const writerName = `chattering-${String(host).replace(/[^\w.-]+/g, '-')}-${process.pid}-${crypto.randomBytes(3).toString('hex')}.jsonl`;

  const txn = fn => { db.exec('BEGIN'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  function summaryCall(id) {
    const row = db.prepare('SELECT src, src_offset, src_length FROM calls WHERE id = ?').get(id);
    if (!row) return null;
    try { return JSON.parse(readSlice(path.join(folder, row.src), row.src_offset, row.src_length)); } catch { return null; }
  }
  function ratingsOf(callId) {
    return db.prepare('SELECT raw FROM ratings WHERE call = ?').all(callId).map(r => JSON.parse(r.raw));
  }
  function restate(callIds) {
    const del = db.prepare('DELETE FROM rating_state WHERE call = ?');
    const put = db.prepare('INSERT OR REPLACE INTO rating_state (call, state, people, open) VALUES (?, ?, ?, ?)');
    const answerOf = db.prepare('SELECT answer, answer_json, content FROM calls WHERE id = ?');
    for (const id of callIds) {
      const rs = ratingsOf(id);
      const c = answerOf.get(id);
      // Enough of the call for the rules: its id, its answer's name and value.
      const call = c ? { id, program: { answer: c.answer }, outputs: c.answer_json != null ? { [c.answer]: JSON.parse(c.answer_json) } : null } : { id, outputs: null };
      const st = rs.length ? ratingState(call, rs) : null;
      if (st) put.run(id, st.state, st.people, st.open); else del.run(id);
    }
  }

  // Read what is new in the log. Quick passes look at the last two days and
  // any new day; a full pass (first time, then every few minutes) stats every
  // file, catching a writer that appended to an older day.
  function refresh({ full = false, force = false } = {}) {
    const t = now();
    if (!force && t - lastRefresh < MIN_REFRESH_MS) return false;
    lastRefresh = t;
    if (!fs.existsSync(folder)) return false;
    const doFull = full || !lastFull || t - lastFull > FULL_EVERY_MS;
    let days;
    try { days = fs.readdirSync(folder).filter(d => DAY.test(d)).sort(); } catch { return false; }
    const look = doFull ? days : days.filter((d, i) => i >= days.length - 2 || !knownDays.has(d));
    let changed = false;
    const touched = new Set();
    for (const day of look) {
      let names;
      try { names = fs.readdirSync(path.join(folder, day)).filter(n => n.endsWith('.jsonl')).sort(); } catch { continue; }
      for (const name of names) {
        const rel = day + '/' + name, abs = path.join(folder, day, name);
        let st; try { st = fs.statSync(abs); } catch { continue; }
        const had = getFile.get(rel);
        let from = had ? had.offset : 0;
        if (had && st.size < had.offset) {
          // The file was replaced by a shorter one: forget what came from it.
          txn(() => { db.prepare('DELETE FROM calls WHERE src = ?').run(rel); db.prepare('DELETE FROM files WHERE path = ?').run(rel); });
          from = 0;
        }
        if (had && st.size === had.size && from === had.offset) continue;
        txn(() => {
          const next = readLines(abs, from, st.size, (buf, offset, length) => {
            let rec; try { rec = JSON.parse(buf.toString('utf8')); } catch { return; }
            if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return;
            if (rec.functai_call === FORMAT && typeof rec.id === 'string' && rec.program && rec.program.name) {
              const row = callRow(rec, rel, offset, length);
              insertCall.run(Object.fromEntries(Object.entries(row).map(([k, v]) => ['$' + k, v])));
              if (hasRatings.get(rec.id)) touched.add(rec.id);
              changed = true;
            } else if (rec.functai_rating === FORMAT && typeof rec.id === 'string' && typeof rec.call === 'string') {
              insertRating.run(rec.id, rec.call, String(rec.at || ''), String(rec.by || ''), rec.verdict ?? null, rec.sample ?? null, JSON.stringify(rec));
              touched.add(rec.call);
              changed = true;
            }
          });
          setFile.run(rel, next, st.size);
        });
      }
    }
    for (const d of days) knownDays.add(d);
    if (touched.size) txn(() => restate(touched));
    if (doFull) { lastFull = t; projectMemo.clear(); }
    if (changed) seq++;
    return changed;
  }

  function projectOf(file) {
    if (!file) return null;
    if (!projectMemo.has(file)) { let p = null; try { p = projectOfPath(file) || null; } catch {} projectMemo.set(file, p); }
    return projectMemo.get(file);
  }
  const key = (name, module) => JSON.stringify([name, module]);
  const callerOf = row => { try { return JSON.parse(row.caller || '{}'); } catch { return {}; } };

  // ---- questions -------------------------------------------------------------

  function programs() {
    const rows = db.prepare(`SELECT name, module, COUNT(*) AS calls, SUM(purpose IS NULL) AS use_calls,
      SUM(purpose IS NULL AND error_type IS NOT NULL) AS errors, MIN(started) AS first, MAX(started) AS last,
      COUNT(DISTINCT version) AS versions, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out
      FROM calls GROUP BY name, module`).all();
    const latest = db.prepare(`SELECT kind, version, signature, answer, file, line, language, caller FROM calls
      WHERE name = ? AND module = ? ORDER BY started DESC, id DESC LIMIT 1`);
    const since = iso(now() - 7 * 86400000);
    const recent = db.prepare('SELECT COUNT(*) AS n FROM calls WHERE name = ? AND module = ? AND purpose IS NULL AND started >= ?');
    const states = db.prepare(`SELECT s.state, SUM(s.open) AS open, COUNT(*) AS n FROM rating_state s JOIN calls c ON c.id = s.call
      WHERE c.name = ? AND c.module = ? GROUP BY s.state`);
    const langs = db.prepare('SELECT DISTINCT language FROM calls WHERE name = ? AND module = ? AND language IS NOT NULL');
    return rows.map(r => {
      const l = latest.get(r.name, r.module) || {};
      const ratings = { right: 0, wrong: 0, disputed: 0, open: 0 };
      for (const s of states.all(r.name, r.module)) { ratings[s.state] = s.n; ratings.open += s.open || 0; }
      const caller = callerOf(l);
      return {
        name: r.name, module: r.module, kind: l.kind || 'ai', version: l.version || null, signature: l.signature || null,
        answer: l.answer || 'result', file: l.file || null, line: l.line ?? null,
        project: projectOf(l.file) || projectOf(caller.notebook) || null,
        languages: langs.all(r.name, r.module).map(x => x.language),
        calls: r.calls, useCalls: r.use_calls || 0, errors: r.errors || 0, recent: recent.get(r.name, r.module, since).n,
        first: r.first, last: r.last, versions: r.versions, tokensIn: r.tokens_in || 0, tokensOut: r.tokens_out || 0, ratings,
      };
    }).sort((a, b) => String(b.last).localeCompare(String(a.last)));
  }

  // A share of right answers from random draws only: ratings that carry a
  // sample id. Ratings people chose to make are not a fair sample.
  function sampleScore(name, module, version = null) {
    const rows = db.prepare(`SELECT r.raw FROM ratings r JOIN calls c ON c.id = r.call
      WHERE c.name = ? AND c.module = ? AND r.sample IS NOT NULL ${version ? 'AND c.version = ?' : ''}`)
      .all(...(version ? [name, module, version] : [name, module])).map(r => JSON.parse(r.raw));
    const byCall = currentRatings(rows);
    let right = 0, n = 0;
    for (const rs of byCall.values()) { n++; if (rs.every(r => r.verdict === 'right')) right++; }
    return wilson(right, n);
  }

  function program(name, module) {
    const all = db.prepare('SELECT COUNT(*) AS n FROM calls WHERE name = ? AND module = ?').get(name, module).n;
    if (!all) return null;
    const summary = programs().find(p => p.name === name && p.module === module);
    const use = db.prepare(`SELECT seconds, started, model, language, caller_kind, person, error_type, tokens_in, tokens_out
      FROM calls WHERE name = ? AND module = ? AND purpose IS NULL`).all(name, module);
    const secs = use.map(c => c.seconds).sort((a, b) => a - b);
    const count = (list, f) => { const m = new Map(); for (const x of list) { const k = f(x); if (k) m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ name: k, n })); };
    const days = [];
    const today = Date.parse(iso(now()).slice(0, 10) + 'T00:00:00Z');
    for (let i = 29; i >= 0; i--) days.push({ day: iso(today - i * 86400000).slice(0, 10), n: 0, errors: 0 });
    const dayAt = new Map(days.map(d => [d.day, d]));
    for (const c of use) { const d = dayAt.get(String(c.started).slice(0, 10)); if (d) { d.n++; if (c.error_type) d.errors++; } }
    const purposes = db.prepare('SELECT purpose, COUNT(*) AS n FROM calls WHERE name = ? AND module = ? AND purpose IS NOT NULL GROUP BY purpose').all(name, module);
    const answers = db.prepare(`SELECT answer_json, COUNT(*) AS n FROM calls WHERE name = ? AND module = ? AND answer_json IS NOT NULL
      AND length(answer_json) <= 200 GROUP BY answer_json ORDER BY n DESC LIMIT 40`).all(name, module)
      .map(a => ({ value: JSON.parse(a.answer_json), n: a.n }));
    const sources = db.prepare(`SELECT caller_ref AS ref, COUNT(*) AS n, MAX(started) AS last FROM calls WHERE name = ? AND module = ?
      AND caller_ref IS NOT NULL GROUP BY caller_ref ORDER BY last DESC LIMIT 12`).all(name, module);
    const files = db.prepare('SELECT file, line, language, COUNT(*) AS n FROM calls WHERE name = ? AND module = ? AND file IS NOT NULL GROUP BY file, line, language ORDER BY MAX(started) DESC LIMIT 10').all(name, module);
    return {
      ...summary,
      stats: {
        use: use.length, other: Object.fromEntries(purposes.map(p => [p.purpose, p.n])),
        errors: use.filter(c => c.error_type).length,
        p50: percentile(secs, 0.5), p95: percentile(secs, 0.95),
        tokensIn: use.reduce((s, c) => s + (c.tokens_in || 0), 0), tokensOut: use.reduce((s, c) => s + (c.tokens_out || 0), 0),
        models: count(use, c => c.model), languages: count(use, c => c.language), callers: count(use, c => c.caller_kind || 'unknown'),
        people: count(use, c => c.person), days,
      },
      sample: sampleScore(name, module, summary.version) || null,
      sampleAll: sampleScore(name, module),
      answers, files, sources,
    };
  }

  function versions(name, module) {
    const rows = db.prepare(`SELECT version, MIN(started) AS first, MAX(started) AS last, SUM(purpose IS NULL) AS use_calls,
      SUM(purpose IS NOT NULL) AS other_calls, SUM(purpose IS NULL AND error_type IS NOT NULL) AS errors,
      AVG(CASE WHEN purpose IS NULL THEN tokens_in + tokens_out END) AS tokens, GROUP_CONCAT(DISTINCT language) AS languages,
      MAX(saved) AS saved FROM calls WHERE name = ? AND module = ? GROUP BY version ORDER BY last DESC`).all(name, module);
    const secsOf = db.prepare('SELECT seconds FROM calls WHERE name = ? AND module = ? AND version IS ? AND purpose IS NULL ORDER BY seconds');
    const states = db.prepare(`SELECT s.state, COUNT(*) AS n FROM rating_state s JOIN calls c ON c.id = s.call
      WHERE c.name = ? AND c.module = ? AND c.version IS ? GROUP BY s.state`);
    return rows.map((v, i) => {
      const secs = secsOf.all(name, module, v.version).map(r => r.seconds);
      const ratings = { right: 0, wrong: 0, disputed: 0 };
      for (const s of states.all(name, module, v.version)) ratings[s.state] = s.n;
      return { version: v.version, current: i === 0, first: v.first, last: v.last, useCalls: v.use_calls || 0, otherCalls: v.other_calls || 0,
        errors: v.errors || 0, p50: percentile(secs, 0.5), tokens: v.tokens == null ? null : Math.round(v.tokens),
        languages: String(v.languages || '').split(',').filter(Boolean), saved: v.saved || null, ratings,
        sample: v.version ? sampleScore(name, module, v.version) : null };
    });
  }

  const RUN_FIELDS = `c.id, c.parent, c.root, c.name, c.module, c.kind, c.version, c.answer, c.started, c.seconds, c.content, c.error_type,
    c.error_code, c.error_message, c.model, c.provider, c.tokens_in, c.tokens_out, c.exchanges, c.cached, c.confidence, c.purpose,
    c.caller_kind, c.caller, c.person, c.host, c.language, c.inputs_preview, c.outputs_preview, c.answer_json,
    s.state AS rating, s.people AS rated_by_n, s.open AS rating_open`;
  function runView(r) {
    const caller = callerOf(r);
    return {
      id: r.id, parent: r.parent, root: r.root, name: r.name, module: r.module, kind: r.kind, version: r.version, answer: r.answer,
      started: r.started, seconds: r.seconds, content: !!r.content,
      error: r.error_type ? { type: r.error_type, code: r.error_code || undefined, message: r.error_message || undefined } : null,
      model: r.model, provider: r.provider, tokensIn: r.tokens_in, tokensOut: r.tokens_out, exchanges: r.exchanges, cached: r.cached,
      confidence: r.confidence, purpose: r.purpose, caller, callerKind: r.caller_kind, person: r.person, host: r.host, language: r.language,
      inputs: r.inputs_preview, outputs: r.outputs_preview, answerValue: r.answer_json != null ? JSON.parse(r.answer_json) : undefined,
      rating: r.rating || null, ratedBy: r.rated_by_n || 0, ratingOpen: !!r.rating_open,
    };
  }

  function runs(name, module, o = {}) {
    const where = ['c.name = ?', 'c.module = ?'], args = [name, module];
    if (o.version) { where.push('c.version = ?'); args.push(o.version); }
    if (o.purpose === 'evaluation' || o.purpose === 'optimization' || o.purpose === 'test') { where.push('c.purpose = ?'); args.push(o.purpose); }
    else if (o.purpose !== 'all') where.push('c.purpose IS NULL');
    if (o.status === 'error') where.push('c.error_type IS NOT NULL');
    else if (o.status === 'ok') where.push('c.error_type IS NULL');
    if (o.rating === 'unrated') where.push('s.state IS NULL');
    else if (o.rating === 'open') where.push('s.open = 1');
    else if (['right', 'wrong', 'disputed'].includes(o.rating)) { where.push('s.state = ?'); args.push(o.rating); }
    else if (o.rating === 'rated') where.push('s.state IS NOT NULL');
    if (o.caller) { where.push('c.caller_kind IS ?'); args.push(o.caller === 'unknown' ? null : o.caller); }
    if (o.model) { where.push('c.model = ?'); args.push(o.model); }
    if (o.from) { where.push('c.caller_ref = ?'); args.push(String(o.from)); }
    if (o.content === 'yes') where.push('c.content = 1');
    if (o.q) { where.push("c.search LIKE ? ESCAPE '\\'"); args.push('%' + String(o.q).toLowerCase().replace(/[%_\\]/g, m => '\\' + m) + '%'); }
    const sql = `FROM calls c LEFT JOIN rating_state s ON s.call = c.id WHERE ${where.join(' AND ')}`;
    const order = o.sort === 'old' ? 'c.started ASC, c.id ASC' : o.sort === 'slow' ? 'c.seconds DESC'
      : o.sort === 'unsure' ? 'c.confidence IS NULL, c.confidence ASC, c.started DESC' : 'c.started DESC, c.id DESC';
    const limit = Math.max(1, Math.min(500, Number(o.limit) || 50)), offset = Math.max(0, Number(o.offset) || 0);
    const total = db.prepare('SELECT COUNT(*) AS n ' + sql).get(...args).n;
    const list = db.prepare(`SELECT ${RUN_FIELDS} ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset).map(runView);
    return { total, runs: list, seq };
  }

  function run(id) {
    const r = db.prepare(`SELECT ${RUN_FIELDS} FROM calls c LEFT JOIN rating_state s ON s.call = c.id WHERE c.id = ?`).get(id);
    if (!r) return null;
    const record = summaryCall(id);
    const children = db.prepare(`SELECT ${RUN_FIELDS} FROM calls c LEFT JOIN rating_state s ON s.call = c.id WHERE c.parent = ? ORDER BY c.started`).all(id).map(runView);
    const parentRow = r.parent ? db.prepare(`SELECT ${RUN_FIELDS} FROM calls c LEFT JOIN rating_state s ON s.call = c.id WHERE c.id = ?`).get(r.parent) : null;
    const ratings = ratingsOf(id).sort((a, b) => (later(a, b, 'at') ? 1 : -1));
    const counting = currentRatings(ratings).get(id) || [];
    return { run: runView(r), record, children, parent: parentRow ? runView(parentRow) : null, ratings, counting };
  }

  // The same inputs answered by two versions: what a change did.
  function compare(name, module, a, b) {
    const pick = v => db.prepare(`SELECT ${RUN_FIELDS}, c.input_key FROM calls c LEFT JOIN rating_state s ON s.call = c.id
      WHERE c.name = ? AND c.module = ? AND c.version = ? AND c.input_key IS NOT NULL ORDER BY c.started`).all(name, module, v);
    const latestBy = rows => { const m = new Map(); for (const r of rows) m.set(r.input_key, r); return m; };
    const A = latestBy(pick(a)), B = latestBy(pick(b));
    const pairs = [];
    for (const [k, ra] of A) {
      const rb = B.get(k);
      if (!rb) continue;
      const same = ra.answer_json != null && ra.answer_json === rb.answer_json && !ra.error_type && !rb.error_type;
      pairs.push({ same, a: runView(ra), b: runView(rb) });
    }
    pairs.sort((x, y) => (x.same === y.same ? String(y.a.started).localeCompare(String(x.a.started)) : x.same ? 1 : -1));
    return { a, b, onlyA: A.size - pairs.length, onlyB: B.size - pairs.length, common: pairs.length,
      differ: pairs.filter(p => !p.same).length, pairs: pairs.slice(0, 300) };
  }

  // The rows with known answers (contract/calls.md), for evaluate and .opt.
  function rated(name, module, { signature = null, by = null } = {}) {
    const ids = db.prepare(`SELECT DISTINCT r.call FROM ratings r JOIN calls c ON c.id = r.call WHERE c.name = ? AND c.module = ?`).all(name, module).map(r => r.call);
    const calls = ids.map(summaryCall).filter(Boolean);
    const ratings = ids.flatMap(ratingsOf);
    return ratedRows(calls, ratings, { name, module, signature, by });
  }

  // A random draw of calls to judge. Its id rides on the ratings made from
  // it, so a score can be computed from draws alone.
  function sample(name, module, { n = 20, version = null, unrated = true } = {}) {
    // Answered calls only: a failed call has no answer to judge (failures
    // are counted on their own).
    const where = ['c.name = ?', 'c.module = ?', 'c.purpose IS NULL', 'c.content = 1', 'c.error_type IS NULL'], args = [name, module];
    if (version) { where.push('c.version = ?'); args.push(version); }
    if (unrated) where.push('s.state IS NULL');
    const size = Math.max(1, Math.min(200, Number(n) || 20));
    const ids = db.prepare(`SELECT c.id FROM calls c LEFT JOIN rating_state s ON s.call = c.id WHERE ${where.join(' AND ')} ORDER BY random() LIMIT ?`)
      .all(...args, size).map(r => r.id);
    return { sample: newId(now()), ids, version };
  }

  // Chattering's rating, appended to the log like any writer's
  // (contract/calls.md, "A rating record"), then read back through the index.
  function rate({ call, verdict, answer, outputs, reasons, note, origin = 'review', sample: sampleId, by }) {
    if (typeof call !== 'string' || !db.prepare('SELECT 1 FROM calls WHERE id = ?').get(call)) throw Object.assign(new Error('No such call in the log.'), { status: 404 });
    if (!['right', 'wrong', null].includes(verdict)) throw Object.assign(new Error('verdict is "right", "wrong", or null to withdraw'), { status: 400 });
    const hasAnswer = answer !== undefined;
    const hasOutputs = outputs && typeof outputs === 'object' && !Array.isArray(outputs) && Object.keys(outputs).length > 0;
    if ((hasAnswer || hasOutputs) && verdict !== 'wrong') throw Object.assign(new Error('Only a wrong answer takes a correction.'), { status: 400 });
    if (!by || typeof by !== 'string') throw Object.assign(new Error('A rating needs a person.'), { status: 400 });
    const rec = { functai_rating: FORMAT, id: newId(now()), call, at: iso(now()), by, verdict };
    if (hasAnswer) rec.answer = answer;
    if (hasOutputs) rec.outputs = outputs;
    const tags = Array.isArray(reasons) ? reasons.map(r => String(r).trim().slice(0, 80)).filter(Boolean).slice(0, 12) : [];
    if (tags.length) rec.reasons = tags;
    if (typeof note === 'string' && note.trim()) rec.note = note.trim().slice(0, 4000);
    rec.origin = origin === 'edit' ? 'edit' : 'review';
    if (typeof sampleId === 'string' && sampleId) rec.sample = sampleId.slice(0, 80);
    const line = JSON.stringify(rec) + '\n';
    if (Buffer.byteLength(line) > 1024 * 1024) throw Object.assign(new Error('That correction is too large.'), { status: 413 });
    const dayDir = path.join(folder, iso(now()).slice(0, 10));
    fs.mkdirSync(dayDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dayDir, writerName), line, { mode: 0o600 });
    refresh({ force: true });
    const st = db.prepare('SELECT state, people, open FROM rating_state WHERE call = ?').get(call);
    return { rating: rec, state: st ? { state: st.state, people: st.people, open: !!st.open } : null };
  }

  return {
    folder, refresh, programs, program, versions, runs, run, compare, rated, sample, rate,
    get seq() { return seq; }, writerName, close: () => db.close(),
  };
}

module.exports = { createProgramIndex, ratedRows, currentRatings, ratingState, wilson, newId, iso, canonical, readLines };
