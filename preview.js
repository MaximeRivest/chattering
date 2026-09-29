'use strict';
// The preview origin (design/67). A second listener serves what agents make —
// web pages, slides, widgets — on an address that is not the app's, so a page
// may run every script it wants without acting as the person inside
// Chattering. It reads no cookies. Its only authority is a signed capability
// naming one person, one conversation and one folder; the server re-checks
// that person's access on every request.
//
// Routes:
//   /_c/proxy.html      MCP Apps sandbox proxy (spec 2026-01-26, "Sandbox proxy")
//   /_c/kit.js          the view side: handshake, theme, size, links, window.chattering
//   /_c/types/<t>.html  viewers for typed artifacts (slides)
//   /a/<cap>/<version>/<path>   a file of an artifact, live from disk or from a version
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');

const PROTOCOL_VERSION = '2026-01-26';
const LIBRARY_HOSTS = ['https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://esm.sh', 'https://cdnjs.cloudflare.com',
  'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https://cdn.tailwindcss.com'];
const FILE_MAX = 64 * 1024 * 1024;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
  '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.webmanifest': 'application/manifest+json',
};
const mimeOf = file => TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
const inside = (root, p) => p === root || p.startsWith(root + path.sep);
const b64 = buf => Buffer.from(buf).toString('base64url');

