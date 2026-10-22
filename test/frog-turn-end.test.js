'use strict';
// The local end-of-turn check (frog-turn-end.js): the hand-overs the
// record holds, the closing words inside sentences Jev got right (and the
// regex before did not), the garbled closings, punctuation as a cue, and the
// probabilities the frog's thresholds read (TURN_SEND_AT 0.85, TURN_ASK_AT
// 0.5). Measured on the whole record in ~/Projects/myvoice
// (python -m myvoice.turnend): 367/367 against the gold labels, Jev 360.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('../frog-turn-end.js');
const { turnDecision } = require('../frog-assistant.js');

const handed = (before, last) => classify(before, last).turn === 'handed_over';

test('closing phrases at the end hand the turn over', () => {
  for (const t of ['over', 'Over.', 'over to you', 'Over to you, frog.', 'okay so over', 'your turn', 'go ahead', 'I\u2019m done', 'done', "that's it", 'that is all', 'send it', 'back to you', 'over and out',
    'I think I can hear you over.', 'Yeah, that Monday was her over.', "but it will cut the other one up mid step two it's not different over",
    'I think it would be nicer over.', 'Anything waiting on us on other conversations? Over.']) {
    assert.ok(handed('', t), 'hand-over: ' + t);
  }
});

test('the same words inside a sentence are not a hand-over', () => {
  for (const t of ['the training is over', 'start over', 'I want it to be done.', 'the training it was doing is done', 'it will come to you', "it's up to you", 'wait your turn',
    'I will go ahead', "I'm just about to say over.", 'Hey, you run?', 'Hmm.', '', 'the meeting is over.']) {
    assert.ok(!handed('', t), 'not a hand-over: ' + t);
  }
});

test('a sentence break before the closing word makes it a cue, whatever the word before', () => {
  assert.ok(handed('', 'Or there are some items still to do? Over.'));
  assert.ok(handed('', 'Is it done. Over'));
  assert.ok(!handed('', 'is it done'), 'without the break, "is done" is the sentence');
});

test('garbled closings the recognizer makes of "over to you"', () => {
  for (const t of ['over do you', 'overdo you', 'all the things over you', 'ask that to an agent in big spin over to you overdo you']) assert.ok(handed('', t), t);
});

test('probabilities fit the frog\u2019s thresholds: a cue sends, a sentence does not, nothing asks', () => {
  const send = classify('', 'over to you');
  assert.ok(turnDecision(send.probabilities).send);
  const keep = classify('', 'the training is over');
  const d = turnDecision(keep.probabilities);
  assert.ok(!d.send && !d.ask, 'a closing word in a sentence neither sends nor asks');
  const none = classify('so the thing is', 'that we should');
  assert.equal(none.probabilities.turn.handed_over, 0.01);
  assert.equal(none.why, 'no closing phrase');
});

test('fast: a thousand decisions well under 20 ms each', () => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) classify('what was said before, at some length, with words', 'and then I think that is about it for now, over to you');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 1000;
  assert.ok(ms < 1, 'ms per decision: ' + ms);
});
