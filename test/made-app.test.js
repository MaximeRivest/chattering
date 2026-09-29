'use strict';
// What this conversation made (design/82), the whole journey in the real
// app: a conversation that edited a committed file, with saved steps; its
// header says what it made; the Made view lists the file with its state;
// a row opens that file in the whole-conversation review; marking it
// reviewed there shows in the view; committing it shows too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { viewerBrowser } = require('./helpers/viewer-browser');
const { chromiumAvailable } = require('./helpers/chromium.js');

const KEY = 'pi:fixture/made.jsonl';
function gitIn(cwd, args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}

async function setup(home) {
  const proj = path.join(home, 'work', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  gitIn(proj, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(proj, 'app.js'), 'one\ntwo\nthree\n');
  gitIn(proj, ['add', '-A']); gitIn(proj, ['commit', '-qm', 'start']);
  const session = path.join(home, '.pi/agent/sessions/fixture/made.jsonl');
  const file = path.join(proj, 'app.js');
  const edit = { type: 'toolCall', id: 'e1', name: 'edit', arguments: { path: file, edits: [{ oldText: 'two\n', newText: 'TWO\nand a half\n' }] } };
  fs.writeFileSync(session, [
    { type: 'session', version: 3, id: 'made', cwd: proj },
    { type: 'message', id: 'u1', parentId: null, timestamp: '2026-09-01T12:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'Change the second line' }] } },
    { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-09-01T12:00:05Z', message: { role: 'assistant', content: [edit] } },
    { type: 'message', id: 't1', parentId: 'a1', timestamp: '2026-09-01T12:00:06Z', message: { role: 'toolResult', toolCallId: 'e1', toolName: 'edit', isError: false, content: [{ type: 'text', text: 'Edited app.js' }] } },
    { type: 'message', id: 'a2', parentId: 't1', timestamp: '2026-09-01T12:00:08Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  // The saved steps a live Pi session would have left (checkpoint-extension.js).
  const { CheckpointStore } = require('../checkpoint-store');
  const L = require('../task-locations');
  const cp = new CheckpointStore(path.join(home, 'checkpoints'));
  const meta = { session, call: 'e1', run: 'run', tool: 'edit', targets: L.directTargets('edit', edit.arguments, proj) };
  await cp.capture(proj, { ...meta, phase: 'before' });
  fs.writeFileSync(file, 'one\nTWO\nand a half\nthree\n');
  await cp.capture(proj, { ...meta, phase: 'after' });
  cp.close();
}

test('what a conversation made: header, view, review at the file, reviewed and committed', { skip: !chromiumAvailable(), timeout: 180000 }, async t => {
  const b = await viewerBrowser(t, { setup });
  const { evaluate: ev, until, base, auth, size } = b;
  const proj = path.join(b.home, 'work', 'proj');
  await until(`sessions.length && nav.current()`);
  if (await ev(`!!document.querySelector('dialog.bg-ask [data-none]')`)) await ev(`document.querySelector('dialog.bg-ask [data-none]').click()`);
  await size(1500, 1000);

  // The route answers the summary; the same conversation is refused to no one here.
  const api = await (await fetch(base + '/api/made?' + new URLSearchParams({ key: KEY }), { headers: auth })).json();
  assert.deepEqual(api.files.map(f => [f.path, f.status, f.git, f.lines]), [['app.js', 'modified', 'uncommitted', { add: 2, del: 1 }]]);
  assert.equal((await fetch(base + '/api/made?key=nope', { headers: auth })).status, 404);

  await ev(`open(${JSON.stringify(KEY)}); 1`);
  await until(`viewKind === 'conversation' && document.getElementById('convChanges')`, 'the header chip');
  await until(`document.getElementById('convChanges').textContent.includes('1 file')`, 'the chip says what it made');
  assert.equal(await ev(`document.getElementById('convChanges').textContent`), '± 1 file · 1 to review');

  await ev(`document.getElementById('convChanges').click(); 1`);
  await until(`document.querySelector('#rightFileList .made .made-row')`, 'the Made view');
  assert.equal(await ev(`document.getElementById('convChanges').getAttribute('aria-pressed')`), 'true');
  assert.equal(await ev(`document.querySelector('#rightFilePanel .file-scope-switch').hidden`), true, 'the project scope does not apply to one conversation');
  const row = await ev(`(() => { const r = document.querySelector('#rightFileList [data-made-file="app.js"]'); return r && r.innerText.replace(/\\s+/g, ' ').trim(); })()`);
  assert.match(row, /^M app\.js \+2 −1 not committed$/);
  const needs = await ev(`[...document.querySelectorAll('#rightFileList .made-needs li')].map(li => li.innerText.trim())`);
  assert.deepEqual(needs, ['1 file not reviewed', '1 file not committed'], 'the branch is only on this machine, but none of its commits are this work’s');
  assert.equal(await ev(`[...document.querySelectorAll('#rightFileList .made-row, #rightFileList .made-status')].filter(el => el.scrollWidth > el.clientWidth + 1).length`), 0, 'nothing is cut off at the column width');

  // A row opens that file in the whole-conversation review.
  await ev(`document.querySelector('#rightFileList [data-made-file="app.js"]').click(); 1`);
  await until(`viewKind === 'change-review' && [...document.querySelectorAll('.cr-file')].some(c => c.open && c.crFile?.path === 'app.js')`, 'the review, at the file');
  const id = await ev(`new URLSearchParams(location.hash.split('?')[1] || location.hash.slice(location.hash.indexOf('review='))).get('review') || (location.hash.match(/review=([^&]+)/) || [])[1]`);
  assert.ok(id, 'the review is in the address');
  await fetch(base + '/api/reviews/mark', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: decodeURIComponent(id), path: 'app.js', checked: true }) });

  // Back in the conversation, the view says it is reviewed.
  await ev(`open(${JSON.stringify(KEY)}); 1`);
  await until(`viewKind === 'conversation'`);
  await ev(`Made.refresh(${JSON.stringify(KEY)}, { force: true }).then(() => 1)`);
  await until(`(document.querySelector('#rightFileList [data-made-file="app.js"]')?.innerText || '').includes('reviewed')`, 'reviewed in the view');
  assert.equal(await ev(`document.getElementById('convChanges').textContent`), '± 1 file · 1 not committed');

  // Committed outside the app: the view follows.
  gitIn(proj, ['commit', '-qam', 'the change']);
  await ev(`Made.refresh(${JSON.stringify(KEY)}, { force: true }).then(() => 1)`);
  await until(`[...document.querySelectorAll('#rightFileList .made-needs li')].some(li => li.innerText.includes('Everything reviewed and committed'))`, 'everything done');
  assert.equal(await ev(`document.getElementById('convChanges').textContent`), '± 1 file');

  // The toggle closes it again, and Files comes back with its scope switch.
  await ev(`document.getElementById('convChanges').click(); 1`);
  assert.equal(await ev(`document.getElementById('rightFilePanel').hidden`), true);
  await ev(`setRightView('files'); 1`);
  assert.equal(await ev(`document.querySelector('#rightFilePanel .file-scope-switch').hidden`), false);
  assert.deepEqual(b.exceptions || [], []);
});
