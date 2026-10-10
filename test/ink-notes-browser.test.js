'use strict';
// Handwritten notes (design/98) in a real browser against a real server:
// made in one tap, written with a pen, erased, undone, saved by themselves,
// merged with another device's writing, never run code from the file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');
const F = require('../ink-format.js');

test('handwritten notes: make, write, erase, undo, save, merge, reopen', { timeout: 180000 }, async t => {
  const b = await viewerBrowser(t);
  const { work, evaluate: run, until, command, size } = b;
  const read = file => F.parse(fs.readFileSync(file, 'utf8'));

  // The side list offers a note in the project; the ✎ shortcut waits for a pen.
  await until(`typeof InkNotes!=='undefined' && !!$('sideInk')`);
  assert.equal(await run(`$('sideInk').hidden`), true, 'no pen seen yet: no shortcut');

  // One tap: a file, open, kept in the side list. (The test's folder is not a
  // project, so the note goes to the notes folder; a project's go to its
  // documents/handwritten/, see ink-notes.test.js.)
  const file = await run(`InkNotes.create('')`);
  await until(`!!document.querySelector('.ink-view .ink-page') && $('docStatus').textContent==='Saved'`, 'the note opens');
  assert.ok(file && fs.existsSync(file), 'the note is a file');
  assert.equal(path.basename(path.dirname(file)), 'handwritten');
  assert.match(path.basename(file), /^\d{4}-\d\d-\d\d-\d{4}\.ink\.svg$/);
  assert.equal(await run(`OpenFiles.isKept(${JSON.stringify(file)})`), true, 'it stays under Open files');
  assert.equal(await run(`viewKind`), 'file');

  // A pen stroke, through the browser's own pen events (pressure included).
  const pen = async (points, { type = 'pen', button = 'left' } = {}) => {
    const [x0, y0] = points[0];
    const ev = (kind, x, y, force) => command('Input.dispatchMouseEvent', { type: kind, x, y, button, buttons: kind === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: type, force });
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, pointerType: type });
    await ev('mousePressed', x0, y0, 0.3);
    for (const [x, y, f] of points.slice(1)) await ev('mouseMoved', x, y, f ?? 0.6);
    const [xn, yn] = points[points.length - 1];
    await ev('mouseReleased', xn, yn, 0);
  };
  const box = await run(`(()=>{const r=document.querySelector('.ink-page').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})()`);
  const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy];
  const line = (fx0, fy, fx1, n = 12) => Array.from({ length: n }, (_, i) => [...at(fx0 + (fx1 - fx0) * i / (n - 1), fy + Math.sin(i) * 0.004), 0.2 + 0.06 * i]);
  await pen(line(0.1, 0.1, 0.6));
  await until(`document.querySelectorAll('.ink-s').length===1`, 'the stroke is on the page');
  assert.equal(await run(`$('sideInk').hidden`), false, 'after a pen: the ✎ shortcut is there');
  await until(`$('docStatus').textContent==='Saved'`, 'saved by itself');
  let note = read(file);
  assert.equal(note.pages[0].strokes.length, 1);
  const s0 = note.pages[0].strokes[0];
  assert.ok(Math.abs(s0.pts[0] - 100) < 3 && Math.abs(s0.pts[1] - 141.4) < 4, 'page coordinates, independent of the screen: ' + s0.pts.slice(0, 2));
  assert.ok(new Set(s0.pts.filter((_, i) => i % 3 === 2).map(p => p.toFixed(2))).size > 2, 'pressure varies along the line');
  assert.ok(s0.t0 > 1.7e12, 'the time it was written');
  assert.equal(await run(`document.querySelectorAll('.ink-page').length`), 2, 'a fresh page waits below the written one');

  // The mouse writes too; the finger scrolls and never writes.
  await pen(line(0.1, 0.2, 0.4), { type: 'mouse' });
  await until(`document.querySelectorAll('.ink-s').length===2`);
  const before = await run(`document.querySelector('.ink-scroll').scrollTop`);
  await size(1440, 1000, true);
  const tbox = await run(`(()=>{const r=document.querySelector('.ink-scroll').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height*0.6}})()`);
  await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tbox.x, y: tbox.y }] });
  for (let i = 1; i <= 8; i++) await command('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tbox.x, y: tbox.y - i * 40 }] });
  await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until(`document.querySelector('.ink-scroll').scrollTop>${before}+200`, 'one finger scrolls the note');
  assert.equal(await run(`document.querySelectorAll('.ink-s').length`), 2, 'the finger wrote nothing');
  await run(`document.querySelector('.ink-scroll').scrollTop=0`);
  await size(1440, 1000);

  // The eraser removes the line it touches; undo brings it back; redo again.
  await run(`document.querySelector('[data-ink-tool=eraser]').click()`);
  await pen([at(0.35, 0.08), at(0.35, 0.12)]);
  await until(`document.querySelectorAll('.ink-s').length===1`, () => run(`JSON.stringify({tool:InkNotes.current.tool,top:document.querySelector('.ink-scroll').scrollTop,box:document.querySelector('.ink-page').getBoundingClientRect(),strokes:InkNotes.current.note.pages.map(p=>p.strokes.map(s=>s.pts.slice(0,2).map(Math.round)))})`));
  await run(`document.querySelector('[data-ink-tool=pen]').click()`);
  await run(`$('inkUndo').click()`);
  assert.equal(await run(`document.querySelectorAll('.ink-s').length`), 2, 'undo brings the line back');
  await run(`$('inkRedo').click()`);
  assert.equal(await run(`document.querySelectorAll('.ink-s').length`), 1, 'redo erases it again');
  // (The pen's eraser end, buttons & 32, cannot be sent through DevTools.)
  await until(`$('docStatus').textContent==='Saved'`);
  assert.equal(read(file).pages[0].strokes.length, 1);

  // Another device writes in the same note meanwhile: both are kept.
  const other = read(file);
  other.pages[0].strokes.push({ pts: [500, 900, 0.5, 600, 950, 0.7, 700, 900, 0.5], w: 2.6, t0: Date.now() - 1000, dur: 300, color: '' });
  fs.writeFileSync(file, F.serialize(other));
  await pen(line(0.1, 0.5, 0.5));
  await until(`$('docStatus').textContent==='Saved' && document.querySelectorAll('.ink-s').length===3`, 'merged with the other device');
  note = read(file);
  assert.equal(note.pages[0].strokes.length, 3, 'nothing lost, nothing doubled');

  // Paper, width and reopening: the note comes back as it was.
  await run(`document.querySelector('.ink-more').open=true;document.querySelector('[data-ink-paper=grid]').click();document.querySelector('[data-ink-width="4.2"]').click()`);
  await pen(line(0.1, 0.6, 0.5));
  await until(`$('docStatus').textContent==='Saved'`);
  note = read(file);
  assert.equal(note.paper, 'grid');
  assert.equal(note.pages[0].strokes.at(-1).w, 4.2);
  fs.writeFileSync(path.join(work, 'nothing.txt'), 'x');
  await run(`openLiveFile(${JSON.stringify(path.join(work, 'nothing.txt'))}, {project:'work'})`);
  await until(`!document.querySelector('.ink-view')`);
  await run(`openLiveFile(${JSON.stringify(file)}, {project:'work'})`);
  await until(`document.querySelectorAll('.ink-s').length===4 && !!document.querySelector('.ink-paper-grid')`, 'reopened as it was');
  assert.deepEqual(b.exceptions, []);

  // A phone: the page fits, the tools stay reachable.
  await size(390, 844, true);
  await until(`document.querySelector('.ink-page').getBoundingClientRect().width<=390`);
  assert.equal(await run(`document.documentElement.scrollWidth<=innerWidth && document.querySelector('[data-ink-tool=pen]').getBoundingClientRect().right<=innerWidth`), true);
  await b.screenshot('ink-note-phone.png');
  await run(`document.documentElement.dataset.themeMode='binary'`);
  await size(1404, 1872, true);
  await b.screenshot('ink-note-eink.png');
  await run(`delete document.documentElement.dataset.themeMode`);
  await size(1440, 1000);
  await b.screenshot('ink-note-desktop.png');
});

