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
  let spells = [];
  let frogSettings = null;
  let person = null;
  let busy = false;
  let reported = null;
  let frogStatus = null; // what the frog can do here: { available, reason }
  const listeners = new Set(); // told when the hotkeys or the frog's settings change

  async function applyAll() {
    const pressArgv = id => [process.execPath, __filename, 'press', id];
    let report;
    if (!desk.supported) report = bindings.map(b => ({ id: b.id, state: 'unsupported' }));
    else {
      // The frog's own key: its book, open on the selection.
      const summon = frogSettings && frogSettings.summonKeys ? [{ id: 'frog', keys: frogSettings.summonKeys, label: 'Open the frog\u2019s book', program: 'frog' }] : [];
      try { report = await desk.apply([...bindings, ...summon], pressArgv); }
      catch (e) { log(e.message); report = bindings.map(b => ({ id: b.id, state: 'bad', by: e.message })); }
    }
    reported = report;
    writeJson(statusFile(), { server: link && link.server, person, at: new Date().toISOString(), desktop: desk.label, supported: desk.supported, reason: desk.reason || null, bindings: bindings.map(b => ({ ...b, ...(report.find(r => r.id === b.id) || {}) })) });
    reportStatus();
  }
  function reportStatus() {
    if (link) call(link, 'POST', '/api/hotkeys/device/status', { desktop: desk.label, supported: desk.supported, reason: desk.reason || null, report: reported || [], frog: frogStatus }).catch(e => log('status: ' + e.message));
  }

  async function press(id) {
    if (id === 'frog') { for (const f of listeners) f('summon'); return; }
    const b = bindings.find(x => x.id === id);
    if (!b) return desk.notify('Chattering', 'This hotkey is not set up any more.');
    if (busy) return desk.notify('Chattering', 'Still working on the last hotkey.', { ms: 2000 });
    busy = true;
    for (const f of listeners) f('press');
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
          spells = r.spells || [];
          frogSettings = r.frog || null;
          await applyAll();
          for (const f of listeners) f('changed');
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

  return {
    press, follow, applyAll, reportStatus,
    get bindings() { return bindings; }, get spells() { return spells; }, get frog() { return frogSettings; },
    get link() { return link; }, get person() { return person; },
    get busy() { return busy; }, set busy(v) { busy = v; },
    set frogStatus(v) { frogStatus = v; reportStatus(); },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
  };
}

// ---- the frog (design/94) ---------------------------------------------------------
//
// When the person selects a few words, the frog hops beside them; clicked,
// it opens their spells. This part decides when it appears and does the
// work; the page (overlay/spells.html) draws it, in a host that shows it
// over the screen (overlay/host-gtk.py). The selected text stays here and
// goes to Chattering only when a spell is cast.

const T = require('./overlay/spells-text.js');
const SETTLE_MS = 250;        // a selection still for this long is a selection, not a drag
const AFTER_REPLACE_MS = 1500; // our own paste changes the selection: not a new one
const OUTPUT_KIND = { replace: 'replace', paste: 'replace', clipboard: 'copy', notify: 'answer' };

function appName(win) {
  const c = String(win.app || '').split('.').pop().replace(/[-_]/g, ' ').trim();
  if (!c) return '';
  if (/^chrom(e|ium)/i.test(c)) return 'Chromium';
  return c.replace(/^./, x => x.toUpperCase());
}

/**
 * The frog's controller. `host` is { send(msg), onMessage(cb) } or made from
 * desk.overlayHost(); `api(route, body)` reaches Chattering.
 */
