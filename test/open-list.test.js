'use strict';
// design/59: the side list holds the conversations a person opened — newest
// conversation on top — with the assistant's typing dots while it works, a
// dot and bold title once it replied and nobody read it, and a ✕ to close.
// No Unread / Read / Working sections, no "Return to work". Against the real
// server and a headless Chromium.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromiumBinary, chromiumAvailable } = require('./helpers/chromium.js');
const { viewerBrowser } = require('./helpers/viewer-browser.js');

test('the side list: opened conversations, previews, typing dots, unread dot, close with undo', { timeout: 60000 }, async t => {
  if (!chromiumAvailable()) return t.skip('chromium is not installed');
  const { home, base, work, auth, evaluate: ev, until, screenshot, exceptions } = await viewerBrowser(t);
  const fixture = path.join(home, '.pi/agent/sessions/fixture');
  const keys = {};
  // Three conversations born a day apart: gamma is the newest.
  const born = { alpha: '2026-09-01T12:00:00Z', beta: '2026-09-02T12:00:00Z', gamma: '2026-09-03T12:00:00Z' };
  for (const [name, ts] of Object.entries(born)) {
    keys[name] = 'pi:fixture/' + name + '.jsonl';
    fs.writeFileSync(path.join(fixture, name + '.jsonl'), [
      { type: 'session', version: 3, id: name, cwd: work },
      { type: 'message', id: name + '-p', parentId: null, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: name + ' question' }] } },
      { type: 'message', id: name + '-a', parentId: name + '-p', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: name + ' reply.' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
  }
  await fetch(base + '/api/rescan', { method: 'POST', headers: auth }); await ev(`load()`);
  await until(`sessions.some(s=>s.key===${JSON.stringify(keys.gamma)})`);
  const rows = `[...document.querySelectorAll('#agentsUnread [data-sec=open] .ag-item:not([inert]) .ag-row[data-key]')].map(r=>r.dataset.key)`;
  const rowOf = key => `document.querySelector('#agentsUnread .ag-item:not([inert]) .ag-row[data-key=${JSON.stringify(key)}]')`;

  // The column is the list, and it starts empty.
  assert.equal(await ev(`document.body.classList.contains('side-layout') && !$('agentsPop').hidden`), true, 'the side column is open');
  assert.equal(await ev(`!!document.querySelector('#agentsUnread .ag-tail .ag-empty')`), true, 'the list starts empty');
  assert.equal(await ev(`!document.querySelector('[data-sec=unread],[data-sec=read],[data-sec=traffic],.read-scope,#returnToWork')`), true, 'no Unread / Read / Working sections, no Return to work');

  // Opening lists, in first-message order, newest on top — not in opening order.
  await ev(`open(${JSON.stringify(keys.alpha)})`);
  await until(`viewKind==='conversation' && current?.key===${JSON.stringify(keys.alpha)}`);
  await until(`${rows}.length===1`, 'the opened conversation is listed');
  await ev(`open(${JSON.stringify(keys.gamma)})`);
  await until(`current?.key===${JSON.stringify(keys.gamma)} && ${rows}.length===2`);
  await ev(`open(${JSON.stringify(keys.beta)})`);
  await until(`current?.key===${JSON.stringify(keys.beta)} && ${rows}.length===3`);
  assert.deepEqual(await ev(rows), [keys.gamma, keys.beta, keys.alpha], 'newest first message on top');
  assert.equal(await ev(`document.querySelector('#agentsUnread .ag-row.current')?.dataset.key`), keys.beta, 'the open conversation is marked');
  // Line two is the last thing said; a loose conversation wastes no line on "No project".
  assert.equal(await ev(`${rowOf(keys.beta)}.querySelector('.ag-preview').textContent`), 'beta reply.', 'the preview is the last message');
  assert.equal(await ev(`${rowOf(keys.beta)}.textContent.includes('No project')`), false, 'no project line for a loose conversation');
  assert.equal(await ev(`${rowOf(keys.beta)}.querySelector('.ag-title .ag-age').textContent.length > 0`), true, 'the time sits on the title line');
  for (let i = 0; i < 100 && Object.keys((await (await fetch(base + '/api/agent-read', { headers: auth })).json()).opened).length < 3; i++) await new Promise(r => setTimeout(r, 30));
  const shared = await (await fetch(base + '/api/agent-read', { headers: auth })).json();
  assert.deepEqual(Object.keys(shared.opened).sort(), Object.values(keys).sort(), 'the list is shared through the server');

  // Working: three typing dots, no unread dot; the human typing bubble is a different element.
  await ev(`jobs.set('run-1',{id:'run-1',type:'agent-run',status:'running',key:${JSON.stringify(keys.alpha)}});activeRuns.set('run-1',{jobId:'run-1',key:${JSON.stringify(keys.alpha)},status:'running',statusText:'tool · bash',startedAt:Date.now()-125000});updateActiveBtn();renderAgentsPop(false)`);
  await until(`document.querySelector('#agentsUnread .ag-row.working[data-key=${JSON.stringify(keys.alpha)}] .ag-typing')`, 'the working row shows typing dots');
  assert.equal(await ev(`(()=>{const r=${rowOf(keys.alpha)};return r.classList.contains('unread')||!!r.querySelector('.ag-mark')||!!r.querySelector('.user-bubble.typing')})()`), false, 'no marker, and not the human typing bubble');
  assert.equal(await ev(`${rowOf(keys.alpha)}.querySelector('.ag-doing').textContent`), 'tool · bash', 'line two says what the assistant is doing');
  assert.equal(await ev(`${rowOf(keys.alpha)}.querySelector('.ag-elapsed').textContent`), '2m', '...and for how long');
  // The ticker updates the text in place, once a second. Any re-render in
  // between restores the start time from the run, so the tick is checked
  // directly: a running ticker, and one tick that rewrites the text alone.
  assert.equal(await ev(`elapsedTicker !== null`), true, 'a ticker runs while a row carries a start time');
  assert.equal(await ev(`(()=>{const el=${rowOf(keys.alpha)}.querySelector('.ag-elapsed');el.dataset.since=String(Date.now()-3600000);tickElapsed();return el.isConnected&&el.textContent})()`), '1h', 'the elapsed time ticks without a re-render');
  assert.deepEqual(await ev(rows), [keys.gamma, keys.beta, keys.alpha], 'work does not reorder the list');

  // Finished, unread: a dot and a bold title; the rail counts it. A reply
  // is a transcript write newer than the last read.
  await ev(`activeRuns.clear();jobs.delete('run-1')`);
  await until(`agentReadPending.size===0`, 'reads reached the server');
  const reply = async (name, text) => {
    await new Promise(r => setTimeout(r, 1100));
    fs.appendFileSync(path.join(fixture, name + '.jsonl'), JSON.stringify({ type: 'message', id: name + '-' + Date.now(), parentId: name + '-a', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n');
    await fetch(base + '/api/rescan', { method: 'POST', headers: auth }); await ev(`load()`);
  };
  await reply('alpha', 'Alpha again.');
  await until(`document.querySelector('#agentsUnread .ag-row.unread[data-key=${JSON.stringify(keys.alpha)}]')`, 'the finished reply is unread');
  assert.equal(await ev(`(()=>{const r=${rowOf(keys.alpha)};const t=r.querySelector('.ag-title');return !r.querySelector('.ag-typing') && getComputedStyle(t).fontWeight>=700 && getComputedStyle(r.querySelector('.ag-mark'),'::before').borderRadius==='50%'})()`), true, 'bold title and a dot, no typing dots');
  assert.equal(await ev(`${rowOf(keys.alpha)}.querySelector('.ag-preview').textContent`), 'Alpha again.', 'the preview follows the reply');
  assert.equal(await ev(`$('side').dataset.unread`), '1', 'the column counts one unread');
  await ev(`jobs.set('run-2',{id:'run-2',type:'agent-run',status:'running',key:${JSON.stringify(keys.beta)}});activeRuns.set('run-2',{jobId:'run-2',key:${JSON.stringify(keys.beta)},status:'running',statusText:'thinking'});renderAgentsPop(false)`);
  await until(`document.querySelector('#agentsUnread .ag-row.working[data-key=${JSON.stringify(keys.beta)}]')`);
  await screenshot('open-list.png');
  await ev(`activeRuns.delete('run-2');jobs.delete('run-2');renderAgentsPop(false)`);

  // Reading it clears the dot. Closing takes it off the list; the rest stays.
  await ev(`document.querySelector('#agentsUnread .ag-row[data-key=${JSON.stringify(keys.alpha)}]').click()`);
  await until(`current?.key===${JSON.stringify(keys.alpha)} && !document.querySelector('#agentsUnread .ag-row.unread')`, 'reading clears the dot');
  assert.equal(await ev(`$('side').dataset.unread`), '', 'nothing unread');
  await ev(`${rowOf(keys.gamma)}.querySelector('.ag-close').click()`);
  await until(`${rows}.length===2`, 'closed: off the list');
  assert.deepEqual(await ev(rows), [keys.beta, keys.alpha]);
  for (let i = 0; i < 100 && !(keys.gamma in (await (await fetch(base + '/api/agent-read', { headers: auth })).json()).dismissed); i++) await new Promise(r => setTimeout(r, 30));
  assert.ok(keys.gamma in (await (await fetch(base + '/api/agent-read', { headers: auth })).json()).dismissed, 'the close reached the server');
  // Undo from the toast puts it back exactly, on every device.
  await until(`[...document.querySelectorAll('.toast')].some(t=>t.textContent.includes('Undo'))`, 'a toast offers Undo');
  await ev(`[...document.querySelectorAll('.toast')].find(t=>t.textContent.includes('Undo')).click()`);
  await until(`${rows}.length===3`, 'undone: back in the list');
  assert.deepEqual(await ev(rows), [keys.gamma, keys.beta, keys.alpha], 'back in its place');
  for (let i = 0; i < 100 && (keys.gamma in (await (await fetch(base + '/api/agent-read', { headers: auth })).json()).dismissed); i++) await new Promise(r => setTimeout(r, 30));
  assert.equal(keys.gamma in (await (await fetch(base + '/api/agent-read', { headers: auth })).json()).dismissed, false, 'the undo reached the server');
  await ev(`${rowOf(keys.gamma)}.querySelector('.ag-close').click()`);
  await until(`${rows}.length===2`);

  // A closed conversation that replies again comes back, unread.
  await reply('gamma', 'Gamma again.');
  await until(`document.querySelector('#agentsUnread .ag-row.unread[data-key=${JSON.stringify(keys.gamma)}]')`, 'a later reply lists it again, unread');
  assert.deepEqual(await ev(rows), [keys.gamma, keys.beta, keys.alpha], 'back in its place');

  // Opening a closed conversation lists it again, too.
  await ev(`${rowOf(keys.beta)}.querySelector('.ag-close').click()`);
  await until(`${rows}.length===2`);
  await ev(`open(${JSON.stringify(keys.beta)})`);
  await until(`current?.key===${JSON.stringify(keys.beta)} && ${rows}.length===3`, 'opening lists a closed conversation again');

  // The assistant ended with a question: an amber "?" says the reply wants
  // an answer. It stays after the reply is read, until the person writes.
  await reply('beta', 'Two ways to do this.\n\nWhich one do you want?');
  await until(`${rowOf(keys.beta)}.classList.contains('asks')`, 'a closing question marks the row');
  assert.equal(await ev(`getComputedStyle(${rowOf(keys.beta)}.querySelector('.ag-mark'),'::before').content`), '"?"');
  assert.equal(await ev(`${rowOf(keys.beta)}.classList.contains('unread')`), false, 'the open conversation is read, and still asking');

  // A stopped run is a row state with Resume; its ✕ gives up recovery too.
  // Gamma was listed again by its later reply: close it first, so the
  // stopped run is seen to list a closed conversation.
  await ev(`${rowOf(keys.gamma)}.querySelector('.ag-close').click()`);
  await until(`!${rowOf(keys.gamma)}`, 'gamma closed again');
  await ev(`applyAgentRecovery({enabled:false,network:{},interrupted:[{id:'rec-1',key:${JSON.stringify(keys.gamma)},title:'gamma question',kind:'network',reason:'fetch failed: ECONNRESET',createdAt:Date.now()-90000,attempts:1,state:'pending',canResume:true,waiting:false,note:''}]});renderAgentsPop(false)`);
  await until(`${rowOf(keys.gamma)}?.classList.contains('stopped')`, 'the interrupted run is listed as stopped, even though it was closed');
  assert.equal(await ev(`getComputedStyle(${rowOf(keys.gamma)}.querySelector('.ag-mark'),'::before').content`), '"!"');
  assert.equal(await ev(`${rowOf(keys.gamma)}.querySelector('.ag-doing').textContent`), 'connection lost');
  assert.equal(await ev(`!!${rowOf(keys.gamma)}.querySelector('.ag-resume[data-recovery-action=resume]') && ${rowOf(keys.gamma)}.querySelector('.ag-close').dataset.recovery === 'rec-1'`), true, 'Resume on the row; ✕ knows the recovery record');
  assert.equal(await ev(`!document.querySelector('.ag-interrupted, .ag-recovery-actions')`), true, 'no separate interrupted block');
  await ev(`applyAgentRecovery({enabled:false,network:{},interrupted:[]});renderAgentsPop(false)`);
  await until(`!${rowOf(keys.gamma)}`);

  // The ⋯ menu: pin, mark unread, close, open — no "remove from replies".
  await ev(`openAgentRowMenu(${JSON.stringify(keys.alpha)}, 0, 0)`);
  assert.deepEqual(await ev(`[...document.querySelectorAll('.ag-menu [data-ag-action]')].map(b=>b.textContent)`), ['Pin to the top', 'Mark as unread', 'Close', 'Open']);
  await ev(`closeFileActionMenu()`);
  assert.deepEqual(exceptions, []);
});
