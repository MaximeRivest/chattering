'use strict';
// frog-turn-end.js — the walkie-talkie's end-of-turn check, answered on this
// computer in well under a millisecond, without Jev (design/102).
//
// "Did the last words hand the turn over?" A hand-over is a closing phrase
// at the end of what was said last: "over", "over to you", "your turn",
// "go ahead", "done", "that's it", "back to you", "send it"… The same words
// inside a sentence are not one: "the training is over", "I want it to be
// done", "start over", "it will come to you".
//
// This is a rule set learned from the record, not a neural network: 371
// real decisions of Jev on Maxime's utterances (2026-10-17 → 19), read
// against the hand-over rule the frog already had (frog-assistant.js
// HAND_OVER). The two agreed on 354; the 17 others were labelled by hand
// (myvoice data/turnend/gold.json). What the data taught:
//   - Jev's misses were long sentences ending in "over" (it answered 0.16 to
//     0.47 on seven of them; the person said "over" again each time);
//   - the regex's misses were closing words used in a sentence ("to be
//     done", "is done", "start over", "come to you").
// The exclusions below are those cases and their obvious kin. Probabilities
// are the share of true hand-overs in each category on the first 60% of
// the record (by time), smoothed; the rest of the record is the test
// (myvoice/turnend.py). A text-only check: prosody was not used — the record
// holds six in-sentence "over"/"done" cases, too few to train on.

