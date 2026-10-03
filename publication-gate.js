'use strict';
// A publication at its own address (design/92): <slug>.<name>.rockfrog.site
// on the internet, <slug>.pub.localhost on this computer. Each is its own
// web origin, so a page an agent wrote can run any script it likes without
// reaching a shared document, a conversation, another publication, or
// Chattering: that is the whole reason for one address per publication.
//
// What answers at a publication's address, and nothing else:
//   /…                                      its files, from the frozen copy (the current version)
//   /_v/<fingerprint>/…                     the files of one exact version (unchanging)
//   /.well-known/chattering-publication.json  its manifest, fingerprint, signature and signer:
//                                           what `node publications.js <url>` checks
//   /_chattering/open, /_chattering/open.js  proving a link ("anyone with the link")
//   /_chattering/program                    a program: what this computer offers it now
//   POST / or /_chattering/run              a program, paid by its owner (when they chose to)
//   POST /_chattering/calls                 a program: a call a visitor chose to share
//
// Access: "public" (anyone at the address) or "link" (the address plus the
// secret after '#k=', proved once for a cookie of this address only).
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const SESSION_MS = 30 * 24 * 3600e3;
const BODY_MAX = 256 * 1024;
const RECORD_MAX = 512 * 1024;

function createPublicationGate(deps) {
  const send = (res, status, body, type, headers = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(buf);
  };
  const json = (res, status, obj, headers = {}) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store', ...headers });
  const cookieName = (share, secure) => secure ? '__Host-chattering_pub' : 'chattering_pub_' + share.id;
  function session(req, share) {
    const names = new Set([cookieName(share, true), cookieName(share, false)]);
    for (const part of String(req.headers.cookie || '').split(';')) {
      const p = part.trim(), eq = p.indexOf('=');
      if (eq < 0 || !names.has(p.slice(0, eq))) continue;
      const s = deps.store.readSession(share.id, p.slice(eq + 1));
      if (s) return s;
    }
    return null;
  }
  async function readBody(req, max) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > max) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
    return Buffer.concat(chunks).toString('utf8');
  }

  // The policy every answer of a program's page carries: its own scripts
  // only, and network calls only to this address and to the AI providers its
  // page offers (from the frozen copy's providers.json): a key typed into
  // the page can go to its provider, and to nothing else.
  function programPolicy(share, manifest) {
    let origins = [];
    try { origins = JSON.parse(fs.readFileSync(deps.pubStore.blobPath(manifest.files['providers.json'].sha256), 'utf8')).map(p => p.origin).filter(o => /^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(o)); } catch {}
    if (deps.extraConnect) origins = origins.concat(deps.extraConnect());
    return ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
      "connect-src 'self' " + origins.join(' '), "worker-src 'self' blob:", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
      "frame-ancestors " + (share.access === 'public' ? '*' : "'self'")].join('; ');
  }
  function common(share, manifest) {
    const h = { 'Referrer-Policy': share.access === 'public' ? 'strict-origin-when-cross-origin' : 'no-referrer', 'X-Chattering-Fingerprint': share.root };
    if (share.access !== 'public') h['X-Robots-Tag'] = 'noindex, nofollow';
    h['Content-Security-Policy'] = share.type === 'program' ? programPolicy(share, manifest) : 'frame-ancestors ' + (share.access === 'public' ? '*' : "'self'");
    return h;
  }

  // "Anyone with the link": the page that proves it, then reloads.
  const OPEN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Opening…</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#111412;color:#dce3dd}main{max-width:420px;padding:24px}h1{font-size:18px;margin:0 0 8px}p{color:#98a29a;margin:0}</style>
