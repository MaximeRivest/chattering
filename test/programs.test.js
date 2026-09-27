'use strict';
// programs.js: the FunctAI call log read, indexed and rated by the
// contract's rules (design/74).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const programs = require('../programs.js');
const platform = require('../platform.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'functai-rated');

test('rows with known answers: every rated case of the FunctAI contract', () => {
  const cases = fs.readdirSync(FIXTURES).filter(f => f.endsWith('.json'));
  assert.ok(cases.length >= 11);
  for (const file of cases) {
    const c = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
    const calls = c.records.filter(r => r.functai_call === 1);
    const ratings = c.records.filter(r => r.functai_rating === 1);
    const out = programs.ratedRows(calls, ratings, c.rated);
    assert.deepEqual(out.rows, c.expect.rows, file);
    assert.deepEqual(out.left_out, c.expect.left_out, file);
  }
});

test('the log folder follows FunctAI: a named folder wins, switch words keep the default', () => {
  const home = path.join(os.tmpdir(), 'h');
  assert.equal(platform.functaiCallsDir({ FUNCTAI_LOG_CALLS: '/data/log' }, home), path.resolve('/data/log'));
  assert.equal(platform.functaiCallsDir({ FUNCTAI_LOG_CALLS: '~/x' }, home), path.resolve(home, 'x'));
  const byDefault = platform.functaiCallsDir({ FUNCTAI_LOG_CALLS: '1' }, home);
  assert.equal(platform.functaiCallsDir({}, home), byDefault);
  assert.match(byDefault, /functai[\\/]calls$/);
  if (platform.IS_LINUX) {
    assert.equal(platform.functaiCallsDir({ XDG_DATA_HOME: '/xdg' }, home), path.join('/xdg', 'functai', 'calls'));
    assert.equal(byDefault, path.join(home, '.local', 'share', 'functai', 'calls'));
  }
});

// ---- a log folder, written as FunctAI writes it ----------------------------------

let n = 0;
const uuid = () => '01926a8e-' + String(++n).padStart(4, '0') + '-7000-8000-000000000000';
function call(over = {}) {
  const id = over.id || uuid();
  return {
    functai_call: 1, id, parent: null, root: id,
    program: { name: 'team', kind: 'ai', module: 'support', version: 'sha256:' + '1'.repeat(64), signature: 'sha256:' + '5'.repeat(64), answer: 'result', file: '/work/support/triage.py', line: 4 },
    started: '2026-09-26T10:00:00.000000Z', seconds: 0.4, content: true,
    inputs: { message: 'I was charged twice.' }, outputs: { result: 'billing' },
    sizes: { inputs: { message: 20 }, outputs: { result: 9 } }, error: null, model: 'gpt-4.1-mini',
    usage: { input_tokens: 200, output_tokens: 3 }, confidence: null,
    exchanges: [{ model: 'gpt-4.1-mini', provider: 'openai', started: '2026-09-26T10:00:00.000100Z', seconds: 0.39, cached: false, finish: 'stop',
      usage: { input_tokens: 200, output_tokens: 3 }, request: { model: 'gpt-4.1-mini', system: 'Function: team', messages: [{ role: 'user', parts: [{ type: 'text', text: '<message>\nI was charged twice.\n</message>\n' }] }] },
      response: { model: 'gpt-4.1-mini', message: { role: 'assistant', parts: [{ type: 'text', text: '<result>\nbilling\n</result>' }] }, finish_reason: 'stop' } }],
    caller: {}, process: { host: 'lambda', pid: 1, user: 'maxime', language: 'python', runtime: '3.13.1', functai: '1.1.0' },
    ...over,
    program: { name: 'team', kind: 'ai', module: 'support', version: 'sha256:' + '1'.repeat(64), signature: 'sha256:' + '5'.repeat(64), answer: 'result', file: '/work/support/triage.py', line: 4, ...(over.program || {}) },
  };
}
const rating = (callId, verdict, over = {}) => ({ functai_rating: 1, id: uuid(), call: callId, at: '2026-09-26T11:00:00.000000Z', by: 'maxime', verdict, ...over });
const line = r => JSON.stringify(r) + '\n';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'programs-'));
  const folder = path.join(root, 'calls');
  fs.mkdirSync(path.join(folder, '2026-09-25'), { recursive: true });
  fs.mkdirSync(path.join(folder, '2026-09-26'), { recursive: true });
  let clock = Date.parse('2026-09-26T12:00:00Z');
  const index = programs.createProgramIndex({ folder, dbFile: path.join(root, 'cache', 'programs.db'), projectOfPath: p => (String(p).startsWith('/work/support') ? 'support' : null), host: 'testhost', now: () => clock });
  return { root, folder, index, tick: ms => { clock += ms; }, setClock: ms => { clock = ms; } };
}

