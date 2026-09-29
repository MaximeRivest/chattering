'use strict';
// The conversation beside the text (ask-panel.js), in a real browser: it
// opens beside the file instead of in its place, says the agent's work in
// plain words and shows the simpler answer first, follows a run as it goes
// (steps, the answer being written, a question from the agent, stop), sends
// a reply through the ask box's own path, keeps a typed reply, closes with
// Esc, comes back with the file, and fits a narrow window and a phone. The
// ask box's "details" opens it, and its settled line says the agent's first
// words. The server is real; only the send is answered by the page and the
// run's events are played to the page's own event handler.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

const KEY = 'pi:fixture/work.jsonl';
const DOC = '# Notes\n\nA long and winding introduction that says little.\n\nMore text.\n';

function setup(home) {
  const work = path.join(home, 'work');
  const note = path.join(work, 'notes.md');
  const ts = s => '2026-09-01T12:00:' + String(s).padStart(2, '0') + 'Z';
  const msg = (id, parentId, s, message) => ({ type: 'message', id, parentId, timestamp: ts(s), message });
  const answer = text => ({ role: 'assistant', provider: 'p', model: 'big', content: [{ type: 'text', text }] });
  fs.writeFileSync(path.join(home, '.pi/agent/sessions/fixture/work.jsonl'), [
    { type: 'session', version: 3, id: 'work', cwd: work },
    msg('u1', null, 1, { role: 'user', content: [{ type: 'text', text: 'Make the intro shorter' }] }),
    msg('a1', 'u1', 2, { role: 'assistant', provider: 'p', model: 'big', content: [
      { type: 'thinking', thinking: 'Read the intro first.' },
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: note } },
      { type: 'toolCall', id: 'call-2', name: 'bash', arguments: { command: 'cd ' + work + ' && grep -n intro notes.md' } },
    ] }),
    msg('r1', 'a1', 3, { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: DOC }], isError: false }),
    msg('r2', 'r1', 4, { role: 'toolResult', toolCallId: 'call-2', toolName: 'bash', content: [{ type: 'text', text: '3:A long…' }], isError: false }),
    msg('a2', 'r2', 5, { role: 'assistant', provider: 'p', model: 'big', content: [{ type: 'text', text: 'Found it; now the edit.' }, { type: 'toolCall', id: 'call-3', name: 'edit', arguments: { path: note, edits: [] } }] }),
    msg('r3', 'a2', 6, { role: 'toolResult', toolCallId: 'call-3', toolName: 'edit', content: [{ type: 'text', text: 'Successfully replaced 1 block(s).' }], isError: false }),
    msg('a3', 'r3', 7, answer('I condensed the introduction to one sentence and left the rest untouched.')),
    { type: 'custom_message', id: 'rq', parentId: 'a3', timestamp: ts(8), customType: 'chattering-answer-rewrite', content: 'rewrite', display: false, details: { sourceEntryId: 'a3' } },
    msg('s3', 'rq', 9, { ...answer('I made the intro one sentence. Nothing else changed.'), chatteringRewrite: { sourceEntryId: 'a3', requestId: 'rq' } }),
  ].map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(note, DOC);
  fs.writeFileSync(path.join(work, 'other.md'), '# Other\n');
}