</head><body><main id="m"><p>Opening…</p></main><script src="/_chattering/open.js"></script></body></html>`;
  const OPEN_JS = `(async () => {
  const m = document.getElementById('m');
  const say = (t, p) => { m.innerHTML = '<h1></h1><p></p>'; m.querySelector('h1').textContent = t; m.querySelector('p').textContent = p; };
  const k = /^#k=([A-Za-z0-9_-]{22})/.exec(location.hash);
  if (!k) return say('This page needs the whole link', 'It was shared with a secret part after #k=. Ask for the link again.');
  try {
    const r = await fetch('/_chattering/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: k[1] }), credentials: 'same-origin' });
    if (r.ok) { location.replace(location.pathname + location.search); return; }
    const e = await r.json().catch(() => ({}));
    say('This link does not open', e.error || 'It may have been turned off or replaced.');
  } catch { say('The computer sharing this is not reachable', 'It is online when its owner\\u2019s computer is. Try again later.'); }
})();`;

  async function handle(req, res, share) {
    const u = new URL(req.url, 'http://publication.invalid');
    const p = u.pathname;
    const get = req.method === 'GET' || req.method === 'HEAD';
    try {
      await deps.resolve(share);
      if (p === '/_chattering/open.js' && get) return send(res, 200, OPEN_JS, 'text/javascript; charset=utf-8', { 'Cache-Control': 'no-cache' });
      if (p === '/_chattering/open' && req.method === 'POST') {
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin' && site !== 'none') return json(res, 403, { error: 'This link opens from its own page.' });
        const ip = deps.clientAddress(req);
        const gate = deps.limiter.check(ip);
        if (!gate.ok) return json(res, 429, { error: 'Too many wrong links from your network. Try again later.' });
        let body = {};
        try { body = JSON.parse(await readBody(req, 4096) || '{}'); } catch {}
        const ok = deps.store.verifySecret(share.id, body.secret);
        if (!ok) { deps.limiter.fail(ip, Date.now(), share.id + ':' + body.secret); return json(res, 404, { error: 'This link does not open anything. It may have been turned off or replaced.' }); }
        deps.limiter.succeed(ip);
        const issued = deps.store.issueSession(share);
        deps.store.noteOpen(share);
        const secure = deps.isSecure(req);
        const cookie = [cookieName(share, secure) + '=' + issued.value, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + Math.floor(SESSION_MS / 1000)];
        if (secure) cookie.push('Secure');
        return json(res, 200, { ok: true }, { 'Set-Cookie': cookie.join('; ') });
      }
      if (share.access === 'link' && !session(req, share)) {
        if (get && /text\/html/.test(String(req.headers.accept || '')) && !p.startsWith('/_chattering/'))
          return send(res, 200, OPEN_PAGE, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
        return json(res, 401, { error: 'This publication opens with its link.' });
      }
      const manifest = deps.pubStore.manifest(share.root);
      if (!manifest) return send(res, 410, 'This publication is gone.');
      if (p === '/.well-known/chattering-publication.json' && get) {
        const v = share.versions.find(x => x.root === share.root) || {};
        return json(res, 200, { manifest, root: share.root, signature: v.sig || null, signer: await deps.signer(), publishedAt: v.at ? new Date(v.at).toISOString() : null }, { 'Access-Control-Allow-Origin': share.access === 'public' ? '*' : 'null' });
      }
      if (share.type === 'program') {
        if (p === '/_chattering/program' && get) return json(res, 200, await deps.program.info(share));
        if (p === '/_chattering/calls' && req.method === 'POST') {
          const site = req.headers['sec-fetch-site'];
          if (site && site !== 'same-origin') return json(res, 403, { error: 'From this page only.' });
          let rec;
          try { rec = JSON.parse(await readBody(req, RECORD_MAX)); } catch (e) { return json(res, e.status || 400, { error: 'The call is not readable.' }); }
          return json(res, 200, await deps.program.acceptCall(share, rec, deps.clientAddress(req)));
        }
        if ((p === '/_chattering/run' || p === '/') && req.method === 'POST') {
          let inputs;
          try { inputs = JSON.parse(await readBody(req, BODY_MAX) || '{}'); } catch (e) { return json(res, e.status || 400, { error: e.status === 413 ? 'The inputs are at most 256 KiB.' : 'The body is not JSON.', code: 'bad-json' }); }
          return deps.program.run(share, inputs, { req, res, ip: deps.clientAddress(req) });
        }
        if (p === '/' && get && !/text\/html/.test(String(req.headers.accept || '')) && /json/.test(String(req.headers.accept || '')))
          return json(res, 200, await deps.program.describe(share, manifest));
      }
      if (!get) return send(res, 405, 'Read-only.', null, { Allow: 'GET, HEAD' });
      // A file: of one exact version, or of the current one.
      let root = share.root, m = manifest, rel = p;
      const pinned = /^\/_v\/([0-9a-f]{64})(\/.*)?$/.exec(p);
      if (pinned) {
        if (!share.versions.some(v => v.root === pinned[1])) return send(res, 404, 'Not a version of this publication.');
        root = pinned[1]; m = deps.pubStore.manifest(root); rel = pinned[2] || '/';
        if (!m) return send(res, 410, 'This version is gone.');
      }
      let name;
      try { name = decodeURIComponent(rel).replace(/^\/+/, ''); } catch { return send(res, 400, 'Bad address.'); }
      if (!name || name.endsWith('/')) name += name ? 'index.html' : m.entry;
      let f = m.files[name];
      if (!f && !path.posix.extname(name) && m.files[name + '/index.html']) {
        res.writeHead(308, { Location: rel + '/', 'Cache-Control': 'no-store' }); return res.end();
      }
      const headers = common(share, m);
      if (!f) {
        const nf = m.files['404.html'];
        if (nf) return send(res, 404, fs.readFileSync(deps.pubStore.blobPath(nf.sha256)), nf.type, { ...headers, 'Cache-Control': 'no-cache' });
        return send(res, 404, 'Not found in this publication.', null, headers);
      }
      const etag = '"' + f.sha256 + '"';
      Object.assign(headers, {
        ETag: etag, 'Repr-Digest': 'sha-256=:' + Buffer.from(f.sha256, 'hex').toString('base64') + ':', 'X-Chattering-Fingerprint': root,
        'Cache-Control': pinned ? (share.access === 'public' ? 'public' : 'private') + ', max-age=31536000, immutable' : 'no-cache',
      });
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
      const abs = deps.pubStore.blobPath(f.sha256);
      return deps.serveFile(req, res, { abs, stat: fs.statSync(abs) }, f.type, { maxBytes: 64 * 1024 * 1024, headers });
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong on the computer publishing this.' });
      else try { res.end(); } catch {}
    }
  }
  return { handle };
}

module.exports = { createPublicationGate };
