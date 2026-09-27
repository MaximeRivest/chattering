'use strict';
// The first open of an install that finds conversations already on the
// computer (design/75): welcomed and told what was found, not dropped on a
// chart; then a chart framed on that history, with the quiet weeks since
// collapsed into a break so it sits beside "now" instead of off screen; and
// the welcome can be shown again from Settings → AI accounts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');
const { chromiumAvailable } = require('./helpers/chromium.js');

test('first open with old history: the welcome says what was found, then home frames it', { skip: !chromiumAvailable() && 'chromium is not installed', timeout: 120000 }, async t => {
  // The fixture conversation is from 2026-09-01: weeks of quiet before now.
  const b = await viewerBrowser(t, { firstRun: true });
  const { evaluate: ev, until, home } = b;
  const settingsFile = path.join(require('./helpers/home-env.js').appDir(home, 'config'), 'settings.json');

  await until(`/found 1 conversation already on this computer/.test(document.querySelector('.wel-lead')?.textContent || '')`, 'the welcome, saying what it found');
  assert.equal(await ev(`!!document.querySelector('#list .timeline')`), false, 'the welcome, not the chart');
  assert.equal(await ev(`!!document.querySelector('dialog.bg-ask')`), false, 'no background question before an AI exists');
  await until(`document.querySelector('.wel [data-aic-server]')`, 'connecting is step 1');
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).welcome.doneAt, null);

  // Skipping is done: remembered, and home is the chart.
  await ev(`document.querySelector('.wel [data-wel-skip]').click()`);
  await until(`document.querySelector('#list .timeline .tmark .violin')`, 'the chart');
  for (let i = 0; i < 50 && !JSON.parse(fs.readFileSync(settingsFile, 'utf8')).welcome.doneAt; i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).welcome.doneAt, 'the welcome is remembered as done');

  // Framed on the history: the conversation is on screen, the weeks since are
  // one labelled break, and "now" is at the right edge, not off screen.
  await until(`document.querySelector('#list .tbreak text')?.textContent`, 'the quiet weeks as a break');
  const view = await ev(`(() => {
    const list = document.getElementById('list').getBoundingClientRect();
    const mark = document.querySelector('#list .tmark .violin').getBoundingClientRect();
    const now = document.querySelector('#list .tnow line').getBoundingClientRect();
    return { list: [list.left, list.right], mark: [mark.left, mark.right], now: now.left,
      quiet: document.querySelector('#list .tbreak text').textContent };
  })()`);
  assert.ok(view.mark[0] >= view.list[0] && view.mark[1] <= view.list[1], 'the conversation is in view: ' + JSON.stringify(view));
  assert.ok(view.now > view.list[1] - 120 && view.now <= view.list[1], '"now" at the right edge: ' + JSON.stringify(view));
  assert.match(view.quiet, /^\d+ (days|weeks)$/);

  // Settings → AI accounts shows it again.
  await ev(`showSettingsPane('ai')`);
  await until(`document.getElementById('replayWelcome')`, 'the way back to the welcome');
  await ev(`document.getElementById('replayWelcome').click()`);
  await until(`/found 1 conversation/.test(document.querySelector('.wel-lead')?.textContent || '')`, 'the welcome again');
  assert.deepEqual(b.exceptions.filter(e => !/ResizeObserver/.test(e)), []);
});
