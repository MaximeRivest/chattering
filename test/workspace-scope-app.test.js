'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

// Two minutes, as the other long browser tests: 17 s alone, once over 60 s on a loaded Windows CI machine.
test('one explicit project scope for browsing; a machine-wide Inbox; scope-aware history', { timeout: 120000 }, async t => {
  const { home, base, evaluate: ev, until, command, screenshot, requests, exceptions, auth } = await viewerBrowser(t);
  const root = fs.mkdtempSync(path.join(os.homedir(), '.scope-projects-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keys = {}, paths = {}, raw = {};
  for (const name of ['alpha', 'beta']) {
    const cwd = path.join(root, name); fs.mkdirSync(cwd);
    paths[name] = path.join(cwd, name + '.md'); fs.writeFileSync(paths[name], '# ' + name + '\n');
    keys[name] = 'pi:fixture/' + name + '.jsonl';
    raw[name] = [
      { type: 'session', version: 3, id: name, cwd },
      { type: 'message', id: name+'-p', parentId: null, timestamp: '2026-09-01T12:00:00Z', message: { role: 'user', content: [{type:'text',text:name+' question'}] } },
      { type: 'message', id: name+'-a', parentId: name+'-p', timestamp: '2026-09-01T12:00:01Z', message: { role: 'assistant', content: [{type:'text',text:name+' reply'}] } },
    ].map(JSON.stringify).join('\n')+'\n';
    fs.writeFileSync(path.join(home,'.pi/agent/sessions/fixture',name+'.jsonl'),raw[name]);
  }
  assert.equal((await fetch(base+'/api/rescan',{method:'POST',headers:auth})).status, 200); await ev(`load();loadSidebarProjectCatalog()`);
  await until(`sessions.some(s=>s.key===${JSON.stringify(keys.beta)}) && !sidebarProjectCatalogRequest`);
  const post = (url, body) => fetch(base+url,{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>{assert.equal(r.status,200,url);return r.json()});
  for (const name of ['alpha','beta']) await post('/api/recent-files',{path:paths[name],project:name});
  await ev(`loadRecentFiles()`);
  const pick = async project => {
    // All selected: the project button opens the picker; a project chosen:
    // the small arrow beside it does (design/51).
    await ev(`(workspaceScope() ? $('sideProjectMore') : $('sideProject')).click()`);
    await until(`!!document.querySelector('.project-scope-picker')`);
    await ev(`[...document.querySelectorAll('[data-workspace-project]')].find(b=>b.dataset.workspaceProject===${JSON.stringify(project)}).click()`);
    await until(`workspaceScope()===${JSON.stringify(project)}`);
  };
  // design/51: with All selected the project button opens the picker; with
  // a project chosen it opens that project's overview.
  await pick('alpha');
  await ev(`$('sideProject').click()`);
  await until(`viewKind==='project' && projectOverviewName==='alpha' && workspaceScope()==='alpha' && !!document.querySelector('.project-overview')`);
  assert.equal(await ev(`$('sideProject').textContent.includes('alpha')`), true);
  assert.equal(await ev(`!!document.querySelector('#agentsPop [data-sec=unread],#agentsPop [data-sec=read],[data-scope-of]')`), false, 'no global inbox sections and no second scope toggle');
  await ev(`setSidePanel('files')`);
  console.log('RP', await ev(`JSON.stringify({open:rightFilesOpen, mode:rightFilesMode, list:recentFilesList.length, html:$('rightFileList').innerHTML.slice(0,400), side:sideLayoutOn(), cls:document.body.className})`));
  assert.deepEqual(await ev(`[...document.querySelectorAll('.ag-file')].map(r=>r.dataset.path)`), [paths.alpha]);
  await pick('beta'); await ev(`setSidePanel('files');renderAgentsPop(false)`);
  assert.deepEqual(await ev(`[...document.querySelectorAll('.ag-file')].map(r=>r.dataset.path)`), [paths.beta]);
  await ev(`setSidePanel('recent-files')`);
  assert.deepEqual(await ev(`[...document.querySelectorAll('.ag-file')].map(r=>r.dataset.path).sort()`), Object.values(paths).sort(), 'Recent ignores project scope');
  assert.equal(await ev(`document.querySelector('.ag-files-block').checkVisibility()`), true);
  assert.equal(await ev(`workspaceScope()`), 'beta', 'global recents does not change the selected project');
  assert.equal(await ev(`$('sideNew').querySelector('span').textContent`), 'new here', 'new here follows the chosen project, not a stale chat');
  // With All chosen, the Files panel's Project side is unavailable and says
  // why; All lists both (design/51).
  await pick(''); await ev(`setSidePanel('files')`);
  assert.equal(await ev(`document.querySelectorAll('#rightFileList .ag-file').length + '|' + document.querySelector('[data-file-scope=files]').disabled`), '0|true');
  assert.match(await ev(`$('rightFileList').textContent`), /Choose a project on the left, or switch to All/);
  await ev(`setSidePanel('recent-files')`);
  assert.equal(await ev(`document.querySelectorAll('#rightFileList .ag-file').length`), 2);
  await ev(`open(${JSON.stringify(keys.alpha)})`);
  assert.equal(await ev(`workspaceScope()`), '', 'All stays broad while browsing ordinary chats');

  // Browsing a project and returning restores the old All scope, not merely
  // whichever project happens to be on screen at the time of Back.
  await pick('beta'); await until(`viewKind==='project' && projectOverviewName==='beta'`);
  await ev(`history.back()`);
  await until(`viewKind==='conversation' && current?.key===${JSON.stringify(keys.alpha)} && workspaceScope()===''`);
  await ev(`history.forward()`);
  await until(`viewKind==='project' && projectOverviewName==='beta' && workspaceScope()==='beta'`);

  // The list is global whatever project is chosen, names each row's
  // project, and a folded column's reopen button carries the unread dot.
  await ev(`pushAgentReads()`); await until(`agentReadPending.size===0 && !agentReadPushing`);
  await post('/api/agent-read',{unread:[keys.alpha,keys.beta],pin:{[keys.beta]:true}});
  await ev(`fetchAgentReadState()`);
  await ev(`setSidePanel('inbox')`);
  await until(`document.querySelectorAll('#agentsUnread .ag-row.unread[data-key]').length>=2`);
  assert.deepEqual(await ev(`[...document.querySelectorAll('#agentsUnread .ag-row.unread .ag-project')].map(n=>n.textContent).sort()`), ['alpha','beta']);
  await ev(`setSideFold(true)`);
  assert.equal(await ev(`document.querySelector('#sideUnfold .rail-badge').hidden`), false, 'unread replies ask for attention');
  await ev(`setSideFold(false)`);
  await ev(`[...document.querySelectorAll('#agentsUnread .ag-row')].find(r=>r.dataset.key===${JSON.stringify(keys.alpha)}).querySelector('.ag-main').click()`);
  await until(`viewKind==='conversation' && current?.key===${JSON.stringify(keys.alpha)} && workspaceScope()==='alpha'`);
  assert.equal(await ev(`sidePanel()`), 'inbox', 'opening a reply keeps the list');
  assert.equal(await ev(`!!document.querySelector('#agentsUnread .ag-row[data-key=${JSON.stringify(keys.beta)}]')`), true, 'another project\'s row stays listed');
  assert.equal(await ev(`!!document.querySelector('[data-sec=unread],[data-sec=read],[data-inbox-tab]')`), false, 'no Unread / Read sections or tabs');

  // Processes stay global even when browsing one project.
  await ev(`window.savedScopeProcs=agentsProcs;agentsProcs=[{pid:99101,key:${JSON.stringify(keys.alpha)},kind:'pi',owner:'fixture',busy:false,title:'alpha worker'},{pid:99102,key:${JSON.stringify(keys.beta)},kind:'pi',owner:'fixture',busy:false,title:'beta worker'},{pid:99103,kind:'pi',owner:'fixture',busy:false,title:'unknown worker'}];renderAgentsPop(false);updateActiveBtn()`);
  assert.equal(await ev(`$('agentsPop').textContent.includes('unknown worker')`), true);
  await pick(''); await ev(`renderAgentsPop(false)`);
  assert.equal(await ev(`$('agentsPop').textContent.includes('unknown worker')`), true);
  await ev(`agentsProcs=savedScopeProcs;renderAgentsPop(false)`);

  // No project is an explicit collection, not another spelling of All.
  await pick('Loose conversations');
  assert.equal(await ev(`$('sideProject').querySelector('span').textContent`), 'No project');
  await pick('alpha'); await ev(`setSidePanel('files')`);
  // A direct file link outside the selected scope adopts its own project.
  // A deliberately delayed project response must not overwrite that file.
  await ev(`window.scopeFetch=fetch;window.scopeProjectReply=null;window.fetch=(url,opts)=>String(url)==='/api/project?name=alpha'?new Promise(resolve=>scopeProjectReply=resolve):scopeFetch(url,opts);window.slowProject=showProjectOverview('alpha');void 0`);
  await until(`!!window.scopeProjectReply`);
  await ev(`openLiveFile(${JSON.stringify(paths.beta)},{project:'beta'})`);
  await until(`fileWs?.path===${JSON.stringify(paths.beta)} && !!fileWs.editor && workspaceScope()==='beta'`);
  await ev(`scopeProjectReply(new Response(JSON.stringify({error:'old project response'})));slowProject`);
  await ev(`window.fetch=scopeFetch`);
  assert.equal(await ev(`viewKind==='file' && !!$('docEditor') && workspaceScope()==='beta'`), true, 'a late project response cannot paint over a newer file');
  await ev(`window.scopeBeforeReload=true`); await command('Page.reload');
  await until(`!window.scopeBeforeReload && typeof workspaceScope==='function' && workspaceScope()==='beta' && fileWs?.path===${JSON.stringify(paths.beta)}`);
  assert.equal(await ev(`$('sideProject').querySelector('span').textContent`), 'beta');
  await ev(`setSidePanel('inbox')`);
  await screenshot('workspace-inbox.png');
  await ev(`setSidePanel('files')`); await screenshot('workspace-files.png');
  await ev(`$('sideProject').click()`); await screenshot('workspace-project-picker.png');
  assert.equal(requests.some(r=>r.method==='PUT'&&r.url.includes('/api/conversation/project')), false, 'scope selection never reassigns a conversation');
  for (const name of ['alpha','beta']) assert.equal(fs.readFileSync(path.join(home,'.pi/agent/sessions/fixture',name+'.jsonl'),'utf8'),raw[name], 'navigation never rewrites the session');
  assert.deepEqual(exceptions, []);
});
