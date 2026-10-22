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
