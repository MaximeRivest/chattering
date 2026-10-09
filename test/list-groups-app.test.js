'use strict';
// design/96: groups in the side list. A person puts open conversations in
// groups they name, folds the ones they set aside, and a folded group still
// lets through a reply or a stopped run. Against the real server and a
// headless Chromium.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromiumAvailable } = require('./helpers/chromium.js');
const { viewerBrowser } = require('./helpers/viewer-browser.js');

test('groups in the side list: make, fold, peek, rename, close, undo, by project, tidy up, several at once', { timeout: 120000 }, async t => {
  if (!chromiumAvailable()) return t.skip('chromium is not installed');
  const { home, base, work, auth, command, evaluate: ev, until, size, screenshot, exceptions } = await viewerBrowser(t);
  const shots = process.env.CHATTERING_SHOTS === '1';
  const shot = async name => { if (!shots) return; await new Promise(r => setTimeout(r, 600)); await screenshot('list-groups-' + name + '.png'); };
  const fixture = path.join(home, '.pi/agent/sessions/fixture');
  // Two projects: four conversations in "alpha", two in "beta".
  // A temporary folder is never a project: these live in the real home.
  const root = fs.mkdtempSync(path.join(os.homedir(), '.list-groups-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = { alpha: path.join(root, 'alpha'), beta: path.join(root, 'beta') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const convs = [['a1', 'alpha', 'Benchmark protocol design'], ['a2', 'alpha', 'Benchmark project setup'], ['a3', 'alpha', 'Dataset cleaning'], ['a4', 'alpha', 'Figures for the paper'], ['b1', 'beta', 'Mesh connectivity for Lily'], ['b2', 'beta', 'iPhone home screen icon']];
  const keys = {};
  convs.forEach(([name, project, title], i) => {
    keys[name] = 'pi:fixture/' + name + '.jsonl';
    const ts = new Date(Date.UTC(2026, 8, 1 + i, 12)).toISOString();
    fs.writeFileSync(path.join(fixture, name + '.jsonl'), [
      { type: 'session', version: 3, id: name, cwd: dirs[project] },
      { type: 'session_info', name: title },
      { type: 'message', id: name + '-p', parentId: null, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: title + '?' }] } },
      { type: 'message', id: name + '-a', parentId: name + '-p', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: title + ': done.' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
  });
  await fetch(base + '/api/rescan', { method: 'POST', headers: auth });
  await ev(`load()`);
  await until(`${JSON.stringify(Object.values(keys))}.every(k=>sessions.some(s=>s.key===k&&s.project!==LOOSE_PROJECT))`, 'projects assigned');
  for (const k of Object.values(keys)) { await ev(`open(${JSON.stringify(k)})`); await until(`current?.key===${JSON.stringify(k)}`); }
  const rows = `[...document.querySelectorAll('#agentsUnread [data-sec=open] .ag-item:not([inert]) .ag-row[data-key]')].map(r=>r.dataset.key)`;
  const heads = `[...document.querySelectorAll('#agentsUnread [data-sec=open] .ag-item:not([inert]) .ag-ghead')].map(h=>h.querySelector('.ag-gname,.ag-grename').textContent||h.querySelector('input')?.value)`;
  const rowOf = key => `document.querySelector('#agentsUnread .ag-item:not([inert]) .ag-row[data-key=${JSON.stringify(key)}]')`;
  const headOf = name => `[...document.querySelectorAll('#agentsUnread .ag-item:not([inert]) .ag-ghead')].find(h=>h.querySelector('.ag-gname')?.textContent===${JSON.stringify(name)})`;
  const server = async () => (await fetch(base + '/api/agent-read', { headers: auth })).json();
  const settle = async check => { for (let i = 0; i < 200; i++) { if (check(await server())) return; await new Promise(r => setTimeout(r, 30)); } assert.fail('the server did not get the change: ' + JSON.stringify(await server())); };
  const key = async (k, mods = {}) => {
    const code = { Enter: 'Enter', Escape: 'Escape', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp', F2: 'F2', ' ': 'Space' }[k] || 'Key' + k.toUpperCase();
    const vk = { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, F2: 113, ' ': 32 }[k] || k.toUpperCase().charCodeAt(0);
    const modifiers = (mods.shift ? 8 : 0);
    const text = k.length === 1 ? k : undefined;
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers, text });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const toastWith = text => `[...document.querySelectorAll('.toast')].find(t=>t.textContent.includes(${JSON.stringify(text)}))`;
  await until(`${rows}.length===6`, 'six open conversations');
  assert.equal(await ev(`document.querySelectorAll('#agentsUnread .ag-ghead').length`), 0, 'no group until a person makes one');
  await shot('0-start');

  // ⊕ on a row opens the picker; typing a name makes a group of it.
  await ev(`${rowOf(keys.a4)}.querySelector('.ag-group-btn').click()`);
  await until(`document.querySelector('.mpick.ag-group-picker input')===document.activeElement`, 'the picker has the keyboard');
  assert.match(await ev(`document.querySelector('.ag-group-picker .mp-list').textContent`), /New group “alpha”/, 'one project names itself');
  assert.match(await ev(`document.querySelector('.ag-group-picker .mp-list').textContent`), /New group “Later”/, 'Later is offered');
  await shot('1-picker');
  await ev(`(()=>{const i=document.querySelector('.ag-group-picker input');i.value='Later';i.dispatchEvent(new Event('input'))})()`);
  await key('Enter');
  await until(`!document.querySelector('.ag-group-picker') && ${headOf('Later')}`, 'the group is made');
  assert.deepEqual(await ev(rows), [keys.b2, keys.b1, keys.a3, keys.a2, keys.a1, keys.a4], 'loose rows on top, then the group');
  assert.match(await ev(`${toastWith('Moved')}.textContent`), /Moved “Figures for the paper\??” to Later · Undo/);
  await settle(s => Object.values(s.groups).some(g => g.name === 'Later') && s.member[keys.a4]);
  const laterId = (await server()).member[keys.a4];

  // g with the keyboard cursor: the group used last comes first, so g Enter repeats it.
  await ev(`toggleAgents(true)`);
  await ev(`selectAgentRow(${JSON.stringify(keys.a3)})`);
  await key('g');
  await until(`document.querySelector('.ag-group-picker .mp-row.hi')?.textContent.startsWith('▤Later')`, 'last used first: ' );
  await key('Enter');
  await until(`${rowOf(keys.a3)}?.closest('.ag-item').classList.contains('ag-tray')`, 'g Enter repeats the last group');
  await settle(s => s.member[keys.a3] === laterId);

  // Fold: the rows tuck away; the header still says how many.
  await ev(`${headOf('Later')}.click()`);
  await until(`!${rowOf(keys.a3)} && !${rowOf(keys.a4)}`, 'folded rows are hidden');
  assert.equal(await ev(`${headOf('Later')}.querySelector('.ag-gcount').textContent`), '2');
  assert.equal(await ev(`${headOf('Later')}.getAttribute('aria-expanded')`), 'false');
  await settle(s => s.groups[laterId].folded === true);
  await shot('2-folded');

  // A working agent inside shows on the header; a reply peeks out under it.
  await ev(`jobs.set('run-g',{id:'run-g',type:'agent-run',status:'running',key:${JSON.stringify(keys.a3)}});activeRuns.set('run-g',{jobId:'run-g',key:${JSON.stringify(keys.a3)},status:'running',statusText:'tool · bash',startedAt:Date.now()-5000});updateActiveBtn();renderAgentsPop(false)`);
  await until(`${headOf('Later')}.querySelector('.ag-gsum .ag-typing')`, 'the header shows the work inside');
  assert.equal(await ev(`!!${rowOf(keys.a3)}`), false, 'work alone does not unfold');
  await ev(`activeRuns.clear();jobs.delete('run-g');renderAgentsPop(false)`);
  await until(`agentReadPending.size===0`);
  await new Promise(r => setTimeout(r, 1100));
  fs.appendFileSync(path.join(fixture, 'a4.jsonl'), JSON.stringify({ type: 'message', id: 'a4-r', parentId: 'a4-a', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'The figures are ready.' }] } }) + '\n');
  await fetch(base + '/api/rescan', { method: 'POST', headers: auth }); await ev(`load()`);
  await until(`${rowOf(keys.a4)}?.classList.contains('peek') && ${rowOf(keys.a4)}.classList.contains('unread')`, 'a reply peeks out of the folded group');
  await shot('3-peek');
  // Read it: it stays while it is on screen, and tucks back once the person moves on.
  await ev(`toggleAgents(false)`);
  await ev(`${rowOf(keys.a4)}.click()`);
  await until(`current?.key===${JSON.stringify(keys.a4)} && ${rowOf(keys.a4)} && !${rowOf(keys.a4)}.classList.contains('unread')`, 'read, still shown');
  await ev(`open(${JSON.stringify(keys.b1)})`);
  await until(`current?.key===${JSON.stringify(keys.b1)} && !${rowOf(keys.a4)}`, 'tucked back in');

  // Rename in place: double-click the name.
  // A real double-click: two clicks (the first folds or unfolds), then dblclick.
  await ev(`(()=>{const h=${headOf('Later')};h.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));h.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:2}));h.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}))})()`);
  await until(`document.querySelector('#agentsUnread .ag-grename')===document.activeElement`, 'the name is editable');
  assert.equal(await ev(`${JSON.stringify(laterId)} in agentReadState.groups && agentReadState.groups[${JSON.stringify(laterId)}].folded`), true, 'the double-click does not unfold it');
  await ev(`document.querySelector('#agentsUnread .ag-grename').value='Back burner'`);
  await ev(`document.querySelector('#agentsUnread .ag-grename').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await until(`${headOf('Back burner')}`, 'renamed');
  await settle(s => s.groups[laterId].name === 'Back burner');

  // Several at once: Ctrl-click two rows, then Group… makes a new group.
  await ev(`${rowOf(keys.b1)}.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))`);
  await ev(`${rowOf(keys.b2)}.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))`);
  await until(`document.querySelector('.ag-selbar')?.textContent.includes('2 selected')`, 'two picked');
  assert.equal(await ev(`current?.key`), keys.b1, 'Ctrl-click picks, it does not open');
  await shot('4-selection');
  await ev(`document.querySelector('.ag-selbar [data-sel=group]').click()`);
  await until(`document.querySelector('.ag-group-picker')`);
  assert.match(await ev(`document.querySelector('.ag-group-picker .ag-gp-head').textContent`), /Move 2 conversations to/);
  await ev(`(()=>{const i=document.querySelector('.ag-group-picker input');i.value='Lily';i.dispatchEvent(new Event('input'))})()`);
  await ev(`document.querySelector('.ag-group-picker .mp-row').click()`);
  await until(`${headOf('Lily')} && !document.querySelector('.ag-selbar')`, 'a new group of the two, the selection gone');
  assert.deepEqual(await ev(heads), ['Lily', 'Back burner'], 'a new group goes first among the groups');
  await settle(s => Object.values(s.groups).length === 2);

  // Undo puts things back exactly, on the server too.
  await ev(`${toastWith('Moved 2 conversations to Lily')}.click()`);
  await until(`!${headOf('Lily')}`, 'undone');
  await settle(s => Object.values(s.groups).length === 1 && !s.member[keys.b1]);

  // Closing a grouped row keeps its group: a later reply brings it back there.
  await ev(`${headOf('Back burner')}.click()`);
  await until(`${rowOf(keys.a3)}`, 'unfolded');
  await ev(`${rowOf(keys.a3)}.querySelector('.ag-close').click()`);
  await until(`!${rowOf(keys.a3)}`, 'closed');
  await settle(s => s.dismissed[keys.a3] && s.member[keys.a3] === laterId);
  await new Promise(r => setTimeout(r, 1100));
  fs.appendFileSync(path.join(fixture, 'a3.jsonl'), JSON.stringify({ type: 'message', id: 'a3-r', parentId: 'a3-a', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Cleaned.' }] } }) + '\n');
  await fetch(base + '/api/rescan', { method: 'POST', headers: auth }); await ev(`load()`);
  await until(`${rowOf(keys.a3)}?.closest('.ag-item').classList.contains('ag-tray')`, 'back, in its group');

  // Keyboard folding: ← folds the group the cursor is in and lands on its header.
  await ev(`toggleAgents(true); selectAgentRow(${JSON.stringify(keys.a3)})`);
  await key('ArrowLeft');
  await until(`agentReadState.groups[${JSON.stringify(laterId)}].folded && agentsSelectedKey==='group:'+${JSON.stringify(laterId)}`, '← folds, the cursor on the header');
  await key('ArrowRight');
  await until(`!agentReadState.groups[${JSON.stringify(laterId)}].folded`, '→ unfolds');
  await key('Escape');

  // Drag a loose row onto another: the two make a group, named after their project.
  await ev(`(()=>{const dt=new DataTransfer();const from=${rowOf(keys.a2)},to=${rowOf(keys.a1)};from.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));to.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));to.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));from.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}))})()`);
  await until(`document.querySelector('#agentsUnread .ag-grename')?.value==='alpha'`, 'a group of the two, ready to rename');
  await ev(`document.querySelector('#agentsUnread .ag-grename').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  await until(`${headOf('alpha')} && ${headOf('alpha')}.querySelector('.ag-gcount').textContent==='2'`);
  await shot('5-groups');

  // By project: a view of this device; the groups stay as they are.
  await ev(`$('sideArrange').click()`);
  await ev(`[...document.querySelectorAll('.ag-menu button')].find(b=>b.textContent.startsWith('By project')).click()`);
  await until(`document.querySelector('.ag-lensbar') && ${heads}.join()==='beta,alpha'`, 'arranged by project: ' );
  assert.equal(await ev(`$('sideArrange').classList.contains('lens')`), true, 'the button says the view is on');
  assert.equal(await ev(`${rowOf(keys.b1)}.querySelector('.ag-project')`), null, 'rows do not repeat the project');
  await shot('6-by-project');
  assert.equal(Object.values((await server()).groups).length, 2, 'the groups are untouched');
  await ev(`document.querySelector('.ag-lensbar button').click()`);
  await until(`!document.querySelector('.ag-lensbar') && ${headOf('Back burner')}`);

  // Tidy up proposes, shows, and only applies when asked. Rows in use stay loose.
  await ev(`ListGroups.move([${JSON.stringify(keys.a1)},${JSON.stringify(keys.a2)}], null, { quiet: true })`);
  await until(`!${headOf('alpha')}`);
  for (const k of [keys.a1, keys.a2, keys.b2]) await ev(`agentReadState.read[${JSON.stringify(k)}]=Date.now()`);
  await ev(`(()=>{for(const s of sessions)s.mtimeMs=Date.now()-2*3600e3; renderAgentsPop(false)})()`);
  await ev(`$('sideArrange').click()`);
  await ev(`[...document.querySelectorAll('.ag-menu button')].find(b=>b.textContent.startsWith('Tidy up')).click()`);
  await until(`document.querySelector('.ag-tidybar')`, 'a proposal is shown');
  assert.equal(Object.values((await server()).groups).length, 1, 'nothing moved yet');
  await shot('7-tidy');
  await ev(`document.querySelector('.ag-tidybar [data-tidy=apply]').click()`);
  await until(`!document.querySelector('.ag-tidybar') && ${headOf('alpha')}`, 'applied');
  assert.equal(await ev(`!!${rowOf(keys.b1)} && !${rowOf(keys.b1)}.closest('.ag-item').classList.contains('ag-tray')`), true, 'the conversation on screen stays loose');
  await settle(s => Object.values(s.groups).some(g => g.name === 'alpha' && g.folded));

  // A fork joins the group of the conversation it came from.
  const aGroup = (await server()).member[keys.a1];
  await ev(`ListGroups.follow(${JSON.stringify(keys.a1)}, 'pi:fixture/fork.jsonl')`);
  await settle(s => s.member['pi:fixture/fork.jsonl'] === aGroup);

  // A group's + starts a draft that will join it.
  await ev(`toggleAgents(false)`);
  await ev(`${headOf('alpha')}.querySelector('[data-gnew]').click()`);
  await until(`viewKind==='draft' && draftState?.d?.group===${JSON.stringify(aGroup)}`, 'the draft carries the group');
  assert.match(await ev(`document.querySelector('.draft-group').textContent`), /It will join the group alpha/);
  assert.equal(await ev(`agentReadState.groups[${JSON.stringify(aGroup)}].folded`), false, 'the group unfolds to receive it');

  // Light and e-ink themes: the trays still read as groups.
  if (shots) {
    for (const theme of ['rockfrog-light', 'eink']) {
      await ev(`document.documentElement.dataset.theme=${JSON.stringify(theme)};${theme === 'eink' ? "document.documentElement.dataset.themeMode='binary';document.documentElement.dataset.themeMotion='none';" : ''}renderAgentsPop(false)`);
      await shot('9-' + theme);
    }
    await ev(`delete document.documentElement.dataset.themeMode;delete document.documentElement.dataset.themeMotion;document.documentElement.dataset.theme='rockfrog-dark'`);
  }

  // A phone: the same groups; ⋯ offers "Move to a group…", the picker is a bottom sheet.
  await size(390, 800, true);
  await until(`document.body.classList.contains('phone-shell')`);
  await ev(`toggleAgents(true)`);
  await until(`!$('agentsPop').hidden && ${headOf('alpha')}`, 'the phone sheet shows the groups');
  await ev(`${rowOf(keys.b1)}.querySelector('.ag-more').click()`);
  await ev(`[...document.querySelectorAll('.ag-menu button')].find(b=>b.textContent.startsWith('Move to a group')).click()`);
  await until(`document.querySelector('.ag-group-picker')`);
  const sheet = await ev(`(()=>{const r=document.querySelector('.ag-group-picker').getBoundingClientRect();return {left:r.left,width:r.width,bottom:innerHeight-r.bottom}})()`);
  assert.equal(sheet.left, 0, 'a bottom sheet, edge to edge');
  assert.equal(sheet.width, 390);
  await shot('8-phone');
  await key('Escape');

  assert.deepEqual(exceptions, [], 'no exceptions');
  if (shots) fs.writeFileSync(path.join(os.tmpdir(), 'list-groups-done'), 'ok');
});
