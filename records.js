'use strict';
// records.js — the agent-facing view of the records.
//
// An agent (Pi, Claude Code, a delegated worker, a person in a terminal)
// asks "what was decided about X?", "show me that conversation", "what does
// project memory say?". One module answers all of them. It renders compact
// plain text made for a context window: every hit carries a short id, a
// date, a trust label, and the exact follow-up command. The same text goes
// out through the CLI (`chattering search …`), the Pi tools
// (extensions/records.ts) and GET /api/records/<op>, so the three never
// drift apart.
//
// Rules the renderer follows everywhere:
//   - bounded: every answer stops at `max` characters and says how to page.
//   - honest: transcripts and notes are AI records, not verified truth; the
//     trust label of every note or memory document is printed next to it.
//   - actionable: an answer never ends in a dead end; it ends in a command.
//
// The module is pure with respect to the server: everything it needs comes
// in through `deps`, so tests run it against a fake index.

const path = require('path');

const MEMORY_KINDS = ['overview', 'intent', 'environment', 'status'];
const CHAT_ROLES = new Set(['user', 'assistant']);
const DEFAULT_MAX = { search: 9000, show: 12000, list: 6000, doc: 14000 };

// Per-message clip in `show`. Tool noise is clipped hard; what people and
// the model said is kept nearly whole.
const CLIP = { user: 4000, assistant: 4000, thinking: 600, tool: 500, toolresult: 900, other: 300 };

const HELP = `chattering — query the conversation records of Chattering (all projects)

  chattering                              where was I? (last session in this folder)
  chattering search "<query>" [opts]      ranked passages across conversations, notes, memory
      --project NAME   only this project      --since 30d|2w|2026-08-01
      --role user|assistant|tool             --type conversation|note|epic|memory
      --limit N (10)   --offset N             --no-semantic   --no-prefix   --exclude ID
      Query grammar: bare words AND; "quoted phrase"; project: role: after: before: path:
  chattering show <id> [opts]             one conversation (id = short id, full key, or file path)
      (no option)      header + outline of every user turn
      --at N [--context K]   messages around #N (default K=3), all roles
      --from A --to B  a range              --last N   last N chat messages
      --roles chat|all (chat = user+assistant)   --max CHARS
  chattering conversations [PROJECT] [--since 30d] [--limit 20]
  chattering projects                     every project with memory state
  chattering memory [PROJECT] [KIND] [--area REL]      project map (overview intent environment status)
  chattering memory --epic ID [KIND]
  chattering notes [PROJECT]              distilled notes, newest first
  chattering note <id|file>               one note (conversation id, or path under the notes tree)
  chattering epics [PROJECT] / chattering epic <id>
  chattering evidence <id>                the evidence card or note of one conversation
  Chattering here [DIR]

  Working with other people's chatterings (design/52):
  chattering join <invite link> [--name "You"] [--folder DIR]   join a project someone invited you to, from this machine
  chattering sync [--all]                 pull and push shared projects with every peer now
  chattering peers                        the installs this one shares projects with
  chattering project-id [PROJECT]         the stable id of a project (the one in .chattering/project.json)

  PROJECT defaults to the project of the current folder. --json prints raw JSON.
  Records are AI transcripts and AI-written notes: a map of what was said, not verified truth.
  Notes carry a trust label: [unverified] means no person reviewed them.`;

// ---- small helpers -------------------------------------------------------

function shortId(key) {
  const base = String(key).slice(String(key).lastIndexOf('/') + 1).replace(/\.jsonl$/, '');
  const m = base.match(/(?:^|_)([0-9a-f]{8})-[0-9a-f]{4}-/i);
  return m ? m[1] : base.slice(-8);
}

