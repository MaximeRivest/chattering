'use strict';
// The frog's spells, the text side (design/94): the changes as shown, when
// an answer is a rewrite, the selection's edges, icons and letters.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../overlay/spells-text.js');

const render = parts => parts.map(p => (p.op === 'del' ? `[-${p.text}-]` : p.op === 'ins' ? `{+${p.text}+}` : p.text)).join('');
// What the answer reads as: the kept and added text (gaps are only shown).
const result = parts => parts.filter(p => p.op === 'same' || p.op === 'ins').map(p => p.text).join('');

test('a correction: removed words before what replaces them, spaces where they were', () => {
  const r = render(T.diff('i has went to the store and buyed three apple', 'I went to the store and bought three apples'));
  assert.equal(r, '[-i has-] {+I+} went to the store and [-buyed-] {+bought+} three [-apple-] {+apples+}');
  assert.equal(result(T.diff('i has went to the store and buyed three apple', 'I went to the store and bought three apples')), 'I went to the store and bought three apples', 'the kept and added parts are the answer, exactly');
});

test('a long removal keeps its spaces and line breaks, so it wraps like text (the bug in the screenshot)', () => {
  const before = 'went to the store.\n\ntheir going to the meeting tomorow, can you send me the agenda before\n\nJe vais être en retard ce matin.';
  const parts = T.diff(before, 'Went to the store.');
  const removed = parts.filter(p => p.op === 'del').map(p => p.text).join('|');
  assert.match(removed, /meeting tomorow, can you/, 'words inside a removed run keep the space between them');
  assert.match(removed, /\n\nJe vais/, 'and the line breaks');
  assert.ok(!/\S{40,}/.test(removed.replace(/\s+/g, ' ')), 'no run of words glued together');
  assert.doesNotMatch(render(parts), /\.\[-their|\S\[-|-\]\S/, 'a removal is apart from the words beside it');
});

test('a rewrite is shown as its new text, a correction as its changes', () => {
  assert.equal(T.view('hey sam, i has went to the store yesterday and buyed three apple', 'Hey Sam, I went to the store yesterday and bought three apples'), 'changes');
  const long = 'their going to the meeting tomorow, can you send me the agenda before. Je vais être en retard ce matin, le métro est encore en panne. The Bank of Canada held its policy rate at 2.25 per cent.';
  assert.equal(T.view(long, 'They’re going to the meeting tomorrow.'), 'text', 'shortened: mostly removed');
  assert.equal(T.view('Je vais être en retard ce matin', 'I’m going to be late this morning'), 'text', 'translated: every word new');
  assert.equal(T.view('', 'anything'), 'text');
  assert.equal(T.kept('a b c', 'A, b. c'), 1);
  assert.equal(T.view('fix this sentense please now', 'Fix this sentence, please, now.'), 'changes');
});

test('the answer keeps the selection\u2019s edges', () => {
  assert.equal(T.keepEdges('  i has went \n', 'I went.'), '  I went. \n');
  assert.equal(T.keepEdges('x', '\n\nX\n'), 'X');
  assert.equal(T.keepEdges('   ', 'X'), '   ');
});

test('icons from what a spell does, and a letter for each', () => {
  assert.equal(T.iconFor({ program: 'fix_writing' }), 'fix');
  assert.equal(T.iconFor({ program: 'to_english' }), 'translate');
  assert.equal(T.iconFor({ program: 'my_thing', label: 'Summarize' }), 'explain');
  assert.equal(T.iconFor({ program: 'zzz' }), 'spark');
  const L = T.letters([
    { keys: 'Super+Ctrl+G', label: 'Fix' }, { keys: 'Super+Ctrl+U', label: 'Translate' },
    { keys: null, label: 'Make it shorter' }, { keys: 'Super+F5', label: 'Explain' }, { keys: null, label: 'Make it more polite' },
  ]);
  assert.deepEqual(L, ['G', 'U', 'M', 'E', 'A'], 'its hotkey\u2019s letter, else the first free letter of its name');
});
