'use strict';
// The terminal host: the unmodified CLI on a real pseudoterminal, and a
// complete terminal state machine (xterm.js headless, the engine VS Code's
// terminal uses) as the single source of truth. Nothing here knows any CLI.
//
// - Bytes from the program go into the emulator; the emulator's own replies
//   (cursor-position reports, device attributes…) go back to the program,
//   exactly as a visible terminal would answer.
// - Every byte both ways can be recorded with its time (asciicast v2,
//   recorder.js), so any session replays into the reader deterministically.
// - A "frame" is published after the emulator has parsed a burst of output,
//   coalesced to at most one per macrotask, with the inputs it answers.
//
// The pseudoterminal is either spawned here (node-pty) or handed in: any
// object with write, resize, kill, onData, onExit — the terminal holder of
// pty-holder.js, which keeps a program alive across a Chattering restart.

const { EventEmitter } = require('node:events');
const { terminalDeps } = require('./deps');

// Programs that redraw everything (Claude Code after a panel closes, on a
// resize): cursor home, then every line of the screen erased, or "erase
// display". The screen then restarts; what had scrolled up earlier may be
// printed again. Each restart is remembered as the buffer row where it
// began, so the reader can tell a reprint from new content. Observed from
// the parser itself, so it works the same live and when replaying.
function watchRepaints(term) {
  const restarts = [];
  let homeAt = null, erased = 0;
  term.parser.registerCsiHandler({ final: 'H' }, params => {
    const row = params.length ? (params[0] || 1) : 1, col = params.length > 1 ? (params[1] || 1) : 1;
    if (row === 1 && col === 1) { homeAt = term.buffer.active.baseY; erased = 0; }
    return false;
  });
  term.parser.registerCsiHandler({ final: 'K' }, params => {
    if (homeAt != null && params.length && params[0] === 2 && ++erased === term.rows - 1 && restarts.at(-1) !== homeAt) restarts.push(homeAt);
    return false;
  });
  term.parser.registerCsiHandler({ final: 'J' }, params => {
    if (params.length && params[0] === 2) { const at = term.buffer.active.baseY; if (restarts.at(-1) !== at) restarts.push(at); }
    if (params.length && params[0] === 3) restarts.length = 0; // scrollback cleared: nothing to compare with
    return false;
  });
  return restarts;
}

