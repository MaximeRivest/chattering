'use strict';
// The walkie-talkie's end-of-turn check on the real Jev (design/102): the
// AI program frog_turn_end, through FunctAI, as the server runs it, logged
// to a call log. Costs a fraction of a cent and needs the network, so it
// runs only when asked: CHATTERING_REAL_JEV=1 (the TypeSafe key from the
// environment, else Chattering's saved one).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const frog = require('../frog-assistant.js');

const keyFile = path.join(os.homedir(), '.config', 'chattering', 'typesafe-api-key');
const key = process.env.TYPESAFE_API_KEY || (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '');
const wanted = process.env.CHATTERING_REAL_JEV === '1';

test('Jev hears a hand-over at the end, and not the same words inside a sentence', { skip: !wanted ? 'set CHATTERING_REAL_JEV=1' : !key && 'no TypeSafe key', timeout: 60000 }, async t => {
  process.env.TYPESAFE_API_KEY = key;
  const log = fs.mkdtempSync(path.join(os.tmpdir(), 'frog-jev-'));
  t.after(() => fs.rmSync(log, { recursive: true, force: true }));
  const programs = require('../ai-programs.js').createAiPrograms({
    piExec: async () => { throw new Error('no Pi here'); }, chatPost: async () => { throw new Error('no chat here'); },
    voiceEndpoint: () => ({}), lm: () => 'none', logFolder: () => log,
  });
  const cases = [
    ['tell the groups conversation to keep the folds when the page reloads', 'okay over to you', true],
    ['', 'what is everybody working on? Over.', true],
    ['so the training run', 'is over now but I want to look at the loss first and', false],
    ['I think we are', 'done with the paper and the next thing is the figures', false],
    ['send that to the paper one', 'your turn', true],
    ['and then, um', 'let me think about it', false],
  ];
  let wrong = 0;
  for (const [before, last, handed] of cases) {
    const t0 = Date.now();
    const r = await programs.run('frog_turn_end', { before, last }, { caller: { kind: 'chattering', purpose: 'test' } });
    const d = frog.turnDecision(r.probabilities);
    t.diagnostic(`${Date.now() - t0} ms · ${r.outputs.turn} · p(handed over) ${d.handedOver.toFixed(2)} · ${JSON.stringify(last)}`);
    assert.ok(r.probabilities && r.probabilities.turn, 'Jev measures every answer (sure ones included: 1.0 and 0.0)');
    if ((r.outputs.turn === 'handed_over') !== handed) wrong++;
    if (handed) assert.ok(!d.ask || d.send || d.handedOver >= frog.TURN_ASK_AT, 'a clear hand-over is at least asked about');
    else assert.equal(d.send, false, 'never sent while still talking: ' + last);
  }
  assert.ok(wrong <= 1, wrong + ' of ' + cases.length + ' wrong');
  // Every call is in the log, for the Programs page and a dataset.
  const lines = fs.readdirSync(log, { recursive: true }).filter(f => f.endsWith('.jsonl'))
    .flatMap(f => fs.readFileSync(path.join(log, f), 'utf8').trim().split('\n').map(JSON.parse)).filter(r => r.functai_call);
  assert.equal(lines.length, cases.length);
  assert.ok(lines.every(r => r.program.name === 'frog_turn_end' && r.program.module === 'chattering' && r.outputs && r.exchanges[0].provider === 'typesafe'));
});
