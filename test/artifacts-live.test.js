'use strict';
// Artifacts that arrive while a conversation is on screen (design/67, design/95).
// A live update draws only the parts that changed; what it brings must be
// wired like a full drawing (widgets load, cards open, code gets its
// preview), and a widget already loaded must not load again when the part
// it stands in is drawn anew.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { viewerBrowser } = require('./helpers/viewer-browser.js');
const { chromiumAvailable } = require('./helpers/chromium.js');

const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test('artifacts brought by a live update show without a reload, and a loaded widget stays loaded', { timeout: 120000 }, async t => {
  if (!chromiumAvailable()) return t.skip('chromium is not installed');
  let clock = 0;
  const ts = () => new Date(Date.UTC(2026, 8, 1, 12, 0, clock++)).toISOString();
  const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
  const assistant = (id, parentId, content) => ({ type: 'message', id, parentId, timestamp: ts(), message: { role: 'assistant', model: 'm', provider: 'p', content } });
  const result = (id, parentId, callId, name) => ({ type: 'message', id, parentId, timestamp: ts(), message: { role: 'toolResult', toolCallId: callId, toolName: name, content: [{ type: 'text', text: 'ok' }], isError: false } });
  const widget = label => `<!doctype html><html><head></head><body style="margin:0"><div style="height:300px">${label}</div></body></html>`;
  const lines = entries => entries.map(JSON.stringify).join('\n') + '\n';
  let chat = null;
  const previewPort = await freePort();
  const b = await viewerBrowser(t, {
    env: { CHATTERING_PREVIEW_PORT: String(previewPort) },
    setup: home => {
      const work = path.join(home, 'work');
      fs.mkdirSync(path.join(work, 'site'), { recursive: true });
      fs.writeFileSync(path.join(work, 'site', 'index.html'), '<!doctype html><title>site</title><h1>SITE</h1>');
      chat = path.join(home, '.pi/agent/sessions/fixture/chat.jsonl');
      fs.writeFileSync(chat, lines([
        { type: 'session', version: 3, id: 'live-artifacts', cwd: work },
        { type: 'message', id: 'u1', parentId: null, timestamp: ts(), message: { role: 'user', content: [{ type: 'text', text: 'Make me a widget' }] } },
        assistant('a1', 'u1', [{ type: 'text', text: 'Starting.' }]),
      ]));
    },
  });
  const key = 'pi:fixture/chat.jsonl';
  // On localhost, so each widget gets its own *.localhost preview site.
  await b.command('Page.navigate', { url: `http://localhost:${new URL(b.base).port}/?token=${b.token}#${encodeURIComponent(key)}` });
  await b.until(`typeof current !== 'undefined' && current && current.key === ${JSON.stringify(key)} && /Starting\\./.test(document.getElementById('conversationTranscript')?.textContent || '')`, 'the conversation');
  await b.evaluate(`document.querySelector('dialog.bg-ask [data-none]')?.click(); 1`);
  // Kept by a patch, gone with a whole drawing: the updates below must take
  // the live path, the one that lost artifacts.
  await b.evaluate(`document.getElementById('conversationTranscript')._probe = 1; 1`);
  const patched = `document.getElementById('conversationTranscript')?._probe === 1`;

  // The run shows a widget.
  fs.appendFileSync(chat, lines([assistant('a2', 'a1', [call('w1', 'show', { html: widget('FIRST WIDGET'), title: 'First' })]), result('r1', 'a2', 'w1', 'show')]));
  const w1 = `document.querySelector('.art-widget[data-art-call="w1"] iframe')`;
  await b.until(`${w1} && parseInt(${w1}.style.height) >= 290`, async () => 'the first widget, loaded and sized, without a reload: ' + await b.evaluate(`document.querySelector('.art-widget[data-art-call="w1"]')?.outerHTML.slice(0, 400) || 'no widget'`));
  assert.equal(await b.evaluate(patched), true, 'drawn by a live update, not a whole drawing');
  // Its frame from now on: the same element, never loaded again.
  await b.evaluate(`(() => { const f = ${w1}; window.__w1 = f; window.__w1Loads = 0; f.addEventListener('load', () => window.__w1Loads++); return 1; })()`);

  // In the same steps: a second widget and an artifact; then an answer with
  // code. The strip of artifacts under these steps is drawn anew.
  fs.appendFileSync(chat, lines([
    assistant('a3', 'r1', [call('w2', 'show', { html: widget('SECOND WIDGET'), title: 'Second' }), call('art', 'artifact', { path: 'site', title: 'The site' })]),
    result('r2', 'a3', 'w2', 'show'), result('r3', 'r2', 'art', 'artifact'),
    assistant('a4', 'r3', [{ type: 'text', text: 'Done.\n\n```html\n<p>CODE BLOCK PAGE</p>\n```' }]),
  ]));
  const w2 = `document.querySelector('.art-widget[data-art-call="w2"] iframe')`;
  await b.until(`${w2} && parseInt(${w2}.style.height) >= 290`, async () => 'the second widget, loaded and sized: ' + await b.evaluate(`JSON.stringify({ figs: [...document.querySelectorAll('.art-widget')].map(f => [f.dataset.artCall, f.dataset.mounted || '', f.isConnected, f.closest('.art-kept') ? 'kept' : 'shown', f.querySelector('iframe')?.style.height || f.textContent.slice(0, 80)]), msgs: current.messages.map(m => m.role + ':' + (m.eid || '') + (m.artifact ? '[' + m.artifact.kind + ']' : '')).join(' '), html: document.getElementById('conversationTranscript').innerHTML.replace(/\\s+/g, ' ').slice(-2500) })`));
  await b.until(`typeof document.querySelector('.art-card .art-open')?.onclick === 'function'`, 'the artifact card, ready to open');
  await b.until(`document.querySelector('pre.md-code[data-lang="html"] .md-preview')`, 'the code preview button');
  assert.equal(await b.evaluate(patched), true, 'still live updates, not a whole drawing');
  const canMove = await b.evaluate(`typeof Element.prototype.moveBefore === 'function'`);
  if (canMove) {
    assert.equal(await b.evaluate(`${w1} === window.__w1`), true, 'the first widget is the same frame');
    assert.equal(await b.evaluate(`window.__w1Loads`), 0, 'the first widget did not load again');
    assert.equal(await b.evaluate(`document.querySelectorAll('.art-widget[data-art-call="w1"]').length`), 1, 'one first widget');
  }
  // Nothing is left set aside once the update is done.
  await b.until(`!document.querySelector('.art-kept .art-widget')`, 'no widget left aside');

  // A whole drawing of the same conversation keeps it loaded too.
  await b.evaluate(`renderConv('preserve')`);
  await b.until(`${w1} && !document.querySelector('.art-kept .art-widget')`, 'drawn whole');
  assert.equal(await b.evaluate(patched), false, 'that was a whole drawing');
  if (canMove) {
    assert.equal(await b.evaluate(`${w1} === window.__w1 && window.__w1Loads === 0`), true, 'the first widget survived the whole drawing');
    assert.equal(await b.evaluate(`parseInt(${w1}.style.height) >= 290`), true, 'at its size, with no jump back to the placeholder');
  }

  // A card whose copy could not be kept has no Open button: wiring it is not
  // an error (it would stop the rest of a live update's wiring).
  assert.equal(await b.evaluate(`(() => { const t = document.createElement('div'); t.innerHTML = artifactCardsHtml(current.key, [{ role: 'tool', eid: 'x', artifact: { kind: 'files', path: '/gone', title: 'Gone', type: 'web', publishedBy: 'Claude Code', missing: true } }]); Artifacts.wire(t.firstElementChild); return !t.querySelector('.art-open'); })()`), true);

  // Another conversation: nothing of this one is carried across.
  await b.evaluate(`open('pi:fixture/media.jsonl', 'bottom')`);
  await b.until(`current && current.key === 'pi:fixture/media.jsonl' && !document.querySelector('.art-widget')`, 'the other conversation');
  await b.until(`!document.querySelector('.art-kept .art-widget')`, 'the widgets of the one left are gone');
  assert.deepEqual(b.exceptions.filter(e => !/ResizeObserver/.test(e)), []);
});

