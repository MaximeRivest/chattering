'use strict';
// runtime-publish.js — the code a person's processes run, where their
// account can read it (design/105).
//
// This server may run from a checkout in its owner's home, and a home is
// private: another account cannot read a file in it, which is right. So
// the files a person's Pi worker needs (this program's own modules, its
// extensions, the pinned Pi and, when present, the owner's Claude Code
// provider extension: code, never credentials) are published to a folder
// everyone may read and only this server may write:
//
//   <root>/pi-<hash>/node_modules/...     the pinned Pi, per lockfile
//   <root>/app-<hash>/*.js, extensions/,   this program, per content;
//     harness/, models/, runtime/          runtime/node_modules links to pi-<hash>
//     owner-extensions/<name>/
//
// Content-addressed: an unchanged checkout publishes nothing, a worker
// started before an update keeps the copy it loaded, and publishing is a
// rename at the end, so no one ever loads half a copy. On btrfs and XFS the
// copy is a reflink (no space, no time); elsewhere it is a copy, once per
// change. Old copies are removed when no longer recent.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const APP_DIRS = ['extensions', 'harness', 'models'];
const APP_FILE = /\.(?:js|cjs|mjs|ts|json)$/;
const KEEP_RECENT = 3;
const KEEP_YOUNGER_MS = 2 * 24 * 3600 * 1000;

function sh(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, { maxBuffer: 16 * 1024 * 1024 }, (e, out, err) => e ? reject(Object.assign(e, { stderr: err })) : resolve(out)));
}
// cp keeps modes and times; --reflink=auto shares blocks where it can.
async function copyTree(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  await sh('cp', ['-a', '--reflink=auto', '--no-preserve=ownership', src, dst]);
}
// Readable by every account, writable only by this one.
async function openUp(dir) { await sh('chmod', ['-R', 'u+rwX,go+rX,go-w', dir]); }

// Every file under `dir` (no symlinks followed), relative, with size and time.
async function manifest(dir, { filter = () => true, skip = () => false } = {}) {
  const out = [];
  async function walk(rel) {
    let entries;
    try { entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (skip(r, e)) continue;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile() && filter(r)) {
        const st = await fsp.stat(path.join(dir, r));
        out.push(r + '\0' + st.size + '\0' + Math.floor(st.mtimeMs));
      }
    }
  }
  await walk('');
  return out.sort();
}
const hashOf = lines => crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);

// What the app copy holds: top-level program files and a few folders.
function appFilter(rel) {
  const top = rel.split('/')[0];
  if (rel === top) return APP_FILE.test(rel);
  return APP_DIRS.includes(top) && !/(^|\/)(test|node_modules)(\/|$)/.test(rel);
}

async function exists(p) { try { await fsp.access(p); return true; } catch { return false; } }

// Build `final` through a temporary folder renamed at the end. Another
// server publishing the same content at the same time wins the rename;
// this one throws its copy away.
async function buildOnce(root, final, build) {
  if (await exists(final)) return final;
  const tmp = path.join(root, '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'));
  await fsp.mkdir(tmp, { recursive: true });
  try {
    await build(tmp);
    await openUp(tmp);
    await fsp.chmod(tmp, 0o755);
    try { await fsp.rename(tmp, final); } catch (e) { if (!(await exists(final))) throw e; }
  } finally { await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
  return final;
}

// Pi: the bundled runtime's node_modules (Pi and its locked dependencies),
// or an installed Pi package, which carries its own node_modules.
async function publishPi(root, { appDir, piPackageDir }) {
  const bundled = path.join(appDir, 'runtime', 'node_modules');
  const lock = path.join(appDir, 'runtime', 'package-lock.json');
  const isBundled = piPackageDir && path.resolve(piPackageDir).startsWith(path.resolve(bundled) + path.sep);
  if (isBundled) {
    const key = hashOf([await fsp.readFile(lock, 'utf8').catch(() => ''), ...(await manifest(piPackageDir, { filter: r => r === 'package.json' }))]);
    const final = path.join(root, 'pi-' + key);
    await buildOnce(root, final, tmp => copyTree(bundled, path.join(tmp, 'node_modules')));
    return { nodeModules: path.join(final, 'node_modules'), piDir: path.join(final, 'node_modules', path.relative(bundled, piPackageDir)) };
  }
  const pkg = JSON.parse(await fsp.readFile(path.join(piPackageDir, 'package.json'), 'utf8'));
  const key = hashOf([path.resolve(piPackageDir), pkg.version || '', ...(await manifest(piPackageDir, { filter: r => r === 'package.json' || /^dist\/[^/]+\.js$/.test(r) }))]);
  const final = path.join(root, 'pi-' + key);
  const name = pkg.name || 'pi';
  await buildOnce(root, final, tmp => copyTree(piPackageDir, path.join(tmp, 'node_modules', name)));
  return { nodeModules: path.join(final, 'node_modules'), piDir: path.join(final, 'node_modules', name) };
}

