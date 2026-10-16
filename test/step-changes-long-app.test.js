'use strict';
// Files changed, when a step changes many (design/88, "A long list"): a run
// of experiments leaves hundreds of files. Short lists stay one row per file;
// a long one shows the files the steps named first, folds what they only left
// behind, and draws files in their folders, which open by themselves only
// while the list stays short. What a person opens stays open.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { viewerBrowser } = require('./helpers/viewer-browser');
const { chromiumAvailable } = require('./helpers/chromium.js');

const KEY = 'pi:fixture/long.jsonl';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function gitIn(cwd, args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

async function setup(home) {
  const proj = path.join(home, 'work', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  gitIn(proj, ['init', '-q', '-b', 'main']);
  write(path.join(proj, 'app.js'), 'one\ntwo\nthree\n');
  gitIn(proj, ['add', '-A']); gitIn(proj, ['commit', '-qm', 'start']);
  const session = path.join(home, '.pi/agent/sessions/fixture/long.jsonl');
  const at = s => `2026-09-01T12:00:${String(s).padStart(2, '0')}Z`;
  const call = (id, name, args, s) => ({ type: 'message', id: 'a' + id, timestamp: at(s), message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] } });
  const result = (id, name, s) => ({ type: 'message', id: 'r' + id, timestamp: at(s), message: { role: 'toolResult', toolCallId: id, toolName: name, isError: false, content: [{ type: 'text', text: 'ok' }] } });
  const steps = {
    e1: ['edit', { path: path.join(proj, 'app.js'), edits: [{ oldText: 'two\n', newText: 'TWO\n' }] }],
    w1: ['write', { path: path.join(proj, 'docs/plan.md'), content: '# Plan\n' }],
    b1: ['bash', { command: 'make build' }],
    b2: ['bash', { command: 'python3 run_all.py' }],
  };
  fs.writeFileSync(session, [
    { type: 'session', version: 3, id: 'long', cwd: proj },
    { type: 'message', id: 'u1', timestamp: at(0), message: { role: 'user', content: [{ type: 'text', text: 'Plan, build, then run everything' }] } },
    call('e1', ...steps.e1, 1), result('e1', 'edit', 2),
    call('w1', ...steps.w1, 3), result('w1', 'write', 4),
    call('b1', ...steps.b1, 5), result('b1', 'bash', 6),
    { type: 'message', id: 'm1', timestamp: at(7), message: { role: 'assistant', content: [{ type: 'text', text: 'Built. Now the runs:' }] } },
    call('b2', ...steps.b2, 8), result('b2', 'bash', 9),
    { type: 'message', id: 'm2', timestamp: at(10), message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ].map((row, i, all) => (i > 0 && row.id ? { ...row, parentId: i > 1 ? all[i - 1].id : null } : row)).map(JSON.stringify).join('\n') + '\n');
  const { CheckpointStore } = require('../checkpoint-store');
  const { stepTargets } = require('../checkpoint-extension');
  const cp = new CheckpointStore(path.join(home, 'checkpoints'));
  const step = async (id, change) => {
    const [name, input] = steps[id];
    const meta = { session, call: id, run: 'run', tool: name, targets: stepTargets(name, input, proj) };
    await cp.capture(proj, { ...meta, phase: 'before' });
    change();
    await cp.capture(proj, { ...meta, phase: 'after' });
  };
  await step('e1', () => write(path.join(proj, 'app.js'), 'one\nTWO\nthree\n'));
  await step('w1', () => write(path.join(proj, 'docs/plan.md'), steps.w1[1].content));
  // A build that leaves 14 files nobody named.
  await step('b1', () => { for (let i = 1; i <= 14; i++) write(path.join(proj, `build/part${String(i).padStart(2, '0')}.o.txt`), `object ${i}\n`); });
  // Experiments: two tasks × 12 runs × 3 files, and 45 frames in one folder.
  await step('b2', () => {
    for (const task of ['reflection-chat', 'restaurant-review-v2']) for (let r = 1; r <= 12; r++) {
      const dir = path.join(proj, 'runs/m3/default', task, `${String(r).padStart(2, '0')}_run`);
      write(path.join(dir, 'result.json'), `{"run": ${r}}\n`);
      write(path.join(dir, 'notes.txt'), 'started\nfinished\n');
      write(path.join(dir, 'chart.png'), PNG);
    }
    for (let i = 1; i <= 45; i++) write(path.join(proj, `frames/f${String(i).padStart(3, '0')}.txt`), `frame ${i}\n`);
  });
  cp.close();
}

test('files changed: a long list is folded by folder, and stays as it was opened', { skip: !chromiumAvailable(), timeout: 180000 }, async t => {
  const b = await viewerBrowser(t, { setup });
  const { evaluate: ev, until, size } = b;
  await until(`sessions.length && nav.current()`);
  if (await ev(`!!document.querySelector('dialog.bg-ask [data-none]')`)) await ev(`document.querySelector('dialog.bg-ask [data-none]').click()`);
  await size(1300, 1000);
  await ev(`open(${JSON.stringify(KEY)}); 1`);
  const strip = n => `document.querySelectorAll('.sc-strip')[${n}]`;
  const rows = n => `[...${strip(n)}.querySelectorAll('.sc-row')].map(r => (r.style.getPropertyValue('--sc-depth') || '0') + ' ' + r.innerText.replace(/\\s+/g, ' ').trim())`;
  await until(`document.querySelectorAll('.sc-strip:not([hidden])').length === 2 && !document.querySelector('.sc-strip .sc-wait') && ${strip(1)}.querySelector('.sc-folder')`, 'both lists');

  // Named files on top, as rows; the build's 14 outputs folded behind one line.
  assert.deepEqual(await ev(rows(0)), ['0 M app.js +1 −1', '0 A plan.md docs/ +1', '0 14 more files found in the folder +14']);
  assert.equal(await ev(`${strip(0)}.querySelector('.sc-group').getAttribute('aria-expanded')`), 'false');

  // Only found files: in their folders. The chain runs/m3/default/ is one row and
  // opens by itself (two rows inside); the tasks (12 runs each) and the 45
  // frames would pass the budget, so they wait for a press.
  assert.deepEqual(await ev(rows(1)), [
    '0 A frames/ 45 new files found +45',
    '0 A runs/m3/default/ 72 new files · 2 folders found +72',
    '1 A reflection-chat/ 36 new files · 12 folders +36',
    '1 A restaurant-review-v2/ 36 new files · 12 folders +36',
  ]);
  assert.equal(await ev(`${strip(1)}.querySelectorAll('[data-file-diff]').length`), 0, 'no file row is drawn before its folder opens');

  // A folder opens on a press, its runs below it; a run shows its files without repeating the folder.
  const press = sel => ev(`${strip(1)}.querySelector(${JSON.stringify(sel)}).click(); 1`);
  const folder = name => `[...${strip(1)}.querySelectorAll('.sc-folder')].find(b => b.querySelector('.sc-name').textContent === ${JSON.stringify(name)})`;
  await ev(`${folder('reflection-chat/')}.click(); 1`);
  assert.equal(await ev(`document.activeElement === ${folder('reflection-chat/')}`), true, 'the folder keeps the focus');
  assert.equal(await ev(`${folder('reflection-chat/')}.getAttribute('aria-expanded')`), 'true');
  await ev(`${folder('03_run/')}.click(); 1`);
  const run = await ev(`[...${folder('03_run/')}.closest('li').querySelectorAll(':scope > .sc-list > li > .sc-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
  assert.deepEqual(run, ['A chart.png picture', 'A notes.txt +2', 'A result.json +1']);

  // A big folder draws 20 entries, then the rest on request.
  await ev(`${folder('frames/')}.click(); 1`);
  const frames = `${folder('frames/')}.closest('li').querySelectorAll(':scope > .sc-list > li > [data-file-diff]').length`;
  assert.equal(await ev(frames), 20);
  assert.equal(await ev(`${folder('frames/')}.closest('li').querySelector('.sc-rest').innerText.trim()`), 'show the other 25');
  await ev(`${folder('frames/')}.closest('li').querySelector('.sc-rest').click(); 1`);
  assert.equal(await ev(frames), 45);
  assert.equal(await ev(`document.activeElement?.dataset.fileDiff?.endsWith('/frames/f021.txt')`), true, 'the focus lands on the first new entry');

  // A file in a folder opens its change in place.
  await ev(`${folder('03_run/')}.closest('li').querySelector('[data-file-diff$="/notes.txt"]').click(); 1`);
  await until(`document.querySelector('.sc-card[data-sc-card$="03_run/notes.txt"] .sc-code')`, 'the change');

  // A redraw of the conversation keeps every folder as it was left, and the open change.
  await ev(`renderConv(); 1`);
  await until(`document.querySelector('.sc-card[data-sc-card$="03_run/notes.txt"] .sc-code') && ${strip(1)}.querySelectorAll('[data-file-diff*="/frames/"]').length === 45`, 'the list as it was left');
  assert.equal(await ev(`${folder('restaurant-review-v2/')}.getAttribute('aria-expanded')`), 'false');

  // A person's fold wins over the default, even around an open change.
  await ev(`${folder('runs/m3/default/')}.click(); 1`);
  assert.equal(await ev(`!!document.querySelector('.sc-card[data-sc-card$="03_run/notes.txt"]')`), false);
  await ev(`${folder('runs/m3/default/')}.click(); 1`);
  await until(`document.querySelector('.sc-card[data-sc-card$="03_run/notes.txt"] .sc-code')`, 'the change, back with its folder');

  // The build's fold opens to its 14 files: their one folder, alone there, opens with it.
  await ev(`${strip(0)}.querySelector('.sc-group').click(); 1`);
  assert.deepEqual(await ev(rows(0)).then(r => r.slice(2, 5)), ['0 14 more files found in the folder +14', '1 A build/ 14 new files +14', '2 A part01.o.txt +1']);
  assert.equal(await ev(`${strip(0)}.querySelectorAll('.sc-fold [data-file-diff]').length`), 14);
  assert.equal(await ev(`[...document.querySelectorAll('.sc-strip .sc-row')].filter(el => el.scrollWidth > el.clientWidth + 1).length`), 0, 'nothing is cut off');
  await b.screenshot('step-changes-long-app.png');
  assert.deepEqual(b.exceptions || [], []);
});
