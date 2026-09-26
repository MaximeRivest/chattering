'use strict';
// platform.js — where Chattering meets the operating system (design/70).
//
// Every question whose answer depends on Linux, macOS or Windows is asked
// here, once: which system this is, how PATH is spelled and split, where
// an executable is, whether one path is inside another, where Chattering
// keeps its own files, how a file is opened or shown in the desktop's file
// manager. Other modules ask; they do not test process.platform
// themselves, so a port is a change to this file and its tests, not a
// hunt through the codebase.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PLATFORM = process.platform;
const IS_WIN = PLATFORM === 'win32';
const IS_MAC = PLATFORM === 'darwin';
const IS_LINUX = PLATFORM === 'linux';
// WSL is Linux with a Windows desktop beside it: files open through the
// Windows side. Detected once.
const IS_WSL = IS_LINUX && (() => {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try { return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); } catch { return false; }
})();

function hostKind() { return IS_WIN ? 'windows' : IS_MAC ? 'macos' : IS_WSL ? 'wsl' : IS_LINUX ? 'linux' : PLATFORM; }

// ---- environment ----------------------------------------------------------

// The name PATH has in this environment. Windows keys are case-insensitive
// and usually spelled "Path"; writing "PATH" beside it makes two entries.
function pathKey(env = process.env) {
  if (!IS_WIN) return 'PATH';
  return Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'Path';
}
function pathEntries(env = process.env) {
  return String(env[pathKey(env)] || '').split(path.delimiter).filter(Boolean);
}
// A copy of env whose PATH is `entries` (deduplicated, order kept).
function withPath(env, entries) {
  const out = { ...env };
  const key = pathKey(out);
  if (IS_WIN) for (const k of Object.keys(out)) if (k.toUpperCase() === 'PATH' && k !== key) delete out[k];
  const seen = new Set();
  out[key] = entries.filter(e => {
    const id = IS_WIN ? e.toLowerCase() : e;
    if (!e || seen.has(id)) return false;
    seen.add(id); return true;
  }).join(path.delimiter);
  return out;
}

// The first executable called `name` on PATH, or null. On Windows the
// PATHEXT extensions are tried (pi.cmd, git.exe); a name with an extension
// is taken as is.
function findOnPath(name, env = process.env) {
  if (!name) return null;
  if (path.isAbsolute(name)) return isExecutable(name) ? name : null;
  const exts = IS_WIN && !path.extname(name)
    ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of pathEntries(env)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}
function isExecutable(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (IS_WIN) return true;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

// ---- paths ----------------------------------------------------------------

// Whether filesystems here compare names without case: Windows and the
// default macOS volume. A guess by platform; precise enough for access
// checks, which also resolve real paths first.
const CASE_INSENSITIVE = IS_WIN || IS_MAC;
const sameCase = p => CASE_INSENSITIVE ? p.toLowerCase() : p;

// Is `child` the folder `parent` or inside it? Both are resolved first; a
// sibling that merely starts with the same letters ("/a/b" vs "/a/bc") is
// outside. This is the one containment test for access checks.
function isInside(child, parent) {
  if (!child || !parent) return false;
  const rel = path.relative(sameCase(path.resolve(parent)), sameCase(path.resolve(child)));
  return rel === '' || (!!rel && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function samePath(a, b) {
  return !!a && !!b && sameCase(path.resolve(a)) === sameCase(path.resolve(b));
}
// A path as it appears in records and URLs: forward slashes everywhere.
// Records stay comparable across machines; native paths are for the disk.
function toPortable(p) { return String(p || '').split(path.sep).join('/'); }
function fromPortable(p) { return IS_WIN ? String(p || '').split('/').join(path.sep) : String(p || ''); }
// Is this string an absolute path on this system? ("C:\x", "\\server\share"
// on Windows; "/x" elsewhere.)
function isAbsolutePath(p) { return typeof p === 'string' && !!p && path.isAbsolute(p); }

// ---- Chattering's own folders ---------------------------------------------

// Where Chattering keeps what it makes.
//   config: settings, people, peers (small, precious)
//   data:   reading heads, guests' homes, preview secrets (precious)
//   cache:  indexes and derived files (rebuildable)
//   notes:  notes and memory (the person's; visible on purpose)
// Each folder that already exists where Chattering has always kept it
// (~/.config, ~/.local/share, ~/.cache) stays there, on every system: an
// update never moves anyone's files. A new install on macOS or Windows
// uses that system's per-user application folders instead. Environment
// overrides win over both.
function appDirs(env = process.env, home = os.homedir(), exists = fs.existsSync) {
  const legacy = {
    config: path.join(home, '.config', 'chattering'),
    data: path.join(home, '.local', 'share', 'chattering'),
    cache: path.join(home, '.cache', 'chattering'),
  };
  let native = legacy;
  if (IS_WIN) {
    const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    native = { config: path.join(roaming, 'Chattering'), data: path.join(local, 'Chattering', 'data'), cache: path.join(local, 'Chattering', 'cache') };
  } else if (IS_MAC) {
    const support = path.join(home, 'Library', 'Application Support', 'Chattering');
    native = { config: support, data: path.join(support, 'data'), cache: path.join(home, 'Library', 'Caches', 'Chattering') };
  }
  const choose = k => {
    const override = env['CHATTERING_' + k.toUpperCase() + '_DIR'];
    if (override && String(override).trim()) return String(override).trim();
    return exists(legacy[k]) ? legacy[k] : native[k];
  };
  return {
    config: choose('config'), data: choose('data'), cache: choose('cache'),
    notes: (env.CHATTERING_NOTES_DIR && String(env.CHATTERING_NOTES_DIR).trim()) || path.join(home, 'notes', 'chattering'),
  };
}

// ---- the desktop ------------------------------------------------------------

// How to open a file with its default application, or show it in the file
// manager: { file, args } to spawn, or null when this host has no desktop
// to ask. Never a shell string: paths with spaces, quotes and & stay
// arguments.
function openCommand(abs, { reveal = false, env = process.env } = {}) {
  if (IS_WIN) {
    // explorer.exe returns 1 even on success; callers must not treat that as failure.
    return reveal ? { file: 'explorer.exe', args: ['/select,', abs], exitOk: [0, 1] } : { file: 'explorer.exe', args: [abs], exitOk: [0, 1] };
  }
  if (IS_MAC) return reveal ? { file: 'open', args: ['-R', abs] } : { file: 'open', args: [abs] };
  if (IS_WSL) return null; // the server asks the Windows side (wslpath + explorer) itself
  const opener = findOnPath('xdg-open', env) || findOnPath('gio', env);
  if (!opener) return null;
  const target = reveal ? path.dirname(abs) : abs;
  return path.basename(opener) === 'gio' ? { file: opener, args: ['open', target] } : { file: opener, args: [target] };
}

module.exports = {
  PLATFORM, IS_WIN, IS_MAC, IS_LINUX, IS_WSL, hostKind,
  pathKey, pathEntries, withPath, findOnPath, isExecutable,
  CASE_INSENSITIVE, isInside, samePath, toPortable, fromPortable, isAbsolutePath,
  appDirs, openCommand,
};
