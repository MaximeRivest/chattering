'use strict';
// How files look, on this device: text size in every file editor, long
// lines wrapping in code and text files, and the documents' width and font
// — from the keys in the text, the ⋯ menu and Settings, kept per browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('text size, wrapping, document width and font', { timeout: 60000 }, async t => {
  const b = await viewerBrowser(t);
  const { evaluate: ev, until, command } = b;
  fs.writeFileSync(path.join(b.work, 'long.py'), 'x = "' + 'long '.repeat(80) + '"\n');
  fs.writeFileSync(path.join(b.work, 'doc.md'), '# Title\n\nSome prose.\n\n```python\nx = 1\n```\n');
  await until(`sessions.length && nav.current()`);
  await ev(`localStorage.removeItem('chattering.fileView.v1'); applyFileViewStyle()`);
  const key = async (key, code, vk, modifiers = 0) => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const px = sel => ev(`parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(sel)})).fontSize)`);

  // A code file: wraps by default; Alt+Z scrolls sideways, and it sticks.
  await b.open('long.py', { project: null });
  await until(`fileWs && fileWs.kind === 'code' && fileWs.editor && fileWs.editor.setLineWrapping`, 'the code file did not open');
  await ev(`fileWs.editor.focus()`);
  const wraps = () => ev(`fileWs.editor.view.contentDOM.classList.contains('cm-lineWrapping')`);
  assert.equal(await wraps(), true);
  await key('z', 'KeyZ', 90, 1);
  assert.equal(await wraps(), false);
  assert.equal(await ev(`JSON.parse(localStorage.getItem('chattering.fileView.v1')).wrap`), false);
  assert.equal(await ev(`document.querySelector('.live-more [data-fv="wrap"]').checked`), false, 'the menu follows');

  // Text size: Alt+= twice, then the menu's reset.
  const base = await px('.code-host .cm-content');
  await key('=', 'Equal', 187, 1);
  await key('=', 'Equal', 187, 1);
  assert.equal(Math.round(await px('.code-host .cm-content') * 100 / base), 120);
  assert.equal(await ev(`document.querySelector('.live-more [data-fv-size]').textContent`), '120%');
  await ev(`document.querySelector('.live-more [data-fv="reset"]').click()`);
  assert.equal(await px('.code-host .cm-content'), base);

  // Reopened, the code file keeps the device's wrapping.
  await b.open('doc.md', { project: null });
  await until(`docState && docState.editor && fileWs.kind === 'md'`, 'the document did not open');
  await b.open('long.py', { project: null });
  await until(`fileWs && fileWs.path.endsWith('long.py') && fileWs.editor && fileWs.editor.view`, 'the code file did not reopen');
  assert.equal(await wraps(), false);

  // A document: the menu has width and font; code in it stays monospace.
  await b.open('doc.md', { project: null });
  await until(`docState && docState.editor && fileWs.kind === 'md' && document.querySelector('.live-more [data-fv="font"]')`, 'the document did not open');
  assert.equal(await ev(`!!document.querySelector('.live-more [data-fv="wrap"]')`), false, 'documents always wrap');
  const family = sel => ev(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).fontFamily`);
  const mono = await family('.doc-editor-host .cm-content');
  await ev(`(() => { const s = document.querySelector('.live-more [data-fv="font"]'); s.value = 'serif'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.match(await family('.doc-editor-host .cm-content'), /Georgia/);
  assert.equal(await family('.doc-editor-host .cm-md-codeblock-line'), mono, 'code in a document stays monospace');
  const width = () => ev(`document.querySelector('#docEditor').getBoundingClientRect().width`);
  const setWidth = v => ev(`(() => { const s = document.querySelector('.live-more [data-fv="width"]'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await setWidth('narrow');
  const narrow = await width();
  assert.equal(narrow, 760);
  await ev(`setFileViewPrefs({ scale: 1.2 })`);
  assert.equal(await width(), 912, 'a narrow column grows with the text');
  await ev(`setFileViewPrefs({ scale: 1 })`);
  await setWidth('full');
  assert.ok(await width() > narrow + 200, 'the whole window');
  await ev(`document.querySelector('.live-more').open = true`);
  await b.screenshot('file-view-menu.png');

  // Settings → appearance has the same controls, on the same prefs.
  await ev(`showSettings('appearance')`);
  await until(`document.querySelector('.settings-pane .fv-controls [data-fv="font"]')`, 'no controls in settings');
  assert.equal(await ev(`document.querySelector('.settings-pane [data-fv="font"]').value`), 'serif');
  assert.equal(await ev(`document.querySelector('.settings-pane [data-fv="wrap"]').checked`), false);
  assert.deepEqual(b.exceptions, []);
});
