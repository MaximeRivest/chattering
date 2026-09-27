'use strict';
// runtime.js — which Pi Chattering runs, and how it is started (design/70).
//
// One answer for every place Pi runs: the SDK loaded in workers, model
// listing, one-shot calls, RPC sessions, terminals, delegated work. Pi is
// started as `<node> <pi's cli.js>`, never through the `pi` shim on PATH:
// a shim is a symlink on Unix and a .cmd batch file on Windows (which
// cannot be spawned without a shell, and a shell would reinterpret the
// arguments), and PATH differs between a service and a terminal.
//
// Which Pi, in order:
//   1. CHATTERING_PI_PACKAGE_DIR — named explicitly (sandboxes, tests).
//   2. The runtime shipped beside this code (runtime/node_modules), the
//      exact version in runtime/package-lock.json. Downloads carry it.
//   3. A Pi the person installed: found on PATH, then in npm's usual
//      global folders and nvm's. A developer checkout uses this one.
// Which node: CHATTERING_NODE, else a node shipped beside this code
// (runtime/node), else the node running this server.
const fs = require('fs');
const os = require('os');
const path = require('path');
const platform = require('./platform.js');

const PI_PACKAGE = path.join('@earendil-works', 'pi-coding-agent');
// The Pi version Chattering is tested with and ships: the one pinned in
// runtime/package.json (and locked with its dependencies beside it).
const PI_TESTED_VERSION = require('./runtime/package.json').dependencies['@earendil-works/pi-coding-agent'];
const APP_DIR = __dirname;
const BUNDLED_PI = path.join(APP_DIR, 'runtime', 'node_modules', PI_PACKAGE);

