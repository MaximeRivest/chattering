'use strict';
// Rename, duplicate and delete in the Files browser, on a real server and
// page: the name is edited in place, a copy is ready to be named, a delete
// waits in Recently deleted and comes back, and a kept open file follows
// its rename.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromiumAvailable } = require('./helpers/chromium.js');
const { viewerBrowser } = require('./helpers/viewer-browser.js');

test('Files browser: rename in place, duplicate, delete and restore', { timeout: 120000 }, async t => {
  if (!chromiumAvailable()) return t.skip('chromium is not installed');
  const b = await viewerBrowser(t, { homeBase: require('node:os').homedir(), setup: home => {
    const work = path.join(home, 'work');
    fs.writeFileSync(path.join(work, 'notes.md'), '# Notes\n');
    fs.writeFileSync(path.join(work, 'keep.md'), 'kept\n');
    fs.mkdirSync(path.join(work, 'data'));
    fs.writeFileSync(path.join(work, 'data', 'a.txt'), 'a\n');
  } });
  const { work, base, auth, evaluate, until } = b;
  const op = async body => {
    const r = await fetch(base + '/api/files/op', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'work', ...body }) });
    return { status: r.status, body: await r.json() };
  };
  // The server's own refusals, before any page.
  assert.equal((await op({ op: 'rename', rel: '../outside', to: 'x' })).status, 400);
  const taken = await op({ op: 'rename', rel: 'notes.md', to: 'keep.md' });
  assert.equal(taken.status, 409, JSON.stringify(taken.body));
  assert.equal(fs.readFileSync(path.join(work, 'keep.md'), 'utf8'), 'kept\n', 'a taken name is never overwritten');
  assert.equal((await op({ op: 'delete', rel: '' })).status, 400, 'not the root');

  await evaluate(`showFilesBrowser('work')`);
  const row = name => `[...document.querySelectorAll('#fbList [data-fb-entry]')].find(b=>b.textContent.trim().endsWith(${JSON.stringify(name)}))`;
  await until(`${row('notes.md')}`, 'the list');

  // Rename: F2 on the row; the name without its ending is selected.
  await evaluate(`${row('notes.md')}.focus(); ${row('notes.md')}.dispatchEvent(new KeyboardEvent('keydown',{key:'F2',bubbles:true}))`);
  await until(`document.querySelector('.fb-rename input')`, 'rename field');
  const input = `document.querySelector('.fb-rename input')`;
  assert.equal(await evaluate(`${input}.value.slice(${input}.selectionStart, ${input}.selectionEnd)`), 'notes');
  await evaluate(`${input}.value='ideas.md'; document.querySelector('.fb-rename').requestSubmit()`);
  await until(`${row('ideas.md')} && document.activeElement===${row('ideas.md')}`, 'renamed row in focus');
  assert.ok(fs.existsSync(path.join(work, 'ideas.md')) && !fs.existsSync(path.join(work, 'notes.md')));

  // A taken name stays in the field with the reason; Escape keeps the old name.
  await evaluate(`${row('ideas.md')}.dispatchEvent(new KeyboardEvent('keydown',{key:'F2',bubbles:true}))`);
  await until(`document.querySelector('.fb-rename input')`);
  await evaluate(`${input}.value='keep.md'; document.querySelector('.fb-rename').requestSubmit()`);
  await until(`document.querySelector('.fb-rename-error')?.textContent.includes('already exists')`, 'refusal shown in place');
  await evaluate(`${input}.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await until(`!document.querySelector('.fb-rename') && ${row('ideas.md')}`);

  // Duplicate from the row's menu: the copy appears, ready to be named.
  await evaluate(`${row('ideas.md')}.closest('.fb-row').querySelector('.fb-more').click()`);
  await until(`document.querySelector('.fb-entry-menu [data-fb-action="1"]')`, 'actions menu');
  await evaluate(`document.querySelector('.fb-entry-menu [data-fb-action="1"]').click()`);
  await until(`document.querySelector('.fb-rename input')?.value==='ideas copy.md'`, 'copy ready to name');
  assert.equal(fs.readFileSync(path.join(work, 'ideas copy.md'), 'utf8'), '# Notes\n');
  await evaluate(`${input}.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);

  // Delete a folder with the Delete key: gone from disk, waiting in Recently deleted.
  await until(`${row('data')}`);
  await evaluate(`${row('data')}.focus(); ${row('data')}.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true}))`);
  await until(`!${row('data')} && document.querySelector('.fb-deleted-toggle')?.textContent.includes('(1)')`, 'deleted and listed');
  assert.equal(fs.existsSync(path.join(work, 'data')), false);
  await evaluate(`document.querySelector('.fb-deleted-toggle').click()`);
  await until(`document.querySelector('[data-fb-restore]')`, 'restore button');
  await evaluate(`document.querySelector('[data-fb-restore]').click()`);
  await until(`${row('data')}`, 'restored');
  assert.equal(fs.readFileSync(path.join(work, 'data', 'a.txt'), 'utf8'), 'a\n');

  // A kept open file follows its rename on every device (the server's list).
  await evaluate(`OpenFiles.keep(${JSON.stringify(path.join(work, 'keep.md'))}, 'work')`);
  await until(`OpenFiles.isKept(${JSON.stringify(path.join(work, 'keep.md'))})`);
  for (let i = 0; i < 100; i++) { const d = await (await fetch(base + '/api/open-files', { headers: auth })).json(); if (d.files.some(f => f.path === path.join(work, 'keep.md'))) break; await new Promise(r => setTimeout(r, 50)); }
  const moved = await op({ op: 'rename', rel: 'keep.md', to: 'kept.md' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  await until(`OpenFiles.isKept(${JSON.stringify(path.join(work, 'kept.md'))}) && !OpenFiles.isKept(${JSON.stringify(path.join(work, 'keep.md'))})`, 'kept file followed its rename');
  assert.deepEqual(b.exceptions, []);
});
