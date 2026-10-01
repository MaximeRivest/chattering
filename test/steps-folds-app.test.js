'use strict';
// Boxes of steps, in the real app: closed unless a person opens one, and
// opening one opens only that one.
// - each box has its own name, also when one saved entry holds thinking,
//   words and calls that land in two boxes (they once shared one, so opening
//   one opened the other);
// - what the app opens by itself (a script, X, a search, a return) lasts for
//   the visit; only a person's click is kept for next time; any close forgets;
// - work in the transcript comes in closed, whatever is open above it;
//   the bottom live monitor opens everything without changing the transcript;
// - the open live stream belongs to its run: the next run starts it closed;
// - the keyboard help names x / X where a conversation's keys are listed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');
const { chromiumAvailable } = require('./helpers/chromium.js');

test('browser: boxes of steps open only when a person opens them, one at a time', { timeout: 120000 }, async t => {
  if (!chromiumAvailable()) return t.skip('chromium is not installed');
  const setup = home => {
    const ts = s => '2026-09-01T12:00:' + String(s).padStart(2, '0') + 'Z';
    const msg = (id, parentId, s, message) => ({ type: 'message', id, parentId, timestamp: ts(s), message });
    fs.writeFileSync(path.join(home, '.pi/agent/sessions/fixture/folds.jsonl'), [
      { type: 'session', version: 3, id: 'folds', cwd: path.join(home, 'work') },
      msg('u1', null, 1, { role: 'user', content: [{ type: 'text', text: 'Why is it slow?' }] }),
      // One entry: a thought, words to the reader, then a call. The thought
      // is one box, the call starts another.
      msg('a1', 'u1', 2, { role: 'assistant', provider: 'p', model: 'big', content: [
        { type: 'thinking', thinking: 'Where to start.' },
        { type: 'text', text: 'Let me look at the code.' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
      ] }),
      msg('r1', 'a1', 3, { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'server.js' }], isError: false }),
      msg('a2', 'r1', 4, { role: 'assistant', provider: 'p', model: 'big', content: [{ type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'server.js' } }] }),
      msg('r2', 'a2', 5, { role: 'toolResult', toolCallId: 'c2', toolName: 'read', content: [{ type: 'text', text: 'startup()' }], isError: false }),
      msg('a3', 'r2', 6, { role: 'assistant', provider: 'p', model: 'big', content: [{ type: 'text', text: 'It reads everything at start.' }] }),
    ].map(JSON.stringify).join('\n') + '\n');
  };
  const { evaluate, until, exceptions, command, base, token } = await viewerBrowser(t, { setup });
  const key = 'pi:fixture/folds.jsonl', other = 'pi:fixture/media.jsonl';
  const boxes = `[...document.querySelectorAll('#conversationTranscript .toolgroup[data-gkey]')]`;
  const state = () => evaluate(`${boxes}.map(g => [g.dataset.gkey, g.open])`);
  const kept = () => evaluate(`JSON.parse(localStorage.getItem('chattering.reader.v2:' + ${JSON.stringify(key)}) || '{}').steps || {}`);
  const openConversation = async k => {
    await evaluate(`open(${JSON.stringify(k)})`);
    await until(`current?.key === ${JSON.stringify(k)} && ${k === key ? `${boxes}.length === 2` : `!document.querySelector('#conversationTranscript .toolgroup')`}`, 'opened ' + k);
  };
  // A person's click: a real mouse press on the box's line.
  const personClick = async selector => {
    const at = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect(); return { x: r.left + 12, y: r.top + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await command('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  };
  const key1 = async (k, code) => {
    await evaluate(`document.activeElement?.blur()`);
    for (const type of ['keyDown', 'keyUp']) await command('Input.dispatchKeyEvent', { type, key: k, code, text: type === 'keyDown' ? k : undefined, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0), modifiers: k === 'X' ? 8 : 0 });
  };

  await until(`typeof open === 'function'`);
  await openConversation(key);
  // Two boxes, two names; both closed.
  assert.deepEqual(await state(), [['a1#0', false], ['t:c1', false]]);

  // Opened by the app (a script): only that box, through re-renders, for this visit.
  await evaluate(`${boxes}[0].open = true`);
  await until(`${boxes}[0].open`);
  await openConversation(key); // a refresh of the same conversation re-renders it
  assert.deepEqual(await state(), [['a1#0', true], ['t:c1', false]], 'opening one opens only that one');
  assert.deepEqual(await kept(), {}, 'the app opening a box is not kept');
  await openConversation(other);
  await openConversation(key);
  assert.deepEqual(await state(), [['a1#0', false], ['t:c1', false]], 'the app\'s openings end with the visit');

  // Opened by a person: kept, also after a reload, and only that one.
  await personClick(`#conversationTranscript .toolgroup[data-gkey="t:c1"] > summary`);
  await until(`${boxes}[1].open`, 'the click opens it');
  assert.deepEqual(await kept(), { 't:c1': true });
  await command('Page.navigate', { url: base + '/?token=' + token });
  await until(`typeof open === 'function' && typeof settingsOf === 'function'`);
  await openConversation(key);
  assert.deepEqual(await state(), [['a1#0', false], ['t:c1', true]], 'a person\'s open box is kept');

  // x folds everything and forgets; X opens everything, for this visit only.
  await key1('x', 'KeyX');
  await until(`${boxes}.every(g => !g.open)`, 'x folds');
  await until(`Object.keys(JSON.parse(localStorage.getItem('chattering.reader.v2:' + ${JSON.stringify(key)}) || '{}').steps || {}).length === 0`, 'a close forgets the kept box');
  await key1('X', 'KeyX');
  await until(`${boxes}.every(g => g.open)`, 'X unfolds');
  assert.deepEqual(await kept(), {}, 'unfold all is not kept');

  // Work being done comes in closed, even with every box above it open.
  const runEvent = (jobId, extra = {}) => evaluate(`live.onmessage({ data: ${JSON.stringify(JSON.stringify({ type: 'run-event', jobId, key, status: 'running', statusText: 'running', startedAt: Date.now(), node: 'a3', model: 'p/big',
    tail: [{ id: 1, kind: 'tool', callId: 'live-' + jobId, name: 'bash', args: 'npm test', out: '', phase: 'running' }], ...extra }))} }); 1`);
  await runEvent('run-1');
  await until(`document.querySelector('#liveReplies .toolgroup[data-live-work]')`, 'the live box');
  assert.equal(await evaluate(`document.querySelector('#liveReplies .toolgroup[data-live-work]').open`), false, 'a coming box is closed');

  // The bottom monitor opens groups and nested inputs, independently of
  // transcript folds. New steps open too, without resetting manual choices.
  await until(`!document.getElementById('lsLine').closest('[hidden]')`, 'the live line');
  await evaluate(`document.getElementById('lsLine').click()`);
  await until(`!document.getElementById('lsFull').hidden && document.querySelector('#lsBlocks .toolgroup')`, 'the stream opens');
  await until(`[...document.querySelectorAll('#lsBlocks details')].every(g => g.open)`, 'monitor details open');
  assert.equal(await evaluate(`document.querySelector('#liveReplies .toolgroup').open`), false, 'monitor opening does not open transcript work');
  assert.deepEqual(await kept(), {}, 'monitor opening is not remembered as a transcript choice');
  await personClick('#lsBlocks .toolgroup > summary');
  await until(`!document.querySelector('#lsBlocks .toolgroup').open`, 'monitor can still be manually folded');
  const tail = [
    { id: 1, kind: 'tool', callId: 'live-run-1', name: 'bash', args: 'npm test', out: 'Tests passed', phase: 'done' },
    { id: 2, kind: 'text', text: 'Now checking another command.', done: true },
    { id: 3, kind: 'text', think: 'Looking at its output.', done: false },
    { id: 4, kind: 'tool', callId: 'live-next', name: 'bash', rawArgs: '{"command":"pwd"}', out: '/work', phase: 'running' },
  ];
  await runEvent('run-1', { tail });
  await until(`document.querySelectorAll('#lsBlocks .toolgroup').length === 2`, 'new group appears');
  assert.equal(await evaluate(`document.querySelector('#lsBlocks .toolgroup').open`), false, 'updates respect a manual fold');
  assert.equal(await evaluate(`[...document.querySelectorAll('#lsBlocks .toolgroup')][1].open`), true, 'new monitor groups open');
  assert.equal(await evaluate(`document.querySelector('#lsBlocks [data-blk="4"] details').open`), true, 'new raw input opens');
  assert.match(await evaluate(`document.getElementById('lsBlocks').innerText`), /Looking at its output\./);
  assert.match(await evaluate(`document.getElementById('lsBlocks').innerText`), /\/work/);
  await evaluate(`document.getElementById('lsLine').click()`);
  await until(`!liveOpen`, 'monitor closes');
  assert.equal(await evaluate(`[...document.querySelectorAll('#liveReplies .toolgroup')].every(g => !g.open)`), true, 'closing monitor leaves transcript folded');
  assert.deepEqual(await kept(), {}, 'manual monitor folds stay local');
  await evaluate(`document.getElementById('lsLine').click()`);
  await runEvent('run-1', { tail, status: 'done', final: true, finishedAt: Date.now() });
  await evaluate(`window._lsLast = 0; renderRunCards(); 1`);
  assert.equal(await evaluate(`liveOpen && !document.getElementById('lsFull').hidden`), true, 'the finished run stays open until closed');
  await runEvent('run-2');
  await until(`!liveOpen && document.getElementById('lsFull').hidden`, 'the next run starts closed');

  // The keys, where a conversation's keys are listed.
  assert.equal(await evaluate(`helpNow().find(s => s.label === 'conversation').keys.some(([k, what]) => k === 'x / X' && /steps/.test(what))`), true);
  assert.deepEqual(exceptions, []);
});
