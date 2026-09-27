'use strict';
// The Chromium the browser tests start: a plain one that takes its own
// temporary profile and a debugging port.
//
// On the desktops here `chromium` on PATH is the shared everyday browser's
// launcher (~/Projects/os/desktop/agent-browser): it forwards to the one
// running browser and refuses --user-data-dir and --remote-debugging-port.
// The Chromium it wraps is named in its controller script
// (AGENT_BROWSER_CHROMIUM), the same build the desktop runs; its own docs
// say tests use that one. Elsewhere `chromium` is used as is.
//
// Override: CHATTERING_TEST_CHROMIUM (or CHROMIUM_BIN, CHROMIUM).
const fs = require('node:fs');
const path = require('node:path');

let cached;

function onPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

// A launcher script's text, or '' for a real binary (never read those whole).
function smallScript(p) {
  try { return fs.statSync(p).size < 64 * 1024 ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; }
}

function chromiumBinary() {
  if (cached) return cached;
  for (const v of ['CHATTERING_TEST_CHROMIUM', 'CHROMIUM_BIN', 'CHROMIUM']) if (process.env[v]) return (cached = process.env[v]);
  const found = onPath('chromium');
  if (!found) return (cached = 'chromium');
  const controller = smallScript(fs.realpathSync(found)).match(/exec "([^"]+\/bin\/agent-browser)"/);
  const inner = controller && smallScript(controller[1]).match(/AGENT_BROWSER_CHROMIUM=(['"]?)([^'"\s]+)\1/);
  return (cached = inner && fs.existsSync(inner[2]) ? inner[2] : found);
}

// Flags every test's browser needs on every system, whatever else the test
// adds. On macOS a fresh profile asks the Keychain for its storage key and
// waits for a person to allow it: the mock keychain and basic password
// store make it ask nobody. The rest keep a headless run quiet and alone.
const CHROMIUM_TEST_FLAGS = ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--use-mock-keychain', '--password-store=basic',
  '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-component-update'];
// Is the test browser there? Found, never run: on Windows `chrome.exe
// --version` opens a browser and does not return, so asking it would hang.
function chromiumAvailable() {
  const bin = chromiumBinary();
  if (path.isAbsolute(bin)) { try { return fs.statSync(bin).isFile(); } catch { return false; } }
  return !!require('../../platform.js').findOnPath(bin);
}
module.exports = { chromiumBinary, chromiumAvailable, CHROMIUM_TEST_FLAGS };
