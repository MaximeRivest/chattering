'use strict';
// Work steps in plain words, in the real app (a fake Pi answers):
// - a finished group on screen: each step's phrase (one small call per step,
//   side by side), then the group's sentence from the phrases, streamed in;
// - work being done now: a step is explained as soon as it has finished, in
//   the saved group at the end of the conversation and in the run's live
//   group, whose line shows the latest phrase; no sentence while it runs;
// - "show commands" / "plain words" switch this screen, without a new call,
//   and a reload reuses what the server remembers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');
const { chromiumAvailable } = require('./helpers/chromium.js');

// Answers by program (the system prompt names it) and by step; writes a few
// characters at a time. The sentence stops at "|" until the test writes go.
function fakePi(dir) {
  const cli = path.join(dir, 'fake-pi.js');
  fs.writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const system = fs.readFileSync(args[args.indexOf('--system-prompt') + 1], 'utf8');
const input = fs.readFileSync(0, 'utf8');
const program = /^Function: (\\w+)/m.exec(system)[1];
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.log'))}, JSON.stringify({ program, args, input, at: Date.now() }) + '\\n');
const phrase = /\\bthought:/.test(input) ? 'Worked out where to start looking' : /grep/.test(input) ? 'Searched the code for the startup part'
  : /npm test/.test(input) ? 'Ran the checks' : 'Opened the main server file';
const script = program === 'step_in_plain_words' ? '<phrase>\\n' + phrase + '\\n</phrase>'
  : '<summary>\\nLooked through the code| to find why the app starts slowly.\\n</summary>';
const hold = script.indexOf('|'), text = script.replace('|', '');
const say = e => process.stdout.write(JSON.stringify(e) + '\\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < text.length;) {
    if (i === hold && !fs.existsSync(${JSON.stringify(path.join(dir, 'go'))})) { await sleep(30); continue; }
    const end = Math.min(i + 5, hold >= 0 && i < hold ? hold : text.length);
    say({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text.slice(i, end) } });
    i = end; await sleep(4);
  }
  say({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop',
    provider: 'fake', model: 'small-1', timestamp: Date.now(), usage: { input: 300, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 320 } } });
})();
`);
  return cli;
}

test('browser: work steps in plain words, step by step, then the sentence; switched per screen; remembered', { timeout: 120000 }, async t => {
  if (!chromiumAvailable()) return t.skip('chromium is not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-steps-app-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = () => { try { return fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  const setup = home => {
    const file = path.join(home, '.config', 'chattering', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ settingsVersion: require('../settings.js').SETTINGS_VERSION, plainSteps: { on: true, provider: 'fake', model: 'small-1' } }));
    const ts = s => '2026-09-01T12:00:' + String(s).padStart(2, '0') + 'Z';
    const msg = (id, parentId, s, message) => ({ type: 'message', id, parentId, timestamp: ts(s), message });
    const lines = [
      { type: 'session', version: 3, id: 'work', cwd: path.join(home, 'work') },
      msg('u1', null, 1, { role: 'user', content: [{ type: 'text', text: 'Why does the app open slowly?' }] }),
      msg('a1', 'u1', 2, { role: 'assistant', provider: 'p', model: 'big', content: [
        { type: 'thinking', thinking: 'I should look at the startup code first.' },
        { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'grep -rn "startup" server.js' } },
        { type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: 'server.js' } },
      ] }),
      msg('r1', 'a1', 3, { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: '12: startup()' }], isError: false }),
      msg('r2', 'r1', 4, { role: 'toolResult', toolCallId: 'call-2', toolName: 'read', content: [{ type: 'text', text: 'const x = 1;' }], isError: false }),
      msg('a2', 'r2', 5, { role: 'assistant', provider: 'p', model: 'big', content: [{ type: 'text', text: 'It reads every conversation at start.' }] }),
    ];
    fs.writeFileSync(path.join(home, '.pi/agent/sessions/fixture/work.jsonl'), lines.map(JSON.stringify).join('\n') + '\n');
    // A second conversation whose run is still going: one command saved with
    // its result at the end of it, the next one still running.
    fs.writeFileSync(path.join(home, '.pi/agent/sessions/fixture/busy.jsonl'), [
      { type: 'session', version: 3, id: 'busy', cwd: path.join(home, 'work') },
      msg('q1', null, 10, { role: 'user', content: [{ type: 'text', text: 'Do the tests pass?' }] }),
      msg('b1', 'q1', 11, { role: 'assistant', provider: 'p', model: 'big', content: [{ type: 'toolCall', id: 'call-t', name: 'bash', arguments: { command: 'npm test' } }] }),
      msg('b2', 'b1', 12, { role: 'toolResult', toolCallId: 'call-t', toolName: 'bash', content: [{ type: 'text', text: '12 passed' }], isError: false }),
    ].map(JSON.stringify).join('\n') + '\n');
  };
  const { evaluate, until, exceptions, command, base, token } = await viewerBrowser(t, { setup, env: { CHATTERING_PI_CLI: fakePi(dir) } });
  const key = 'pi:fixture/work.jsonl';
  await until(`typeof settingsOf === 'function' && settingsOf().plainSteps && settingsOf().plainSteps.on`, 'settings loaded');
  await evaluate(`open(${JSON.stringify(key)})`);
  await until(`document.querySelector('.toolgroup[data-gkey]')`, 'the steps');
  await evaluate(`document.querySelector('.toolgroup').open = true`);

  // A finished group: its three steps, each in a call of its own, side by
  // side; then its sentence, streamed in (held half-way by the fake Pi).
  await until(`document.querySelector('.toolgroup .tg-detail.tg-writing')?.textContent === 'Looked through the code'`, async () => 'no sentence: ' + JSON.stringify(calls().map(c => c.program)));
  const steps = calls().filter(c => c.program === 'step_in_plain_words');
  assert.equal(steps.length, 3);
  assert.ok(Math.max(...steps.map(c => c.at)) - Math.min(...steps.map(c => c.at)) < 1500, 'started together');
  const summaryCall = calls().find(c => c.program === 'steps_summary_in_plain_words');
  assert.match(summaryCall.input, /1\. Worked out where to start looking\n2\. Searched the code for the startup part\n3\. Opened the main server file/);
  assert.doesNotMatch(summaryCall.input, /grep/, 'the sentence reads the phrases, not the commands');
  const call = steps.find(c => /grep/.test(c.input));
  assert.deepEqual(call.args.slice(call.args.indexOf('--thinking'), call.args.indexOf('--thinking') + 2), ['--thinking', 'off']);
  assert.ok(call.args.includes('--provider') && call.args.includes('fake') && call.args.includes('small-1'), call.args.join(' '));
  assert.match(call.input, /Why does the app open slowly\?/);
  assert.doesNotMatch(call.input, /It reads every conversation at start/, 'the answer itself is not sent');
  const rows = await evaluate(`[...document.querySelectorAll('.toolgroup [data-step]')].map(el => [el.dataset.step, el.querySelector('.step-plain')?.textContent, getComputedStyle(el.querySelector('.step-tech')).display !== 'none'])`);
  assert.deepEqual(rows, [
    ['k:a1', 'Worked out where to start looking', false],
    ['t:call-1', 'Searched the code for the startup part', false],
    ['t:call-2', 'Opened the main server file', false],
  ]);
  assert.match(await evaluate(`document.querySelector('.toolgroup [data-step="t:call-1"] .step-plain').title`), /bash · grep -rn "startup" server\.js/);
  fs.writeFileSync(path.join(dir, 'go'), '');
  await until(`document.querySelector('.toolgroup .tg-detail').textContent === 'Looked through the code to find why the app starts slowly.' && !document.querySelector('.tg-writing')`, 'the whole sentence');
  assert.equal(calls().length, 4);

  // This screen back to the commands, and to plain words again: no new call.
  await evaluate(`document.querySelector('.tg-plain-switch').click()`);
  await until(`!document.querySelector('.step-plain') && document.querySelector('.tg-plain-switch')?.textContent === 'plain words'`, 'technical view');
  assert.match(await evaluate(`document.querySelector('.toolgroup .tg-detail').textContent`), /thinking · bash · read/);
  assert.equal(await evaluate(`document.querySelector('.toolgroup').open`), true, 'the switch does not fold the group');
  await evaluate(`document.querySelector('.tg-plain-switch').click()`);
  await until(`document.querySelectorAll('.step-plain').length === 3 && document.querySelector('.tg-plain')`, 'plain again');

  // A reload: the server remembers.
  await command('Page.navigate', { url: base + '/?token=' + token });
  await until(`typeof open === 'function' && typeof settingsOf === 'function' && settingsOf().plainSteps`);
  await evaluate(`open(${JSON.stringify(key)})`);
  await until(`document.querySelector('.toolgroup .tg-detail.tg-plain')?.textContent.startsWith('Looked through the code to find')`, 'plain after reload');
  assert.equal(calls().length, 4);

  // Work being done: a run in progress. Its first command has finished; the
  // next one is still running.
  const busy = 'pi:fixture/busy.jsonl';
  const runEvent = tail => evaluate(`live.onmessage({ data: ${JSON.stringify(JSON.stringify({ type: 'run-event', jobId: 'run:e2e1', key: busy, status: 'running', statusText: 'running', startedAt: Date.now(), node: 'b2', model: 'p/big' }))}.replace('"model"', '"tail":' + ${JSON.stringify(JSON.stringify(tail))} + ',"model"') }); 1`);
  await runEvent([
    { id: 1, kind: 'tool', callId: 'call-t', name: 'bash', args: 'npm test', out: '12 passed', phase: 'done' },
    { id: 2, kind: 'tool', callId: 'call-u', name: 'bash', args: 'npm run lint', out: '', phase: 'running' },
  ]);
  // Opened once the page knows the run: its saved group is work being done.
  await evaluate(`open(${JSON.stringify(busy)})`);
  await until(`current && current.key === ${JSON.stringify(busy)} && document.querySelector('.toolgroup[data-gkey]')`, 'the busy conversation');
  await until(`document.querySelector('.toolgroup[data-gkey] [data-step="t:call-t"] .step-plain')?.textContent === 'Ran the checks'`, async () => 'the finished step: ' + JSON.stringify(calls().map(c => c.program)));
  // The live group's line: the latest phrase; its finished row, the phrase.
  await until(`document.querySelector('.toolgroup[data-live-work] .tg-detail')?.textContent === 'Ran the checks'`, async () => 'live line: ' + await evaluate(`document.querySelector('#liveReplies')?.innerHTML.slice(0, 1200)`));
  await evaluate(`document.querySelector('.toolgroup[data-live-work]').open = true`);
  await until(`document.querySelector('.toolgroup[data-live-work] .ls-b[data-step="t:call-t"] .ls-plain')?.textContent === 'Ran the checks'`, 'live row');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ls-b[data-step="t:call-u"] .ls-b-head')).display !== 'none'`), true, 'the running command stays as it is');
  await new Promise(r => setTimeout(r, 600));
  const since = calls().slice(4).map(c => c.program);
  assert.deepEqual(since, ['step_in_plain_words'], 'one step call; no sentence while the work goes on');
  assert.deepEqual(exceptions, []);
});
