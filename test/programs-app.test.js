'use strict';
// The Programs pages in the real app (design/74), walked the way a person
// uses them: which programs are there, what one promises (its instruction and
// arrow signature), its examples as input → output, judging one right, one
// wrong with the answer it should have given, checking random answers for the
// one honest measure, which answers a new version changed and which was
// right, the answer key, the right panel, a phone. The judgements land in the
// FunctAI log as lines FunctAI itself reads.
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
      request: { model: 'gpt-4.1-mini', system: 'Function: team\n\nWhich team should answer this customer message?\n\nReply in exactly this form:\n<result>\none of: shipping, billing, product, account\n</result>\n', messages: [{ role: 'user', parts: [{ type: 'text', text: `<message>\n${message}\n</message>\n` }] }] },
      ...(error ? { error: { type: error.type, message: error.message } } : { response: { model: 'gpt-4.1-mini', message: { role: 'assistant', parts: [{ type: 'text', text: `<result>\n${answer}\n</result>` }] }, finish_reason: 'stop' } }) }],
    caller, process: { host: 'lambda', pid: 7, user: 'someone', language, runtime: '3.13', functai: '1.1.0' },
  };
}

test('browser: AI programs, from the call log to judged rows', { timeout: 120000 }, async t => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'programs-log-'));
  t.after(() => fs.rmSync(logRoot, { recursive: true, force: true }));
  const folder = path.join(logRoot, 'calls'), day = path.join(folder, new Date().toISOString().slice(0, 10));
  fs.mkdirSync(day, { recursive: true });
  // Times an hour ago and after, so "this week" holds whenever the test runs.
  const at = min => new Date(Date.now() - 3600000 + min * 60000).toISOString().replace(/\.\d+Z$/, m => m.slice(0, 4).padEnd(7, '0') + 'Z');
  const messages = [['The vase came smashed.', 'product', 'shipping'], ['Refund please, the chair wobbles.', 'product', 'billing'],
    ['I cannot log in.', 'account', 'account'], ['Where is order A-1042?', 'shipping', 'shipping'], ['Charged twice.', 'billing', 'billing']];
  const lines = [];
  messages.forEach(([m, before, after], i) => {
    lines.push(call({ version: V1, message: m, answer: before, started: at(i), caller: { evaluation: 'e1' } }));
    lines.push(call({ version: V2, message: m, answer: after, started: at(10 + i), caller: { kind: 'notebook', notebook: '/work/triage.md' } }));
  });
  lines.push(call({ version: V2, message: 'Help??', answer: '', started: at(20), error: { type: 'Refusal', code: 'parse-choice', message: 'furious is not one of the choices' } }));
  lines.push(call({ name: 'mood', module: 'reviews', version: V1, message: 'Love it.', answer: 'happy', started: at(-30), language: 'typescript' }));
  fs.writeFileSync(path.join(day, 'lambda-7-abcdef.jsonl'), lines.map(l => JSON.stringify(l) + '\n').join(''));

  const { evaluate, until, size, exceptions, base, auth } = await viewerBrowser(t, { env: { FUNCTAI_LOG_CALLS: folder } });
  // Chattering's own file, in the folder of the day it wrote (today, UTC).
  const ratingLines = () => fs.readdirSync(folder).flatMap(d => fs.readdirSync(path.join(folder, d)).filter(f => f.startsWith('chattering-'))
    .flatMap(f => fs.readFileSync(path.join(folder, d, f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)));
  const text = sel => evaluate(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`);

  // Which programs there are, each with its promise.
  await evaluate(`Programs.showList()`);
  await until(`document.querySelectorAll('.pg-card').length === 2`, 'two programs listed');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.pg-card .pg-card-name')].map(c => c.innerText.replace('ƒ', '').trim())`), ['team', 'mood'], 'the most recently used first');
  assert.match(await evaluate(`document.querySelector('.pg-card').innerText`), /message\s*→\s*shipping · billing · product · account[\s\S]*Which team should answer/);

  // One program: its instruction, its arrow signature, its examples.
  await evaluate(`document.querySelector('.pg-card').click()`);
  await until(`document.querySelectorAll('.pg-tr').length === 6`, 'six examples (the evaluation runs are counted apart)');
  assert.equal((await text('.pg-lede')).trim(), 'Which team should answer this customer message?');
  assert.equal((await text('.pg-sigbox')).replace(/\s+/g, ' ').trim(), 'message → shipping · billing · product · account');
  assert.match(await text('.pg-status'), /6 answers this week · 1 failure[\s\S]*Nobody knows yet/);
  assert.match(await text('.pg-pills'), /5 \? not judged[\s\S]*1 ! failed/);
  assert.match(await text('.pg-tools'), /5 test runs/);
  assert.match(await evaluate(`document.querySelector('.pg-tr').innerText`), /Help\?\?[\s\S]*furious is not one of the choices[\s\S]*! failed/, 'newest first');
  assert.match(await evaluate(`decodeURIComponent(location.hash)`), /^#program=\{"name":"team","module":"support"\}$/);

  // Open one in place: the whole example, and what the model saw.
  const row = m => `[...document.querySelectorAll('.pg-tr')].find(r => r.innerText.includes(${JSON.stringify(m)}))`;
  await evaluate(`${row('Charged twice')}.querySelector('.pg-row-line').click()`);
  await until(`document.querySelector('.pg-tr.open .pg-ask')`, 'opened in place');
  assert.match(await text('.pg-tr.open'), /Charged twice\.[\s\S]*billing[\s\S]*Is billing right for this\?/);
  await evaluate(`document.querySelector('.pg-tr.open details').open = true`);
  assert.match(await text('.pg-tr.open .pg-chat'), /Which team should answer[\s\S]*Charged twice/);
  // Right: written to the log, and the next unjudged example opens.
  await evaluate(`document.querySelector('[data-rate=right]').click()`);
  await until(`${row('Charged twice')}.innerText.includes('✓ right') && document.querySelector('.pg-tr.open') && !document.querySelector('.pg-tr.open').innerText.includes('Charged twice')`, 'judged, and on to the next');
  let written = ratingLines();
  assert.equal(written.length, 1);
  assert.equal(written[0].verdict, 'right');
  assert.equal(written[0].by, os.userInfo().username, 'the owner judges as the person FunctAI names in their own scripts');

  // Wrong: "what should it have said?" offers the other allowed answers.
  await evaluate(`${row('vase')}.querySelector('.pg-row-line') ? ${row('vase')}.querySelector('.pg-row-line').click() : null`);
  await until(`document.querySelector('.pg-tr.open') && document.querySelector('.pg-tr.open').innerText.includes('vase')`);
  await evaluate(`document.querySelector('.pg-tr.open [data-rate=wrong]').click()`);
  await until(`document.querySelectorAll('#pgCorrect [data-pick]').length === 3`, 'the three other answers');
  await evaluate(`document.querySelector('#pgNote').value = 'Broken on arrival is the product.';
    [...document.querySelectorAll('#pgCorrect [data-pick]')].find(b => b.innerText.includes('product')).click()`);
  await until(`${row('vase')}.innerText.includes('should be product')`, 'the row says what it should be');
  written = ratingLines();
  assert.deepEqual({ verdict: written[1].verdict, answer: written[1].answer, note: written[1].note, origin: written[1].origin },
    { verdict: 'wrong', answer: 'product', note: 'Broken on arrival is the product.', origin: 'review' });

  // Check random answers: the one honest measure.
  await evaluate(`document.querySelector('[data-pg-check]').click()`);
  await until(`document.querySelector('.pg-check .pg-ask')`, 'a random answer to check');
  assert.match(await text('.pg-check-head'), /1 of 3/, 'the three answered examples nobody judged');
  for (let i = 0; i < 3; i++) {
    await until(`document.querySelector('[data-check=right]') && document.querySelector('.pg-check-head').innerText.includes('${i + 1} of 3')`);
    await evaluate(`document.querySelector('[data-check=right]').click()`);
  }
  await until(`document.querySelector('.pg-check-done')`, 'the result');
  assert.match(await text('.pg-check-done'), /^3 of 3[\s\S]*were right/);
  assert.equal((await text('.pg-score-n')).trim(), '100%');
  const draws = ratingLines().filter(r => r.sample);
  assert.equal(draws.length, 3);
  assert.equal(new Set(draws.map(r => r.sample)).size, 1, 'one draw, one id');

  // Compare versions: which answers the change changed, and which was right.
  await evaluate(`document.querySelector('[data-pg-tab=compare]').click()`);
  await until(`document.querySelectorAll('.pg-cmp').length === 2`, 'the two changed answers');
  // The random check judged v2's chair answer right; now say v1 had the vase right.
  assert.equal((await text('.pg-compare .pg-lede')).trim(), '2 of the 5 questions both answered got a different answer. Click the right one.');
  assert.equal((await text('.pg-board')).replace(/\s+/g, ' ').trim(), '0 v1 was right 1 v2 was right 1 to judge');
  await evaluate(`[...document.querySelectorAll('.pg-cmp')].find(c => c.innerText.includes('vase')).querySelector('[data-cmp-right=a]').click()`);
  await until(`document.querySelector('.pg-board-end')`, 'every change judged: a conclusion');
  assert.equal((await text('.pg-board')).replace(/\s+/g, ' ').trim(), '1 v1 was right 1 v2 was right 0 to judge Neither is better on what changed.');

  // The answer key: the rows FunctAI's evaluate reads, and the same rows as a file.
  await evaluate(`document.querySelector('[data-pg-tab=key]').click()`);
  await until(`document.querySelector('.pg-key')`);
  assert.match(await text('.pg-key .pg-lede'), /^\d+ examples with a known right answer/);
  const csv = await fetch(base + '/api/programs/rated?name=team&module=support&format=csv', { headers: auth });
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  const csvText = await csv.text();
  assert.match(csvText.split('\r\n')[0], /^message,result,call,version,rating,rated_by,origin,sample,disputed$/);
  assert.match(csvText, /The vase came smashed\.,product,/);

  // The right panel lists programs; a row opens its page.
  await evaluate(`goHome(); setRightFiles('recent-files', true); setRightView('programs')`);
  await until(`document.querySelectorAll('#rightFileList .pg-row').length === 2`, 'the panel lists programs');
  await evaluate(`[...document.querySelectorAll('#rightFileList .pg-row')].find(r => r.innerText.includes('mood')).querySelector('button').click()`);
  await until(`typeof viewKind !== 'undefined' && viewKind === 'program' && document.querySelectorAll('.pg-tr').length === 1`, 'mood opened');

  // A phone: nothing wider than the screen.
  await size(390, 844, true);
  await until(`document.documentElement.scrollWidth <= innerWidth + 1`, 'no sideways scroll on a phone');
  assert.deepEqual(exceptions, []);
});
