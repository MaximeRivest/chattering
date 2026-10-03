#!/usr/bin/env node
'use strict';
require('./win-hide.js'); // first: on Windows nothing this starts opens a window (design/70)
// hotkeys-device.js — the hotkey helper on a person's computer (design/93).
// `chattering-app hotkeys …` runs it; so can `node hotkeys-device.js …`.
//
//   connect [ADDRESS]   link this computer to the person's Chattering: shows a
//                       code, opens the page that approves it, waits
//   run                 stay running: keep the person's hotkeys on the
//                       desktop and do the work when one is pressed
//   press ID            (what a hotkey runs) hand one press to `run`
//   status              linked to whom, which hotkeys, which are live
//   forget              unlink this computer
//
// The Chattering that holds the hotkeys can be this computer's own or
// another one (lambda for the household). The helper talks to it with the
// computer's own credential (chk_…), which opens the hotkey routes for one
// person and nothing else. The text a hotkey reads goes to that Chattering,
// to the program; nothing is kept here but the list of hotkeys.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const MAX_CHARS = 20000;
const LONG_POLL_S = 25;

function dirs() { return require('./platform.js').appDirs(); }
const linkFile = () => path.join(dirs().data, 'hotkeys-device.json');
const statusFile = () => path.join(dirs().cache, 'hotkeys-status.json');
function socketPath() {
  if (process.platform === 'win32') return '\\\\.\\pipe\\chattering-hotkeys-' + os.userInfo().username;
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(base, process.env.XDG_RUNTIME_DIR ? 'chattering-hotkeys.sock' : `chattering-hotkeys-${process.getuid ? process.getuid() : 'user'}.sock`);
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.error('[hotkeys]', ...a);

// This computer's own Chattering, when no address is given.
function localAddress() {
  const st = readJson(path.join(dirs().data, 'server.json'));
  return 'http://127.0.0.1:' + ((st && st.port) || Number(process.env.CHATTERING_PORT) || 7433);
}

async function call(link, method, route, body, { timeoutMs = 15000 } = {}) {
  const res = await fetch(link.server.replace(/\/+$/, '') + route, {
    method,
    headers: { ...(link.credential ? { Authorization: 'Bearer ' + link.credential } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `${route} answered ${res.status}`), { status: res.status, data });
  return data;
}

// ---- connect ------------------------------------------------------------------

function openInBrowser(url) {
  const cmd = require('./platform.js').openCommand(url);
  if (!cmd) return false;
  try { spawn(cmd.file, cmd.args, { stdio: 'ignore', detached: true }).unref(); return true; } catch { return false; }
}

async function connect(args) {
  const address = (args.find(a => !a.startsWith('-')) || localAddress()).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(address)) throw new Error(`${address} is not an address (like https://lambda.example.ts.net).`);
  const desk = require('./hotkeys-desktop.js').detect();
  const start = await call({ server: address }, 'POST', '/api/hotkeys/pair', { name: os.hostname(), os: process.platform, desktop: desk.label });
  const approve = `${address}/#hotkeys-connect=${encodeURIComponent(start.code)}`;
  console.log(`\nLink this computer to your hotkeys in Chattering.\n\n  Code:   ${start.code}\n  Open:   ${approve}\n\nSign in there as yourself and approve the code (it lasts ten minutes).`);
  if (!args.includes('--no-browser') && openInBrowser(approve)) console.log('(The page is opening in your browser.)');
  const until = Date.now() + start.expiresIn * 1000;
  while (Date.now() < until) {
    await sleep(2000);
    let r;
    try { r = await call({ server: address }, 'POST', '/api/hotkeys/pair/poll', { pairing: start.pairing }); }
    catch (e) { if (e.status) throw e; continue; } // the network blinked: ask again
    if (r.state === 'waiting') continue;
    if (r.state === 'denied') throw new Error('The code was refused on the page.');
    if (r.state === 'expired') throw new Error('The code expired. Run connect again.');
    if (r.state === 'linked') {
      writeJson(linkFile(), { server: address, credential: r.credential, computer: r.computer, linkedAt: new Date().toISOString() });
      const me = await call({ server: address, credential: r.credential }, 'GET', '/api/hotkeys/device?since=-1');
      console.log(`\nLinked: ${os.hostname()} now runs ${me.person.name}'s hotkeys from ${address}.`);
      if (!desk.supported) console.log(`But ${desk.reason}`);
      // A running helper picks the new link up by itself.
      return;
    }
  }
  throw new Error('The code expired. Run connect again.');
}

// ---- run ------------------------------------------------------------------------

// The answer keeps the selection's surrounding space and line breaks, so
// replacing "word \n" leaves the space and the line break where they were.
function keepEdges(input, output) {
  if (!String(input).trim()) return input;
  const lead = input.match(/^\s*/)[0], trail = input.match(/\s*$/)[0];
  return lead + String(output).trim() + trail;
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function createHelper({ desk, readLink = () => readJson(linkFile()) }) {
  let link = readLink();
  let bindings = [];
  let person = null;
  let busy = false;
  let reported = null;

  async function applyAll() {
    const pressArgv = id => [process.execPath, __filename, 'press', id];
    let report;
    if (!desk.supported) report = bindings.map(b => ({ id: b.id, state: 'unsupported' }));
    else {
      try { report = await desk.apply(bindings, pressArgv); }
      catch (e) { log(e.message); report = bindings.map(b => ({ id: b.id, state: 'bad', by: e.message })); }
    }
    reported = report;
    writeJson(statusFile(), { server: link && link.server, person, at: new Date().toISOString(), desktop: desk.label, supported: desk.supported, reason: desk.reason || null, bindings: bindings.map(b => ({ ...b, ...(report.find(r => r.id === b.id) || {}) })) });
    if (link) call(link, 'POST', '/api/hotkeys/device/status', { desktop: desk.label, supported: desk.supported, reason: desk.reason || null, report }).catch(e => log('status: ' + e.message));
  }

  async function press(id) {
    const b = bindings.find(x => x.id === id);
    if (!b) return desk.notify('Chattering', 'This hotkey is not set up any more.');
    if (busy) return desk.notify('Chattering', 'Still working on the last hotkey.', { ms: 2000 });
    busy = true;
    const started = Date.now();
    let progress = 0;
    try {
      const win = await desk.focused();
      const text = b.input === 'selection' ? await desk.selection(win) : await desk.clipboardText();
      if (!text.trim()) return void await desk.notify(b.label, b.input === 'selection' ? 'Select some text first.' : 'The clipboard has no text.', { ms: 3000 });
      if (text.length > MAX_CHARS) return void await desk.notify(b.label, `That is ${text.length} characters; a hotkey takes at most ${MAX_CHARS}.`, { ms: 5000 });
      progress = await desk.notify(b.label + '…', '', { ms: 0 });
      const res = await call(link, 'POST', '/api/hotkeys/device/run', { id: b.id, text }, { timeoutMs: 3 * 60 * 1000 });
      await desk.dismiss(progress); progress = 0;
      let out = String(res.text || '');
      if (b.output === 'replace' || b.output === 'paste') {
        if (b.output === 'replace') {
          out = keepEdges(text, out);
          if (out === text) return void await desk.notify('No changes needed', '', { ms: 1500 });
        }
        // The answer took a moment: if the person moved to another window,
        // pasting there would be wrong. The clipboard holds it instead.
        const now = await desk.focused().catch(() => null);
        if (!now || now.id !== win.id) {
          await desk.setClipboard(out);
          return void await desk.notify('Answer copied', 'You moved to another window, so the answer is on the clipboard.', { ms: 5000 });
        }
        await desk.paste(win, out);
      } else if (b.output === 'clipboard') {
        await desk.setClipboard(out);
        await desk.notify('Copied', clip(out, 200), { ms: 3000 });
      } else {
        await desk.notify(b.label, out, { ms: 0 });
      }
      log(`${b.program}: ${b.input} -> ${b.output}, ${text.length} chars, ${((Date.now() - started) / 1000).toFixed(1)} s`);
    } catch (e) {
      log(`${b.program}: failed after ${((Date.now() - started) / 1000).toFixed(1)} s: ${e.message}`);
      await desk.dismiss(progress);
      await desk.notify(b.label, e.message, { ms: 6000 });
    } finally { busy = false; }
  }

  // Follow the person's hotkeys: a long poll answers at once when they
  // change on the page, else after LONG_POLL_S with nothing new.
  async function follow({ stop }) {
    let since = -1, wait = 2000, told = false;
    while (!stop.stopped) {
      link = readLink();
      if (!link) {
        if (bindings.length) { bindings = []; await applyAll(); }
        if (!told) { log('not linked yet: run `chattering-app hotkeys connect`'); told = true; }
        await sleep(5000); since = -1; continue;
      }
      told = false;
      try {
        const r = await call(link, 'GET', `/api/hotkeys/device?since=${since}&wait=${LONG_POLL_S}`, null, { timeoutMs: (LONG_POLL_S + 10) * 1000 });
        wait = 2000;
        if (r.version !== since || !reported) {
          since = r.version;
          person = r.person;
          bindings = r.bindings;
          await applyAll();
          log(`${bindings.length} hotkey(s) for ${person.name}: ${reported.filter(x => x.state === 'on').length} live`);
        }
      } catch (e) {
        if (e.status === 401) {
          log('this computer was unlinked in Chattering');
          await desk.notify('Chattering hotkeys', 'This computer was unlinked. Run “chattering-app hotkeys connect” to link it again.', { ms: 8000 });
          try { fs.renameSync(linkFile(), linkFile() + '.unlinked'); } catch {}
          continue;
        }
        log(`cannot reach ${link.server}: ${e.message}; again in ${wait / 1000} s`);
        await sleep(wait);
        wait = Math.min(wait * 2, 60000);
      }
    }
  }

  return { press, follow, applyAll, get bindings() { return bindings; } };
}

async function runHelper() {
  const desk = require('./hotkeys-desktop.js').detect();
  if (desk.supported) {
    const miss = desk.missing();
    if (miss.length) log(`missing on this computer: ${miss.join(', ')}`);
  } else log(desk.reason);
  const helper = createHelper({ desk });
  const sock = socketPath();
  // One helper per session: a second one would bind the same keys twice.
  if (process.platform !== 'win32' && fs.existsSync(sock)) {
    const alive = await new Promise(r => { const c = net.connect(sock, () => { c.end(); r(true); }); c.on('error', () => r(false)); });
    if (alive) throw new Error('The hotkey helper is already running.');
    fs.unlinkSync(sock);
  }
  const server = net.createServer(c => {
    let buf = '';
    c.on('data', d => { buf += d; if (buf.length > 200) c.destroy(); });
    c.on('end', () => { const id = buf.trim(); c.end(); if (/^[a-z0-9]{6,32}$/.test(id)) helper.press(id); });
    c.on('error', () => {});
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(sock, resolve); });
  if (process.platform !== 'win32') fs.chmodSync(sock, 0o600);
  const stop = { stopped: false };
  const stopWatch = desk.supported ? desk.watch(() => { log('the desktop reloaded its configuration: binding again'); setTimeout(() => helper.applyAll(), 300); }) : () => {};
  const quit = async () => {
    stop.stopped = true;
    stopWatch();
    server.close();
    if (desk.supported) await desk.clear();
    process.exit(0);
  };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
  log(`running on ${desk.label}`);
  await helper.follow({ stop });
}

async function pressCommand(id) {
  await new Promise((resolve) => {
    const c = net.connect(socketPath(), () => c.end(String(id)));
    c.on('close', resolve);
    c.on('error', () => {
      // Nothing listens: say so where the person is looking.
      const desk = require('./hotkeys-desktop.js').detect();
      Promise.resolve(desk.supported ? desk.notify('Chattering hotkeys', 'The hotkey helper is not running. Start it with “chattering-app hotkeys run”.', { ms: 6000 }) : null).then(resolve);
    });
  });
}

async function status() {
  const link = readJson(linkFile());
  if (!link) return console.log('Not linked. Run: chattering-app hotkeys connect [ADDRESS]');
  console.log(`Linked to ${link.server} since ${link.linkedAt}.`);
  try {
    const r = await call(link, 'GET', '/api/hotkeys/device?since=-1');
    console.log(`Hotkeys of ${r.person.name}, on ${r.computer.name}:`);
    const st = readJson(statusFile());
    const keys = require('./hotkeys-keys.js');
    for (const b of r.bindings) {
      const s = st && (st.bindings || []).find(x => x.id === b.id);
      const state = !s ? 'not live (is the helper running?)' : s.state === 'on' ? 'live' : s.state === 'taken' ? `taken by “${s.by}”` : s.state;
      console.log(`  ${keys.label(b.keys).padEnd(20)} ${b.label}  (${b.input} → ${b.output})  ${state}`);
    }
    if (!r.bindings.length) console.log('  none yet: add some in Chattering, settings → hotkeys');
  } catch (e) { console.log(`Cannot read the hotkeys: ${e.message}`); }
}

async function forget() {
  const link = readJson(linkFile());
  if (!link) return console.log('This computer is not linked.');
  try { await call(link, 'DELETE', '/api/hotkeys/device'); } catch (e) { if (e.status !== 401) console.log(`Chattering did not answer (${e.message}); unlinked here only. Forget it there too: settings → hotkeys.`); }
  fs.unlinkSync(linkFile());
  console.log('Unlinked.');
}

const USAGE = `chattering-app hotkeys: run your AI programs from hotkeys anywhere on this computer.

  connect [ADDRESS]   link this computer to your Chattering (default: this computer's own)
  run                 keep your hotkeys live
  autostart on|off    start \`run\` with your session (Linux desktops)
  status              linked to whom, which hotkeys, which are live
  forget              unlink this computer

Hotkeys are made in Chattering: settings → hotkeys.`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'connect') return connect(rest);
  if (cmd === 'run') return runHelper();
  if (cmd === 'press') return pressCommand(rest[0]);
  if (cmd === 'status' || !cmd) return status();
  if (cmd === 'forget') return forget();
  console.log(USAGE);
  if (cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exitCode = 2;
}

if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error('hotkeys: ' + e.message); process.exit(1); });

module.exports = { main, createHelper, keepEdges, socketPath };