// The closing phrases, each as a regex over normalized words (lowercase,
// no punctuation, one space). The trailing "frog | please | thanks" and the
// lead-in "okay | so | and | right | well" are stripped before matching.
const PHRASES = [
  { name: 'over', re: /(?:^|\s)(?:over)(?:\s+(?:and\s+out|to\s+you|to\s+the\s+frog|you|do\s+you|overdo\s+you|to\s+you\s+over(?:do|\s+do)?\s+you))?$/,
    // In a sentence: "the training is over", "start over", "think it over", "all over", "game over" (the last one as a sentence, not a cue).
    inSentence: /(?:^|\s)(?:is|was|are|were|be|been|being|it's|that's|its|thats|all|start|starts|started|starting|think|thinking|look|looking|come|coming|get|got|getting|take|taking|took|fall|fell|falling|turn|turning|left|run|running|hand|pull|cross|move|roll|flip|carry|hang|pass|jump|walk|read|say|said|saying|word|the|an|a|game|half|almost|nearly|not|never|isn't|wasn't|still|about|it|them)\s+over$/ },
  { name: 'to you', re: /(?:^|\s)(?:back\s+)?to\s+you$/,
    // "it will come to you", "I'll talk to you", "up to you", "it's up to you".
    inSentence: /(?:^|\s)(?:come|comes|coming|came|get|gets|getting|got|talk|talking|talked|say|said|saying|listen|listening|up|send|sent|sending|give|gave|giving|show|showing|speak|speaking|spoke|belong|belongs|next|happen|happens|happened|mean|means|meant|sound|sounds|look|looks|close|closer|down|it|that|this|them|things|everything|anything|something|nothing)\s+to\s+you$/ },
  { name: 'your turn', re: /(?:^|\s)your\s+turn$/, inSentence: /(?:^|\s)(?:wait|waiting|not|isn't|wasn't|for|skip|skipped|miss|missed|on|in|take|took)\s+your\s+turn$/ },
  { name: 'go ahead', re: /(?:^|\s)go\s+ahead$/, inSentence: /(?:^|\s)(?:to|don't|do\s+not|can't|cannot|couldn't|shouldn't|wouldn't|let\s+me|let's|i|i'll|i'd|we|we'll|we'd|they|they'll|will|would|should|could|may|might|just)\s+go\s+ahead$/ },
  { name: 'done', re: /(?:^|\s)(?:i'm\s+|i\s+am\s+|im\s+)?done$/,
    // "the training is done", "I want it to be done", "once it's done", "when you're done" (said to the frog about its work).
    inSentence: /(?:^|\s)(?:is|was|are|were|be|been|being|get|gets|got|getting|it's|that's|its|thats|he's|she's|they're|we're|you're|youre|not|never|almost|nearly|half|all|when|once|after|before|until|till|if|isn't|wasn't|aren't|still|already|also|what's|whats|something|anything|nothing|everything|job|work|well|it|that|this|them|things)\s+done$/ },
  { name: "that's it", re: /(?:^|\s)(?:that's|thats|that\s+is)\s+(?:it|all)$/, inSentence: /(?:^|\s)(?:if|when|whether|unless|hope|hoping|think|thought|sure|not|maybe)\s+(?:that's|thats|that\s+is)\s+(?:it|all)$/ },
  { name: 'send it', re: /(?:^|\s)send\s+it$/, inSentence: /(?:^|\s)(?:to|don't|do\s+not|didn't|not|can't|cannot|couldn't|shouldn't|wouldn't|i'll|we'll|i|we|you|they|will|would|should|could|may|might|just|and|then|before|after|when|if)\s+send\s+it$/ },
  { name: 'you go', re: /(?:^|\s)you\s+go$/, inSentence: /(?:^|\s)(?:when|where|if|as|before|after|did|do|there|here|now|while|until|till|should|would|could|can|will|and|then|so)\s+you\s+go$/ },
];
const LEAD_IN = /^(?:(?:ok|okay|so|alright|all\s+right|right|and|well|yeah|yes|yep|um|uh|hmm)\s+)+/;
const TRAILER = /(?:\s+(?:frog|please|thanks|thank\s+you|now))+$/;

// What the record showed in each category (first 60% by time, Laplace
// smoothed; myvoice/turnend.py prints the table and the test numbers).
const P = Object.freeze({
  phrase: 0.98,        // a closing phrase at the end, not in a sentence
  inSentence: 0.08,    // a closing word, but used in the sentence
  none: 0.01,          // no closing phrase
});

function normalize(text) {
  return String(text || '').toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

// A sentence break right before the closing words ("still to do? Over."):
// the recognizer heard the pause and the fall, so the words are a cue
// whatever the word before them. Only recognizers that punctuate
// (Parakeet) give this; the small one writes none, and then the words
// alone decide. `at` is the index of the closing phrase's first word among
// the text's words.
function breakBefore(text, at) {
  const toks = String(text || '').trim().split(/\s+/).filter(t => normalize(t));
  return at > 0 && at <= toks.length && /[.!?,;:—]$/.test(toks[at - 1]);
}

/**
 * The decision for the words said last. `before` is what was said earlier in
 * this turn (the message so far); it is accepted for the record and for the
 * log's shape, and does not change the answer today.
 * Returns { turn, probabilities: { turn: { handed_over, still_talking } },
 * phrase, why }.
 */
function classify(before, last) {
  let s = normalize(last);
  // Garbled closings the recognizer makes of "over to you": "overdo you",
  // "over do you", "over you".
  s = s.replace(/\bover\s*do\s+you\b/g, 'over to you').replace(/\bover\s+you\b/g, 'over to you');
  s = s.replace(TRAILER, '');
  let p = P.none, phrase = '', why = 'no closing phrase';
  if (s) {
    for (const ph of PHRASES) {
      if (!ph.re.test(s)) continue;
      const body = s.replace(LEAD_IN, '');
      phrase = ph.name;
      // "the training is over": the word before the closing says it is
      // part of the sentence. A lead-in ("okay so, over") is not such a word.
      const words = (body.match(ph.re) || [''])[0].trim().split(/\s+/).length;
      const at = s.split(' ').filter(Boolean).length - words;
      if (ph.inSentence.test(body) && !breakBefore(last, at)) { p = P.inSentence; why = `"${ph.name}" inside the sentence`; }
      else { p = P.phrase; why = `ends with "${ph.name}"`; }
      break;
    }
  }
  const handed = Math.round(p * 100) / 100;
  return {
    turn: handed >= 0.5 ? 'handed_over' : 'still_talking',
    probabilities: { turn: { handed_over: handed, still_talking: Math.round((1 - handed) * 100) / 100 } },
    phrase, why,
  };
}

module.exports = { classify, normalize, PHRASES, P };

// `node frog-turn-end.js` reads JSON lines {before, last} on stdin and writes
// one decision per line: the measurement harness in myvoice.
if (require.main === module) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { buf += d; });
  process.stdin.on('end', () => {
    for (const line of buf.split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      process.stdout.write(JSON.stringify(classify(r.before, r.last)) + '\n');
    }
  });
}