// The whole publication. Returns where things are and the path maps that
// turn a path of this checkout into the published one.
async function publishRuntime({ root, appDir, piPackageDir, ownerExtensions = [] }) {
  if (!root) throw new Error('no folder to publish the shared runtime to');
  try { await fsp.access(root, fs.constants.W_OK); }
  catch { throw new Error(`The shared runtime folder ${root} is missing or not writable by this server. The system configuration creates it (design/105).`); }
  const pi = await publishPi(root, { appDir, piPackageDir });
  const app = await manifest(appDir, { filter: appFilter, skip: (r, e) => e.isDirectory() && r.split('/').length === 1 && !APP_DIRS.includes(r) });
  const extLines = [];
  const exts = ownerExtensions.filter(x => x && x.dir && fs.existsSync(x.dir));
  for (const x of exts) extLines.push('ext:' + x.name, ...(await manifest(x.dir, { filter: r => !/(^|\/)test\//.test(r) })));
  const key = hashOf(['app', path.basename(pi.nodeModules.replace(/\/node_modules$/, '')), ...app, ...extLines]);
  const final = path.join(root, 'app-' + key);
  await buildOnce(root, final, async tmp => {
    for (const line of app) {
      const rel = line.split('\0')[0];
      const dst = path.join(tmp, rel);
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      await fsp.copyFile(path.join(appDir, rel), dst, fs.constants.COPYFILE_FICLONE);
    }
    await fsp.mkdir(path.join(tmp, 'runtime'), { recursive: true });
    for (const f of ['package.json', 'package-lock.json']) if (await exists(path.join(appDir, 'runtime', f))) await fsp.copyFile(path.join(appDir, 'runtime', f), path.join(tmp, 'runtime', f), fs.constants.COPYFILE_FICLONE);
    // Relative, so it holds once the folder is renamed into place.
    await fsp.symlink(path.relative(path.join(final, 'runtime'), pi.nodeModules), path.join(tmp, 'runtime', 'node_modules'));
    for (const x of exts) {
      const dst = path.join(tmp, 'owner-extensions', x.name);
      await copyTree(x.dir, dst);
      await fsp.rm(path.join(dst, 'test'), { recursive: true, force: true });
    }
  });
  const piDir = path.join(final, 'runtime', 'node_modules', path.relative(pi.nodeModules, pi.piDir));
  const maps = [{ from: path.resolve(appDir), to: final }, ...exts.map(x => ({ from: path.resolve(x.dir), to: path.join(final, 'owner-extensions', x.name) }))];
  // The bundled Pi under the checkout maps through the app copy's link.
  return { root, appDir: final, piDir: fs.existsSync(piDir) ? piDir : pi.piDir, maps };
}

// Remove copies nobody needs: keep the newest few and anything recent
// (a worker started before an update may still load modules from it).
async function prune(root, { keepNames = [], now = Date.now() } = {}) {
  let entries = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return []; }
  const removed = [];
  const stats = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name);
    if (e.name.startsWith('.tmp-')) { const st = await fsp.stat(p).catch(() => null); if (st && now - st.mtimeMs > 3600e3) { await fsp.rm(p, { recursive: true, force: true }); removed.push(e.name); } continue; }
    if (!/^(app|pi)-[0-9a-f]{16}$/.test(e.name)) continue;
    stats.push({ name: e.name, mtimeMs: (await fsp.stat(p)).mtimeMs });
  }
  const apps = stats.filter(s => s.name.startsWith('app-')).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keep = new Set(keepNames);
  for (const [i, s] of apps.entries()) if (i < KEEP_RECENT || now - s.mtimeMs < KEEP_YOUNGER_MS) keep.add(s.name);
  // A Pi copy stays while a kept app copy links to it.
  for (const name of [...keep]) {
    if (!name.startsWith('app-')) continue;
    try { const t = await fsp.readlink(path.join(root, name, 'runtime', 'node_modules')); const m = /(pi-[0-9a-f]{16})/.exec(t); if (m) keep.add(m[1]); } catch {}
  }
  for (const s of stats) if (!keep.has(s.name) && now - s.mtimeMs >= KEEP_YOUNGER_MS) { await fsp.rm(path.join(root, s.name), { recursive: true, force: true }); removed.push(s.name); }
  return removed;
}

module.exports = { publishRuntime, prune, manifest, appFilter };
