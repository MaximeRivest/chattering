'use strict';
// Replay a recorded session to any moment: the terminal as it was, what the
// reader made of it, and what each device sent and was shown around then.
//   node replay.js [session.cast] [--at SECONDS | --at HH:MM[:SS]] [--around 5] [--events FILE]
// Defaults: the running instance's files in ~/.cache/chattering-terminal-prototype/.
// Without --at: a timeline of what devices did, to pick a moment from.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Terminal } = require('@xterm/headless');
const { watchRepaints, TerminalHost } = require('./host');
const { readDocument } = require('./reader');

const dir = path.join(os.homedir(), '.cache', 'chattering-terminal-prototype');
const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const castFile = args.find(a => a.endsWith('.cast')) || path.join(dir, 'session.cast');
const eventsFile = opt('events') || castFile.replace(/\.cast$/, '.events.jsonl');
const around = +(opt('around') || 5);

const lines = fs.readFileSync(castFile, 'utf8').trim().split('\n');
const head = JSON.parse(lines[0]);
const startMs = head.timestamp * 1000;
const events = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const clock = t => new Date(startMs + t * 1000).toLocaleTimeString();
function parseAt(v) {
  if (v == null) return null;
  if (/^\d+:\d+/.test(v)) { const [h, m, s = 0] = v.split(':').map(Number); const d = new Date(startMs); d.setHours(h, m, s, 0); return (d - startMs) / 1000; }
  return +v;
}
const at = parseAt(opt('at'));
const short = m => {
  if (!m) return '';
  if (m.t === 'text' || m.t === 'paste') return m.t + ' ' + JSON.stringify(m.text);
  if (m.t === 'key') return 'key ' + (m.shift ? '⇧' : '') + (m.ctrl ? '^' : '') + m.key;
  if (m.t === 'draft' || m.t === 'submit') return m.t + ' ' + JSON.stringify(m.text);
  return m.t + (m.index != null ? ' #' + m.index : '');
};
function describe(e) {
  if (e.ev === 'sent') return `${e.dev} → ${short(e.msg)}`;
  if (e.ev === 'answer') return `${e.dev} ← ${e.answer}${e.error ? ': ' + e.error : ''}${e.ms != null ? ' (' + e.ms + ' ms)' : ''}${e.text != null ? ' box=' + JSON.stringify(e.text) : ''}`;
  if (e.ev === 'shown') { const s = e.patch.set || {}; const bits = Object.keys(s).concat(Object.keys(e.patch.lists || {})); return `${e.dev} shown: ${bits.join(', ')}${s.mode ? ' · mode ' + s.mode : ''}${s.composer !== undefined ? ' · box ' + JSON.stringify(s.composer && s.composer.text) : ''}`; }
  return `${e.dev} ${e.ev}${e.msg ? ' ' + short(e.msg) : ''}`;
}

(async () => {
  if (at == null) {
    console.log(`${castFile}: started ${new Date(startMs).toLocaleString()}, ${lines.length - 1} records; ${events.length} device events`);
    for (const e of events) if (e.ev !== 'shown') console.log(`${e.t.toFixed(1).padStart(8)}s ${clock(e.t)}  ${describe(e)}`);
    console.log('\nPick a moment: node replay.js --at <seconds or HH:MM:SS>');
    return;
  }
  const term = new Terminal({ cols: head.width, rows: head.height, scrollback: 10000, allowProposedApi: true });
  const restarts = watchRepaints(term);
  for (const l of lines.slice(1)) {
    const [t, kind, data] = JSON.parse(l);
    if (t > at) break;
    if (kind === 'o') await new Promise(r => term.write(data, r));
    else if (kind === 'r') { const [c, r] = data.split('x').map(Number); term.resize(c, r); }
  }
  const snap = TerminalHost.prototype.snapshot.call({ term, cols: term.cols, rows: term.rows, revision: 0, cursorVisible: true, restarts });
  const doc = readDocument(snap);
  console.log(`== the terminal at ${at.toFixed(1)}s (${clock(at)})`);
  snap.lines.slice(snap.base, snap.base + snap.rows).forEach((l, y) => { if (l.text.trim()) console.log(String(y).padStart(2) + '│' + l.text); });
  console.log(`\n== what the reader made of it: mode ${doc.mode}`);
  if (doc.composer) console.log('box: ' + JSON.stringify(doc.composer.text) + (doc.composer.placeholder ? ' (placeholder ' + JSON.stringify(doc.composer.placeholder) + ')' : ''));
  if (doc.menu) console.log('menu: ' + doc.menu.items.map(i => (i.selected ? '▸' : ' ') + i.label).join(' '));
  if (doc.choice) console.log('choice: ' + doc.choice.options.map(o => (o.selected ? '▸' : ' ') + o.label).join(' | '));
  if (doc.status) console.log('status: ' + doc.status.text);
  console.log('conversation: ' + doc.transcript.map(b => b.kind + ':' + JSON.stringify(b.text.slice(0, 40))).join('  '));
  if (doc.live.length) console.log('live (shown as drawn): ' + doc.live.length + ' block(s)');
  console.log(`\n== devices from ${(at - around).toFixed(1)}s to ${(at + around).toFixed(1)}s`);
  for (const e of events) if (Math.abs(e.t - at) <= around) console.log(`${e.t.toFixed(2).padStart(8)}s  ${describe(e)}`);
})();
