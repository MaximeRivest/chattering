'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('work-first rail, visible timeline tools, quiet jobs and a return from agent check-ins', { timeout: 60000 }, async t => {
  const { home, base, work, evaluate: ev, until, command, size, screenshot, exceptions } = await viewerBrowser(t);
  const fixture = path.join(home, '.pi/agent/sessions/fixture');
  fs.writeFileSync(path.join(fixture, 'second.jsonl'), fs.readFileSync(path.join(fixture, 'media.jsonl'), 'utf8').replace('"id":"media"', '"id":"second"'));
  await fetch(base + '/api/rescan', { method: 'POST' }); await ev(`load()`);
  await until(`sessions.length >= 2 && nav.current() && $('projSort').children.length`);
  assert.deepEqual(await ev(`[...document.querySelectorAll('.rail-primary button')].map(b=>b.id || b.dataset.rail)`), ['sideHome', 'inbox', 'traffic', 'recent-files']);
  assert.equal(await ev(`$('sideProject').closest('.rail-secondary') !== null`), true);
  assert.equal(await ev(`sidePanel()`), 'inbox');
  assert.equal(await ev(`['ganttBar','projSort','homeFilters','ganttProject','ganttDate'].every(id=>$(id).checkVisibility())`), true, 'controls must actually be visible, not merely inside a hidden toolbar');
  assert.equal(await ev(`$('list').getBoundingClientRect().top > 45 && $('list').getBoundingClientRect().right < innerWidth`), true);
  await ev(`$('homeFilters').click()`);
  await until(`$('homeFilters').getAttribute('aria-expanded')==='true'`);
  assert.equal(await ev(`$('src').checkVisibility() && document.activeElement.id==='src'`), true);
  assert.equal(await ev(`(()=>{const r=$('filtersPop').getBoundingClientRect();return r.left>=$('side').getBoundingClientRect().right && r.right<=innerWidth && r.bottom<=innerHeight})()`), true);
  await ev(`document.body.click()`);
  await until(`$('homeFilters').getAttribute('aria-expanded')==='false'`);
  await screenshot('workflow-home.png');
  for (const width of [760, 1024, 1440]) {
    await size(width, 900);
    assert.equal(await ev(`document.documentElement.scrollWidth<=innerWidth && $('homeFilters').checkVisibility()`), true, 'toolbar fits at ' + width);
  }

  // Background work neither lights Inbox nor interrupts with a toast.
  await ev(`window.workflowEvent = job => live.onmessage({data:JSON.stringify({type:'job',job})});window.oldToast=toast;window.notices=[];toast=(...args)=>notices.push(args);agentReadState.finished={};agentReadState.flagged={};agentReadState.read=Object.fromEntries(sessions.map(s=>[s.key,Math.max(Date.now(),s.mtimeMs||0)+1000]));agentsRecovery.interrupted=[];workflowEvent({id:'routine',type:'memory-docs',status:'running',title:'Routine task',startedAt:1})`);
  assert.equal(await ev(`document.querySelector('[data-rail=inbox] .rail-badge').hidden`), true);
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

  // Crashes stay visible without opening an options fold. A routine job
  // does not share their badge; a busy agent does not hide among idle ones.
  await ev(`agentsRecovery={enabled:false,interrupted:[{id:'crash',key:'pi:fixture/media.jsonl',title:'Interrupted run',kind:'error',reason:'Process exited',createdAt:Date.now(),canResume:false}]};setSidePanel('inbox');renderAgentsPop(false);updateActiveBtn()`);
  assert.equal(await ev(`document.querySelector('.ag-interrupted').checkVisibility()`), true);
  assert.equal(await ev(`document.querySelector('[data-rail=inbox] .rail-badge').hidden`), false);
  await ev(`document.querySelector('details.ag-recovery').open=true`);
  await until(`agentRecoveryOpen`);
  await ev(`renderAgentsPop(false)`);
  assert.equal(await ev(`document.querySelector('details.ag-recovery').open`), true);
  await ev(`agentsRecovery.interrupted=[];agentsProcs=[{pid:91911,kind:'pi',owner:'test',title:'Busy elsewhere',busy:true},{pid:91912,kind:'pi',owner:'test',title:'Idle elsewhere',busy:false}];setWorkspaceScope('another-project');setSidePanel('traffic');renderAgentsPop(false)`);
  assert.equal(await ev(`document.querySelector('[data-sec=traffic] .ag-row').textContent.includes('Busy elsewhere')`), true);
  assert.equal(await ev(`document.querySelector('#agentsLegacy details .ag-row').checkVisibility()`), false);
  await ev(`setSideFold(true)`);
  assert.equal(await ev(`document.querySelector('[data-rail=inbox]').checkVisibility() && $('sideProject').checkVisibility()`), true);
  await ev(`document.querySelector('[data-rail=traffic]').click()`);
  assert.equal(await ev(`sideFolded()`), false);

  // Interrupt deeper file work, then return through the real history stack.
  const file = path.join(work, 'writing.md');
  fs.writeFileSync(file, '# Writing\n\n' + 'A paragraph to return to.\n\n'.repeat(180));
  await ev(`openLiveFile(${JSON.stringify(file)})`);
  await until(`fileWs?.editor && fileWs.path===${JSON.stringify(file)}`);
  await ev(`window.workEntry=nav.current().id;setSidePanel('traffic');openPanelConversation('pi:fixture/media.jsonl')`);
  await until(`viewKind==='conversation' && current?.key==='pi:fixture/media.jsonl' && $('returnToWork').checkVisibility()`);
  assert.equal(await ev(`workReturnId===workEntry`), true);
  await ev(`openPanelConversation('pi:fixture/second.jsonl')`);
  await until(`current?.key==='pi:fixture/second.jsonl'`);
  assert.equal(await ev(`workReturnId===workEntry`), true, 'checking another agent keeps the original file as the return target');
  // A refresh must not discard the return address.
  await ev('window.beforeReloadMark = true'); // the old page matches until it is gone
  await command('Page.reload');
  await until(`!window.beforeReloadMark && viewKind==='conversation' && current && $('returnToWork').checkVisibility()`);
  await ev(`$('returnToWork').click()`);
  await until(`viewKind==='file' && fileWs?.path===${JSON.stringify(file)} && !!fileWs.editor`);
  assert.equal(await ev(`$('returnToWork').hidden`), true);
  assert.equal(await ev(`workReturnId`), null);

  await ev(`goHome();setSidePanel('inbox');selectTheme('eink')`);
  assert.equal(await ev(`$('homeFilters').checkVisibility()`), true);
  await screenshot('workflow-home-eink.png');
  await size(390, 844, true);
  assert.equal(await ev(`document.documentElement.scrollWidth<=innerWidth`), true);
  assert.deepEqual(exceptions, []);
});
