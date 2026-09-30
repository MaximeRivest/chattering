'use strict';
// The pair (design/83), in a real browser: a conversation and what it made
// side by side. A change and a file open beside the conversation, not in its
// place; the file beside is the real editor, and moving it full page and
// back keeps the very same editor; "working" swaps the columns; a file page
// brings in its conversation; the ask box inside the pair sends to the
// conversation on screen; a conversation keeps what was beside it; a narrow
// window and a phone show one side at a time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

const KEY = 'pi:fixture/pair.jsonl';
const DOC = '# Notes\n\nThe first paragraph.\n\nThe second paragraph.\n';

function setup(home) {
  const work = path.join(home, 'work');
  const note = path.join(work, 'notes.md');
  const ts = s => '2026-09-01T12:00:' + String(s).padStart(2, '0') + 'Z';
  const msg = (id, parentId, s, message) => ({ type: 'message', id, parentId, timestamp: ts(s), message });
  fs.writeFileSync(note, DOC);
  fs.writeFileSync(path.join(work, 'other.md'), '# Other\n');
  fs.writeFileSync(path.join(home, '.pi/agent/sessions/fixture/pair.jsonl'), [
    { type: 'session', version: 3, id: 'pair', cwd: work },
    msg('u1', null, 1, { role: 'user', content: [{ type: 'text', text: 'Tidy the notes' }] }),
    msg('a1', 'u1', 2, { role: 'assistant', provider: 'p', model: 'big', content: [{ type: 'toolCall', id: 'call-1', name: 'edit', arguments: { path: note, edits: [{ oldText: 'The first paragraph.', newText: 'The first paragraph.' }] } }] }),
    msg('r1', 'a1', 3, { role: 'toolResult', toolCallId: 'call-1', toolName: 'edit', content: [{ type: 'text', text: 'Successfully replaced 1 block(s).' }], isError: false }),
    msg('a2', 'r1', 4, { role: 'assistant', provider: 'p', model: 'big', content: [{ type: 'text', text: 'I tidied ' + note + ' and nothing else.' }] }),
    msg('a3', 'a2', 5, { role: 'assistant', provider: 'p', model: 'big', content: [{ type: 'toolCall', id: 'call-2', name: 'artifact', arguments: { path: path.join(work, 'other.md'), title: 'Other notes' } }] }),
    msg('r3', 'a3', 6, { role: 'toolResult', toolCallId: 'call-2', toolName: 'artifact', content: [{ type: 'text', text: 'declared' }], isError: false }),
    msg('a4', 'r3', 7, { role: 'assistant', provider: 'p', model: 'big', content: [{ type: 'text', text: 'Both are ready.' }] }),
  ].map(JSON.stringify).join('\n') + '\n');
}

