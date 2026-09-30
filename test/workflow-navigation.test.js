'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('work-first panel, visible timeline tools, quiet jobs and Back to the work after agent check-ins', { timeout: 60000 }, async t => {
  const { home, base, work, evaluate: ev, until, command, size, screenshot, exceptions, auth } = await viewerBrowser(t);
  const fixture = path.join(home, '.pi/agent/sessions/fixture');
  fs.writeFileSync(path.join(fixture, 'second.jsonl'), fs.readFileSync(path.join(fixture, 'media.jsonl'), 'utf8').replace('"id":"media"', '"id":"second"'));
  assert.equal((await fetch(base + '/api/rescan', { method: 'POST', headers: auth })).status, 200); await ev(`load()`);
  await until(`sessions.length >= 2 && nav.current() && $('projSort').children.length`);
  // One top row: machine, Gantt, then the project control; Agents is the
  // only left panel (design/51, 59). No icon rail.
  assert.deepEqual(await ev(`[...document.querySelectorAll('.side-project-row button')].map(b=>b.id)`), ['railMachine', 'sideHome', 'sideProject', 'sideProjectMore']);
  assert.equal(await ev(`!document.querySelector('#sideRail,.rail-primary,[data-rail]')`), true, 'no icon rail');
  assert.equal(await ev(`sidePanel()`), 'inbox');
  // Sorting and the compact camera controls share one quiet toolbar.
  assert.equal(await ev(`['ganttBar','projSort'].every(id=>$(id).checkVisibility())`), true, 'sorting and search are visible, not merely present');
  assert.equal(await ev(`['homeFilters','ganttProject'].every(id=>!$(id).checkVisibility())`), true, 'auxiliary controls stay out of the toolbar');
  assert.equal(await ev(`$('list').getBoundingClientRect().top > 45 && $('list').getBoundingClientRect().right < innerWidth`), true);
  // f opens the filters, focused, beside the column and on screen.
  await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'f',bubbles:true}))`);
  await until(`$('homeFilters').getAttribute('aria-expanded')==='true'`, 'f opens the filters');
  assert.equal(await ev(`$('src').checkVisibility() && document.activeElement.id==='src'`), true);
  assert.equal(await ev(`(()=>{const r=$('filtersPop').getBoundingClientRect();return r.left>=$('side').getBoundingClientRect().right && r.right<=innerWidth && r.bottom<=innerHeight})()`), true);
  await ev(`document.body.click()`);
  await until(`$('homeFilters').getAttribute('aria-expanded')==='false'`);
  await screenshot('workflow-home.png');
  for (const width of [760, 1024, 1440]) {
    await size(width, 900);
    assert.equal(await ev(`document.documentElement.scrollWidth<=innerWidth && $('projSort').checkVisibility()`), true, 'toolbar fits at ' + width);
  }

  // Background work neither lights Inbox nor interrupts with a toast.
  await ev(`window.workflowEvent = job => live.onmessage({data:JSON.stringify({type:'job',job})});window.oldToast=toast;window.notices=[];toast=(...args)=>notices.push(args);agentReadState.finished={};agentReadState.flagged={};agentReadState.read=Object.fromEntries(sessions.map(s=>[s.key,Math.max(Date.now(),s.mtimeMs||0)+1000]));agentsRecovery.interrupted=[];workflowEvent({id:'routine',type:'memory-docs',status:'running',title:'Routine task',startedAt:1})`);
  const badge = `document.querySelector('#sideUnfold .rail-badge')`;
  assert.equal(await ev(`${badge}.hidden`), true, 'routine work does not ask for attention');
  await ev(`workflowEvent({id:'routine',type:'memory-docs',status:'done',title:'Routine task',startedAt:1});workflowEvent({id:'routine-error',type:'memory-docs',status:'error',title:'Routine failed',startedAt:2})`);
  assert.equal(await ev(`notices.length`), 0);
  await ev(`toggleJobs(true)`);
  await until(`!!$('backgroundJobs')`);
  assert.match(await ev(`$('backgroundJobs').textContent`), /Routine task/);
  await ev(`workflowEvent({id:'later',type:'distill',status:'running',title:'Later task',startedAt:3})`);
  assert.match(await ev(`$('backgroundJobs').textContent`), /Later task/);
  await ev(`closeSettings()`); await until(`!settingsOpen`);

  // Clickable success and failure notifications, never from maintenance jobs.
  await ev(`workflowEvent({id:'reply',type:'agent-run',key:'pi:fixture/media.jsonl',status:'done',title:'A reply',startedAt:4});workflowEvent({id:'failure',type:'agent-run',key:'pi:fixture/media.jsonl',status:'error',title:'Failed reply',startedAt:5})`);
  assert.equal(await ev(`notices.length`), 2);
  assert.equal(await ev(`notices.every(n=>typeof n[1]==='function')`), true);
  await ev(`toast=oldToast`);

  // An interrupted run is a stopped row in the list, and the folded
  // panel's reopen button carries the attention dot (design/59). The
  // recovery settings fold keeps its state across a repaint.
  await ev(`agentsRecovery={enabled:false,network:{},interrupted:[{id:'crash',key:'pi:fixture/media.jsonl',title:'Interrupted run',kind:'error',reason:'Process exited',createdAt:Date.now(),attempts:1,state:'pending',canResume:false,note:''}]};setSidePanel('inbox');renderAgentsPop(false);updateActiveBtn()`);
  await until(`document.querySelector('#agentsUnread .ag-row.stopped[data-key="pi:fixture/media.jsonl"]')?.checkVisibility()`, 'the stopped run is a visible row');
  assert.equal(await ev(`${badge}.hidden`), false, 'an interruption asks for attention');
  await ev(`document.querySelector('details.ag-recovery').open=true`);
  await until(`agentRecoveryOpen`);
  await ev(`renderAgentsPop(false)`);
  assert.equal(await ev(`document.querySelector('details.ag-recovery').open`), true);
  // Processes no listed row accounts for fold under Other processes, the
  // busy one marked as working (design/59).
  await ev(`agentsRecovery.interrupted=[];agentsProcs=[{pid:91911,kind:'pi',owner:'test',title:'Busy elsewhere',busy:true},{pid:91912,kind:'pi',owner:'test',title:'Idle elsewhere',busy:false}];setWorkspaceScope('another-project');renderAgentsPop(false)`);
  assert.equal(await ev(`document.querySelector('#agentsLegacy details.ag-others summary').textContent.includes('2')`), true);
  assert.match(await ev(`[...document.querySelectorAll('#agentsLegacy .ag-others .ag-row.working')].map(r=>r.textContent).join()`), /Busy elsewhere/);
  // Folding leaves one reopen button; it brings the panel back.
  await ev(`setSideFold(true)`);
  assert.equal(await ev(`sideFolded() && $('sideUnfold').checkVisibility()`), true);
  await ev(`$('sideUnfold').click()`);
  assert.equal(await ev(`sideFolded()`), false);
  await ev(`setWorkspaceScope('')`);

  // Interrupt deeper file work, check two agents, and Back returns to the
  // file (design/59: Back replaced "Return to work"), also after a reload.
  const file = path.join(work, 'writing.md');
  fs.writeFileSync(file, '# Writing\n\n' + 'A paragraph to return to.\n\n'.repeat(180));
  await ev(`openLiveFile(${JSON.stringify(file)})`);
  await until(`fileWs?.editor && fileWs.path===${JSON.stringify(file)}`);
  await ev(`openPanelConversation('pi:fixture/media.jsonl')`);
  await until(`viewKind==='conversation' && current?.key==='pi:fixture/media.jsonl'`);
  await ev(`openPanelConversation('pi:fixture/second.jsonl')`);
  await until(`viewKind==='conversation' && current?.key==='pi:fixture/second.jsonl'`);
  await ev('window.beforeReloadMark = true'); // the old page matches until it is gone
  await command('Page.reload');
  await until(`!window.beforeReloadMark && viewKind==='conversation' && current?.key==='pi:fixture/second.jsonl'`);
  await ev(`$('sideBack').click()`);
  await until(`viewKind==='conversation' && current?.key==='pi:fixture/media.jsonl'`);
  await ev(`$('sideBack').click()`);
  await until(`viewKind==='file' && fileWs?.path===${JSON.stringify(file)} && !!fileWs.editor`, 'Back returns to the file');

  await ev(`goHome();setSidePanel('inbox');selectTheme('eink')`);
  await until(`$('projSort').checkVisibility()`, 'the project sort shows on the e-ink home');
  await screenshot('workflow-home-eink.png');
  await size(390, 844, true);
  assert.equal(await ev(`document.documentElement.scrollWidth<=innerWidth`), true);
  assert.deepEqual(exceptions, []);
});
