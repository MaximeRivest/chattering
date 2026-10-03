'use strict';
// Shared links (design/92): "anyone with the link can view / can edit", for
// one thing on this computer, served from it, with no account.
//
// A share is one record here: what (one file, live), the role the link
// gives (view or edit), who made it, until when. Every request a visitor
// makes passes one gate (this file): the link's secret proves they were
// given the link; the share must still be active; the person who made it
// must still have the right to what it names (checked again on every
// request, through deps.resolve). Nothing else on the computer is reachable
// from a share: no other file, no conversation, no agent, no command.
//
// The link:   <base>/s/<id>/#<secret>
//   - id: 16 lowercase base32 characters (80 bits). Lowercase so it can
//     become a host name later (<id>.<user>.rockfrog.site); it names the
//     share, it does not open it.
//   - secret: 22 base64url characters (128 bits), after '#', which a browser
//     never sends to any server: not in request lines, logs or Referer.
//     The page reads it and proves it once (POST /s/<id>/open); the answer
//     is a session cookie scoped to this share's path.
//   The secret is derived (HMAC of the id and a generation) from a key
//   kept in a file only this user can read, so the owner can copy the link
//   again at any time; "new link" bumps the generation, which kills the
//   old link and every session opened with it.
//
// Sessions: a signed cookie naming the share, its generation and a random
// visitor id. Stateless, but checked against the share on every request:
// revoking, expiring or changing the link takes effect at once, and open
// live connections are closed (closeShare).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[a-z2-7]{16}$/;
const ROLES = ['view', 'edit'];
const SESSION_MS = 30 * 24 * 3600e3;
const KEEP_REVOKED_MS = 30 * 24 * 3600e3;
const MAX_LIVE_PER_SHARE = 50;
const MAX_LIVE_TOTAL = 300;
const MESSAGE_MAX = 512 * 1024;               // one WebSocket message from a visitor
const BUDGET = { bytes: 4 * 1024 * 1024, perMs: 60e3 }; // what one visitor may send per minute
const ASSET_MAX = 25 * 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp', '.ico']);
const DISPLAY_EXT = new Set(['.html', '.htm']);

