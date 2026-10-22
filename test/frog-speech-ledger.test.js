'use strict';
// The frog's speech across a run that is cut (server.js speakFrogText,
// frogNewTurn, frogSpeechEnd; design/102). What happened on 2026-10-18 at
// 19:19: the frog said "Finding that idea.", ran tools, and the person
// sent a question while it worked ("over"). The message was queued into
// the running turn (the same job), the cut cancelled the run's one speech
// ledger, and every word after it (what the frog did, then its answer to
// the question) went unspoken: three replies on screen, none heard.
// Run against the server's own code, lifted the way frog-stream.test.js
// does, with a stand-in Kokoro and a stand-in screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const speechScript = require('../speech-script.js');
const frogLib = require('../frog-assistant.js');

const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
function lift(from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a);
  assert.ok(a >= 0 && b > a, 'server.js has ' + from + ' … ' + to);
  return source.slice(a, b);
}
const ledgerCode = lift('const FROG_RATE = 1;', '// An aside (design/102): said while the frog was speaking.');
const streamCode = lift('const frogStreams = new WeakMap();', '\nasync function frogApi(');

function world() {
  const sent = [];      // what reached the screen, in order
  const made = [];      // what Kokoro was asked for
  const logs = [];
  const broadcasts = [];
  let muted = false;
  let clipSeq = 0;
  const ctx = vm.createContext({
    console: { log: m => logs.push(m), error: m => logs.push(m) },
    Date, Math, String, Number, Array, Map, WeakMap, Set, Promise, JSON, Object, setTimeout,
    path: require('node:path'), TTS_DIR: '/tmp',
    // The woven timeline (frog-timeline.js) lives in the same region: real, logging to a scratch file.
    DATA_DIR: fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'frog-ledger-')), fs,
    require: m => require(m.startsWith('./') ? '../' + m.slice(2) : m),
    theFrog: { key: 'frog', talk: true, speed: 1, asidesText: () => '' },
    speechScript, frogLib,
    voiceMuted: () => muted,
    soundTargets: () => ({ host: false, screens: ['screen-1'] }),
    synthesizeSpeech: async text => { made.push(text); await new Promise(r => setTimeout(r, 5)); return { id: 'clip' + (++clipSeq), runs: [] }; },
    enqueueAnnouncement: () => {}, playTargetsTone: () => {},
    sendScreenSound: (conn, sound) => sent.push(sound),
    broadcast: m => broadcasts.push(m),
    sleep: ms => new Promise(r => setTimeout(r, ms)),
  });
  vm.runInContext(ledgerCode + '\n' + streamCode, ctx);
  const settle = () => new Promise(r => setTimeout(r, 60));
  const spokenTexts = () => sent.filter(s => s.audio).map(s => made[Number(s.frog.clip.slice(4)) - 1]);
  return { ctx, sent, made, logs, broadcasts, settle, spokenTexts, mute: v => { muted = v; } };
}

// A message of the run streamed whole, as the model would.
function stream(ctx, job, id, text) {
  const cur = { id, text: '' };
  for (let i = 3; i < text.length + 3; i += 3) { cur.text = text.slice(0, i); ctx.frogStreamSpeech(job, cur, false); }
  ctx.frogStreamSpeech(job, cur, true);
}

