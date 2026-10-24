'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

const SKIP = new Set(['.git', 'node_modules', '.direnv', 'target', '__pycache__', '.venv']);
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

// `io` is how the disk is reached: this process's own file system, or a
// person's host process when they run as their own account (design/105),
// so their folders are listed with their rights. Same shape as fs/promises
// for the four calls used here.
const NODE_IO = { realpath: p => fs.realpath(p), stat: p => fs.stat(p), readdir: p => fs.readdir(p, { withFileTypes: true }), readFile: p => fs.readFile(p) };

// Resolve both sides: lexical containment alone would allow symlink escapes.
async function safePath(root, relative = '', io = NODE_IO) {
  root = await io.realpath(root);
  const candidate = path.resolve(root, relative);
  if (!inside(root, candidate)) throw new Error('Path is outside this repository');
  const real = await io.realpath(candidate);
  if (!inside(root, real)) throw new Error('Link points outside this repository');
  return real;
}

async function browse(root, { dir = '', q = '', contents = false } = {}, io = NODE_IO) {
  root = await io.realpath(root);
  const base = await safePath(root, dir, io);
  if (!(await io.stat(base)).isDirectory()) throw new Error('Not a folder');
  const entries = [];
  const query = String(q).trim().toLowerCase();
  let visited = 0, bytes = 0, truncated = false;
  const deadline = Date.now() + 3000;
  async function walk(folder) {
    const names = await io.readdir(folder);
    names.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const ent of names) {
      if (SKIP.has(ent.name)) continue;
      if (++visited > 12000 || entries.length >= 300 || Date.now() > deadline || bytes > 16 * 1024 * 1024) { truncated = true; return; }
      const full = path.join(folder, ent.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      const isDir = ent.isDirectory();
      let match = !query || rel.toLowerCase().includes(query), line = null, snippet = null;
      // Do not recurse into or read symbolic links during search.
      if (query && contents && ent.isFile()) {
        const stat = await io.stat(full).catch(() => null);
        if (stat && stat.size <= 512 * 1024) {
          bytes += stat.size;
          const data = await io.readFile(full).catch(() => null);
          if (data && !data.includes(0)) {
            const lines = data.toString('utf8').split('\n');
            const at = lines.findIndex(s => s.toLowerCase().includes(query));
            if (at >= 0) { match = true; line = at + 1; snippet = lines[at].slice(0, 240); }
          }
        }
      }
      if (match) entries.push({ name: ent.name, rel, path: full, directory: isDir, link: ent.isSymbolicLink(), line, snippet });
      if (query && isDir) { await walk(full); if (truncated) return; }
    }
  }
  await walk(base);
  const readme = !query && entries.find(e => !e.directory && /^readme\.(md|markdown)$/i.test(e.name));
  return { root, dir: path.relative(root, base).split(path.sep).join('/'), entries, readme: readme?.path || null, truncated, searched: visited };
}

function activityQuery(db, project, params = {}) {
  const now = Date.now();
  const number = (v, fallback) => v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback;
  const from = Math.max(0, number(params.from, now - 86400000));
  const to = Math.max(from, Math.min(now, number(params.to, now)));
  const limit = Math.max(1, Math.min(5000, Math.floor(number(params.limit, 1000))));
  const args = [project, from, to];
  let where = "project = ? AND ts BETWEEN ? AND ? AND outcome <> 'failed'";
  if (params.conv) { where += ' AND conv_key = ?'; args.push(params.conv); }
  if (['ai', 'human', 'external', 'git'].includes(params.actor)) { where += ' AND actor = ?'; args.push(params.actor); }
  const rows = db.prepare(`SELECT id, ts, path, repo_root, actor, producer, outcome, added, removed, conv_key, call_id, commit_hash FROM file_events WHERE ${where} ORDER BY ts DESC, id DESC LIMIT ?`).all(...args, limit + 1);
  return { from, to, events: rows.slice(0, limit), truncated: rows.length > limit };
}
module.exports = { browse, safePath, inside, activityQuery };
