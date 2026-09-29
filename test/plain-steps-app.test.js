'use strict';
// Work steps in plain words, in the real app: with the setting on, a group of
// steps on screen gets its sentence and each step its phrase from one model
// call (a fake Pi here); "show commands" brings the technical lines back on
// this screen, "plain words" brings the explanation back without asking the
// model again, and a reload reuses the remembered answer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');
const { chromiumAvailable } = require('./helpers/chromium.js');

function fakePi(dir) {
  const cli = path.join(dir, 'fake-pi.js');
  fs.writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs');
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.log'))}, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');
const text = '<summary>\\nLooked through the code to find why the app starts slowly.\\n</summary>\\n<phrases>\\n' +
  JSON.stringify([{ n: 1, plain: 'Worked out where to start looking' }, { n: 2, plain: 'Searched the code for the startup part' }, { n: 3, plain: 'Opened the main server file' }]) + '\\n</phrases>';
process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop',
  provider: 'fake', model: 'small-1', timestamp: Date.now(), usage: { input: 300, output: 60, cacheRead: 0, cacheWrite: 0, totalTokens: 360 } } }) + '\\n');
`);
  return cli;
}

test('browser: work steps in plain words, switched per screen, remembered', { timeout: 120000 }, async t => {
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
      msg('r2', 'r1', 4, { role: 'toolResult', toolCallId: 'call-2', toolName: 'read', content: [{ type: 'text', text: 'const x = 1;' }], isError: false }),
      msg('a2', 'r2', 5, { role: 'assistant', provider: 'p', model: 'big', content: [{ type: 'text', text: 'It reads every conversation at start.' }] }),
    ].map(JSON.stringify).join('\n') + '\n');
  };
  const { evaluate, until, exceptions, command, base, token } = await viewerBrowser(t, { setup, env: { CHATTERING_PI_CLI: fakePi(dir) } });
  const key = 'pi:fixture/work.jsonl';
  await until(`typeof settingsOf === 'function' && settingsOf().plainSteps && settingsOf().plainSteps.on`, 'settings loaded');
  await evaluate(`open(${JSON.stringify(key)})`);
  await until(`document.querySelector('.toolgroup[data-gkey] .tg-detail.tg-plain')`, async () => 'no plain sentence: ' + JSON.stringify(calls()));
  assert.equal(await evaluate(`document.querySelector('.toolgroup .tg-detail').textContent`), 'Looked through the code to find why the app starts slowly.');
  assert.equal(calls().length, 1, 'one call for the group');
  const call = calls()[0];
  // The model chosen for it, thinking off, and only this group's content.
  assert.deepEqual(call.args.slice(call.args.indexOf('--thinking'), call.args.indexOf('--thinking') + 2), ['--thinking', 'off']);
  assert.ok(call.args.includes('--provider') && call.args.includes('fake') && call.args.includes('small-1'), call.args.join(' '));
  assert.match(call.input, /Why does the app open slowly\?/);
  assert.match(call.input, /\[2\] bash\ngiven: grep -rn "startup" server\.js\ncame back: 12: startup\(\)/);
  assert.doesNotMatch(call.input, /It reads every conversation at start/, 'the answer itself is not sent');

  // Open the group: each step carries its phrase; the command is hidden, not gone.
  await evaluate(`document.querySelector('.toolgroup').open = true`);
  const steps = await evaluate(`[...document.querySelectorAll('.toolgroup [data-step]')].map(el => ({ step: el.dataset.step, plain: el.querySelector('.step-plain')?.textContent, techShown: getComputedStyle(el.querySelector('.step-tech')).display !== 'none', title: el.querySelector('.step-plain')?.title }))`);
  assert.deepEqual(steps.map(s => [s.step, s.plain, s.techShown]), [
    ['k:a1', 'Worked out where to start looking', false],
    ['t:call-1', 'Searched the code for the startup part', false],
    ['t:call-2', 'Opened the main server file', false],
  ]);
  assert.match(steps[1].title, /bash · grep -rn "startup" server\.js/);

  // This screen back to the commands, and to plain words again: no new call.
  await evaluate(`document.querySelector('.tg-plain-switch').click()`);
  await until(`!document.querySelector('.step-plain') && document.querySelector('.tg-plain-switch')?.textContent === 'plain words'`, 'technical view');
  assert.match(await evaluate(`document.querySelector('.toolgroup .tg-detail').textContent`), /thinking · bash · read/);
  assert.equal(await evaluate(`document.querySelector('.toolgroup').open`), true, 'the switch does not fold the group');
  await evaluate(`document.querySelector('.tg-plain-switch').click()`);
  await until(`document.querySelectorAll('.step-plain').length === 3`, 'plain again');

  // A reload: the server remembers; still one call.
  await command('Page.navigate', { url: base + '/?token=' + token });
  await until(`typeof open === 'function' && typeof settingsOf === 'function' && settingsOf().plainSteps`);
  await evaluate(`open(${JSON.stringify(key)})`);
  await until(`document.querySelector('.toolgroup .tg-detail.tg-plain')`, 'plain after reload');
  assert.equal(calls().length, 1);
  assert.deepEqual(exceptions, []);
});