test('the index reads every writer and day, skips what is not a record, and waits for a partial line', t => {
  const { root, folder, index, tick } = fixture();
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const a = call({ started: '2026-09-25T09:00:00.000000Z' });
  const b = call({ started: '2026-09-26T10:00:00.000000Z', inputs: { message: 'My parcel never came.' }, outputs: { result: 'shipping' } });
  const c = call({ started: '2026-09-26T10:05:00.000000Z', outputs: null, error: { type: 'Refusal', code: 'parse-choice', message: 'furious is not a choice' } });
  const evalCall = call({ started: '2026-09-26T10:06:00.000000Z', caller: { evaluation: 'run-1' } });
  const other = call({ program: { name: 'summarize', module: 'notes', answer: 'result', file: '/elsewhere/n.ts' }, started: '2026-09-26T08:00:00.000000Z', outputs: { result: 'A summary.' },
    process: { host: 'lambda', pid: 2, user: 'maxime', language: 'typescript', runtime: 'node 24', functai: '0.1.0' } });
  fs.writeFileSync(path.join(folder, '2026-09-25', 'lambda-1-aaaaaa.jsonl'), line(a) + 'not json\n' + line({ something: 'else' }));
  const bText = line(b);
  fs.writeFileSync(path.join(folder, '2026-09-26', 'lambda-1-aaaaaa.jsonl'), line(c) + line(evalCall) + bText.slice(0, 40));
  fs.writeFileSync(path.join(folder, '2026-09-26', 'lambda-2-bbbbbb.jsonl'), line(other) + line(rating(a.id, 'right')));
  fs.mkdirSync(path.join(folder, 'not-a-day'));
  fs.writeFileSync(path.join(folder, 'not-a-day', 'x.jsonl'), line(call()));

  assert.equal(index.refresh(), true);
  const list = index.programs();
  assert.deepEqual(list.map(p => p.name), ['team', 'summarize']);
  const team = list[0];
  assert.equal(team.calls, 3, 'the partial line is not read yet');
  assert.equal(team.useCalls, 2, 'evaluation calls are not use');
  assert.equal(team.errors, 1);
  assert.equal(team.project, 'support');
  assert.deepEqual(team.ratings, { right: 1, wrong: 0, disputed: 0, open: 0 });
  assert.deepEqual(list[1].languages, ['typescript']);

  // The writer finishes its line.
  fs.appendFileSync(path.join(folder, '2026-09-26', 'lambda-1-aaaaaa.jsonl'), bText.slice(40));
  tick(1000);
  index.refresh();
  assert.equal(index.programs()[0].calls, 4);

  const r = index.runs('team', 'support');
  assert.equal(r.total, 3);
  assert.deepEqual(r.runs.map(x => x.id), [c.id, b.id, a.id], 'newest first, evaluation calls left out');
  assert.equal(r.runs[0].error.code, 'parse-choice');
  assert.equal(r.runs[1].inputs, 'My parcel never came.');
  assert.equal(r.runs[1].answerValue, 'shipping');
  assert.equal(r.runs[2].rating, 'right');
  assert.deepEqual(index.runs('team', 'support', { purpose: 'all' }).total, 4);
  assert.deepEqual(index.runs('team', 'support', { purpose: 'evaluation' }).runs.map(x => x.id), [evalCall.id]);
  assert.deepEqual(index.runs('team', 'support', { status: 'error' }).runs.map(x => x.id), [c.id]);
  assert.deepEqual(index.runs('team', 'support', { rating: 'unrated' }).runs.map(x => x.id), [c.id, b.id]);
  assert.deepEqual(index.runs('team', 'support', { q: 'PARCEL' }).runs.map(x => x.id), [b.id]);
  assert.deepEqual(index.runs('team', 'support', { q: '100%' }).runs, [], 'search text is literal');

  const one = index.run(b.id);
  assert.equal(one.record.exchanges[0].response.message.parts[0].text, '<result>\nbilling\n</result>', 'the whole line is read back from the log');
  assert.equal(index.run('nope'), null);
});

