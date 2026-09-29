'use strict';
// When this process read each of its own source files (design/82).
//
// "Is this change live?" has an exact answer for a running server: a file
// it loaded is out of date when the file on disk is newer than the version
// it compiled. Node keeps no load time, so this records the file's
// modification time at the moment it is compiled. Required first by
// server.js; the main script itself is stamped when this runs, a few
// milliseconds after it was read.
const fs = require('node:fs');
const Module = require('node:module');

const stamps = new Map();
const stamp = file => { try { stamps.set(file, fs.statSync(file).mtimeMs); } catch {} };
// Already loaded: the main script, whatever it required before this, and
// this file. Stamped now, the closest moment to their load.
for (const file of Object.keys(require.cache)) stamp(file);
if (require.main?.filename) stamp(require.main.filename);
for (const ext of ['.js', '.cjs', '.json']) {
  const load = Module._extensions[ext];
  if (typeof load !== 'function' || load.chatteringStamped) continue;
  const stamped = function (module, filename) { stamp(filename); return load.call(this, module, filename); };
  stamped.chatteringStamped = true;
  Module._extensions[ext] = stamped;
}

// The files this process loaded from disk, each with the modification time
// it had then. Never stamped later: a late stamp would hide the very
// staleness it is asked about.
function loaded() { return stamps; }

module.exports = { loaded };
