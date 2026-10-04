'use strict';
// A shared notebook in the real app, with the real editor bundle's
// y-websocket provider, through dropped connections. The bug this guards:
// a page keeps its copy of the document across a reconnect, and the server
// had rebuilt its own from the disk text, so the resync repeated the whole
// notebook (and the quiet save wrote it to disk that way).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const NOTEBOOK = '# Notebook\n\nSome words.\n\n```python\nprint(1)\n```\n';

test('a shared notebook is never repeated by a reconnect', { timeout: 120000 }, async t => {
  const b = await viewerBrowser(t);
  const { work, home, evaluate: run, until, open } = b;
  const file = path.join(work, 'notebook.md');
  fs.writeFileSync(file, NOTEBOOK);
  const disk = () => fs.readFileSync(file, 'utf8');
  const untilDisk = async (want, label) => { for (let i = 0; i < 200 && disk() !== want; i++) await sleep(50); assert.equal(disk(), want, label); };
  await open('notebook.md');
  await until(`fileWs?.collab?.synced && docState?.editor && docState.editor.getContent()===${JSON.stringify(NOTEBOOK)}`, 'the notebook opens shared');
  const lineage = await run(`fileWs.collab.provider.params.lineage`);
  assert.ok(lineage, 'the page learned the lineage of the server copy');

  // 1. The connection drops long enough for the server to let the document
  //    go (it was the only viewer), then comes back on its own.
  await run(`fileWs.collab.provider.ws.close()`);
  await until(`fileWs.collab.provider.wsconnected && fileWs.collab.provider.synced`, 'the provider reconnects');
  await sleep(300);
  assert.equal(await run(`docState.editor.getContent()`), NOTEBOOK, 'the editor holds the notebook once');
  assert.equal(await run(`fileWs.collab.provider.params.lineage`), lineage, 'the server reloaded the same history');
  await run(`docState.editor.view.dispatch({ changes: { from: docState.editor.getContent().indexOf('Some'), insert: 'Typed. ' } })`);
  const typed = NOTEBOOK.replace('Some', 'Typed. Some');
  await untilDisk(typed, 'the typing reaches the disk, once');

  // 2. The server loses its saved history while the page is away (a wiped
  //    cache, a month unused) and the person types offline. The page must
  //    take the server copy rather than merge into it, and offer its text back.
  await run(`(() => { const p = fileWs.collab.provider; p.shouldConnect = false; p.ws.close(); })()`);
  await until(`!fileWs.collab.provider.wsconnected`, 'disconnected');
  await sleep(300); // the server closes the document and saves its history
  fs.rmSync(path.join(home, 'cache/collab/files'), { recursive: true, force: true });
  await run(`docState.editor.view.dispatch({ changes: { from: 0, insert: 'offline ' } })`);
  await run(`fileWs.collab.provider.connect()`);
  await until(`fileWs.collab.provider.synced && fileWs.collab.provider.params.lineage !== ${JSON.stringify(lineage)}`, 'reconnected to a new history');
  await until(`!$('fwBanner').hidden && $('fwBanner').textContent.includes('fresh copy')`, 'the person is told their text was replaced');
  assert.equal(await run(`docState.editor.getContent()`), typed, 'the server copy, once; the old copy not merged');
  await sleep(600);
  assert.equal(disk(), typed, 'the disk is not repeated either');
  await run(`[...$('fwBanner').querySelectorAll('button')].find(x => x.textContent === 'Put my version back').click()`);
  await until(`docState.editor.getContent() === ${JSON.stringify('offline ' + typed)}`, 'their version is back');
  await untilDisk('offline ' + typed, 'their version reaches the disk, once');

  // 3. An agent rewrites the file while nobody has it open; the page comes
  //    back to the same history brought up to the disk.
  await run(`(() => { const p = fileWs.collab.provider; p.shouldConnect = false; p.ws.close(); })()`);
  await until(`!fileWs.collab.provider.wsconnected`, 'disconnected');
  await sleep(300);
  const agent = disk().replace('# Notebook', '# Notebook (by an agent)');
  fs.writeFileSync(file, agent);
  const before = await run(`fileWs.collab.provider.params.lineage`);
  await run(`fileWs.collab.provider.connect()`);
  await until(`fileWs.collab.provider.synced && docState.editor.getContent() === ${JSON.stringify(agent)}`, 'the agent’s edit arrives, nothing repeated');
  assert.equal(await run(`fileWs.collab.provider.params.lineage`), before, 'same history: no reset');
  assert.deepEqual(b.exceptions, []);
});