test('a rating from Chattering is a line of its own file, read back like any writer’s', t => {
  const { root, folder, index, tick } = fixture();
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const a = call();
  const b = call({ inputs: { message: 'Where is my parcel?' }, outputs: { result: 'billing' } });
  fs.writeFileSync(path.join(folder, '2026-09-26', 'lambda-1-aaaaaa.jsonl'), line(a) + line(b));
  index.refresh();

  const out = index.rate({ call: b.id, verdict: 'wrong', answer: 'shipping', reasons: ['wrong team'], note: 'A parcel is shipping.', by: 'maxime' });
  assert.equal(out.state.state, 'wrong');
  assert.equal(out.state.open, false);
  const file = path.join(folder, '2026-09-26', index.writerName);
  assert.match(index.writerName, /^chattering-testhost-\d+-[0-9a-f]{6}\.jsonl$/);
  if (!platform.IS_WIN) assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the log holds what people typed');
  const [written] = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(Object.keys(written), ['functai_rating', 'id', 'call', 'at', 'by', 'verdict', 'answer', 'reasons', 'note', 'origin']);
  assert.match(written.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(written.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  assert.equal(written.origin, 'review');

  // Wrong without an answer: open, waiting for someone who knows.
  tick(1000);
  assert.equal(index.rate({ call: a.id, verdict: 'wrong', by: 'lilly' }).state.open, true);
  assert.deepEqual(index.runs('team', 'support', { rating: 'open' }).runs.map(x => x.id), [a.id]);
  // Someone else says it was right: disputed.
  tick(1000);
  assert.equal(index.rate({ call: a.id, verdict: 'right', by: 'maxime' }).state.state, 'disputed');
  // Lilly withdraws: maxime's right stands alone.
  tick(1000);
  assert.equal(index.rate({ call: a.id, verdict: null, by: 'lilly' }).state.state, 'right');

  assert.throws(() => index.rate({ call: a.id, verdict: 'right', answer: 'x', by: 'maxime' }), /Only a wrong answer/);
  assert.throws(() => index.rate({ call: 'missing', verdict: 'right', by: 'maxime' }), e => e.status === 404);
  assert.throws(() => index.rate({ call: a.id, verdict: 'maybe', by: 'maxime' }), /verdict/);

  // The rows equal the contract's rules over the raw log.
  const raw = fs.readdirSync(path.join(folder, '2026-09-26')).flatMap(f => fs.readFileSync(path.join(folder, '2026-09-26', f), 'utf8').trim().split('\n').map(JSON.parse));
  const expected = programs.ratedRows(raw.filter(r => r.functai_call), raw.filter(r => r.functai_rating), { name: 'team', module: 'support' });
  const rows = index.rated('team', 'support');
  assert.deepEqual(rows, expected);
  assert.deepEqual(rows.rows.map(r => r.result), ['billing', 'shipping']);
});

test('random draws: a sample id on ratings, and a score from draws alone', t => {
  const { root, folder, index, tick } = fixture();
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const calls = Array.from({ length: 10 }, (_, i) => call({ started: `2026-09-26T10:${String(i).padStart(2, '0')}:00.000000Z`, inputs: { message: 'm' + i } }));
  fs.writeFileSync(path.join(folder, '2026-09-26', 'lambda-1-aaaaaa.jsonl'), calls.map(line).join(''));
  index.refresh();
  // A rating someone chose to make does not count towards the score.
  index.rate({ call: calls[0].id, verdict: 'wrong', by: 'maxime' });
  const draw = index.sample('team', 'support', { n: 4 });
  assert.equal(draw.ids.length, 4);
  assert.ok(!draw.ids.includes(calls[0].id), 'unrated calls only');
  draw.ids.forEach((id, i) => { tick(10); index.rate({ call: id, verdict: i < 3 ? 'right' : 'wrong', by: 'maxime', sample: draw.sample }); });
  const p = index.program('team', 'support');
  assert.equal(p.sample.n, 4);
  assert.equal(p.sample.right, 3);
  assert.ok(p.sample.low < 0.75 && p.sample.high > 0.75);
  assert.equal(p.stats.use, 10);
  assert.equal(p.stats.days.length, 30);
  assert.equal(p.stats.days.at(-1).n, 10);
  assert.deepEqual(p.answers, [{ value: 'billing', n: 10 }]);
});

test('versions and comparison: the same inputs answered by two versions', t => {
  const { root, folder, index } = fixture();
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const v1 = 'sha256:' + 'a'.repeat(64), v2 = 'sha256:' + 'b'.repeat(64);
  const recs = [
    call({ program: { version: v1 }, inputs: { message: 'broken vase' }, outputs: { result: 'product' }, started: '2026-09-26T09:00:00.000000Z' }),
    call({ program: { version: v1 }, inputs: { message: 'refund please' }, outputs: { result: 'billing' }, started: '2026-09-26T09:01:00.000000Z' }),
    call({ program: { version: v2 }, inputs: { message: 'broken vase' }, outputs: { result: 'shipping' }, started: '2026-09-26T10:00:00.000000Z' }),
    call({ program: { version: v2 }, inputs: { message: 'refund please' }, outputs: { result: 'billing' }, started: '2026-09-26T10:01:00.000000Z' }),
    call({ program: { version: v2 }, inputs: { message: 'new one' }, outputs: { result: 'account' }, started: '2026-09-26T10:02:00.000000Z' }),
  ];
  fs.writeFileSync(path.join(folder, '2026-09-26', 'w.jsonl'), recs.map(line).join(''));
  index.refresh();
  const vs = index.versions('team', 'support');
  assert.deepEqual(vs.map(v => [v.version, v.current, v.useCalls]), [[v2, true, 3], [v1, false, 2]]);
  const cmp = index.compare('team', 'support', v1, v2);
  assert.equal(cmp.common, 2);
  assert.equal(cmp.differ, 1);
  assert.equal(cmp.onlyB, 1);
  assert.deepEqual([cmp.pairs[0].a.answerValue, cmp.pairs[0].b.answerValue], ['product', 'shipping'], 'differences first');
});

test('the index is a cache: deleted, it is rebuilt from the log', t => {
  const { root, folder, index } = fixture();
  const a = call();
  fs.writeFileSync(path.join(folder, '2026-09-26', 'w.jsonl'), line(a));
  index.refresh();
  index.rate({ call: a.id, verdict: 'right', by: 'maxime' });
  index.close();
  fs.rmSync(path.join(root, 'cache'), { recursive: true, force: true });
  const again = programs.createProgramIndex({ folder, dbFile: path.join(root, 'cache', 'programs.db'), now: () => Date.parse('2026-09-26T12:00:00Z') });
  t.after(() => { again.close(); fs.rmSync(root, { recursive: true, force: true }); });
  again.refresh();
  assert.equal(again.runs('team', 'support').runs[0].rating, 'right');
});

test('values not recorded (log_content off): sizes and times only, never a row', t => {
  const { root, folder, index } = fixture();
  t.after(() => { index.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const secret = call({ content: false });
  delete secret.inputs; delete secret.outputs;
  secret.exchanges = secret.exchanges.map(({ request, response, ...rest }) => rest);
  fs.writeFileSync(path.join(folder, '2026-09-26', 'w.jsonl'), line(secret));
  index.refresh();
  const [r] = index.runs('team', 'support').runs;
  assert.equal(r.content, false);
  assert.equal(r.inputs, '');
  index.rate({ call: secret.id, verdict: 'right', by: 'maxime' });
  assert.deepEqual(index.rated('team', 'support').left_out, { other_signature: 0, no_content: 1, no_answer: 0 });
  assert.deepEqual(index.sample('team', 'support').ids, [], 'nothing to judge in a draw');
});