// A run started here is drawn from its live steps until it ends, then the
// saved conversation is drawn once (app.html reconcileTranscript). Its
// artifacts show in the live view as soon as their call finishes, the panel
// opens then, and the end draws the saved conversation even when the reader
// is further up, keeping their place; a widget stays the same frame.
test('artifacts of a run started here show while it runs, and its end draws them wherever the reader is', { timeout: 120000 }, async t => {
  if (!chromiumAvailable()) return t.skip('chromium is not installed');
  let clock = 0, t0 = Date.now() - 60000;
  const ts = () => new Date(t0 + 10 * clock++).toISOString();
  const call = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
  const assistant = (id, parentId, content) => ({ type: 'message', id, parentId, timestamp: ts(), message: { role: 'assistant', model: 'm', provider: 'p', content } });
  const result = (id, parentId, callId, name) => ({ type: 'message', id, parentId, timestamp: ts(), message: { role: 'toolResult', toolCallId: callId, toolName: name, content: [{ type: 'text', text: 'ok' }], isError: false } });
  const lines = entries => entries.map(JSON.stringify).join('\n') + '\n';
  const widgetPage = '<!doctype html><html><head></head><body style="margin:0"><div style="height:300px">RUN WIDGET</div></body></html>';
  const answer = 'Here is the gallery, open beside.\n\n' + Array.from({ length: 60 }, (_, i) => `Paragraph ${i} of the answer.`).join('\n\n');
  let chat = null;
  const previewPort = await freePort();
  const b = await viewerBrowser(t, {
    env: { CHATTERING_PREVIEW_PORT: String(previewPort) },
    setup: home => {
      const work = path.join(home, 'work');
      fs.mkdirSync(path.join(work, 'site'), { recursive: true });
      fs.writeFileSync(path.join(work, 'site', 'index.html'), '<!doctype html><title>site</title><h1>SITE</h1>');
      chat = path.join(home, '.pi/agent/sessions/fixture/chat.jsonl');
      fs.writeFileSync(chat, lines([
        { type: 'session', version: 3, id: 'hosted-artifacts', cwd: work },
        { type: 'message', id: 'u1', parentId: null, timestamp: ts(), message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
        assistant('a1', 'u1', [{ type: 'text', text: 'Starting.' }]),
      ]));
    },
  });
  const key = 'pi:fixture/chat.jsonl', ev = b.evaluate;
  await b.command('Page.navigate', { url: `http://localhost:${new URL(b.base).port}/?token=${b.token}#${encodeURIComponent(key)}` });
  await b.until(`typeof current !== 'undefined' && current && current.key === ${JSON.stringify(key)} && /Starting\\./.test(document.getElementById('conversationTranscript')?.textContent || '')`, 'the conversation');
  await ev(`document.querySelector('dialog.bg-ask [data-none]')?.click(); 1`);
  // The run's events, as the server sends them (server.js runEventForwarder).
  const run = obj => ev(`live.onmessage({ data: ${JSON.stringify(JSON.stringify({ type: 'run-event', jobId: 'job1', key, ...obj }))} }); 1`);
  const startedAt = Date.now();
  const tool = (id, callId, name, args, phase) => ({ id, kind: 'tool', callId, name, args: '', rawArgs: JSON.stringify(args), out: phase === 'done' ? 'ok' : '', phase });
  const steps = phase => [
    tool('b1', 'w1', 'show', { html: widgetPage, title: 'Run widget' }, phase),
    tool('b2', 'art', 'artifact', { path: 'site', title: 'The site' }, phase),
  ];
  await run({ status: 'running', statusText: 'running', startedAt, node: 'a1', model: 'p/m', tail: steps('running') });
  // The run writes its question and the calls (Pi saves a message when it ends).
  t0 = Date.now(); clock = 0;
  fs.appendFileSync(chat, lines([
    { type: 'message', id: 'u2', parentId: 'a1', timestamp: ts(), message: { role: 'user', content: [{ type: 'text', text: 'Make the gallery' }] } },
    assistant('a2', 'u2', [call('w1', 'show', { html: widgetPage, title: 'Run widget' }), call('art', 'artifact', { path: 'site', title: 'The site' })]),
  ]));
  await new Promise(r => setTimeout(r, 300));
  // Nothing before the calls finish.
  assert.equal(await ev(`document.querySelectorAll('#liveReplies [data-live-arts] [data-art-call]').length`), 0, 'no artifact before its call finished');
  fs.appendFileSync(chat, lines([result('r1', 'a2', 'w1', 'show'), result('r2', 'r1', 'art', 'artifact')]));
  await run({ status: 'running', tail: steps('done') });

  // While it runs: the widget loads and the card opens, in the live view.
  const liveFrame = `document.querySelector('#liveReplies .art-widget[data-art-call="w1"] iframe')`;
  await b.until(`${liveFrame} && parseInt(${liveFrame}.style.height) >= 290`, async () => 'the widget in the live view, loaded: ' + await ev(`document.getElementById('liveReplies').innerHTML.replace(/\\s+/g, ' ').slice(-1500)`));
  await b.until(`typeof document.querySelector('#liveReplies .art-card[data-art-call="art"] .art-open')?.onclick === 'function'`, 'the card in the live view, ready to open');
  await b.until(`document.body.classList.contains('artifact-open') && Artifacts.state()?.path === 'site'`, 'the panel opened while the run goes on');
  assert.equal(await ev(`document.querySelectorAll('#conversationTranscript .art-widget, #conversationTranscript .art-card').length`), 0, 'the saved conversation was not drawn yet');
  // More events redraw the live view: the widget stays the same frame.
  await ev(`window.__runFrame = ${liveFrame}; window.__runLoads = 0; window.__runFrame.addEventListener('load', () => window.__runLoads++); 1`);
  await run({ status: 'running', tail: [...steps('done'), { id: 'x1', kind: 'text', text: answer.slice(0, 200) }] });
  await run({ status: 'running', tail: [...steps('done'), { id: 'x1', kind: 'text', text: answer, done: true }] });
  await b.until(`/Paragraph 59/.test(document.getElementById('liveReplies').textContent)`, 'the whole answer, live');
  const canMove = await ev(`typeof Element.prototype.moveBefore === 'function'`);
  assert.equal(await ev(`${liveFrame} === window.__runFrame`), true, 'one frame while the run streams');

  // The reader goes up into the answer, then the run ends.
  fs.appendFileSync(chat, lines([assistant('a3', 'r2', [{ type: 'text', text: answer }])]));
  // The server sends the run's end once it has read the file (server.js).
  for (let i = 0; ; i++) {
    const d = await (await fetch(b.base + '/api/session?id=' + encodeURIComponent(key), { headers: b.auth })).json();
    if (d.messages?.some(m => m.eid === 'a3')) break;
    assert.ok(i < 200, 'the server read the answer');
    await new Promise(r => setTimeout(r, 50));
  }
  // With the wheel, as a person does (a scroll the app made itself would not
  // end its following of the end).
  const wheel = deltaY => b.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 400, deltaX: 0, deltaY });
  await wheel(-1600);
  await b.until(`!readerAtTail() && [...document.querySelectorAll('#liveReplies .msg p')].some(p => { const r = p.getBoundingClientRect(); return r.top > 300 && r.top < 700; })`, 'the reader inside the answer, away from the end');
  // A paragraph in the middle of the screen: it must not move. (Near the
  // very end, the page itself may get shorter when the run's bottom bar goes.)
  const paraText = await ev(`[...document.querySelectorAll('#liveReplies .msg p')].find(p => { const r = p.getBoundingClientRect(); return r.top > 300 && r.top < 700; }).textContent`);
  const para = `[...document.querySelectorAll('#view .msg.assistant p')].find(p => p.textContent === ${JSON.stringify(paraText)})`;
  const at = () => ev(`Math.round(${para}.getBoundingClientRect().top)`);
  const before = await at();
  // Without the browser's own scroll anchoring (Safari has none): the
  // reader's place is kept by the app.
  await ev(`document.getElementById('view').style.overflowAnchor = 'none'; 1`);
  await run({ final: true, status: 'done', finishedAt: Date.now() });
  await b.until(`document.querySelector('#conversationTranscript .art-widget[data-art-call="w1"] iframe') && document.querySelector('#conversationTranscript .art-card[data-art-call="art"]') && !document.querySelector('#liveReplies [data-live-arts]')`,
    async () => 'the saved conversation, with its artifacts, though the reader is not at the end: ' + await ev(`JSON.stringify({ reload: !!document.getElementById('convReload'), live: document.getElementById('liveReplies').textContent.slice(0, 200), msgs: current.messages.length })`));
  assert.equal(await ev(`document.querySelectorAll('.art-widget[data-art-call="w1"]').length`), 1, 'one widget');
  assert.equal(await ev(`!document.getElementById('convReload')`), true, 'no button to press');
  assert.ok(Math.abs(await at() - before) <= 2, `the paragraph being read stays where it was (${before} → ${await at()})`);
  assert.equal(await ev(`readerAtTail()`), false, 'the reader was not taken to the end');
  if (canMove) assert.equal(await ev(`document.querySelector('#conversationTranscript .art-widget[data-art-call="w1"] iframe') === window.__runFrame && window.__runLoads === 0`), true, 'the widget the run showed is the saved one, not loaded again');
  assert.equal(await ev(`document.body.classList.contains('artifact-open') && Artifacts.state()?.path`), 'site', 'the panel stays');

  // An update while the reader is further up (an agent of another program):
  // a button; back at the end, it is drawn without pressing it.
  fs.appendFileSync(chat, lines([{ type: 'message', id: 'u3', parentId: 'a3', timestamp: ts(), message: { role: 'user', content: [{ type: 'text', text: 'LATER QUESTION' }] } }]));
  await b.until(`document.getElementById('convReload')`, 'the button, while the reader is further up');
  assert.doesNotMatch(await ev(`document.getElementById('conversationTranscript').textContent`), /LATER QUESTION/);
  await wheel(5000);
  await b.until(`/LATER QUESTION/.test(document.getElementById('conversationTranscript').textContent) && !document.getElementById('convReload')`, 'drawn once the reader is back at the end');
  assert.deepEqual(b.exceptions.filter(e => !/ResizeObserver/.test(e)), []);
});
