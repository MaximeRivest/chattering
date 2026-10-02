'use strict';
// The terminal holder: one small process that owns the pseudoterminals of
// the programs Chattering runs live (Claude Code, Pi, Codex…), so that a
// program, and the reply it is writing, outlive a restart of Chattering.
// VS Code keeps its terminals across window reloads the same way (its "pty
// host"), and hands the screen back with the same serializer.
//
//   node pty-holder.js <state folder>        the holder itself
//   connectHolder({ dir })                   Chattering's side (below)
//
// The holder knows nothing of agents or pages. For each program it keeps:
//   - the pseudoterminal (node-pty), the program's environment as given;
//   - a headless terminal engine of its own, which answers the program's
//     terminal queries even while Chattering is away, and from which the
//     exact screen (text, colours, cursor, input modes) is serialized when
//     Chattering attaches again;
//   - the recording (recorder.js), so a restart leaves no gap in it.
//
// Access: a socket (a named pipe on Windows) beside a token file, both in
// a folder only this account can read; a connection that does not present
// the token first is closed. Programs a guest runs are wrapped in their
// walls by the caller before they get here.
//
// Lifetime: the holder ends once it has had no program for IDLE_MS. If no
// Chattering has been connected for ORPHAN_MS, it ends its programs (the
// app is gone, or was removed) and then itself.
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PROTOCOL = 1;
const IDLE_MS = 30 * 1000;
const ORPHAN_MS = 30 * 60 * 1000;
const EXITED_KEEP_MS = 60 * 1000;

// Where the socket lives. Unix sockets have a ~104-byte path limit: a long
// state folder gets a short private one in the temporary folder instead.
function socketPath(dir) {
  if (process.platform === 'win32') return '\\\\.\\pipe\\chattering-pty-' + crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 24);
  const p = path.join(dir, 'holder.sock');
  if (Buffer.byteLength(p) < 100) return p;
  const short = path.join(os.tmpdir(), 'chattering-pty-' + crypto.createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 16));
  fs.mkdirSync(short, { recursive: true, mode: 0o700 });
  return path.join(short, 's');
}
const tokenFile = dir => path.join(dir, 'holder.token');

// Newline-delimited JSON both ways.
function lines(socket, onMessage) {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { socket.destroy(); return; }
      onMessage(m);
    }
  });
}
const sendTo = (socket, m) => { if (!socket.destroyed) socket.write(JSON.stringify(m) + '\n'); };

