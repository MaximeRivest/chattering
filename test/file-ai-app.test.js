'use strict';
// AI commands beyond Markdown, in the app: a source file and a plain-text
// file get their own commands in the Ctrl+J box, the ✦, the model's answer
// beside the text or for review, and a record of what became of it; a
// note opens in the same file editor. The server is real; only the model
// is answered by the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('AI commands in source and text files, and notes in the file editor', { timeout: 60000 }, async t => {
  const b = await viewerBrowser(t);
  const { evaluate: ev, until, command } = b;
  fs.writeFileSync(path.join(b.work, 'calc.py'), '# Adds two numbers.\ndef add(a, b):\n    return a + b\n');
  fs.writeFileSync(path.join(b.work, 'notes.txt'), 'Their going to the store.\n');
  const notes = path.join(b.home, 'notes', 'chattering');
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'memo.md'), '# Memo\n\n## First\n\nOne.\n\n## Second\n\nTwo.\n');
  await until(`sessions.length && nav.current()`);
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  const key = async (key, code, vk, modifiers = 0) => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
  };
  // The model, answered by the page: the target, with names made longer.
  await ev(`(() => {
    window.aiAsked = [];
    const real = window.fetch;
    window.fetch = (url, opts) => {
      if (String(url).endsWith('/api/doc/ai') && opts && opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        aiAsked.push(body);
        const text = body.request.target.text.replace('add(a, b)', 'add(first, second)').replace('a + b', 'first + second').replace('Their', "They're");
        return Promise.resolve(new Response(JSON.stringify({ type: 'done', text, model: 'fixture/model' }) + '\\n', { headers: { 'Content-Type': 'application/x-ndjson' } }));
      }
      if (String(url).endsWith('/api/doc/ai')) return Promise.resolve(new Response(JSON.stringify({ available: true, model: 'fixture/model' })));
      return real(url, opts);
    };
    aiCommandMode.set('review');
  })()`);

  // A source file: the box lists the source file's commands, for the function at the cursor.
  await b.open('calc.py', { project: null });
  await until(`fileWs && fileWs.kind === 'code' && fileWs.editor && fileWs.editor.openAiMenu`, 'the source file did not open');
  await ev(`(() => { const v = fileWs.editor.view; v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('return') } }); v.focus(); })()`);
  await until(`document.querySelector('.mrmd-ai-spark-gutter .cm-gutterElement:not([style*="visibility"]) .mrmd-ai-spark')`, 'no ✦ in the source file');
  const { MOD } = require('./helpers/chromium.js');
  await key('j', 'KeyJ', 74, MOD.bit);
  await until(`document.activeElement?.classList.contains('mrmd-ai-menu-input')`, `${MOD.name}+J did not open the box in the source file`);
  const labels = await ev(`[...document.querySelectorAll('.mrmd-ai-menu-label')].map(e => e.textContent)`);
  assert.ok(labels.includes('Finish this block') && labels.includes('Improve names'), labels.join());
  assert.ok(!labels.includes('Fix grammar and spelling') && !labels.includes('Finish this cell'), labels.join());
  assert.match(await ev(`document.querySelector('.mrmd-ai-menu-head').textContent`), /lines 1–3/);
  assert.equal(await ev(`helpNow()[0].label`), 'AI command box');
  await command('Input.insertText', { text: 'names' });
  await key('Enter', 'Enter', 13);
  // Review mode: the answer is in the text, to accept or reject.
  await until(`fileWs.editor.review.summary().changes === 1`, 'the answer is not under review');
  assert.deepEqual(await ev(`[aiAsked[0].command, aiAsked[0].request.target.text, aiAsked[0].request.block.language]`), ['names', '# Adds two numbers.\ndef add(a, b):\n    return a + b', 'python']);
  await key('y', 'KeyY', 89, 1); // on the first changed line, where the answer put the cursor
  await until(`fileWs.editor.review.summary().changes === 0 && fileWs.editor.getContent().includes('add(first, second)')`, 'Alt+Y did not accept');
  const records = async () => (await (await fetch(b.base + '/api/ai-feedback?limit=20', { headers: b.auth })).json()).records;
  let rec;
  for (let i = 0; i < 100 && !(rec = (await records()).find(r => r.command === 'names')); i++) await new Promise(r => setTimeout(r, 30));
  assert.ok(rec, 'the command was not recorded');
  assert.deepEqual([rec.decision, rec.language, rec.path], ['accepted', 'python', path.join(b.work, 'calc.py')]);
  // The file follows the text (a shared file saves as you type).
  for (let i = 0; i < 100 && !fs.readFileSync(path.join(b.work, 'calc.py'), 'utf8').includes('first'); i++) await new Promise(r => setTimeout(r, 50));
  assert.match(fs.readFileSync(path.join(b.work, 'calc.py'), 'utf8'), /def add\(first, second\)/);

  // Plain text: prose commands, on the paragraph; suggest mode, Tab accepts.
  await ev(`aiCommandMode.set('suggest')`);
  await b.open('notes.txt', { project: null });
  await until(`fileWs && fileWs.path.endsWith('notes.txt') && fileWs.editor && fileWs.editor.runAiCommand`, 'the text file did not open');
  await ev(`(() => { const v = fileWs.editor.view; v.dispatch({ selection: { anchor: 3 } }); v.focus(); })()`);
  assert.equal(await ev(`fileWs.editor.runAiCommand('names')`), false, 'no code commands in plain text');
  assert.equal(await ev(`fileWs.editor.runAiCommand('grammar')`), true);
  await until(`document.querySelector('.mrmd-ai-panel, .mrmd-ai-ghost')`, 'no suggestion in the text file');
  await key('Tab', 'Tab', 9);
  await until(`fileWs.editor.getContent().startsWith("They're going")`, 'Tab did not accept in the text file');

  // A note: "edit" opens it in the file editor, at the section.
  await ev(`editNoteFile('~/notes/chattering/memo.md', 7)`);
  await until(`fileWs && fileWs.path === ${JSON.stringify(path.join(notes, 'memo.md'))} && docState && docState.editor && docState.editor.openAiMenu`, 'the note did not open in the file editor');
  await until(`docState.editor.selection().line === 7`, 'the note did not open at its section');
  assert.deepEqual(b.exceptions, []);
});
