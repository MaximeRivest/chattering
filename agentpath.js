'use strict';
// Build the PATH agents run with. User tool dirs go first; system dirs go
// last so they never shadow what the service already has. On NixOS this
// matters: /run/wrappers/bin (setuid sudo, ping, mount…) must stay ahead of
// /run/current-system/sw/bin, whose sudo is the unwrapped binary and refuses
// to run. Every dir appears once, so the result is idempotent: feeding the
// output back in as process.env.PATH yields the same string. pisdk.mergeEnv
// depends on that to stop rewriting process.env after the first call.
//
// Every system (design/70): the separator is the system's (";" on
// Windows), NixOS and snap folders are added only where they exist, and the
// folder of the node running Chattering comes along, so an agent's `node`
// is the one Pi runs on. On Windows, entries compare without case.
const fs = require('fs');
const os = require('os');
const path = require('path');

const WRAPPERS = '/run/wrappers/bin';
const SW_BIN = '/run/current-system/sw/bin';

const defaultExists = d => { try { return fs.existsSync(d); } catch { return false; } };

// `opts.exists`, `opts.home`, `opts.platform` and `opts.nodeDir` are
// injection points for tests; production callers pass nothing.
function agentPath(current, opts = {}) {
  const exists = opts.exists || defaultExists;
  const home = opts.home || os.homedir();
  const win = (opts.platform || process.platform) === 'win32';
  const p = win ? path.win32 : path.posix;
  const delimiter = win ? ';' : ':';
  const nodeDir = opts.nodeDir === undefined ? path.dirname(process.execPath) : opts.nodeDir;
  const userDirs = [
    ...(win ? [] : [p.join(home, '.local', 'bin')]),
    nodeDir,
  ].filter(d => d && exists(d));
  const systemDirs = win ? [] : [
    WRAPPERS, // NixOS setuid wrappers; must precede sw/bin
    SW_BIN,   // NixOS: xdg-open, git… live here
    '/snap/bin',
  ].filter(exists);
  const fallback = win ? 'C:\\Windows\\system32;C:\\Windows' : '/usr/bin:/bin';
  const base = (current || fallback).split(delimiter).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const d of [...userDirs, ...base, ...systemDirs]) {
    const id = win ? d.toLowerCase().replace(/\\+$/, '') : d;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(d);
  }
  // Enforce the NixOS invariant even when the inherited PATH had it wrong.
  const w = out.indexOf(WRAPPERS);
  const s = out.indexOf(SW_BIN);
  if (w > s && s >= 0) {
    out.splice(w, 1);
    out.splice(s, 0, WRAPPERS);
  }
  return out.join(delimiter);
}

module.exports = { agentPath, WRAPPERS, SW_BIN };
