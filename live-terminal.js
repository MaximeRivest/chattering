'use strict';
// Experimental (CHATTERING_LIVE_TERMINAL=1): a Claude Code conversation
// continued from Chattering through the real, interactive `claude`, on an
// invisible terminal. The conversation itself is Chattering's own view of
// Claude Code's session file; only the live part comes from the terminal
// (the input box, suggestions, questions, panels, "working…", and while it
// works a window of the terminal as drawn). Design and measurements:
// prototypes/terminal-document/README.md.
//
// One program per conversation, shared by every page that watches it (the
// hub: patches, one typist at a time, nothing applied twice). Each session
// is recorded (terminal + devices) under <cache>/live-terminal/.
//
// The terminal parts (node-pty, @xterm/headless) live in the prototype's
// folder for now; they are not Chattering dependencies yet.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROTO = path.join(__dirname, 'prototypes', 'terminal-document');

function load() {
  try {
    return {
      TerminalHost: require(path.join(PROTO, 'host.js')).TerminalHost,
      createHub: require(path.join(PROTO, 'hub.js')).createHub,
      CLAUDE: require(path.join(PROTO, 'reader.js')).CLAUDE,
      GENERIC: require(path.join(PROTO, 'reader.js')).GENERIC,
    };
  } catch (e) {
    return { error: 'The live terminal needs the prototype\'s modules (cd prototypes/terminal-document && npm install): ' + e.message.split('\n')[0] };
  }
}

function createLiveTerminals({ cacheDir, claudeBin = () => 'claude', claudeProjects, env = () => process.env, log = () => {} }) {
  const parts = load();
  const sessions = new Map(); // conversation key → { host, hub, startedAt, record, sessionId, cwd }
  const dir = path.join(cacheDir, 'live-terminal');

  function status(key) {
    const s = sessions.get(key);
    return { available: !parts.error, why: parts.error || '', running: !!(s && !s.host.exited), startedAt: s ? s.startedAt : null, record: s ? s.record : null };
  }

  // Continue an existing conversation in its own program: `command` is the
  // program and its arguments (claude --resume ID, pi --session FILE,
  // codex resume ID). Or start a new Claude Code one in `cwd` with a session
  // id chosen here, so its file and key are known before it exists.
  function start(key, { cwd, sessionId = null, resume = true, command = null, harness = 'claude' }) {
    if (parts.error) throw new Error(parts.error);
    const old = sessions.get(key);
    if (old && !old.host.exited) return old;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = sessionId || crypto.randomUUID();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const record = path.join(dir, id + '-' + stamp + '.cast');
    const [bin, ...args] = command || [claudeBin(), ...(resume ? ['--resume', id] : ['--session-id', id])];
    const host = new parts.TerminalHost({ command: bin, args, cwd, env: env(), cols: 100, rows: 34, record });
    // Claude Code's marks are known; Pi and Codex are read with the generic
    // rules (a prompt mark on the cursor's line, frame lines or not).
    const hub = parts.createHub({ host, profile: harness === 'claude' ? parts.CLAUDE : parts.GENERIC, events: record.replace(/\.cast$/, '.events.jsonl'), liveOnly: true });
    const s = { host, hub, startedAt: Date.now(), record, sessionId: id, cwd, key, harness };
    sessions.set(key, s);
    host.on('exit', e => { log('live terminal: claude ended for ' + key + ' (' + JSON.stringify(e) + ')'); setTimeout(() => { if (sessions.get(key) === s) { hub.close(); sessions.delete(key); } }, 60000).unref?.(); });
    log('live terminal: ' + path.basename(bin) + ' ' + args.join(' ') + ' in ' + cwd);
    return s;
  }

  // The key and file a new conversation will have (Claude Code's layout:
  // ~/.claude/projects/<folder with every non-alphanumeric as ->/<id>.jsonl).
  function newSession(cwd) {
    const id = crypto.randomUUID();
    const folder = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
    const file = path.join(claudeProjects, folder, id + '.jsonl');
    const key = 'claude:' + path.relative(claudeProjects, file);
    start(key, { cwd, sessionId: id, resume: false });
    return { key, file, sessionId: id };
  }

  function stop(key) {
    const s = sessions.get(key);
    if (!s) return false;
    s.hub.close(); s.host.kill(); sessions.delete(key);
    return true;
  }
  function stopAll() { for (const k of [...sessions.keys()]) stop(k); }

  // A page's connection (Chattering's WsConn) joins the conversation's hub.
  function attach(key, conn, { name } = {}) {
    const s = sessions.get(key);
    if (!s) { conn.send(JSON.stringify({ t: 'ended', why: 'not running' })); conn.close(4404, 'not running'); return false; }
    s.hub.attach(conn, { name });
    return true;
  }

  return { status, start, newSession, stop, stopAll, attach, sessions, available: !parts.error, why: parts.error || '' };
}

module.exports = { createLiveTerminals };
