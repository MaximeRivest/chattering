'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

// design/58: on a phone one bottom bar carries Agents, Gantt, New, Files and
// You; Agents and Files open as full-screen sheets above it and are the same
// elements the desktop column fills. Reading and typing hide the bar with the
// top bar; a sheet keeps it. The Android back button asks the page first.
test('phone shell: bottom bar, sheets, one-row head, back hook, desktop untouched', { timeout: 90000 }, async t => {
  const { home, base, work, auth, evaluate: ev, until, size, screenshot, exceptions } = await viewerBrowser(t);
  // A fresh install first asks about background AI; its modal would hold focus.
  await until(`!document.querySelector('dialog.bg-ask')`, 'the first-run question stayed');
  const fixture = path.join(home, '.pi/agent/sessions/fixture');
  const keys = {};
  for (const name of ['alpha', 'beta']) {
    keys[name] = 'pi:fixture/' + name + '.jsonl';
    const lines = [{ type: 'session', version: 3, id: name, cwd: work },
      { type: 'message', id: name + '-p', parentId: null, timestamp: '2026-09-01T12:00:00Z', message: { role: 'user', content: [{ type: 'text', text: name + ' question' }] } }];
    for (let i = 0; i < 30; i++) lines.push({ type: 'message', id: name + '-a' + i, parentId: i ? name + '-a' + (i - 1) : name + '-p', timestamp: '2026-09-01T12:00:0' + (i % 10) + 'Z', message: { role: 'assistant', content: [{ type: 'text', text: name + ' reply ' + i + '. ' + 'Words that fill a phone screen. '.repeat(20) }] } });
    fs.writeFileSync(path.join(fixture, name + '.jsonl'), lines.map(JSON.stringify).join('\n') + '\n');
  }
  // A conversation that fits the screen: nothing to scroll.
  keys.gamma = 'pi:fixture/gamma.jsonl';
  fs.writeFileSync(path.join(fixture, 'gamma.jsonl'), [
    { type: 'session', version: 3, id: 'gamma', cwd: work },
    { type: 'message', id: 'gamma-p', parentId: null, timestamp: '2026-09-01T12:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'gamma question' }] } },
    { type: 'message', id: 'gamma-a', parentId: 'gamma-p', timestamp: '2026-09-01T12:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'A short answer.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  await fetch(base + '/api/rescan', { method: 'POST', headers: auth }); await ev(`load()`);
  await until(`${JSON.stringify([keys.beta, keys.gamma])}.every(k=>sessions.some(s=>s.key===k))`);
  const doc = path.join(work, 'notes.md'); fs.writeFileSync(doc, '# Notes\n\nA file to open from the sheet.\n');
  await fetch(base + '/api/recent-files', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: doc, project: 'work' }) });

  // Desktop first: the column, no bar, the sheet head and ⋯ absent.
  assert.equal(await ev(`document.body.classList.contains('side-layout') && !document.body.classList.contains('phone-shell')`), true);
  assert.equal(await ev(`['phoneBar','agentsSheetHead','phoneMore'].every(id=>getComputedStyle($(id)).display==='none')`), true, 'desktop shows nothing of the shell');

  await size(390, 844, true);
  await until(`document.body.classList.contains('phone-shell') && !document.body.classList.contains('side-layout')`, 'the shell replaces the column on a phone');
  assert.equal(await ev(`$('agentsPop').hidden && $('agentsPop').parentElement.tagName==='BODY'`), true, 'the sheet starts closed');
  assert.deepEqual(await ev(`[...document.querySelectorAll('#phoneBar [data-phone-tab]')].map(b=>b.dataset.phoneTab)`), ['agents', 'gantt', 'new', 'files']);
  assert.equal(await ev(`$('settingsBtn').closest('#phoneBar')!==null && $('settingsBtn').checkVisibility()`), true, 'You is the fifth tab');
  const fits = `(()=>{const r=$('phoneBar').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && Math.abs(r.bottom-innerHeight)<1 && r.height>=50})()`;
  assert.equal(await ev(fits), true, 'the bar sits on the bottom edge');
  assert.equal(await ev(`[...document.querySelectorAll('#phoneBar > button, #phoneBar > .pb-slot')].every(b=>b.getBoundingClientRect().height>=44)`), true, 'every tab is a finger target');
  assert.equal(await ev(`document.querySelector('[data-phone-tab=gantt]').getAttribute('aria-pressed')`), 'true', 'home lights Gantt');
  assert.equal(await ev(`document.querySelector('#timelineControls [data-action=now]').getBoundingClientRect().bottom <= $('phoneBar').getBoundingClientRect().top`), true, 'Now is reachable in the chart toolbar, above the phone bar');
  await screenshot('phone-shell-home.png');

  // Agents: the side list in a sheet (design/59) — the conversations a
  // person opened, the working one with its typing dots.
  await ev(`agentReadState.read=Object.fromEntries(sessions.map(s=>[s.key,1]));agentReadState.finished={};agentReadState.flagged={};agentReadState.opened=Object.fromEntries(sessions.map(s=>[s.key,1]));jobs.set('run-1',{id:'run-1',type:'agent-run',status:'running',key:${JSON.stringify(keys.beta)}});activeRuns.set('run-1',{jobId:'run-1',key:${JSON.stringify(keys.beta)},status:'running',statusText:'tool · bash'});updateActiveBtn()`);
  await ev(`document.querySelector('[data-phone-tab=agents]').click()`);
  await until(`!$('agentsPop').hidden && $('agentsPop').dataset.panel==='inbox' && document.querySelector('#agentsUnread [data-sec=open] .ag-row.working[data-key=${JSON.stringify(keys.beta)}] .ag-typing')`, 'Agents opens as the list, with the running conversation typing');
  assert.equal(await ev(`document.body.classList.contains('phone-sheet') && document.querySelector('[data-phone-tab=agents]').getAttribute('aria-pressed')==='true'`), true);
  assert.equal(await ev(`$('agentsSheetHead').checkVisibility() && $('agentsSheetClose').getBoundingClientRect().height>=44`), true, 'the sheet has a head with a close button');
  assert.equal(await ev(`(()=>{const p=$('agentsPop').getBoundingClientRect(),b=$('phoneBar').getBoundingClientRect();return p.top<=0.5 && Math.abs(p.bottom-b.top)<1 && p.width===innerWidth})()`), true, 'the sheet fills the screen above the bar');
  assert.equal(await ev(`!document.querySelector('[data-sec=unread],[data-sec=read],[data-sec=traffic]')`), true, 'no Unread, Read or Working sections');
  assert.equal(await ev(`document.querySelectorAll('#agentsUnread [data-sec=open] .ag-row[data-key]').length===sessions.length`), true, 'every opened conversation is listed');
  assert.equal(await ev(`$('phoneBar').checkVisibility()`), true, 'the bar stays while a sheet is open');
  await screenshot('phone-shell-agents.png');
  // A row opens its conversation and closes the sheet; the one-row head shows a full title and ⋯.
  await ev(`document.querySelector('#agentsUnread .ag-row[data-key=${JSON.stringify(keys.alpha)}]').click()`);
  await until(`viewKind==='conversation' && current?.key===${JSON.stringify(keys.alpha)} && $('agentsPop').hidden`, 'a row opens and the sheet closes');
  assert.equal(await ev(`document.body.classList.contains('phone-sheet')`), false);
  // The head is drawn just after the view switches: wait for it rather than read once.
  await until(`(()=>{const t=$('chTitle')?.getBoundingClientRect();return !!t && t.width>innerWidth*0.5})()`, 'the title has the row');
  assert.equal(await ev(`$('phoneMore').checkVisibility() && ['newLoose','brand','activeBtn','chNew','chMove','barFold'].every(id=>!$(id).checkVisibility())`), true, 'one ⋯ instead of nine controls');
  await until(`(()=>{const c=$('composerDock')?.getBoundingClientRect(),b=$('phoneBar')?.getBoundingClientRect();return !!c && !!b && Math.abs(c.bottom-b.top)<1})()`, 'the composer sits on the bar');
  // The share control fills in from a request of its own: wait for it, as
  // the menu lists only what is ready.
  await until(`!$('shareBtn').hidden`, 'the share control is ready');
  await ev(`$('phoneMore').click()`);
  await until(`!!document.querySelector('.phone-more-menu')`);
  // The fixture's folder is not a project: no "new here", no project page, no file browser.
  assert.deepEqual(await ev(`[...document.querySelectorAll('.phone-more-menu button')].map(b=>b.textContent)`), ['Rename', 'Who can see this', 'Move to another project', 'Conversation tree', 'Compact conversation…']);
  assert.equal(await ev(`[...document.querySelectorAll('.phone-more-menu button')].every(b=>b.getBoundingClientRect().height>=44)`), true);
  assert.equal(await ev(`window.chatteringBack()`), true, 'back closes the menu');
  assert.equal(await ev(`!document.querySelector('.phone-more-menu') && $('phoneMore').getAttribute('aria-expanded')==='false'`), true);
  await screenshot('phone-shell-conversation.png');

  // Reading hides the chrome, bar included; scrolling back up returns it.
  await ev(`$('view').scrollTop=600`);
  await new Promise(r => setTimeout(r, 100));
  await ev(`$('view').scrollTop=760`);
  await until(`document.body.classList.contains('chrome-min')`, 'scrolling down hides the chrome');
  assert.equal(await ev(`!$('phoneBar').checkVisibility() && getComputedStyle($('composerDock')).bottom==='0px'`), true, 'the bar leaves with the top bar; the composer drops to the edge');
  await ev(`$('view').scrollTop=600`);
  await until(`!document.body.classList.contains('chrome-min')`, 'scrolling up brings it back');
  assert.equal(await ev(`$('phoneBar').checkVisibility()`), true);
  // The keyboard: focus hides the bar too; blur alone does not bring it back (the page decides).
  await ev(`$('agentText').focus()`);
  await until(`document.body.classList.contains('chrome-min')`, 'typing hides the chrome');
  assert.equal(await ev(`$('phoneBar').checkVisibility()`), false);
  await ev(`$('agentText').blur();$('view').scrollTop=560`);
  await until(`!document.body.classList.contains('chrome-min')`, 'a small scroll up brings the chrome back after typing');

  // The chrome hides only while the reader can bring it back. Content that
  // shrinks under a hidden chrome (a collapsed block, another branch) takes
  // away the scroll that would ask for it: the chrome returns on its own.
  await ev(`$('view').scrollTop=600`);
  await new Promise(r => setTimeout(r, 100));
  await ev(`$('view').scrollTop=760`);
  await until(`document.body.classList.contains('chrome-min')`);
  await ev(`$('conversationTranscript').replaceChildren()`);
  await until(`!document.body.classList.contains('chrome-min') && $('phoneBar').checkVisibility()`, 'a view that stops scrolling brings the chrome back');
  // A conversation that fits the screen has no scroll at all: typing hides
  // the chrome, and letting go of the composer must bring it back.
  await ev(`open(${JSON.stringify(keys.gamma)}, 'bottom')`);
  await until(`viewKind==='conversation' && current?.key===${JSON.stringify(keys.gamma)} && !!$('agentText')`);
  assert.equal(await ev(`$('view').scrollHeight-$('view').clientHeight < 48`), true, 'the short conversation fits');
  await ev(`$('agentText').focus()`);
  await until(`document.body.classList.contains('chrome-min')`, 'typing hides the chrome in a short conversation too');
  await ev(`$('agentText').blur()`);
  await until(`!document.body.classList.contains('chrome-min') && $('phoneBar').checkVisibility()`, 'with nothing to scroll, the keyboard leaving brings the bar back');

  // Files: the same file list as the desktop's right column, as a sheet.
  await ev(`document.querySelector('[data-phone-tab=files]').click()`);
  await until(`rightFilesOpen && document.body.classList.contains('phone-files') && !$('rightFilePanel').hidden`, 'Files opens as a sheet');
  await until(`document.querySelector('.ag-files-block')?.checkVisibility() && [...document.querySelectorAll('.ag-file')].some(r=>r.dataset.path===${JSON.stringify(doc)})`, 'the recent file is listed');
  await ev(`document.querySelector('[data-phone-tab=agents]').click()`);
  await until(`!$('agentsPop').hidden && !rightFilesOpen`, 'one sheet at a time');
  await ev(`document.querySelector('[data-phone-tab=agents]').click()`);
  await until(`$('agentsPop').hidden`, 'the tab toggles its sheet closed');
  await ev(`document.querySelector('[data-phone-tab=files]').click()`);
  await until(`rightFilesOpen`);
  await screenshot('phone-shell-files.png');
  assert.equal(await ev(`window.chatteringBack()`), true, 'back closes the sheet');
  await until(`!rightFilesOpen && !document.body.classList.contains('phone-sheet')`);
  assert.equal(await ev(`window.chatteringBack()`), false, 'with nothing open, back is the page history');
  await ev(`document.querySelector('[data-phone-tab=files]').click()`);
  await until(`rightFilesOpen`);
  // Matched by value, not a CSS selector: a backslash in C:\… is an escape in CSS.
  await ev(`[...document.querySelectorAll('.ag-file[data-path]')].find(r => r.dataset.path === ${JSON.stringify(doc)}).querySelector('.ag-file-open').click()`);
  await until(`viewKind==='file' && fileWs?.path===${JSON.stringify(doc)} && !rightFilesOpen`, 'a file opens and the sheet closes');

  // Gantt and New from the bar; leaving for a page closes the sheet.
  await ev(`document.querySelector('[data-phone-tab=gantt]').click()`);
  await until(`viewKind==='home' && document.querySelector('[data-phone-tab=gantt]').getAttribute('aria-pressed')==='true'`);
  // New follows the chosen project (design/50): the file above was in
  // `work`, so New would start there. (The fixture's `work` is a label on
  // the file, not a registered project, so its reviewed start is not run.)
  assert.equal(await ev(`workspaceScope() + '|' + sideNewProject()`), 'work|work');
  // With All projects chosen, New is a blank draft.
  await ev(`setWorkspaceScope('')`);
  await ev(`document.querySelector('[data-phone-tab=new]').click()`);
  await until(`viewKind==='draft' && document.querySelector('[data-phone-tab=new]').getAttribute('aria-pressed')==='true'`, 'New starts a draft');
  await ev(`document.querySelector('[data-phone-tab=agents]').click()`);
  await until(`!$('agentsPop').hidden`);
  // The fixture's conversations are loose, so their rows carry no project
  // link; follow the address a link would, with the sheet open.
  await ev(`location.hash='#project=work'`);
  await until(`viewKind==='project' && $('agentsPop').hidden`, 'leaving for a page closes the sheet');
  assert.equal(await ev(`document.documentElement.scrollWidth<=innerWidth`), true);

  // Back to a desk: the column returns, the bar goes, You is back in the column.
  await size(1440, 1000);
  await until(`document.body.classList.contains('side-layout') && !document.body.classList.contains('phone-shell')`);
  assert.equal(await ev(`getComputedStyle($('phoneBar')).display==='none' && $('settingsBtn').closest('#side')!==null && !$('agentsPop').hidden && $('agentsPop').parentElement.id==='sideAgents'`), true);
  assert.deepEqual(exceptions, []);
});