test('the pair: beside, not in place; one editor that moves; both ways; one side at a time when narrow', { timeout: 120000 }, async t => {
  const b = await viewerBrowser(t, { setup });
  const { evaluate: ev, until, command } = b;
  const note = path.join(b.work, 'notes.md');
  await until(`sessions.some(s => s.key === ${JSON.stringify(KEY)})`, 'the fixture conversation is indexed');
  await until(`!document.querySelector('dialog.bg-ask')`, 'the first-run question stayed');
  const shows = sel => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && el.getClientRects().length > 0; })()`);
  const rect = sel => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; })()`);

  await ev(`open(${JSON.stringify(KEY)})`);
  await until(`viewKind === 'conversation' && document.querySelector('#view [data-transcript-path]')`, 'the conversation with its file link');

  // ---- a file named in the conversation opens beside it, in the real editor ----
  await ev(`document.querySelector('#view [data-transcript-path]').click()`);
  await until(`fileWs && fileWs.placement === 'beside' && fileWs.editor && docState && document.querySelector('#artifactPane .art-body > .live-file-view')`, 'the file did not open beside');
  assert.equal(await ev(`viewKind`), 'conversation', 'the conversation stays');
  assert.equal(await ev(`Artifacts.state().kind`), 'document');
  assert.equal(await ev(`fileWs.path`), note);
  const talk = { pane: await rect('#artifactPane'), view: await rect('#view') };
  assert.ok(talk.pane.left >= talk.view.right - 1 && talk.view.width >= 420, 'talking: the conversation wide on the left, the file on its right: ' + JSON.stringify(talk));
  assert.equal(await shows('#artifactPane #liveBack'), false, 'no ← back beside the conversation');
  assert.equal(await shows('#artifactPane [data-art-act="page"]'), true);
  await b.screenshot('pair-talk.png');

  // ---- working: the file wide, the conversation narrow on its right; the same editor ----
  await ev(`(window.__editor = docState.editor, true)`);
  await ev(`document.querySelector('#artifactPane [data-art-act="tilt"]').click()`);
  await until(`document.body.classList.contains('pair-swap')`, 'the tilt did not swap');
  const work = { pane: await rect('#artifactPane'), view: await rect('#view') };
  assert.ok(work.pane.right <= work.view.left + 1 && work.pane.width > work.view.width, 'working: the file wide on the left, the conversation narrow on its right: ' + JSON.stringify(work));
  assert.equal(await ev(`docState.editor === window.__editor`), true, 'nothing was rebuilt');
  assert.equal(await ev(`localStorage.getItem('chattering.pair.tilt')`), 'work', 'this device keeps the choice');
  await b.screenshot('pair-work.png');

  // ---- full page: the same editor moves into the page, with ← back to its conversation ----
  await ev(`document.querySelector('#artifactPane [data-art-act="page"]').click()`);
  await until(`viewKind === 'file' && document.querySelector('#view > .live-file-view') && !Artifacts.state()`, 'the file did not go full page');
  assert.equal(await ev(`docState.editor === window.__editor && fileWs.placement === 'page'`), true, 'the same editor, on the page');
  assert.equal(await shows('#liveBack'), true);
  assert.equal(await shows('#liveWithConv'), true, 'the page offers its conversation beside it');

  // ---- from the page, its conversation beside it: the file stays the wide side ----
  await ev(`document.querySelector('#liveWithConv').click()`);
  await until(`viewKind === 'conversation' && activeRel === ${JSON.stringify(KEY)} && fileWs && fileWs.placement === 'beside' && document.querySelector('#artifactPane .art-body > .live-file-view')`, 'its conversation did not come beside it');
  assert.equal(await ev(`docState.editor === window.__editor`), true, 'the same editor again');
  assert.equal(await ev(`document.body.classList.contains('pair-swap')`), true, 'the file stays the wide side');

  // ---- the ask box inside the pair: the conversation on screen is where it goes ----
  await ev(`fileWsToggleAsk(true)`);
  await until(`askBox && askBox.info && document.querySelector('.ask-target').value === ${JSON.stringify(KEY)}`, 'the ask box does not go to the conversation beside');
  assert.equal(await shows('.ask-bubble .ask-convo'), false, 'no "conversation" link: it is on screen');
  const box = await rect('.ask-bubble'), pane = await rect('#artifactPane');
  assert.ok(box.left >= pane.left - 1 && box.right <= pane.right + 1, 'the box floats over the file, in the panel: ' + JSON.stringify({ box, pane }));
  await ev(`askBubbleClose()`);

  // ---- another conversation: the file goes (closed or kept); coming back brings it again ----
  await ev(`open('pi:fixture/media.jsonl')`);
  await until(`activeRel === 'pi:fixture/media.jsonl' && !Artifacts.state() && !fileWs`, 'the file stayed beside another conversation');
  await ev(`open(${JSON.stringify(KEY)})`);
  await until(`activeRel === ${JSON.stringify(KEY)} && fileWs && fileWs.placement === 'beside' && fileWs.path === ${JSON.stringify(note)} && fileWs.editor`, 'the file did not come back beside its conversation');

  // ---- a change opens beside too; "Edit file" puts the file there ----
  await ev(`Artifacts.closePanel()`);
  await until(`!fileWs && !Artifacts.state()`, 'closing did not let the file go');
  await ev(`(() => { const g = document.querySelector('#view .toolgroup'); if (g) g.open = true; })()`);
  await until(`document.querySelector('#view [data-file-diff]')`, 'no change link in the conversation');
  // A click reads the change in place (design/88); the menu's "View this change beside" puts it here.
  await ev(`viewFileChange(fileControlContext(document.querySelector('#view [data-file-diff]')))`);
  await until(`Artifacts.state()?.kind === 'change' && document.querySelector('#artifactPane .quick-file-view .qf-body') && !/Loading/.test(document.querySelector('#artifactPane .qf-body').textContent)`, 'the change did not open beside');
  assert.equal(await ev(`viewKind`), 'conversation');
  assert.equal(await shows('#artifactPane #qfBack'), false);
  await b.screenshot('pair-change.png');
  await ev(`(document.querySelector('#artifactPane #qfEdit:not([disabled])') || document.querySelector('#artifactPane #qfOpenLive')).click()`);
  await until(`Artifacts.state()?.kind === 'document' && fileWs && fileWs.placement === 'beside' && fileWs.editor`, '"Edit file" did not put the file beside');

  // ---- a Markdown artifact's card: the current version opens in the real editor ----
  await ev(`(() => { for (const g of document.querySelectorAll('#view .toolgroup')) g.open = true; })()`);
  await until(`document.querySelector('#view .art-card .art-open')`, 'no artifact card');
  await ev(`document.querySelector('#view .art-card .art-open').click()`);
  await until(`Artifacts.state()?.kind === 'files' && Artifacts.state().editing && fileWs && fileWs.placement === 'beside' && fileWs.path.endsWith('other.md') && fileWs.editor`, 'the artifact did not open in the editor');
  assert.equal(await ev(`!!document.querySelector('#artifactPane .art-read')`), false, 'not the read-only page any more');
  await b.screenshot('pair-artifact.png');

  // ---- Made: a row opens beside, and ← Made goes back to the list ----
  await ev(`Artifacts.closePanel()`);
  await until(`document.querySelector('#convChanges') && !document.querySelector('#convChanges').hidden`, 'no Made chip');
  await ev(`document.querySelector('#convChanges').click()`);
  await until(`document.querySelector('#rightFileList [data-made-open]')`, 'Made did not list the file');
  await ev(`document.querySelector('#rightFileList [data-made-open]').click()`);
  await until(`Artifacts.state()?.kind === 'document' && fileWs && fileWs.placement === 'beside' && !document.body.classList.contains('file-side-open')`, 'the Made row did not open beside');
  assert.equal(await ev(`document.querySelector('#artifactPane [data-art-act="list"]').textContent`), '← Made');
  await ev(`document.querySelector('#artifactPane [data-art-act="list"]').click()`);
  await until(`document.body.classList.contains('file-side-open') && !Artifacts.state() && !fileWs && document.querySelector('#rightFileList .made')`, '← Made did not go back to the list');
  await ev(`setRightFiles(rightFilesMode, false)`);

  // ---- the ask box's "details", from a file full page: its conversation comes beside it ----
  await ev(`openLiveFile(${JSON.stringify(note)}, { project: null })`);
  await until(`viewKind === 'file' && fileWs && fileWs.editor && fileWs.placement === 'page'`, 'the file did not open full page');
  await ev(`askShowConversation(${JSON.stringify(KEY)})`);
  await until(`viewKind === 'conversation' && activeRel === ${JSON.stringify(KEY)} && fileWs && fileWs.placement === 'beside' && fileWs.path === ${JSON.stringify(note)}`, '"details" did not bring the conversation beside the file');

  // ---- Shift+click and the menu: full page, as before ----
  await until(`document.querySelector('#view [data-transcript-path]')`, 'the conversation beside the file did not draw');
  assert.match(await ev(`(() => { openFileActionMenu(fileControlContext(document.querySelector('#view [data-transcript-path]')), 10, 10); const t = [...document.querySelectorAll('.file-action-menu [role=menuitem]')].map(b => b.textContent); closeFileActionMenu(); return t.join('|'); })()`), /Open the file beside\|Open the file full page/);

  // ---- a narrow window: one side at a time, the other one tap away ----
  await b.size(900, 800);
  await until(`Pair.overlay() && !document.body.classList.contains('pair-swap')`, 'narrow: still side by side');
  assert.equal(await shows('#artifactPane'), true, 'what was asked for is on screen');
  assert.equal(await ev(`document.querySelector('#artifactPane [data-art-act="tilt"]').textContent`), '☷ conversation');
  await ev(`document.querySelector('#artifactPane [data-art-act="tilt"]').click()`);
  await until(`!document.querySelector('#artifactPane').getClientRects().length && document.querySelector('#pairPill') && !document.querySelector('#pairPill').hidden`, 'the conversation did not come to the front');
  assert.equal(await ev(`fileWs && fileWs.editor === docState.editor && !!fileWs.editor`), true, 'the file is kept, not closed');
  await ev(`document.querySelector('#pairPill').click()`);
  await until(`document.querySelector('#artifactPane').getClientRects().length > 0`, 'the pill did not bring the file back');

  // ---- a phone: a sheet; the back button brings the conversation back ----
  await b.size(390, 800, true);
  await until(`(() => { const r = document.querySelector('#artifactPane').getBoundingClientRect(); return r.left === 0 && r.width === innerWidth; })()`, 'not a full sheet on a phone');
  await b.screenshot('pair-phone.png');
  assert.equal(await ev(`chatteringBack()`), true);
  await until(`!document.querySelector('#artifactPane').getClientRects().length && fileWs && viewKind === 'conversation'`, 'back did not step the sheet aside');
  await b.size(1440, 1000);
  await until(`!Pair.overlay()`);
  assert.deepEqual(b.exceptions, []);
});
