'use strict';
// design/96: a conversation started with a group's ＋ is in that group once
// it exists, on every device, as the draft promised.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromiumAvailable } = require('./helpers/chromium.js');
const { viewerBrowser } = require('./helpers/viewer-browser.js');
const { fakeOpenAI } = require('./helpers/fake-openai.js');

test('a conversation started with a group’s + joins the group, in one project or across several', { skip: !chromiumAvailable() && 'chromium is not installed', timeout: 180000 }, async t => {
  const model = await fakeOpenAI({ reply: 'Noted.' });
  t.after(() => model.close());
  const { home, base, auth, evaluate: ev, until, exceptions } = await viewerBrowser(t);
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const d = await r.json(); assert.ok(r.ok, p + ': ' + JSON.stringify(d)); return d; };
  await post('/api/ai/server', { baseUrl: model.baseUrl });
  const fixture = path.join(home, '.pi/agent/sessions/fixture');
  const root = fs.mkdtempSync(path.join(os.homedir(), '.list-groups-plus-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = { alpha: path.join(root, 'alpha'), beta: path.join(root, 'beta') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const keys = {};
  [['a1', 'alpha', 'Benchmark protocol'], ['b1', 'beta', 'Mesh for Lily']].forEach(([name, project, title], i) => {
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
  const server = async () => (await fetch(base + '/api/agent-read', { headers: auth })).json();
  const headOf = name => `[...document.querySelectorAll('#agentsUnread .ag-item:not([inert]) .ag-ghead')].find(h=>h.querySelector('.ag-gname')?.textContent===${JSON.stringify(name)})`;

  async function startFrom(group, text) {
    await ev(`toggleAgents(true)`);
    await until(`${headOf(group)}`, 'the group ' + group + ' is in the list');
    await ev(`${headOf(group)}.querySelector('[data-gnew]').click()`);
    await until(`viewKind==='draft'`, 'a draft opens');
    const gid = await ev(`draftState?.d?.group || ''`);
    assert.ok(gid, 'the draft carries the group ' + group);
    await ev(`(()=>{const t=document.getElementById('agentText');t.value=${JSON.stringify(text)};t.dispatchEvent(new Event('input'))})()`);
    await ev(`document.getElementById('agentRun').click()`);
    await until(`viewKind==='conversation' && current && current.key && !current.key.startsWith('draft')`, 'the conversation opened');
    const key = await ev(`current.key`);
    for (let i = 0; i < 100; i++) { if ((await server()).member[key] === gid) break; await new Promise(r => setTimeout(r, 50)); }
    assert.equal((await server()).member[key], gid, 'the server keeps the new conversation in ' + group);
    assert.equal(await ev(`agentReadState.member[${JSON.stringify(key)}]`), gid, 'the page shows it in ' + group);
    return key;
  }

  // One project in the group: the draft starts in that folder and joins.
  await ev(`ListGroups.move([${JSON.stringify(keys.a1)}], null, { name: 'alpha' })`);
  await until(`${headOf('alpha')}`);
  const k1 = await startFrom('alpha', 'First in alpha');
  assert.equal(await ev(`projectOf(sessions.find(s=>s.key===${JSON.stringify(k1)}))`), 'alpha', 'in the group’s project');

  // Several projects in the group: no folder to guess, the draft still joins.
  await ev(`ListGroups.move([${JSON.stringify(keys.a1)}, ${JSON.stringify(keys.b1)}], null, { name: 'mixed' })`);
  await until(`${headOf('mixed')}`);
  await startFrom('mixed', 'Across projects');

  assert.deepEqual(exceptions, [], 'no exceptions');
});

// Lilly's conversations (2026-10): run from the home folder, put in a group
// named after the project, they were in the group but not in the project,
// so their memory leaves fed no project. A group named after a project
// files a loose conversation under it, its ＋ starts in that project, and a
// copy of a filed conversation stays filed.
test('a group named after a project: loose conversations put in it join the project', { skip: !chromiumAvailable() && 'chromium is not installed', timeout: 180000 }, async t => {
  const { home, base, auth, evaluate: ev, until, exceptions } = await viewerBrowser(t);
  const api = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }); const d = await r.json(); assert.ok(r.ok, p + ': ' + JSON.stringify(d)); return d; };
  const fixture = path.join(home, '.pi/agent/sessions/fixture');
  const root = fs.mkdtempSync(path.join(os.homedir(), '.list-groups-project-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = { corn: path.join(root, 'corn'), other: path.join(root, 'other'), loose: '/home/fixture-person' };
  fs.mkdirSync(dirs.corn); fs.mkdirSync(dirs.other);
  const keys = {};
  [['c1', 'corn', 'Kernel masks'], ['o1', 'other', 'Benchmark'], ['l1', 'loose', 'Corn masks'], ['l2', 'loose', 'SAM skill']].forEach(([name, where, title], i) => {
    keys[name] = 'pi:fixture/' + name + '.jsonl';
    const ts = new Date(Date.UTC(2026, 9, 1 + i, 12)).toISOString();
    fs.writeFileSync(path.join(fixture, name + '.jsonl'), [
      { type: 'session', version: 3, id: name, timestamp: ts, cwd: dirs[where] },
      { type: 'session_info', name: title },
      { type: 'message', id: name + '-p', parentId: null, timestamp: ts, message: { role: 'user', content: [{ type: 'text', text: title + '?' }] } },
      { type: 'message', id: name + '-a', parentId: name + '-p', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: title + ': done.' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
  });
  await fetch(base + '/api/rescan', { method: 'POST', headers: auth });
  await ev(`load()`);
  const projectOf = k => `projectOf(sessions.find(s=>s.key===${JSON.stringify(k)})||{})`;
  await until(`${projectOf(keys.c1)}==='corn' && ${projectOf(keys.l1)}===LOOSE_PROJECT`, 'fixture projects');
  for (const k of Object.values(keys)) { await ev(`open(${JSON.stringify(k)})`); await until(`current?.key===${JSON.stringify(k)}`); }
  const toastText = () => ev(`[...document.querySelectorAll('#toasts .toast')].map(x=>x.textContent).join(' | ')`);

  // Into a group named after the project: the loose one is filed, the one
  // from another project keeps its project; one message, one Undo.
  await ev(`ListGroups.move([${JSON.stringify(keys.c1)}], null, { name: 'corn' })`);
  await ev(`ListGroups.move([${JSON.stringify(keys.l1)}, ${JSON.stringify(keys.o1)}], null, { name: 'corn' })`);
  await until(`${projectOf(keys.l1)}==='corn'`, 'the loose conversation joined project corn');
  assert.equal(await ev(projectOf(keys.o1)), 'other', 'a conversation of another project stays in it');
  assert.match(await toastText(), /filed under project corn · Undo/, 'the move says it filed it');
  const assigned = JSON.parse(fs.readFileSync(path.join(home, 'notes/chattering/projects/conversation-projects.json'), 'utf8'));
  assert.equal(assigned[keys.l1], 'corn', 'a durable assignment on the server');
  assert.equal(assigned[keys.o1], undefined, 'nothing for the other project’s conversation');

  // Undo takes back the group and the filing.
  await ev(`[...document.querySelectorAll('#toasts .toast')].find(x=>/filed under/.test(x.textContent)).click()`);
  await until(`${projectOf(keys.l1)}===LOOSE_PROJECT && !agentReadState.member[${JSON.stringify(keys.l1)}]`, 'Undo: loose again and out of the group');

  // The frog's path (the server rule alone, no page): a loose one put in the group is filed.
  await api('POST', '/api/agent-read', { grouping: { member: { [keys.l2]: await ev(`agentReadState.member[${JSON.stringify(keys.c1)}]`) } } });
  await until(`${projectOf(keys.l2)}==='corn'`, 'filed by the server rule');

  // A copy of a filed conversation stays in the project (same folder).
  const fork = await api('POST', '/api/fork', { id: keys.l2, node: 'l2-a' });
  await until(`sessions.some(s=>s.key===${JSON.stringify(fork.key)}) && ${projectOf(fork.key)}==='corn'`, 'the ⤔ copy is in corn too');

  // The group's ＋ starts in the project the group is named after, even with
  // loose and other-project rows in it (before: the home folder).
  await ev(`ListGroups.move([${JSON.stringify(keys.o1)}], agentReadState.member[${JSON.stringify(keys.c1)}])`);
  const gid = await ev(`agentReadState.member[${JSON.stringify(keys.c1)}]`);
  assert.equal(await ev(`ListGroups.projectOfGroup(${JSON.stringify(gid)})`), 'corn');
  await ev(`ListGroups.newIn(${JSON.stringify(gid)})`);
  await until(`viewKind==='draft' && draftState?.d?.folder`, 'the draft has a folder');
  assert.equal(await ev(`draftState.d.folder`), dirs.corn, 'the ＋ runs in the project’s folder');

  assert.deepEqual(exceptions, [], 'no exceptions');
});
