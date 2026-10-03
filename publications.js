'use strict';
// Publications (design/92): frozen copies of what was made here — a web
// page, a game, an AI program's page — kept by their content.
//
// A version is a manifest: every file by its path, with its SHA-256, size
// and type, the entry page, and what kind of thing it is. Its fingerprint
// (the "root") is the SHA-256 of the manifest written canonically (members
// sorted, no spaces). Change one byte of one file and the root changes. The
// computer that published it signs the root with its own key (the key its
// public address and phone link already prove), so a copy served by anyone,
// anywhere, can be checked: the files against the manifest, the manifest
// against the root, the root against the signature, the key against the
// computer's id. verifyPublication does exactly that, in a browser or Node.
//
// Storage, under one folder (0700):
//   blobs/<sha256>          each file's bytes, once however many versions hold it
//   manifests/<root>.json   each version's manifest
// Nothing is ever changed in place; old versions stay until no publication
// names them (gc).
require('./win-hide.js');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const FORMAT = 1;
const CONTEXT = 'chattering-publication/1\n';
const LIMITS = { files: 5000, fileBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, pathLength: 512 };
const KINDS = ['site', 'program'];
const HEX64 = /^[0-9a-f]{64}$/;

// Members sorted at every level, no spaces: the one way to write a manifest.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// A path inside a publication: relative, forward slashes, no way out.
function cleanPath(p) {
  const s = String(p || '');
  if (!s || s.length > LIMITS.pathLength || s.startsWith('/') || s.includes('\\') || /[\u0000-\u001f\u007f]/.test(s)) return null;
  const parts = s.split('/');
  if (parts.some(x => !x || x === '.' || x === '..')) return null;
  return s;
}

function rootOf(manifest) { return sha256(Buffer.from(canonical(manifest), 'utf8')); }

function checkManifest(m) {
  if (!m || typeof m !== 'object' || m.chattering_publication !== FORMAT) throw new Error('not a publication manifest');
  if (!KINDS.includes(m.kind)) throw new Error('unknown kind');
  if (!m.files || typeof m.files !== 'object') throw new Error('no files');
  const names = Object.keys(m.files);
  if (!names.length || names.length > LIMITS.files) throw new Error('too many or no files');
  for (const n of names) {
    const f = m.files[n];
    if (cleanPath(n) !== n || !f || !HEX64.test(f.sha256) || !Number.isInteger(f.size) || f.size < 0 || typeof f.type !== 'string') throw new Error('bad file entry: ' + n);
  }
  if (!Object.prototype.hasOwnProperty.call(m.files, m.entry)) throw new Error('the entry page is not in the files');
  return m;
}

class PublicationStore {
  constructor({ dir }) {
    this.dir = dir;
    this.blobs = path.join(dir, 'blobs');
    this.manifests = path.join(dir, 'manifests');
    fs.mkdirSync(this.blobs, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.manifests, { recursive: true, mode: 0o700 });
  }
  blobPath(hash) {
    if (!HEX64.test(String(hash))) throw new Error('bad hash');
    return path.join(this.blobs, hash);
  }
  // Keep bytes; returns their hash. Written once: same content, same file.
  async putBlob(bytes) {
    const hash = sha256(bytes);
    const file = this.blobPath(hash);
    if (!fs.existsSync(file)) {
      const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
      await fsp.writeFile(tmp, bytes, { mode: 0o600 });
      await fsp.rename(tmp, file);
    }
    return hash;
  }
  // A version from files: [{ path, bytes, type }]. Returns { root, manifest }.
  async put({ kind, entry, files }) {
    if (!KINDS.includes(kind)) throw new Error('unknown kind');
    if (!files.length) throw new Error('nothing to publish');
    if (files.length > LIMITS.files) throw new Error(`at most ${LIMITS.files} files`);
    let total = 0;
    const out = {};
    for (const f of files) {
      const p = cleanPath(f.path);
      if (!p) throw new Error('a file name cannot be published: ' + f.path);
      if (Object.prototype.hasOwnProperty.call(out, p)) throw new Error('the same file twice: ' + p);
      if (f.bytes.length > LIMITS.fileBytes) throw new Error(`${p} is over ${LIMITS.fileBytes / 1048576} MB`);
      total += f.bytes.length;
      if (total > LIMITS.totalBytes) throw new Error(`over ${LIMITS.totalBytes / 1048576} MB in all`);
      out[p] = { sha256: await this.putBlob(f.bytes), size: f.bytes.length, type: String(f.type || 'application/octet-stream') };
    }
    const manifest = checkManifest({ chattering_publication: FORMAT, kind, entry, files: out });
    const root = rootOf(manifest);
    const file = path.join(this.manifests, root + '.json');
    if (!fs.existsSync(file)) await fsp.writeFile(file, canonical(manifest), { mode: 0o600 });
    return { root, manifest };
  }
  manifest(root) {
    if (!HEX64.test(String(root))) return null;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(this.manifests, root + '.json'), 'utf8'));
      return rootOf(m) === root ? m : null; // a manifest that does not hash to its name is not served
    } catch { return null; }
  }
  // Remove every version no live publication names, then every file no
  // remaining version holds.
  async gc(keepRoots) {
    const keep = new Set(keepRoots);
    const used = new Set();
    let removed = 0;
    for (const f of await fsp.readdir(this.manifests)) {
      const root = f.replace(/\.json$/, '');
      if (!keep.has(root)) { await fsp.rm(path.join(this.manifests, f), { force: true }); removed++; continue; }
      const m = this.manifest(root);
      if (m) for (const e of Object.values(m.files)) used.add(e.sha256);
    }
    for (const b of await fsp.readdir(this.blobs)) if (HEX64.test(b) && !used.has(b)) { await fsp.rm(path.join(this.blobs, b), { force: true }); removed++; }
    return removed;
  }
}

