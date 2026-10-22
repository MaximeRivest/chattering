'use strict';
// The new-project journey in the whole app: find the entry, fill one form,
// land on the first message in the new folder with the purpose attached,
// undo; make a draft's missing folder a project without losing its words;
// create from the project picker's search; an empty project's first
// conversation starts on the same page. Nothing here starts an agent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('new project: one form, then the first message; undo; missing folder; picker; empty project start', { timeout: 120000 }, async t => {
  const { evaluate: ev, until, screenshot, exceptions } = await viewerBrowser(t);
  // Under the real home: a temporary folder is never a project.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.homedir(), '.project-setup-app-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const J = JSON.stringify;

  // The entry heads the project column, the full height of the date strip.
  await ev(`goHome(); renderTabList()`);
  await until(`!!document.querySelector('.project-new-cell')`);
  const cell = await ev(`(() => { const b = document.querySelector('.project-new-cell'); const r = b.getBoundingClientRect(); return { tag: b.tagName, h: r.height, text: b.textContent }; })()`);
  assert.equal(cell.tag, 'BUTTON'); assert.ok(cell.h >= 24, 'target at least 24px tall: ' + cell.h); assert.match(cell.text, /New project/);
  await ev(`document.querySelector('.project-new-cell').click()`);
  await until(`!!document.querySelector('.ps-card')`);
  assert.equal(await ev(`document.activeElement.classList.contains('ps-name')`), true, 'the name has focus');
  await ev(`(() => { const q = s => document.querySelector(s);
    q('.ps-name').value = 'My Thesis'; q('.ps-name').dispatchEvent(new Event('input'));
    q('.ps-where-toggle').click(); q('.ps-parent').value = ${J(root)}; q('.ps-parent').dispatchEvent(new Event('input'));
    q('.ps-intent').value = 'Write and defend the thesis on soil carbon.'; })()`);
  assert.equal(await ev(`document.querySelector('.ps-preview').textContent`), path.join(root, 'My-Thesis'));
  await screenshot('project-setup-form.png');
  await ev(`document.querySelector('.ps-card').requestSubmit()`);

  // Straight to the first message, in the new folder, purpose attached.
  await until(`viewKind === 'draft' && !!document.querySelector('.draft-made') && document.querySelector('.agent-ctx-chip')?.textContent.includes('purpose')`, 'draft with the purpose chip');
  const cwd = path.join(root, 'My-Thesis');
  assert.ok(fs.statSync(path.join(cwd, '.git')).isDirectory(), 'Git on by default');
  assert.equal(await ev(`draftState.d.folder`), cwd);
  assert.equal(await ev(`document.activeElement === $('agentText')`), true, 'the cursor waits in the message box');
  assert.match(await ev(`document.querySelector('.draft-made').textContent`), /Created project My Thesis/);
  assert.deepEqual(await ev(`attachedContext()`), [{ project: 'My-Thesis', kind: 'intent' }]);
  assert.equal(await ev(`(projectFolds.created || []).some(c => c.name === 'My-Thesis')`), true);
  assert.equal(await ev(`workspaceScope()`), 'My-Thesis', 'making a project chooses it');
  await screenshot('project-setup-draft.png');

  // Undo: registration, purpose and the still-empty folder all go.
  await ev(`document.querySelector('.draft-made-undo').click()`);
  await until(`viewKind === 'home' && !(projectFolds.created || []).some(c => c.name === 'My-Thesis')`, 'undo returns home');
  assert.equal(fs.existsSync(cwd), false, 'the empty folder setup made is gone');
  assert.equal(await ev(`workspaceScope()`), '', 'undo lets go of the removed project');

  // A draft whose folder does not exist yet: make it a project, keep the words.
  await ev(`startDraftIn(${J(path.join(root, 'Novel'))})`);
  await until(`!!document.querySelector('.ds-make-project')`, 'offer to create the missing folder');
  await ev(`$('agentText').value = 'Outline chapter one'; $('agentText').dispatchEvent(new Event('input')); document.querySelector('.ds-make-project').click()`);
  await until(`!!document.querySelector('.ps-card')`);
  assert.equal(await ev(`document.querySelector('.ps-name').value + '|' + document.querySelector('.ps-preview').textContent`), 'Novel|' + path.join(root, 'Novel'));
  await ev(`document.querySelector('.ps-card').requestSubmit()`);
  await until(`viewKind === 'draft' && !!document.querySelector('.draft-made') && draftState.folderInfo?.exists`, 'same draft, now in the project');
  assert.equal(await ev(`$('agentText').value`), 'Outline chapter one', 'the words survive');
  assert.ok(fs.statSync(path.join(root, 'Novel')).isDirectory());
  // Undo with words typed: the project goes, the draft stays, with no project.
  await ev(`document.querySelector('.draft-made-undo').click()`);
  await until(`viewKind === 'draft' && !document.querySelector('.draft-made') && $('agentText')?.value === 'Outline chapter one'`, 'draft kept after undo');
  assert.equal(await ev(`draftState.d.folder`), '');
  await ev(`document.querySelector('.ds-discard') && (window.confirm = () => true, document.querySelector('.ds-discard').click())`);

  // The project picker: search, then create what was not found.
  await ev(`goHome(); $('sideProject').click()`);
  await until(`!!document.querySelector('.project-scope-picker [data-workspace-create]')`);
  await ev(`(() => { const i = document.querySelector('.project-scope-picker input'); i.value = 'Étude'; i.dispatchEvent(new Event('input')); })()`);
  assert.match(await ev(`document.querySelector('[data-workspace-create]').textContent`), /New project “Étude”/);
  await ev(`document.querySelector('[data-workspace-create]').click()`);
  await until(`document.querySelector('.ps-name')?.value === 'Étude'`);
  await ev(`(() => { const q = s => document.querySelector(s); q('.ps-parent').value = ${J(root)}; q('.ps-parent').dispatchEvent(new Event('input')); q('.ps-git').checked = false; q('.ps-card').requestSubmit(); })()`);
  await until(`viewKind === 'draft' && !!document.querySelector('.draft-made')`, 'Unicode project created');
  assert.ok(fs.statSync(path.join(root, 'Étude')).isDirectory());
  assert.equal(fs.existsSync(path.join(root, 'Étude', '.git')), false, 'Git off when asked');
  assert.deepEqual(await ev(`attachedContext()`), [], 'no purpose written, no chip');

  // An empty project's start opens a draft in its folder, not the review dialog.
  await ev(`deleteDraft(draftState.d.id); draftState = null; current = null; goHome(); startReviewedConversation('Étude')`);
  await until(`viewKind === 'draft' && draftState.d.folder === ${J(path.join(root, 'Étude'))}`, 'empty project starts a draft');
  assert.equal(await ev(`!!document.querySelector('.ctx-confirm')`), false);

  // Add a folder you already have, found by typing its path into the search.
  const mine = path.join(root, 'Field notes'); fs.mkdirSync(mine); fs.writeFileSync(path.join(mine, 'day1.md'), 'keep');
  await ev(`deleteDraft(draftState.d.id); draftState = null; current = null; goHome(); openNewProjectForm({ operation: 'add' })`);
  await until(`document.activeElement?.classList.contains('ps-existing')`, 'add mode starts in the search');
  await ev(`(() => { const i = document.querySelector('.ps-existing'); i.value = ${J(root + '/fie')}; i.dispatchEvent(new Event('input')); })()`);
  await until(`[...document.querySelectorAll('.ps-existing-list .fsel-opt')].some(o => o.textContent.includes('Field notes'))`, 'path search lists the folder');
  await screenshot('project-setup-add.png');
  await ev(`document.querySelector('.ps-existing').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  assert.equal(await ev(`document.querySelector('.ps-existing').value`), mine, 'Enter chooses the highlighted folder');
  await ev(`document.querySelector('.ps-card').requestSubmit()`);
  await until(`viewKind === 'draft' && document.querySelector('.draft-made')?.textContent.includes('Added project')`, 'added');
  assert.deepEqual(fs.readdirSync(mine), ['day1.md'], 'adding changes nothing in the folder');
  // The draft's own folder box is the same search, for running a conversation.
  await until(`!!draftState?.folderInfo && document.activeElement === $('agentText')`, 'the draft finished loading');
  await ev(`draftToggleSetup(true)`);
  await until(`!document.querySelector('.ds-folder-list .fsel-list')?.hidden`, 'the draft folder search opens');
  await ev(`(() => { const i = $('dsFolder'); i.value = ${J(root + '/')}; i.dispatchEvent(new Event('input')); })()`);
  await until(`document.querySelectorAll('.ds-folder-list .fsel-opt').length >= 2`, 'draft path search');
  await screenshot('project-setup-draft-picker.png');
  await ev(`(() => { const i = $('dsFolder'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); })()`);
  assert.equal(await ev(`document.querySelector('.ds-folder-list .fsel-list').hidden && !$('draftSetupPanel').hidden`), true, 'Esc closes the list, not the setup panel');

  // The sidebar's "new" menu offers a project too.
  await ev(`goHome(); $('sideNewMore').click()`);
  await until(`!!document.querySelector('.ag-menu')`);
  assert.match(await ev(`[...document.querySelectorAll('.ag-menu [data-ag-action]')].map(b => b.textContent).join('|')`), /New project…/);
  assert.deepEqual(exceptions, []);
});
