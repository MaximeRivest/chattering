'use strict';
// file-ops.js — rename, duplicate and delete for the Files browser
// (files-browser.js), and the place deleted files wait to be restored.
//
// Rules carried here:
// · Everything happens inside one repository root, named by its path
//   relative to that root. The entry itself is never followed when it is a
//   symbolic link: renaming or deleting a link acts on the link; only its
//   folder must really be inside the root.
// · Nothing is overwritten. A rename onto an existing name is refused; a
//   duplicate picks the first free "name copy" (created with exclusive
//   flags, so two clicks never collide); a restore whose place is taken
//   comes back as "name (restored)".
// · Delete does not destroy. The entry moves to a folder of Chattering's
//   own (one per installation, outside every project, so Git and the
//   project watcher do not see it), with a small record of where it came
//   from. It can be restored from there for RETAIN_MS; after that the next
//   delete or listing removes it for good.
// · The root itself and a repository's .git folder are never touched.

const fs = require('node:fs/promises');
const fsConstants = require('node:fs').constants;
const path = require('node:path');
const crypto = require('node:crypto');
const platform = require('./platform.js');

const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
// A duplicate is a copy of everything inside: past these, it is refused
// (a folder of data or dependencies, copied by one click, fills a disk).
const DUPLICATE_MAX_BYTES = 1024 * 1024 * 1024;
const DUPLICATE_MAX_ENTRIES = 20000;
const PROTECTED = new Set(['.git']);
// Endings that are one kind of file: "a.ink.svg" copies as "a copy.ink.svg",
// not "a.ink copy.svg" (which would no longer be a handwritten note).
const COMPOUND_EXT = /(\.ink\.svg|\.tar\.(?:gz|bz2|xz|zst)|\.d\.ts)$/i;
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