// ---------------------------------------------------------------- the holder
function runHolder(dir, { idleMs = IDLE_MS, orphanMs = ORPHAN_MS, log = m => process.stderr.write(new Date().toISOString() + ' ' + m + '\n') } = {}) {
  const { terminalDeps } = require('./deps');
  const { createRecorder } = require('./recorder');
  const deps = terminalDeps();
  if (deps.error) { log(deps.error); process.exit(2); }
  const { SerializeAddon } = require(path.join(__dirname, '..', '..', 'runtime', 'node_modules', '@xterm', 'addon-serialize'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(24).toString('hex');
  const programs = new Map(); // id → program
  const clients = new Set();
  let lastClientAt = Date.now(), emptySince = Date.now();

  function startProgram(m) {
    if (programs.has(m.id)) throw new Error('a program with this id is running');
    const cols = m.cols | 0 || 100, rows = m.rows | 0 || 34;
    const term = new deps.Terminal({ cols, rows, scrollback: m.scrollback | 0 || 1000, allowProposedApi: true });
    const serializer = new SerializeAddon(); term.loadAddon(serializer);
    const proc = deps.pty.spawn(m.command, m.args || [], { cols, rows, cwd: m.cwd, name: 'xterm-256color', env: { ...(m.env || {}), TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
    const recorder = m.record ? createRecorder(m.record) : null;
    if (recorder) recorder.start({ cols, rows, title: [m.command, ...(m.args || [])].join(' ') });
    const p = { id: m.id, pid: proc.pid, proc, term, serializer, recorder, cols, rows, meta: m.meta || {}, startedAt: Date.now(), exited: null, watchers: new Set() };
    // A query the program asks its terminal (cursor position, attributes)
    // is answered here, present or not Chattering.
    term.onData(reply => { if (!p.exited) proc.write(reply); });
    proc.onData(data => {
      if (recorder) recorder.output(data);
      // Forwarded once parsed: an attach serializes exactly what was
      // parsed and receives everything after it, nothing twice or lost.
      term.write(data, () => { for (const w of p.watchers) sendTo(w, { t: 'o', id: p.id, d: data }); });
    });
    proc.onExit(e => {
      p.exited = { exitCode: e.exitCode, signal: e.signal || 0, at: Date.now() };
      if (recorder) recorder.close();
      term.write('', () => { for (const w of p.watchers) sendTo(w, { t: 'exit', id: p.id, ...p.exited }); });
      setTimeout(() => { if (programs.get(p.id) === p) { programs.delete(p.id); term.dispose(); } }, EXITED_KEEP_MS).unref();
      log('program ' + p.id + ' ended (' + JSON.stringify(e) + ')');
    });
    programs.set(p.id, p);
    log('program ' + p.id + ' started: pid ' + proc.pid + ' ' + path.basename(m.command));
    return p;
  }
  const describe = p => ({ id: p.id, pid: p.pid, cols: p.cols, rows: p.rows, meta: p.meta, startedAt: p.startedAt, exited: p.exited });

  const server = net.createServer(socket => {
    let authed = false;
    const watching = new Set();
    lines(socket, m => {
      if (!authed) {
        if (m.t !== 'hello' || typeof m.token !== 'string' || m.token.length !== token.length || !crypto.timingSafeEqual(Buffer.from(m.token), Buffer.from(token))) { socket.destroy(); return; }
        authed = true; clients.add(socket); lastClientAt = Date.now();
        sendTo(socket, { t: 'hello', protocol: PROTOCOL, pid: process.pid });
        return;
      }
      lastClientAt = Date.now();
      const reply = (extra) => sendTo(socket, { t: 'reply', n: m.n, ...extra });
      const p = m.id != null ? programs.get(m.id) : null;
      try {
        switch (m.t) {
          case 'spawn': { const q = startProgram(m); q.watchers.add(socket); watching.add(q); return reply({ program: describe(q) }); }
          case 'list': return reply({ programs: [...programs.values()].map(describe) });
          case 'attach': {
            if (!p) return reply({ error: 'no such program' });
            // Everything parsed so far, then (from the same moment) the rest.
            return p.term.write('', () => {
              p.watchers.add(socket); watching.add(p);
              reply({ program: describe(p), screen: p.serializer.serialize({ scrollback: m.scrollback | 0 }) });
            });
          }
          case 'detach': if (p) { p.watchers.delete(socket); watching.delete(p); } return reply({});
          case 'write': if (p && !p.exited) { p.proc.write(String(m.d)); if (p.recorder) p.recorder.input(String(m.d)); } return;
          case 'resize': {
            if (!p || p.exited) return;
            const cols = Math.max(20, Math.min(400, m.cols | 0)), rows = Math.max(5, Math.min(200, m.rows | 0));
            p.cols = cols; p.rows = rows; p.term.resize(cols, rows); p.proc.resize(cols, rows);
            if (p.recorder) p.recorder.resize(cols, rows);
            return;
          }
          case 'meta': if (p) p.meta = { ...p.meta, ...(m.meta || {}) }; return reply({});
          case 'kill': if (p && !p.exited) { try { p.proc.kill(m.signal || undefined); } catch {} } return reply({});
          case 'shutdown': reply({}); return shutdown('asked');
          default: return reply({ error: 'unknown request' });
        }
      } catch (e) { reply({ error: e.message }); }
    });
    const gone = () => { clients.delete(socket); for (const p of watching) p.watchers.delete(socket); lastClientAt = Date.now(); };
    socket.on('close', gone); socket.on('error', gone);
  });

  function shutdown(why) {
    log('holder ending: ' + why);
    for (const p of programs.values()) if (!p.exited) { try { p.proc.kill(); } catch {} }
    server.close();
    try { if (process.platform !== 'win32') fs.unlinkSync(socketPath(dir)); } catch {}
    try { fs.unlinkSync(tokenFile(dir)); } catch {}
    setTimeout(() => process.exit(0), 300).unref();
  }

  const sock = socketPath(dir);
  const listen = () => server.listen(sock, () => {
    // The token is written only once the socket is ours: a client that
    // reads it can connect.
    fs.writeFileSync(tokenFile(dir), token, { mode: 0o600 });
    try { fs.chmodSync(tokenFile(dir), 0o600); if (process.platform !== 'win32') fs.chmodSync(sock, 0o600); } catch {}
    log('holder listening (pid ' + process.pid + ')');
  });
  server.on('error', e => {
    if (e.code !== 'EADDRINUSE') { log('holder: ' + e.message); process.exit(1); }
    // Another holder, or a stale socket from one that died.
    const probe = net.connect(sock);
    probe.on('connect', () => { probe.destroy(); log('another holder is running here'); process.exit(0); });
    probe.on('error', () => { try { fs.unlinkSync(sock); } catch {} listen(); });
  });
  listen();

  setInterval(() => {
    const live = [...programs.values()].filter(p => !p.exited).length;
    if (live) emptySince = Date.now();
    if (!clients.size && live && Date.now() - lastClientAt > orphanMs) return shutdown('no Chattering for ' + Math.round(orphanMs / 60000) + ' min');
    if (!live && Date.now() - emptySince > idleMs) return shutdown('no programs');
  }, Math.min(5000, idleMs)).unref?.();
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return { server, programs };
}

// ---------------------------------------------------------- Chattering's side
// connectHolder({ dir, start }) → a connection to the holder of `dir`,
// starting it when none runs (`start(argv)` spawns it detached; by default
// a plain detached node). The connection:
//   spawn(opts)  → a pty-like { pid, write, resize, kill, onData, onExit, detach }
//   attach(id)   → { pty, program, screen } for a program already running
//   list()       → the programs it holds, with the meta given at spawn
//   onLost(fn)   the holder went away (every pty also reports an exit)
// The holder is a node process: on a loaded computer it can take seconds
// to start, hence the generous wait.
function connectHolder({ dir, start = null, timeoutMs = 20000 } = {}) {
  const sock = socketPath(dir);
  const tryConnect = () => new Promise((resolve, reject) => {
    let token;
    try { token = fs.readFileSync(tokenFile(dir), 'utf8').trim(); } catch { return reject(new Error('no holder')); }
    const s = net.connect(sock);
    s.once('error', reject);
    s.once('connect', () => { s.removeListener('error', reject); resolve({ s, token }); });
  });
  return (async () => {
    let c;
    try { c = await tryConnect(); }
    catch {
      (start || defaultStart)([process.execPath, __filename, dir]);
      const until = Date.now() + timeoutMs;
      for (;;) {
        await new Promise(r => setTimeout(r, 50));
        try { c = await tryConnect(); break; } catch (e) { if (Date.now() > until) throw new Error('the terminal holder did not start within ' + Math.round(timeoutMs / 1000) + ' s (' + e.message + '; its log: ' + path.join(dir, 'holder.log') + ')'); }
      }
    }
    return client(c.s, c.token);
  })();
}

function defaultStart([node, script, dir]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = fs.openSync(path.join(dir, 'holder.log'), 'a', 0o600);
  const child = spawn(node, [script, dir], { detached: true, stdio: ['ignore', out, out], windowsHide: true, cwd: dir });
  child.unref();
  fs.closeSync(out);
}

function client(s, token) {
  let n = 0;
  const waiting = new Map(), ptys = new Map(), lost = [];
  let hello = null, closed = false, helloPid = null;
  const ready = new Promise((resolve, reject) => { hello = { resolve, reject }; });
  const send = m => sendTo(s, m);
  const request = m => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('the terminal holder is gone'));
    m.n = ++n; waiting.set(m.n, { resolve, reject }); send(m);
  });
  lines(s, m => {
    if (m.t === 'hello') { if (m.protocol !== PROTOCOL) { hello.reject(new Error('the running terminal holder speaks another version (' + m.protocol + '); it ends when its programs do')); s.destroy(); } else { helloPid = m.pid; hello.resolve(m); } return; }
    if (m.t === 'reply') { const w = waiting.get(m.n); if (w) { waiting.delete(m.n); m.error ? w.reject(new Error(m.error)) : w.resolve(m); } return; }
    const p = ptys.get(m.id);
    if (!p) return;
    if (m.t === 'o') for (const f of p.data) f(m.d);
    else if (m.t === 'exit') { ptys.delete(m.id); for (const f of p.exit) f({ exitCode: m.exitCode, signal: m.signal }); }
  });
  s.on('close', () => {
    closed = true;
    hello.reject(new Error('the terminal holder closed the connection'));
    for (const w of waiting.values()) w.reject(new Error('the terminal holder is gone'));
    waiting.clear();
    for (const [, p] of ptys) for (const f of p.exit) f({ exitCode: null, signal: 0, holderLost: true });
    ptys.clear();
    for (const f of lost) f();
  });
  s.on('error', () => {});
  send({ t: 'hello', token });

  const ptyFor = program => {
    const p = { data: [], exit: [] };
    ptys.set(program.id, p);
    return {
      pid: program.pid, id: program.id,
      write: d => send({ t: 'write', id: program.id, d }),
      resize: (cols, rows) => send({ t: 'resize', id: program.id, cols, rows }),
      kill: signal => send({ t: 'kill', id: program.id, signal }),
      onData: f => { p.data.push(f); },
      onExit: f => { p.exit.push(f); },
      // Chattering lets go; the program goes on in the holder.
      detach: () => { ptys.delete(program.id); send({ t: 'detach', id: program.id }); },
    };
  };
  return ready.then(() => ({
    async spawn(opts) { const id = opts.id || crypto.randomUUID(); const r = await request({ t: 'spawn', ...opts, id }); return ptyFor(r.program); },
    async attach(id, { scrollback = 0 } = {}) { const r = await request({ t: 'attach', id, scrollback }); return { pty: ptyFor(r.program), program: r.program, screen: r.screen }; },
    async list() { return (await request({ t: 'list' })).programs; },
    meta: (id, meta) => request({ t: 'meta', id, meta }),
    get pid() { return helloPid; },
    shutdown: () => request({ t: 'shutdown' }).catch(() => {}),
    onLost: f => lost.push(f),
    get closed() { return closed; },
    close: () => { closed = true; s.end(); },
  }));
}

module.exports = { connectHolder, runHolder, socketPath, PROTOCOL };

if (require.main === module) runHolder(process.argv[2] || path.join(os.homedir(), '.local', 'share', 'chattering', 'live-terminal'));
