'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../sidebar-projects');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('project directory includes empty registered projects, folds, titles and current activity', () => {
  const rows = P.build([
    { project: 'work', cwd: '/work/sub', mtimeMs: 200 },
    { project: 'work-tree', cwd: '/work-tree', mtimeMs: 300 },
    { project: 'work', hiddenFanout: true, mtimeMs: 900 },
    { project: 'Loose conversations', mtimeMs: 999 },
  ], [{ name: 'empty', cwd: '/empty', createdAt: 100 }], [{ name: 'work', cwd: '/work', title: 'Workspace' }], s => s.project === 'work-tree' ? 'work' : s.project);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.find(r => r.name === 'work'), { name: 'work', title: 'Workspace', cwd: '/work', count: 2, latest: 300, createdAt: 0 });
  assert.equal(rows.find(r => r.name === 'empty').count, 0);
  assert.deepEqual(P.select(rows, { query: 'work space' }).map(r => r.name), ['work']);
});

test('file work contributes recency without changing conversation counts or inventing projects', () => {
  const rows = P.build([{ project: 'work', cwd: '/work', mtimeMs: 10 }], [], [], s => s.project,
    'Loose conversations', [{ project: 'work', at: 90 }, { project: 'orphan', at: 100 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].latest, 90);
  assert.equal(rows[0].count, 1);
});

test('sort modes are stable and unknown measurements are never treated as zero', () => {
  const rows = [
    { name: 'a', title: 'Zebra', count: 2, latest: 40, cwd: '/a' },
    { name: 'b', title: 'Alpha', count: 5, latest: 20, cwd: '/b' },
    { name: 'c', count: 1, latest: 10, cwd: '/c' },
  ];
  const names = options => P.select(rows, options).map(r => r.name);
  assert.deepEqual(names({ sort: 'recent' }), ['a', 'b', 'c']);
  assert.deepEqual(names({ sort: 'name' }), ['b', 'c', 'a']);
  assert.deepEqual(names({ sort: 'count' }), ['b', 'a', 'c']);
  assert.deepEqual(names({ sort: 'size', stats: { a: { size: 0 }, c: { size: 90 } } }), ['c', 'a', 'b']);
  assert.deepEqual(names({ sort: 'born', stats: { a: { born: 0 }, b: { born: 20 }, c: { born: 10 } } }), ['b', 'c', 'a']);
});

test('project timeline bounds, quiet badges and scroll-loaded lists in the real app', { timeout: 60000 }, async t => {
  const { home, base, evaluate: ev, until, size, command, screenshot, exceptions, auth } = await viewerBrowser(t);
  // Temporary cwd paths are intentionally classified as loose conversations.
  // Give this fixture a real project-shaped cwd outside /tmp.
  const projectHome = fs.mkdtempSync(path.join(os.homedir(), '.sidebar-projects-test-'));
  t.after(() => fs.rmSync(projectHome, { recursive: true, force: true }));
  const cwd = path.join(projectHome, 'work'); fs.mkdirSync(cwd);
  const sessionFile = path.join(home, '.pi/agent/sessions/fixture/media.jsonl');
  const entries = fs.readFileSync(sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
  entries[0].cwd = cwd; fs.writeFileSync(sessionFile, entries.map(JSON.stringify).join('\n') + '\n');
  assert.equal((await fetch(base + '/api/rescan', { method: 'POST', headers: auth })).status, 200);
  await ev(`load()`);
  await until(`sessions.some(s=>projectOf(s)==='work') && sideLayoutOn()`);
  // A project's page: its timeline, opened, never covers the column.
  await ev(`showProjectOverview('work')`);
  await until(`viewKind==='project' && !!document.querySelector('.mgantt')`);
  await ev(`document.querySelector('.mgantt').click()`);
  await until(`!!document.querySelector('.mgantt[data-mg-open]')`);
  const bounds = () => ev(`(()=>{const g=document.querySelector('.mgantt[data-mg-open]').getBoundingClientRect(),s=$('side').getBoundingClientRect();return {left:g.left,right:g.right,top:g.top,edge:s.right}})()`);
  let b = await bounds(); assert.ok(Math.abs(b.left-b.edge)<2 && b.right<=1440 && b.top===0, JSON.stringify(b));
  assert.equal(await ev(`document.elementFromPoint(100,100)?.closest('#side') !== null`), true, 'chart never paints over sidebar controls');
  await screenshot('projects-gantt-layout.png');
  // Folded, the chart uses the freed space (design/51).
  await ev(`setSideFold(true)`);
  b = await bounds(); assert.ok(Math.abs(b.left)<2, 'folded chart starts at the edge: ' + JSON.stringify(b));
  await ev(`setSideFold(false)`);
  await size(390, 844); await until(`!sideLayoutOn()`);
  b = await bounds(); assert.equal(b.left, 0); assert.ok(b.right<=390);
  await size(1440, 1000); await until(`sideLayoutOn()`);
  await ev(`mgCollapseOpen()`);

  // The folded column's reopen button: a quiet dot by default, the unread
  // count when the person asks for numbers; the choice survives a reload.
  // Painted and read in one turn: a real poll may repaint in between.
  const badge = `(()=>{const b=document.querySelector('#sideUnfold .rail-badge');return {hidden:b.hidden,text:b.textContent,dot:b.classList.contains('dot')}})()`;
  assert.deepEqual(await ev(`paintRailBadges({working:true,unread:3});${badge}`), { hidden: false, text: '', dot: true });
  assert.equal(await ev(`$('sideUnfold').classList.contains('work')`), true, 'the reopen symbol shows work in progress');
  await ev(`showSettings('appearance')`);
  await until(`!!$('setRailCounts')`);
  assert.equal(await ev(`$('setRailCounts').checked`), false);
  assert.deepEqual(await ev(`$('setRailCounts').checked=true;$('setRailCounts').dispatchEvent(new Event('change'));paintRailBadges({unread:3});${badge}`), { hidden: false, text: '3', dot: false });
  assert.equal(await ev(`JSON.parse(localStorage.getItem(AGENT_SEC_KEY)).railCounts`), true);
  await ev(`window.beforeBadgeReload=true`); await command('Page.reload');
  await until(`!window.beforeBadgeReload && !!document.querySelector('#setRailCounts')`);
  assert.equal(await ev(`$('setRailCounts').checked`), true, 'badge preference survives reload');
  await ev(`$('setRailCounts').checked=false;$('setRailCounts').dispatchEvent(new Event('change'));goHome()`);

  // Long lists page by a hundred, load more on scroll, and reach the last
  // record: the side list and the Files panel. Synthetic records: the
  // production selection, rendering and scroll handlers are the ones used.
  await ev(`window.panelFixtureKeep={sessions,recentFilesList,agentReadState,agentSecState:{...agentSecState}};
    const old=Date.now()-7*86400000;
    sessions=Array.from({length:205},(_,i)=>({key:'pi:page/'+i,source:'pi',project:'page-project-'+String(i).padStart(3,'0'),cwd:'/fixture/page-'+i,title:'Older conversation '+i,firstTs:new Date(old-i*1000).toISOString(),lastUserTs:new Date(old-i*1000).toISOString(),mtimeMs:old-i*1000}));
    agentReadState={...agentReadState,opened:Object.fromEntries(sessions.map(s=>[s.key,old])),read:Object.fromEntries(sessions.map(s=>[s.key,Date.now()])),dismissed:{},pinned:{},flagged:{}};
    panelListLimits.clear();renderAgentsPop(false);`);
  const rows = `document.querySelectorAll('#agentsUnread .ag-row[data-key^="pi:page/"]').length`;
  assert.equal(await ev(rows), 100, 'first page of the side list');
  await ev(`$('agentsUnread').scrollTop=$('agentsUnread').scrollHeight;$('agentsUnread').dispatchEvent(new Event('scroll'));$('agentsPop').scrollTop=$('agentsPop').scrollHeight;$('agentsPop').dispatchEvent(new Event('scroll'))`);
  await until(`${rows}===200`, 'scrolling loads the next page');
  await ev(`document.querySelector('#agentsUnread [data-panel-more=open]').click()`);
  await until(`${rows}===205`, 'the last page is reachable');
  assert.equal(await ev(`!!document.querySelector('#agentsUnread [data-panel-more=open]')`), false, 'no dead end before the last record');
  await ev(`recentFilesList=Array.from({length:205},(_,i)=>({path:'/fixture/file-'+i+'.md',project:'fixture',actor:'human',kind:'opened',at:Date.now()-i}));agentSecState['files:actor']='human';panelListLimits.clear();setRightFiles('recent-files',true)`);
  assert.equal(await ev(`document.querySelectorAll('#rightFileList .ag-file').length`), 100, 'files page by a hundred');
  await ev(`$('rightFileList').scrollTop=$('rightFileList').scrollHeight;$('rightFileList').dispatchEvent(new Event('scroll'))`);
  await until(`document.querySelectorAll('#rightFileList .ag-file').length===200`);
  await ev(`document.querySelector('#rightFileList [data-panel-more=files]').click()`);
  assert.equal(await ev(`document.querySelectorAll('#rightFileList .ag-file').length`), 205);
  assert.equal(await ev(`!!document.querySelector('#rightFileList [data-panel-more=files]')`), false, 'no dead end before the last record');
  await ev(`({sessions,recentFilesList,agentReadState,agentSecState}=panelFixtureKeep);panelListLimits.clear();saveAgentSecState();setRightFiles('recent-files',false);renderAgentsPop(false)`);
  assert.deepEqual(exceptions, []);
});
