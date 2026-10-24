'use strict';
// account-files.js — the files Chattering shows and saves for a person who
// runs as their own computer account (design/105).
//
// Every disk operation here goes through their host process (account-host.js),
// which runs as them: Linux decides, as for any program of theirs. This
// server only relays bytes and keeps its own records (history, ledger) of
// the text it was handed. It never opens their path with its own rights,
// so a symlink of theirs cannot aim it at anything else.
const path = require('path');
const crypto = require('crypto');
const fileMedia = require('./file-media.js');

const CHUNK = 4 * 1024 * 1024;
const sha256Hex = s => crypto.createHash('sha256').update(s).digest('hex');

function expandHome(home, raw) {
  const s = String(raw || '').trim();
  if (s === '~') return home;
  if (s.startsWith('~/')) return path.join(home, s.slice(2));
  return s;
}
// Where a path named in a conversation may be: absolute as it is, else
// against the conversation's folder (and the repository around it).
function candidates({ home, cwd, roots = [], pathValue, stripLocation = p => p }) {
  const expanded = expandHome(home, stripLocation(pathValue));
  if (!expanded) throw new Error('missing path');
  if (path.isAbsolute(expanded)) return [path.resolve(expanded)];
  if (!cwd) throw new Error('relative path without a conversation');
  return [cwd, ...roots].map(base => path.resolve(base, expanded));
}
async function locate(host, list) {
  for (const p of list) {
    try { const abs = await host.call('realpath', p); return { abs, stat: await host.call('stat', abs) }; } catch {}
  }
  throw Object.assign(new Error('file not found, or not yours to open'), { status: 404 });
}

async function info(host, list, { maxEdit }) {
  const { abs, stat } = await locate(host, list);
  if (stat.type === 'dir') return { path: abs, kind: 'directory', preview: 'none', hostActions: false };
  if (stat.type !== 'file') throw new Error('not a regular file or directory');
  const mime = fileMedia.mediaType(abs);
  let preview = fileMedia.mediaKind(abs) || 'text';
  if (!mime) {
    if (stat.size > maxEdit) preview = 'none';
    else if (stat.size) { const { data } = await host.call('read', abs, { start: 0, length: 8192 }); if (Buffer.from(data).includes(0)) preview = 'none'; }
  }
  return { path: abs, kind: 'file', preview, mime: mime || null, size: stat.size, hostActions: false };
}

async function readText(host, abs, { max }) {
  const stat = await host.call('stat', abs);
  if (stat.type !== 'file') throw new Error('not a regular file');
  if (stat.size > max) throw new Error('file is too large to open here');
  const { data } = await host.call('read', abs, { start: 0, length: max });
  const buf = Buffer.from(data);
  if (buf.subarray(0, 8192).includes(0)) throw new Error('this is a binary file');
  const text = buf.toString('utf8');
  return { path: abs, text, sha: sha256Hex(text) };
}

// Whole-text save, refused when the file changed since it was loaded.
async function saveText(host, abs, text, { baseSha = null } = {}) {
  let oldText = '', oldState = 'present';
  try { oldText = Buffer.from((await host.call('read', abs, { start: 0 })).data).toString('utf8'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; oldState = 'deleted'; }
  if (baseSha && sha256Hex(oldText) !== baseSha) throw new Error('the file changed on disk after you loaded it — reload and edit again');
  await host.call('write', abs, text);
  return { ok: true, path: abs, sha: sha256Hex(text), oldText, oldState };
}

// A file as an HTTP response, ranges and validators as file-media.js does,
// the bytes read by their host in slices.
async function serve(req, res, host, abs, mime, { download = false, maxBytes = Infinity } = {}) {
  const stat = await host.call('stat', abs);
  if (stat.type !== 'file') throw new Error('not a regular file');
  if (stat.size > maxBytes) throw new Error('file is too large to open here');
  const etag = '"' + crypto.createHash('sha256').update([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')).digest('hex').slice(0, 32) + '"';
  const common = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', ETag: etag, 'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
    'Content-Disposition': fileMedia.disposition(abs, download), 'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "sandbox; default-src 'none'" };
  const none = String(req.headers['if-none-match'] || '');
  if (none === '*' || none.split(',').some(tag => tag.trim().replace(/^W\//, '') === etag)) { res.writeHead(304, common); res.end(); return; }
  const ifRange = req.headers['if-range'];
  const rangeAllowed = !ifRange || ifRange === etag;
  const range = req.method === 'HEAD' || !rangeAllowed ? null : fileMedia.byteRange(req.headers.range, stat.size);
  if (range === false) { res.writeHead(416, { ...common, 'Content-Range': `bytes */${stat.size}`, 'Content-Length': 0 }); res.end(); return; }
  const start = range ? range.start : 0, end = range ? range.end : stat.size - 1;
  const size = stat.size ? end - start + 1 : 0;
  res.writeHead(range ? 206 : 200, { ...common, 'Content-Length': size, ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}) });
  if (req.method === 'HEAD' || !size) { res.end(); return; }
  let at = start, aborted = false;
  res.on('close', () => { aborted = true; });
  while (at <= end && !aborted) {
    const { data } = await host.call('read', abs, { start: at, length: Math.min(CHUNK, end - at + 1) });
    const buf = Buffer.from(data);
    if (!buf.length) break;
    if (!res.write(buf)) await new Promise(r => res.once('drain', r));
    at += buf.length;
  }
  res.end();
}

// The folder picker: subfolders of a folder of theirs.
async function dirs(host, base, { home, known = () => false }) {
  const entries = await host.call('readdir', base);
  const out = [];
  for (const e of entries) {
    if (e.type !== 'dir' || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(base, e.name);
    let git = false;
    try { await host.call('stat', path.join(full, '.git')); git = true; } catch {}
    out.push({ name: e.name, git, known: !!known(full) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(base);
  return { path: base, display: base === home || base.startsWith(home + path.sep) ? '~' + base.slice(home.length) : base, parent: parent !== base ? parent : null, dirs: out };
}

// Which of these names are real files or folders for them (links in prose).
async function exists(host, lists) {
  const found = {};
  await Promise.all(Object.entries(lists).map(async ([name, list]) => {
    try { const { abs, stat } = await locate(host, list); found[name] = { path: abs, kind: stat.type === 'dir' ? 'directory' : 'file' }; }
    catch { found[name] = null; }
  }));
  return found;
}

// The four disk calls files-browser-server.js makes, as their host makes them.
function hostIo(host) {
  const st = s => ({ isDirectory: () => s.type === 'dir', isFile: () => s.type === 'file', isSymbolicLink: () => s.type === 'link', size: s.size, mtimeMs: s.mtimeMs });
  return {
    realpath: p => host.call('realpath', p),
    stat: async p => st(await host.call('stat', p)),
    readdir: async p => (await host.call('readdir', p)).map(e => ({ name: e.name, ...st(e) })),
    readFile: async p => Buffer.from((await host.call('read', p, { start: 0 })).data),
  };
}

module.exports = { hostIo, expandHome, candidates, locate, info, readText, saveText, serve, dirs, exists };
