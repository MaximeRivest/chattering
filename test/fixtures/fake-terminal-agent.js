#!/usr/bin/env node
'use strict';
// A stand-in for an agent's interactive terminal program, for tests that
// must not call a model: it draws what Claude Code, Pi or Codex draw (in the
// shapes recorded from them, test/fixtures/terminal/*.cast) and writes its
// conversation where each writes it, in each one's file format, so
// Chattering's own reader shows it.
//
//   FAKE_AGENT_STYLE=claude|pi|codex  (default claude)
//   claude:  --session-id ID | --resume ID
//   pi:      --session-id ID | --session FILE
//   codex:   (nothing: it picks an id) | resume ID
//   FAKE_AGENT_TRUST=1   asks "trust this folder?" first
//   FAKE_AGENT_LOG=FILE  every key it received, one JSON line each
//
// Like the real ones it ignores keys for its first 400 ms (it is starting),
// then turns on bracketed paste. Its box: a line editor (←/→, Home/End,
// Backspace/Delete, Alt+Enter or Shift+Enter for a line break, paste).
// Typing "/" opens its command list (↑/↓, Tab completes, Enter runs, Esc
// closes); /usage opens a panel with no box (Esc closes). A message works
// for FAKE_AGENT_DELAY ms (default 500; "slow" in it: 15 s, Esc stops);
// "permission" in it asks "Do you want to proceed?" first.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const style = process.env.FAKE_AGENT_STYLE || 'claude';
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const cwd = process.cwd();
const delay = Number(process.env.FAKE_AGENT_DELAY) || 500;
const keyLog = process.env.FAKE_AGENT_LOG || null;
const out = s => process.stdout.write(s);
const cols = () => process.stdout.columns || 100;
const RULE = () => '─'.repeat(cols());
const DIM = s => '\x1b[2m' + s + '\x1b[22m';
const COMMANDS = [['/clear', 'Start a new conversation'], ['/help', 'Show help'], ['/model', 'Choose the model'], ['/usage', 'Show plan usage']];

// ---------------------------------------------------------------- its file
const now = () => new Date().toISOString();
let sessionId = opt('--session-id') || opt('--resume') || (style === 'codex' && argv[0] === 'resume' ? argv[1] : null);
let file = null, lastId = null;
function locate() {
  if (style === 'pi' && opt('--session')) return opt('--session');
  if (style === 'claude') {
    const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
    if (opt('--resume')) for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) { const f = path.join(root, d, sessionId + '.jsonl'); if (fs.existsSync(f)) return f; }
    return path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), sessionId + '.jsonl');
  }
  if (style === 'pi') {
    const dir = path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions', '--' + cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-') + '--');
    fs.mkdirSync(dir, { recursive: true }); // Pi makes the folder at start, the file at the first message
    return path.join(dir, now().replace(/[:.]/g, '-') + '_' + sessionId + '.jsonl');
  }
  if (style === 'codex') {
    const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
    if (sessionId) { const found = findCodex(root, sessionId); if (found) return found; }
    sessionId = sessionId || crypto.randomUUID();
    const d = new Date(), day = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    return path.join(day, 'rollout-' + d.toISOString().slice(0, 19).replace(/:/g, '-') + '-' + sessionId + '.jsonl');
  }
}
function findCodex(dir, id) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const f = findCodex(p, id); if (f) return f; }
    else if (e.name.endsWith(id + '.jsonl')) return p;
  }
  return null;
}
function append(role, text) {
  if (!file) file = locate();
  const fresh = !fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [];
  const id = crypto.randomUUID();
  if (style === 'claude') {
    lines.push({ type: role, uuid: id, parentUuid: lastId, sessionId, cwd, timestamp: now(), message: role === 'user' ? { role, content: text } : { role, model: 'fake-1', content: [{ type: 'text', text }] } });
  } else if (style === 'pi') {
    if (fresh) lines.push({ type: 'session', version: 3, id: sessionId, timestamp: now(), cwd });
    lines.push({ type: 'message', id: id.slice(0, 8), parentId: lastId, timestamp: now(), message: role === 'user' ? { role, content: [{ type: 'text', text }], timestamp: Date.now() } : { role, content: [{ type: 'text', text }], provider: 'fake', model: 'fake-1', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() } });
  } else {
    if (fresh) lines.push({ timestamp: now(), type: 'session_meta', payload: { id: sessionId, session_id: sessionId, timestamp: now(), cwd, originator: 'codex-tui', cli_version: '0.0.0-fake', source: 'cli', model_provider: 'openai' } });
    if (role === 'user') lines.push({ timestamp: now(), type: 'event_msg', payload: { type: 'user_message', message: text, images: [] } });
    lines.push({ timestamp: now(), type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  }
  lastId = style === 'pi' ? id.slice(0, 8) : id;
  fs.appendFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}
if (sessionId && (opt('--resume') || opt('--session') || argv[0] === 'resume')) {
  file = locate();
  // Continue the chain where the file left it.
  try { const last = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)).pop(); lastId = last.uuid || last.id || null; } catch {}
}

