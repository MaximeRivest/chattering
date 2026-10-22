'use strict';
// What a reply sounds like through Kokoro (speech-script.js, design/102):
// heard, a list has to be announced before it starts and numbered as it
// goes, the eye's resting places become pauses, and no symbol is read out.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../speech-script.js');

const said = md => S.toSpeech(md).map(s => s.text);
const noMarks = segs => { for (const s of segs) assert.doesNotMatch(s.text, /[*_#`|>\[\]]|https?:/, s.text); };

test('a list is announced, then numbered aloud, with a pause after each item and a longer one after the list', () => {
  const segs = S.toSpeech('Here is what changed:\n\n- **Topics UX:** your layout.\n- the voice work\n- Comparison: tests\n\nAnything else?');
  noMarks(segs);
  assert.deepEqual(segs.map(s => s.text), [
    'Here is what changed.', 'Three things.', 'First, Topics UX, your layout.', 'Second, the voice work.', 'And third, Comparison, tests.', 'Anything else?']);
  assert.deepEqual(segs.map(s => s.pauseMs), [S.PAUSE.announce, S.PAUSE.announce, S.PAUSE.item, S.PAUSE.item, S.PAUSE.afterList, 0]);
  assert.ok(segs.every(s => !/[;:]\s/.test(s.text)), 'no colon or semicolon for Kokoro to break at');
});

test('a list whose opening line already says how many is not counted twice', () => {
  assert.deepEqual(said('Three of your conversations are still working:\n\n- a\n- b\n- c'), ['Three of your conversations are still working.', 'First, a.', 'Second, b.', 'And third, c.']);
  assert.deepEqual(said('Topics UX got 2 things:\n1. your question\n2. your request'), ['Topics UX got 2 things.', 'First, your question.', 'Second, your request.']);
  assert.deepEqual(said('It will finish the layout first, then:\n- remove the map\n- fix the matching'), ['It will finish the layout first, then two things.', 'First, remove the map.', 'Second, fix the matching.']);
  assert.deepEqual(said('- only one'), ['only one.'], 'one item is not a list to count');
});

test('a list item keeps its sub-items and its continued lines, said as part of it', () => {
  assert.deepEqual(said('- **Marking read.** No tool yet.\n  - so I went around it\n- Clicking\n  in your browser'),
    ['Two things.', 'First, Marking read. No tool yet. so I went around it.', 'Second, Clicking in your browser.']);
});

test('headings and bold labels are said as sentences with a pause; paragraphs end in one', () => {
  const segs = S.toSpeech('## What is running\n\n**The ping.** A checker looks every five minutes. It buzzes you.\n\nDone.');
  assert.deepEqual(segs.map(s => s.text), ['What is running.', 'The ping.', 'A checker looks every five minutes.', 'It buzzes you.', 'Done.']);
  assert.deepEqual(segs.map(s => s.pauseMs), [S.PAUSE.heading, S.PAUSE.heading, 0, S.PAUSE.paragraph, 0]);
});

test('code, tables, pictures and addresses stay on the screen; files are said by name', () => {
  const segs = S.toSpeech('See [the log](https://x.y/z) or https://lambda.ts.net:18940/?q=1 and `server.js` in `/home/maxime/Projects/bigspin/run.py`.\n\n```js\nconst x = 1;\n```\n\n```sh\nls\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![chart](c.png) That is all 🎉.');
  noMarks(segs);
  assert.deepEqual(segs.map(s => s.text), [
    'See the log or a link on your screen and server dot js in run dot py.',
    'There is some code on your screen.',
    'There is a table on your screen.',
    'That is all.',
  ]);
});

test('symbols said as words; times kept', () => {
  assert.deepEqual(said('The loss is 0.12 now. Version 2.1 works.'), ['The loss is 0.12 now.', 'Version 2.1 works.'], 'a decimal point ends no sentence');
  assert.deepEqual(said('Note: around 2:30; then more.'), ['Note, around 2:30, then more.'], 'a time keeps its colon');
  assert.deepEqual(said('Around 2:30 → about 3× faster, e.g. on the GPU — not the CPU & not snake_case.'),
    ['Around 2:30 to about 3 times faster, for example on the GPU, not the CPU and not snake case.'], 'an underscore is a space to the ear');
  assert.deepEqual(said('It *really* works, ~40 maps a day.'), ['It really works, about 40 maps a day.']);
});

test('pieces to make one after another: the first sentence alone, then a few sentences each', () => {
  const segs = S.toSpeech('Three are running. ' + 'The paper one found twelve studies and more. '.repeat(12));
  const pieces = S.speechPieces(segs);
  assert.deepEqual(pieces[0].map(s => s.text), ['Three are running.']);
  assert.ok(pieces.slice(1).every(p => S.spokenText(p).length <= 340));
  assert.equal(pieces.flat().length, segs.length);
});

test('nothing to say: nothing comes back', () => {
  assert.deepEqual(S.toSpeech(''), []);
  assert.deepEqual(said('```\ncode\n```'), ['There is some code on your screen.']);
});