test('a note never runs code from its file', { timeout: 120000 }, async t => {
  const b = await viewerBrowser(t);
  const { work, evaluate: run, until } = b;
  const file = path.join(work, 'trap.ink.svg');
  fs.writeFileSync(file, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1414" data-ink-format="1" data-paper="blank">
<g data-ink-page="1"><g data-ink-layer="pen"><path d="M10 10l100 100" stroke-width="3"/></g>
<g data-ink-layer="extra"><script>window.ran=1</script><image href="javascript:window.ran=2" width="10" height="10" onload="window.ran=3"/><rect width="50" height="50" onclick="window.ran=4" fill="url(javascript:alert(1))"/><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="window.ran=5"/></div></foreignObject><text x="20" y="300">kept text</text></g></g></svg>`);
  await run(`openLiveFile(${JSON.stringify(file)}, {project:'work'})`);
  await until(`document.querySelectorAll('.ink-s').length===1`);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await run(`window.ran===undefined`), true);
  assert.equal(await run(`!document.querySelector('.ink-extra script, .ink-extra foreignObject, .ink-extra [onclick], .ink-extra [onload]')`), true);
  assert.equal(await run(`document.querySelector('.ink-extra text').textContent`), 'kept text');
  assert.equal(await run(`!document.querySelector('.ink-extra rect').getAttribute('fill')`), true, 'a url() paint is dropped');
  // Writing on it keeps what it holds, including what was not shown.
  await run(`InkNotes.current.note.pages[0].strokes.push({pts:[1,1,0.5,2,2,0.5],w:2,t0:1,dur:1,color:''});`);
  assert.deepEqual(b.exceptions, []);
});
