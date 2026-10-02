'use strict';
// Files changed, read in the conversation (design/88), the whole journey in
// the real app: a conversation whose steps edit a long file, write a new
// Markdown page, run a script that makes a data file and a picture without
// naming them, and one edit with no saved steps (as Claude Code leaves it).
// Under the steps, a list says what changed; a row opens the change right
// there; a step's own file opens that step's change under its line.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { viewerBrowser } = require('./helpers/viewer-browser');
const { chromiumAvailable } = require('./helpers/chromium.js');

const KEY = 'pi:fixture/changes.jsonl';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function gitIn(cwd, args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}
const longFile = n => Array.from({ length: n }, (_, i) => `const line${i + 1} = compute(${i + 1}, 'value');`).join('\n') + '\n';

async function setup(home) {
  const proj = path.join(home, 'work', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  gitIn(proj, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(proj, 'app.js'), longFile(60));
  fs.writeFileSync(path.join(proj, 'gen.py'), 'print("data")\n');
  fs.writeFileSync(path.join(proj, 'late.js'), 'alpha\nbeta\ngamma\n');
  gitIn(proj, ['add', '-A']); gitIn(proj, ['commit', '-qm', 'start']);
  const session = path.join(home, '.pi/agent/sessions/fixture/changes.jsonl');
  const at = s => `2026-09-01T12:00:${String(s).padStart(2, '0')}Z`;
  const call = (id, name, args, s) => ({ type: 'message', id: 'a' + id, timestamp: at(s), message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] } });
  const result = (id, name, s, isError = false) => ({ type: 'message', id: 'r' + id, timestamp: at(s), message: { role: 'toolResult', toolCallId: id, toolName: name, isError, content: [{ type: 'text', text: 'ok' }] } });
  const steps = {
    e1: ['edit', { path: path.join(proj, 'app.js'), edits: [{ oldText: "const line30 = compute(30, 'value');", newText: "const line30 = compute(30, 'answer');" }] }],
    w1: ['write', { path: path.join(proj, 'docs/notes.md'), content: '# Release notes\n\nThe **answer** is now computed on line 30.\n\n- faster\n- clearer\n' }],
    b1: ['bash', { command: 'python3 gen.py' }],
    e2: ['edit', { path: path.join(proj, 'late.js'), edits: [{ oldText: 'beta\n', newText: 'BETA\nbeta two\n' }] }],
  };
  fs.writeFileSync(session, [
    { type: 'session', version: 3, id: 'changes', cwd: proj },
    { type: 'message', id: 'u1', timestamp: at(0), message: { role: 'user', content: [{ type: 'text', text: 'Change the answer, write notes, and make the data' }] } },
    call('e1', ...steps.e1, 1), result('e1', 'edit', 2),
    call('w1', ...steps.w1, 3), result('w1', 'write', 4),
    call('b1', ...steps.b1, 5), result('b1', 'bash', 6),
    { type: 'message', id: 'm1', timestamp: at(7), message: { role: 'assistant', content: [{ type: 'text', text: 'Now the late file, without saved steps:' }] } },
    call('e2', ...steps.e2, 8), result('e2', 'edit', 9),
    { type: 'message', id: 'm2', timestamp: at(10), message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } },
  ].map((row, i, all) => (i > 0 && row.id ? { ...row, parentId: i > 1 ? all[i - 1].id : null } : row)).map(JSON.stringify).join('\n') + '\n');
  // The saved steps a live Pi session leaves (checkpoint-extension.js), for
  // the first three steps; the fourth has none.
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
  await step('e1', () => fs.writeFileSync(path.join(proj, 'app.js'), longFile(60).replace("compute(30, 'value')", "compute(30, 'answer')")));
  await step('w1', () => { fs.mkdirSync(path.join(proj, 'docs')); fs.writeFileSync(path.join(proj, 'docs/notes.md'), steps.w1[1].content); });
  await step('b1', () => {
    fs.mkdirSync(path.join(proj, 'out'));
    fs.writeFileSync(path.join(proj, 'out/data.csv'), 'x,y\n1,2\n3,4\n');
    fs.writeFileSync(path.join(proj, 'out/chart.png'), PNG);
  });
  cp.close();
  fs.writeFileSync(path.join(proj, 'late.js'), 'alpha\nBETA\nbeta two\ngamma\n');
}