test('the conversation beside the text: plain, live, a reply, and it keeps its place', { timeout: 90000 }, async t => {
  const b = await viewerBrowser(t, { setup });
  const { evaluate: ev, until, command } = b;
  await until(`sessions.length && sessions.some(s => s.key === ${JSON.stringify(KEY)})`, 'the fixture conversation is indexed');
  await until(`!document.querySelector('dialog.bg-ask')`, 'the first-run question stayed');
  await b.open('notes.md', { project: null });
  await until(`fileWs && fileWs.editor && docState && docState.path.endsWith('notes.md')`, 'the document did not open');
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  const key = async (key, code, vk, modifiers = 0) => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const shows = sel => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && el.getClientRects().length > 0; })()`);
  const text = sel => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() ?? null`);

  // ---- beside the text, in plain words ----
  await ev(`AskPanel.open(fileWs, ${JSON.stringify(KEY)}, { focus: true })`);
  await until(`document.querySelector('#askPanel .askp-turn')`, 'the conversation did not load in the panel');
  assert.equal(await ev(`viewKind`), 'file', 'the file stays on screen');
  const geo = await ev(`(() => { const p = document.querySelector('#askPanel').getBoundingClientRect(), t = document.querySelector('.doc-editor-host').getBoundingClientRect(); return { panelLeft: p.left, panelWidth: p.width, textRight: t.right, textWidth: t.width }; })()`);
  assert.ok(geo.panelLeft >= geo.textRight - 1, 'the panel is beside the text, not over it: ' + JSON.stringify(geo));
  assert.ok(geo.panelWidth >= 320 && geo.textWidth >= 420, 'both keep their room: ' + JSON.stringify(geo));
  assert.equal(await text('#askPanel .askp-you-text'), 'Make the intro shorter');
  // The work: the transcript's own groups, each said in plain words; the file is "this file".
  assert.deepEqual(await ev(`[...document.querySelectorAll('#askPanel .askp-work .tg-detail')].map(el => el.textContent)`),
    ['Read this file · Searched the files', 'Changed this file']);
  assert.equal(await text('#askPanel .askp-turn > .askp-answer.md'), 'Found it; now the edit.', 'what the agent said between its steps stays in place');
  assert.deepEqual(await ev(`[...document.querySelectorAll('#askPanel .askp-work')].map(g => g.dataset.gkey + ':' + [...g.querySelectorAll('[data-step]')].map(s => s.dataset.step).join(','))`),
    ['a1:k:a1,t:call-1,t:call-2', 'a2:t:call-3'], 'the same groups and step ids as the full page (plain-steps-ui reads them)');
  // The simpler answer first; the original one click away.
  assert.equal(await text('#askPanel .askp-versions [data-version="simpler"]'), 'I made the intro one sentence. Nothing else changed.');
  assert.equal(await shows('#askPanel .askp-versions [data-version="original"]'), false);
  await ev(`document.querySelector('#askPanel [data-askp-version]').click()`);
  assert.equal(await shows('#askPanel .askp-versions [data-version="original"]'), true);
  assert.equal(await text('#askPanel .askp-title'), 'Make the intro shorter');
  assert.equal(await ev(`document.activeElement?.classList.contains('askp-text')`), true, 'the reply box has the keyboard');
  assert.match(await text('#askPanel .askp-hint'), /^about line \d+ · you approve each change$/);
  await b.screenshot('ask-panel.png');

  // ---- a reply goes through the ask box's path, to this conversation ----
  await ev(`(() => {
    window.askSent = [];
    const real = window.fetch;
    window.fetch = (url, opts) => {
      if (String(url).includes('/api/files/ask') && !String(url).includes('ask-') && opts && opts.method === 'POST') {
        askSent.push(JSON.parse(opts.body));
        return Promise.resolve(new Response(JSON.stringify({ ok: true, key: ${JSON.stringify(KEY)}, created: false, queued: false, job: { id: 'run:test' }, title: 'Make the intro shorter', notes: [] })));
      }
      return real(url, opts);
    };
  })()`);
  await command('Input.insertText', { text: 'now fix the heading' });
  await key('Enter', 'Enter', 13);
  await until(`askSent.length === 1`, 'the reply was not sent');
  const sent = await ev(`askSent[0]`);
  assert.deepEqual([sent.prompt, sent.target, typeof sent.line], ['now fix the heading', KEY, 'number'], 'the conversation, the file and the cursor line');
  await until(`fileWs.run && document.querySelector('#askPanel .askp-live .askp-you.pending')`, 'the request does not show while it starts');
  assert.equal(await ev(`document.querySelector('#askPanel .askp-text').value`), '', 'the sent reply left the box');
  assert.equal(await ev(`document.querySelector('#askPanel .askp-send').disabled`), true, 'no second send while the agent works');
  assert.equal(await ev(`docState.editor.view.state.readOnly`), true, 'the editor locks as for any ask');

  // The run, as the server tells it: the steps and the answer as they come.
  const started = Date.now();
  const event = d => ev(`live.onmessage({ data: ${JSON.stringify(JSON.stringify({ type: 'run-event', jobId: 'run:test', key: KEY, status: 'running', startedAt: started, ...d }))} })`);
  const note = path.join(b.work, 'notes.md');
  await event({ statusText: 'tool · read', tail: [{ id: 1, kind: 'tool', name: 'read', args: JSON.stringify({ path: note }), phase: 'running' }] });
  await until(`document.querySelector('#askPanel .askp-now')?.textContent === 'Reading this file…'`, 'the step being taken is not said');
  assert.equal(await shows('#askPanel .askp-stop'), true);
  await event({ statusText: 'streaming', tail: [
    { id: 1, kind: 'tool', name: 'read', args: JSON.stringify({ path: note }), phase: 'done' },
    { id: 2, kind: 'tool', name: 'bash', args: JSON.stringify({ command: 'rat run --doc notes.md py "1+1"' }), phase: 'done' },
    { id: 3, kind: 'text', text: 'The heading now says **Field notes**.' },
  ] });
  await until(`document.querySelector('#askPanel .askp-live .askp-answer')?.textContent.includes('Field notes')`, 'the answer is not shown as it is written');
  assert.deepEqual(await ev(`[...document.querySelectorAll('#askPanel .askp-livestep')].map(el => el.dataset.state + ' ' + el.textContent.trim())`),
    ['done ✓ Read this file', 'done ✓ Ran code in the notebook']);
  assert.equal(await text('#askPanel .askp-now'), 'Writing the answer…');
  // A question from the agent is answered here.
  await event({ statusText: 'waiting for you · Rename?', uiRequests: [{ id: 'q1', method: 'confirm', title: 'Rename the heading?' }], tail: [] });
  await until(`document.querySelector('#askPanel .rc-ui .rc-dialog')`, 'the agent’s question is not in the panel');
  assert.equal(await text('#askPanel .askp-now'), 'Waiting for your answer below');
  await b.screenshot('ask-panel-live.png');
  // It settles: the live part goes, the text is given back.
  await ev(`live.onmessage({ data: ${JSON.stringify(JSON.stringify({ type: 'run-event', jobId: 'run:test', key: KEY, status: 'done', final: true, excerpt: 'The heading now says Field notes.' }))} })`);
  await until(`document.querySelector('#askPanel .askp-live').hidden && !fileWs.run`, 'the live part stayed after the run');
  await until(`docState.editor.view.state.readOnly === false`, 'the editor stayed locked');

  // ---- the ask box's "details" opens it; its settled line says the agent's words ----
  await ev(`AskPanel.close()`);
  assert.equal(await shows('#askPanel'), false);
  await ev(`fileWsToggleAsk(true)`);
  await until(`document.querySelector('.ask-bubble .ask-text')`, 'the ask box did not open');
  await ev(`document.querySelector('.ask-text').value = 'shorter still'`);
  await key('Enter', 'Enter', 13);
  await until(`askSent.length === 2 && fileWs.run`, 'the box did not send');
  await ev(`live.onmessage({ data: ${JSON.stringify(JSON.stringify({ type: 'run-event', jobId: 'run:test', key: KEY, status: 'done', final: true, excerpt: 'Nothing needed to change.' }))} })`);
  await until(`document.querySelector('.ask-bubble .ask-said')`, 'the settled line has no words from the agent');
  assert.equal(await text('.ask-bubble .ask-said'), '\u201cNothing needed to change.\u201d');
  await ev(`document.querySelector('.ask-bubble [data-run-open]').click()`);
  await until(`AskPanel.showing(${JSON.stringify(KEY)}) && !document.querySelector('.ask-bubble')`, '"details" did not open the panel');
  assert.equal(await ev(`viewKind`), 'file', '"details" keeps the file on screen');

  // ---- a reply typed and not sent stays; Esc closes and gives the text back ----
  await ev(`document.querySelector('#askPanel .askp-text').focus()`);
  await command('Input.insertText', { text: 'half a thought' });
  await key('Escape', 'Escape', 27);
  await until(`!AskPanel.showing() && document.activeElement === docState.editor.view.contentDOM`, 'Esc did not close the panel');
  await ev(`AskPanel.open(fileWs, ${JSON.stringify(KEY)})`);
  assert.equal(await ev(`document.querySelector('#askPanel .askp-text').value`), 'half a thought', 'the typed reply came back');

  // ---- it belongs to the file: gone with it, back with it ----
  await b.open('other.md', { project: null });
  await until(`fileWs && fileWs.path.endsWith('other.md') && fileWs.editor`, 'the other file did not open');
  assert.equal(await shows('#askPanel'), false, 'another file has no panel');
  await b.open('notes.md', { project: null });
  await until(`fileWs && fileWs.path.endsWith('notes.md') && AskPanel.showing(${JSON.stringify(KEY)})`, 'the panel did not come back with its file');

  // ---- "full page": the conversation's own page, with the very same groups ----
  const panelGroups = await ev(`[...document.querySelectorAll('#askPanel .askp-turns .askp-work')].map(g => g.dataset.gkey + ':' + [...g.querySelectorAll('[data-step]')].map(s => s.dataset.step).join(','))`);
  await ev(`document.querySelector('#askPanel .askp-full').click()`);
  await until(`viewKind === 'conversation' && document.querySelector('#view .toolgroup[data-gkey]')`, 'full page did not open the conversation');
  assert.equal(await shows('#askPanel'), false, 'the panel goes with the file');
  const pageGroups = await ev(`[...document.querySelectorAll('#view .toolgroup[data-gkey]')].map(g => g.dataset.gkey + ':' + [...new Set([...g.querySelectorAll(':scope > [data-step]')].map(s => s.dataset.step))].join(','))`);
  assert.deepEqual(panelGroups, pageGroups.slice(0, panelGroups.length), 'the panel groups the steps as the full page does');
  await b.open('notes.md', { project: null });
  await until(`fileWs && fileWs.path.endsWith('notes.md') && AskPanel.showing(${JSON.stringify(KEY)})`, 'the panel did not come back after the full page');

  // ---- a narrow window: over the text; a phone: the whole screen ----
  await b.size(900, 800);
  await until(`getComputedStyle(document.querySelector('#askPanel')).position === 'fixed'`, 'the panel does not lie over the text in a narrow window');
  await b.size(390, 800, true);
  await until(`(() => { const r = document.querySelector('#askPanel').getBoundingClientRect(); return r.left === 0 && r.width === innerWidth; })()`, 'the panel is not a full sheet on a phone');
  await b.screenshot('ask-panel-phone.png');
  // Android's back button closes it before it leaves the file.
  assert.equal(await ev(`chatteringBack()`), true);
  assert.equal(await ev(`AskPanel.showing()`), false, 'back did not close the sheet');
  assert.equal(await ev(`viewKind`), 'file');
  await b.size(1440, 1000);
  assert.deepEqual(b.exceptions, []);
});

