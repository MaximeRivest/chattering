'use strict';
// hotkeys-desktop.js — what the hotkey helper needs from the desktop it runs
// on (design/93), one adapter per desktop. The helper (hotkeys-device.js)
// never calls a desktop tool itself; adding a desktop is one adapter here.
//
// An adapter:
//   name, label                       'hyprland', 'Hyprland'
//   missing()                         tools it needs that are not installed
//   apply(bindings, press)            make these hotkeys live (replacing the
//                                     earlier ones); press(id) runs one.
//                                     → [{ id, state: 'on'|'taken'|'bad', by? }]
//   clear()                           take them all away
//   watch(onReset) → stop             call onReset when the desktop dropped
//                                     them (its configuration was reloaded)
//   focused() → window                the window with the keyboard focus
//   selection(window) → text          what is selected there ('' for nothing);
//                                     the clipboard is left as it was
//   clipboardText() → text
//   setClipboard(text)
//   paste(window, text)               paste over the selection or at the
//                                     cursor, then put the clipboard back
//   notify(title, body, {replace, ms}) → id     dismiss(id)
//
// For the frog (design/94), optional:
//   watchSelection(onText) → stop   each new selection's text, as the app
//                                   offers it (no copy, the clipboard untouched)
//   pointer() → {x, y}              the pointer, in the desktop's layout
//   monitors() → [{name, x, y, w, h}]   screens, logical size
//   windowRect(window) → {x, y, w, h}
//   focus(window)                   give the keyboard back to a window
//   overlayHost() → {file, args, env} | {reason}   how to start the overlay
//
// Hyprland is built. Windows, macOS, GNOME, KDE and X11 are named here so the
// helper can say what it is on and why it cannot help yet.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFile } = require('child_process');
const keys = require('./hotkeys-keys.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function run(file, args, { input = null, timeout = 4000, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout, encoding, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve(stdout);
    });
    if (input !== null) child.stdin.end(input);
  });
}

function onPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch {}
  }
  return false;
}

// ---- Hyprland (Wayland) ------------------------------------------------------
// Hotkeys: bound at run time through Hyprland's Lua (`hyprctl eval`), each
// bind's handle kept in a Lua global so the next apply removes exactly ours
// and never a binding of the person's own config. A configuration reload
// drops them; the event socket says when, and they are bound again.
// Copy and paste: the key chord is sent to the window itself with exactly
// its modifiers (send_key_state), so the keys still held from the hotkey do
// not mix in; the clipboard is wl-clipboard's.

const HYPR_MODS = { Super: 'SUPER', Ctrl: 'CTRL', Alt: 'ALT', Shift: 'SHIFT' };
const HYPR_MASK = { Shift: 1, Ctrl: 4, Alt: 8, Super: 64 };
// xkbcommon keysym names. Punctuation is lower case ("comma"; "COMMA" does not match).
const HYPR_KEY = {
  Space: 'SPACE', Enter: 'RETURN', Tab: 'TAB', Backspace: 'BACKSPACE', Delete: 'DELETE', Insert: 'INSERT', Home: 'HOME', End: 'END',
  PageUp: 'Prior', PageDown: 'Next', Up: 'UP', Down: 'DOWN', Left: 'LEFT', Right: 'RIGHT',
  Minus: 'minus', Equal: 'equal', BracketLeft: 'bracketleft', BracketRight: 'bracketright', Backslash: 'backslash',
  Semicolon: 'semicolon', Quote: 'apostrophe', Backquote: 'grave', Comma: 'comma', Period: 'period', Slash: 'slash',
  Print: 'PRINT', Pause: 'PAUSE',
};
const TERMINAL_CLASSES = new Set(['alacritty', 'kitty', 'foot', 'footclient', 'com.mitchellh.ghostty', 'org.wezfurlong.wezterm', 'xterm', 'org.gnome.console', 'org.gnome.ptyxis', 'konsole']);
const DESCRIPTION_PREFIX = 'Chattering: ';

function hyprCombo(text) {
  const c = keys.parse(text);
  return {
    spec: [...c.mods.map(m => HYPR_MODS[m]), HYPR_KEY[c.key] || c.key].join(' + '),
    mask: c.mods.reduce((n, m) => n | HYPR_MASK[m], 0),
    key: HYPR_KEY[c.key] || c.key,
  };
}
// A Lua long string that cannot be closed by its content.
function luaString(s) {
  let eq = '';
  while (String(s).includes(']' + eq + ']')) eq += '=';
  return '[' + eq + '[' + s + ']' + eq + ']';
}
const shellQuote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

