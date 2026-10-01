'use strict';
// The two parts a live terminal needs, from the runtime shipped beside the
// app (runtime/node_modules, exact versions in runtime/package-lock.json):
//   @lydell/node-pty  a pseudoterminal (Microsoft's node-pty, published with
//                     its compiled part for Linux, macOS and Windows, x64
//                     and arm64: nothing to build on install)
//   @xterm/headless   the terminal engine of VS Code's terminal, without a
//                     window: the exact screen a program draws
// Loaded on first use only: Chattering without them works, and says why
// this feature does not.
const path = require('node:path');

const APP_DIR = path.join(__dirname, '..', '..');
let loaded = null;

function from(name) {
  const errors = [];
  for (const where of [path.join(APP_DIR, 'runtime', 'node_modules', name), name]) {
    try { return require(where); } catch (e) { errors.push(e.message.split('\n')[0]); }
  }
  throw new Error(errors[errors.length - 1]);
}

function terminalDeps() {
  if (loaded) return loaded;
  try {
    loaded = { pty: from('@lydell/node-pty'), Terminal: from('@xterm/headless').Terminal };
  } catch (e) {
    loaded = { error: 'The live terminal needs its runtime parts (in the Chattering folder: npm ci --prefix runtime): ' + e.message };
  }
  return loaded;
}

module.exports = { terminalDeps };