const inside = (root, p) => p === root || p.startsWith(root + path.sep);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// A name for one entry in one folder. Trimmed at both ends: a trailing
// space is almost always a typing slip, and invisible afterwards.
function checkName(raw, { windows = platform.IS_WIN } = {}) {
  const name = String(raw ?? '').trim();
  if (!name) throw fail('Type a name.');
  if (name === '.' || name === '..') throw fail('That name is reserved.');
  if (name.includes('/') || name.includes('\0')) throw fail('A name cannot contain “/”. Renaming does not move a file to another folder.');
  if (Buffer.byteLength(name) > 255) throw fail('That name is too long.');
  if (PROTECTED.has(name)) throw fail('“' + name + '” is reserved for Git.');
  if (windows) {
    if (/[\\:*?"<>|\x00-\x1f]/.test(name)) throw fail('Windows does not allow these characters in a name: \\ : * ? " < > |');
    if (/[. ]$/.test(name)) throw fail('Windows does not allow a name ending in a dot or a space.');
    if (WIN_RESERVED.test(name)) throw fail('Windows reserves that name.');
  }
  return name;
}

// The entry named by `rel` under `root`, without following it. Its folder
// is resolved (a link on the way must stay inside the root).
async function entryAt(root, rel) {
  root = await fs.realpath(root);
  const relText = String(rel ?? '');
  if (!relText || relText.includes('\0')) throw fail('Choose a file or folder.');
  const lexical = path.resolve(root, relText);
  if (!inside(root, lexical) || lexical === root) throw fail('That is outside this repository.');
  const parent = await fs.realpath(path.dirname(lexical)).catch(() => { throw fail('This file or folder no longer exists. Refresh the list.', 404); });
  if (!inside(root, parent)) throw fail('That folder is outside this repository.');
  const name = path.basename(lexical);
  if (PROTECTED.has(name)) throw fail('“' + name + '” belongs to Git and is not changed from here.');
  const abs = path.join(parent, name);
  const stat = await fs.lstat(abs).catch(e => { throw e.code === 'ENOENT' ? fail('This file or folder no longer exists. Refresh the list.', 404) : e; });
  return { root, abs, parent, name, stat, directory: stat.isDirectory(), link: stat.isSymbolicLink() };
}
const relOf = (root, abs) => platform.toPortable(path.relative(root, abs));

async function exists(p) {
  try { return await fs.lstat(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// Rename within the same folder. A change of case only ("readme.md" →
// "README.md") is allowed on a file system that sees both as one file.
async function renameEntry(root, rel, newName, opts = {}) {
  const e = await entryAt(root, rel);
  const name = checkName(newName, opts);
  const to = path.join(e.parent, name);
  if (name === e.name) return { from: e.abs, to, rel: relOf(e.root, to), directory: e.directory, changed: false };
  const there = await exists(to);
  if (there && !(there.ino === e.stat.ino && there.dev === e.stat.dev)) throw fail('“' + name + '” already exists in this folder.', 409);
  await platform.renameRetry(e.abs, to);
  return { from: e.abs, to, rel: relOf(e.root, to), directory: e.directory, changed: true };
}

// "report copy.md", then "report copy 2.md"; a folder "data copy".
function copyName(name, directory, n = 1) {
  let stem = name, ext = '';
  if (!directory) {
    const compound = COMPOUND_EXT.exec(name);
    const dot = name.lastIndexOf('.');
    if (compound && compound.index > 0) { stem = name.slice(0, compound.index); ext = compound[1]; }
    else if (dot > 0) { stem = name.slice(0, dot); ext = name.slice(dot); }
  }
  return stem + (n === 1 ? ' copy' : ' copy ' + n) + ext;
}

// What a folder holds, counted without following links; refused past the
// limits as soon as they are crossed.
async function measure(dir, { maxBytes = DUPLICATE_MAX_BYTES, maxEntries = DUPLICATE_MAX_ENTRIES } = {}) {
  let bytes = 0, entries = 0;
  const walk = async folder => {
    for (const ent of await fs.readdir(folder, { withFileTypes: true })) {
      if (++entries > maxEntries) throw fail(`This folder holds more than ${maxEntries.toLocaleString('en')} files and folders; duplicate it from a terminal if you mean to.`, 413);
      const full = path.join(folder, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile()) {
        bytes += (await fs.lstat(full)).size;
        if (bytes > maxBytes) throw fail(`This folder holds more than ${Math.round(maxBytes / 1024 / 1024).toLocaleString('en')} MB; duplicate it from a terminal if you mean to.`, 413);
      }
    }
  };
  await walk(dir);
  return { bytes, entries };
}

// Create the copy at `dest`, failing with EEXIST when the name is taken.
async function copyTo(e, dest) {
  if (e.link) return fs.symlink(await fs.readlink(e.abs), dest);
  if (!e.directory) return fs.copyFile(e.abs, dest, fsConstants.COPYFILE_EXCL);
  await fs.mkdir(dest); // reserves the name: fails if it exists
  // Only what is inside is copied into the reserved folder (cp refuses an
  // existing destination folder). A failure removes the partial copy, which
  // is ours alone: its name did not exist a moment ago.
  try {
    for (const name of await fs.readdir(e.abs)) {
      await fs.cp(path.join(e.abs, name), path.join(dest, name), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    }
    await fs.chmod(dest, e.stat.mode & 0o7777).catch(() => {}); // last: a read-only folder still receives its copy
  } catch (err) { await fs.rm(dest, { recursive: true, force: true }).catch(() => {}); throw err; }
}

async function duplicateEntry(root, rel, limits = {}) {
  const e = await entryAt(root, rel);
  if (e.directory && !e.link) await measure(e.abs, limits);
  for (let n = 1; n <= 200; n++) {
    const name = copyName(e.name, e.directory, n);
    if (Buffer.byteLength(name) > 255) throw fail('The name is too long to add “copy” to it. Rename it first.');
    const dest = path.join(e.parent, name);
    try { await copyTo(e, dest); return { from: e.abs, to: dest, rel: relOf(e.root, dest), directory: e.directory }; }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
  }
  throw fail('Too many copies of this name already exist.', 409);
}

// A move that also works across file systems: a rename when it can, else a
// full copy then removal of the original (only once the copy is complete).
async function move(from, to) {
  try { await platform.renameRetry(from, to); }
  catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true, preserveTimestamps: true });
    await fs.rm(from, { recursive: true, force: true });
  }
}

// ---- recently deleted ----
// <dir>/<id>.json  the record: where it was, when, by whom, what it was
// <dir>/<id>/<name> the entry itself
function createTrash(dir, { retainMs = RETAIN_MS, now = () => Date.now() } = {}) {
  const recordPath = id => path.join(dir, id + '.json');
  const validId = id => typeof id === 'string' && /^[a-z0-9]{6,40}$/.test(id);
  // Expired entries go at most hourly, on the way to a listing or a delete.
  let purgedAt = 0;
  const purgeSoon = () => { if (now() - purgedAt < 60 * 60 * 1000) return; purgedAt = now(); return purge().catch(() => {}); };

  async function read(id) {
    if (!validId(id)) return null;
    try {
      const r = JSON.parse(await fs.readFile(recordPath(id), 'utf8'));
      if (!r || r.id !== id || typeof r.from !== 'string' || typeof r.name !== 'string') return null;
      if (!(await exists(path.join(dir, id, r.name)))) return null; // half-written or already restored
      return r;
    } catch { return null; }
  }
  async function drop(id) {
    await fs.rm(path.join(dir, id), { recursive: true, force: true });
    await fs.rm(recordPath(id), { force: true });
  }

  // Move `abs` here. `info` is kept with it (root, project, user, extra).
  async function put(abs, info = {}) {
    await fs.mkdir(dir, { recursive: true });
    await purgeSoon();
    const stat = await fs.lstat(abs);
    const id = now().toString(36) + crypto.randomBytes(5).toString('hex');
    const name = path.basename(abs);
    const record = { ...info, id, from: abs, name, at: now(), directory: stat.isDirectory() && !stat.isSymbolicLink() };
    // The record first: an entry moved without one could not be found again.
    await fs.writeFile(recordPath(id), JSON.stringify(record) + '\n');
    try {
      await fs.mkdir(path.join(dir, id));
      await move(abs, path.join(dir, id, name));
    } catch (e) { await drop(id).catch(() => {}); throw e; }
    return record;
  }

  async function list(filter = () => true) {
    await purgeSoon();
    let names = [];
    try { names = await fs.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const r = await read(n.slice(0, -5));
      if (r && filter(r)) out.push(r);
    }
    return out.sort((a, b) => b.at - a.at);
  }

  // Put it back. `place(record)` returns the absolute path to restore to
  // (after any checks of its own; its folder must exist). Never overwrites.
  async function restore(id, place) {
    const r = await read(id);
    if (!r) throw fail('This deleted item is no longer kept.', 404);
    const target = await place(r);
    const parent = path.dirname(target), base = path.basename(target);
    let dest = target;
    for (let n = 1; await exists(dest); n++) {
      if (n > 100) throw fail('Too many items with this name already exist.', 409);
      const dot = r.directory ? -1 : base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base, ext = dot > 0 ? base.slice(dot) : '';
      dest = path.join(parent, `${stem} (restored${n === 1 ? '' : ' ' + n})${ext}`);
    }
    await move(path.join(dir, id, r.name), dest);
    await drop(id).catch(() => {});
    return { ...r, to: dest, renamed: dest !== target };
  }

  async function purge() {
    let names = [];
    try { names = await fs.readdir(dir); } catch { return 0; }
    let removed = 0;
    const limit = now() - retainMs;
    const ids = new Set(names.map(n => n.endsWith('.json') ? n.slice(0, -5) : n).filter(validId));
    for (const id of ids) {
      let at = 0;
      try { at = Number(JSON.parse(await fs.readFile(recordPath(id), 'utf8')).at) || 0; }
      catch { at = (await exists(path.join(dir, id)))?.mtimeMs || 0; } // an entry left without its record
      if (at && at < limit) { await drop(id).catch(() => {}); removed++; }
    }
    return removed;
  }

  return { dir, put, list, restore, purge, read };
}

module.exports = { checkName, entryAt, renameEntry, duplicateEntry, copyName, measure, move, createTrash, RETAIN_MS, DUPLICATE_MAX_BYTES, DUPLICATE_MAX_ENTRIES };