// ---- checking a publication, wherever it is served (browser or Node) -----
// doc: what /.well-known/chattering-publication.json serves.
// fetchFile(path) → bytes (Uint8Array) of that file as served.
async function verifyPublication(doc, fetchFile, { subtle = globalThis.crypto && globalThis.crypto.subtle } = {}) {
  const problems = [];
  const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  const unb64u = s => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
  const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = async bytes => hex(await subtle.digest('SHA-256', bytes));
  let manifest = doc && doc.manifest;
  try { checkManifest(manifest); } catch (e) { return { ok: false, problems: ['manifest: ' + e.message] }; }
  const root = await digest(new TextEncoder().encode(canonical(manifest)));
  if (root !== doc.root) problems.push('the manifest does not hash to the fingerprint it is published under');
  // The signer: the key hashes to the computer's id (as its address and phone link prove it).
  const spki = unb64u(doc.signer && doc.signer.key || '');
  const id = b64u(new Uint8Array(await subtle.digest('SHA-256', spki)).subarray(0, 16));
  if (!doc.signer || id !== doc.signer.id) problems.push('the signing key is not the computer it names');
  try {
    const key = await subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(doc.signature || ''), new TextEncoder().encode(CONTEXT + root));
    if (!ok) problems.push('the signature does not match the fingerprint');
  } catch { problems.push('the signature cannot be read'); }
  const files = [];
  for (const [p, f] of Object.entries(manifest.files)) {
    let bytes;
    try { bytes = await fetchFile(p); } catch (e) { problems.push(p + ': could not be read (' + e.message + ')'); continue; }
    const got = await digest(bytes);
    if (got !== f.sha256 || bytes.length !== f.size) problems.push(p + ': changed (its content is not what was published)');
    files.push(p);
  }
  return { ok: !problems.length, root, signer: doc.signer && doc.signer.id, files: files.length, problems };
}

module.exports = { PublicationStore, verifyPublication, canonical, rootOf, cleanPath, checkManifest, sha256, CONTEXT, LIMITS, FORMAT };

// `node publications.js https://game.maxime.rockfrog.site` checks a
// publication as served: every file, the fingerprint and the signature.
if (require.main === module) {
  const base = String(process.argv[2] || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) { console.error('usage: node publications.js https://<address>'); process.exit(2); }
  (async () => {
    const doc = await (await fetch(base + '/.well-known/chattering-publication.json')).json();
    const r = await verifyPublication(doc, async p => {
      const res = await fetch(base + '/_v/' + doc.root + '/' + p.split('/').map(encodeURIComponent).join('/'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return new Uint8Array(await res.arrayBuffer());
    });
    console.log(r.ok ? `✓ ${base}: ${r.files} files, fingerprint ${r.root}, signed by computer ${r.signer}` : `✗ ${base}:\n  ` + r.problems.join('\n  '));
    process.exit(r.ok ? 0 : 1);
  })().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
}
