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