const b64u = buf => Buffer.from(buf).toString('base64url');
function base32(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
const newShareId = () => base32(crypto.randomBytes(10)); // 80 bits → 16 characters
const equalText = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function cleanVisitorName(raw) {
  const s = String(raw || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || 'Someone';
}
// The same colours as users.js picks for people, from the visitor id.
function visitorColor(id) {
  const palette = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#d6409f', '#ab4aba', '#3e63dd'];
  const h = crypto.createHash('sha256').update(String(id)).digest();
  return palette[h[0] % palette.length];
}

// ---- the store --------------------------------------------------------------
class ShareStore {
  constructor({ file, keyFile, now = () => Date.now() }) {
    this.file = file;
    this.now = now;
    let key = null;
    try { key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex'); } catch {}
    if (!key || key.length < 32) {
      key = crypto.randomBytes(32);
      fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(keyFile, key.toString('hex') + '\n', { mode: 0o600 });
    }
    this.key = key;
    this.shares = new Map();
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    for (const s of (raw && Array.isArray(raw.shares) ? raw.shares : [])) {
      const n = normalizeShare(s);
      if (n) this.shares.set(n.id, n);
    }
  }
  save() {
    const cut = this.now() - KEEP_REVOKED_MS;
    for (const [id, s] of this.shares) if (s.revokedAt && s.revokedAt < cut) this.shares.delete(id);
    const body = JSON.stringify({ v: 1, shares: [...this.shares.values()] }, null, 1) + '\n';
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  mac(label, text) { return crypto.createHmac('sha256', this.key).update(label + '\0' + text).digest(); }
  secretOf(share) { return b64u(this.mac('share-link', share.id + '\0' + share.gen).subarray(0, 16)); }

  // An active share: exists, not revoked, not expired.
  active(id) {
    const s = this.shares.get(String(id || ''));
    if (!s || s.revokedAt) return null;
    if (s.expiresAt && s.expiresAt <= this.now()) return null;
    return s;
  }
  get(id) { return this.shares.get(String(id || '')) || null; }
  list(filter = () => true) { return [...this.shares.values()].filter(filter).sort((a, b) => b.createdAt - a.createdAt); }

  create({ kind = 'file', path: abs, title, role, createdBy, expiresAt = null }) {
    if (kind !== 'file') throw httpError(400, 'Only files can be shared for now.');
    if (!ROLES.includes(role)) throw httpError(400, 'A link can view or edit.');
    if (!abs || !path.isAbsolute(abs)) throw httpError(400, 'Which file?');
    if (!createdBy) throw httpError(400, 'Who is sharing?');
    let id;
    do { id = newShareId(); } while (this.shares.has(id));
    const share = normalizeShare({ id, kind, path: abs, title: title || path.basename(abs), role, createdBy, createdAt: this.now(), expiresAt: cleanExpiry(expiresAt, this.now()), gen: 1 });
    this.shares.set(id, share);
    this.save();
    return share;
  }
  change(id, patch) {
    const s = this.shares.get(id);
    if (!s || s.revokedAt) throw httpError(404, 'This link no longer exists.');
    if (patch.role !== undefined) { if (!ROLES.includes(patch.role)) throw httpError(400, 'A link can view or edit.'); s.role = patch.role; }
    if (patch.expiresAt !== undefined) s.expiresAt = cleanExpiry(patch.expiresAt, this.now());
    if (patch.newSecret) s.gen += 1;
    s.changedAt = this.now();
    this.save();
    return s;
  }
  revoke(id) {
    const s = this.shares.get(id);
    if (!s) throw httpError(404, 'This link no longer exists.');
    if (!s.revokedAt) { s.revokedAt = this.now(); this.save(); }
    return s;
  }
  noteOpen(s) { s.opens = (s.opens || 0) + 1; s.lastOpenAt = this.now(); this.saveSoon(); }
  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; try { this.save(); } catch {} }, 2000);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  // Proving the link. Constant time; a wrong secret and an unknown or
  // inactive share look the same from outside.
  verifySecret(id, secret) {
    const s = this.active(id);
    const want = s ? this.secretOf(s) : 'x'.repeat(22);
    const ok = equalText(want, String(secret || ''));
    return ok && s ? s : null;
  }
  issueSession(share, visitorId = b64u(crypto.randomBytes(9))) {
    const body = b64u(JSON.stringify({ s: share.id, g: share.gen, v: visitorId, t: this.now() }));
    return { value: body + '.' + b64u(this.mac('share-session', body)), visitorId };
  }
  readSession(id, value) {
    const [body, mac] = String(value || '').split('.');
    if (!body || !mac) return null;
    const want = this.mac('share-session', body), got = Buffer.from(mac, 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    let c;
    try { c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    const s = this.active(id);
    if (!s || c.s !== s.id || c.g !== s.gen || !(c.t + SESSION_MS > this.now())) return null;
    return { share: s, visitorId: String(c.v || '') };
  }
}
function cleanExpiry(at, now) {
  if (at == null || at === '' || at === 0) return null;
  const n = Number(at);
  if (!Number.isFinite(n) || n <= now) throw httpError(400, 'The end date must be in the future.');
  return Math.round(n);
}
function normalizeShare(s) {
  if (!s || !ID_RE.test(String(s.id || '')) || !ROLES.includes(s.role) || !s.path || !s.createdBy) return null;
  return { id: s.id, kind: 'file', path: String(s.path), title: String(s.title || path.basename(String(s.path))).slice(0, 200), role: s.role,
    createdBy: String(s.createdBy), createdAt: Number(s.createdAt) || 0, expiresAt: Number(s.expiresAt) || null,
    revokedAt: Number(s.revokedAt) || null, changedAt: Number(s.changedAt) || null, gen: Math.max(1, Number(s.gen) || 1),
    opens: Number(s.opens) || 0, lastOpenAt: Number(s.lastOpenAt) || null };
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// ---- the gate on the preview address -----------------------------------------
// deps: {
//   store, collab,
//   resolve(share) → { abs, owner: { name } }   throws { status } when the
//       file is gone or its maker may no longer share it (re-checked always)
//   limiter (authguard.createLimiter), clientAddress(req),
//   isSecure(req), serveFile(req, res, { abs, stat }, mime, opts), mimeOf(file),
//   staticFile(name) → { body, type } | null   (the page's own files)
//   acceptWebSocket, refuseUpgrade, log(msg)
// }
function createShareGate(deps) {
  const live = new Map(); // share id → Set(conn)
  let liveTotal = 0;
  const cookieName = id => 'chattering_share_' + id;
  const cookieOf = (req, id) => {
    const want = cookieName(id) + '=';
    for (const part of String(req.headers.cookie || '').split(';')) {
      const p = part.trim();
      if (p.startsWith(want)) return p.slice(want.length);
    }
    return '';
  };
  const strict = () => ({
    'Content-Security-Policy': ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:",
      "font-src 'self' data:", "connect-src 'self'", "media-src 'self' data: blob:", "worker-src 'self' blob:", "frame-src 'self'", "object-src 'none'",
      "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; '),
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  });
  const send = (res, status, body, type = 'text/plain; charset=utf-8', extra = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.writeHead(status, { ...strict(), 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...extra });
    res.end(buf);
  };
  const json = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);
  // Browsers say who started a request; a share's actions are started by its
  // own page only (not another site's form or script).
  const sameOrigin = req => { const s = req.headers['sec-fetch-site']; return !s || s === 'same-origin' || s === 'none'; };
  async function readBody(req, max = 4096) {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > max) throw httpError(413, 'Too large'); }
    try { return JSON.parse(body || '{}'); } catch { throw httpError(400, 'Bad request'); }
  }
  // What the page may know about the share: never the path on this computer.
  async function view(share, visitorId) {
    const r = await deps.resolve(share);
    return { id: share.id, title: share.title, role: share.role, kind: share.kind, expiresAt: share.expiresAt,
      owner: { name: r.owner && r.owner.name || 'Someone' }, visitor: visitorId, fileName: path.basename(r.abs) };
  }
  function session(req, id) { return deps.store.readSession(id, cookieOf(req, id)); }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://share.invalid');
    if (u.pathname.startsWith('/_c/share/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'Read-only'); return true; }
      const f = deps.staticFile(u.pathname.slice('/_c/share/'.length));
      if (!f) { send(res, 404, 'Not found'); return true; }
      res.writeHead(200, { ...strict(), 'Content-Type': f.type, 'Content-Length': f.body.length, 'Cache-Control': f.cache || 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : f.body);
      return true;
    }
    const m = /^\/s\/([^/]*)(\/.*)?$/.exec(u.pathname);
    if (!m) return false;
    const id = m[1], rest = m[2] || '';
    try {
      if (!ID_RE.test(id)) { send(res, 404, 'Not found'); return true; }
      if (!rest) { res.writeHead(308, { Location: '/s/' + id + '/', 'Cache-Control': 'no-store', ...strict() }); res.end(); return true; }
      // The page: the same bytes for every share, known or not, so the
      // address alone tells nobody whether a share exists.
      if (rest === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
        const f = deps.staticFile('page.html');
        res.writeHead(200, { ...strict(), 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': f.body.length, 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : f.body);
        return true;
      }
      if (rest === '/open' && req.method === 'POST') {
        if (!sameOrigin(req)) { json(res, 403, { error: 'This link opens from its own page.' }); return true; }
        const ip = deps.clientAddress(req);
        const gate = deps.limiter.check(ip);
        if (!gate.ok) { json(res, 429, { error: 'Too many wrong links from your network. Try again in ' + Math.ceil(gate.retryAfterMs / 60000) + ' minutes.' }, { 'Retry-After': String(Math.ceil(gate.retryAfterMs / 1000)) }); return true; }
        if (gate.slowMs) await new Promise(r => setTimeout(r, gate.slowMs));
        const body = await readBody(req);
        // A page reloaded without its '#' part still has its session.
        const had = session(req, id);
        let share = null, visitorId = '';
        if (body.secret) {
          share = deps.store.verifySecret(id, body.secret);
          if (!share) { deps.limiter.fail(ip, Date.now(), id + ':' + body.secret); json(res, 404, { error: 'This link does not open anything. It may have been turned off, replaced by a new one, or copied incompletely.' }); return true; }
          deps.limiter.succeed(ip);
          visitorId = had && had.share.id === share.id ? had.visitorId : '';
        } else if (had) { share = had.share; visitorId = had.visitorId; }
        else { json(res, 401, { error: 'This page needs the whole link, including the part after #.' }); return true; }
        let v;
        try { v = await view(share, visitorId); }
        catch (e) { json(res, e.status || 410, { error: e.message }); return true; }
        const issued = deps.store.issueSession(share, visitorId || undefined);
        v.visitor = issued.visitorId;
        if (!had) deps.store.noteOpen(share);
        const cookie = [cookieName(id) + '=' + issued.value, 'Path=/s/' + id + '/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=' + Math.floor(SESSION_MS / 1000)];
        if (deps.isSecure(req)) cookie.push('Secure');
        json(res, 200, v, { 'Set-Cookie': cookie.join('; ') });
        return true;
      }
      const sess = session(req, id);
      if (!sess) { json(res, 401, { error: 'This link was turned off or replaced.' }); return true; }
      if (rest === '/asset' && (req.method === 'GET' || req.method === 'HEAD')) {
        await asset(req, res, sess.share, u.searchParams.get('src') || '');
        return true;
      }
      send(res, 404, 'Not found');
      return true;
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong on the computer sharing this.' });
      else try { res.end(); } catch {}
      if (!e.status) deps.log('[shares] ' + e.message);
      return true;
    }
  }

  // Pictures the document shows, and the pages a notebook's runs saved
  // (```output displays: <iframe class="rat-output" src="_assets/generated/…">):
  // only in the document's own folder or below it, never through a link that
  // leads elsewhere; a page only from an _assets/generated folder, and always
  // sandboxed (its own origin: it cannot reach the visitor's session, this
  // page, or the cookies, whatever the document's text says).
  async function asset(req, res, share, src) {
    const r = await deps.resolve(share);
    const raw = String(src).split('#')[0].split('?')[0];
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') || raw.includes('\0') || raw.includes('\\')) throw httpError(404, 'Not found');
    let rel;
    try { rel = decodeURIComponent(raw); } catch { throw httpError(400, 'Bad path'); }
    const dir = await fs.promises.realpath(path.dirname(r.abs));
    const want = path.resolve(dir, rel);
    const ext = path.extname(want).toLowerCase();
    const display = DISPLAY_EXT.has(ext);
    if (!IMAGE_EXT.has(ext) && !display) throw httpError(404, 'Only pictures and saved results are shared with a document.');
    let real, stat;
    try { real = await fs.promises.realpath(want); stat = await fs.promises.stat(real); } catch { throw httpError(404, 'Not found'); }
    if (!(real === dir || real.startsWith(dir + path.sep)) || !stat.isFile()) throw httpError(404, 'Not found');
    if (display && !path.relative(dir, real).split(path.sep).slice(0, -1).join('/').match(/(^|\/)_assets\/generated$/)) throw httpError(404, 'Not found');
    if (stat.size > ASSET_MAX) throw httpError(413, 'This picture is too large to share.');
    const headers = { ...strict(), 'Cache-Control': 'private, no-cache' };
    // An SVG opened on its own runs no script (the policy above), and is
    // sandboxed besides.
    if (path.extname(real).toLowerCase() === '.svg') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    // A saved result runs its scripts, in a sandbox with an origin of its own,
    // framed by this page only. It may load libraries from the web, as it
    // does in Chattering.
    if (display) {
      headers['Content-Security-Policy'] = "sandbox allow-scripts; frame-ancestors 'self'";
      delete headers['X-Frame-Options'];
    }
    return deps.serveFile(req, res, { abs: real, stat }, deps.mimeOf(real), { maxBytes: ASSET_MAX, headers });
  }

  // ws(s)://<preview>/s/<id>/collab?name=… : the shared text of the file.
  async function upgrade(req, socket, head) {
    const u = new URL(req.url, 'http://share.invalid');
    const m = /^\/s\/([a-z2-7]{16})\/collab$/.exec(u.pathname);
    if (!m) return false;
    const id = m[1];
    const refuse = (s, t) => { deps.refuseUpgrade(socket, s, t); return true; };
    // A page of another site cannot open this socket with the visitor's cookie.
    const origin = String(req.headers.origin || '');
    const host = String(req.headers.host || '');
    if (!origin || !host || (origin !== 'https://' + host && origin !== 'http://' + host)) return refuse(403, 'Forbidden');
    const sess = session(req, id);
    if (!sess) return refuse(401, 'Unauthorized');
    const share = sess.share;
    let r;
    try { r = await deps.resolve(share); } catch (e) { return refuse(e.status || 410, 'Gone'); }
    const set = live.get(id) || new Set();
    if (set.size >= MAX_LIVE_PER_SHARE || liveTotal >= MAX_LIVE_TOTAL) return refuse(503, 'Service Unavailable');
    let initialText = '';
    const name = 'file:' + r.abs;
    if (!deps.collab.has(name)) {
      try { initialText = await fs.promises.readFile(r.abs, 'utf8'); } catch { return refuse(404, 'Not Found'); }
      if (initialText.includes('\0')) return refuse(415, 'Unsupported Media Type');
    }
    const conn = deps.acceptWebSocket(req, socket, head, { maxPayload: MESSAGE_MAX });
    if (!conn) return true;
    set.add(conn); live.set(id, set); liveTotal++;
    const unwatch = watchFile(r.abs);
    conn.on('close', () => { if (set.delete(conn)) liveTotal--; if (!set.size) live.delete(id); unwatch(); });
    const visitor = sess.visitorId || 'anon';
    const user = { id: 'link:' + id + ':' + visitor, name: cleanVisitorName(u.searchParams.get('name')) + ' (via link)', glyph: cleanVisitorName(u.searchParams.get('name')).slice(0, 1).toUpperCase(), color: visitorColor(visitor), via: 'link' };
    conn.shareId = id;
    deps.collab.join(conn, name, { user, canWrite: share.role === 'edit', initialText, pinUser: true, budget: makeBudget() });
    return true;
  }
  // While visitors are connected, the file is watched on its own: a write on
  // disk (an agent, git, another editor) reaches them as one minimal edit,
  // whether or not the rest of Chattering watches that folder. The folder is
  // watched, not the file, because editors replace files by renaming.
  const watchers = new Map(); // abs → { watcher, refs, timer }
  function watchFile(abs) {
    let w = watchers.get(abs);
    if (!w) {
      w = { refs: 0, timer: null, watcher: null };
      const name = path.basename(abs);
      const read = () => fs.promises.readFile(abs, 'utf8').then(text => { if (!text.includes('\0')) deps.collab.fromDisk('file:' + abs, text); }).catch(() => {});
      try {
        w.watcher = fs.watch(path.dirname(abs), { persistent: false }, (ev, file) => {
          if (file && String(file) !== name) return;
          clearTimeout(w.timer);
          w.timer = setTimeout(read, 120);
        });
        w.watcher.on('error', () => {});
      } catch (e) { deps.log('[shares] cannot watch ' + abs + ': ' + e.message); }
      watchers.set(abs, w);
    }
    w.refs++;
    let done = false;
    return () => {
      if (done) return; done = true;
      if (--w.refs > 0) return;
      clearTimeout(w.timer);
      try { w.watcher && w.watcher.close(); } catch {}
      watchers.delete(abs);
    };
  }
  // Close every live connection of a share: revoked, expired, its link
  // replaced, or its role changed (they reconnect with the new role, or not).
  function closeShare(id, why = 'this link changed') {
    const set = live.get(id);
    if (!set) return 0;
    let n = 0;
    for (const c of [...set]) { try { c.close(4403, why); n++; } catch {} }
    return n;
  }
  function liveCount(id) { return (live.get(id) || new Set()).size; }
  // Called every minute: a share that expired, or whose maker lost the
  // right to it, closes its live connections too, not only new requests.
  async function sweep() {
    for (const id of [...live.keys()]) {
      const s = deps.store.active(id);
      if (!s) { closeShare(id, 'this link has ended'); continue; }
      try { await deps.resolve(s); } catch { closeShare(id, 'this link has ended'); }
    }
  }
  return { handle, upgrade, closeShare, liveCount, sweep };
}
function makeBudget({ bytes = BUDGET.bytes, perMs = BUDGET.perMs } = {}) {
  let start = Date.now(), used = 0;
  return { take(n) { const now = Date.now(); if (now - start > perMs) { start = now; used = 0; } used += n; return used <= bytes; } };
}

module.exports = { ShareStore, createShareGate, newShareId, cleanVisitorName, visitorColor, makeBudget, ID_RE, ROLES, MESSAGE_MAX };
