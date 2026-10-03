'use strict';
// Hotkeys (design/93) in the real app and server, with a fake Pi: a person
// adds the grammar starter in settings → hotkeys (its program is made and
// published), a computer asks for a code, the page opened at
// #hotkeys-connect=CODE links it, the computer's credential lists the
// hotkeys and runs the program, and opens nothing else; unlinked, it opens
// nothing at all. The helper's own press runs against this server too.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

// A Pi that proofreads by fixing one sentence, in FunctAI's reply form.
function fakePi(dir) {
  const cli = path.join(dir, 'fake-pi.js');
  fs.writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const sp = args.indexOf('--system-prompt');
const system = sp >= 0 ? fs.readFileSync(args[sp + 1], 'utf8') : '';
const input = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(path.join(dir, 'pi-calls.jsonl'))}, JSON.stringify({ system, input, args }) + '\\n');
const text = system.startsWith('Function: fix_writing')
  ? '<fixed_text>\\n' + (/i has went/.test(input) ? 'I went to the store.' : 'unchanged') + '\\n</fixed_text>'
  : '<result>\\nok\\n</result>';
process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop',
  provider: 'fake', model: 'fake-1', timestamp: Date.now(), usage: { input: 40, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 46 } } }) + '\\n');
`);
  return cli;
}

test('browser: a starter hotkey, a computer linked by its code, a press answered', { timeout: 150000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotkeys-app-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { evaluate, until, exceptions, base, auth } = await viewerBrowser(t, { env: { FUNCTAI_LOG_CALLS: path.join(dir, 'calls'), CHATTERING_PI_CLI: fakePi(dir) } });
  const click = sel => evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const text = sel => evaluate(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`);
  const call = async (p, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const piCalls = () => { try { return fs.readFileSync(path.join(dir, 'pi-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };

  // Settings → hotkeys: nothing yet, three starters.
  await until(`window.appBooted`, 'the app\'s first screen');
  await evaluate(`location.hash = '#settings=hotkeys'`);
  await until(`document.querySelector('[data-starter="fix_writing"]')`, 'the starters');
  assert.match(await text('#hkRoot'), /No computer runs your hotkeys yet/);

  // The grammar starter: its program made and published, and a hotkey for it.
  await click('[data-starter="fix_writing"]');
  await until(`document.querySelector('.hk-row')`, 'the new hotkey');
  assert.match(await text('.hk-row'), /Super \+ Ctrl \+ G/);
  assert.match(await text('.hk-row'), /Fix spelling and grammar/);
  const view = (await call('/api/hotkeys', { headers: auth })).body;
  assert.equal(view.bindings.length, 1);
  assert.equal(view.programs.find(p => p.name === 'fix_writing').live, true, 'its program is published');
  assert.equal(view.programs.find(p => p.name === 'fix_writing').field, 'text');

  // A computer asks for a code; without one, nothing opens.
  assert.equal((await call('/api/hotkeys/device?since=-1')).status, 401);
  assert.equal((await call('/api/hotkeys/device?since=-1', { headers: { Authorization: 'Bearer chk_guess' } })).status, 401);
  const pair = (await call('/api/hotkeys/pair', { method: 'POST', body: { name: 'testbox', os: 'linux', desktop: 'Hyprland' } })).body;
  assert.match(pair.code, /^....-....$/);
  assert.equal((await call('/api/hotkeys/pair/poll', { method: 'POST', body: { pairing: pair.pairing } })).body.state, 'waiting');

  // The page the computer opens: the code, the computer, and a choice.
  await evaluate(`location.hash = '#hotkeys-connect=${pair.code}'`);
  await until(`document.querySelector('#hkApprove')`, 'the approval');
  assert.match(await text('.hk-approve'), /testbox/);
  assert.match(await text('.hk-approve'), new RegExp(pair.code));
  await click('#hkApprove');
  await until(`/is linked/.test(document.querySelector('#hkRoot').innerText)`, 'linked');

  // The computer gets its credential once.
  const linked = (await call('/api/hotkeys/pair/poll', { method: 'POST', body: { pairing: pair.pairing } })).body;
  assert.equal(linked.state, 'linked');
  const device = { Authorization: 'Bearer ' + linked.credential };
  const mine = (await call('/api/hotkeys/device?since=-1', { headers: device })).body;
  assert.equal(mine.bindings.length, 1);
  assert.equal(mine.bindings[0].label, 'Fix spelling and grammar');
  assert.equal(mine.bindings[0].keys, 'Super+Ctrl+G');

  // Its credential opens the hotkey routes and nothing else.
  assert.equal((await call('/api/settings', { headers: device })).status, 401);
  assert.equal((await call('/api/hotkeys', { headers: device })).status, 401);
  assert.equal((await call('/programs/fix_writing', { method: 'POST', body: { text: 'x' }, headers: device })).status, 401);

  // A press: the text through the program, its answer back as text, logged as a hotkey call.
  const answered = await call('/api/hotkeys/device/run', { method: 'POST', body: { id: mine.bindings[0].id, text: 'i has went to the store' }, headers: device });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.text, 'I went to the store.');
  assert.equal(answered.body.program, 'fix_writing');
  const last = piCalls().at(-1);
  assert.match(last.input, /i has went to the store/);
  assert.equal(last.args[last.args.indexOf('--thinking') + 1], 'off', 'thinking off for hotkeys');
  const runs = (await call('/api/programs/runs?name=fix_writing&module=programs', { headers: auth })).body;
  const rows = runs.runs || runs.rows || runs;
  assert.ok(JSON.stringify(rows).includes('hotkey'), 'the call shows on the program\u2019s page, from a hotkey');

  // Refused before any model: nothing to work on, a hotkey that is not there.
  const n = piCalls().length;
  assert.equal((await call('/api/hotkeys/device/run', { method: 'POST', body: { id: mine.bindings[0].id, text: '   ' }, headers: device })).status, 400);
  assert.equal((await call('/api/hotkeys/device/run', { method: 'POST', body: { id: 'nothere', text: 'x' }, headers: device })).status, 404);
  assert.equal(piCalls().length, n);

  // The computer reports what its desktop did; the page shows it.
  await call('/api/hotkeys/device/status', { method: 'POST', body: { desktop: 'Hyprland', supported: true, report: [{ id: mine.bindings[0].id, state: 'on' }] }, headers: device });
  await evaluate(`location.hash = '#settings=profile'`);
  await evaluate(`location.hash = '#settings=hotkeys'`);
  await until(`/1 hotkey live/.test((document.querySelector('[data-computer]') || {}).innerText || '')`, 'the computer\u2019s report');
  assert.match(await text('.hk-row'), /● testbox/);

  // A change on the page reaches the computer's long poll at once.
  const waiting = call(`/api/hotkeys/device?since=${mine.version}&wait=20`, { headers: device });
  await new Promise(r => setTimeout(r, 300));
  await evaluate(`document.querySelector('.hk-row [data-on]').click()`);
  const woke = await waiting;
  assert.equal(woke.body.bindings.length, 0, 'the hotkey turned off');

  // Unlinked on the page: its credential opens nothing.
  await evaluate(`window.confirm = () => true`);
  await until(`document.querySelector('[data-forget]')`);
  await click('[data-forget]');
  await until(`!document.querySelector('[data-computer]')`, 'unlinked');
  assert.equal((await call('/api/hotkeys/device?since=-1', { headers: device })).status, 401);
  assert.deepEqual(exceptions, []);
});