test('files changed: the list under the steps, the change read in place', { skip: !chromiumAvailable(), timeout: 180000 }, async t => {
  const b = await viewerBrowser(t, { setup });
  const { evaluate: ev, until, base, auth, size } = b;
  await until(`sessions.length && nav.current()`);
  if (await ev(`!!document.querySelector('dialog.bg-ask [data-none]')`)) await ev(`document.querySelector('dialog.bg-ask [data-none]').click()`);
  await size(1300, 1000);

  // The route: each box's files, how each was known, lines added and removed.
  const post = body => fetch(base + '/api/conversation/changes', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const api = await (await post({ id: KEY, groups: [['e1', 'w1', 'b1'], ['e2']] })).json();
  assert.deepEqual(api.groups[0].files.map(f => [f.rel, f.kind, f.how, f.add, f.del]), [
    ['app.js', 'modified', 'named', 1, 1],
    ['docs/notes.md', 'added', 'named', 6, 0],
    ['out/chart.png', 'added', 'observed', null, null],
    ['out/data.csv', 'added', 'observed', 3, 0],
  ], 'the script\u2019s outputs are found without being named');
  assert.deepEqual(api.groups[1].files.map(f => [f.rel, f.kind, f.how, f.add, f.del]), [['late.js', 'modified', 'recorded', 2, 1]]);
  assert.equal((await post({ id: 'nope', groups: [['e1']] })).status, 404);

  await ev(`open(${JSON.stringify(KEY)}); 1`);
  await until(`document.querySelectorAll('.sc-strip:not([hidden]) .sc-row:not(.sc-wait)').length >= 5`, 'the lists under the steps');
  const rows = await ev(`[...document.querySelectorAll('.sc-strip .sc-row')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
  assert.deepEqual(rows, ['M app.js +1 −1', 'A notes.md docs/ +6', 'A chart.png out/ found picture', 'A data.csv out/ found +3', 'M late.js +2 −1']);
  assert.equal(await ev(`document.querySelectorAll('.sc-card').length`), 0, 'nothing opens by itself');
  assert.equal(await ev(`document.querySelector('.tg-review-turn').hidden`), false, 'the turn changed files: its review is offered');
  assert.equal(await ev(`[...document.querySelectorAll('.sc-row')].filter(el => el.scrollWidth > el.clientWidth + 1).length`), 0, 'nothing is cut off');

  // A changed file: its diff, here, with the lines around it and the rest folded.
  await ev(`document.querySelector('.sc-row[data-file-diff$="/app.js"]').click(); 1`);
  await until(`document.querySelector('.sc-card[data-sc-card$="/app.js"] .sc-code')`, 'the diff');
  const diff = await ev(`(() => { const c = document.querySelector('.sc-card[data-sc-card$="/app.js"]');
    return { removed: [...c.querySelectorAll('.sc-l[data-t="1"] .sc-c')].map(x => x.textContent), added: [...c.querySelectorAll('.sc-l[data-t="2"] .sc-c')].map(x => x.textContent),
      numbers: [...c.querySelectorAll('.sc-l .sc-ln')].map(x => x.textContent), gaps: [...c.querySelectorAll('.sc-gap')].map(x => x.textContent),
      words: CSS.highlights.get('sc-add-word')?.size || 0, head: c.querySelector('.sc-what').innerText, expanded: document.querySelector('.sc-row[data-file-diff$="/app.js"]').getAttribute('aria-expanded'), view: location.hash }; })()`);
  assert.deepEqual(diff.removed, ["const line30 = compute(30, 'value');"]);
  assert.deepEqual(diff.added, ["const line30 = compute(30, 'answer');"]);
  assert.deepEqual(diff.numbers, ['27', '28', '29', '30', '30', '31', '32', '33']);
  assert.deepEqual(diff.gaps, ['⋯ 26 lines above', '⋯ 27 lines below']);
  assert.equal(diff.words, 1, 'the changed word is marked, not only the line');
  assert.match(diff.head, /^Changed · \+1 −1/);
  assert.equal(diff.expanded, 'true');
  assert.equal(await ev(`viewKind`), 'conversation', 'the reader stays in the conversation');
  await ev(`document.querySelector('.sc-card[data-sc-card$="/app.js"] .sc-gap').click(); 1`);
  assert.equal(await ev(`document.querySelectorAll('.sc-card[data-sc-card$="/app.js"] .sc-l').length`), 34, 'the lines above open on request');

  // A new Markdown file reads as a page; its source is one press away.
  await ev(`document.querySelector('.sc-row[data-file-diff$="/notes.md"]').click(); 1`);
  await until(`document.querySelector('.sc-card[data-sc-card$="/notes.md"] .sc-page h1')`, 'the page');
  assert.equal(await ev(`document.querySelector('.sc-card[data-sc-card$="/notes.md"] .sc-page h1').textContent`), 'Release notes');
  await ev(`document.querySelector('.sc-card[data-sc-card$="/notes.md"] [data-sc-mode="source"]').click(); 1`);
  assert.equal(await ev(`document.querySelectorAll('.sc-card[data-sc-card$="/notes.md"] .sc-read .sc-l').length`), 6);

  // A picture the script made, as a picture.
  await ev(`document.querySelector('.sc-row[data-file-diff$="/chart.png"]').click(); 1`);
  await until(`document.querySelector('.sc-card[data-sc-card$="/chart.png"] img')?.complete && document.querySelector('.sc-card[data-sc-card$="/chart.png"] img').naturalWidth === 1`, 'the picture');

  // No saved steps: rebuilt from the recorded edit and today's file, with real line numbers.
  await ev(`document.querySelector('.sc-row[data-file-diff$="/late.js"]').click(); 1`);
  await until(`document.querySelector('.sc-card[data-sc-card$="/late.js"] .sc-code')`, 'the recorded change');
  assert.deepEqual(await ev(`[...document.querySelectorAll('.sc-card[data-sc-card$="/late.js"] .sc-l')].map(l => l.querySelector('.sc-ln').textContent + l.querySelector('.sc-sg').textContent + l.querySelector('.sc-c').textContent)`),
    ['1alpha', '2−beta', '2+BETA', '3+beta two', '4gamma']);
  assert.match(await ev(`document.querySelector('.sc-card[data-sc-card$="/late.js"] .sc-what').innerText`), /rebuilt from the recorded edits/);

  // Inside the box: the script's step names what it made; its file opens that step's change under it.
  await ev(`document.querySelector('.toolgroup').open = true; 1`);
  await until(`document.querySelector('.sc-chips[data-sc-call="b1"] .sc-chip')`, 'the step\u2019s files');
  assert.deepEqual(await ev(`[...document.querySelectorAll('.sc-chips[data-sc-call="b1"] .sc-chip')].map(c => c.innerText.replace(/\\s+/g, ' ').trim())`), ['A chart.png picture', 'A data.csv +3']);
  assert.equal(await ev(`document.querySelector('.sc-count[data-sc-count="e1"]').innerText.replace(/\\s+/g, '')`), '+1−1', 'an edit step says how much it changed');
  await ev(`document.querySelector('.sc-chips[data-sc-call="b1"] .sc-chip[data-file-diff$="/data.csv"]').click(); 1`);
  await until(`[...document.querySelectorAll('.sc-step-card')].find(c => c.dataset.scCard.startsWith('b1\\n'))?.querySelector('.sc-code')`, 'the step\u2019s own card');
  assert.equal(await ev(`[...document.querySelectorAll('.sc-step-card')].find(c => c.dataset.scCard.startsWith('b1\\n')).previousElementSibling.matches('.msg.tool')`), true, 'under its step');
  assert.equal(await ev(`document.querySelector('details.msg.tool[data-step="t:b1"]').open`), false, 'pressing the file does not unfold the command');
  await b.screenshot('step-changes-app.png');

  // A re-render keeps what was open; a second press closes it.
  await ev(`renderConv(); 1`);
  await until(`document.querySelector('.sc-card[data-sc-card$="/app.js"] .sc-code') && [...document.querySelectorAll('.sc-step-card')].some(c => c.dataset.scCard.startsWith('b1\\n'))`, 'the open cards after a re-render');
  await ev(`document.querySelector('.sc-row[data-file-diff$="/app.js"]').click(); 1`);
  assert.equal(await ev(`!!document.querySelector('.sc-card[data-sc-card$="/app.js"]')`), false);

  // Review is one press from a card.
  await ev(`document.querySelector('.sc-card[data-sc-card$="/notes.md"] [data-sc-act="review"]').click(); 1`);
  await until(`viewKind === 'change-review'`, 'the review');
  assert.deepEqual(b.exceptions || [], []);
});

test('files changed: the list under steps still running grows as each step finishes', { skip: !chromiumAvailable(), timeout: 180000 }, async t => {
  const b = await viewerBrowser(t, { setup });
  const { evaluate: ev, until } = b;
  await until(`sessions.length && nav.current()`);
  if (await ev(`!!document.querySelector('dialog.bg-ask [data-none]')`)) await ev(`document.querySelector('dialog.bg-ask [data-none]').click()`);
  await ev(`open(${JSON.stringify(KEY)}); 1`);
  await until(`current?.key === ${JSON.stringify(KEY)} && document.getElementById('liveReplies')`, 'the conversation');
  // A run streaming the same steps (their snapshots are on record): two done, the script still running.
  const tool = (id, name, phase) => ({ id, kind: 'tool', callId: id, name, args: '', out: '', phase });
  const runEvent = tail => ev(`live.onmessage({ data: ${JSON.stringify(JSON.stringify({ type: 'run-event', jobId: 'grow', key: KEY, status: 'running', statusText: 'running',
    startedAt: Date.now(), node: 'm2', model: 'p/big', tail }))} }); 1`);
  const liveRows = `[...document.querySelectorAll('#liveReplies .sc-strip[data-live-strip] .sc-row:not(.sc-wait)')].map(r => r.dataset.fileDiff.split('/').pop())`;
  await runEvent([tool('e1', 'edit', 'done'), tool('w1', 'write', 'done'), tool('b1', 'bash', 'running')]);
  await until(`${liveRows}.length === 2`, 'the finished steps\u2019 files, while the box still runs');
  assert.deepEqual(await ev(liveRows), ['app.js', 'notes.md']);
  assert.equal(await ev(`document.querySelector('#liveReplies .sc-strip[data-live-strip]').previousElementSibling.matches('.toolgroup[data-live-work]')`), true, 'under its box');
  // A row opened now stays open as the box grows.
  await ev(`document.querySelector('#liveReplies .sc-strip[data-live-strip] .sc-row[data-file-diff$="/app.js"]').click(); 1`);
  await until(`document.querySelector('#liveReplies .sc-card[data-sc-card$="/app.js"] .sc-code')`, 'the change, read while the box runs');
  await runEvent([tool('e1', 'edit', 'done'), tool('w1', 'write', 'done'), tool('b1', 'bash', 'done')]);
  await until(`${liveRows}.length === 4`, 'the script\u2019s files join when it finishes');
  assert.deepEqual(await ev(liveRows), ['app.js', 'notes.md', 'chart.png', 'data.csv']);
  await until(`[...document.querySelectorAll('#liveReplies .sc-card')].some(c => c.dataset.scCard.startsWith('e1,w1,b1\\n') && c.dataset.scCard.endsWith('/app.js') && c.querySelector('.sc-code'))`, async () => 'the open row follows the grown box: ' + JSON.stringify(await ev(`[...document.querySelectorAll('#liveReplies .sc-card')].map(c => [c.dataset.scCard, c.innerText.slice(0, 80)])`)));
  assert.equal(await ev(`document.querySelectorAll('#liveReplies .sc-strip[data-live-strip]').length`), 1, 'one list per box');
  // Drawn like the saved box's list: same width and place under its box.
  const box = sel => `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; })()`;
  assert.deepEqual(await ev(box('#liveReplies .sc-strip[data-live-strip]')), await ev(box('#conversationTranscript .sc-strip')), 'the same place as a saved list');
  assert.deepEqual(b.exceptions || [], []);
});
