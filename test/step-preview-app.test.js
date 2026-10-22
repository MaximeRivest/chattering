'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');
const { chromiumAvailable } = require('./helpers/chromium');

const KEY = 'pi:fixture/previews.jsonl';
async function setup(home) {
  const cwd = path.join(home, 'work');
  const html = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"></head>\n' +
    Array.from({ length: 150 }, (_, i) => `<p data-row="${i}">${'long text '.repeat(150)}</p>`).join('\n');
  const files = { 'large.html': html, 'page.md': '# A long page\n\n' + 'A paragraph.\n\n'.repeat(250), 'short.txt': 'one\ntwo\n' };
  const rows = [{ type: 'session', version: 3, id: 'previews', cwd },
    { type: 'message', id: 'u', message: { role: 'user', content: [{ type: 'text', text: 'Write the files' }] } }];
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(cwd, name);
    fs.writeFileSync(file, content);
    rows.push({ type: 'message', id: 'a-' + name, message: { role: 'assistant', content: [{ type: 'toolCall', id: name, name: 'write', arguments: { path: file, content } }] } },
      { type: 'message', id: 'r-' + name, message: { role: 'toolResult', toolCallId: name, toolName: 'write', content: [{ type: 'text', text: 'ok' }] } });
  }
  rows.push({ type: 'message', id: 'done', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
  fs.writeFileSync(path.join(home, '.pi/agent/sessions/fixture/previews.jsonl'), rows.map((r, i) => JSON.stringify({ ...r,
    timestamp: new Date(Date.UTC(2026, 8, 1, 12, 0, i)).toISOString(), ...(i ? { parentId: i > 1 ? rows[i - 1].id : null } : {}),
  })).join('\n') + '\n');
}

test('file previews stay bounded, readable and closable on desktop and phone', { skip: !chromiumAvailable(), timeout: 180000 }, async t => {
  const b = await viewerBrowser(t, { setup });
  const { evaluate: ev, until, size } = b;
  await until('sessions.length && nav.current()');
  if (await ev(`!!document.querySelector('dialog.bg-ask [data-none]')`)) await ev(`document.querySelector('dialog.bg-ask [data-none]').click()`);
  await ev(`open(${JSON.stringify(KEY)}); 1`);
  await until(`document.querySelectorAll('.sc-row:not(.sc-wait)').length === 3`);
  // Declarations, unrecognised syntax and entities must remain literal
  // source, never HTML that can repair/reparent the surrounding code rows.
  const examples = ['<!doctype html>', '<?xml version="1.0"?>', '<!unknown', '<div title="a&b">', '<tag &amp;>', '</code><script>alert(1)</script>'];
  const literal = await ev(`(${JSON.stringify(examples)}).map(text => {
    const host = document.createElement('div');
    host.innerHTML = '<code>' + highlightFileLines(text, 'html', {eager:true})[0] + '</code>';
    return {text: host.textContent, codes: host.querySelectorAll('code').length, unsafe: !!host.querySelector('script, div, tag')};
  })`);
  assert.deepEqual(literal, examples.map(text => ({ text, codes: 1, unsafe: false })));
  const row = name => `document.querySelector('.sc-row[data-file-diff$="/${name}"]')`;
  const card = name => `document.querySelector('.sc-card[data-sc-card$="/${name}"]')`;
  for (const [width, height] of [[1300, 1000], [390, 740], [740, 390]]) {
    await size(width, height, width < 800);
    await ev(`${row('large.html')}.click(); 1`);
    await until(`${card('large.html')}?.querySelector('.sc-code')`);
    const geometry = await ev(`(() => { const c = ${card('large.html')}, body = c.querySelector('.sc-body'), line = c.querySelectorAll('.sc-l')[1], code = line.querySelector('.sc-c');
      c.scrollIntoView({block:'start'});
      const before = c.querySelector('[data-sc-act="close"]').getBoundingClientRect().top;
      body.scrollTop = body.scrollHeight;
      return { height: body.clientHeight, full: body.scrollHeight, line: line.clientWidth, code: code.clientWidth,
        closeMoved: c.querySelector('[data-sc-act="close"]').getBoundingClientRect().top - before,
        overflow: body.scrollWidth > body.clientWidth + 1, text: code.textContent,
        markup: line.outerHTML, grid: getComputedStyle(line).gridTemplateColumns,
        children: [...line.children].map(x => [x.tagName, x.className, getComputedStyle(x).display, x.getBoundingClientRect().width]) };
    })()`);
    assert.ok(geometry.height <= height * .55 + 1, JSON.stringify(geometry));
    assert.ok(geometry.full > geometry.height * 2, 'large content scrolls inside the preview');
    assert.ok(geometry.code > geometry.line * .7, 'HTML source uses the reading column: ' + JSON.stringify(geometry));
    assert.equal(geometry.closeMoved, 0, 'scrolling the file never scrolls away its close button');
    assert.equal(geometry.overflow, false, 'wrapped code fits the preview');
    assert.equal(geometry.text, '<html lang="en"><head><meta charset="utf-8"></head>');
    await ev(`${card('large.html')}.querySelector('[data-sc-all]').click(); 1`);
    assert.ok(await ev(`${card('large.html')}.querySelector('.sc-body').clientHeight <= innerHeight * .55 + 1`), 'show all still respects the screen');
    if (width === 1300) await b.screenshot('step-preview-desktop.png');
    if (width === 390) await b.screenshot('step-preview-phone.png');
    await ev(`${card('large.html')}.querySelector('[data-sc-act="close"]').click(); 1`);
    assert.equal(await ev(`!!${card('large.html')}`), false);
    assert.equal(await ev(`${row('large.html')}.getAttribute('aria-expanded')`), 'false');
    assert.equal(await ev(`document.activeElement === ${row('large.html')}`), true, 'focus returns to the file row');
  }
  await size(1300, 1000);
  await ev(`${row('page.md')}.click(); ${row('short.txt')}.click(); 1`);
  await until(`${card('page.md')}?.querySelector('[data-sc-all]') && ${card('short.txt')}?.querySelector('.sc-read')`);
  assert.ok(await ev(`${card('short.txt')}.querySelector('.sc-body').clientHeight < 100`), 'short previews stay small');
  await ev(`${card('page.md')}.querySelector('[data-sc-all]').click(); 1`);
  assert.ok(await ev(`${card('page.md')}.querySelector('.sc-body').scrollHeight > ${card('page.md')}.querySelector('.sc-body').clientHeight`));
  await ev(`${card('page.md')}.querySelector('.sc-body').focus(); 1`);
  await b.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await b.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  assert.equal(await ev(`!!${card('page.md')}`), false, 'Escape closes just the focused preview');
  assert.equal(await ev(`!!${card('short.txt')}`), true);
  await ev('renderConv(); 1');
  await until(`${card('short.txt')}?.querySelector('.sc-read')`);
  assert.equal(await ev(`!!${card('page.md')} || !!${card('large.html')}`), false, 'closed previews stay closed after redrawing');

  // A pending request must not trap the reader or reopen a dismissed card.
  await ev(`window.previewFetch = window.fetch;
    window.fetch = (url, ...args) => String(url).startsWith('/api/conversation/change?')
      ? new Promise(resolve => { window.finishPreview = resolve; }) : previewFetch(url, ...args);
    const host = document.createElement('div'); host.id = 'pendingPreview';
    host.innerHTML = StepChanges.stripHtml('pending-key', ['pending-call'], ['/pending.txt']);
    document.getElementById('view').append(host);
    StepChanges.toggle(host.querySelector('.sc-row')); 1`);
  assert.equal(await ev(`!!document.querySelector('#pendingPreview [data-sc-act="close"]')`), true, 'loading has a close button too');
  await ev(`document.querySelector('#pendingPreview [data-sc-act="close"]').click();
    finishPreview(new Response(JSON.stringify({path:'/pending.txt',kind:'written',next:{text:'late reply'}})));
    window.fetch = previewFetch; 1`);
  assert.equal(await ev(`!!document.querySelector('#pendingPreview .sc-card')`), false);
  // Failed requests retain the same escape route.
  await ev(`window.fetch = (url, ...args) => String(url).startsWith('/api/conversation/change?')
    ? Promise.resolve(new Response(JSON.stringify({error:'Unavailable'}), {status:503})) : previewFetch(url, ...args);
    document.getElementById('pendingPreview').innerHTML = StepChanges.stripHtml('failed-key', ['failed-call'], ['/failed.txt']);
    StepChanges.toggle(document.querySelector('#pendingPreview .sc-row')); 1`);
  await until(`document.querySelector('#pendingPreview .sc-what')?.textContent === 'Unavailable'`);
  await ev(`document.querySelector('#pendingPreview [data-sc-act="close"]').click(); window.fetch = previewFetch; 1`);
  assert.equal(await ev(`!!document.querySelector('#pendingPreview .sc-card')`), false);
  assert.deepEqual(b.exceptions, []);
});