// Dates and times print in local time, both of them, so a day never
// disagrees with the clock next to it.
function pad(n) { return String(n).padStart(2, '0'); }
function day(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return '????-??-??';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function hm(ts) {
  const d = ts ? new Date(ts) : null;
  if (!d || Number.isNaN(d.getTime())) return '--:--';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function ago(ts, now = Date.now()) {
  const s = Math.max(0, (now - new Date(ts).getTime()) / 1000);
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' days ago';
}
function oneLine(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
function clipText(s, n) {
  const t = String(s || '').replace(/\r/g, '').trimEnd();
  return t.length > n ? t.slice(0, n) + `\n… [+${t.length - n} chars]` : t;
}
function num(v, dflt, lo = 0, hi = Infinity) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
function flag(v) { return v === true || v === '1' || v === 'true' || v === 'yes'; }
function sq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// `--since 30d`, `2w`, `6m`, `1y`, or an ISO date → ISO timestamp.
function sinceToIso(v, now = Date.now()) {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d+)\s*([dwmy])$/i);
  if (m) {
    const n = Number(m[1]);
    const daysPer = { d: 1, w: 7, m: 30, y: 365 }[m[2].toLowerCase()];
    return new Date(now - n * daysPer * 86400000).toISOString();
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`bad --since value: ${v} (use 30d, 2w, 6m, 1y or a date)`);
  return new Date(t).toISOString();
}

// Search snippets carry \u0001/\u0002 around matched words. Plain text keeps
// them as «…» so the reader still sees why a passage matched.
function plainSnippet(s) {
  return String(s || '').replace(/\u0001/g, '«').replace(/\u0002/g, '»').replace(/\s+/g, ' ').trim();
}

// Stop at `max` characters on a line boundary and say how much is left.
function bound(text, max, more) {
  if (text.length <= max) return text;
  let cut = text.lastIndexOf('\n', max);
  if (cut < max * 0.6) cut = max;
  return text.slice(0, cut).trimEnd() + `\n\n[output cut at ${max} chars; ${text.length - cut} more]` + (more ? ` ${more}` : '');
}

function createRecords(deps) {
  const {
    fsp,
    index,               // () => { key: entry }
    epics,               // () => { id: epic }
    cachePathFor,
    keyForSessionPath,   // abs path → key | null
    projectNameOf,       // (cwd, key) → name
    projectMetaFor,      // name → { cwd, entries:[{key,entry}], epics } | null
    projectMemoryIndex,  // () => [{ name, title, cwd, conversations, docs }]
    projectMemoryDocument, areaMemoryDocument, epicMemoryDocument,
    declaredAreasFor,    // name → { rel: rec }
    trustLabel,          // abs path → '[unverified]' | …
    existingEvidenceFor, // (data, allowStale) → evidence | null
    searchIdx,           // () => SearchIndex | null
    semanticEnabled, semFetch, semNs, semanticGroups,
    runningKeys,         // () => Set of keys with a live agent
    notesDir, port,
    now = () => Date.now(),
  } = deps;

  const cli = 'chattering';
  const noteLabel = p => (p ? trustLabel(p) : '');

  // Live markers come from a /proc scan: one scan per answer, not per line.
  let liveSet = null;
  function liveMark(key) {
    if (!liveSet) { try { liveSet = runningKeys(); } catch { liveSet = new Set(); } }
    return liveSet.has(key) ? ' · LIVE' : '';
  }

  async function readCache(key) {
    return JSON.parse(await fsp.readFile(cachePathFor(key), 'utf8'));
  }

  // Resolve what an agent typed into one conversation key: the full key, a
  // session file path, the short id, or any unique substring.
  function resolveKey(id) {
    const idx = index();
    const raw = String(id || '').trim();
    if (!raw) throw new Error('missing conversation id');
    if (idx[raw]) return raw;
    if (path.isAbsolute(raw)) {
      const k = keyForSessionPath(raw);
      if (k) return k;
    }
    const keys = Object.keys(idx);
    let hits = keys.filter(k => shortId(k) === raw);
    if (!hits.length) hits = keys.filter(k => k.includes(raw));
    if (hits.length === 1) return hits[0];
    if (!hits.length) throw new Error(`no conversation matches "${raw}". Run: ${cli} conversations, or ${cli} search "<words>".`);
    hits.sort((a, b) => String(idx[b].lastTs || '').localeCompare(String(idx[a].lastTs || '')));
    const list = hits.slice(0, 6).map(k => `  ${shortId(k)}  ${day(idx[k].lastTs)}  ${oneLine(idx[k].title, 60)}`).join('\n');
    throw new Error(`"${raw}" matches ${hits.length} conversations. Use one short id:\n${list}`);
  }

  // The project an op works on: explicit name, else the project of `dir`.
  function projectFor(params, { required = true } = {}) {
    const name = String(params.project || '').trim();
    if (name) return name;
    const dir = String(params.dir || '').trim();
    if (dir) {
      const p = projectNameOf(dir, '');
      if (p && p !== '?') return p;
    }
    if (required) throw new Error(`no project given and none found for this folder. Run: ${cli} projects`);
    return null;
  }

  function entryLine(key, e, { withProject = true } = {}) {
    const bits = [shortId(key), day(e.lastTs) + ' ' + hm(e.lastTs), oneLine(e.timelineTitle || e.title || '(untitled)', 70)];
    const meta = [];
    if (withProject) meta.push(projectNameOf(e.cwd, key));
    meta.push(`${e.realUserCount ?? e.userCount ?? '?'} user turns`);
    if (e.notePath) meta.push('note');
    return bits.join('  ') + '  (' + meta.join(' · ') + ')' + liveMark(key);
  }

  // ---- ops ---------------------------------------------------------------

  async function search(params) {
    const q0 = String(params.q || '').trim();
    if (q0.length < 2) throw new Error('search needs at least 2 characters');
    const idx = searchIdx();
    if (!idx) throw new Error('the search index is not available on this server (node:sqlite missing)');
    const limit = num(params.limit, 10, 1, 50);
    const offset = num(params.offset, 0, 0);
    const max = num(params.max, DEFAULT_MAX.search, 500);
    let q = q0;
    const project = String(params.project || '').trim();
    if (project) q += ` project:${/\s/.test(project) ? JSON.stringify(project) : project}`;
    if (params.role) q += ` role:${String(params.role).trim()}`;
    if (params.type) q += ` type:${String(params.type).trim()}`;
    const since = sinceToIso(params.since, now());
    if (since) q += ` after:${since}`;
    // Like the UI, the last word prefix-matches ("capacitor" finds
    // "capacitors"); the index has no stemming, so this is the only plural
    // help there is. --no-prefix (prefix=false) matches whole words only.
    if (params.prefix !== undefined && !flag(params.prefix)) q += ' ';
    const boost = project || projectFor(params, { required: false }) || '';
    const exclude = new Set();
    if (params.exclude) { try { exclude.add(resolveKey(params.exclude)); } catch {} }
    if (params.excludePath) { const k = keyForSessionPath(String(params.excludePath)); if (k) exclude.add(k); }

    const t0 = now();
    // The index ranks every group anyway; take its whole (capped) list and
    // page here, so "N more" is always true.
    const lex = idx.search(q, { limit: 100, offset: 0, boostProject: boost });
    if (lex.error) throw new Error(`bad query: ${q0} (check quotes and field: operators)`);
    let groups = lex.groups.filter(g => !(g.key && exclude.has(g.key)));
    let semUsed = false, semError = null;
    const wantSem = params.semantic === undefined ? true : flag(params.semantic);
    if (wantSem && semanticEnabled()) {
      try {
        const r = await semFetch('/search', { ns: semNs(), q: q0, limit: 30 }, 8000);
        const seen = new Set(groups.map(g => g.key ? 'c:' + g.key : 'f:' + g.file));
        const extra = [];
        for (const g of semanticGroups(r.hits || [])) {
          if (g.key && exclude.has(g.key)) continue;
          if (project && g.project && g.project !== project) continue;
          const gid = g.key ? 'c:' + g.key : 'f:' + g.file;
          if (seen.has(gid)) continue;
          seen.add(gid);
          extra.push(g);
        }
        // Semantic hits rank after the lexical page: exact words first,
        // paraphrases next. They fill the page when the lexical stage is thin.
        groups = groups.concat(extra);
        semUsed = true;
      } catch (e) { semError = 'semantic stage unreachable'; }
    }
    const page = groups.slice(offset, offset + limit);
    const idxAll = index();
    const lines = [];
    const modeTxt = semUsed ? 'lexical + semantic' : (semError ? `lexical only (${semError})` : 'lexical');
    lines.push(`search ${JSON.stringify(q0)}${project ? ' in ' + project : ''}${since ? ' since ' + day(since) : ''} · ${lex.total} passages in ${groups.length} records · ${modeTxt} · ${now() - t0} ms`);
    if (!page.length) {
      lines.push('', offset ? 'No more results.' : `No results. Try fewer words, other words, or a wider --since. Or list what exists: ${cli} conversations${project ? ' ' + sq(project) : ''}.`);
      return { text: lines.join('\n'), q: q0, total: lex.total, groups: [] };
    }
    lines.push('');
    page.forEach((g, i) => {
      const n = offset + i + 1;
      if (g.kind === 'conversation') {
        const e = idxAll[g.key] || {};
        const id = shortId(g.key);
        lines.push(`${n}. [conversation] ${g.project || '?'} · ${day(e.lastTs || g.matches[0]?.ts)} · ${oneLine(e.timelineTitle || e.title || g.title || '(untitled)', 80)} · id ${id}${g.semantic ? ' · ~semantic' : ''}${liveMark(g.key)}`);
        for (const m of g.matches) {
          const where = m.i == null ? (m.role === 'title' ? 'title' : m.role) : `#${m.i} ${m.role}`;
          if (m.role === 'title' && m.i == null) continue;
          lines.push(`   ${where}: ${oneLine(plainSnippet(m.snippet), 220)}`);
        }
        const first = g.matches.find(m => m.i != null);
        lines.push(`   → ${cli} show ${id}${first ? ' --at ' + first.i : ''}`);
        if (e.notePath) lines.push(`   note: ${e.notePath} ${noteLabel(e.notePath)} → ${cli} note ${id}`);
      } else {
        const abs = path.join(notesDir, g.file || '');
        lines.push(`${n}. [${g.kind}] ${g.project || ''}${g.project ? ' · ' : ''}${oneLine(g.title || g.file, 80)} ${noteLabel(abs)}${g.semantic ? ' · ~semantic' : ''}`);
        for (const m of g.matches) lines.push(`   ${m.title ? oneLine(m.title, 40) + ': ' : ''}${oneLine(plainSnippet(m.snippet), 220)}`);
        lines.push(`   → ${cli} note ${sq(g.file)}`);
      }
      lines.push('');
    });
    if (groups.length > offset + limit) lines.push(`${groups.length - offset - limit} more records → ${cli} search ${sq(q0)} --offset ${offset + limit}`);
    const text = bound(lines.join('\n').trimEnd(), max, `Use --limit or --offset.`);
    return { text, q: q0, total: lex.total, groupCount: groups.length, semantic: semUsed, groups: page };
  }

  function showHeader(key, data, e) {
    const idx = index();
    const roles = {};
    for (const m of data.messages) roles[m.role] = (roles[m.role] || 0) + 1;
    const out = [];
    out.push(`${data.timelineTitle || data.title || e.title || '(untitled)'}`);
    out.push(`id ${shortId(key)} · ${projectNameOf(data.cwd, key)} · ${data.source || e.source} · ${day(data.firstTs)} ${hm(data.firstTs)} → ${day(data.lastTs)} ${hm(data.lastTs)} (${ago(data.lastTs, now())})${liveMark(key)}`);
    out.push(`${data.messages.length} messages: ${Object.entries(roles).map(([r, n]) => `${n} ${r}`).join(', ')}`);
    out.push(`cwd ${data.cwd || '?'}${data.gitBranch ? ' · branch ' + data.gitBranch : ''}`);
    out.push(`key ${key}`);
    if (data.notePath || e.notePath) {
      const p = data.notePath || e.notePath;
      const stale = e.mtimeMs && e.notedAt && e.mtimeMs > e.notedAt;
      out.push(`note ${p} ${noteLabel(p)}${stale ? ' · STALE (conversation continued after the note)' : ''} → ${cli} note ${shortId(key)}`);
    }
    if (data.parentSession) {
      const pk = keyForSessionPath(data.parentSession);
      if (pk && idx[pk]) out.push(`forked from ${shortId(pk)} · ${oneLine(idx[pk].title, 60)}`);
    }
    const inEpics = Object.values(epics()).filter(ep => (ep.sessionIds || []).includes(key));
    if (inEpics.length) out.push(`epics: ${inEpics.map(ep => `${oneLine(ep.title, 50)} (${ep.id})`).join('; ')}`);
    out.push('record: AI transcript — what was said, not verified truth');
    return out;
  }

  function renderMessage(m, i, allRoles) {
    const t = hm(m.ts);
    if (m.role === 'user') return `#${i} ${t} user\n${clipText(m.text, CLIP.user)}`;
    if (m.role === 'assistant') return `#${i} ${t} assistant\n${clipText(m.text, CLIP.assistant)}`;
    if (!allRoles) return null;
    if (m.role === 'thinking') return `#${i} ${t} thinking\n${clipText(m.text, CLIP.thinking)}`;
    if (m.role === 'tool') return `#${i} ${t} tool ${m.name || ''}${m.path ? ' ' + m.path : ''}\n${clipText(m.text, CLIP.tool)}`;
    if (m.role === 'toolresult') return `#${i} ${t} result\n${clipText(m.text, CLIP.toolresult)}`;
    return `#${i} ${t} ${m.role}${m.text ? '\n' + clipText(m.text, CLIP.other) : ''}`;
  }

  async function show(params) {
    const key = resolveKey(params.id);
    const e = index()[key];
    const data = await readCache(key);
    const msgs = data.messages || [];
    const max = num(params.max, DEFAULT_MAX.show, 500);
    const allRoles = String(params.roles || '').toLowerCase() === 'all';
    const id = shortId(key);
    const lines = showHeader(key, data, e);
    lines.push('');

    const at = params.at !== undefined && params.at !== '' ? num(params.at, -1, 0, msgs.length - 1) : -1;
    const hasRange = params.from !== undefined || params.to !== undefined;
    const last = params.last !== undefined ? num(params.last, 6, 1, 500) : 0;

    if (at >= 0 || hasRange || last) {
      let from, to, all = allRoles;
      if (at >= 0) {
        const ctx = num(params.context, 3, 0, 50);
        from = Math.max(0, at - ctx); to = Math.min(msgs.length - 1, at + ctx);
        all = params.roles === undefined ? true : allRoles; // zooming in shows the tools too
      } else if (hasRange) {
        from = num(params.from, 0, 0, msgs.length - 1);
        to = num(params.to, msgs.length - 1, from, msgs.length - 1);
      } else {
        const chat = [];
        for (let i = msgs.length - 1; i >= 0 && chat.length < last; i--) if (CHAT_ROLES.has(msgs[i].role)) chat.push(i);
        from = chat.length ? chat[chat.length - 1] : 0; to = msgs.length - 1;
      }
      lines.push(`messages #${from}–#${to} of 0–${msgs.length - 1}${all ? ' (all roles)' : ' (user + assistant; add --roles all for tools)'}`);
      lines.push('');
      let shown = 0;
      for (let i = from; i <= to; i++) {
        const r = renderMessage(msgs[i], i, all);
        if (r === null) continue;
        lines.push(r, '');
        shown++;
      }
      if (!shown) lines.push('(no user or assistant messages in this range; add --roles all)');
      const nav = [];
      if (from > 0) nav.push(`earlier: ${cli} show ${id} --from ${Math.max(0, from - 10)} --to ${from - 1}${all ? ' --roles all' : ''}`);
      if (to < msgs.length - 1) nav.push(`later: ${cli} show ${id} --from ${to + 1} --to ${Math.min(msgs.length - 1, to + 10)}${all ? ' --roles all' : ''}`);
      if (nav.length) lines.push(nav.join('   '));
      return { text: bound(lines.join('\n').trimEnd(), max, `Narrow with --from/--to or --context.`), key, id, from, to };
    }

    // Outline: every user turn is a waypoint; the last assistant message
    // says where it ended. The agent picks a #N and zooms with --at.
    const users = [];
    msgs.forEach((m, i) => { if (m.role === 'user') users.push(i); });
    lines.push(`outline: ${users.length} user turns (zoom: ${cli} show ${id} --at N; range: --from A --to B; whole tail: --last 8)`);
    lines.push('');
    for (const i of users) lines.push(`#${i} ${hm(msgs[i].ts)}  ${oneLine(msgs[i].text, 160)}`);
    let lastA = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant' && msgs[i].text) { lastA = i; break; }
    if (lastA >= 0) lines.push('', `last assistant #${lastA}:`, clipText(msgs[lastA].text, 1200));
    return { text: bound(lines.join('\n').trimEnd(), max, `Use --from/--to to read a slice.`), key, id, userTurns: users };
  }

  async function conversations(params) {
    const idx = index();
    const project = projectFor(params, { required: false });
    const dir = String(params.dir || '').trim();
    const since = sinceToIso(params.since, now());
    const limit = num(params.limit, 20, 1, 200);
    const max = num(params.max, DEFAULT_MAX.list, 500);
    let rows = Object.entries(idx).filter(([, e]) => e);
    let scope = 'all projects';
    if (project) { rows = rows.filter(([k, e]) => projectNameOf(e.cwd, k) === project); scope = project; }
    else if (dir && flag(params.underDir)) { rows = rows.filter(([, e]) => e.cwd && require('./platform.js').isInside(e.cwd, dir)); scope = 'under ' + dir; }
    if (since) rows = rows.filter(([, e]) => String(e.lastTs || '') >= since);
    rows.sort((a, b) => String(b[1].lastTs || '').localeCompare(String(a[1].lastTs || '')));
    const page = rows.slice(0, limit);
    const lines = [`conversations · ${scope}${since ? ' · since ' + day(since) : ''} · ${rows.length} total, newest ${page.length}`, ''];
    for (const [k, e] of page) lines.push(entryLine(k, e, { withProject: !project }));
    if (rows.length > limit) lines.push('', `${rows.length - limit} more → ${cli} conversations${project ? ' ' + sq(project) : ''} --limit ${Math.min(200, limit * 2)}`);
    lines.push('', `open one: ${cli} show <id>`);
    return { text: bound(lines.join('\n'), max), project, total: rows.length, rows: page.map(([k, e]) => ({ key: k, id: shortId(k), title: e.title, lastTs: e.lastTs })) };
  }

  async function projects(params) {
    const list = projectMemoryIndex().sort((a, b) => b.conversations - a.conversations);
    const here = projectFor(params, { required: false });
    const lines = [`projects · ${list.length}${here ? ` · this folder → ${here}` : ''}`, ''];
    for (const p of list) {
      const docs = MEMORY_KINDS.filter(k => p.docs[k]);
      lines.push(`${p.name}${p.title && p.title !== p.name ? ' — ' + oneLine(p.title, 50) : ''}  ${p.conversations} conversations  memory: ${docs.length ? docs.join(' ') : 'none'}  ${p.cwd || ''}`);
    }
    lines.push('', `next: ${cli} memory <project> · ${cli} conversations <project> · ${cli} search "<words>" --project <project>`);
    return { text: bound(lines.join('\n'), num(params.max, DEFAULT_MAX.list, 500)), projects: list };
  }

  async function memory(params) {
    const max = num(params.max, DEFAULT_MAX.doc, 500);
    const kinds = params.kind ? [String(params.kind)] : MEMORY_KINDS;
    for (const k of kinds) if (!MEMORY_KINDS.includes(k)) throw new Error(`unknown memory kind "${k}" (use ${MEMORY_KINDS.join(', ')})`);
    const blocks = [];
    let head;
    if (params.epic) {
      const ep = epics()[String(params.epic)];
      if (!ep) throw new Error(`no epic "${params.epic}". Run: ${cli} epics`);
      head = `epic memory · ${ep.title} (${ep.id})`;
      for (const k of kinds) {
        try { const d = await epicMemoryDocument(ep.id, k); blocks.push(`## ${k} · ${d.path} ${noteLabel(d.path)}\n\n${d.text.trim()}`); } catch {}
      }
    } else {
      const project = projectFor(params);
      const area = String(params.area || '').trim();
      head = `project memory · ${project}${area ? ' · area ' + area : ''}`;
      const areas = Object.keys(declaredAreasFor(project) || {});
      if (area && !areas.includes(area)) throw new Error(`"${area}" is not a declared area of ${project}${areas.length ? ' (areas: ' + areas.join(', ') + ')' : ''}`);
      for (const k of kinds) {
        try {
          const d = area ? await areaMemoryDocument(project, area, k) : await projectMemoryDocument(project, k);
          blocks.push(`## ${k} · ${d.path} ${noteLabel(d.path)}\n\n${d.text.trim()}`);
        } catch {}
      }
      if (!blocks.length) {
        const meta = projectMetaFor(project);
        if (!meta) throw new Error(`unknown project "${project}". Run: ${cli} projects`);
        return { text: `${head}\n\nNo memory documents yet (${meta.entries.length} conversations on record). Use: ${cli} conversations ${sq(project)} · ${cli} search "<words>" --project ${sq(project)}`, project, docs: [] };
      }
      if (!area && areas.length) head += `\nareas: ${areas.join(', ')} (add --area REL for the narrow map)`;
    }
    const text = [head, 'Memory is AI-written from the records. [unverified] = no person reviewed it.', '', blocks.join('\n\n---\n\n')].join('\n');
    return { text: bound(text, max, 'Ask for one KIND at a time.'), docs: blocks.length };
  }

  function noteRows(project) {
    const idx = index();
    const rows = [];
    for (const [k, e] of Object.entries(idx)) {
      if (!e || !e.notePath) continue;
      if (project && projectNameOf(e.cwd, k) !== project) continue;
      rows.push({ key: k, entry: e, stale: !!(e.mtimeMs && e.notedAt && e.mtimeMs > e.notedAt) });
    }
    rows.sort((a, b) => (b.entry.notedAt || 0) - (a.entry.notedAt || 0) || String(b.entry.lastTs || '').localeCompare(String(a.entry.lastTs || '')));
    return rows;
  }

  async function notes(params) {
    const project = projectFor(params, { required: false });
    const limit = num(params.limit, 30, 1, 300);
    const rows = noteRows(project);
    const lines = [`distilled notes · ${project || 'all projects'} · ${rows.length}`, ''];
    for (const { key, entry, stale } of rows.slice(0, limit)) {
      lines.push(`${shortId(key)}  ${day(entry.lastTs)}  ${oneLine(entry.title, 70)}  ${noteLabel(entry.notePath)}${stale ? ' STALE' : ''}${project ? '' : '  ' + projectNameOf(entry.cwd, key)}`);
      lines.push(`    ${entry.notePath}`);
    }
    if (rows.length > limit) lines.push('', `${rows.length - limit} more → --limit ${Math.min(300, limit * 2)}`);
    lines.push('', `read one: ${cli} note <id>   (STALE = the conversation continued after the note was written)`);
    return { text: bound(lines.join('\n'), num(params.max, DEFAULT_MAX.list, 500)), total: rows.length };
  }

  async function note(params) {
    const raw = String(params.id || '').trim();
    if (!raw) throw new Error('note needs a conversation id or a file under the notes tree');
    const max = num(params.max, DEFAULT_MAX.doc, 500);
    let file = null, from = '';
    // A file inside the notes tree (relative or absolute) wins; otherwise
    // it is a conversation id and the note is the one distilled from it.
    const candidate = path.isAbsolute(raw) ? raw : path.resolve(notesDir, raw);
    if (raw.endsWith('.md')) {
      if (candidate.startsWith(notesDir + path.sep)) file = candidate;
      else throw new Error(`note files must live under ${notesDir} (got ${candidate})`);
    }
    if (!file) {
      const key = resolveKey(raw);
      const e = index()[key];
      if (!e.notePath) throw new Error(`conversation ${shortId(key)} has no distilled note. Read it: ${cli} show ${shortId(key)}; or its evidence: ${cli} evidence ${shortId(key)}`);
      file = e.notePath;
      from = `distilled from ${shortId(key)} · ${oneLine(e.title, 60)}${e.mtimeMs && e.notedAt && e.mtimeMs > e.notedAt ? ' · STALE: the conversation continued after this note' : ''}`;
    }
    let text;
    try { text = await fsp.readFile(file, 'utf8'); } catch { throw new Error('note file missing: ' + file); }
    const head = [`${file} ${noteLabel(file)}`, from, 'AI-written note; [unverified] = no person reviewed it.'].filter(Boolean).join('\n');
    return { text: bound(head + '\n\n' + text.trim(), max), file };
  }

  async function epicsList(params) {
    const project = projectFor(params, { required: false });
    const idx = index();
    let list = Object.values(epics());
    if (project) list = list.filter(ep => (ep.sessionIds || []).some(k => idx[k] && projectNameOf(idx[k].cwd, k) === project));
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const lines = [`epics · ${project || 'all projects'} · ${list.length}`, ''];
    for (const ep of list.slice(0, num(params.limit, 30, 1, 200))) {
      lines.push(`${ep.id}  ${day(new Date(ep.updatedAt || 0).toISOString())}  ${oneLine(ep.title, 70)}  (${(ep.sessionIds || []).length} conversations) ${noteLabel(ep.notePath)}`);
      if (ep.abstract) lines.push(`    ${oneLine(ep.abstract, 200)}`);
    }
    lines.push('', `read one: ${cli} epic <id> · its map: ${cli} memory --epic <id>`);
    return { text: bound(lines.join('\n'), num(params.max, DEFAULT_MAX.list, 500)), total: list.length };
  }

  async function epic(params) {
    const ep = epics()[String(params.id || '').trim()];
    if (!ep) throw new Error(`no epic "${params.id}". Run: ${cli} epics`);
    const idx = index();
    let text = '';
    try { text = (await fsp.readFile(ep.notePath, 'utf8')).trim(); } catch { text = ep.abstract || '(epic note missing)'; }
    const lines = [`epic ${ep.id} · ${ep.title} ${noteLabel(ep.notePath)}`, `file ${ep.notePath}`, 'AI-written cross-conversation narrative; [unverified] = no person reviewed it.', ''];
    lines.push(text, '', `conversations (${(ep.sessionIds || []).length}):`);
    for (const k of ep.sessionIds || []) {
      const e = idx[k];
      lines.push(e ? `  ${entryLine(k, e)}` : `  ${shortId(k)}  (missing)`);
    }
    lines.push('', `epic map: ${cli} memory --epic ${ep.id}`);
    return { text: bound(lines.join('\n'), num(params.max, DEFAULT_MAX.doc, 500)), id: ep.id };
  }

  async function evidence(params) {
    const key = resolveKey(params.id);
    const data = await readCache(key);
    const ev = await existingEvidenceFor(data, true);
    const id = shortId(key);
    if (!ev) return { text: `no evidence card or note yet for ${id} · ${oneLine(data.title, 60)}. Read the transcript: ${cli} show ${id}`, key, id, evidence: null };
    const label = ev.kind === 'note' ? `${ev.notePath} ${noteLabel(ev.notePath)}` : 'evidence card (AI-written, unverified)';
    const lines = [`evidence · ${id} · ${oneLine(data.title, 70)} · ${day(data.lastTs)}`, `${ev.source}${ev.outdated ? ' · STALE: the conversation continued after this was written' : ''} · ${label}`, '', ev.text.trim(), '', `transcript: ${cli} show ${id}`];
    return { text: bound(lines.join('\n'), num(params.max, DEFAULT_MAX.doc, 500)), key, id, source: ev.source };
  }

  async function here(params) {
    const dir = String(params.dir || '').trim();
    if (!dir) throw new Error('here needs a folder');
    const idx = index();
    const hits = Object.entries(idx)
      .filter(([, e]) => e && e.cwd && require('./platform.js').isInside(e.cwd, dir))
      .sort((a, b) => String(b[1].lastTs || '').localeCompare(String(a[1].lastTs || '')));
    if (!hits.length) return { text: `No sessions found under ${dir}. Run: ${cli} projects`, count: 0 };
    const [key, e] = hits[0];
    const data = await readCache(key);
    // The last exchange: the last user turn and the last assistant reply.
    // An agentic turn can hold dozens of assistant messages in between;
    // they are counted, not printed.
    const msgs = data.messages;
    let lastUser = -1, lastAssistant = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (lastAssistant < 0 && msgs[i].role === 'assistant' && msgs[i].text) lastAssistant = i;
      if (msgs[i].role === 'user') { lastUser = i; break; }
    }
    const id = shortId(key);
    const project = projectNameOf(e.cwd, key);
    const lines = [`${data.timelineTitle || data.title || '(untitled)'}`,
      `id ${id} · ${project} · ${hits.length} session${hits.length > 1 ? 's' : ''} under this folder · last ended ${ago(e.lastTs, now())}${liveMark(key)}`, ''];
    if (lastUser >= 0) lines.push(`user #${lastUser}`, clipText(msgs[lastUser].text, 1500), '');
    if (lastAssistant > lastUser) {
      const between = msgs.slice(lastUser + 1, lastAssistant).filter(m => m.role === 'assistant' && m.text).length;
      if (between) lines.push(`(${between} assistant messages in between — ${cli} show ${id} --from ${lastUser + 1} --to ${lastAssistant})`, '');
      lines.push(`assistant #${lastAssistant}`, clipText(msgs[lastAssistant].text, 3000), '');
    }
    lines.push(`more: ${cli} show ${id} · ${cli} conversations ${sq(project)} · ${cli} memory ${sq(project)} · web http://localhost:${port}/#${encodeURIComponent(key)}`);
    return { text: bound(lines.join('\n'), num(params.max, DEFAULT_MAX.show, 500)), key, id, count: hits.length, project };
  }

  const OPS = { search, show, conversations, projects, memory, notes, note, epics: epicsList, epic, evidence, here };

  async function run(op, params = {}) {
    if (op === 'help') return { text: HELP };
    const fn = OPS[op];
    if (!fn) throw new Error(`unknown records op "${op}". Ops: help, ${Object.keys(OPS).join(', ')}`);
    liveSet = null;
    return fn(params);
  }

  return { run, ops: Object.keys(OPS), resolveKey };
}

module.exports = { createRecords, shortId, sinceToIso, plainSnippet, bound, HELP, MEMORY_KINDS };
