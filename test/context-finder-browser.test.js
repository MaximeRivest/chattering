'use strict';
// design/110 end to end: the finder's routes on a real server, what each
// depth sends, and the finder beside a conversation, driven by keys.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromiumAvailable } = require('./helpers/chromium.js');
const { viewerBrowser } = require('./helpers/viewer-browser.js');

function conversation(file, id, cwd, turns) {
  const lines = [{ type: 'session', version: 3, id, cwd }];
  let parent = null, n = 0;
  for (const [role, text] of turns) {
    const mid = id + '-' + (++n);
    lines.push({ type: 'message', id: mid, parentId: parent, timestamp: `2026-10-${String(10 + n).padStart(2, '0')}T12:00:00Z`,
      message: role === 'user' ? { role: 'user', content: [{ type: 'text', text }] }
        : { role: 'assistant', provider: 'p', model: 'm', content: [{ type: 'text', text }], stopReason: 'stop' } });
    parent = mid;
  }
  fs.writeFileSync(file, lines.map(JSON.stringify).join('\n') + '\n');
}

test('the context finder: rows, depths, and the panel beside a conversation', { skip: !chromiumAvailable() && 'chromium is not installed', timeout: 180000 }, async t => {
  const app = await viewerBrowser(t, {
    setup: home => {
      const dir = path.join(home, '.pi/agent/sessions/fixture'), work = path.join(home, 'work');
      conversation(path.join(dir, 'alpha.jsonl'), 'alpha', work, [
        ['user', 'The zebra importer drops rows when the quokka column is empty. Fix it.'],
        ['assistant', 'Found it: the parser skips empty quokka cells. I changed importer.py line 42 to keep them.'],
        ['user', 'Also add a test for the empty quokka column.'],
        ['assistant', 'Added test_empty_quokka in tests/test_importer.py; all 12 tests pass.'],
      ]);
      conversation(path.join(dir, 'beta.jsonl'), 'beta', work, [
        ['user', 'Plan the next release.'], ['assistant', 'Here is a plan.'],
      ]);
    },
  });
  const { evaluate, until, base, auth, command } = app;
  // CHATTERING_SHOT_DIR=… keeps pictures of each step, to look at.
  const shot = async name => { if (!process.env.CHATTERING_SHOT_DIR) return; const s = await command('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(process.env.CHATTERING_SHOT_DIR, name), Buffer.from((s.result || s).data, 'base64')); };
  const post = async (url, body) => { const r = await fetch(base + url, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const alpha = 'pi:fixture/alpha.jsonl', beta = 'pi:fixture/beta.jsonl';
  // The index is filled after the first scan.
  let found;
  for (let i = 0; i < 100; i++) {
    found = await post('/api/context/find', { key: beta, q: 'quokka' });
    if (found.body.groups && found.body.groups.length) break;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.equal(found.status, 200, JSON.stringify(found.body));
  const row = found.body.groups.flatMap(g => g.rows).find(r => r.id === 'chat:' + alpha);
  assert.ok(row, JSON.stringify(found.body));
  assert.equal(row.messages, 4);
  assert.ok(row.hits.length >= 1 && row.hits.every(h => typeof h.i === 'number'));
  assert.match(row.snippet, /\u0001quokka\u0002/i);
  assert.equal(row.depth, 'full', 'a small conversation goes whole by default');
  assert.ok(row.sizes.link < row.sizes.full);
  assert.ok(!found.body.groups.flatMap(g => g.rows).some(r => r.id === 'chat:' + beta), 'the conversation itself is not offered');

  // Without words: what the draft is about, and the recent work.
  const sug = await post('/api/context/find', { key: beta, draft: 'Does the quokka importer test still pass after the zebra change?' });
  assert.deepEqual(sug.body.groups.map(g => g.id).filter(id => id === 'related' || id === 'recent').sort(), ['recent', 'related'].filter(id => sug.body.groups.some(g => g.id === id)).sort());
  const related = sug.body.groups.find(g => g.id === 'related');
  assert.ok(related && related.rows[0].id === 'chat:' + alpha, JSON.stringify(sug.body.groups));
  assert.match(related.rows[0].why, /Shares words with your message: .*(quokka|importer|zebra)/);

  // What each depth sends.
  const preview = async item => post('/api/conversation/context-preview', { id: beta, context: [item] });
  const link = await preview({ type: 'chat', key: alpha, depth: 'link' });
  assert.match(link.body.text, /## Linked sources/); assert.match(link.body.text, /chattering show /);
  assert.doesNotMatch(link.body.text, /importer\.py line 42/, 'a link holds no text of it');
  const excerpt = await preview({ type: 'chat', key: alpha, depth: 'excerpt', pick: [row.hits[0].i] });
  assert.match(excerpt.body.text, /Excerpt chosen by the user: 1 of 4 messages/);
  const full = await preview({ type: 'chat', key: alpha, depth: 'full' });
  assert.match(full.body.text, /The whole conversation: 4 messages/); assert.match(full.body.text, /test_empty_quokka/);
  // (In a conversation this small a link's few lines can outweigh one message.)
  assert.ok(excerpt.body.tokens < full.body.tokens);
  assert.equal(full.body.items.length, 1); assert.equal(full.body.items[0].item.depth, 'full');
  // A summary nobody wrote yet: a link stands in, and says so.
  const sum = await preview({ type: 'chat', key: alpha, depth: 'summary' });
  assert.match(sum.body.text, /A summary was chosen but is not written yet/);
  // Items from before depths render as they did.
  const legacy = await preview({ type: 'chat', key: alpha });
  assert.match(legacy.body.text, /Recent history: 4 of 4 messages/);

  // The preview's reading: the messages, with their places.
  const src = await (await fetch(base + '/api/context/source?id=' + encodeURIComponent('chat:' + alpha), { headers: auth })).json();
  assert.deepEqual(src.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(src.summary, null);

  // The finder beside the conversation, by keys.
  await evaluate(`location.hash = '#${beta}'; 1`);
  await until(`$('agentAt') && current && current.key === ${JSON.stringify(beta)}`, 'the conversation with its composer');
  await evaluate(`$('agentAt').click(); 1`);
  await until(`document.querySelector('.cf .cf-row')`, 'the finder with its first rows');
  await until(`document.activeElement && document.activeElement.closest('.cf-search')`, 'focus in the finder\u2019s box');
  await evaluate(`(() => { const i = document.querySelector('.cf-search input'); i.value = 'quokka'; i.dispatchEvent(new Event('input')); return 1; })()`);
  await until(`[...document.querySelectorAll('.cf-row .cf-title')].some(e => /zebra|quokka|importer/i.test(e.textContent)) && /source/.test(document.querySelector('.cf-status').textContent)`, () => evaluate(`document.querySelector('.cf').textContent.slice(0, 600)`));
  const key = k => evaluate(`(() => { const i = document.querySelector('.cf-search input'); i.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k.key)}, shiftKey: ${!!k.shift}, ctrlKey: ${!!k.ctrl}, bubbles: true, cancelable: true })); return 1; })()`);
  // The preview shows the messages, the matched one marked.
  await until(`document.querySelector('.cf-pv-body .cf-msg.hit')`, 'the matched message in the preview');
  await key({ key: 'Enter' });
  await until(`attachedContext().length === 1 && attachedContext()[0].depth === 'full'`, () => evaluate(`JSON.stringify(attachedContext())`));
  await until(`document.querySelector('.cf-row.added') && /Remove/.test(document.querySelector('.cf-row.added .cf-add').textContent)`, 'the row marked added');
  // The composer's chip says how much, and the budget line weighs it.
  await until(`/whole/.test($('agentCtx').textContent) && $('agentCtxBudget') && /within the recommended/.test($('agentCtxBudget').textContent)`, () => evaluate(`$('agentCtx').textContent + ' | ' + ($('agentCtxBudget') || {}).textContent`));
  await until(`/· \\d/.test($('agentCtx').textContent)`, 'the chip\u2019s tokens');
  await shot('context-finder-added.png');
  // Tab: the next depth to the right (it wraps); Shift+Tab back.
  await key({ key: 'Tab', shift: true });
  await until(`attachedContext()[0].depth === 'excerpt'`, () => evaluate(`JSON.stringify(attachedContext())`));
  assert.deepEqual(await evaluate(`attachedContext()[0].pick`), row.hits.map(h => h.i), 'an excerpt starts from the matched messages');
  await key({ key: 'Tab', shift: true });
  await key({ key: 'Tab', shift: true });
  await until(`attachedContext()[0].depth === 'link'`, () => evaluate(`JSON.stringify(attachedContext())`));
  await until(`/link/.test($('agentCtx').textContent)`, 'the chip says link');
  await shot('context-finder-link.png');
  if (process.env.CHATTERING_SHOT_DIR) { await app.size(390, 844, true); await new Promise(r => setTimeout(r, 600)); await shot('context-finder-phone.png'); await app.size(1440, 1000); }
  // Saved with the conversation.
  const saved = await (await fetch(base + '/api/session?id=' + encodeURIComponent(beta), { headers: auth })).json().catch(() => ({}));
  if (saved.attachedContext) assert.equal(saved.attachedContext[0].depth, 'link');
  // Enter again removes it; Escape clears the words, then closes.
  await key({ key: 'Enter' });
  await until(`attachedContext().length === 0 && !$('agentCtxBudget')`, 'removed');
  await key({ key: 'Escape' });
  await until(`document.querySelector('.cf-search input').value === ''`, 'the words cleared');
  await key({ key: 'Escape' });
  await until(`!document.querySelector('.cf') || !document.querySelector('.cf').offsetParent`, 'the finder closed');
  assert.deepEqual(app.exceptions, []);
});
