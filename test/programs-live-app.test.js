'use strict';
// AI programs, live, in the real app (design/74, "Live"): a call Chattering
// makes shows while the model writes it — in "Running now" on the list, on
// its program's page with the input and the output so far — and lands in
// the examples when it is done, open and ready to judge. A call another
// writer appends to the log appears without anyone asking again. A fake Pi
// writes its reply slowly and waits at a gate, so the test sees the call
// mid-way.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

// Each run takes the next reply of answers.json. A reply stops at its "|"
// until the test writes go-<n> (n: the run, from 1).
function fakePi(dir) {
  const cli = path.join(dir, 'fake-pi.js');
  fs.writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs');
const dir = ${JSON.stringify(dir)};
fs.readFileSync(0, 'utf8');
const n = fs.readdirSync(dir).filter(f => f.startsWith('run-')).length + 1;
fs.writeFileSync(dir + '/run-' + n, '');
const answer = JSON.parse(fs.readFileSync(dir + '/answers.json', 'utf8'))[n - 1];
const hold = answer.indexOf('|');
const text = answer.replace('|', '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = e => process.stdout.write(JSON.stringify(e) + '\\n');
(async () => {
  say({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'A title for the fixture.' } });
  for (let i = 0; i < text.length;) {
    if (i === hold && !fs.existsSync(dir + '/go-' + n)) { await sleep(30); continue; }
    const end = Math.min(i + 4, i < hold ? hold : text.length);
    say({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text.slice(i, end) } });
    i = end;
    await sleep(5);
  }
  say({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'A title for the fixture.' }, { type: 'text', text }], stopReason: 'stop',
    provider: 'fake', model: 'fake-1', timestamp: Date.now(), usage: { input: 40, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 46 } } });
})();
`);
  return cli;
}

test('browser: AI programs, live — running now, the text as it is written, landing in the examples', { timeout: 120000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'programs-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'calls');
  fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify([
    // 1: stops after "File viewer".
    '<label>\nMedia\n</label>\n<title>\nFile viewer| fixture check\n</title>',
    // 2: a reply that cannot be read (no title), then 3: the answer asked again.
    '<label>\nMedia\n</label>\n<titl| oops',
    '<label>\nViewer\n</label>\n<title>\nSecond| try\n</title>',
  ]));
  const go = n => fs.writeFileSync(path.join(dir, 'go-' + n), '');
  const { evaluate, until, exceptions, base, auth } = await viewerBrowser(t, { env: { FUNCTAI_LOG_CALLS: folder, CHATTERING_PI_CLI: fakePi(dir) } });
  const text = sel => evaluate(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`);

  // The list, following: nothing has run yet.
  await evaluate(`Programs.showList()`);
  await until(`Programs.liveInfo().mode === 'on'`, 'the list follows the programs live');
  assert.equal(await evaluate(`document.querySelectorAll('.pg-live-item').length`), 0);

  // Chattering names a conversation: a program call, held half-way by the fake Pi.
  const retitle = fetch(base + '/api/conversation/retitle', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'pi:fixture/media.jsonl' }) });
  await until(`document.querySelector('.pg-live-item [data-live-tail]') && /File viewer/.test(document.querySelector('.pg-live-item [data-live-tail]').innerText)`, async () => 'the call shows while it is written: ' + JSON.stringify(await evaluate('Programs.liveInfo()')));
  const item = await text('.pg-live-item');
  assert.match(item, /conversation_title/);
  assert.match(item, /writing/);
  assert.match(item, /for File viewer fixture/, 'says what it is for: the conversation');
  assert.doesNotMatch(item, /fixture check/, 'only what is written so far');
  assert.match(await text('.pg-live-group h2'), /Running now/i);
  // The right panel says it too.
  await evaluate(`setRightView('programs')`);
  await until(`/first call is running/.test((document.querySelector('.pg-lib') || {}).innerText || '')`, 'the panel names the running program');
  await evaluate(`closeRightFiles()`);

  // Its page: it has never finished a call, so the page is its first call, open.
  await evaluate(`document.querySelector('.pg-live-item').click()`);
  await until(`/^File viewer/.test((document.querySelector('.pg-live-tr.open [data-live-field="title"]') || {}).textContent)`, 'the running call, opened, with the text so far');
  assert.match(await text('.pg-lede'), /first call is running/);
  assert.match(await text('.pg-live-open .pg-pair'), /File viewer fixture/, 'the input');
  assert.equal(await evaluate(`document.querySelector('[data-live-field="label"]').textContent`), 'Media');
  assert.doesNotMatch(await evaluate(`document.querySelector('[data-live-field="title"]').textContent`), /check/, 'held at the gate');
  assert.match(await text('.pg-live-open'), /provisional/);
  assert.match(await evaluate(`document.querySelector('[data-live-thinking]').textContent`), /A title for the fixture/);
  // Time passes on screen while it runs.
  const first = await evaluate(`document.querySelector('[data-live-since]').textContent`);
  await until(`document.querySelector('[data-live-since]') && document.querySelector('[data-live-since]').textContent !== ${JSON.stringify(first)}`, 'the elapsed time ticks');

  // The model finishes: the call lands in the examples, opened, to be judged.
  go(1);
  const res = await retitle;
  assert.equal(res.status, 200, await res.text());
  await until(`document.querySelector('.pg-tr.open[data-run]') && !document.querySelector('.pg-live-tr') && /File viewer fixture check/.test((document.querySelector('.pg-tr.open[data-run] .pg-pair') || {}).textContent || '') && /Is .*File viewer fixture check.* right/.test((document.querySelector('.pg-tr.open[data-run] .pg-ask') || {}).textContent || '')`, async () => 'the finished example replaces the live call: ' + JSON.stringify(await evaluate('Programs.liveInfo()')));
  assert.match(await text('.pg-tr.open[data-run] .pg-pair'), /File viewer fixture check/);
  assert.match(await text('.pg-tr.open[data-run] .pg-ask'), /Is .*File viewer fixture check.* right/);
  assert.equal(await evaluate(`document.querySelectorAll('.pg-live').length`), 0, 'nothing running');

  // Named again: the first reply cannot be read, so it is asked again. What
  // it wrote is wiped, and the page says why.
  const again = fetch(base + '/api/conversation/retitle', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'pi:fixture/media.jsonl' }) });
  await until(`document.querySelector('.pg-live-tr') && /Media/.test(document.querySelector('.pg-live-tr [data-live-tail]').innerText)`, 'the second call runs above the examples');
  assert.match(await text('.pg-live-title'), /Running now/i);
  await evaluate(`document.querySelector('.pg-live-tr .pg-row-line').click()`);
  await until(`document.querySelector('.pg-live-tr.open [data-live-field="label"]')`);
  go(2);
  await until(`/Asked again/.test((document.querySelector('.pg-live-open') || {}).innerText || '') && /Second/.test(document.querySelector('[data-live-field="title"]').textContent)`, 'asked again, the text so far replaced');
  assert.equal(await evaluate(`document.querySelector('[data-live-field="label"]').textContent`), 'Viewer', 'the first reply\'s text is gone');
  assert.match(await text('.pg-live-tr [data-live-state]'), /attempt 2/);
  go(3);
  assert.equal((await again).status, 200);
  await until(`!document.querySelector('.pg-live-tr') && /Second try/.test((document.querySelector('.pg-tr.open[data-run]') || {}).innerText || '')`, 'the retried call lands, opened');

  // Another writer's calls arrive unasked. A page on another program stays
  // as it is (a person may be reading it); its own program's call shows.
  const day = path.join(folder, new Date().toISOString().slice(0, 10));
  fs.mkdirSync(day, { recursive: true });
  let k = 0;
  const append = (name, module, answer) => {
    const cid = '01926a8e-000' + (++k) + '-7000-8000-000000000001';
    fs.appendFileSync(path.join(day, 'lambda-9-abcdef.jsonl'), JSON.stringify({
      functai_call: 1, id: cid, parent: null, root: cid, program: { name, kind: 'ai', module, version: 'sha256:' + 'a'.repeat(64), signature: 'sha256:' + '5'.repeat(64), answer: 'result' },
      started: new Date().toISOString(), seconds: 0.4, content: true, inputs: { text: 'Love it.' }, outputs: { result: answer }, sizes: { inputs: { text: 10 }, outputs: { result: 7 } },
      error: null, model: 'gpt-4.1-mini', usage: { input_tokens: 20, output_tokens: 2 }, exchanges: [], caller: {}, process: { host: 'lambda', pid: 9, user: 'someone', language: 'python' },
    }) + '\n');
  };
  await evaluate(`document.querySelector('.pg-view').dataset.still = '1'`);
  const seqBefore = await evaluate(`Programs.liveInfo().seq`);
  append('mood', 'reviews', 'happy');
  await until(`Programs.liveInfo().seq !== ${JSON.stringify(seqBefore)}`, 'the log moved');
  await new Promise(r => setTimeout(r, 400));
  assert.equal(await evaluate(`(document.querySelector('.pg-view') || {}).dataset?.still`), '1', 'another program\'s call leaves this page as it is');
  append('conversation_title', 'chattering', 'Another title');
  await until(`/Another title/.test(document.querySelector('.pg-table:not(.pg-live-table)').innerText)`, 'this program\'s own new call shows without a reload');

  // The list shows the other writer's program too, unasked.
  await evaluate(`Programs.showList()`);
  await until(`document.querySelectorAll('.pg-card').length === 2`);
  append('tone', 'reviews', 'warm');
  await until(`document.querySelectorAll('.pg-card').length === 3`, 'a call from another writer shows without a reload');

  // Leaving the pages stops following.
  await evaluate(`location.hash = ''`);
  await until(`typeof viewKind !== 'undefined' && viewKind !== 'programs' && Programs.liveInfo().mode === 'off'`, 'following stops off the pages');
  assert.deepEqual(exceptions, []);
});
