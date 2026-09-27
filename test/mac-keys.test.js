'use strict';
// The keyboard on a Mac, checked on any system. Chrome can report a Mac
// (navigator.platform "MacIntel"), and that is what the page and its editor
// (CodeMirror) both read. On a Mac the command key is ⌘ and Ctrl keeps its
// text meaning: Ctrl+K deletes to the line's end, so it must not also open
// the ask box, and labels must name ⌘, the key that works.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

const MAC = { platform: 'MacIntel',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36' };

test('on a Mac: ⌘ opens the ask box, Ctrl+K stays the editor’s own, labels say ⌘', { timeout: 60000 }, async t => {
  const b = await viewerBrowser(t);
  const { evaluate: ev, until, command } = b;
  fs.writeFileSync(path.join(b.work, 'keys.md'), '# Keys\n\nFirst line of text.\n\nSecond line.\n');
  await until(`sessions.length && nav.current()`);
  await until(`!document.querySelector('dialog.bg-ask')`, 'the first-run question stayed');
  // The platform is read once, as the page loads: report a Mac, then reload.
  await command('Emulation.setUserAgentOverride', MAC);
  await ev(`window.beforeReload = true`); // gone once the new page is there
  await command('Page.reload');
  await until(`!window.beforeReload && navigator.platform === 'MacIntel' && typeof openLiveFile === 'function' && typeof load === 'function' && sessions.length`, 'the page did not load as a Mac');
  await b.open('keys.md', { project: null });
  await until(`docState && docState.path.endsWith('keys.md') && fileWs && fileWs.editor`, 'the document did not open');
  await command('Emulation.setFocusEmulationEnabled', { enabled: true });
  const key = async (key, code, vk, modifiers) => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
  };

  // Labels name the key that works here.
  assert.match(await ev(`document.getElementById('liveAi').textContent`), /\(⌘J\)/);
  assert.match(await ev(`document.getElementById('liveAskMenu').textContent`), /\(⌘K\)/);

  // Ctrl+K (DevTools modifier 2): the Mac's delete to the line's end, and no ask box.
  await ev(`(() => { const v = docState.editor.view; v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('line of text') } }); v.focus(); })()`);
  await key('k', 'KeyK', 75, 2);
  await until(`!docState.editor.view.state.doc.toString().includes('line of text')`, 'Ctrl+K did not delete to the line’s end');
  assert.match(await ev(`docState.editor.view.state.doc.toString()`), /\nFirst \n/);
  assert.equal(await ev(`!!document.querySelector('.ask-text')`), false, 'Ctrl+K opened the ask box as well');

  // ⌘K (modifier 4): the ask box, focused.
  await key('k', 'KeyK', 75, 4);
  await until(`document.activeElement?.classList.contains('ask-text')`, '⌘K did not open the ask box');
  assert.equal(await ev(`docState.editor.view.state.doc.toString().includes('Second line.')`), true, '⌘K left the text alone');
});