function createFrog({ desk, helper, host: givenHost = null, api = null, now = () => Date.now(), settleMs = SETTLE_MS }) {
  const request = api || ((route, body, timeoutMs, method = 'POST') => call(helper.link, method, route, body, { timeoutMs }));
  let host = givenHost, hostFailures = [], disabled = null;
  let shown = null;   // { text, win, monitor }
  let mode = 'off';   // off | idle | panel | busy
  let last = null;    // the last spell cast: { spell } or { ask }, and its answer
  let settleT = 0, quietUntil = 0, pendingText = null;
  let timing = null; // { settled, sent }: how long a frog takes to appear (logged, no text)
  let spotOn = null;   // the screen the frog lives on, while it is there (mode 'spot')
  let spotAway = false; // hidden for a full-screen window
  let snoozeUntil = 0;
  let lastApp = '';
  // The last frog's selection, and when it ended: an app offers its
  // selection again when it gets the keyboard back (after the book closes,
  // after a click), which is not a new selection and must not bring the
  // frog back (it looked like a flicker).
  let episode = null; // { text, winId, endedAt }
  const REOFFER_MS = 3000;
  let handedBackAt = 0;
  const sameWin = (a, b) => String(a || '').replace(/^0x/, '') === String(b || '').replace(/^0x/, '');
  const SIZE = { small: [40, 66], medium: [60, 100], large: [80, 133] };
  const homeFile = () => path.join(dirs().data, 'hotkeys-frog-home.json');

  // A Chattering that sends no frog settings is older than the frog: off.
  const settings = () => helper.frog || { on: false, mode: 'call', skip: ['terminal'], minWords: 2, theme: { id: 'rockfrog' } };
  const frogMode = () => settings().mode || (settings().on === false ? 'call' : 'beside');
  const common = () => ({ spells: helper.spells, model: settings().askModel || '', theme: settings().theme || { id: 'rockfrog' }, size: settings().size || 'medium' });

  // ---- the host ----
  function startHost() {
    if (host || disabled) return host;
    const how = desk.overlayHost ? desk.overlayHost(path.join(__dirname, 'overlay', 'host-gtk.py')) : { reason: 'This desktop has no overlay yet.' };
    if (how.reason) { disable(how.reason); return null; }
    const child = spawn(how.file, how.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...how.env } });
    let carry = '', errTail = '';
    const handlers = new Set();
    child.stdout.on('data', d => {
      carry += d;
      const lines = carry.split('\n'); carry = lines.pop();
      for (const l of lines) { let m; try { m = JSON.parse(l); } catch { continue; } for (const h of handlers) h(m); }
    });
    child.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
    child.on('error', e => log('frog host: ' + e.message));
    child.on('exit', code => {
      // Gone while it held the keys: give them back to the app, or nothing
      // would have the keyboard.
      if (mode === 'panel' && shown && desk.focus) desk.focus(shown.win).catch(() => {});
      host = null; mode = 'off'; shown = null; spotOn = null;
      if (code === 3) return disable('This desktop does not offer the layer shell the frog needs (GNOME does not).');
      const t = now(); hostFailures = hostFailures.filter(x => t - x < 60000).concat(t);
      const why = errTail.trim().split('\n').filter(l => !/a11y|appsink|GStreamer/i.test(l)).pop() || ('exit ' + code);
      log('frog host stopped: ' + why);
      if (hostFailures.length >= 3) disable('Its overlay keeps stopping: ' + why);
      else if (frogMode() === 'spot') setTimeout(() => showSpot().catch(() => {}), 2000); // it lives there: back
    });
    host = {
      send: m => { try { child.stdin.write(JSON.stringify(m) + '\n'); } catch {} },
      onMessage: h => handlers.add(h),
      stop: () => { try { child.stdin.end(); } catch {} child.kill(); },
    };
    host.onMessage(fromPage);
    helper.frogStatus = { available: true };
    return host;
  }
  function disable(reason) {
    disabled = reason; log('frog: ' + reason);
    helper.frogStatus = { available: false, reason };
  }
  if (givenHost) givenHost.onMessage(fromPage);

  // ---- when it appears ----
  function onSelection(text) {
    if (disabled || frogMode() === 'call' || now() < snoozeUntil) return;
    if (now() < quietUntil || mode === 'panel' || mode === 'busy' || helper.busy) return;
    pendingText = text;
    clearTimeout(settleT);
    settleT = setTimeout(() => consider(pendingText).catch(e => log('frog: ' + e.message)), settleMs);
  }
  async function consider(text) {
    if (mode === 'panel' || mode === 'busy' || helper.busy) return;
    const st = settings();
    if (!String(text).trim() || T.words(text) < (st.minWords || 2) || text.length > MAX_CHARS) { if (mode === 'idle') hide(); return; }
    if (shown && mode === 'idle' && shown.text === text) return;
    const settled = now();
    if (episode && episode.endedAt && text === episode.text && settled - episode.endedAt < REOFFER_MS) {
      const w = await desk.focused().catch(() => null);
      if (w && sameWin(w.id, episode.winId)) return;
    }
    if (frogMode() === 'spot') return wakeFor(text);
    // Everything the desktop must say, asked at once.
    const [win, look] = await Promise.all([desk.focused().catch(() => null), lookAround()]);
    if (!win || !look) return;
    const skip = (st.skip || []).map(x => String(x).toLowerCase());
    if ((skip.includes('terminal') && win.terminal) || skip.includes(String(win.app || '').toLowerCase())) return;
    const place = where(win, look);
    if (!place) return;
    timing = { settled, sent: now() };
    shown = { text, win, monitor: place.monitor }; lastApp = win.app || '';
    episode = { text, winId: win.id, endedAt: 0 };
    mode = 'idle';
    if (!startHost()) return;
    host.send({
      type: 'show', monitor: place.monitor, at: place.at, corner: place.corner, screen: place.screen,
      words: T.words(text), app: appName(win), linger: 5000, ...common(),
    });
  }
  // The pointer, the screens and every window's rectangle, in one go.
  async function lookAround() {
    try {
      const [p, mons, rects] = await Promise.all([desk.pointer(), desk.monitors(), desk.windowRects ? desk.windowRects() : null]);
      return { p, mons, rects };
    } catch { return null; }
  }
  // Beside the end of the selection: the pointer is there when a mouse
  // selection ends. The pointer outside the window means the keys made the
  // selection: the frog waits in the window's corner instead.
  function where(win, { p, mons, rects }) {
    const rect = rects ? rects[win.id] : null;
    if (!rect || !mons.length) return null;
    const inside = (pt, r) => pt.x >= r.x && pt.x < r.x + r.w && pt.y >= r.y && pt.y < r.y + r.h;
    const byPointer = inside(p, rect);
    const anchor = byPointer ? p : { x: rect.x + rect.w - 18, y: rect.y + rect.h - 14 };
    const mon = mons.find(m => inside(anchor, m)) || mons.find(m => m.focused) || mons[0];
    return { monitor: mon.name, at: { x: anchor.x - mon.x, y: anchor.y - mon.y }, corner: !byPointer, screen: { w: mon.w, h: mon.h } };
  }
  function endEpisode() { if (episode && !episode.endedAt) episode.endedAt = now(); }
  function hide() { endEpisode(); if (host && mode !== 'off') host.send({ type: 'hide' }); mode = 'off'; shown = null; spotOn = null; }

  // ---- its spot (mode 'spot') ----
  // Where it lives, per computer and per screen, from the nearest corner:
  // a screen that changes size keeps the frog in its corner.
  function homes() { return readJson(homeFile()) || { monitor: null, places: {} }; }
  function homeFor(mon) {
    const [w, h] = SIZE[settings().size || 'medium'] || SIZE.medium;
    const p = homes().places[mon.name];
    if (!p) return { x: mon.w - w - 28, y: mon.h - h - 28 };
    return { x: p.right ? mon.w - p.dx - w : p.dx, y: p.bottom ? mon.h - p.dy - h : p.dy };
  }
  function saveHome(monName, m) {
    const sw = m.screen ? m.screen.w : 1920, sh = m.screen ? m.screen.h : 1080;
    const right = m.x + m.w / 2 > sw / 2, bottom = m.y + m.h / 2 > sh / 2;
    const all = homes();
    all.monitor = monName;
    all.places[monName] = { right, bottom, dx: Math.round(right ? sw - m.x - m.w : m.x), dy: Math.round(bottom ? sh - m.y - m.h : m.y) };
    writeJson(homeFile(), all);
  }
  async function showSpot() {
    if (disabled || frogMode() !== 'spot' || spotAway) return;
    if (!startHost()) return;
    const mons = await desk.monitors().catch(() => []);
    if (!mons.length) return;
    const saved = homes().monitor;
    const mon = mons.find(m => m.name === saved) || mons.find(m => m.focused) || mons[0];
    spotOn = mon.name;
    if (mode === 'panel' || mode === 'busy') return;
    mode = 'idle';
    host.send({ type: 'show', mode: 'spot', asleep: true, monitor: mon.name, home: homeFor(mon), screen: { w: mon.w, h: mon.h }, words: 0, app: '', ...common() });
  }
  async function wakeFor(text) {
    const win = await desk.focused().catch(() => null);
    if (!win) return;
    const st = settings(), skip = (st.skip || []).map(x => String(x).toLowerCase());
    if ((skip.includes('terminal') && win.terminal) || skip.includes(String(win.app || '').toLowerCase())) return;
    if (!spotOn) await showSpot();
    if (!spotOn) return;
    shown = { text, win, monitor: spotOn }; lastApp = win.app || '';
    mode = 'idle';
    host.send({ type: 'wake', words: T.words(text), app: appName(win) });
  }
  // The desktop moved on: the frog beside the text leaves; the one in its
  // spot goes back to sleep, and hides for a full-screen window.
  async function onDesktop(name, data) {
    if (name !== 'activewindowv2' && name !== 'workspacev2' && name !== 'fullscreen') return;
    // The keyboard going back to the app the frog works for is not the
    // person moving on: only another window (or workspace) is.
    const ours = shown && shown.win && name === 'activewindowv2' && (sameWin(data, shown.win.id) || !data || now() - handedBackAt < 600);
    if (ours) return;
    if (frogMode() === 'spot') {
      if (mode === 'idle' && host) host.send({ type: 'sleep' });
      const win = await desk.focused().catch(() => null);
      const full = name === 'fullscreen' ? data === '1' : !!(win && win.fullscreen);
      if (full && !spotAway) { spotAway = true; if (mode === 'idle') hide(); }
      else if (!full && spotAway) { spotAway = false; await showSpot(); }
    } else if (mode === 'idle' && name !== 'fullscreen') hide();
  }

  // ---- what the person does ----
  async function fromPage(m) {
    try {
      if (m.type === 'shown') {
        if (timing) log(`frog: drawn ${now() - timing.settled} ms after the selection settled (${timing.sent - timing.settled} ms asking the desktop, ${now() - timing.sent} ms drawing)`);
        timing = null;
      }
      else if (m.type === 'keyboard') {
        if (m.on) mode = 'panel';
        else {
          if (mode === 'panel') mode = 'idle';
          // The desktop does not say when the keyboard went back to the app
          // (its active window never changed): give it back ourselves.
          if (shown && desk.focus) { handedBackAt = now(); await desk.focus(shown.win); }
        }
      }
      else if (m.type === 'hidden') { endEpisode(); mode = 'off'; shown = null; spotOn = null; }
      else if (m.type === 'moved') { if (frogMode() === 'spot' && spotOn) saveHome(spotOn, m); }
      else if (m.type === 'set') {
        const patch = {}; if (m.mode) patch.mode = m.mode; if (m.size) patch.size = m.size;
        if (helper.frog) Object.assign(helper.frog, patch); // at once here; Chattering confirms
        await request('/api/hotkeys/device/frog', patch, 15000, 'PUT');
        if (m.mode === 'spot') { spotOn = shown ? shown.monitor : spotOn; }
      }
      else if (m.type === 'snooze') { snoozeUntil = now() + (Number(m.minutes) || 60) * 60000; }
      else if (m.type === 'skip-app') {
        const app = (shown && shown.win && shown.win.app) || lastApp;
        if (app) { if (helper.frog) helper.frog.skip = [...(helper.frog.skip || []), String(app).toLowerCase()]; await request('/api/hotkeys/device/frog', { skipApp: app }, 15000, 'PUT'); }
      }
      else if (m.type === 'close') { if (mode === 'panel') mode = 'idle'; }
      else if (m.type === 'cast') await cast({ spell: helper.spells.find(s => s.id === m.id) });
      else if (m.type === 'ask') await cast({ ask: String(m.request || '') });
      else if (m.type === 'again') { if (last) await cast(last.what); }
      else if (m.type === 'copy') { if (last && last.answer) await desk.setClipboard(last.answer.text); if (mode !== 'off') mode = 'idle'; }
      else if (m.type === 'replace') await replace();
      else if (m.type === 'judge') { if (m.call) await request('/api/hotkeys/device/rate', { call: m.call, verdict: m.verdict || null }, 15000); }
      else if (m.type === 'settings') { if (helper.link) openInBrowser(helper.link.server.replace(/\/+$/, '') + '/#settings=hotkeys'); hide(); }
      else if (m.type === 'unsupported') disable(m.reason || 'The overlay cannot run here.');
    } catch (e) {
      log('frog: ' + e.message);
      if (host && shown) host.send({ type: 'problem', title: 'That did not work', message: e.message });
    }
  }

  async function cast(what) {
    if (!shown || (!what.spell && !what.ask)) return;
    if (helper.busy) return;
    helper.busy = true; mode = 'busy';
    const label = what.spell ? what.spell.label : '“' + what.ask + '”';
    const started = now();
    try {
      const res = what.spell
        ? await request('/api/hotkeys/device/run', { id: what.spell.id, text: shown.text }, 3 * 60 * 1000)
        : await request('/api/hotkeys/device/ask', { request: what.ask, text: shown.text }, 3 * 60 * 1000);
      const kind = what.spell ? (OUTPUT_KIND[what.spell.output] || 'answer') : res.kind;
      const answer = { kind, text: String(res.text || ''), call: res.call || null };
      last = { what, answer };
      if (kind === 'replace' && T.keepEdges(shown.text, answer.text) === shown.text) {
        host.send({ type: 'done', html: '<span class="live">✓</span> Nothing to change', ms: 2200 });
      } else {
        host.send({ type: 'answer', kind, label, before: shown.text.trim(), text: answer.text.trim(), program: res.program || '', version: res.version || '',
          model: res.model || '', secs: Math.round((now() - started) / 100) / 10, call: answer.call });
      }
      log(`frog: ${res.program || 'spell'}: ${shown.text.length} chars, ${((now() - started) / 1000).toFixed(1)} s`);
    } catch (e) {
      host.send({ type: 'problem', title: label, message: e.message });
    } finally { helper.busy = false; if (mode === 'busy') mode = 'panel'; }
  }

  // Replace the selection with the answer, safely: the keyboard goes back
  // to the app, the selection there is read once more, and only if it is
  // still the text the spell worked on is it pasted over. Else the answer
  // waits on the clipboard.
  async function replace() {
    if (!shown || !last || !last.answer) return;
    const { win, text } = shown, out = T.keepEdges(text, last.answer.text);
    helper.busy = true; mode = 'busy'; quietUntil = now() + 60000;
    // Whatever stops the paste, the answer is not lost: it waits on the clipboard.
    const onClipboard = async why => {
      await desk.setClipboard(last.answer.text).catch(() => {});
      host.send({ type: 'done', html: why + ', so the answer is on the clipboard: <kbd>Ctrl</kbd> <kbd>V</kbd>', ms: 4200 });
    };
    try {
      try { await giveBack(win); } catch { return await onClipboard('The app did not take the keyboard back'); }
      const current = await desk.selection(win).catch(() => '');
      if (current.trim() !== text.trim()) return await onClipboard('Your selection changed');
      try { await desk.paste(win, out); } catch { return await onClipboard('The paste did not go through'); }
      host.send({ type: 'done', html: '<span class="live">✓</span> Replaced · <kbd>Ctrl</kbd> <kbd>Z</kbd> undoes it', ms: 2200 });
    } finally {
      helper.busy = false; quietUntil = now() + AFTER_REPLACE_MS;
      // Beside the text the page says when the frog has left; in its spot
      // it just goes back to sleep, ready for the next selection.
      if (frogMode() === 'spot') { mode = 'idle'; shown = null; }
    }
  }
  async function giveBack(win) {
    // The page gave the keys back a moment ago. The window must have the
    // keyboard again for the paste (an app reads the clipboard only then);
    // the desktop's active window cannot tell, so focus it, then let the
    // app take the focus in.
    if (desk.focus) { handedBackAt = now(); await desk.focus(win); }
    await new Promise(r => setTimeout(r, 120));
    const f = await desk.focused().catch(() => null);
    if (!f || f.id !== win.id) throw new Error('Could not give the keyboard back to ' + (appName(win) || 'the app') + ': the answer is on the clipboard.');
  }

  // Called by its key: the book opens on whatever is selected, wherever.
  async function summon() {
    if (disabled || !helper.frog) return;
    if (helper.busy || mode === 'busy') return;
    const text = desk.primaryText ? await desk.primaryText().catch(() => '') : '';
    if (frogMode() === 'spot' && !spotAway) {
      if (!spotOn) await showSpot();
      if (!spotOn) return;
      const win = await desk.focused().catch(() => null);
      if (!win) return;
      if (!String(text).trim() || text.length > MAX_CHARS) {
        host.send({ type: 'problem', title: 'Nothing is selected', message: 'Select some text first, then call me.', again: false });
        return;
      }
      shown = { text, win, monitor: spotOn }; lastApp = win.app || ''; mode = 'idle';
      host.send({ type: 'wake', words: T.words(text), app: appName(win) });
      host.send({ type: 'open' });
      return;
    }
    const [win, look] = await Promise.all([desk.focused().catch(() => null), lookAround()]);
    if (!win || !look) return;
    const place = where(win, look);
    if (!place || !startHost()) return;
    if (!String(text).trim()) {
      shown = { text: '', win, monitor: place.monitor }; mode = 'idle';
      host.send({ type: 'show', monitor: place.monitor, at: place.at, corner: place.corner, screen: place.screen, words: 0, app: appName(win), linger: 4000, ...common() });
      host.send({ type: 'problem', title: 'Nothing is selected', message: 'Select some text first, then call me.', again: false });
      return;
    }
    if (text.length > MAX_CHARS) return;
    shown = { text, win, monitor: place.monitor }; mode = 'idle';
    host.send({ type: 'show', open: true, monitor: place.monitor, at: place.at, corner: place.corner, screen: place.screen, words: T.words(text), app: appName(win), ...common() });
  }

  helper.onChange(why => {
    if (why === 'summon') summon().catch(e => log('frog: ' + e.message));
    if (why === 'press') hide();
    if (why === 'changed') { if (frogMode() === 'call') hide(); warm(); }
  });

  // Ready before the first selection: starting the host costs a second or two.
  // In its spot, the frog goes there.
  function warm() {
    if (disabled) return;
    if (frogMode() === 'spot') showSpot().catch(e => log('frog: ' + e.message));
    else { if (spotOn) hide(); if (frogMode() === 'beside') startHost(); }
  }

  return { onSelection, hide, startHost, summon, warm, onDesktop, showSpot, get mode() { return mode; }, get disabled() { return disabled; }, stop: () => host && host.stop && host.stop() };
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
    c.on('end', () => { const id = buf.trim(); c.end(); if (id === 'frog' || /^[a-z0-9]{6,32}$/.test(id)) helper.press(id); });
    c.on('error', () => {});
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(sock, resolve); });
  if (process.platform !== 'win32') fs.chmodSync(sock, 0o600);
  const stop = { stopped: false };
  const frog = desk.supported && desk.watchSelection ? createFrog({ desk, helper }) : null;
  const stopSelection = frog ? desk.watchSelection(t => frog.onSelection(t)) : () => {};
  if (!frog) helper.frogStatus = { available: false, reason: desk.reason || 'The frog is not built for this desktop yet.' };
  // The frog leaves when the person moves to another window or workspace.
  const onEvent = (name, data) => { if (frog) frog.onDesktop(name, data).catch(() => {}); };
  const stopWatch = desk.supported ? desk.watch(() => { log('the desktop reloaded its configuration: binding again'); setTimeout(() => helper.applyAll(), 300); }, onEvent) : () => {};
  const quit = async () => {
    stop.stopped = true;
    stopWatch();
    stopSelection();
    if (frog) frog.stop();
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

module.exports = { main, createHelper, createFrog, keepEdges, socketPath, appName };