test('steps said in plain words, without a model', () => {
  const vm = require('node:vm');
  const context = { window: {}, globalThis: {}, document: { body: { classList: { toggle() {} } } }, localStorage: {}, sessionStorage: {} };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ask-panel.js'), 'utf8'), context);
  const { stepPhrase, groupLine } = context.window.AskPanel;
  const here = '/w/notes.md';
  assert.equal(stepPhrase('read', { path: '/w/notes.md' }, { here }), 'Read this file');
  assert.equal(stepPhrase('read', { path: 'notes.md' }, { here }), 'Read this file');
  assert.equal(stepPhrase('edit', '{"path":"/w/other.py","edits":[', { live: true, here }), 'Changing other.py…', 'arguments still streaming in');
  assert.equal(stepPhrase('bash', { command: 'cd /w && rg -n foo' }), 'Searched the files');
  assert.equal(stepPhrase('bash', { command: 'rat run --doc x.md py "1"' }, { live: true }), 'Running code in the notebook…');
  assert.equal(stepPhrase('bash', { command: 'git log -3' }), 'Checked the project’s history');
  assert.equal(stepPhrase('bash', { command: 'uv pip install pandas' }), 'Installed what the code needs');
  assert.equal(stepPhrase('bash', { command: 'make' }, { failed: true }), 'Built and tested the code — it did not work');
  assert.equal(stepPhrase('mystery_tool', {}), 'Used mystery_tool');
  assert.equal(groupLine(['Thought it over', 'Read this file', 'Read this file', 'Ran a command']), 'Read this file ×2 · Ran a command');
  assert.equal(groupLine(['Thought it over']), 'Thought it over');
  assert.equal(groupLine(['A', 'B', 'C', 'D', 'E']), 'A · B · C · and 2 more');
});
