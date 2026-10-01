'use strict';
// A Codex conversation in the page (design/87), in a real browser against
// the real server and the stand-in Codex (fixtures/fake-codex.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromiumAvailable } = require('./helpers/chromium');
const { viewerBrowser } = require('./helpers/viewer-browser');
const fx = require('./helpers/codex-fixtures');

test('Codex conversations in the page: composer, controls, streaming, approvals, drafts, copies', { timeout: 120000 }, async t => {
  if (!chromiumAvailable()) return t.skip('Chromium is required');
  let work;
  const b = await viewerBrowser(t, {
    env: { CHATTERING_CODEX: path.join(__dirname, 'fixtures', 'fake-codex.js'), FAKE_CODEX_APPROVE: '1', CHATTERING_NO_WATCH: '0' },
    setup(home) {
      work = path.join(home, 'work');
      fs.mkdirSync(work, { recursive: true });
      fs.writeFileSync(path.join(work, 'owl notes.md'), 'owls\n');
      fx.writeCodexHome(home, work);
    },
  });
  // The server's HOME is the test home, so Codex's files are its ~/.codex.
  const key = 'codex:2026/09/20/rollout-2026-09-20T10-00-00-01a0f000-0000-7000-8000-000000000001.jsonl';
  const copyKey = 'codex:2026/09/21/rollout-2026-09-21T09-00-00-01a0f000-0000-7000-8000-000000000004.jsonl';
  await b.until(`true`);
  await b.evaluate(`location.hash = ${JSON.stringify('#' + encodeURIComponent(key))}`);
  // Its own model, even one Codex no longer lists: that is what the next message uses.
  await b.until(`document.querySelector('#modelPick .mname')?.textContent === 'Codex · gpt-fixture'`, 'the Codex composer: harness and the conversation’s own model on the model button');
  // The transcript: the person's words, Codex's answer and tools.
  await b.until(`document.querySelector('#view').textContent.includes('Why does the parrot fixture fail?')`, 'Codex transcript');
  assert.ok(!(await b.evaluate(`document.querySelector('#view').textContent.includes('AGENTS.md instructions')`)), 'no injected instructions shown');
  assert.ok(await b.evaluate(`document.querySelector('#view').textContent.includes('The parrot said quack')`));
  // Codex's controls, from Codex's own menus.
  assert.equal(await b.evaluate(`!!document.querySelector('#agentMode')`), false, 'no Pi modes on a Codex conversation');
  await b.until(`/ChatGPT pro · 40% of the 7-day limit used/.test(document.querySelector('#ctxMeter')?.textContent || '')`, 'plan usage in the usage line, not a per-message cost');
  assert.ok(!(await b.evaluate(`document.querySelector('#ctxMeter').textContent.includes('cost unknown')`)));
  await b.evaluate(`document.querySelector('#modelPick').click()`);
  await b.until(`document.querySelectorAll('.codex-pick .mp-row').length === 2`, 'Codex model list (hidden model excluded)');
  await b.evaluate(`[...document.querySelectorAll('.codex-pick .mp-row')].find(r => r.textContent.includes('Fake Mini')).click()`);
  await b.until(`document.querySelector('#modelPick .mname')?.textContent === 'Codex · Fake Mini'`, 'model switched');
  await b.until(`/low/.test(document.querySelector('#agentThink')?.textContent || '')`, 'effort follows the model (Fake Mini offers only low)');
  await b.evaluate(`document.querySelector('#modelPick').click()`);
  await b.until(`document.querySelectorAll('.codex-pick .mp-row').length === 2`, 'model list again');
  await b.evaluate(`[...document.querySelectorAll('.codex-pick .mp-row')].find(r => r.textContent.includes('Fake Model')).click()`);
  await b.until(`document.querySelector('#modelPick .mname')?.textContent === 'Codex · Fake Model'`, 'model back');
  await b.evaluate(`document.querySelector('#agentThink').click()`);
  await b.until(`document.querySelectorAll('.codex-pick .mp-row').length === 3`, 'the three levels Fake Model offers');
  await b.evaluate(`[...document.querySelectorAll('.codex-pick .mp-row')].find(r => r.textContent.includes('high')).click()`);
  await b.until(`/high/.test(document.querySelector('#agentThink').textContent)`, 'effort chosen');
  await b.evaluate(`document.querySelector('#codexAccess').click()`);
  await b.until(`document.querySelectorAll('.codex-pick .mp-row').length === 4`, 'access levels');
  await b.evaluate(`[...document.querySelectorAll('.codex-pick .mp-row')].find(r => r.textContent.includes('This folder')).click()`);
  await b.until(`document.querySelector('#codexAccess').textContent === 'this folder'`, 'access chosen');
  const prefs = await (await fetch(b.base + '/api/session?id=' + encodeURIComponent(key), { headers: b.auth })).json();
  assert.deepEqual(prefs.codexPrefs, { model: 'fake-model', effort: 'high', access: 'workspace' });

  // The composer: Codex's file search behind @.
  const set = text => b.evaluate(`(()=>{const t=document.querySelector('#agentText');t.focus();t.value=${JSON.stringify(text)};t.setSelectionRange(t.value.length,t.value.length);t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await set('look at @owl');
  await b.until(`[...document.querySelectorAll('.file-completion [role=option]')].some(o => o.textContent.includes('owl notes.md'))`, 'Codex file search');
  await b.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await b.until(`document.querySelector('#agentText').value === 'look at @"owl notes.md" '`, 'file inserted, quoted');

  // Send: the reply streams into the page; Codex asks before its command.
  await set('Please check the owls');
  await b.evaluate(`headlessSendFromComposer(document.querySelector('#agentRun'))`);
  await b.until(`[...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'Allow')`, 'the approval card');
  assert.ok(await b.evaluate(`document.body.textContent.includes('Codex wants to run a command')`));
  await b.evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Allow').click()`);
  await b.until(`document.querySelector('#view').textContent.includes('Fake Codex heard: Please check the owls')`, 'the answer, in the transcript');

  // A text-only copy: read, never continued; the original is named.
  await b.evaluate(`location.hash = ${JSON.stringify('#' + encodeURIComponent(copyKey))}`);
  await b.until(`document.querySelector('#codexNotice')?.textContent.includes('text-only copy')`, 'copy notice');
  assert.equal(await b.evaluate(`!!document.querySelector('#agentText')`), false);

  // A new conversation with Codex, from a draft.
  await b.evaluate(`startNewConversation()`);
  await b.until(`!!document.querySelector('[data-harness="codex"]')`, 'harness choice on the draft');
  await b.evaluate(`document.querySelector('[data-harness="codex"]').click()`);
  await b.until(`/^Codex · /.test(document.querySelector('#modelPick .mname')?.textContent || '') && document.querySelector('[data-harness="codex"]').getAttribute('aria-checked') === 'true'`, 'draft switched to Codex');
  await b.evaluate(`(()=>{const i=document.querySelector('#dsFolder'); i.value=${JSON.stringify(work)}; i.dispatchEvent(new Event('input'));})()`);
  await new Promise(r => setTimeout(r, 400));
  await set('Start with Codex please');
  await b.evaluate(`document.querySelector('#agentRun').click()`);
  await b.until(`[...document.querySelectorAll('button')].some(x => x.textContent.trim() === 'Allow')`, async () => 'approval in the new conversation: ' + await b.evaluate(`JSON.stringify({hash: location.hash, toasts: [...document.querySelectorAll('.toast, #toast, .err-toast')].map(x => x.textContent).slice(-3), strip: document.querySelector('#liveStrip')?.textContent.slice(0, 200), cards: document.querySelector('#runCards')?.textContent.slice(0, 300), draftState: typeof draftState !== 'undefined' && draftState ? draftState.d.harness + ' ' + draftState.d.folder : null})`));
  await b.evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Allow').click()`);
  await b.until(`/^codex:/.test(decodeURIComponent(location.hash.slice(1))) && document.querySelector('#view').textContent.includes('Fake Codex heard: Start with Codex please')`, 'new Codex conversation opened with its answer');

  // Phone width: the Codex controls fit.
  await b.size(390, 844, true);
  await b.until(`document.querySelector('#modelPick .mname')?.textContent.includes('Fake Model')`, 'model button on the phone');
  // Every control of the row is on screen and none overlaps another.
  const layout = await b.evaluate(`(()=>{const els=[...document.querySelectorAll('.agent-compose-row > .compose-left > *, .agent-compose-row > .compose-right > *, .agent-compose-row .model-strip > *')].filter(e=>e.getClientRects().length && !e.classList.contains('model-strip'));const rs=els.map(e=>({id:e.id||e.className,r:e.getBoundingClientRect()}));const bad=[];for(const a of rs){if(a.r.left<-1||a.r.right>innerWidth+1)bad.push('off '+a.id);for(const b2 of rs){if(a===b2)continue;const ov=Math.min(a.r.right,b2.r.right)-Math.max(a.r.left,b2.r.left);const vv=Math.min(a.r.bottom,b2.r.bottom)-Math.max(a.r.top,b2.r.top);if(ov>2&&vv>2&&!(a.r.left<=b2.r.left&&a.r.right>=b2.r.right))bad.push(a.id+' over '+b2.id);}}return {bad,mname:document.querySelector('#modelPick .mname').getBoundingClientRect().width};})()`);
  assert.deepEqual(layout.bad, [], 'composer row on the phone');
  assert.ok(layout.mname >= 40, 'the model name is readable on the phone');
  await b.screenshot('codex-composer-phone.png');
  assert.deepEqual(b.exceptions, []);
});