function hyprland() {
  const hyprctl = (...args) => run('hyprctl', args);
  const ok = out => { const o = String(out || '').trim(); return o === '' || o === 'ok'; };
  async function evalLua(code) {
    const out = await hyprctl('eval', code);
    if (!ok(out)) throw new Error('Hyprland refused the hotkeys: ' + String(out).trim());
  }
  async function chord(win, mods, key) {
    const target = 'address:' + win.id;
    const send = async state => ok(await hyprctl('dispatch', `hl.dsp.send_key_state({ mods = ${JSON.stringify(mods)}, key = ${JSON.stringify(key)}, state = ${JSON.stringify(state)}, window = ${JSON.stringify(target)} })`).catch(() => 'failed'));
    if (await send('down')) { await sleep(40); await send('up'); return; }
    // Hyprland before its Lua configuration.
    const out = await hyprctl('dispatch', 'sendshortcut', `${mods}, ${key}, ${target}`).catch(e => e.message);
    if (!ok(out)) throw new Error(`could not send ${mods}+${key} to the window: ${String(out).trim()}`);
  }

  async function types() {
    try { return String(await run('wl-paste', ['--list-types'], { timeout: 2000 })).split('\n').map(s => s.trim()).filter(Boolean); }
    catch { return []; }
  }
  const pick = (list, ...wanted) => { for (const w of wanted) { const t = list.find(x => x === w || x.startsWith(w)); if (t) return t; } return null; };
  const TEXT_TYPES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING'];
  // One representation of what is on the clipboard: its text first, else
  // an image, else its first type. A rich copy (HTML and text) comes back
  // as its text only.
  async function snapshot() {
    const list = await types();
    if (!list.length) return null;
    const mime = pick(list, ...TEXT_TYPES, 'image/png', 'image/') || list[0];
    try { return { mime, data: await run('wl-paste', ['--no-newline', '--type', mime], { timeout: 2000, encoding: 'buffer' }) }; }
    catch { return null; }
  }
  // wl-copy forks a child that serves the clipboard and keeps every pipe it
  // inherited: waiting on its output would wait for the next copy. Only its
  // stdin is a pipe.
  function copy(mime, data, { sensitive = false } = {}) {
    return new Promise((resolve, reject) => {
      const args = ['--type', mime];
      // Sensitive: the clipboard history (which saw it already) skips it.
      if (sensitive) args.push('--sensitive');
      const child = spawn('wl-copy', args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', reject);
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error('wl-copy failed'))));
      child.stdin.end(data);
    });
  }
  async function restore(snap) {
    if (!snap) { await run('wl-copy', ['--clear']).catch(() => {}); return; }
    await copy(snap.mime, snap.data, { sensitive: true }).catch(() => {});
  }
  async function readText(list) {
    const t = pick(list, ...TEXT_TYPES);
    return t ? String(await run('wl-paste', ['--no-newline', '--type', t], { timeout: 2000 })) : null;
  }

  let handles = 0;
  return {
    name: 'hyprland', label: 'Hyprland', supported: true,
    missing: () => ['hyprctl', 'wl-copy', 'wl-paste', 'notify-send'].filter(t => !onPath(t)),

    async apply(bindings, pressArgv) {
      const taken = new Map();
      try {
        for (const b of JSON.parse(await hyprctl('binds', '-j'))) {
          if (String(b.description || '').startsWith(DESCRIPTION_PREFIX)) continue;
          taken.set(b.modmask + ':' + String(b.key).toLowerCase(), b.description || b.dispatcher + ' ' + (b.arg || ''));
        }
      } catch {}
      const report = [];
      const lines = [
        'local t = _G.chattering_hotkeys or {}',
        'for _, h in ipairs(t) do pcall(function() h:unbind() end) end',
        '_G.chattering_hotkeys = {}',
      ];
      for (const b of bindings) {
        let c;
        try { c = hyprCombo(b.keys); } catch (e) { report.push({ id: b.id, state: 'bad', by: e.message }); continue; }
        const by = taken.get(c.mask + ':' + c.key.toLowerCase());
        if (by) { report.push({ id: b.id, state: 'taken', by }); continue; }
        const cmd = pressArgv(b.id).map(shellQuote).join(' ');
        lines.push(`table.insert(_G.chattering_hotkeys, hl.bind(${luaString(c.spec)}, hl.dsp.exec_cmd(${luaString(cmd)}), { description = ${luaString(DESCRIPTION_PREFIX + (b.label || b.program))} }))`);
        report.push({ id: b.id, state: 'on' });
      }
      await evalLua(lines.join('\n'));
      handles = report.filter(r => r.state === 'on').length;
      return report;
    },
    async clear() {
      await evalLua('local t = _G.chattering_hotkeys or {}\nfor _, h in ipairs(t) do pcall(function() h:unbind() end) end\n_G.chattering_hotkeys = {}').catch(() => {});
      handles = 0;
    },
    // The primary selection: what is selected, offered by the app the moment
    // it is selected (GTK, Qt, Chromium, Firefox, terminals). Read through
    // wl-paste's watch, at most 20,001 bytes each time, base64 on one line.
    watchSelection(onText) {
      let stopped = false, child = null, carry = '';
      const start = () => {
        if (stopped) return;
        child = spawn('wl-paste', ['--primary', '--type', 'text', '--watch', 'sh', '-c', 'head -c 20001 | base64 -w0; echo'], { stdio: ['ignore', 'pipe', 'ignore'] });
        child.stdout.on('data', d => {
          carry += d;
          const lines = carry.split('\n');
          carry = lines.pop();
          for (const l of lines) { try { onText(Buffer.from(l, 'base64').toString('utf8')); } catch {} }
        });
        child.on('exit', () => { child = null; if (!stopped) setTimeout(start, 2000); });
        child.on('error', () => {});
      };
      start();
      return () => { stopped = true; if (child) child.kill(); };
    },
    async primaryText() {
      return String(await run('wl-paste', ['--primary', '--no-newline', '--type', 'text'], { timeout: 1500 }).catch(() => '')).slice(0, 20001);
    },
    async pointer() {
      const p = JSON.parse(await hyprctl('cursorpos', '-j'));
      return { x: Math.round(p.x), y: Math.round(p.y) };
    },
    async monitors() {
      return JSON.parse(await hyprctl('monitors', '-j')).map(m => {
        const turned = m.transform % 2 === 1;
        const w = Math.round((turned ? m.height : m.width) / m.scale), h = Math.round((turned ? m.width : m.height) / m.scale);
        return { name: m.name, x: m.x, y: m.y, w, h, focused: !!m.focused };
      });
    },
    async windowRects() {
      const out = {};
      for (const c of JSON.parse(await hyprctl('clients', '-j'))) out[c.address] = { x: c.at[0], y: c.at[1], w: c.size[0], h: c.size[1] };
      return out;
    },
    async windowRect(win) {
      const all = JSON.parse(await hyprctl('clients', '-j'));
      const c = all.find(x => x.address === win.id);
      return c ? { x: c.at[0], y: c.at[1], w: c.size[0], h: c.size[1] } : null;
    },
    async focus(win) {
      await hyprctl('dispatch', `hl.dsp.focus({ window = "address:${win.id}" })`).catch(() => {});
    },
    // The overlay host: overlay/host-gtk.py with GTK 4, gtk4-layer-shell and
    // WebKitGTK 6. A packaged install names its own (CHATTERING_OVERLAY_HOST,
    // a program that runs Python with them); else the system's python3, with
    // the layer-shell library found in the usual places.
    overlayHost(script) {
      if (process.env.CHATTERING_OVERLAY_HOST) return { file: process.env.CHATTERING_OVERLAY_HOST, args: [script], env: {} };
      const lib = ['/usr/lib/libgtk4-layer-shell.so.0', '/usr/lib64/libgtk4-layer-shell.so.0', '/usr/lib/x86_64-linux-gnu/libgtk4-layer-shell.so.0', '/usr/lib/aarch64-linux-gnu/libgtk4-layer-shell.so.0']
        .find(f => fs.existsSync(f));
      if (!lib) return { reason: 'The frog needs gtk4-layer-shell, WebKitGTK 6 and PyGObject (on Debian or Ubuntu: apt install libgtk4-layer-shell0 gir1.2-gtk4layershell-1.0 gir1.2-webkit-6.0 python3-gi python3-gi-cairo).' };
      return { file: 'python3', args: [script], env: { LD_PRELOAD: lib } };
    },
    watch(onReset, onEvent) {
      const dir = path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'hypr', process.env.HYPRLAND_INSTANCE_SIGNATURE || '');
      let sock = null, stopped = false, carry = '';
      const connect = () => {
        if (stopped) return;
        sock = net.connect(path.join(dir, '.socket2.sock'));
        sock.on('data', d => {
          carry += d;
          const lines = carry.split('\n');
          carry = lines.pop();
          if (lines.some(l => l.startsWith('configreloaded>>'))) onReset();
          if (onEvent) for (const l of lines) { const i = l.indexOf('>>'); if (i > 0) onEvent(l.slice(0, i), l.slice(i + 2)); }
        });
        sock.on('error', () => {});
        sock.on('close', () => { if (!stopped) setTimeout(connect, 2000); });
      };
      connect();
      return () => { stopped = true; if (sock) sock.destroy(); };
    },

    async focused() {
      let w = null;
      try { w = JSON.parse(await hyprctl('activewindow', '-j')); } catch {}
      if (!w || !w.address) throw new Error('No window has the keyboard focus.');
      const terminal = TERMINAL_CLASSES.has(String(w.class || '').toLowerCase()) || (w.tags || []).some(t => String(t).replace(/\*$/, '') === 'terminal');
      return { id: w.address, app: w.class || '', terminal };
    },
    async selection(win) {
      const snap = await snapshot();
      try {
        await run('wl-copy', ['--clear']).catch(() => {});
        // Ctrl+C in a terminal interrupts the program running there.
        await chord(win, 'CTRL', win.terminal ? 'Insert' : 'C');
        const until = Date.now() + 800;
        while (Date.now() < until) {
          await sleep(25);
          const text = await readText(await types()).catch(() => null);
          if (text !== null) return text;
        }
        return '';
      } finally { await restore(snap); }
    },
    async clipboardText() {
      const text = await readText(await types()).catch(() => null);
      if (text === null) throw new Error('There is no text on the clipboard.');
      return text;
    },
    setClipboard: text => copy('text/plain;charset=utf-8', Buffer.from(String(text))),
    // Through the clipboard: one undo step in the app, no auto-indent or
    // auto-closed brackets, fast for long text. The clipboard is put back
    // once the app has had time to read it; nothing says when it has.
    async paste(win, text) {
      const snap = await snapshot();
      await copy('text/plain;charset=utf-8', Buffer.from(String(text)), { sensitive: true });
      await sleep(30);
      try { await chord(win, win.terminal ? 'SHIFT' : 'CTRL', win.terminal ? 'Insert' : 'V'); }
      finally { await sleep(600); await restore(snap); }
    },
    async notify(title, body = '', { replace = 0, ms = 4000 } = {}) {
      const args = ['--app-name=Chattering', '--print-id', '--expire-time=' + ms];
      if (replace) args.push('--replace-id=' + replace);
      args.push('--', String(title), String(body));
      try { return Number(String(await run('notify-send', args)).trim()) || 0; } catch { return 0; }
    },
    async dismiss(id) {
      if (!id) return;
      await run('busctl', ['--user', 'call', 'org.freedesktop.Notifications', '/org/freedesktop/Notifications', 'org.freedesktop.Notifications', 'CloseNotification', 'u', String(id)]).catch(() => {});
    },
    get live() { return handles; },
  };
}

