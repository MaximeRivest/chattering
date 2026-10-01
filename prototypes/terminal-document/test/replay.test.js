'use strict';
// Recorded real sessions (recordings/*.cast, asciicast v2) replayed into the
// same terminal engine: the reader must reach the same document every time.
// Recordings are made by bench.js / browser-bench.js on this machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Terminal } = require('@xterm/headless');
const { readDocument } = require('../reader');

async function replay(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const head = JSON.parse(lines[0]);
  const term = new Terminal({ cols: head.width, rows: head.height, scrollback: 10000, allowProposedApi: true });
  const restarts = require('../host').watchRepaints(term);
  let bytes = 0;
  for (const l of lines.slice(1)) {
    const [, kind, data] = JSON.parse(l);
    if (kind === 'o') { bytes += data.length; await new Promise(r => term.write(data, r)); }
    else if (kind === 'r') { const [c, r] = data.split('x').map(Number); term.resize(c, r); }
  }
  // The same snapshot shape the host produces.
  const { TerminalHost } = require('../host');
  const snap = TerminalHost.prototype.snapshot.call({ term, cols: term.cols, rows: term.rows, revision: 0, cursorVisible: true, restarts });
  return { snap, bytes };
}
const cast = name => path.join(__dirname, '..', 'recordings', name + '.cast');

test('the live Claude Code session replays to the same conversation', { skip: !fs.existsSync(cast('claude-live')) }, async () => {
  const t0 = performance.now();
  const { snap, bytes } = await replay(cast('claude-live'));
  const ms = performance.now() - t0;
  const a = readDocument(snap), b = readDocument(snap);
  assert.deepEqual(a, b, 'deterministic');
  assert.equal(a.mode, 'compose');
  const kinds = a.transcript.map(x => x.kind);
  assert.ok(kinds.includes('user') && kinds.includes('tool') && kinds.includes('assistant'), kinds.join(','));
  console.log(`replayed ${bytes} bytes in ${ms.toFixed(0)} ms`);
});
test('every recording replays without a reader error', async () => {
  const dir = path.join(__dirname, '..', 'recordings');
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.cast')) : []) {
    const { snap } = await replay(path.join(dir, f));
    const d = readDocument(snap);
    assert.ok(['compose', 'choice', 'working', 'panel', 'unknown'].includes(d.mode), f);
    // No recording shows the welcome logo more than once in its conversation.
    assert.ok(d.transcript.map(b => b.text).join('\n').split('Claude Code v').length - 1 <= 1, f + ': logo repeated');
  }
});

test('a panel (/usage) and the full repaint after it: the logo once, the panel live, not in the conversation', async () => {
  const file = cast('claude-panel');
  // Replay up to the moment /usage is open, then to the end (closed).
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const head = JSON.parse(lines[0]);
  const { Terminal } = require('@xterm/headless');
  const { watchRepaints, TerminalHost } = require('../host');
  const term = new Terminal({ cols: head.width, rows: head.height, scrollback: 10000, allowProposedApi: true });
  const restarts = watchRepaints(term);
  const snap = () => TerminalHost.prototype.snapshot.call({ term, cols: term.cols, rows: term.rows, revision: 0, cursorVisible: true, restarts });
  let panelSeen = null, inputs = 0;
  for (const l of lines.slice(1)) {
    const [, kind, data] = JSON.parse(l);
    if (kind === 'i') { inputs++; if (data === '\x1b' && !panelSeen) panelSeen = readDocument(snap()); continue; }
    if (kind === 'o') await new Promise(r => term.write(data, r));
    else if (kind === 'r') { const [c, r] = data.split('x').map(Number); term.resize(c, r); }
  }
  assert.equal(panelSeen.mode, 'panel');
  assert.ok(panelSeen.live.length && panelSeen.live.some(b => b.lines.some(runs => runs.map(r => r.t).join('').includes('Usage'))), 'the panel is live');
  assert.ok(!panelSeen.transcript.some(b => /Total cost|Current week/.test(b.text)), 'the panel is not in the conversation');
  assert.equal(panelSeen.live.length, 1, 'the panel is one block');
  const end = readDocument(snap());
  const logos = end.transcript.map(b => b.text).join('\n').split('Claude Code v').length - 1;
  const raw = snap().lines.filter(l => l.text.includes('Claude Code v')).length;
  assert.ok(raw >= 2, 'the terminal itself holds the reprinted logo (' + raw + ')');
  assert.equal(logos, 1, 'the conversation shows it once');
});

test('a running step whose dot blinks stays one step (it once flickered on e-ink)', async () => {
  // Recorded from the e-ink tablet session: Claude Code blinks the dot of a
  // running Bash step. Every state while it runs must show the same blocks.
  const file = cast('claude-eink-blink');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const head = JSON.parse(lines[0]);
  const { Terminal } = require('@xterm/headless');
  const { watchRepaints, TerminalHost } = require('../host');
  const term = new Terminal({ cols: head.width, rows: head.height, scrollback: 10000, allowProposedApi: true });
  const restarts = watchRepaints(term);
  const shapes = new Set();
  for (const l of lines.slice(1)) {
    const [t, kind, data] = JSON.parse(l);
    if (kind !== 'o') continue;
    await new Promise(r => term.write(data, r));
    if (t < 395 || t > 402) continue; // the Bash step running
    const d = readDocument(TerminalHost.prototype.snapshot.call({ term, cols: term.cols, rows: term.rows, revision: 0, cursorVisible: true, restarts }));
    shapes.add(d.transcript.map(b => b.kind).join(','));
  }
  assert.equal(shapes.size, 1, [...shapes].join('\n'));
  assert.ok([...shapes][0].endsWith('tool'));
});

test('Pi working: the box found while its cursor is up in the reply, "Working" read from its frame', async () => {
  // Recorded from Pi inside Chattering: while it answers, Pi parks the
  // cursor where it writes and puts "⠦ Working" in its box's frame line.
  const { Terminal } = require('@xterm/headless');
  const { watchRepaints, TerminalHost } = require('../host');
  const { GENERIC } = require('../reader');
  const lines = fs.readFileSync(cast('pi-live'), 'utf8').trim().split('\n');
  const head = JSON.parse(lines[0]);
  const term = new Terminal({ cols: head.width, rows: head.height, scrollback: 10000, allowProposedApi: true });
  const restarts = watchRepaints(term);
  const modes = [];
  let enterAt = null;
  for (const l of lines.slice(1)) {
    const [t, kind, data] = JSON.parse(l);
    if (kind === 'i' && data === '\r') enterAt = t;
    if (kind !== 'o') continue;
    await new Promise(r => term.write(data, r));
    if (enterAt == null || t < enterAt) continue;
    const d = readDocument(TerminalHost.prototype.snapshot.call({ term, cols: term.cols, rows: term.rows, revision: 0, cursorVisible: true, restarts }), GENERIC);
    assert.ok(d.composer, 'the box is found at ' + t);
    assert.ok(!/Ready when/.test(d.composer.text), 'the reply is never read as the box');
    if (modes.at(-1) !== d.mode) modes.push(d.mode);
  }
  // Ready (Enter not yet seen by Pi), working, ready: never a panel or unknown.
  assert.deepEqual(modes.filter((m, i) => i || m !== 'compose'), ['working', 'compose']);
});