test('the file ask box follows the agent it sends to: a Codex conversation shows Codex\'s controls and sends Codex\'s choices', { timeout: 90000 }, async t => {
  if (!chromiumAvailable()) return t.skip('Chromium is required');
  const b = await viewerBrowser(t, {
    env: { CHATTERING_CODEX: path.join(__dirname, 'fixtures', 'fake-codex.js'), CHATTERING_NO_WATCH: '0' },
    setup(home) { const work = path.join(home, 'work'); fs.mkdirSync(work, { recursive: true }); fx.writeCodexHome(home, work); },
  });
  const { evaluate: ev, until } = b;
  const key = 'codex:2026/09/20/rollout-2026-09-20T10-00-00-01a0f000-0000-7000-8000-000000000001.jsonl';
  fs.writeFileSync(path.join(b.work, 'notes.md'), '# Notes\n\nOne line.\n');
  await until(`sessions.length && nav.current()`);
  await until(`!document.querySelector('dialog.bg-ask')`, 'the first-run question stayed');
  await b.open('notes.md', { project: null });
  await until(`docState && docState.path.endsWith('notes.md') && fileWs && fileWs.editor`, 'the document did not open');
  // A Pi model and level remembered by the box, and the Codex conversation
  // as where the last ask went.
  await ev(`localStorage.setItem('chattering.ask.v1', JSON.stringify({ model: 'anthropic/claude-fixture', thinking: 'off', more: true }))`);
  await ev(`fileWs.askLast = { key: ${JSON.stringify(key)}, title: 'Parrot' }`);
  await ev(`askBubbleOpen(fileWs)`);
  await until(`askBox && askBox.info && askBox.target.value === ${JSON.stringify(key)}`, 'the Codex conversation is the target');
  assert.match(await ev(`askBox.target.selectedOptions[0].textContent`), /· Codex/);
  assert.ok(await ev(`[...askBox.target.options].some(o => o.value === 'new-codex')`), 'a new Codex conversation is offered');
  await until(`document.querySelector('.ask-model').textContent.includes('Codex · gpt-fixture')`, 'the conversation’s own Codex model (an older one Codex no longer lists), not the box’s Pi model');
  assert.equal(await ev(`document.querySelector('.ask-think').textContent`), '∴ default ▾');
  // Codex's models and levels in the box's menus.
  await ev(`document.querySelector('.ask-model').click()`);
  await until(`document.querySelectorAll('.codex-pick .mp-row').length === 3`, 'own + two Codex models');
  await ev(`[...document.querySelectorAll('.codex-pick .mp-row')].find(r => r.textContent.includes('Fake Mini')).click()`);
  await until(`document.querySelector('.ask-model').textContent.includes('Codex · fake-mini')`, 'the Codex model chosen for the box');
  await ev(`document.querySelector('.ask-think').click()`);
  await until(`document.querySelectorAll('.codex-pick .mp-row').length >= 2`, 'Codex levels');
  const levels = await ev(`[...document.querySelectorAll('.codex-pick .mp-row b')].map(x => x.textContent)`);
  assert.ok(!levels.includes('off'), 'Pi’s levels are not offered for Codex: ' + levels);
  await ev(`[...document.querySelectorAll('.codex-pick .mp-row')].find(r => r.querySelector('b').textContent === 'low').click()`);
  await until(`document.querySelector('.ask-think').textContent === '∴ low ▾'`, 'the Codex level chosen for the box');
  // The send carries both agents' choices; the server applies Codex's.
  await ev(`(() => { window.askSent = []; const real = window.fetch; window.fetch = (url, opts) => {
    if (String(url).includes('/api/files/ask') && !String(url).includes('ask-') && opts && opts.method === 'POST') { askSent.push(JSON.parse(opts.body)); return Promise.resolve(new Response(JSON.stringify({ ok: true, key: ${JSON.stringify(key)}, harness: 'codex', created: false, queued: false, job: { id: 'run:t' }, notes: [] }))); }
    return real(url, opts); }; })()`);
  await ev(`(() => { const ta = document.querySelector('.ask-text'); ta.value = 'shorter'; askBubbleSend(); })()`);
  await until(`askSent.length === 1`, 'the send did not go');
  const sent = await ev(`askSent[0]`);
  assert.deepEqual([sent.target, sent.codexModel, sent.codexEffort], [key, 'fake-mini', 'low']);
  // A Pi target again: the box's Pi choices, unchanged.
  await ev(`fileWsRunEvent({ jobId: 'run:t', key: ${JSON.stringify(key)}, final: true, status: 'done' })`);
  // The settled run reloads where the box sends: wait for it, then choose
  // as a person does (the list's change event).
  await until(`!fileWs.run && askBox && askBox.info && askBox.target.value === ${JSON.stringify(key)}`, 'the box settles on the conversation');
  const choose = v => ev(`(() => { const s = askBox.target; s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await choose('new');
  await until(`!document.querySelector('.ask-model').textContent.includes('Codex')`, 'a Pi target shows Pi’s model');
  assert.equal(await ev(`document.querySelector('.ask-think').textContent`), '∴ off ▾');
  await choose('new-codex');
  await until(`document.querySelector('.ask-model').textContent.includes('Codex · fake-mini')`, 'a new Codex conversation shows Codex’s choices');
});
