'use strict';
// The Programs pages in the real app (design/74): the list, a program's calls
// as rows of inputs and outputs, judging one (right, and wrong with the right
// answer), a random draw, versions side by side, the rows with known answers,
// the right panel, and a phone. The ratings land in the FunctAI log as lines
// FunctAI itself reads.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

let n = 0;
const id = () => '01926a8e-' + String(++n).padStart(4, '0') + '-7000-8000-' + String(n).padStart(12, '0');
const V1 = 'sha256:' + 'a'.repeat(64), V2 = 'sha256:' + 'b'.repeat(64);
function call({ name = 'team', module = 'support', version = V2, message, answer, started, error = null, caller = {}, parent = null, language = 'python' }) {
  const cid = id();
  return {
    functai_call: 1, id: cid, parent, root: parent || cid,
    program: { name, kind: 'ai', module, version, signature: 'sha256:' + '5'.repeat(64), answer: 'result', file: '/work/support.py', line: 9 },
    started, seconds: 0.5, content: true, inputs: { message }, outputs: error ? null : { result: answer },
    sizes: { inputs: { message: message.length + 2 }, outputs: error ? {} : { result: answer.length + 2 } }, error,
    model: 'gpt-4.1-mini', usage: { input_tokens: 120, output_tokens: 4 }, confidence: null,
    exchanges: [{ model: 'gpt-4.1-mini', provider: 'openai', started, seconds: 0.49, cached: false, finish: error ? null : 'stop', usage: { input_tokens: 120, output_tokens: 4 },
      request: { model: 'gpt-4.1-mini', system: 'Function: team\n\nWhich team should answer this customer message?', messages: [{ role: 'user', parts: [{ type: 'text', text: `<message>\n${message}\n</message>\n` }] }] },
      ...(error ? { error: { type: error.type, message: error.message } } : { response: { model: 'gpt-4.1-mini', message: { role: 'assistant', parts: [{ type: 'text', text: `<result>\n${answer}\n</result>` }] }, finish_reason: 'stop' } }) }],
    caller, process: { host: 'lambda', pid: 7, user: 'someone', language, runtime: '3.13', functai: '1.1.0' },
  };
}

