'use strict';
// Conversations continued through the agent's own interactive program
// (Claude Code, Pi, Codex…) on an invisible terminal (design/91). The
// conversation itself is Chattering's own view of the agent's session file;
// only the live part comes from the terminal: the input box, suggestions,
// questions, panels, "working…", and while it works a window of the
// terminal as drawn.
//
// - One program per conversation, shared by every device (hub.js: patches,
//   one typist at a time, nothing applied twice).
// - Programs live in the terminal holder (terminal/pty-holder.js), so a
//   restart of Chattering does not end them: on start, Chattering attaches
//   to what still runs and the screen comes back exactly.
// - A program that has been idle (nothing typed, not working, its box
//   empty, no question open) for the set time is ended; the next message
//   starts it again from the session file. Text left in its box is kept and
//   put back.
// - Every session is recorded (terminal + devices, gzip, private) unless the
//   setting is off: the trace that makes any glitch replayable.
//
// Nothing here knows an agent: profiles (terminal/profiles.js) say how to
// start or resume each one; the server resolves programs and environments
// and decides who may do what.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { terminalDeps } = require('./terminal/deps');
const { profileFor } = require('./terminal/profiles');

const COLS = 100, ROWS = 34;

// The id of a new conversation, in the shape its program accepts. Pi names
// its files with time-ordered ids (UUID v7), and Chattering's short ids come
// from their first characters.
function newId(pattern) {
  if (pattern !== 'uuidv7') return crypto.randomUUID();
  const b = crypto.randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function createLiveTerminals({
  dataDir,                       // recordings and the holder's state live here
  commandFor,                    // (profile, args, { sessionId, sessionPath, cwd, isNew }) → [file, ...args]
  envFor = () => process.env,    // (principal) → the program's environment
  settings = () => ({}),         // () → { record, idleMinutes }
  onState = () => {},            // (key, state) when a program's state changes
  log = () => {},
  useHolder = true,              // false: programs live in this process (tests)
  holderStart = null,            // how the holder process is started (see pty-holder.js)
}) {
  const deps = terminalDeps();
  const { TerminalHost } = require('./terminal/host');
  const { createHub } = require('./terminal/hub');
  const { createRecorder, createEventLog } = require('./terminal/recorder');
  const { connectHolder } = require('./terminal/pty-holder');
  const sessions = new Map();    // conversation key → session
  const keptDrafts = new Map();  // key → text left in a program's box when it was ended
  const dir = path.join(dataDir, 'live-terminal');
  let holder = null;

  const conf = () => ({ record: true, idleMinutes: 30, ...settings() });

  async function getHolder() {
    if (holder && !holder.closed) return holder;
    holder = await connectHolder({ dir: path.join(dir, 'holder'), start: holderStart });
    holder.onLost(() => { holder = null; });
    return holder;
  }

  function recordingFiles(profile, sessionId) {
    if (!conf().record) return null;
    const now = new Date(), day = now.toISOString().slice(0, 10);
    const stamp = now.toISOString().slice(11, 19).replace(/:/g, '');
    const base = path.join(dir, 'recordings', day, `${stamp}-${profile.id}-${sessionId || 'new'}`);
    return { cast: base + '.cast.gz', events: base + '.events.jsonl.gz' };
  }

  // A program on a terminal, with its hub, for conversation `key`.
  function track(key, { host, profile, record, cwd, sessionId, userId = null, startedAt = Date.now(), recovered = false }) {
    const s = { key, host, profile, cwd, sessionId, userId, startedAt, record, recovered, notice: null };
    s.hub = createHub({ host, profile, liveOnly: true, events: record && record.events && conf().record ? createEventLog(record.events) : null,
      onState: st => onState(s.key, { ...st, harness: profile.id }) });
    sessions.set(key, s);
    host.on('exit', e => {
      log('live terminal: ' + profile.id + ' ended for ' + s.key + ' (' + JSON.stringify(e) + ')');
      // A program already replaced by a new one for this conversation (ended
      // here, then started again) says nothing: its end is not the new one's.
      const now = sessions.get(s.key);
      if (now && now !== s) return;
      onState(s.key, { ...s.hub.state(), harness: profile.id });
      // Devices see "ended" for a while, then the hub goes.
      setTimeout(() => { if (sessions.get(s.key) === s) { s.hub.close(); sessions.delete(s.key); } }, 60000).unref?.();
    });
    return s;
  }

  // Start `key`'s program: resume a conversation, or begin a new one.
  //   profileId  'claude' | 'pi' | 'codex' | …
  //   cwd        the conversation's folder
  //   sessionId, sessionPath  what the profile's arguments ask for
  //   isNew      begin a new conversation (the profile's `start`)
  //   principal  who drives it (for the environment)
  //   launch     (argv) → { file, args, env }: the caller's walls around the
  //              program (a guest's bubblewrap, their slice); by default the
  //              program as is, in envFor(principal)
  //   userId     who started it (their "stop their work" ends it)
  async function start(key, { profileId, cwd, sessionId = null, sessionPath = null, isNew = false, principal = null, launch = null, userId = null }) {
    if (deps.error) throw new Error(deps.error);
    const old = sessions.get(key);
    if (old && !old.host.exited) return old;
    if (old) { old.hub.close(); sessions.delete(key); }
    const profile = profileFor(profileId);
    const template = isNew ? profile.start : profile.resume;
    if (!profile.program || !template) throw new Error(profile.name + ' cannot be ' + (isNew ? 'started' : 'continued') + ' here');
    const plain = commandFor(profile, require('./terminal/profiles').fill(template, { sessionId, sessionPath }), { sessionId, sessionPath, cwd, isNew });
    const launched = launch ? launch(plain) : { file: plain[0], args: plain.slice(1), env: envFor(principal) };
    const argv = [launched.file, ...launched.args], env = launched.env;
    const record = recordingFiles(profile, sessionId);
    let host;
    if (useHolder) {
      const h = await getHolder();
      const pty = await h.spawn({ command: argv[0], args: argv.slice(1), cwd, env, cols: COLS, rows: ROWS, record: record && record.cast,
        meta: { key, profile: profile.id, cwd, sessionId, sessionPath, userId, events: record && record.events } });
      host = new TerminalHost({ pty, cols: COLS, rows: ROWS, scrollback: 200, answerQueries: false, command: argv[0], args: argv.slice(1) });
    } else {
      host = new TerminalHost({ command: argv[0], args: argv.slice(1), cwd, env, cols: COLS, rows: ROWS, scrollback: 200, recorder: record ? createRecorder(record.cast) : null });
    }
    log('live terminal: ' + (launch ? '(walled) ' : '') + path.basename(plain[0]) + ' ' + plain.slice(1).join(' ') + ' in ' + cwd);
    const s = track(key, { host, profile, record, cwd, sessionId, userId });
    // Text left in its box when it was last ended goes back in.
    const kept = keptDrafts.get(key);
    if (kept) {
      keptDrafts.delete(key);
      s.hub.until(d => d.composer && !d.choice && !d.status, 15000).then(() => require('./terminal/actions').setComposerText(host, kept, { profile })).catch(() => {});
    }
    return s;
  }

  // A new conversation's id, chosen before it starts when its program
  // accepts one (Claude Code, Pi); null when the program picks (Codex).
  function newSessionId(profileId) {
    const p = profileFor(profileId);
    return p.newSession === 'known-id' ? newId(p.idPattern) : null;
  }

  // Programs that outlived the last Chattering: attach to them again. A
  // holder is not started for this: if none runs, nothing outlived.
  async function recover() {
    if (!useHolder || deps.error) return [];
    if (!fs.existsSync(path.join(dir, 'holder', 'holder.token'))) return [];
    let h;
    try { h = await getHolder(); } catch (e) { log('live terminal: no holder to recover from (' + e.message + ')'); return []; }
    const found = [];
    for (const p of await h.list()) {
      const key = p.meta && p.meta.key;
      if (!key || p.exited || sessions.has(key)) continue;
      try {
        const back = await h.attach(p.id);
        const profile = profileFor(p.meta.profile);
        const host = new TerminalHost({ pty: back.pty, cols: p.cols, rows: p.rows, scrollback: 200, answerQueries: false, replay: back.screen, command: p.meta.profile });
        track(key, { host, profile, userId: p.meta.userId || null, record: p.meta.events ? { events: p.meta.events.replace(/\.events\.jsonl\.gz$/, '') + '.after-restart.events.jsonl.gz' } : null, cwd: p.meta.cwd, sessionId: p.meta.sessionId, startedAt: p.startedAt, recovered: true });
        found.push(key);
      } catch (e) { log('live terminal: could not attach to ' + key + ': ' + e.message); }
    }
    if (found.length) log('live terminal: attached again to ' + found.length + ' program(s) after a restart');
    return found;
  }

  function status(key) {
    const s = sessions.get(key);
    return {
      available: !deps.error, why: deps.error || '',
      running: !!(s && !s.host.exited), harness: s ? s.profile.id : null,
      startedAt: s ? s.startedAt : null, recovered: !!(s && s.recovered),
      state: s ? s.hub.state() : null, notice: s ? s.notice : null,
      keptDraft: keptDrafts.has(key),
    };
  }

  // A message for `key`'s program from the server side (a new
  // conversation's first message; a message typed while it had ended):
  // waits for its box, answers 'question' if it asks something first.
  async function send(key, text, { timeoutMs = 60000 } = {}) {
    const s = sessions.get(key);
    if (!s || s.host.exited) throw new Error('the program is not running');
    const d = await s.hub.until(x => (x.composer && !x.status) || x.choice, timeoutMs);
    if (d.choice) return { question: true };
    await s.hub.submit(text);
    return { sent: true };
  }

  function stop(key, { keepDraft = false } = {}) {
    const s = sessions.get(key);
    if (!s) return false;
    if (keepDraft && !s.host.exited) {
      const d = require('./terminal/reader').readDocument(s.host.snapshot({ screenOnly: true }), s.profile);
      if (d.composer && d.composer.text.trim()) keptDrafts.set(key, d.composer.text);
    }
    s.hub.close(); s.host.kill(); sessions.delete(key);
    onState(key, { mode: 'ended', working: false, waiting: false, exited: { exitCode: 0 }, harness: s.profile.id });
    return true;
  }
  function stopAll() { for (const k of [...sessions.keys()]) stop(k); }
  // Someone's "stop their work" (settings → people): their programs end.
  function stopUser(userId) { let n = 0; for (const [k, s] of [...sessions]) if (s.userId && s.userId === userId) { stop(k); n++; } return n; }
  // Chattering is ending: let go of the programs, which go on in the holder.
  function detachAll() {
    for (const s of sessions.values()) { s.hub.close(); if (useHolder) s.host.detach(); else s.host.kill(); }
    sessions.clear();
    if (holder) { holder.close(); holder = null; }
  }

  // Idle programs end; their box text is kept for the next start.
  function reap(now = Date.now()) {
    const idleMs = Math.max(1, Number(conf().idleMinutes) || 30) * 60000;
    for (const [key, s] of sessions) {
      if (s.host.exited) continue;
      const st = s.hub.state();
      const last = Math.max(st.lastInputAt, s.startedAt);
      if (st.working) continue;
      // A question or a half-written message waits four times longer.
      const busyBox = st.waiting || st.mode === 'panel';
      if (now - last > idleMs * (busyBox ? 4 : 1)) {
        log('live terminal: ending idle ' + s.profile.id + ' for ' + key);
        stop(key, { keepDraft: true });
      }
    }
  }
  const reaper = setInterval(() => { try { reap(); } catch (e) { log('live terminal: ' + e.message); } }, 60000);
  reaper.unref?.();

  // A new conversation's program, started under a temporary key, takes
  // the conversation's own once its file exists. The holder is told too,
  // so a restart attaches it under the right one.
  function rekey(from, to) {
    const s = sessions.get(from);
    if (!s || from === to) return false;
    sessions.delete(from); s.key = to; sessions.set(to, s);
    if (useHolder && holder && s.host.proc && s.host.proc.id) holder.meta(s.host.proc.id, { key: to }).catch(() => {});
    return true;
  }

  // A device's connection joins the conversation's hub.
  function attach(key, conn, { name } = {}) {
    const s = sessions.get(key);
    if (!s) { conn.send(JSON.stringify({ t: 'ended', why: 'not running' })); conn.close(4404, 'not running'); return false; }
    s.hub.attach(conn, { name });
    return true;
  }

  // Something about this program the devices should know (another program
  // writing the same conversation…), shown above its box.
  function setNotice(key, text) { const s = sessions.get(key); if (s && s.notice !== text) { s.notice = text; s.hub.notice(text); } }

  // The processes Chattering runs live: not "a terminal elsewhere".
  function ownPids() {
    const pids = new Set();
    for (const s of sessions.values()) if (s.host.pid) pids.add(s.host.pid);
    return { pids, holderPid: holder ? holder.pid : null };
  }

  function close() { clearInterval(reaper); detachAll(); }

  return { status, start, newSessionId, send, stop, stopAll, stopUser, detachAll, recover, attach, reap, setNotice, ownPids, rekey, close, sessions,
    available: !deps.error, why: deps.error || '' };
}

module.exports = { createLiveTerminals, newId };