class TerminalHost extends EventEmitter {
  // scrollback: rows kept above the screen. A live strip reads the screen
  // only (snapshot({ screenOnly })), so a long session costs no more per
  // update than a short one; the prototype's full reader reads them all.
  // replay: the screen of a program already running (serialized by the
  // holder), fed to the engine first so the screen is exactly as it was.
  // answerQueries: false when the holder's own engine answers the
  // program's terminal queries (two answers would reach it).
  constructor({ command, args = [], cwd, env = process.env, cols = 100, rows = 34, recorder = null, pty = null, scrollback = 10000, replay = null, answerQueries = true }) {
    super();
    const deps = terminalDeps();
    if (deps.error) throw new Error(deps.error);
    this.cols = cols; this.rows = rows;
    this.term = new deps.Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.restarts = watchRepaints(this.term);
    // The window title the program sets (some show "working" there).
    this.title = '';
    this.term.onTitleChange(t => { this.title = t; });
    this.t0 = performance.now();
    this.recorder = recorder;
    this.pending = [];          // inputs written, waiting for the program's reaction
    this.revision = 0;
    this.stats = { bytesOut: 0, chunks: 0, frames: 0, parseMs: 0 };
    this.lastOutputAt = 0; this.lastInputAt = 0;
    if (replay) { this.term.write(replay); this.sawInputModes = true; }
    this.proc = pty || deps.pty.spawn(command, args, { cols, rows, cwd, name: 'xterm-256color', env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
    this.pid = this.proc.pid;
    if (recorder) recorder.start({ cols, rows, title: [command, ...args].join(' ') });
    // The emulator answers terminal queries; the answers are the program's input.
    if (answerQueries) this.term.onData(reply => this.proc.write(reply));
    this.proc.onData(data => this.onOutput(data));
    this.proc.onExit(e => { this.exited = e; if (this.recorder) this.recorder.close(); this.emit('exit', e); });
    this.frameQueued = false;
  }

  now() { return performance.now() - this.t0; }

  onOutput(data) {
    const at = performance.now();
    this.stats.bytesOut += data.length; this.stats.chunks++; this.lastOutputAt = Date.now();
    if (this.recorder) this.recorder.output(data);
    // First output after an input: the program reacted (not yet parsed).
    for (const p of this.pending) if (p.firstByteAt == null) p.firstByteAt = at;
    // Cursor visibility is not in xterm's public mode list: follow it here.
    const vis = data.lastIndexOf('\x1b[?25h'), hid = data.lastIndexOf('\x1b[?25l');
    if (vis !== hid) this.cursorVisible = vis > hid;
    this.term.write(data, () => {
      this.stats.parseMs += performance.now() - at;
      this.revision++;
      if (!this.frameQueued) { this.frameQueued = true; setImmediate(() => this.publish()); }
    });
  }

  publish() {
    this.frameQueued = false;
    this.stats.frames++;
    const answered = this.pending.filter(p => p.firstByteAt != null);
    this.pending = this.pending.filter(p => p.firstByteAt == null);
    this.emit('frame', { revision: this.revision, at: performance.now(), answered });
  }

  // Is the program reading keys now? Raw mode comes too early (Claude Code
  // drops keys for ~450 ms after it). Programs with a line editor turn on
  // their input protocol (bracketed paste, focus reports) once they listen:
  // that is the signal. A program that never does is ready after a quiet
  // second. Measured, not guessed: see results/.
  inputReady() {
    const m = this.term.modes;
    if (m.bracketedPasteMode || m.sendFocusMode) { this.sawInputModes = true; this.modesOffSince = null; return true; }
    const now = performance.now();
    if (!this.sawInputModes) return now - this.t0 > 1500;
    // Modes switched off between screens (a dialog closing): hold briefly.
    if (this.modesOffSince == null) this.modesOffSince = now;
    return now - this.modesOffSince > 800;
  }

  flushHeld() {
    if (!this.held || !this.held.length || !this.inputReady()) return;
    const held = this.held; this.held = [];
    this.stats.heldMs = (this.stats.heldMs || 0) + (performance.now() - held[0].at);
    for (const h of held) this.write(h.bytes, h.id, h.at);
  }

  // Bytes to the program, as typed or pasted into a terminal. `id` lets a
  // client match the frame that answers this input (for latency). Input
  // that arrives before the program listens is held, in order, not lost.
  input(bytes, id = null) {
    if (!this.inputReady() || (this.held && this.held.length)) {
      (this.held ||= []).push({ bytes, id, at: performance.now() });
      clearTimeout(this.heldTimer);
      const poll = () => { this.flushHeld(); if (this.held.length) this.heldTimer = setTimeout(poll, 25); };
      this.heldTimer = setTimeout(poll, 25);
      return;
    }
    this.write(bytes, id, performance.now());
  }

  write(bytes, id, typedAt) {
    if (this.recorder) this.recorder.input(bytes);
    this.lastInputAt = Date.now();
    this.pending.push({ id, writtenAt: typedAt, firstByteAt: null });
    if (this.pending.length > 256) this.pending.shift();
    this.proc.write(bytes);
  }

  // Text the way a terminal pastes it: bracketed when the program asked.
  paste(text, id) {
    const clean = String(text).replace(/\x1b\[20[01]~/g, '').replace(/\r?\n/g, '\r');
    this.input(this.term.modes.bracketedPasteMode ? '\x1b[200~' + clean + '\x1b[201~' : clean, id);
  }

  resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    this.term.resize(cols, rows); this.proc.resize(cols, rows);
    if (this.recorder) this.recorder.resize(cols, rows);
  }

  // The whole buffer (scrollback + screen) as styled rows: the reader's input.
  // screenOnly: the visible screen alone, as if it were the whole buffer
  // (base 0, no restarts): what a live strip needs, bounded by the screen.
  snapshot({ screenOnly = false } = {}) {
    const b = this.term.buffer.active, cell = b.getNullCell();
    const lines = [];
    const from = screenOnly ? b.baseY : 0, to = screenOnly ? Math.min(b.length, b.baseY + this.rows) : b.length;
    for (let y = from; y < to; y++) {
      const line = b.getLine(y);
      const runs = []; let run = null;
      for (let x = 0; x < this.cols; x++) {
        const c = line.getCell(x, cell);
        if (!c || c.getWidth() === 0) continue;
        // flags|foreground|background — e.g. "db|p12|" (dim bold, palette 12).
        const color = (def, mode, value) => def ? '' : (mode === 0x1000000 ? 'p' : mode === 0x2000000 ? 'r' : 'x') + value;
        const style = (c.isDim() ? 'd' : '') + (c.isBold() ? 'b' : '') + (c.isItalic() ? 'i' : '') + (c.isInverse() ? 'v' : '')
          + '|' + color(c.isFgDefault(), c.getFgColorMode(), c.getFgColor()) + '|' + color(c.isBgDefault(), c.getBgColorMode(), c.getBgColor());
        const ch = c.getChars() || ' ';
        if (!run || run.s !== style) { run = { s: style, t: '' }; runs.push(run); }
        run.t += ch;
      }
      lines.push({ text: runs.map(r => r.t).join('').replace(/\s+$/, ''), runs, wrapped: line.isWrapped });
    }
    const base = screenOnly ? 0 : b.baseY;
    return {
      lines, cols: this.cols, rows: this.rows, base, viewport: screenOnly ? 0 : b.viewportY,
      cursor: { x: b.cursorX, y: base + b.cursorY, visible: this.cursorVisible !== false },
      alternate: b.type === 'alternate',
      modes: { bracketedPaste: this.term.modes.bracketedPasteMode, appCursor: this.term.modes.applicationCursorKeysMode },
      restarts: screenOnly ? [] : (this.restarts || []).slice(),
      title: this.title || '',
      revision: this.revision,
    };
  }

  kill() { clearTimeout(this.heldTimer); try { this.proc.kill(); } catch {} if (this.recorder) this.recorder.close(); }
  // Let go of the program without ending it (a holder keeps it running).
  detach() { clearTimeout(this.heldTimer); if (this.proc.detach) this.proc.detach(); if (this.recorder) this.recorder.close(); }
}

// Keys as a terminal sends them (xterm conventions). The browser sends
// key descriptions; the host, which knows the program's modes, encodes.
function encodeKey(k, modes = {}) {
  const ss3 = modes.appCursor;
  const arrow = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' }[k.key];
  const mod = 1 + (k.shift ? 1 : 0) + (k.alt ? 2 : 0) + (k.ctrl ? 4 : 0);
  if (arrow) return mod > 1 ? '\x1b[1;' + mod + arrow : (ss3 ? '\x1bO' : '\x1b[') + arrow;
  switch (k.key) {
    case 'Enter': return k.shift || k.alt ? '\x1b\r' : '\r'; // Claude Code and Pi read ESC+CR as a new line
    case 'Backspace': return k.ctrl || k.alt ? '\x17' : '\x7f';
    case 'Delete': return '\x1b[3~';
    case 'Tab': return k.shift ? '\x1b[Z' : '\t';
    case 'Escape': return '\x1b';
    case 'Home': return '\x1b[H';
    case 'End': return '\x1b[F';
    case 'PageUp': return '\x1b[5~';
    case 'PageDown': return '\x1b[6~';
  }
  if (k.key && k.key.length === 1) {
    if (k.ctrl && /^[a-z@\[\\\]^_ ]$/i.test(k.key)) return String.fromCharCode(k.key === ' ' ? 0 : k.key.toUpperCase().charCodeAt(0) & 31);
    return (k.alt ? '\x1b' : '') + k.key;
  }
  return '';
}

module.exports = { TerminalHost, encodeKey, watchRepaints };
