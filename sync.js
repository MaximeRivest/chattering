'use strict';
// Project sync between installs: a project's conversations, memory leaves
// and notes flow between the machines of the people who work on it.
//
// The rule that keeps this simple: every record has one origin install and
// only the origin writes it. What arrives from a peer is a MIRROR —
// readable, searchable, forkable, never edited here. There is nothing to
// merge, so there is no merge. Memory documents are not synced at all:
// each install regenerates them from the union of leaves it holds.
//
// Transport: a project feed (`GET /api/sync/feed`) that a peer pulls as
// the person it is (its credential names a guest or a member on this
// roster, and the ordinary access rules decide what the feed contains),
// and a push (`POST /api/sync/push`) for installs that cannot be reached
// from outside (a laptop behind a home router). Both land in the same
// import path. No server in the middle.
//
// Sharing is also leaking: a transcript holds tool output. Before a
// conversation leaves this machine, tool results that touched paths
// outside the project folder (or commands that smell of secrets) are
// redacted, per the project's policy: redact (default), exclude the whole
// conversation, or send it whole.
//
// See design/52-project-invites-and-sync.md.
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const PEERS_VERSION = 1;
const POLICIES = ['redact', 'exclude', 'whole'];
const PULL_INTERVAL_MS = 60 * 1000;
const FEED_LIMIT_ITEMS = 25;
const FEED_LIMIT_BYTES = 12 * 1024 * 1024;
const MIRROR_SOURCE = 'mirror';
const REDACTED = '[redacted before sharing: this tool step touched files outside the project folder, or looked like it could hold a secret]';

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const newId = prefix => prefix + '_' + crypto.randomBytes(8).toString('hex');

// ---- redaction ----
// Paths in a tool call that fall outside the project root. `~` and $HOME
// count as outside (a home directory is where secrets live); relative
// paths are inside by construction (the agent runs in the project).
const ABS_PATH_RE = /(?:^|[\s"'`=:(,<>|])((?:~|\$HOME|\$\{HOME\})?\/[A-Za-z0-9._~\-+@%][^\s"'`)<>|;&]*)/g;
// Words that make a tool step likely to hold a secret. `token` and `secret`
// must stand alone or be joined by _ or - (GITHUB_TOKEN, --token), so that
// tokens.css or estimateInputTokens do not trip it; over-redacting one
// step is the safe error, under-redacting is not.
const SECRET_HINT_RE = /(?:\b(?:printenv|env(?!ironment)\b|export\s+-p|\.netrc|\.ssh\/|\.gnupg|\.aws\/credentials|auth\.json|credentials\.json|\.env\b|id_rsa|id_ed25519|secrets?\.(?:json|ya?ml|toml)|api[_-]?key|passw(?:or)?d)|(?:^|[^A-Za-z])(?:token|secrets?)(?=[^A-Za-z]|$))/i;

function insideRoot(p, root) {
  if (!root) return false;
  const r = root.replace(/\/+$/, '');
  return p === r || p.startsWith(r + '/');
}
// Why a tool call must not travel, or null when it may.
function toolCallFlag(name, input, projectRoot, { home = '' } = {}) {
  const inp = input && typeof input === 'object' ? input : {};
  const texts = [];
  for (const v of Object.values(inp)) if (typeof v === 'string') texts.push(v);
  const joined = texts.join('\n');
  if (SECRET_HINT_RE.test(joined)) return 'secret-hint';
  const seen = new Set();
  for (const m of joined.matchAll(ABS_PATH_RE)) {
    let p = m[1];
    if (p.startsWith('~') || p.startsWith('$HOME') || p.startsWith('${HOME}')) {
      // Inside the home but under the project root is fine; anything else in the home is not.
      const rest = p.replace(/^(?:~|\$HOME|\$\{HOME\})/, '');
      p = (home || '~') + rest;
      if (!home) return 'outside-project';
    }
    if (seen.has(p)) continue;
    seen.add(p);
    if (/^\/(?:tmp|dev|proc|sys|usr|bin|etc\/(?:os-release|hostname)|nix\/store)\b/.test(p)) continue; // system paths hold no personal data of note
    if (!insideRoot(p, projectRoot)) return 'outside-project';
  }
  return null;
}

// Rewrite one transcript (pi or Claude jsonl) for sharing. Two passes over
// the same lines: find the flagged tool calls, then blank their results.
// Returns the text and counts; with policy 'exclude' and any flag, `text`
// is null (the conversation stays home).
function redactTranscript(text, { projectRoot, policy = 'redact', home = '' } = {}) {
  if (!POLICIES.includes(policy)) policy = 'redact';
  const lines = String(text || '').split('\n');
  if (policy === 'whole') return { text: String(text || ''), flagged: 0, redacted: 0, excluded: false };
  const flagged = new Map(); // tool call id -> reason
  const parsed = lines.map(l => { if (!l) return null; try { return JSON.parse(l); } catch { return null; } });
  for (const d of parsed) {
    if (!d) continue;
    const content = d.message && d.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || (b.type !== 'toolCall' && b.type !== 'tool_use')) continue;
      const reason = toolCallFlag(b.name, b.arguments || b.input, projectRoot, { home });
      if (reason && b.id) flagged.set(b.id, reason);
    }
  }
  if (!flagged.size) return { text: lines.join('\n'), flagged: 0, redacted: 0, excluded: false };
  if (policy === 'exclude') return { text: null, flagged: flagged.size, redacted: 0, excluded: true };
  let redacted = 0;
  const out = lines.map((line, i) => {
    const d = parsed[i];
    if (!d || !d.message) return line;
    const msg = d.message;
    let changed = false;
    if (msg.role === 'toolResult') {
      const id = msg.toolCallId || msg.toolCallID;
      if (id && flagged.has(id)) { msg.content = [{ type: 'text', text: REDACTED }]; delete msg.details; changed = true; }
    } else if (Array.isArray(msg.content)) {
      msg.content = msg.content.map(b => {
        if (b && b.type === 'tool_result' && b.tool_use_id && flagged.has(b.tool_use_id)) { changed = true; return { ...b, content: REDACTED }; }
        return b;
      });
    }
    if (!changed) return line;
    redacted++;
    return JSON.stringify(d);
  });
  return { text: out.join('\n'), flagged: flagged.size, redacted, excluded: false };
}

