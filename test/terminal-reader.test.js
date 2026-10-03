'use strict';
// Reader rules on hand-made screens (the shapes seen from Claude Code 2.1.285–286).
const test = require('node:test');
const assert = require('node:assert/strict');
const { readDocument } = require('../harness/terminal/reader');
const row = (text, style = '||') => ({ text, runs: [{ s: style, t: text }] });
const screen = (rows, cursor, cols = 100) => ({ lines: rows.map(r => typeof r === 'string' ? row(r) : r), cols, rows: 34, base: 0, cursor, revision: 1 });
const RULE = '─'.repeat(100);

test('composer: text, caret, and the no-break space after the prompt', () => {
  const d = readDocument(screen([RULE, '❯\u00a0hello wor', RULE, '  ~/work                    0 tokens'], { x: 11, y: 1 }));
  assert.equal(d.mode, 'compose'); assert.equal(d.composer.text, 'hello wor'); assert.equal(d.composer.caret, 9);
  assert.equal(d.menu, null); assert.equal(d.footer.length, 1);
});
test('a dim placeholder is not input', () => {
  const d = readDocument(screen([RULE, { text: '❯ Try "fix lint"', runs: [{ s: '||', t: '❯ ' }, { s: 'd||', t: 'Try' }, { s: '||', t: ' ' }, { s: 'd||', t: '"fix lint"' }] }, RULE], { x: 2, y: 1 }));
  assert.equal(d.composer.text, ''); assert.equal(d.composer.placeholder, 'Try "fix lint"');
});
test('menu: aligned descriptions, the highlighted row is the odd colour', () => {
  const item = (l, sel) => ({ text: '  ' + l.padEnd(30) + 'does ' + l, runs: [{ s: '||', t: '  ' }, { s: sel ? '|p12|' : '|p7|', t: l.padEnd(30) + 'does ' + l }] });
  const d = readDocument(screen([RULE, '❯ /mo', RULE, item('/model', false), item('/mobile', true), item('/morning', false)], { x: 5, y: 1 }));
  assert.deepEqual(d.menu.items.map(i => i.label), ['/model', '/mobile', '/morning']); assert.equal(d.menu.selected, 1);
});
test('a dialog needs a hint or numbers before it is actionable', () => {
  const dialog = readDocument(screen([' Do you want to proceed?', ' ❯ Yes', '   No', '', ' Esc to cancel'], { x: 0, y: 0 }));
  assert.equal(dialog.mode, 'choice'); assert.deepEqual(dialog.choice.options.map(o => o.label), ['Yes', 'No']);
  const numbered = readDocument(screen([' Allow?', ' ❯ 1. Yes', '   2. No'], { x: 0, y: 0 }));
  assert.equal(numbered.choice.options[1].number, '2');
  // An echoed two-line message has the same shape and must stay text.
  const echo = readDocument(screen(['❯ Use the Write tool to create notes.md with a heading and two short bullet points about', '  testing. Then say done.', '', RULE, '❯ ', RULE], { x: 2, y: 4 }));
  assert.equal(echo.choice, null); assert.equal(echo.mode, 'compose');
  assert.equal(echo.transcript[0].kind, 'user');
});
test('soft wraps join with a space, short lines keep their typed line break', () => {
  const long = 'x '.repeat(46).trim(); // 91 characters: the next word cannot fit
  const wrapped = readDocument(screen([RULE, '❯ ' + long, '  continued', RULE], { x: 11, y: 2 }));
  assert.equal(wrapped.composer.text, long + ' continued'); assert.equal(wrapped.composer.softWraps, 1);
  const typed = readDocument(screen([RULE, '❯ line one', '  line two', RULE], { x: 10, y: 2 }));
  assert.equal(typed.composer.text, 'line one\nline two');
});
test('transcript: user, tool with its result, answer; both bullet glyphs', () => {
  const d = readDocument(screen(['❯ make a file', '', '● Write(hello.txt)', '  ⎿  Wrote 1 line', '', '⏺ Done.', '', RULE, '❯ ', RULE], { x: 2, y: 8 }));
  assert.deepEqual(d.transcript.map(b => b.kind), ['user', 'tool', 'assistant']);
  assert.match(d.transcript[1].result, /Wrote 1 line/);
});
test('anything not understood stays visible as cells', () => {
  const d = readDocument(screen(['', '', RULE, '❯ ', RULE, '', '▓▓ some unusual widget ▓▓'], { x: 2, y: 3 }));
  assert.ok(d.footer.some(f => /unusual/.test(f.text)) || d.live.length, 'kept somewhere visible');
});
test('a box with no frame (Codex): the cursor is the caret, so trailing spaces count', () => {
  const codex = require('../harness/terminal/profiles').profileFor('codex');
  // After Tab completes "/model " the cursor stands past the space.
  const d = readDocument(screen(['>_ Codex', '', '› /model ', '', '  gpt low · ~/work'], { x: 9, y: 2 }), codex);
  assert.equal(d.composer.text, '/model '); assert.equal(d.composer.caret, 7);
});
test('one suggestion left is a menu when it completes what is typed after / or @; else a status line', () => {
  const codex = require('../harness/terminal/profiles').profileFor('codex');
  const one = readDocument(screen(['', '› /perm', '', '  /permissions  choose what Codex is allowed to do'], { x: 7, y: 1 }), codex);
  assert.deepEqual(one.menu && one.menu.items.map(i => i.label), ['/permissions']);
  const status = readDocument(screen(['', '› hello', '', '  gpt low  ~/work'], { x: 7, y: 1 }), codex);
  assert.equal(status.menu, null); assert.equal(status.footer.length, 1);
});
test('Codex after an answer: frame lines around the answer are not its box; the prompt line holding the cursor is', () => {
  // The screen seen on 2026-10-01 (Codex 0.153.4) after "• Created approval-check.txt."
  const codex = require('../harness/terminal/profiles').profileFor('codex');
  const R = '─'.repeat(100), dim = t => ({ text: t, runs: [{ s: '||', t: t.slice(0, 2) }, { s: 'd||', t: t.slice(2) }] });
  const rows = ['• Ran touch approval-check.txt', '  └ (no output)', '', R, '', '• Created approval-check.txt.', '', R, '', '', dim('› Ask Codex to do anything'), '', '  gpt-5.6-sol low · ~/scratch/codex'];
  const d = readDocument(screen(rows, { x: 2, y: 10 }), codex);
  assert.equal(d.mode, 'compose');
  assert.equal(d.composer.text, '');
  assert.equal(d.composer.placeholder, 'Ask Codex to do anything');
});
test('Pi\'s last suggestion (its commands have no "/") is a menu too', () => {
  const pi = require('../harness/terminal/profiles').profileFor('pi');
  const R = '─'.repeat(100);
  const d = readDocument(screen([R, ' /sett', R, '  settings  Open settings menu'], { x: 6, y: 1 }), pi);
  assert.deepEqual(d.menu && d.menu.items.map(i => i.label), ['settings']);
});
test('Pi\'s list with its mark on a later row: the rows above it are items too, not status lines', () => {
  // As drawn by Pi 0.87 after ↓ ↓ (2026-10-01).
  const pi = require('../harness/terminal/profiles').profileFor('pi');
  const R = '─'.repeat(100);
  const d = readDocument(screen([R, ' /', R,
    '      settings                        Open settings menu',
    '      model                           <provider/model> — Select model (opens selector UI)',
    '    → tree                            Navigate session tree (switch branches)',
    '      thinking                        <level> — Set thinking level'], { x: 2, y: 1 }), pi);
  assert.deepEqual(d.menu.items.map(i => i.label), ['settings', 'model', 'tree', 'thinking']);
  assert.equal(d.menu.selected, 2);
  assert.equal(d.footer.length, 0);
});
test('Pi\'s own list dialog under its search line (/model): the current model\'s ✓ does not hide its siblings', () => {
  const pi = require('../harness/terminal/profiles').profileFor('pi');
  const R = '─'.repeat(100);
  const d = readDocument(screen([R, '', '> ', '', '→ ✓ m-one [a] · default', '    m-two [a]', '    m-three [b]', '  (1/3)', '', '  Enter to select · Escape/Ctrl+C to cancel', R, '~/work'], { x: 2, y: 2 }), pi);
  assert.equal(d.mode, 'choice');
  assert.deepEqual(d.choice.options.map(o => o.label), ['✓ m-one [a] · default', 'm-two [a]', 'm-three [b]']);
  assert.equal(d.choice.selected, 0);
  // The highlight elsewhere: the ✓ moves to its sibling's place.
  const moved = readDocument(screen([R, '', '> ', '', '  ✓ m-one [a] · default', '→   m-two [a]', '    m-three [b]', '', '  Enter to select · Esc to cancel', R], { x: 2, y: 2 }), pi);
  assert.deepEqual(moved.choice.options.map(o => o.label), ['✓ m-one [a] · default', 'm-two [a]', 'm-three [b]']);
  assert.equal(moved.choice.selected, 1);
});
test('a numbered list typed into the box stays the box\'s text', () => {
  const R = '─'.repeat(100);
  const d = readDocument(screen([R, '❯ plan:', '  > 1. first', '    2. second', R], { x: 12, y: 3 }));
  assert.equal(d.mode, 'compose'); assert.equal(d.choice, null);
  assert.equal(d.composer.text, 'plan:\n> 1. first\n  2. second');
});
test('a list in Pi\'s answer above its box, with "enter" a few lines lower, stays conversation', () => {
  const pi = require('../harness/terminal/profiles').profileFor('pi');
  const R = '─'.repeat(100);
  const d = readDocument(screen([' Two ways:', '', '→ Keep the cache', '  Drop the cache', '', ' Either works;', ' the second is slower', ' to enter but simpler.', R, ' ', R], { x: 1, y: 9 }), pi);
  assert.equal(d.mode, 'compose'); assert.equal(d.choice, null);
});
test('working from the window title: Claude Code writing its answer has no working line, its title turns ("◐"); idle it shows "✳"', () => {
  const claude = require('../harness/terminal/profiles').profileFor('claude');
  const rows = ['❯ Count from 1 to 600', '', '● 1', '  2', '  3', '', RULE, '❯ ', RULE];
  const writing = readDocument({ ...screen(rows, { x: 2, y: 7 }), title: '◐ Count to 600' }, claude);
  assert.equal(writing.mode, 'working'); assert.equal(writing.status.fromTitle, true);
  const idle = readDocument({ ...screen(rows, { x: 2, y: 7 }), title: '✳ Count to 600' }, claude);
  assert.equal(idle.mode, 'compose');
  // A question still comes first.
  const asking = readDocument({ ...screen([' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'], { x: 0, y: 0 }), title: '◐ x' }, claude);
  assert.equal(asking.mode, 'choice');
});
test('a box wrapped inside a path (Codex breaks after "/"): the text comes back without a space', () => {
  const codex = require('../harness/terminal/profiles').profileFor('codex');
  const line1 = '› Run exactly this shell command and nothing else: touch /home/maxime/.cache/chattering-live-test/';
  const d = readDocument(screen(['', line1, '  outside/codex-x.txt', ''], { x: 21, y: 2 }, 100), codex);
  assert.equal(d.composer.text, 'Run exactly this shell command and nothing else: touch /home/maxime/.cache/chattering-live-test/outside/codex-x.txt');
});
test('Codex turns a spinner in its title even when idle: its title does not say "working"', () => {
  const codex = require('../harness/terminal/profiles').profileFor('codex');
  const d = readDocument({ ...screen(['', '› ', '', '  gpt low · ~/w'], { x: 2, y: 1 }), title: '⠋ laptop-codex' }, codex);
  assert.equal(d.mode, 'compose');
});
