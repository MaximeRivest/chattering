'use strict';
// Beside (design/104), in a real browser: the right column holds tabs. A
// project's folder goes beside a conversation; a PDF opened from it opens in
// that tab and ‹ goes back to the folder; a pinned tab stays beside other
// conversations, an unpinned one follows its own; a file edited full page
// leaves the file beside readable, and "Edit it here" swaps; a file and a
// folder go from the middle to Beside with ◨; Alt+B puts it away and the
// corner says how many tabs wait; the desk survives a reload; a narrow
// window keeps the middle in front after a move; things that open by
// themselves never take a pinned tab's place.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromiumAvailable } = require('./helpers/chromium.js');
const { viewerBrowser, samplePDF } = require('./helpers/viewer-browser.js');

const KEY = 'pi:fixture/beside.jsonl';
const OTHER = 'pi:fixture/media.jsonl';

function setup(home) {
  const work = path.join(home, 'work');
  fs.mkdirSync(path.join(work, 'papers'));
  fs.writeFileSync(path.join(work, 'papers', 'lorenz1963.pdf'), samplePDF());
  fs.writeFileSync(path.join(work, 'notes.md'), '# Notes\n\nAbout predictability.\n');
  fs.writeFileSync(path.join(work, 'draft.md'), '# Draft\n\nSecond file.\n');
  fs.writeFileSync(path.join(home, '.pi/agent/sessions/fixture/beside.jsonl'), [
    { type: 'session', version: 3, id: 'beside', cwd: work },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-09-01T12:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'Which papers argue scale matters?' }] } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-09-01T12:00:02Z', message: { role: 'assistant', provider: 'p', model: 'big', content: [{ type: 'text', text: 'Lorenz 1963 does. See ' + path.join(work, 'notes.md') + '.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
}