// ---- peers ----
// Another install that shares projects with this one. `credential` is what
// we present there (a secret that names us on their roster); `url` is
// where they answer, empty when they can only push to us.
function normalizePeers(raw) {
  const out = { v: PEERS_VERSION, peers: [] };
  for (const p of Array.isArray(raw && raw.peers) ? raw.peers : []) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string') continue;
    out.peers.push({
      id: p.id, name: String(p.name || 'peer').slice(0, 60), url: typeof p.url === 'string' ? p.url.replace(/\/+$/, '') : '',
      credential: typeof p.credential === 'string' ? p.credential : '',
      publicKey: typeof p.publicKey === 'string' ? p.publicKey : '',
      // The person we are on their roster, and who they are on ours.
      me: p.me && typeof p.me === 'object' ? { id: String(p.me.id || ''), name: String(p.me.name || '') } : null,
      them: p.them && typeof p.them === 'object' ? { id: String(p.them.id || ''), name: String(p.them.name || '') } : null,
      projects: (Array.isArray(p.projects) ? p.projects : []).filter(x => x && typeof x.id === 'string')
        .map(x => ({ id: x.id, name: String(x.name || 'project'), right: x.right === 'act' ? 'act' : 'see', pullCursor: Number(x.pullCursor) || 0, pushCursor: Number(x.pushCursor) || 0 })),
      // 'host': they joined us with our invite (their rights here decide
      // what we accept from them); 'joined': we joined them.
      role: p.role === 'joined' ? 'joined' : 'host',
      createdAt: p.createdAt || new Date().toISOString(),
      lastPullAt: p.lastPullAt || null, lastPushAt: p.lastPushAt || null, lastError: typeof p.lastError === 'string' ? p.lastError : '',
      paused: !!p.paused,
    });
  }
  return out;
}
function loadPeers(file) {
  try { return normalizePeers(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return normalizePeers(null); }
}
function savePeers(file, peers) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalizePeers(peers), null, 2) + '\n', { mode: 0o600 });
  require('./platform.js').renameSyncRetry(tmp, file);
}
const publicPeer = p => p && { id: p.id, name: p.name, url: p.url, reachable: !!p.url, role: p.role, me: p.me, them: p.them, projects: p.projects.map(x => ({ id: x.id, name: x.name, right: x.right })), createdAt: p.createdAt, lastPullAt: p.lastPullAt, lastPushAt: p.lastPushAt, lastError: p.lastError, paused: p.paused };

