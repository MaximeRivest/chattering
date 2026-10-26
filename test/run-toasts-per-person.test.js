'use strict';
// "Reply ready" and "Agent stopped" are told to the person who asked, not to
// everyone who has the app open (2026-10-26: Maxime saw Lilly's). A run
// nobody asked for (a resume, the frog) is told to whoever has it in their list.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromiumAvailable } = require('./helpers/chromium.js');
const { viewerBrowser } = require('./helpers/viewer-browser.js');

test('run toasts go to the person who asked', { skip: !chromiumAvailable() && 'chromium is not installed', timeout: 120000 }, async t => {
  const { evaluate, until } = await viewerBrowser(t);
  await until(`typeof live !== 'undefined' && peopleState.me && agentReadLoaded`, 'the app, its person and their list');
  const me = await evaluate(`peopleState.me.id`);
  const key = 'pi:fixture/media.jsonl';
  // Feed the page the events the server sends, one run at a time.
  const run = async (id, extra, status = 'done') => evaluate(`(() => {
    document.querySelectorAll('#toasts > *').forEach(n => n.remove());
    const send = job => live.onmessage({ data: JSON.stringify({ type: 'job', job }) });
    const base = { id: ${JSON.stringify(id)}, type: 'agent-run', key: ${JSON.stringify(key)}, title: 'gpt · ' + ${JSON.stringify(id)}, ...${JSON.stringify(extra)} };
    send({ ...base, status: 'running' });
    send({ ...base, status: ${JSON.stringify(status)}, statusText: 'out of extra usage' });
    return [...document.querySelectorAll('#toasts > *')].map(n => n.textContent).join(' | ');
  })()`);
  assert.equal(await run('r1', { askedBy: 'u_someone_else' }), '', 'someone else\u2019s reply: no toast');
  assert.equal(await run('r2', { askedBy: 'u_someone_else' }, 'error'), '', 'nor their stopped run');
  assert.match(await run('r3', { askedBy: me }), /Reply ready: gpt · r3/, 'mine: told');
  assert.match(await run('r4', { askedBy: me }, 'error'), /Agent stopped/);
  assert.equal(await run('r5', {}), '', 'nobody asked, not in my list: no toast');
  await evaluate(`openAgentConversation(${JSON.stringify(key)})`);
  await until(`agentIsListed(sessions.find(s => s.key === ${JSON.stringify(key)}) || { key: ${JSON.stringify(key)} })`, 'listed');
  assert.match(await run('r6', {}), /Reply ready/, 'nobody asked, in my list: told');
});
