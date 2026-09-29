'use strict';
// Work steps in plain words, in the real app (a fake Pi answers):
// - a finished group: above each command, its sentence (one small call per
//   step, side by side), typed in; the commands stay; the group's folded line
//   changes once, when its sentence is complete; no switch to go back;
// - a reload reuses what the server remembers;
// - work being done now: the live group opens, and its steps come one at a
//   time, each sentence typed in above its command before the next step shows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');
const { chromiumAvailable } = require('./helpers/chromium.js');

// Answers by program (the system prompt names it) and by step; writes a few
// characters at a time. A reply stops at "|" until the test writes its gate.
function fakePi(dir) {
  const cli = path.join(dir, 'fake-pi.js');
  fs.writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const system = fs.readFileSync(args[args.indexOf('--system-prompt') + 1], 'utf8');
const input = fs.readFileSync(0, 'utf8');
const program = /^Function: (\\w+)/m.exec(system)[1];
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.log'))}, JSON.stringify({ program, args, input, at: Date.now() }) + '\\n');
const [phrase, gate] = /\\bthought:/.test(input) ? ['Deciding where to look first: thinking about the startup code.']
  : /grep/.test(input) ? ['Finding where the app starts: searching the code for the word startup.']
  : /npm test/.test(input) ? ['Checking nothing broke:| running the project tests.', 'go-tests']
  : ['Reading the main server file to see how it starts.'];
const [script, gateFile] = program === 'step_in_plain_words' ? ['<phrase>\\n' + phrase + '\\n</phrase>', gate]
  : ['<summary>\\nLooked through the code| to find why the app starts slowly.\\n</summary>', 'go-summary'];
const hold = script.indexOf('|'), text = script.replace('|', '');
const say = e => process.stdout.write(JSON.stringify(e) + '\\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < text.length;) {
    if (i === hold && !fs.existsSync(${JSON.stringify(dir)} + '/' + gateFile)) { await sleep(30); continue; }
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

test('browser: work steps in plain words above their commands; live steps one at a time', { timeout: 120000 }, async t => {
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
    fs.writeFileSync(path.join(home, '.pi/agent/sessions/fixture/work.jsonl'), [
      { type: 'session', version: 3, id: 'work', cwd: path.join(home, 'work') },
      msg('u1', null, 1, { role: 'user', content: [{ type: 'text', text: 'Why does the app open slowly?' }] }),
      msg('a1', 'u1', 2, { role: 'assistant', provider: 'p', model: 'big', content: [
        { type: 'thinking', thinking: 'I should look at the startup code first.' },
        { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'grep -rn "startup" server.js' } },
        { type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: 'server.js' } },
      ] }),
      msg('r1', 'a1', 3, { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: '12: startup()' }], isError: false }),
      msg('r2', 'r1', 4, { role: 'toolResult', toolCallId: 'call-2', toolName: 'read', content: [{ type: 'text', text: 'const secret = 1;' }], isError: false }),
      msg('a2', 'r2', 5, { role: 'assistant', provider: 'p', model: 'big', content: [{ type: 'text', text: 'It reads every conversation at start.' }] }),
    ].map(JSON.stringify).join('\n') + '\n');
    // A conversation whose run is still going: one command saved.
    fs.writeFileSync(path.join(home, '.pi/agent/sessions/fixture/busy.jsonl'), [
      { type: 'session', version: 3, id: 'busy', cwd: path.join(home, 'work') },
      msg('q1', null, 10, { role: 'user', content: [{ type: 'text', text: 'Do the tests pass?' }] }),
      msg('b1', 'q1', 11, { role: 'assistant', provider: 'p', model: 'big', content: [{ type: 'toolCall', id: 'call-t', name: 'bash', arguments: { command: 'npm test' } }] }),
    ].map(JSON.stringify).join('\n') + '\n');
  };
  const { evaluate, until, exceptions, command, base, token } = await viewerBrowser(t, { setup, env: { CHATTERING_PI_CLI: fakePi(dir) } });
  const key = 'pi:fixture/work.jsonl';
  await until(`typeof settingsOf === 'function' && settingsOf().plainSteps && settingsOf().plainSteps.on`, 'settings loaded');
  await evaluate(`open(${JSON.stringify(key)})`);
  await until(`document.querySelector('.toolgroup[data-gkey]')`, 'the steps');
  await evaluate(`document.querySelector('.toolgroup').open = true`);

  // Each step's sentence, above its command; the commands stay.
  const rows = () => evaluate(`[...document.querySelectorAll('.toolgroup [data-step]')].map(el => ({ step: el.dataset.step,
    say: el.querySelector('.step-say')?.textContent, command: getComputedStyle(el.querySelector('.step-tech')).display !== 'none' && el.querySelector('.step-tech').textContent }))`);
  await until(`[...document.querySelectorAll('.toolgroup .step-say')].filter(s => s.textContent.endsWith('.') && !s.classList.contains('typing')).length === 3`, async () => 'sentences: ' + JSON.stringify(await rows()) + JSON.stringify(calls().map(c => c.program)));
  const r = await rows();
  assert.deepEqual(r.map(x => x.say), [
    'Deciding where to look first: thinking about the startup code.',
    'Finding where the app starts: searching the code for the word startup.',
    'Reading the main server file to see how it starts.',
  ]);
  assert.match(r[1].command, /bash · grep -rn "startup" server\.js/, 'the command is still there');
  assert.ok(r.every(x => x.command), 'every command stays');
  assert.equal(await evaluate(`document.querySelector('.tg-plain-switch')`), null, 'no switch: the setting is on or off');
  const steps = calls().filter(c => c.program === 'step_in_plain_words');
  assert.equal(steps.length, 3);
  assert.ok(Math.max(...steps.map(c => c.at)) - Math.min(...steps.map(c => c.at)) < 1500, 'side by side');
  const grep = steps.find(c => /grep/.test(c.input));
  assert.match(grep.input, /I should look at the startup code first/, 'the thought before it, for its why');
  assert.doesNotMatch(calls().map(c => c.input).join('\n'), /startup\(\)|const secret/, 'no command result reaches the model');
  assert.deepEqual(grep.args.slice(grep.args.indexOf('--thinking'), grep.args.indexOf('--thinking') + 2), ['--thinking', 'off']);
  assert.ok(grep.args.includes('fake') && grep.args.includes('small-1'), grep.args.join(' '));

  // The group's sentence is being written (held half-way): its line does not
  // move until the sentence is complete, then changes once.
  for (let i = 0; i < 40 && !calls().some(c => c.program === 'steps_summary_in_plain_words'); i++) await new Promise(r => setTimeout(r, 50));
  const summaryCall = calls().find(c => c.program === 'steps_summary_in_plain_words');
  assert.ok(summaryCall, 'the sentence was asked for');
  assert.doesNotMatch(summaryCall.input, /grep -rn/, 'it reads the sentences, not the commands');
  await new Promise(r => setTimeout(r, 400));
  assert.equal(await evaluate(`document.querySelector('.toolgroup .tg-detail').textContent`), 'thinking · bash · read');
  fs.writeFileSync(path.join(dir, 'go-summary'), '');
  await until(`document.querySelector('.toolgroup .tg-detail').textContent === 'Looked through the code to find why the app starts slowly.'`, 'the whole sentence');
  assert.equal(calls().length, 4);

  // A reload: the server remembers; the sentences are simply there.
  await command('Page.navigate', { url: base + '/?token=' + token });
  await until(`typeof open === 'function' && typeof settingsOf === 'function' && settingsOf().plainSteps`);
  await evaluate(`open(${JSON.stringify(key)})`);
  await until(`document.querySelector('.toolgroup .tg-detail.tg-plain') && document.querySelectorAll('.toolgroup .step-say').length === 3 && [...document.querySelectorAll('.toolgroup .step-say')].every(s => s.textContent.length > 20)`, 'plain after reload');
  assert.equal(calls().length, 4);

  // Work being done: the run's first command is written and running; the
  // second is written too. The live group opens; the second step waits until
  // the first one's sentence is typed out.
  const busy = 'pi:fixture/busy.jsonl';
  const runEvent = tail => {
    const ev = { type: 'run-event', jobId: 'run:e2e1', key: busy, status: 'running', statusText: 'running', startedAt: Date.now(), node: 'b1', model: 'p/big', tail };
    return evaluate(`live.onmessage({ data: ${JSON.stringify(JSON.stringify(ev))} }); 1`);
  };
  await runEvent([
    { id: 1, kind: 'tool', callId: 'call-t', name: 'bash', args: 'npm test', out: '', phase: 'running' },
    { id: 2, kind: 'tool', callId: 'call-u', name: 'bash', args: 'npm run lint', out: '', phase: 'ready' },
  ]);
  await evaluate(`open(${JSON.stringify(busy)})`);
  await until(`document.querySelector('.toolgroup[data-live-work]')?.open`, async () => 'the live group opens: ' + await evaluate(`document.getElementById('liveReplies')?.innerHTML.slice(0, 800)`));
  const liveRows = () => evaluate(`[...document.querySelectorAll('.toolgroup[data-live-work] .ls-b[data-step]')].map(el => ({ step: el.dataset.step, hidden: el.hidden,
    say: el.querySelector('.step-say')?.textContent, cmd: el.querySelector('.step-cmd')?.textContent, state: el.querySelector('.step-state')?.textContent,
    folded: !el.querySelector('.step-more')?.open }))`);
  await until(`document.querySelector('.toolgroup[data-live-work] .ls-b[data-step="t:call-t"] .step-say')?.textContent === 'Checking nothing broke:'`, async () => 'first sentence: ' + JSON.stringify(await liveRows()));
  const half = await liveRows();
  assert.deepEqual(half.map(x => [x.step, x.hidden]), [['t:call-t', false], ['t:call-u', true]], 'the next step waits for this sentence');
  // Under the sentence, one quiet line: the command and how it goes; the
  // rest (the command box, what came back) is folded behind it.
  assert.deepEqual([half[0].cmd, half[0].state, half[0].folded], ['npm test', '● running', true]);
  assert.equal(await evaluate(`document.querySelector('.ls-b[data-step="t:call-t"] .step-more .st-preview') !== null`), true, 'the technical view is inside');
  await evaluate(`document.querySelector('.ls-b[data-step="t:call-t"] .step-line').click()`);
  await until(`document.querySelector('.ls-b[data-step="t:call-t"] .step-more').open && document.querySelector('.ls-b[data-step="t:call-t"] .st-preview').innerText.includes('npm test')`, 'one click opens it');
  fs.writeFileSync(path.join(dir, 'go-tests'), '');
  await until(`document.querySelector('.ls-b[data-step="t:call-u"]') && !document.querySelector('.ls-b[data-step="t:call-u"]').hidden`, async () => 'the next step: ' + JSON.stringify(await liveRows()));
  assert.equal(await evaluate(`document.querySelector('.ls-b[data-step="t:call-t"] .step-say').textContent`), 'Checking nothing broke: running the project tests.');
  assert.deepEqual(exceptions, []);
});
