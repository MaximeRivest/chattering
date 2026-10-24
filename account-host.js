'use strict';
// account-host.js — runs AS a person's account (design/105) and does the
// file work this server needs done for them: writing a fork into their
// conversation folder, and the files Chattering shows and saves for them.
// The server asks over the IPC channel; every operation runs with the
// account's own rights, so Linux answers whether they may, as it would for
// any program they run. Nothing here decides who may do what.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MAX_READ = 16 * 1024 * 1024;

function typeOf(st) { return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'; }
function statView(st) {
  return { type: typeOf(st), size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, mode: st.mode, uid: st.uid, gid: st.gid, ino: st.ino, dev: st.dev };
}
const abs = p => {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) throw Object.assign(new Error('an absolute path is needed'), { code: 'EINVAL' });
  return path.resolve(p);
};

const OPS = {
  async stat(p) { return statView(await fsp.stat(abs(p))); },
  async lstat(p) { return statView(await fsp.lstat(abs(p))); },
  async realpath(p) { return fsp.realpath(abs(p)); },
  async access(p, mode = fs.constants.R_OK) { await fsp.access(abs(p), mode); return true; },
  async readdir(p) {
    const entries = await fsp.readdir(abs(p), { withFileTypes: true });
    return entries.map(e => ({ name: e.name, type: e.isSymbolicLink() ? 'link' : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other' }));
  },
  // A slice of a file: bytes (a Buffer) or text. Never more than MAX_READ.
  async read(p, { start = 0, length = MAX_READ, encoding = null } = {}) {
    const fh = await fsp.open(abs(p), 'r');
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
      const want = Math.max(0, Math.min(length, MAX_READ, st.size - start));
      const buf = Buffer.alloc(want);
      let got = 0;
      while (got < want) { const { bytesRead } = await fh.read(buf, got, want - got, start + got); if (!bytesRead) break; got += bytesRead; }
      const out = buf.subarray(0, got);
      return { data: encoding ? out.toString(encoding) : out, size: st.size, mtimeMs: st.mtimeMs };
    } finally { await fh.close(); }
  },
  // Whole-file write, atomic unless `exclusive` (create only, never replace).
  async write(p, data, { exclusive = false, mkdirs = false, mode } = {}) {
    const file = abs(p);
    if (mkdirs) await fsp.mkdir(path.dirname(file), { recursive: true });
    const body = typeof data === 'string' ? data : Buffer.from(data);
    if (exclusive) { await fsp.writeFile(file, body, { flag: 'wx', ...(mode ? { mode } : {}) }); return true; }
    const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.chattering-' + process.pid + '-' + Date.now());
    await fsp.writeFile(tmp, body, mode ? { mode } : {});
    try {
      if (!mode) { try { const st = await fsp.stat(file); await fsp.chmod(tmp, st.mode & 0o7777); } catch {} }
      await fsp.rename(tmp, file);
    } catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
    return true;
  },
  async append(p, data) { await fsp.appendFile(abs(p), typeof data === 'string' ? data : Buffer.from(data)); return true; },
  async mkdir(p, { recursive = false } = {}) { await fsp.mkdir(abs(p), { recursive }); return true; },
  async rename(a, b) { await fsp.rename(abs(a), abs(b)); return true; },
  async rm(p, { recursive = false } = {}) { await fsp.rm(abs(p), { recursive, force: false }); return true; },
  async whoami() { return { uid: process.getuid(), gid: process.getgid(), home: process.env.HOME, pid: process.pid }; },
};

process.on('message', async msg => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'shutdown') { process.disconnect(); return; }
  const { id, op, args } = msg;
  const fn = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null;
  try {
    if (!fn) throw Object.assign(new Error('unknown operation ' + op), { code: 'ENOSYS' });
    process.send({ id, ok: true, result: await fn(...(Array.isArray(args) ? args : [])) });
  } catch (e) {
    process.send({ id, ok: false, error: { message: String(e && e.message || e), code: e && e.code || null } });
  }
});
// The server went away: so does this.
process.on('disconnect', () => process.exit(0));
process.send({ type: 'ready', pid: process.pid, uid: process.getuid() });
