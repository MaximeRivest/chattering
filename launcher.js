#!/usr/bin/env node
'use strict';
// launcher.js — the `chattering-app` command of a Chattering download
// (design/71). One program for every system:
//
//   chattering-app            start Chattering if needed, open it in the browser
//   chattering-app start      start it in the background, no browser
//   chattering-app stop       stop it (waits for running work; --force stops it)
//   chattering-app status     is it running, which version, where
//   chattering-app url        print the signed-in address (for scripts)
//   chattering-app logs       print the server's recent log
//   chattering-app autostart on|off   start with the session
//   chattering-app update [--force]   install the newest release, keep the old one
//   chattering-app rollback   go back to the previous version
//   chattering-app version
//
// The server runs as the signed-in person, on this machine only, in the
// background: closing the browser does not stop work; `stop` does. A
// running Chattering is recognised by asking it with this install's token,
// not by a port that happens to answer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync, execFileSync } = require('child_process');
const platform = require('./platform.js');
const runtime = require('./runtime.js');

const APP_DIR = __dirname;
const VERSION = (() => { try { return require('./package.json').version; } catch { return 'dev'; } })();
const DIRS = platform.appDirs();
const STATE_FILE = path.join(DIRS.data, 'server.json');
const LOG_DIR = path.join(DIRS.data, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');
const TOKEN_FILE = path.join(DIRS.cache, 'lan-token');
const REPO = process.env.CHATTERING_RELEASE_REPO || 'MaximeRivest/chattering';
// Where a download lives: versions/<v>/ beside bin/ (install scripts). A
// checkout run directly has no such parent; update is refused there.
const INSTALL_HOME = path.basename(path.dirname(APP_DIR)) === 'versions' ? path.dirname(path.dirname(APP_DIR)) : null;

const say = m => process.stdout.write(m + '\n');
const fail = m => { process.stderr.write('chattering: ' + m + '\n'); process.exit(1); };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const token = () => { try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch { return ''; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- the running server ---------------------------------------------------------
async function ask(port, route, opts = {}) {
  const t = token();
  if (!t) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { ...opts, headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout || 3000) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch { return null; }
}
// { port, status } of this install's running server, or null.
async function running() {
  const state = readJson(STATE_FILE);
  if (!state || !state.port) return null;
  const r = await ask(state.port, '/api/app/status');
  return r && r.status === 200 && r.body.app === 'chattering' ? { port: state.port, status: r.body, state } : null;
}
function portFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
async function freePort(from, avoid = []) {
  for (let p = from; p < from + 200; p++) if (!avoid.includes(p) && await portFree(p)) return p;
  throw new Error('no free port from ' + from);
}
async function start({ quiet = false } = {}) {
  const already = await running();
  if (already) return already;
  const port = await freePort(Number(process.env.PORT) || 7433);
  const preview = await freePort(port + 2, [port]);
  const tls = await freePort(port + 10, [port, preview]);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  // The previous run's log stays one generation.
  try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch {}
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(runtime.nodePath(), [path.join(APP_DIR, 'server.js')], {
    cwd: APP_DIR, detached: true, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, PORT: String(port), CHATTERING_PREVIEW_PORT: String(preview), CHATTERING_TLS_PORT: String(tls) },
  });
  child.unref();
  fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: child.pid, port, version: VERSION, appDir: APP_DIR, startedAt: Date.now() }, null, 2));
  if (!quiet) say('Starting Chattering…');
  for (let i = 0; i < 600; i++) {
    if (child.exitCode !== null) break;
    const r = await ask(port, '/api/app/status');
    if (r && r.status === 200) return { port, status: r.body };
    await sleep(100);
  }
  let tail = '';
  try { tail = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-20).join('\n'); } catch {}
  throw new Error('Chattering did not start. The end of its log (' + LOG_FILE + '):\n' + tail);
}
function signedInUrl(port) { return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token())}`; }

// ---- the browser ------------------------------------------------------------------------
// An app window from Chrome, Edge or Chromium when one is installed (its
// own window, no tabs); else the default browser.
function appBrowser() {
  const candidates = platform.IS_WIN
    ? [path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
       path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
       path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')]
    : platform.IS_MAC
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'].map(n => platform.findOnPath(n)).filter(Boolean);
  return candidates.find(c => c && fs.existsSync(c)) || null;
}
function openBrowser(url) {
  if (process.env.CHATTERING_NO_BROWSER === '1') return false;
  const app = appBrowser();
  const cmd = app ? { file: app, args: ['--app=' + url] } : platform.openCommand(url);
  if (!cmd) return false;
  const c = spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: false });
  c.on('error', () => {});
  c.unref();
  return true;
}

// ---- stop ---------------------------------------------------------------------------------
async function stop({ force = false } = {}) {
  const r = await running();
  if (!r) { say('Chattering is not running.'); return true; }
  const answer = await ask(r.port, '/api/app/stop', { method: 'POST', body: JSON.stringify({ force }) });
  if (answer && answer.status === 409) { say(answer.body.error + '. Use: chattering-app stop --force'); return false; }
  for (let i = 0; i < 150; i++) { if (!(await running())) { say('Chattering stopped.'); return true; } await sleep(100); }
  // Did not stop within fifteen seconds: end it.
  if (r.state && r.state.pid) require('./processes.js').stopTree(r.state.pid, 'SIGKILL');
  say('Chattering was stopped forcefully.');
  return true;
}

// ---- start with the session ---------------------------------------------------------------------
function launcherCommand() {
  // Through the install's bin/ shim when there is one, so an update moves it.
  if (INSTALL_HOME) return platform.IS_WIN ? [path.join(INSTALL_HOME, 'bin', 'chattering-app.cmd')] : [path.join(INSTALL_HOME, 'bin', 'chattering-app')];
  return [runtime.nodePath(), path.join(APP_DIR, 'launcher.js')];
}
function autostart(on) {
  const cmd = launcherCommand();
  if (platform.IS_MAC) {
    const f = path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.rockfrog.chattering.plist');
    if (!on) { spawnSync('launchctl', ['unload', f]); try { fs.unlinkSync(f); } catch {} return f; }
    const args = [...cmd, 'start'].map(a => `<string>${a.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`).join('');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>dev.rockfrog.chattering</string><key>ProgramArguments</key><array>${args}</array><key>RunAtLoad</key><true/></dict></plist>\n`);
    return f;
  }
  if (platform.IS_WIN) {
    const f = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Chattering.cmd');
    if (!on) { try { fs.unlinkSync(f); } catch {} return f; }
    fs.writeFileSync(f, `@echo off\r\n${cmd.map(a => `"${a}"`).join(' ')} start\r\n`);
    return f;
  }
  const f = path.join(os.homedir(), '.config', 'autostart', 'chattering.desktop');
  if (!on) { try { fs.unlinkSync(f); } catch {} return f; }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `[Desktop Entry]\nType=Application\nName=Chattering\nExec=${cmd.map(a => `"${a}"`).join(' ')} start\nX-GNOME-Autostart-enabled=true\n`);
  return f;
}