// ---------------------------------------------------------------- its screen
const st = { mode: process.env.FAKE_AGENT_TRUST === '1' ? 'trust' : 'compose', text: '', caret: 0, sel: 0, menuClosed: false, spin: 0, choiceFor: null };
let drawnHeight = 0, caretRow = 0;
const menuItems = () => st.mode === 'compose' && st.text.startsWith('/') && !st.text.includes(' ') && !st.menuClosed ? COMMANDS.filter(c => c[0].startsWith(st.text)) : [];
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
function region() {
  const L = []; let caret = null;
  // As recorded from Claude Code: a frame line above the question.
  const options = (q, opts) => { L.push(RULE()); L.push(' ' + q); opts.forEach((o, i) => L.push((i === st.sel ? ' ❯ ' : '   ') + (i + 1) + '. ' + o)); L.push(''); L.push(DIM(' Enter to confirm · Esc to cancel')); };
  if (st.mode === 'trust') { options('Do you trust the files in this folder?', ['Yes, proceed', 'No, exit']); return { L, caret: null }; }
  if (st.mode === 'choice') { options('Do you want to proceed?', ['Yes', 'No']); return { L, caret: null }; }
  if (st.mode === 'panel') { L.push(RULE()); L.push(' Usage'); L.push(''); L.push(' Current session   0 tokens'); L.push(' Current week      1% used'); L.push(''); L.push(DIM(' Esc to close')); return { L, caret: null }; }
  const working = st.mode === 'working';
  if (working && style !== 'pi') { L.push(''); L.push((style === 'codex' ? '• Working (' : '✻ Thinking… (') + Math.floor(st.spin / 10) + 's · esc to interrupt)'); }
  const lines = st.text.split('\n');
  let row = 0, col = st.caret;
  for (const l of lines) { if (col <= l.length) break; col -= l.length + 1; row++; }
  const placeholder = !st.text;
  if (style === 'codex') {
    L.push('');
    lines.forEach((l, i) => { if (i === row) caret = { row: L.length, col: 2 + col }; L.push((i ? '  ' : '› ') + (placeholder && !i ? DIM('Ask Codex to do anything') : l)); });
    L.push(''); // as recorded: a blank line between its box and what is under it
  } else {
    L.push(working && style === 'pi' ? '── ' + SPIN[st.spin % SPIN.length] + ' Working ' + '─'.repeat(cols() - 13) : RULE());
    const pad = style === 'pi' ? ' ' : '❯ ';
    lines.forEach((l, i) => { if (i === row) caret = { row: L.length, col: pad.length + col }; L.push((i && style !== 'pi' ? '  ' : pad) + (placeholder && !i ? DIM(style === 'pi' ? 'Ready when you are' : 'Try "fix the tests"') : l)); });
    L.push(RULE());
  }
  const items = menuItems();
  if (items.length) {
    st.sel = Math.min(st.sel, items.length - 1);
    // The selected row: another colour (Claude Code, Codex) or a marker (Pi).
    items.forEach(([c, d], i) => L.push(style === 'pi' ? (i === st.sel ? '→ ' : '  ') + c.padEnd(20) + d : (i === st.sel ? '\x1b[38;5;12m' : '\x1b[38;5;7m') + '  ' + c.padEnd(20) + d + '\x1b[39m'));
  } else L.push(DIM(style === 'codex' ? '  fake-1 low · ' + cwd : '  ? for shortcuts'));
  return { L, caret };
}
// Like Ink: the live region is redrawn in place under what was printed.
function draw(printed = []) {
  let s = '\x1b[?25l';
  if (drawnHeight) s += (caretRow ? '\x1b[' + caretRow + 'A' : '') + '\r\x1b[J';
  for (const p of printed) s += p + '\r\n';
  const { L, caret } = region();
  s += L.join('\r\n');
  drawnHeight = L.length;
  const at = caret || { row: L.length - 1, col: 0 };
  const up = L.length - 1 - at.row;
  s += (up ? '\x1b[' + up + 'A' : '') + '\r' + (at.col ? '\x1b[' + at.col + 'C' : '');
  caretRow = at.row;
  s += caret ? '\x1b[?25h' : '';
  out(s);
}
const say = text => style === 'claude' ? '● ' + text : style === 'codex' ? '• ' + text : ' ' + text;

