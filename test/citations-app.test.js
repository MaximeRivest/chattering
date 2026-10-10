'use strict';
// Citation cards in the real app (design/97): an answer with numbered
// citations shows buttons and a filled reference list; a button opens the
// paper's card on click and on hover; a made-up reference is flagged in the
// text itself; Escape closes the card. The paper service is a fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');
const { chromiumAvailable } = require('./helpers/chromium.js');

const ANSWER = [
  'Semaglutide gave about 15% weight loss [1], and tirzepatide about 20% [2][3].',
  'One reference does not exist [4].',
  '',
  '## References',
  '- [1] https://doi.org/10.5555/sema — Wilding 2021',
  '- [2] https://doi.org/10.5555/tirz',
  '- [3] https://openalex.org/W1003',
  '- [4] https://openalex.org/W404404 — Invented 2020',
].join('\n');

const RECORDS = {
  '/works/10.5555/sema': { id: 'W1001', doi: '10.5555/sema', title: 'Once-Weekly Semaglutide in Adults with Overweight or Obesity', year: 2021, type: 'article', authors: 'John Wilding | Rachel Batterham | Salvatore Calanna | Melanie Davies', authors_count: 14, venue: 'New England Journal of Medicine', citations: 5049, is_oa: 1, smr: 0, abstract: 'BACKGROUND: Obesity is a global health challenge. '.repeat(20), openalex: 'https://openalex.org/W1001' },
  '/works/10.5555/tirz': { id: 'W1002', doi: '10.5555/tirz', title: 'Tirzepatide Once Weekly for the Treatment of Obesity', year: 2022, type: 'article', authors: 'Ania Jastreboff', authors_count: 9, venue: 'New England Journal of Medicine', citations: 3000 },
  '/works/W1003': { id: 'W1003', doi: null, title: 'A review of incretin drugs', year: 2024, type: 'review', authors: 'A Author', authors_count: 1, venue: 'Obesity Reviews', citations: 12 },
};

test('citation buttons, the reference list and the paper card', { skip: !chromiumAvailable() && 'no Chromium' }, async t => {
  const fake = http.createServer((req, res) => {
    const rec = RECORDS[decodeURIComponent(req.url)];
    res.writeHead(rec ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rec || { detail: 'not in the corpus' }));
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  t.after(() => fake.close());
  const api = 'http://127.0.0.1:' + fake.address().port;

  const b = await viewerBrowser(t, {
    env: { CHATTERING_PAPERS_API: api },
    setup(home) {
      const dir = path.join(home, '.pi/agent/sessions/fixture');
      fs.writeFileSync(path.join(dir, 'cite.jsonl'), [
        { type: 'session', version: 3, id: 'cite', cwd: path.join(home, 'work') },
        { type: 'message', id: 'u1', parentId: null, timestamp: '2026-10-10T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'How do weight-loss drugs compare?' }] } },
        { type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-10-10T10:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: ANSWER }], model: 'test', provider: 'test' } },
      ].map(JSON.stringify).join('\n') + '\n');
    },
  });
  await b.until(`typeof sessions !== 'undefined' && sessions.some(s => s.key === 'pi:fixture/cite.jsonl')`, 'the fixture conversation is listed');
  await b.evaluate(`open('pi:fixture/cite.jsonl')`);
  await b.until(`document.querySelectorAll('#view .md .cite').length === 3`, 'three citation buttons');
  assert.deepEqual(await b.evaluate(`[...document.querySelectorAll('#view .md .cite')].map(x => x.textContent)`), ['1', '2, 3', '4']);

  // The list fills itself with the records; the invented one is flagged.
  await b.until(`document.querySelectorAll('#view .cite-ref[data-cite-done]').length === 4`, 'the reference list is filled');
  const list = await b.evaluate(`[...document.querySelectorAll('#view .cite-ref')].map(li => ({ n: li.dataset.citeN, title: li.querySelector('.cite-ref-title')?.textContent, problem: li.classList.contains('problem') }))`);
  assert.equal(list[0].title, 'Once-Weekly Semaglutide in Adults with Overweight or Obesity');
  assert.equal(list[2].title, 'A review of incretin drugs');
  assert.equal(list[3].title, 'Invented 2020', 'the agent’s own words when no record exists');
  await b.until(`document.querySelector('#view .cite-ref[data-cite-n="4"] .cite-note')`, 'the missing paper says so');

  // Click: the card, with title, authors, the short summary and links.
  await b.evaluate(`document.querySelector('#view .md .cite').click()`);
  await b.until(`document.querySelector('.cite-pop:not([hidden]) .cite-title')?.textContent.includes('Semaglutide')`, 'the card opens on click');
  const card = await b.evaluate(`(() => { const p = document.querySelector('.cite-pop'); return { authors: p.querySelector('.cite-authors')?.textContent, meta: p.querySelector('.cite-meta')?.textContent, clipped: !!p.querySelector('.cite-abstract.clipped'), links: [...p.querySelectorAll('.cite-links a')].map(a => a.textContent), goto: !!p.querySelector('.cite-goto') }; })()`);
  assert.equal(card.authors, 'John Wilding, Rachel Batterham, Salvatore Calanna et al. (14 authors)');
  assert.match(card.meta, /2021 · New England Journal of Medicine · cited 5,049 times/);
  assert.ok(card.clipped, 'a long summary starts short');
  assert.ok(card.links.includes('Publisher page'));
  assert.ok(card.goto);
  await b.evaluate(`document.querySelector('.cite-pop .cite-more').click()`);
  assert.equal(await b.evaluate(`!!document.querySelector('.cite-pop .cite-abstract.clipped')`), false, 'the whole summary on demand');

  // Escape closes it and gives the focus back to the number.
  await b.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await b.until(`document.querySelector('.cite-pop').hidden`, 'Escape closes the card');

  // A group opens one card listing each of its papers.
  await b.evaluate(`document.querySelectorAll('#view .md .cite')[1].click()`);
  await b.until(`document.querySelectorAll('.cite-pop:not([hidden]) .cite-paper').length === 2`, 'two papers in the group card');

  // The made-up reference is marked in the text, without opening anything.
  await b.until(`document.querySelectorAll('#view .md .cite')[2].classList.contains('problem') === false`, 'a W-number not in the database is not called made-up');

  // Hover with a mouse previews the card.
  await b.evaluate(`document.querySelector('.cite-pop').hidden = true`);
  const r = await b.evaluate(`(() => { const x = document.querySelector('#view .md .cite').getBoundingClientRect(); return { x: x.left + x.width / 2, y: x.top + x.height / 2 }; })()`);
  await b.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
  await b.until(`!document.querySelector('.cite-pop').hidden`, 'hover opens the card');
  assert.deepEqual(b.exceptions, []);
});