// ---- the others, named --------------------------------------------------------

function unsupported(name, label, reason) {
  return { name, label, supported: false, reason };
}

/** The adapter for the desktop this process runs in. */
function detect(env = process.env, platform = process.platform) {
  if (platform === 'linux') {
    if (env.HYPRLAND_INSTANCE_SIGNATURE) return hyprland();
    const d = String(env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || '').toLowerCase();
    const wayland = !!env.WAYLAND_DISPLAY;
    if (d.includes('gnome')) return unsupported('gnome', 'GNOME', 'GNOME hotkeys are not built yet (they need GNOME\u2019s global shortcuts portal).');
    if (d.includes('kde') || d.includes('plasma')) return unsupported('kde', 'KDE Plasma', 'KDE hotkeys are not built yet (they need KDE\u2019s global shortcuts service).');
    if (!wayland && env.DISPLAY) return unsupported('x11', 'X11', 'X11 desktops are not built yet (they need xdotool and xclip).');
    return unsupported('linux', 'this Linux desktop', 'Only Hyprland is built so far.');
  }
  if (platform === 'darwin') return unsupported('macos', 'macOS', 'macOS hotkeys are not built yet (they need a small signed helper for the Accessibility permission).');
  if (platform === 'win32') return unsupported('windows', 'Windows', 'Windows hotkeys are not built yet.');
  return unsupported(platform, platform, 'This system is not supported.');
}

module.exports = { detect, hyprCombo, luaString, shellQuote, DESCRIPTION_PREFIX };