// A folder is Pi's package when its package.json says so.
function isPiPackage(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === '@earendil-works/pi-coding-agent'; }
  catch { return false; }
}
// From a file inside the package (the bin target), up to the package.
function packageRootFrom(file) {
  let dir;
  try { dir = path.dirname(fs.realpathSync.native(file)); } catch { return null; }
  for (let i = 0; i < 6; i++) {
    if (isPiPackage(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function installedCandidates(env = process.env, home = os.homedir()) {
  const out = [];
  const shim = platform.findOnPath('pi', env);
  if (shim && !(platform.IS_WSL && shim.startsWith('/mnt/'))) {
    // Unix: a symlink into the package. Windows: pi.cmd in npm's prefix,
    // the package in node_modules beside it.
    out.push(() => packageRootFrom(shim));
    out.push(() => path.join(path.dirname(shim), 'node_modules', PI_PACKAGE));
    out.push(() => path.join(path.dirname(shim), '..', 'lib', 'node_modules', PI_PACKAGE));
  }
  // npm's global folder for the node running this server.
  const nodeDir = path.dirname(process.execPath);
  out.push(() => platform.IS_WIN ? path.join(nodeDir, 'node_modules', PI_PACKAGE) : path.join(nodeDir, '..', 'lib', 'node_modules', PI_PACKAGE));
  if (platform.IS_WIN && env.APPDATA) out.push(() => path.join(env.APPDATA, 'npm', 'node_modules', PI_PACKAGE));
  out.push(() => path.join(home, '.local', 'lib', 'node_modules', PI_PACKAGE));
  out.push(() => path.join(home, '.npm-global', 'lib', 'node_modules', PI_PACKAGE));
  // Every nvm node, newest first.
  out.push(() => {
    const base = path.join(home, '.nvm', 'versions', 'node');
    const vnum = v => v.replace(/^v/, '').split('.').map(n => Number(n) || 0);
    let versions = [];
    try { versions = fs.readdirSync(base).sort((a, b) => { const x = vnum(a), y = vnum(b); return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]); }); } catch {}
    for (const v of versions) { const dir = path.join(base, v, 'lib', 'node_modules', PI_PACKAGE); if (isPiPackage(dir)) return dir; }
    return null;
  });
  if (!platform.IS_WIN) out.push(() => path.join('/usr/local/lib/node_modules', PI_PACKAGE), () => path.join('/usr/lib/node_modules', PI_PACKAGE));
  return out;
}

let cached = null;
// { dir, source: 'env' | 'bundled' | 'installed' } or null.
function locatePi({ env = process.env, home = os.homedir(), fresh = false } = {}) {
  if (cached && !fresh && env === process.env) return cached;
  let found = null;
  const named = env.CHATTERING_PI_PACKAGE_DIR;
  if (named && isPiPackage(named)) found = { dir: path.resolve(named), source: 'env' };
  else if (isPiPackage(BUNDLED_PI)) found = { dir: BUNDLED_PI, source: 'bundled' };
  else {
    for (const candidate of installedCandidates(env, home)) {
      let dir = null;
      try { dir = candidate(); } catch {}
      if (dir && isPiPackage(dir)) { found = { dir: path.resolve(dir), source: 'installed' }; break; }
    }
  }
  if (env === process.env) cached = found;
  return found;
}

function piPackageDir(opts) {
  const found = locatePi(opts);
  if (!found) throw new Error('Pi is not installed: install it (npm install -g @earendil-works/pi-coding-agent) or use a Chattering download, which includes it.');
  return found.dir;
}
function piVersion(opts) {
  try { return JSON.parse(fs.readFileSync(path.join(piPackageDir(opts), 'package.json'), 'utf8')).version || null; } catch { return null; }
}
// Pi's command-line entry: the package's own bin target.
function piCliPath(opts) {
  const dir = piPackageDir(opts);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.pi;
  if (!bin) throw new Error('the Pi package at ' + dir + ' names no command');
  return path.join(dir, bin);
}

function nodePath(env = process.env) {
  if (env.CHATTERING_NODE && platform.isExecutable(env.CHATTERING_NODE)) return env.CHATTERING_NODE;
  const bundled = path.join(APP_DIR, 'runtime', 'node', platform.IS_WIN ? 'node.exe' : path.join('bin', 'node'));
  if (platform.isExecutable(bundled)) return bundled;
  return process.execPath;
}

// How to start Pi with these arguments: { file, args } for spawn/execFile.
// CHATTERING_PI still names a whole command (an existing override).
// CHATTERING_PI_CLI names a JavaScript file to run in Pi's place, started
// like Pi (node + file): the portable seam tests use for a fake Pi.
function piCommand(args = [], { env = process.env } = {}) {
  if (env.CHATTERING_PI) return { file: env.CHATTERING_PI, args: [...args] };
  if (env.CHATTERING_PI_CLI) return { file: nodePath(env), args: [env.CHATTERING_PI_CLI, ...args] };
  return { file: nodePath(env), args: [piCliPath({ env }), ...args] };
}
// The same as one argv array (for terminals, which take a command line).
function piArgv(args = [], opts) { const c = piCommand(args, opts); return [c.file, ...c.args]; }

// The folder Pi keeps a working directory's sessions in, named exactly as
// Pi names it (session-manager getDefaultSessionDirPath): one leading
// separator dropped, then every / \\ and : a dash. "C:\\Users\\x" and
// "/home/x" both give a valid folder name on every system.
function piSessionDirName(cwd) {
  return '--' + path.resolve(String(cwd || '.')).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--';
}

// Pi's own folder (settings, auth, sessions, extensions, modes), by Pi's
// rule (config.js getAgentDir): PI_CODING_AGENT_DIR, else ~/.pi/agent.
function piAgentDir(env = process.env, home = os.homedir()) {
  const named = env.PI_CODING_AGENT_DIR;
  if (named) return named === '~' ? home : named.startsWith('~/') || named.startsWith('~\\') ? path.join(home, named.slice(2)) : path.resolve(named);
  return path.join(home, '.pi', 'agent');
}

module.exports = { piAgentDir, piSessionDirName, PI_TESTED_VERSION, PI_PACKAGE, BUNDLED_PI, isPiPackage, locatePi, piPackageDir, piVersion, piCliPath, nodePath, piCommand, piArgv };