test('browser: AI programs, from the call log to judged rows', { timeout: 120000 }, async t => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'programs-log-'));
  t.after(() => fs.rmSync(logRoot, { recursive: true, force: true }));
  const folder = path.join(logRoot, 'calls'), day = path.join(folder, '2026-09-26');
  fs.mkdirSync(day, { recursive: true });
  const messages = [['The vase came smashed.', 'product', 'shipping'], ['Refund please, the chair wobbles.', 'product', 'billing'],
    ['I cannot log in.', 'account', 'account'], ['Where is order A-1042?', 'shipping', 'shipping'], ['Charged twice.', 'billing', 'billing']];
  const lines = [];
  messages.forEach(([m, before, after], i) => {
    lines.push(call({ version: V1, message: m, answer: before, started: `2026-09-26T09:0${i}:00.000000Z`, caller: { evaluation: 'e1' } }));
    lines.push(call({ version: V2, message: m, answer: after, started: `2026-09-26T10:0${i}:00.000000Z`, caller: { kind: 'notebook', notebook: '/work/triage.md' } }));
  });
  lines.push(call({ version: V2, message: 'Help??', answer: '', started: '2026-09-26T10:09:00.000000Z', error: { type: 'Refusal', code: 'parse-choice', message: 'furious is not one of the choices' } }));
  lines.push(call({ name: 'mood', module: 'reviews', version: V1, message: 'Love it.', answer: 'happy', started: '2026-09-26T08:00:00.000000Z', language: 'typescript' }));
  fs.writeFileSync(path.join(day, 'lambda-7-abcdef.jsonl'), lines.map(l => JSON.stringify(l) + '\n').join(''));

  const { evaluate, until, size, exceptions, base, auth } = await viewerBrowser(t, { env: { FUNCTAI_LOG_CALLS: folder } });
  // Chattering's own file, in the folder of the day it wrote (today, UTC).
  const ratingLines = () => fs.readdirSync(folder).flatMap(d => fs.readdirSync(path.join(folder, d)).filter(f => f.startsWith('chattering-'))
    .flatMap(f => fs.readFileSync(path.join(folder, d, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)));

  // The list.
  await evaluate(`Programs.showList()`);
  await until(`document.querySelectorAll('.pg-list-table tr[data-program]').length === 2`, 'two programs listed');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.pg-list-table tr[data-program]')].map(r => r.querySelector('b').textContent)`), ['team', 'mood'], 'newest first');

  // One program: use calls only (evaluation calls are counted apart), newest first.
  await evaluate(`document.querySelector('tr[data-program*="team"]').click()`);
  await until(`document.querySelectorAll('tr[data-run]').length === 6`, 'six use calls');
  assert.match(await evaluate(`document.querySelector('.pg-cards').innerText`), /5 in evaluations not counted/);
  assert.equal(await evaluate(`document.querySelector('tr[data-run] .pg-assess').innerText.trim()`), '✗ Refusal\nparse-choice', 'the failed call first, with its refusal code');
  assert.match(await evaluate(`decodeURIComponent(location.hash)`), /^#program=\{"name":"team","module":"support"\}$/);

  // Open a call whole: inputs, outputs, what the model saw.
  await evaluate(`[...document.querySelectorAll('tr[data-run]')].find(r => r.innerText.includes('Charged twice')).click()`);
  await until(`document.querySelector('.pg-detail .pg-fields')`, 'the call, whole');
  assert.match(await evaluate(`document.querySelector('.pg-detail').innerText`), /notebook · triage\.md[\s\S]*Charged twice\.[\s\S]*billing[\s\S]*What the model saw[\s\S]*Which team should answer/i);
  // Right.
  await evaluate(`document.querySelector('[data-rate=right]').click()`);
  await until(`document.querySelector('.pg-ratings')`, 'the judgement is shown');
  let written = ratingLines();
  assert.equal(written.length, 1);
  assert.equal(written[0].verdict, 'right');
  assert.equal(written[0].by, os.userInfo().username, 'the owner rates as the person FunctAI names in their own scripts');

  // Wrong, with the right answer picked from answers the program gave elsewhere.
  await evaluate(`[...document.querySelectorAll('tr[data-run]')].find(r => r.innerText.includes('vase')).click()`);
  await until(`document.querySelector('.pg-detail') && document.querySelector('.pg-detail').innerText.includes('vase')`);
  await evaluate(`document.querySelector('[data-rate=wrong]').click()`);
  await until(`document.querySelector('#pgCorrect [data-pick]')`, 'the correction form offers seen answers');
  await evaluate(`const f = document.querySelector('#pgCorrect'); [...f.querySelectorAll('[data-pick]')].find(b => b.textContent === 'product').click();
    f.querySelector('[data-reason="wrong choice"]').click(); f.querySelector('#pgNote').value = 'Broken on arrival is the product.'; f.requestSubmit();`);
  await until(`[...document.querySelectorAll('tr[data-run]')].find(r => r.innerText.includes('vase')).querySelector('.pg-assess').innerText.includes('wrong')`, 'the row shows it');
  written = ratingLines();
  assert.deepEqual({ verdict: written[1].verdict, answer: written[1].answer, reasons: written[1].reasons, note: written[1].note, origin: written[1].origin },
    { verdict: 'wrong', answer: 'product', reasons: ['wrong choice'], note: 'Broken on arrival is the product.', origin: 'review' });

  // A random draw: every rating carries the draw's id; the score comes from draws only.
  await evaluate(`document.querySelector('[data-pg-tab=review]').click()`);
  await until(`document.querySelector('[data-pg-queue=draw]')`);
  await evaluate(`document.querySelector('[data-pg-queue=draw]').click()`);
  await until(`document.querySelector('[data-review=right]')`, 'a call to judge');
  const drawn = 3; // the answered calls of the current version nobody has judged
  assert.match(await evaluate(`document.querySelector('.pg-progress').innerText`), /^1 of 3 in this draw/);
  for (let i = 0; i < drawn; i++) {
    await evaluate(`document.querySelector('[data-review=right]').click()`);
    await until(`!document.querySelector('[data-review=right]') || document.querySelector('.pg-progress').innerText.includes('${i + 1} judged')`);
  }
  await until(`document.querySelector('.pg-measured').innerText.includes('100%')`, 'measured from the draw');
  const draws = ratingLines().filter(r => r.sample);
  assert.equal(draws.length, 3);
  assert.equal(new Set(draws.map(r => r.sample)).size, 1);

  // Versions: the same inputs, answered by each.
  await evaluate(`document.querySelector('[data-pg-tab=versions]').click()`);
  await until(`document.querySelector('[data-pg-compare]')`);
  await evaluate(`document.querySelector('[data-pg-compare]').click()`);
  await until(`document.querySelector('.pg-compare')`);
  assert.match(await evaluate(`document.querySelector('.pg-compare p').innerText`), /^5 inputs were answered by both; 2 answered differently\./);

  // Data: the rows FunctAI's evaluate reads; the same rows as a file.
  await evaluate(`document.querySelector('[data-pg-tab=data]').click()`);
  await until(`document.querySelector('.pg-data-table')`);
  assert.match(await evaluate(`document.querySelector('.pg-data p').innerText`), /^5 rows with known answers/);
  const csv = await fetch(base + '/api/programs/rated?name=team&module=support&format=csv', { headers: auth });
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  const csvText = await csv.text();
  assert.match(csvText.split('\r\n')[0], /^message,result,call,version,rating,rated_by,origin,sample,disputed$/);
  assert.match(csvText, /The vase came smashed\.,product,/);

  // The right panel lists programs; a row opens its page.
  await evaluate(`goHome(); setRightFiles('recent-files', true); setRightView('programs')`);
  await until(`document.querySelectorAll('#rightFileList .pg-row').length === 2`, 'the panel lists programs');
  await evaluate(`[...document.querySelectorAll('#rightFileList .pg-row')].find(r => r.innerText.includes('mood')).querySelector('button').click()`);
  await until(`typeof viewKind !== 'undefined' && viewKind === 'program' && document.querySelectorAll('tr[data-run]').length === 1`, 'mood opened');

  // A phone: nothing wider than the screen.
  await size(390, 844, true);
  await until(`document.documentElement.scrollWidth <= innerWidth + 1`, 'no sideways scroll on a phone');
  assert.deepEqual(exceptions, []);
});
