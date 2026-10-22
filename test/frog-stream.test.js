'use strict';
// The frog speaks as it writes (server.js frogStreamSpeech, design/102):
// its first sentence as soon as it ends, then whole paragraphs; a list or
// code block only once whole; the rest when the message is whole. Fed here
// the way a model streams, a few characters at a time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const a = source.indexOf('const frogStreams = new WeakMap();'), b = source.indexOf('\n}\n', a) + 3;

function run(text, { talk = true, key = 'frog', step = 3 } = {}) {
  const said = [];
  const ctx = vm.createContext({ theFrog: { key: 'frog', talk }, speakFrogText: (job, piece) => said.push(piece) });
  vm.runInContext(source.slice(a, b), ctx);
  const job = { key }, cur = { id: 1, text: '' };
  for (let i = step; i < text.length + step; i += step) {
    cur.text = text.slice(0, i);
    ctx.frogStreamSpeech(job, cur, false);
  }
  const before = said.length;
  ctx.frogStreamSpeech(job, cur, true);
  return { said, beforeEnd: before };
}

test('the first sentence is spoken as soon as it ends; then paragraphs; nothing twice, nothing lost', () => {
  const text = 'Three are running, and one waits for you. The loss is 0.12 now.\n\nThe paper one found twelve studies. It wants you to pick two.\n\nWant the details?';
  const { said, beforeEnd } = run(text);
  assert.equal(said[0], 'Three are running, and one waits for you. ', 'heard before the rest is written');
  assert.equal(said.join(''), text);
  assert.ok(beforeEnd >= 3, 'paragraphs spoken while it writes: ' + JSON.stringify(said));
  assert.ok(!said.some(p => /0\.$/.test(p.trim())), 'a decimal point ends nothing');
});

test('a list waits until it is whole, so it can be announced and counted', () => {
  const text = 'Here is what changed.\n\n- the layout\n- the voice\n- the memory\n\nThat is all.';
  const { said } = run(text);
  const list = said.find(p => p.includes('- the layout'));
  assert.ok(list.includes('- the memory'), 'one piece holds the whole list: ' + JSON.stringify(said));
  assert.equal(said.join(''), text);
});

test('a code block is never cut in two', () => {
  const text = 'Run this.\n\n```sh\nls\n\npwd\n```\n\nDone.';
  const { said } = run(text);
  assert.ok(said.some(p => p.includes('```sh') && p.includes('pwd\n```')), JSON.stringify(said));
  assert.equal(said.join(''), text);
});

test('nothing is spoken for another conversation, or when talk is off', () => {
  assert.deepEqual(run('Hello there. More.', { key: 'other' }).said, []);
  assert.deepEqual(run('Hello there. More.', { talk: false }).said, []);
});
