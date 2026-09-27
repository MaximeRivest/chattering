'use strict';
// win-hide.js — on Windows, no program Chattering or its agents start opens
// a window of its own (design/70).
//
// Chattering runs in the background with no console. When a process without
// a console starts a console program (git, bash, rg, python, powershell),
// Windows gives that program a new, visible console window: one flash per
// command, dozens per agent step. Node avoids it only when asked, per call
// (`windowsHide: true`, CREATE_NO_WINDOW). Such a program then has a console
// without a window, and everything it starts shares that hidden console.
//
// This module makes that the default in the process that loads it: every way
// Node starts a program (spawn, execFile, exec, fork and their Sync forms,
// promisified or not, required or imported as an ES module) hides the window
// unless the call says `windowsHide: false` (a browser window, say).
//
// Loaded first by every Node program of Chattering (server, launcher, the Pi
// worker, the delegation supervisor, the AI accounts helper), and put into
// every Pi process with `node --require <this file>` (runtime.piCommand),
// because Pi starts rg, fd, git and extension commands without asking.
// Then each process in the tree either loads this module, or was started
// with a hidden console that its own children inherit.
//
// One rule stays with the caller: `detached: true` on Windows means no
// console at all, and Windows then ignores the request to hide. Detach only
// Node programs that load this module, or window programs (explorer).
//
// Does nothing on other systems.
const PATCHED = Symbol.for('chattering.winHide');

// The arguments of a child_process call with windowsHide: true in its
// options, unless the call already says. Options sit after an optional args
// array (spawn, execFile, fork and their Sync forms: afterArgs) or right
// after the command (exec, execSync). A missing args slot given as null or
// undefined before later arguments stays where it is.
function withHidden(args, { afterArgs = true } = {}) {
  const a = [...args];
  const empty = v => v === undefined || v === null;
  const isOptions = v => v && typeof v === 'object' && !Array.isArray(v);
  let i = 1;
  if (afterArgs && (Array.isArray(a[1]) || (empty(a[1]) && a.length > 2))) i = 2;
  if (isOptions(a[i])) {
    if (a[i].windowsHide === undefined) a[i] = { ...a[i], windowsHide: true };
  } else if (empty(a[i])) {
    a[i] = { windowsHide: true };
  } else if (typeof a[i] === 'function') {
    a.splice(i, 0, { windowsHide: true }); // before the callback
  }
  return a;
}

function install(cp = require('child_process')) {
  if (cp[PATCHED]) return false;
  const util = require('util');
  const wrap = (name, afterArgs) => {
    const original = cp[name];
    const wrapped = function (...args) { return original.apply(this, withHidden(args, { afterArgs })); };
    // promisify(execFile) and promisify(exec) resolve { stdout, stderr }
    // through a custom form; keep it, hidden too.
    if (original[util.promisify.custom]) {
      const custom = original[util.promisify.custom];
      wrapped[util.promisify.custom] = (...args) => custom(...withHidden(args, { afterArgs }));
    }
    Object.defineProperty(wrapped, 'name', { value: name });
    cp[name] = wrapped;
  };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) wrap(name, true);
  for (const name of ['exec', 'execSync']) wrap(name, false);
  cp[PATCHED] = true;
  // `import { spawn } from 'node:child_process'` (Pi is ES modules) reads
  // the built-in's ESM bindings: bring them in line with the patched ones.
  require('module').syncBuiltinESMExports();
  return true;
}

if (process.platform === 'win32' && process.env.CHATTERING_WIN_HIDE !== '0') install();

module.exports = { withHidden, install, file: __filename };
