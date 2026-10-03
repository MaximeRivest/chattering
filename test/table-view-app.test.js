'use strict';
// A CSV opened in the file view reads as a table (table-view.js): the
// device's choice between Table and Text, the text editor kept under the
// table, the table following the text, rows drawn a page at a time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');
const { chromiumAvailable } = require('./helpers/chromium.js');

const rows = n => 'id,question,score\n' + Array.from({ length: n }, (_, i) => `${i + 1},"Does treatment ${i + 1} help, or not? ${'A long methods description that goes on. '.repeat(6)}",${(i * 7) % 50}.5`).join('\n') + '\n';

test('a CSV in the file view: Table or Text', { skip: !chromiumAvailable(), timeout: 180000 }, async t => {
  const b = await viewerBrowser(t, { setup: home => fs.writeFileSync(path.join(home, 'work', 'data.csv'), rows(450)) });
  const { evaluate: ev, until, open, size } = b;
  await open('data.csv');
  await until(`document.querySelector('.lf-table-view .tv tbody tr[data-tv-row]')`, 'the table');
  const state = () => ev(`({ pressed: document.getElementById('tableOn').getAttribute('aria-pressed'), codeHidden: document.querySelector('.code-host').hidden,
    drawn: document.querySelectorAll('.lf-table-view tr[data-tv-row]').length, sum: document.querySelector('.tv-sum')?.textContent })`);
  assert.deepEqual(await state(), { pressed: 'true', codeHidden: true, drawn: 200, sum: '450 rows · 3 columns' });
  assert.equal(await ev(`getComputedStyle(document.querySelector('.tv thead th')).position`), 'sticky', 'the names stay as the rows scroll');
  assert.equal(await ev(`document.querySelector('.tv tbody td.tv-num') !== null`), true);
  await b.screenshot('table-view-file.png');

  // Reaching the end draws the next rows.
  await ev(`(() => { const s = document.querySelector('.tv-scroll'); s.scrollTop = s.scrollHeight; })(); 1`);
  await until(`document.querySelectorAll('.lf-table-view tr[data-tv-row]').length === 400`, 'the next rows');

  // A row opens to its whole text; the keyboard does it too.
  const clamped = `getComputedStyle(document.querySelector('.tv tbody tr[data-tv-row] td:nth-child(3) .tv-cell')).webkitLineClamp`;
  assert.equal(await ev(clamped), '3');
  await ev(`document.querySelector('.tv tbody tr[data-tv-row] td:nth-child(3)').click(); 1`);
  assert.equal(await ev(`document.querySelector('.tv tbody tr[data-tv-row]').classList.contains('tv-open')`), true);

  // Ctrl+F filters the rows.
  await ev(`document.querySelector('.tv-scroll').focus(); document.querySelector('.tv-scroll').dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })); 1`);
  assert.equal(await ev(`document.activeElement.classList.contains('tv-filter')`), true, 'Ctrl+F is the table\u2019s filter');

  // Text: the editor, with the edits the table then shows.
  await ev(`document.getElementById('tableOff').click(); 1`);
  assert.equal(await ev(`document.querySelector('.code-host').hidden || !!document.querySelector('.lf-table-view')`), false);
  assert.equal(await ev(`localStorage.getItem('chattering.tableView.v1')`), 'text', 'the choice is remembered on this device');
  await ev(`fileWs.editor.setContent('id,question,score\\n1,edited,9\\n'); 1`);
  await ev(`document.getElementById('tableOn').click(); 1`);
  await until(`document.querySelector('.tv-sum')?.textContent === '1 row · 3 columns'`, 'the table shows the editor\u2019s text');
  await ev(`fileWs.editor.setContent('id,question,score\\n1,edited,9\\n2,again,8\\n'); 1`);
  await until(`document.querySelector('.tv-sum')?.textContent === '2 rows · 3 columns'`, 'the table follows the text as it changes');

  // A phone: the table scrolls inside its box; the page does not.
  await size(390, 800, true);
  await open('data.csv');
  await until(`document.querySelector('.lf-table-view .tv tbody tr[data-tv-row]')`, 'the table on a phone');
  assert.equal(await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), true, 'nothing spills sideways');
  await b.screenshot('table-view-phone.png');
  assert.deepEqual(b.exceptions || [], []);
});
