'use strict';
// Read-only file delivery. Authorization belongs to the caller; an opened file
// must still have the identity that was authorized before any bytes are sent.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
});
const ASSET_TYPES = Object.freeze({ ...TYPES, '.pdf': null,
  '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
});
function mediaType(file) { return TYPES[path.extname(file).toLowerCase()] || null; }
function mediaKind(file) {
  const mime = mediaType(file);
  return mime?.startsWith('image/') ? 'image' : mime?.startsWith('video/') ? 'video' : mime === 'application/pdf' ? 'pdf' : null;
}
function byteRange(header, size) {
  if (!header || !header.startsWith('bytes=') || header.includes(',')) return null; // Ignore unsupported units/multipart.
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2]) || !size) return false;
  let start, end;
  if (!m[1]) { const suffix = Number(m[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return false; start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(m[1]); end = m[2] ? Number(m[2]) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
  return { start, end: Math.min(end, size - 1) };
}
function disposition(file, attachment = false) {
  const name = path.basename(file);
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
async function serveFile(req, res, found, mime, { download = false, maxBytes = Infinity, headers = {} } = {}) {
  const handle = await fsp.open(found.abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== found.stat.dev || stat.ino !== found.stat.ino) throw Error('The file changed while opening. Try again.');
    if (stat.size > maxBytes) throw Error('file is too large to open here');
    const etag = '"' + crypto.createHash('sha256').update([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')).digest('hex').slice(0, 32) + '"';
    const modified = stat.mtime.toUTCString();
    const common = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', ETag: etag, 'Last-Modified': modified,
      'Content-Disposition': disposition(found.abs, download), 'Cache-Control': 'private, no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "sandbox; default-src 'none'", ...headers };
    const none = String(req.headers['if-none-match'] || '');
    if (none === '*' || none.split(',').some(tag => tag.trim().replace(/^W\//, '') === etag)) {
      res.writeHead(304, common); res.end(); return;
    }
    const ifRange = req.headers['if-range'];
    const rangeAllowed = !ifRange || ifRange === etag || (!ifRange.startsWith('"') && !ifRange.startsWith('W/') && Date.parse(ifRange) === Math.floor(stat.mtimeMs / 1000) * 1000);
    const range = req.method === 'HEAD' || !rangeAllowed ? null : byteRange(req.headers.range, stat.size);
    if (range === false) { res.writeHead(416, { ...common, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 }); res.end(); return; }
    const size = range ? range.end - range.start + 1 : stat.size;
    res.writeHead(range ? 206 : 200, { ...common, 'Content-Length': size,
      ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}` } : {}) });
    if (req.method === 'HEAD' || !size) { res.end(); return; }
    // pipeline destroys the disk stream if a seeking player disconnects.
    await pipeline(handle.createReadStream({ ...(range || {}), autoClose: false }), res);
  } catch (error) {
    if (!res.headersSent) throw error;
    res.destroy();
  } finally { await handle.close(); }
}

// Opaque sandboxed HTML has no app cookies. Short-lived, unguessable capabilities
// expose only typed static assets within one authorized directory, never APIs,
// HTML, scripts, arbitrary documents or directory listings.
class PreviewAssets {
  constructor({ now = Date.now, ttl = 30 * 60 * 1000, limit = 128 } = {}) {
    this.grants = new Map(); this.now = now; this.ttl = ttl; this.limit = limit;
  }
  create(found, { authorize = null } = {}) {
    if (!/\.html?$/i.test(found.abs)) throw Error('Only HTML files have a web preview');
    this.prune();
    if (this.grants.size >= this.limit) throw Error('Too many open previews. Close another preview and try again.');
    const token = crypto.randomBytes(32).toString('hex');
    // The folder by its given name and by its real one: a resolved asset is
    // compared with the real one (macOS /var is /private/var; Windows may
    // hand out a short 8.3 name).
    const root = path.dirname(found.abs);
    let realRoot = root;
    try { realRoot = require('fs').realpathSync.native(root); } catch {}
    this.grants.set(token, { root, realRoot, expires: this.now() + this.ttl, authorize });
    return { token, base: `/api/file/preview-assets/${token}/`, expiresIn: this.ttl };
  }
  prune() { for (const [token, grant] of this.grants) if (grant.expires <= this.now()) this.grants.delete(token); }
  revoke(token) { this.grants.delete(token); }
  async resolve(token, relative) {
    const grant = this.grants.get(token);
    if (!grant || grant.expires <= this.now()) { this.grants.delete(token); throw Error('Preview expired. Refresh the preview.'); }
    if (!relative || relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative)) throw Error('Invalid preview asset path');
    const inside = (abs, root) => abs.startsWith(root + path.sep);
    const wanted = path.resolve(grant.root, relative);
    if (!inside(wanted, grant.root)) throw Error('Asset is outside the preview folder');
    const abs = await fsp.realpath(wanted);
    if (!inside(abs, grant.realRoot || grant.root)) throw Error('Asset is outside the preview folder');
    // Recheck the initiating person's current rights on each resolved asset,
    // including nested projects; a revoked login must invalidate its previews.
    if (grant.authorize) await grant.authorize(abs);
    const mime = ASSET_TYPES[path.extname(abs).toLowerCase()];
    if (!mime) throw Error('This file type is not allowed in previews');
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) throw Error('Not a regular preview asset');
    if (stat.size > 32 * 1024 * 1024) throw Error('Preview asset exceeds 32 MB');
    grant.expires = this.now() + this.ttl;
    return { abs, stat, mime };
  }
}
module.exports = { mediaType, mediaKind, byteRange, disposition, serveFile, PreviewAssets };