// ---- update and rollback -------------------------------------------------------------------------
function assetName(version) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const osName = platform.IS_WIN ? 'win' : platform.IS_MAC ? 'macos' : 'linux';
  return `chattering-${version}-${osName}-${arch}.${platform.IS_WIN ? 'zip' : 'tar.gz'}`;
}
async function download(url, file) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(url + ': ' + r.status);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}
function setCurrent(version) {
  // Windows reads a pointer file (no symlinks without privileges); Unix a link.
  fs.writeFileSync(path.join(INSTALL_HOME, 'current.txt'), version + '\n');
  if (!platform.IS_WIN) {
    const link = path.join(INSTALL_HOME, 'current'), tmp = link + '.tmp';
    try { fs.unlinkSync(tmp); } catch {}
    fs.symlinkSync(path.join('versions', version), tmp);
    fs.renameSync(tmp, link);
  }
}
async function update({ force = false } = {}) {
  if (!INSTALL_HOME) fail('this Chattering is not a download (it runs from ' + APP_DIR + '); update it the way it was installed.');
  const api = process.env.CHATTERING_RELEASE_API || `https://api.github.com/repos/${REPO}/releases/latest`;
  const rel = await (await fetch(api, { headers: { Accept: 'application/vnd.github+json' } })).json();
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  if (!latest) fail('could not read the latest release');
  if (latest === VERSION) { say('Chattering ' + VERSION + ' is the latest.'); return; }
  const r = await running();
  if (r && r.status.activeRuns && !force) fail(r.status.activeRuns + ' run(s) are working. Update when they finish, or: chattering-app update --force');
  const name = assetName(latest);
  const asset = (rel.assets || []).find(a => a.name === name), sums = (rel.assets || []).find(a => a.name === 'SHA256SUMS');
  if (!asset || !sums) fail('the release ' + latest + ' has no ' + name);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chattering-update-'));
  try {
    say('Downloading ' + name + '…');
    await download(asset.browser_download_url, path.join(tmp, name));
    await download(sums.browser_download_url, path.join(tmp, 'SHA256SUMS'));
    const want = fs.readFileSync(path.join(tmp, 'SHA256SUMS'), 'utf8').split('\n').map(l => l.trim().split(/\s+/)).find(([, n]) => n === name);
    const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp, name))).digest('hex');
    if (!want || want[0] !== got) fail('the download does not match its checksum; nothing was changed');
    const dest = path.join(INSTALL_HOME, 'versions', latest), staging = dest + '.partial';
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    // tar reads .tar.gz everywhere and .zip on Windows 10 and later.
    // Windows' own tar.exe reads zip; another tar on PATH (Git's) may not.
    const tarBin = platform.IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const x = spawnSync(tarBin, ['-xf', path.join(tmp, name), '-C', staging], { stdio: 'inherit' });
    if (x.status !== 0) fail('could not unpack ' + name);
    const inner = fs.readdirSync(staging).length === 1 ? path.join(staging, fs.readdirSync(staging)[0]) : staging;
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(inner, dest);
    fs.rmSync(staging, { recursive: true, force: true });
    const wasRunning = !!r;
    if (wasRunning && !(await stop({ force }))) fail('could not stop the running Chattering; the new version is unpacked, not switched to');
    fs.writeFileSync(path.join(INSTALL_HOME, 'previous.txt'), VERSION + '\n');
    setCurrent(latest);
    say('Chattering ' + latest + ' is installed (' + VERSION + ' is kept: chattering-app rollback).');
    if (wasRunning) {
      const next = spawn(path.join(INSTALL_HOME, 'versions', latest, 'runtime', 'node', platform.IS_WIN ? 'node.exe' : path.join('bin', 'node')), [path.join(dest, 'launcher.js'), 'start'], { stdio: 'inherit' });
      await new Promise(res => next.on('exit', res));
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
async function rollback() {
  if (!INSTALL_HOME) fail('this Chattering is not a download');
  let prev = '';
  try { prev = fs.readFileSync(path.join(INSTALL_HOME, 'previous.txt'), 'utf8').trim(); } catch {}
  if (!prev || !fs.existsSync(path.join(INSTALL_HOME, 'versions', prev))) fail('there is no previous version to go back to');
  await stop({ force: false }) || fail('work is running; stop it first');
  fs.writeFileSync(path.join(INSTALL_HOME, 'previous.txt'), VERSION + '\n');
  setCurrent(prev);
  say('Back to Chattering ' + prev + '. Start it: chattering-app');
}

// ---- main -----------------------------------------------------------------------------------------
async function main(argv) {
  const [cmd = 'open', ...rest] = argv;
  const force = rest.includes('--force');
  try {
    if (cmd === 'open') { const r = await start(); if (!openBrowser(signedInUrl(r.port))) say('Open ' + signedInUrl(r.port)); return; }
    if (cmd === 'start') { const r = await start({ quiet: true }); say('Chattering ' + (r.status.version || '') + ' is running on port ' + r.port + '.'); return; }
    if (cmd === 'stop') { process.exitCode = (await stop({ force })) ? 0 : 1; return; }
    if (cmd === 'url') { const r = await running(); if (!r) fail('Chattering is not running (start it: chattering-app start)'); say(signedInUrl(r.port)); return; }
    if (cmd === 'status') {
      const r = await running();
      if (!r) { say('Chattering is not running.'); process.exitCode = 3; return; }
      say(`Chattering ${r.status.version} is running on port ${r.port} (pid ${r.status.pid}), Pi ${r.status.pi || 'not found'}, ${r.status.activeRuns} run(s) working.\nProgram: ${r.status.appDir}\nData: ${DIRS.config}, ${DIRS.data}, ${DIRS.cache}, ${DIRS.notes}`);
      return;
    }
    if (cmd === 'logs') { try { process.stdout.write(fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-200).join('\n')); } catch { say('No log yet.'); } return; }
    if (cmd === 'autostart') { const on = rest[0] !== 'off'; say((on ? 'Chattering will start with your session: ' : 'Chattering no longer starts with your session: ') + autostart(on)); return; }
    if (cmd === 'update') return await update({ force });
    if (cmd === 'rollback') return await rollback();
    if (cmd === 'version' || cmd === '--version') { say('Chattering ' + VERSION + ' · Node ' + process.version + ' · Pi ' + (runtime.piVersion() || 'not found')); return; }
    if (cmd === 'help' || cmd === '--help' || cmd === '-h') { say(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 17).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
    fail('unknown command "' + cmd + '" (chattering-app help)');
  } catch (e) { fail(e.message); }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { main, assetName, start, stop, running, INSTALL_HOME };