test('Beside: tabs next to your work, pinned or following, with their own back', { timeout: 180000 }, async t => {
  if (!chromiumAvailable()) return t.skip('chromium is not installed');
  const b = await viewerBrowser(t, { homeBase: os.homedir(), setup });
  const { evaluate: ev, until, command } = b;
  const work = b.work, note = path.join(work, 'notes.md'), draft = path.join(work, 'draft.md');
  const pdf = path.join(work, 'papers', 'lorenz1963.pdf');
  const shows = sel => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && el.getClientRects().length > 0; })()`);
  // A click as a person makes it: the pointer lands first (Beside knows where you clicked).
  const press = sel => ev(`(() => { const el = ${sel}; el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); el.click(); return true; })()`);
  const desk = () => ev(`JSON.stringify(Beside.visible().map(t => [t.spec.kind, Beside.label(t.spec)[1], t.pinned]))`);
  await until(`sessions.some(s => s.key === ${JSON.stringify(KEY)})`, 'the fixture conversation is indexed');
  await until(`!document.querySelector('dialog.bg-ask')`, 'the first-run question stayed');

  await ev(`open(${JSON.stringify(KEY)})`);
  await until(`viewKind === 'conversation' && activeRel === ${JSON.stringify(KEY)}`, 'the conversation');
  assert.equal(await shows('#artifactPane'), false, 'nothing beside yet');

  // ---- the project's folder beside the conversation, from the + menu ----
  await ev(`Beside.showLists('files')`);
  await until(`Artifacts.state()?.kind === 'lists' && document.querySelector('#artifactPane #rightFilePanel')`, 'the lists as a tab');
  await b.screenshot('beside-lists.png');
  await ev(`document.querySelector('#artifactPane [data-bs-new]').click()`);
  await until(`[...document.querySelectorAll('.bs-menu [role=menuitem]')].some(b => /folder of work/.test(b.textContent))`, 'the + menu offers the project folder');
  await ev(`[...document.querySelectorAll('.bs-menu [role=menuitem]')].find(b => /folder of work/.test(b.textContent)).click()`);
  await until(`Artifacts.state()?.kind === 'folder' && document.querySelector('#artifactPane .fb-view.fb-beside #bs-fbList [data-fb-entry]')`, 'the folder did not open beside');
  assert.equal(await ev(`viewKind + ' ' + activeRel`), 'conversation ' + KEY, 'the conversation stays in the middle');
  assert.equal(await ev(`!!document.getElementById('fbList')`), false, 'the beside browser has its own ids');
  const pane = await ev(`JSON.stringify([document.querySelector('#artifactPane').getBoundingClientRect().left, document.querySelector('#view').getBoundingClientRect().right])`).then(JSON.parse);
  assert.ok(pane[0] >= pane[1] - 2, 'the folder is on the right of the conversation: ' + pane);
  assert.deepEqual(JSON.parse(await desk()), [['lists', 'Files', true], ['folder', 'work', false]], 'the folder follows the conversation; the lists stay pinned');
  await b.screenshot('beside-folder.png');

  // ---- into a folder, then a PDF: it opens in this tab; ‹ goes back to the folder ----
  const row = name => `[...document.querySelectorAll('#artifactPane #bs-fbList [data-fb-entry]')].find(b => b.textContent.trim().endsWith(${JSON.stringify(name)}))`;
  await press(row('papers'));
  await until(`${row('lorenz1963.pdf')}`, 'the folder did not open');
  assert.equal(await ev(`Beside.active().spec.dir`), 'papers', 'the tab remembers where its folder is');
  const tabs = await ev(`Beside.visible().length`);
  await press(row('lorenz1963.pdf'));
  await until(`Artifacts.state()?.kind === 'file' && document.querySelector('#artifactPane .bs-reader iframe')`, 'the PDF did not open beside');
  assert.equal(await ev(`Beside.visible().length`), tabs, 'in the same tab');
  assert.match(await ev(`document.querySelector('#artifactPane .bs-reader iframe').src`), /pdfjs.*viewer\.html/);
  await until(`document.querySelector('#artifactPane .bs-reader-message').hidden`, 'the PDF reader did not say it is ready');
  assert.equal(await ev(`fileWs === null`), true, 'a PDF beside holds no editor: a file can be edited full page meanwhile');
  assert.equal(await ev(`document.querySelector('#artifactPane [data-art-act="back"] .bs-back-name').textContent`), 'papers/');
  await b.screenshot('beside-pdf.png');
  await ev(`document.querySelector('#artifactPane [data-art-act="back"]').click()`);
  await until(`Artifacts.state()?.kind === 'folder' && ${row('lorenz1963.pdf')}`, '‹ did not go back to the folder, where it was');

  // ---- Shift+click: the other place (the middle) ----
  await ev(`${row('lorenz1963.pdf')}.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))`);
  await until(`viewKind === 'file' && fileWs && fileWs.path === ${JSON.stringify(pdf)} && fileWs.placement === 'page'`, 'Shift+click did not open the PDF in the middle');
  // A folder follows its project: the PDF in the middle is in it, so the folder stays beside.
  await until(`Artifacts.state()?.kind === 'folder' && document.querySelector('#artifactPane #bs-fbList [data-fb-entry]')`, 'the folder did not stay beside a file of its project');
  // Home is no project's: there, it steps aside; the pinned lists stay.
  await ev(`goHome()`);
  await until(`viewKind === 'home' && Artifacts.state()?.kind === 'lists'`, 'the folder did not step aside at home');
  assert.deepEqual(JSON.parse(await desk()).map(t => t[0]), ['lists']);
  await ev(`open(${JSON.stringify(KEY)})`);
  await until(`viewKind === 'conversation' && Beside.visible().some(t => t.spec.kind === 'folder')`, 'coming back did not bring the folder back');

  // ---- pinned: the folder stays beside another conversation ----
  await ev(`Beside.activate(Beside.visible().find(t => t.spec.kind === 'folder'))`);
  await until(`Artifacts.state()?.kind === 'folder'`);
  await ev(`document.querySelector('#artifactPane [data-art-act="pin"]').click()`);
  await until(`Beside.active().pinned && document.querySelector('#artifactPane .bs-tab.on.pinned')`, 'the pin did not take');
  await ev(`open(${JSON.stringify(OTHER)})`);
  await until(`activeRel === ${JSON.stringify(OTHER)} && Artifacts.state()?.kind === 'folder'`, 'the pinned folder did not stay beside another conversation');
  await ev(`Beside.togglePin()`);
  await until(`!Beside.active().pinned && Beside.active().owner === 'project:work'`, 'unpinned, a folder follows its project');
  await ev(`Beside.togglePin()`);

  // ---- a file beside, then another full page: beside, a copy to read; "Edit it here" swaps ----
  await ev(`open(${JSON.stringify(KEY)})`);
  await until(`viewKind === 'conversation' && document.querySelector('#view [data-transcript-path]')`, 'the file link');
  await press(`document.querySelector('#view [data-transcript-path]')`);
  await until(`fileWs && fileWs.placement === 'beside' && fileWs.path === ${JSON.stringify(note)} && fileWs.editor`, 'the file link did not open beside, in the editor');
  assert.ok(JSON.parse(await desk()).length >= 3, 'a tab of its own: the pinned folder and the lists stay');
  // Pinned, the file stays beside the next page too (and is kept in Open files).
  await ev(`Beside.setPinned(Beside.active(), true, { silent: true })`);
  await until(`OpenFiles.isKept(${JSON.stringify(note)})`, 'a file pinned beside is kept in Open files');
  await ev(`openLiveFile(${JSON.stringify(draft)}, { project: 'work', back: ${JSON.stringify(KEY)} })`);
  await until(`viewKind === 'file' && fileWs.path === ${JSON.stringify(draft)} && Artifacts.state()?.kind === 'document' && Artifacts.state().readOnly && /About predictability/.test(document.querySelector('#artifactPane .bs-copy-body')?.textContent || '')`, 'the file beside did not become a copy to read');
  assert.match(await ev(`document.querySelector('#artifactPane .bs-copy-note').textContent`), /draft\.md is open in the middle/);
  await ev(`document.querySelector('#artifactPane .bs-copy-edit').click()`);
  await until(`viewKind === 'conversation' && fileWs && fileWs.placement === 'beside' && fileWs.path === ${JSON.stringify(note)} && fileWs.editor && !Artifacts.state().readOnly`, '"Edit it here" did not swap');

  // ---- the middle's file goes beside with ◨, the middle goes back ----
  await ev(`openLiveFile(${JSON.stringify(draft)}, { project: 'work', back: ${JSON.stringify(KEY)} })`);
  await until(`viewKind === 'file' && fileWs.editor && fileWs.path === ${JSON.stringify(draft)} && document.querySelector('#liveBeside')`, 'draft.md full page');
  await ev(`(window.__draft = docState.editor, true)`);
  await ev(`document.querySelector('#liveBeside').click()`);
  await until(`viewKind === 'conversation' && activeRel === ${JSON.stringify(KEY)} && fileWs && fileWs.placement === 'beside' && fileWs.path === ${JSON.stringify(draft)}`, '◨ Beside did not move the file');
  assert.equal(await ev(`docState.editor === window.__draft`), true, 'the same editor, moved');

  // ---- the middle's folder goes beside with ◨ ----
  await ev(`Beside.close(Beside.visible().find(t => t.spec.kind === 'folder'))`);
  await ev(`showFilesBrowser('work', { conv: ${JSON.stringify(KEY)} })`);
  await until(`viewKind === 'files-browser' && document.querySelector('#fbToBeside') && document.querySelector('#fbList [data-fb-entry]')`, 'the folder in the middle');
  await ev(`document.querySelector('#fbToBeside').click()`);
  await until(`viewKind === 'conversation' && Artifacts.state()?.kind === 'folder' && document.querySelector('#artifactPane #bs-fbList [data-fb-entry]')`, '◨ Beside did not move the folder');

  // ---- two browsers at once: the middle's and Beside's, each its own ----
  await ev(`showFilesBrowser('work', {})`);
  await until(`viewKind === 'files-browser' && document.querySelector('#fbList [data-fb-entry]')`, 'the middle browser');
  // The folder followed the conversation: pin it to keep it here too.
  await ev(`open(${JSON.stringify(KEY)})`);
  await until(`Artifacts.state()?.kind === 'folder'`);
  await ev(`Beside.setPinned(Beside.active(), true, { silent: true })`);
  await ev(`showFilesBrowser('work', {})`);
  await until(`viewKind === 'files-browser' && document.querySelector('#fbList [data-fb-entry]') && document.querySelector('#bs-fbList [data-fb-entry]')`, 'both browsers on screen');
  await ev(`(() => { const i = document.querySelector('#bs-fbSearch'); i.focus(); i.value = 'lorenz'; i.dispatchEvent(new Event('input')); })()`);
  await until(`document.querySelector('#bs-fbFinderList [role=option]') && document.querySelector('#fbFinderPopup').hidden`, 'Beside\'s finder works on its own');
  await b.screenshot('beside-two-browsers.png');
  assert.equal(await ev(`(() => { const p = document.querySelector('#bs-fbFinderPopup').getBoundingClientRect(), a = document.querySelector('#artifactPane').getBoundingClientRect(); return p.left >= a.left - 1 && p.right <= a.right + 1; })()`), true, 'the finder stays inside Beside');

  // ---- Alt+B puts Beside away; the corner says how many tabs wait; Alt+B again ----
  const altB = async () => {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, modifiers: 1 });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, modifiers: 1 });
  };
  await ev(`document.activeElement?.blur()`);
  await altB();
  await until(`!Artifacts.state() && Beside.hidden() && document.querySelector('#filesToggle .bs-count')`, 'Alt+B did not put Beside away');
  assert.match(await ev(`document.querySelector('#filesToggle').title`), /Beside: \d+ tabs/);
  await altB();
  await until(`Artifacts.state() && !Beside.hidden()`, 'Alt+B did not bring it back');

  // ---- things that open by themselves never take a pinned tab's place ----
  await ev(`open(${JSON.stringify(KEY)})`);
  await until(`viewKind === 'conversation'`);
  await ev(`Beside.activate(Beside.visible().find(t => t.spec.kind === 'folder'))`);
  await ev(`Beside.open({ kind: 'files', key: ${JSON.stringify(KEY)}, path: ${JSON.stringify(note)}, title: 'A new artifact' }, { auto: true, origin: 'middle' })`);
  await until(`[...document.querySelectorAll('.toast, #toast, [role=status]')].some(e => /New: A new artifact/.test(e.textContent))`, 'the artifact was not offered');
  assert.equal(await ev(`Artifacts.state().kind`), 'folder', 'the pinned folder kept the screen');

  // ---- the desk survives a reload ----
  const before = await desk();
  await command('Page.reload');
  await until(`typeof Beside !== 'undefined' && typeof load === 'function' && sessions.length`, 'reloaded');
  await ev(`open(${JSON.stringify(KEY)})`);
  await until(`viewKind === 'conversation' && Artifacts.state()`, 'nothing beside after a reload');
  assert.deepEqual(JSON.parse(await desk()).map(t => t[0]).sort(), JSON.parse(before).map(t => t[0]).sort(), 'the same tabs');

  // ---- a narrow window: after a move the middle comes first, Beside one tap away ----
  await b.size(900, 800);
  await until(`Pair.overlay()`);
  await ev(`open(${JSON.stringify(OTHER)})`);
  await until(`activeRel === ${JSON.stringify(OTHER)} && !document.querySelector('#artifactPane').getClientRects().length && document.querySelector('#pairPill') && !document.querySelector('#pairPill').hidden`, 'narrow: the middle did not come first');
  assert.match(await ev(`document.querySelector('#pairPill').textContent`), /\+\d/, 'the pill says more tabs wait');
  await b.screenshot('beside-narrow-pill.png');
  await ev(`document.querySelector('#pairPill').click()`);
  await until(`document.querySelector('#artifactPane').getClientRects().length > 0`, 'the pill did not bring Beside back');
  await b.screenshot('beside-narrow.png');
  // A phone: Beside is a sheet with its tabs on top.
  await b.size(390, 800, true);
  await until(`(() => { const r = document.querySelector('#artifactPane').getBoundingClientRect(); return r.left === 0 && r.width === innerWidth; })()`, 'not a sheet on a phone');
  await b.screenshot('beside-phone.png');
  await b.size(1440, 1000);
  await until(`!Pair.overlay()`);

  assert.deepEqual(b.exceptions, []);
});