// A relative path from a peer, made safe to join under the mirror folder.
function safeRel(rel) {
  const parts = String(rel || '').replace(/\\/g, '/').split('/').filter(s => s && s !== '.' && s !== '..');
  if (!parts.length) throw new Error('bad mirror path');
  return parts.map(s => s.replace(/[^A-Za-z0-9._@%+=,-]/g, '_')).join('/');
}
const mirrorKey = (peerId, source, rel) => `${MIRROR_SOURCE}:${peerId}/${source}/${safeRel(rel)}`;
const isMirrorKey = key => typeof key === 'string' && key.startsWith(MIRROR_SOURCE + ':');
function mirrorPeerOf(key) { return isMirrorKey(key) ? key.slice(MIRROR_SOURCE.length + 1).split('/')[0] : null; }

// Feed item version: the newest of the transcript, its leaf and its note.
function itemVersion(entry, leaf, notedAt) {
  return Math.max(Number(entry && entry.mtimeMs) || 0, Number(leaf && leaf.builtAt) || 0, Number(notedAt) || 0);
}

// ---- engine ----
// deps:
//   hostname, homeDir, mirrorDir, mirrorNotesDir, peersFile, log(msg)
//   localConversations(projectId) -> [{ key, entry, absPath, source, rel }]   (origin-local only)
//   canSee(identity, key) -> bool
//   projectRootOf(projectId) -> abs path or null
//   projectPolicyOf(projectId) -> 'redact' | 'exclude' | 'whole'
//   readLeaf(key) -> leaf | null ; writeLeaf(key, leaf)
//   readNote(entry) -> { text, notedAt } | null
//   onImported({ key, projectId, notePath, notedAt, participants }) -> Promise (index + assign)
//   onDropped(key)
//   fetch (injectable for tests)
function createSyncEngine(deps) {
  const log = deps.log || (() => {});
  const fetchFn = deps.fetch || globalThis.fetch;
  let peers = loadPeers(deps.peersFile);
  const save = () => { try { savePeers(deps.peersFile, peers); } catch (e) { log('[sync] save peers: ' + e.message); } };
  let timer = null;
  let running = null;

  function peerById(id) { return peers.peers.find(p => p.id === id) || null; }
  function addPeer(spec) {
    const existing = spec.url && peers.peers.find(p => p.url === spec.url) || (spec.publicKey && peers.peers.find(p => p.publicKey === spec.publicKey)) || null;
    const peer = existing || normalizePeers({ peers: [{ id: newId('peer'), ...spec }] }).peers[0];
    if (existing) {
      for (const k of ['name', 'url', 'credential', 'publicKey', 'me', 'them', 'role']) if (spec[k] !== undefined) existing[k] = spec[k];
      for (const pr of spec.projects || []) {
        const have = existing.projects.find(x => x.id === pr.id);
        if (have) { have.name = pr.name || have.name; have.right = pr.right || have.right; }
        else existing.projects.push({ id: pr.id, name: pr.name || 'project', right: pr.right || 'see', pullCursor: 0, pushCursor: 0 });
      }
    } else peers.peers.push(peer);
    save();
    return peer;
  }
  function addProjectToPeer(id, pr) {
    const p = peerById(id);
    if (!p) throw new Error('no such peer');
    const have = p.projects.find(x => x.id === pr.id);
    if (have) { have.name = pr.name || have.name; have.right = pr.right || have.right; }
    else p.projects.push({ id: pr.id, name: pr.name || 'project', right: pr.right || 'see', pullCursor: 0, pushCursor: 0 });
    save();
    return p;
  }
  function updatePeer(id, patch) {
    const p = peerById(id);
    if (!p) throw new Error('no such peer');
    if (patch.paused !== undefined) p.paused = !!patch.paused;
    if (patch.name !== undefined) p.name = String(patch.name).slice(0, 60);
    if (patch.url !== undefined) p.url = String(patch.url).replace(/\/+$/, '');
    save();
    return p;
  }
  function removePeer(id) {
    const p = peerById(id);
    if (!p) throw new Error('no such peer');
    peers.peers = peers.peers.filter(x => x.id !== id);
    save();
    return p;
  }

  // What this install sends about one project, after `since`, as seen by
  // `identity`. Pagination by item count and bytes; `cursor` is the
  // version to ask for next, `more` says whether to ask again now.
  async function buildFeed({ projectId, since = 0, identity, limit = FEED_LIMIT_ITEMS, maxBytes = FEED_LIMIT_BYTES }) {
    const root = deps.projectRootOf(projectId);
    const policy = deps.projectPolicyOf(projectId);
    const rows = [];
    for (const c of deps.localConversations(projectId)) {
      if (!deps.canSee(identity, c.key)) continue;
      const leaf = await deps.readLeaf(c.key);
      const note = deps.readNote ? await deps.readNote(c.entry) : null;
      const version = itemVersion(c.entry, leaf, note && note.notedAt);
      if (version <= since) continue;
      rows.push({ ...c, leaf, note, version });
    }
    rows.sort((a, b) => a.version - b.version);
    const items = [];
    let bytes = 0, cursor = since, more = false, excluded = 0, redactedSteps = 0;
    for (const r of rows) {
      if (items.length >= limit || bytes >= maxBytes) { more = true; break; }
      let raw = '';
      try { raw = await fsp.readFile(r.absPath, 'utf8'); } catch { cursor = Math.max(cursor, r.version); continue; }
      const red = redactTranscript(raw, { projectRoot: root, policy, home: deps.homeDir });
      cursor = Math.max(cursor, r.version);
      if (red.excluded) { excluded++; items.push({ kind: 'tombstone', key: r.key, version: r.version, reason: 'excluded by the sharing policy' }); continue; }
      redactedSteps += red.redacted;
      const e = r.entry;
      const item = {
        kind: 'conversation', key: r.key, source: r.source, rel: r.rel, version: r.version,
        entry: { title: e.title || '', timelineTitle: e.timelineTitle || null, firstTs: e.firstTs || null, lastTs: e.lastTs || null, cwd: e.cwd || null, gitBranch: e.gitBranch || null,
          createdBy: e.createdBy || null, participants: e.participants || [], realUserCount: e.realUserCount || 0 },
        transcript: red.text, redacted: red.redacted, flagged: red.flagged,
        leaf: r.leaf ? { ...r.leaf, key: undefined } : null,
        note: r.note ? { text: r.note.text, notedAt: r.note.notedAt } : null,
      };
      bytes += Buffer.byteLength(red.text) + (r.leaf ? JSON.stringify(r.leaf).length : 0) + (r.note ? r.note.text.length : 0);
      items.push(item);
    }
    return { v: 1, host: deps.hostname, project: projectId, since, cursor, more, items, stats: { candidates: rows.length, sent: items.length, excluded, redactedSteps } };
  }

  // Land items from a peer: transcripts under the mirror source, leaves
  // with the mirror key, notes under the mirror notes folder. Then the
  // indexer takes over like for any transcript.
  async function importItems(peer, projectId, items) {
    let landed = 0;
    for (const it of items) {
      if (!it || typeof it.key !== 'string') continue;
      const [source, ...restParts] = it.key.split(':');
      const rel = restParts.join(':');
      if (!source || !rel || source === MIRROR_SOURCE) continue; // never mirror a mirror
      let key;
      try { key = mirrorKey(peer.id, source, rel); } catch { continue; }
      const file = path.join(deps.mirrorDir, key.slice(MIRROR_SOURCE.length + 1));
      if (it.kind === 'tombstone') {
        try { await fsp.unlink(file); } catch {}
        if (deps.onDropped) await deps.onDropped(key);
        continue;
      }
      if (it.kind !== 'conversation' || typeof it.transcript !== 'string') continue;
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp-' + process.pid;
      await fsp.writeFile(tmp, it.transcript);
      await require('./platform.js').renameRetry(tmp, file);
      if (it.leaf && typeof it.leaf === 'object') {
        await deps.writeLeaf(key, { ...it.leaf, key, mirrored: { peer: peer.id, originKey: it.key, host: it.leaf.host || null } });
      }
      let notePath = null, notedAt = null;
      if (it.note && typeof it.note.text === 'string' && it.note.text.trim()) {
        notePath = path.join(deps.mirrorNotesDir, peer.id, safeRel(rel).replace(/\.jsonl$/, '') + '.md');
        await fsp.mkdir(path.dirname(notePath), { recursive: true });
        await fsp.writeFile(notePath, it.note.text);
        notedAt = Number(it.note.notedAt) || Date.now();
      }
      await deps.onImported({ key, file, peer, projectId, item: it, notePath, notedAt });
      landed++;
    }
    return landed;
  }

  async function request(peer, pathname, { method = 'GET', body = null, timeoutMs = 60000 } = {}) {
    if (!peer.url) throw new Error('that peer cannot be reached from here (no address); it pushes to us instead');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchFn(peer.url + pathname, { method, signal: ctl.signal,
        headers: { Authorization: 'Bearer ' + peer.credential, ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-Chattering-Sync': deps.hostname },
        body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      if (!r.ok) throw new Error((data && data.error) || `${r.status} from ${peer.url}`);
      return data;
    } finally { clearTimeout(t); }
  }

  async function pull(peer, { all = false } = {}) {
    let landed = 0;
    for (const pr of peer.projects) {
      // A guest who may only read here contributes nothing here: their
      // conversations are not pulled, as they could not be pushed.
      if (peer.role === 'host' && pr.right !== 'act') continue;
      let since = all ? 0 : pr.pullCursor;
      for (let page = 0; page < 40; page++) {
        const feed = await request(peer, `/api/sync/feed?project=${encodeURIComponent(pr.id)}&since=${since}`);
        landed += await importItems(peer, pr.id, feed.items || []);
        since = Math.max(since, Number(feed.cursor) || 0);
        pr.pullCursor = since;
        save();
        if (!feed.more) break;
      }
    }
    peer.lastPullAt = new Date().toISOString();
    save();
    return landed;
  }

  // Push: what we have that they have not seen, computed by the same feed
  // builder as ourselves (the console identity: our own machine sends
  // what we, the owner, may see — the peer's rights are checked THERE).
  async function push(peer, identity, { all = false } = {}) {
    let sent = 0;
    for (const pr of peer.projects) {
      let since = all ? 0 : pr.pushCursor;
      for (let page = 0; page < 40; page++) {
        const feed = await buildFeed({ projectId: pr.id, since, identity });
        if (feed.items.length) {
          const r = await request(peer, '/api/sync/push', { method: 'POST', body: { project: pr.id, host: deps.hostname, items: feed.items, cursor: feed.cursor } });
          sent += Number(r && r.landed) || 0;
        }
        since = Math.max(since, feed.cursor);
        pr.pushCursor = since;
        save();
        if (!feed.more) break;
      }
    }
    peer.lastPushAt = new Date().toISOString();
    save();
    return sent;
  }

  async function syncPeer(peer, identity, opts = {}) {
    if (peer.paused && !opts.force) return { pulled: 0, pushed: 0, skipped: 'paused' };
    const out = { pulled: 0, pushed: 0 };
    try {
      if (peer.url) { out.pulled = await pull(peer, opts); out.pushed = await push(peer, identity, opts); }
      peer.lastError = '';
    } catch (e) {
      peer.lastError = e.message;
      log(`[sync] ${peer.name}: ${e.message}`);
    }
    save();
    return out;
  }
  async function syncAll(identity, opts = {}) {
    if (running) return running;
    running = (async () => {
      const results = {};
      for (const peer of peers.peers) results[peer.id] = await syncPeer(peer, identity, opts);
      return results;
    })();
    try { return await running; } finally { running = null; }
  }
  function start(identity, intervalMs = PULL_INTERVAL_MS) {
    stop();
    timer = setInterval(() => { syncAll(identity).catch(e => log('[sync] ' + e.message)); }, intervalMs);
    if (timer.unref) timer.unref();
    setTimeout(() => syncAll(identity).catch(e => log('[sync] ' + e.message)), 5000).unref?.();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return {
    get peers() { return peers.peers; }, peerById, addPeer, addProjectToPeer, updatePeer, removePeer, publicPeer,
    buildFeed, importItems, pull, push, syncPeer, syncAll, start, stop, request,
    // Re-read after another process wrote the file (the CLI's join).
    reload() { peers = loadPeers(deps.peersFile); return peers.peers; },
  };
}

module.exports = { POLICIES, MIRROR_SOURCE, REDACTED, PULL_INTERVAL_MS, toolCallFlag, redactTranscript, normalizePeers, loadPeers, savePeers, publicPeer, safeRel, mirrorKey, isMirrorKey, mirrorPeerOf, itemVersion, createSyncEngine, sha256 };
