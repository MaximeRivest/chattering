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
