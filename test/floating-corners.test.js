'use strict';
// The floating corners of the wide layout: the files square at the top
// right and, with the side column folded, its ▸ and the voice button at the
// top left. Every view's head keeps them free (--corner-r / --corner-l), so
// no button of a page sits under one. The voice button lives in the side
// column's foot beside You when the column shows, and never beside the
// message box's dictation microphone, which looks the same.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('floating corners cover no button on any view; the voice button has a home', { timeout: 180000 }, async t => {
  const b = await viewerBrowser(t);
  const { evaluate: ev, until } = b;
  fs.writeFileSync(path.join(b.work, 'doc.md'), '# Title\n\nSome prose.\n');
  await until(`sessions.length && nav.current()`);

  // Every clickable thing of the page that a floating button overlaps.
  const covered = `(() => {
    const floats = [...document.querySelectorAll('#filesToggle, #sideUnfold, #voiceOnButton.corner')].filter(e => e.checkVisibility()).map(e => e.getBoundingClientRect());
    const hits = [];
    for (const el of document.querySelectorAll('button, a[href], summary, select, input, textarea, [role=button]')) {
      if (el.matches('#filesToggle, #sideUnfold, #voiceOnButton') || !el.checkVisibility()) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (floats.some(f => r.left < f.right && r.right > f.left && r.top < f.bottom && r.bottom > f.top))
        hits.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + el.className) + ' ' + JSON.stringify((el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 24)));
    }
    return hits;
  })()`;
  const views = [
    ['home', `goHome()`, `viewKind==='home'`],
    ['conversation', `open('pi:fixture/media.jsonl')`, `viewKind==='conversation' && !!$('floatHead')`],
    ['draft', `location.hash='#new'`, `viewKind==='draft'`],
    ['file', `openLiveFile(${JSON.stringify(path.join(b.work, 'doc.md'))}, { project: null })`, `viewKind==='file' && !!document.querySelector('.live-file-head #docStatus')`],
    ['project', `location.hash='#project=work'`, `viewKind==='project'`],
    ['usage', `location.hash='#usage'`, `viewKind==='usage'`],
  ];
  // The voice button follows the layout on a timer (700 ms).
  const settle = () => new Promise(r => setTimeout(r, 900));
  for (const folded of [false, true]) {
    await ev(`setSideFold(${folded}); 1`);
    for (const [name, go, ready] of views) {
      await ev(`${go}; 1`);
      await until(ready, name);
      await settle();
      assert.deepEqual(await ev(covered), [], `${name}${folded ? ', column folded' : ''}: a floating button covers the page's buttons`);
      if (!folded) assert.equal(await ev(`$('voiceOnButton')?.parentElement?.id`), 'sideFootSlot', `${name}: the voice button sits in the side column's foot`);
      else assert.equal(await ev(`$('voiceOnButton')?.classList.contains('corner') && $('voiceOnButton').getBoundingClientRect().left > $('sideUnfold').getBoundingClientRect().right`), true, `${name}: folded, the voice button sits beside ▸`);
    }
  }
  await ev(`setSideFold(false); 1`);

  // Files open over a conversation: the square goes, the voice button stays
  // in the foot; it never joins the dictation microphone in the message box.
  await ev(`open('pi:fixture/media.jsonl'); 1`);
  await until(`viewKind==='conversation'`);
  await ev(`setRightFiles('recent-files', true); 1`);
  await until(`rightFilesOpen`);
  await settle();
  assert.equal(await ev(`$('voiceOnButton')?.parentElement?.id`), 'sideFootSlot', 'Files open: the voice button stays beside You');
  assert.equal(await ev(`!document.querySelector('#agentCompose #voiceOnButton')`), true, 'never beside the dictation microphone');
});