// ---- capabilities: stateless, signed, re-authorised on use ----------------
// Stateless so a link keeps working across restarts and in history; the
// person's current access is checked on every request, so revoking access or
// hiding a project still takes effect at once.
class Capabilities {
  constructor(secretFile) {
    let secret = null;
    try { secret = Buffer.from(fs.readFileSync(secretFile, 'utf8').trim(), 'hex'); } catch {}
    if (!secret || secret.length < 32) {
      secret = crypto.randomBytes(32);
      fs.mkdirSync(path.dirname(secretFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(secretFile, secret.toString('hex') + '\n', { mode: 0o600 });
    }
    this.secret = secret;
  }
  sign(claims, ttlMs = 30 * 24 * 3600e3) {
    const body = b64(JSON.stringify({ ...claims, v: 1, x: Date.now() + ttlMs }));
    return body + '.' + b64(crypto.createHmac('sha256', this.secret).update(body).digest());
  }
  verify(token) {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) throw httpError(404, 'Unknown preview');
    const want = crypto.createHmac('sha256', this.secret).update(body).digest();
    const got = Buffer.from(mac, 'base64url');
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw httpError(404, 'Unknown preview');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (claims.v !== 1 || !(claims.x > Date.now())) throw httpError(410, 'This preview link expired. Open the artifact again from its conversation.');
    return claims;
  }
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// A short, stable name for an artifact: its own browser site on *.localhost
// and on a public preview domain (one per artifact, design/67).
function siteId(key, root) { return crypto.createHash('sha256').update(String(key) + '\0' + String(root)).digest('hex').slice(0, 20); }

// ---- content security policy ----------------------------------------------
// Trust is the default (Maxime, 2026-09-23): pages may load and call
// anything. "libraries" narrows scripts, styles, fonts and network calls to
// the public library sites Claude and ChatGPT allow. Either way: no plugins,
// and only Chattering itself may frame a preview.
function contentPolicy(network = 'open', ancestors = []) {
  const frameAncestors = ["'self'", ...ancestors].join(' ');
  if (network === 'libraries') {
    const libs = LIBRARY_HOSTS.join(' ');
    return [`default-src 'self' data: blob:`, `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: ${libs}`,
      `style-src 'self' 'unsafe-inline' ${libs}`, `font-src 'self' data: ${libs}`, `img-src 'self' data: blob: https:`,
      `media-src 'self' data: blob: https:`, `connect-src 'self' ${libs}`, `worker-src 'self' blob:`, `frame-src 'self' blob: data:`,
      `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors ${frameAncestors}`].join('; ');
  }
  return [`default-src * data: blob: 'unsafe-inline' 'unsafe-eval'`, `script-src * data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`,
    `style-src * data: blob: 'unsafe-inline'`, `img-src * data: blob:`, `font-src * data:`, `connect-src * data: blob:`,
    `media-src * data: blob:`, `worker-src * data: blob:`, `frame-src * data: blob:`, `object-src 'none'`, `base-uri 'self'`,
    `frame-ancestors ${frameAncestors}`].join('; ');
}

// ---- the view side, served to every artifact --------------------------------
// A minimal MCP Apps view client with no dependencies. Pages written by an
// agent get it for free: host theme as the standard CSS variables, their size
// reported to the host, external links opened by the host, and
// window.chattering for a few host actions.
const KIT = `(() => {
  if (window.__chatteringKit || window.parent === window) return;
  window.__chatteringKit = true;
  const root = document.documentElement;
  let seq = 0, ctx = {}, lastW = 0, lastH = 0, frame = 0;
  const pending = new Map();
  const post = m => window.parent.postMessage(Object.assign({ jsonrpc: '2.0' }, m), '*');
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = 'kit-' + (++seq); pending.set(id, { resolve, reject }); post({ id, method, params });
  });
  const notify = (method, params) => post({ method, params: params || {} });
  const apply = c => {
    if (!c) return;
    ctx = Object.assign({}, ctx, c);
    const vars = c.styles && c.styles.variables;
    if (vars) for (const k in vars) if (vars[k] != null) root.style.setProperty(k, vars[k]);
    const fonts = c.styles && c.styles.css && c.styles.css.fonts;
    if (fonts && !document.getElementById('chattering-fonts')) { const s = document.createElement('style'); s.id = 'chattering-fonts'; s.textContent = fonts; (document.head || root).appendChild(s); }
    if (c.theme) { root.dataset.theme = c.theme; root.style.colorScheme = c.theme; }
    if (c.displayMode) root.dataset.displayMode = c.displayMode;
    if (c.platform) root.dataset.platform = c.platform;
    window.dispatchEvent(new CustomEvent('chattering:context', { detail: ctx }));
  };
  window.addEventListener('message', e => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id != null && !m.method && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || 'The host refused')); else p.resolve(m.result);
      return;
    }
    if (m.method === 'ui/notifications/host-context-changed') apply(m.params);
    else if (m.method === 'ui/resource-teardown' && m.id != null) post({ id: m.id, result: {} });
    else if (m.method === 'ping' && m.id != null) post({ id: m.id, result: {} });
    if (m.method) window.dispatchEvent(new CustomEvent('chattering:message', { detail: m }));
  });
  const measure = () => {
    frame = 0;
    const b = document.body;
    const h = Math.ceil(Math.max(root.scrollHeight, b ? b.scrollHeight : 0));
    const w = Math.ceil(Math.max(root.scrollWidth, b ? b.scrollWidth : 0));
    if (h === lastH && w === lastW) return;
    lastH = h; lastW = w;
    notify('ui/notifications/size-changed', { width: w, height: h });
  };
  const watchSize = () => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (!frame) frame = requestAnimationFrame(measure); });
    ro.observe(root); if (document.body) ro.observe(document.body);
    measure();
  };
  document.addEventListener('click', e => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented) return;
    let url; try { url = new URL(a.getAttribute('href'), location.href); } catch { return; }
    if (!/^https?:$/.test(url.protocol) || url.origin === location.origin) return;
    e.preventDefault();
    request('ui/open-link', { url: url.href }).catch(() => window.open(url.href, '_blank', 'noopener'));
  }, true);
  const ready = request('ui/initialize', {
    appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    clientInfo: { name: 'chattering-artifact', version: '1' }, protocolVersion: '${PROTOCOL_VERSION}',
  }).then(r => {
    apply(r && r.hostContext);
    notify('ui/notifications/initialized', {});
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchSize, { once: true }); else watchSize();
    return r;
  });
  ready.catch(() => {});
  window.chattering = {
    ready,
    context: () => ctx,
    sendMessage: text => request('ui/message', { role: 'user', content: { type: 'text', text: String(text) } }),
    openLink: url => request('ui/open-link', { url: String(url) }),
    requestDisplayMode: mode => request('ui/request-display-mode', { mode }),
  };
})();
`;

// The MCP Apps sandbox proxy: it must live on a different origin than the
// host, receive the page's HTML from the host, load it in an inner frame
// under the policy, and relay every message that is not a sandbox- message.
// It accepts the host only from the origin named in its own URL.
function proxyPage(hostOrigin) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Chattering sandbox</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}iframe{border:0;display:block;width:100%;height:100%;background:transparent}</style></head><body>
<script>(() => {
  const HOST = ${JSON.stringify(hostOrigin)};
  const host = window.parent;
  let inner = null;
  const esc = s => String(s).replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));
  const policy = csp => {
    if (!csp) return '';
    const list = a => (Array.isArray(a) ? a : []).filter(x => /^https?:\\/\\/[^\\s;'"]+$/.test(x)).join(' ');
    const res = list(csp.resourceDomains), con = list(csp.connectDomains), fr = list(csp.frameDomains), base = list(csp.baseUriDomains);
    return ["default-src 'self' data: blob:", "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: " + res,
      "style-src 'self' 'unsafe-inline' " + res, "img-src 'self' data: blob: " + res, "font-src 'self' data: " + res,
      "media-src 'self' data: blob: " + res, "connect-src 'self' " + con, fr ? 'frame-src ' + fr : "frame-src 'none'",
      "object-src 'none'", base ? 'base-uri ' + base : "base-uri 'self'"].join('; ');
  };
  const load = p => {
    let html = String(p.html || '');
    const head = '<script src="/_c/kit.js"><\\/script>' + (p.csp ? '<meta http-equiv="Content-Security-Policy" content="' + esc(policy(p.csp)) + '">' : '');
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, m => m + head);
    else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, m => m + '<head>' + head + '</head>');
    else html = '<!doctype html><html><head><meta charset="utf-8">' + head + '</head><body>' + html + '</body></html>';
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', typeof p.sandbox === 'string' ? p.sandbox : 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-pointer-lock');
    const perms = p.permissions || {}, allow = ['fullscreen'];
    if (perms.camera) allow.push('camera'); if (perms.microphone) allow.push('microphone');
    if (perms.geolocation) allow.push('geolocation'); if (perms.clipboardWrite) allow.push('clipboard-write');
    f.setAttribute('allow', allow.join('; '));
    f.title = 'artifact';
    f.srcdoc = html;
    if (inner) inner.remove();
    inner = f;
    document.body.appendChild(f);
  };
  window.addEventListener('message', e => {
    const m = e.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (e.source === host) {
      if (e.origin !== HOST) return;
      if (m.method === 'ui/notifications/sandbox-resource-ready') return load(m.params || {});
      if (typeof m.method === 'string' && m.method.indexOf('ui/notifications/sandbox-') === 0) return;
      if (inner && inner.contentWindow) inner.contentWindow.postMessage(m, '*');
    } else if (inner && e.source === inner.contentWindow) {
      if (typeof m.method === 'string' && m.method.indexOf('ui/notifications/sandbox-') === 0) return;
      host.postMessage(m, HOST);
    }
  });
  host.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, HOST);
})();</script></body></html>`;
}

// Put the kit into an HTML document (served files; widgets get it from the proxy).
function withKit(html) {
  const tag = '<script src="/_c/kit.js"></script>';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => m + tag);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, m => m + '<head>' + tag + '</head>');
  return tag + html;
}

// ---- the handler -------------------------------------------------------------
// deps: { caps, store, authorize(claims, abs), network(), ancestors(), typeViewer(name) }
function createPreviewHandler(deps) {
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  const common = () => ({ 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': contentPolicy(deps.network(), deps.ancestors()) });
  return async function handle(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Previews are read-only', { Allow: 'GET, HEAD' });
      const u = new URL(req.url, 'http://preview.invalid');
      if (u.pathname === '/_c/kit.js') {
        return send(res, 200, req.method === 'HEAD' ? '' : KIT, { ...common(), 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      }
      if (u.pathname === '/_c/proxy.html') {
        const hostOrigin = u.searchParams.get('host') || '';
        if (!/^https?:\/\/[^/\s]+$/.test(hostOrigin) || !deps.ancestors().some(a => a === hostOrigin || (a.includes('*') && new RegExp('^' + a.replace(/[.]/g, '\\.').replace('*', '[^.]+') + '$').test(hostOrigin)))) {
          return send(res, 403, 'This sandbox only serves Chattering.');
        }
        return send(res, 200, req.method === 'HEAD' ? '' : proxyPage(hostOrigin), { ...common(), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      }
      const m = /^\/a\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/(live|[a-f0-9]{64})\/(.*)$/.exec(u.pathname);
      if (!m) return send(res, 404, 'Not found');
      const claims = deps.caps.verify(m[1]);
      const version = m[2];
      let rel = decodeURIComponent(m[3] || '');
      if (rel.includes('\0') || rel.includes('\\') || path.isAbsolute(rel) || rel.split('/').includes('..')) throw httpError(400, 'Invalid path');
      const root = claims.r;
      if (!rel || rel.endsWith('/')) rel += claims.e && !rel ? claims.e : 'index.html';
      const abs = path.resolve(root, rel);
      if (!inside(root, abs)) throw httpError(400, 'Outside the artifact');
      await deps.authorize(claims, abs);
      // The artifact root of a typed artifact (slides) is its viewer, when the
      // folder has no page of its own.
      let found = await readVersion(deps.store, claims, version, abs);
      if (!found && claims.t && (rel === 'index.html' || rel === claims.e) && deps.typeViewer(claims.t)) {
        found = { bytes: Buffer.from(deps.typeViewer(claims.t)), mime: 'text/html; charset=utf-8', immutable: false, source: 'viewer' };
      }
      if (!found) return send(res, 404, 'This file is not in this version of the artifact.', common());
      const headers = { ...common(), 'X-Chattering-Source': found.source,
        'Cache-Control': found.immutable ? 'private, max-age=31536000, immutable' : 'no-cache' };
      if (found.stream) {
        return deps.serveFile(req, res, found.stream, found.mime, { maxBytes: FILE_MAX, headers });
      }
      let body = found.bytes;
      if (found.mime.startsWith('text/html')) body = Buffer.from(withKit(body.toString('utf8')));
      res.writeHead(200, { ...headers, 'Content-Type': found.mime, 'Content-Length': body.length,
        ETag: '"' + crypto.createHash('sha1').update(body).digest('hex') + '"' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (e) {
      send(res, e.status || 500, e.status ? e.message : 'The preview failed: ' + e.message);
    }
  };
}

// Live: the file on disk (HTML read to add the kit; everything else streamed
// with ranges). A version: the exact bytes captured then; a file the version
// could not capture (older than its folder's declaration) falls back to disk
// and says so in X-Chattering-Source.
async function readVersion(store, claims, version, abs) {
  const live = async source => {
    let real;
    try { real = await fsp.realpath(abs); } catch { return null; }
    if (!inside(claims.r, real)) return null;
    const stat = await fsp.stat(real);
    if (!stat.isFile()) return null;
    if (stat.size > FILE_MAX) throw httpError(413, 'This file is over 64 MB');
    const mime = mimeOf(real);
    if (mime.startsWith('text/html')) return { bytes: await fsp.readFile(real), mime, immutable: false, source };
    return { stream: { abs: real, stat }, mime, immutable: false, source };
  };
  if (version === 'live') return live('live');
  const snap = await store.snapshot(version);
  if (!inside(snap.root, claims.r) && !inside(claims.r, snap.root)) throw httpError(404, 'That version belongs to another workspace');
  const rel = path.relative(snap.root, abs).split(path.sep).join('/');
  const item = snap.manifest.find(f => f.path === rel);
  if (item && item.oid) return { bytes: await store.blob(snap.root, item.oid), mime: mimeOf(abs), immutable: true, source: 'version' };
  if (item && item.unavailable) return live('live-fallback');
  return null;
}

module.exports = { Capabilities, createPreviewHandler, contentPolicy, proxyPage, withKit, siteId, mimeOf, KIT, PROTOCOL_VERSION, LIBRARY_HOSTS };