test('a message queued into the running turn cuts what was being said, not what the frog says next', async () => {
  const w = world();
  const job = { id: 'run:abc', key: 'frog', askedBy: 'u1' };
  stream(w.ctx, job, 1, 'Finding that idea.');
  await w.settle();
  assert.equal(w.spokenTexts().length, 1, 'the words before its tools are spoken');
  assert.equal(w.sent[0].frog.job, 'run:abc', 'the first ledger carries the run\u2019s id');

  // The person sends a question while the tools run: startAgentRun calls
  // frogNewTurn first, then queues the message into the same run.
  w.ctx.frogNewTurn();
  assert.equal(JSON.stringify(w.broadcasts.map(b => b.type)), '["frog-cut"]');
  assert.equal(JSON.stringify([...w.broadcasts[0].jobs]), '["run:abc"]', 'the pages are told which ledger was cut');

  // The run goes on: what it did, then (the queued message delivered) its answer.
  stream(w.ctx, job, 2, 'Found it: put the list before the paper. Sending it to Comparison.');
  await w.settle();
  stream(w.ctx, job, 3, 'I queued it in Comparison.\n\nThe GitHub history question is still open for you.');
  await w.settle();
  stream(w.ctx, job, 4, 'The rewrite itself is easy, one command. The finicky part is around it.');
  await w.settle();

  const after = w.sent.filter(s => s.audio).slice(1);
  assert.ok(after.length >= 3, 'the frog\u2019s later words are spoken: ' + JSON.stringify(w.spokenTexts()));
  assert.ok(w.spokenTexts().join(' ').includes('Found it'), 'what it did');
  assert.ok(w.spokenTexts().join(' ').includes('The rewrite itself is easy'), 'its answer to the queued question');
  assert.ok(after.every(s => s.frog.job === 'run:abc#2'), 'on a fresh ledger: ' + JSON.stringify(after.map(s => s.frog.job)));

  // Its "over" follows the last words, for the fresh ledger.
  await w.ctx.frogSpeechEnd(job);
  const over = w.sent.find(s => s.cue === 'over');
  assert.ok(over, 'the frog\u2019s own over after a reply said to the end');
  assert.equal(over.frog.job, 'run:abc#2');
});

test('the rest of a message that was cut off stays unspoken; a later message of the run is said', async () => {
  const w = world();
  const job = { id: 'run:def', key: 'frog', askedBy: 'u1' };
  const cur = { id: 1, text: 'Here is the story. It begins long ago. ' };
  w.ctx.frogStreamSpeech(job, cur, false);
  await w.settle();
  assert.equal(w.spokenTexts().length, 1);
  // The page reports a cut on the clip playing (talk turned off, a message
  // typed to it): the rest of that message is not made.
  w.ctx.frogHeard({ job: 'run:def', clip: 'clip1', ms: 400, state: 'cut' });
  cur.text += 'And then a lot more happened.\n\nAnd more still.';
  w.ctx.frogStreamSpeech(job, cur, true);
  await w.settle();
  assert.equal(w.spokenTexts().length, 1, 'the rest of the stopped message is not said');
  assert.ok(w.logs.some(l => /not spoken: the message was cut off/.test(l)), 'the record says so: ' + JSON.stringify(w.logs));
  // The run goes on (tools), then a new message: said.
  stream(w.ctx, job, 2, 'Done. The file is saved.');
  await w.settle();
  assert.equal(w.spokenTexts().slice(1).join(' '), 'Done. The file is saved.', 'the next message is heard: ' + JSON.stringify(w.spokenTexts()));
  assert.ok(w.sent.filter(s => s.audio).slice(1).every(s => s.frog.job === 'run:def#2'));
});

test('a new run cuts the old one\u2019s ledger and gets its own', async () => {
  const w = world();
  const a = { id: 'run:a', key: 'frog', askedBy: 'u1' }, b = { id: 'run:b', key: 'frog', askedBy: 'u1' };
  stream(w.ctx, a, 1, 'First reply.');
  await w.settle();
  w.ctx.frogNewTurn();
  stream(w.ctx, b, 2, 'Second reply.');
  await w.settle();
  const jobs = w.sent.filter(s => s.audio).map(s => s.frog.job);
  assert.equal(JSON.stringify(jobs), '["run:a","run:b"]');
  // The unspoken pieces of a cut ledger are what the frog is told it missed.
  stream(w.ctx, b, 3, 'One. Two. Three.');
  w.ctx.frogNewTurn();
  await w.settle();
  const note = await w.ctx.frogCutNote();
  assert.match(note.text, /One|Two|Three/, 'the cut note names what was never sent: ' + note.text);
});

test('after its tools, the first sentence of the answer is heard as soon as it ends', () => {
  const w = world();
  const said = [];
  w.ctx.speakFrogText = (job, piece) => said.push(piece);
  const job = { id: 'run:x', key: 'frog' };
  stream(w.ctx, job, 1, 'Checking the run.');
  const cur = { id: 2, text: 'It finished. The loss is 0.12 and the tests pass. ' };
  w.ctx.frogStreamSpeech(job, cur, false);
  assert.equal(said.at(-1), 'It finished. ', 'spoken before the message is whole: ' + JSON.stringify(said));
});