// ---------------------------------------------------------------- its loop
let workTimer = null, spinTimer = null, pendingText = null;
function startWork(text) {
  st.mode = 'working'; st.spin = 0;
  spinTimer = setInterval(() => { st.spin++; draw(); }, 100);
  const ms = /slow/.test(text) ? 15000 : delay;
  if (/permission/.test(text)) { workTimer = setTimeout(() => { clearInterval(spinTimer); st.mode = 'choice'; st.sel = 0; st.choiceFor = text; draw(); }, Math.min(ms, 300)); return; }
  workTimer = setTimeout(() => finish(text, 'Done: ' + text), ms);
  draw();
}
function finish(text, reply) {
  clearInterval(spinTimer); clearTimeout(workTimer);
  st.mode = 'compose';
  append('assistant', reply);
  draw(['', say(reply), '']);
}
function submit() {
  const text = st.text;
  st.text = ''; st.caret = 0; st.sel = 0; st.menuClosed = false;
  if (!text.trim()) return draw();
  if (text.trim() === '/usage') { st.mode = 'panel'; return draw(['❯ /usage']); }
  if (text.startsWith('/')) return draw(['❯ ' + text, '  ⎿  ' + (text.startsWith('/model') ? 'Model: fake-1' : 'ok')]);
  append('user', text);
  draw([(style === 'codex' ? '› ' : '❯ ') + text.split('\n').join('\n  ')]);
  startWork(text);
}
function insert(s) { st.text = st.text.slice(0, st.caret) + s + st.text.slice(st.caret); st.caret += s.length; st.menuClosed = false; }
function key(k) {
  if (keyLog) fs.appendFileSync(keyLog, JSON.stringify(k) + '\n');
  if (st.mode === 'trust' || st.mode === 'choice') {
    if (k === '\x1b[A' || k === '\x1bOA') st.sel = (st.sel + 1) % 2; // wraps around, like the real ones
    else if (k === '\x1b[B' || k === '\x1bOB') st.sel = (st.sel + 1) % 2;
    else if (k === '1' || k === '2') st.sel = +k - 1;
    if (k === '\r' || k === '\x1b') {
      const yes = k === '\r' && st.sel === 0;
      if (st.mode === 'trust') { if (!yes) { out('\r\n'); process.exit(1); } st.mode = 'compose'; return draw(); }
      st.mode = 'working';
      if (yes) { const t = st.choiceFor; workTimer = setTimeout(() => finish(t, 'Done: ' + t), 300); spinTimer = setInterval(() => { st.spin++; draw(); }, 100); return draw(['  ⎿  Allowed']); }
      return finish(st.choiceFor, 'Not done: you said no.');
    }
    return draw();
  }
  if (st.mode === 'panel') { if (k === '\x1b') { st.mode = 'compose'; draw(); } return; }
  if (st.mode === 'working') {
    if (k === '\x1b') { clearInterval(spinTimer); clearTimeout(workTimer); st.mode = 'compose'; return draw(['  ⎿  Interrupted by user']); }
    // Typing while it works goes into the box (queued, like the real ones).
  }
  const items = menuItems();
  if (k === '\r') { if (items.length && st.mode !== 'working') { st.text = items[st.sel][0]; } if (st.mode === 'working') return; return submit(); }
  if (k === '\t') { if (items.length) { st.text = items[st.sel][0] + ' '; st.caret = st.text.length; } return draw(); }
  if (k === '\x1b') { if (items.length) st.menuClosed = true; return draw(); }
  if (k === '\x1b[A' || k === '\x1bOA') { if (items.length) st.sel = (st.sel + items.length - 1) % items.length; return draw(); }
  if (k === '\x1b[B' || k === '\x1bOB') { if (items.length) st.sel = (st.sel + 1) % items.length; return draw(); }
  if (k === '\x1b[D' || k === '\x1bOD') { st.caret = Math.max(0, st.caret - 1); return draw(); }
  if (k === '\x1b[C' || k === '\x1bOC') { st.caret = Math.min(st.text.length, st.caret + 1); return draw(); }
  if (k === '\x1b[H' || k === '\x1b[1~' || k === '\x01') { st.caret = st.text.lastIndexOf('\n', st.caret - 1) + 1; return draw(); }
  if (k === '\x1b[F' || k === '\x1b[4~' || k === '\x05') { const e = st.text.indexOf('\n', st.caret); st.caret = e < 0 ? st.text.length : e; return draw(); }
  if (k === '\x7f' || k === '\b') { if (st.caret) { st.text = st.text.slice(0, st.caret - 1) + st.text.slice(st.caret); st.caret--; st.menuClosed = false; } return draw(); }
  if (k === '\x1b[3~') { st.text = st.text.slice(0, st.caret) + st.text.slice(st.caret + 1); return draw(); }
  if (k === '\x1b\r' || k === '\n') { insert('\n'); return draw(); }
  if (k.startsWith('\x1b[200~')) { insert(k.slice(6).replace(/\x1b\[201~$/, '').replace(/\r\n?/g, '\n')); return draw(); }
  if (k.length === 1 && k >= ' ') { insert(k); return draw(); }
}
// A chunk of input, split into keys as a terminal program reads them.
function keys(data) {
  const out = [];
  for (let i = 0; i < data.length;) {
    if (data.startsWith('\x1b[200~', i)) { const e = data.indexOf('\x1b[201~', i); const end = e < 0 ? data.length : e + 6; out.push(data.slice(i, end)); i = end; continue; }
    if (data[i] === '\x1b') {
      const m = /^\x1b(\[[0-9;]*[~A-Za-z]|O[A-Za-z]|\r)/.exec(data.slice(i));
      if (m) { out.push(m[0]); i += m[0].length; continue; }
      out.push('\x1b'); i++; continue;
    }
    out.push(data[i]); i++;
  }
  return out;
}

if (keyLog) fs.appendFileSync(keyLog, JSON.stringify({ argv }) + '\n'); // how it was started
let listening = false;
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  if (!listening) return; // still starting: keys are lost, as with the real ones
  if (d === '\x03') { out('\x1b[?2004l\r\n'); process.exit(0); }
  for (const k of keys(d)) key(k);
});
out((style === 'claude' ? ' ✻ Fake Code v0.0.0' : style === 'codex' ? '>_ Fake Codex (v0.0.0)' : ' fake pi v0.0.0') + '\r\n\r\n');
draw();
setTimeout(() => { listening = true; out('\x1b[?2004h\x1b[?1004h'); }, 400);
process.stdout.on('resize', () => draw());
process.on('SIGHUP', () => process.exit(0));
