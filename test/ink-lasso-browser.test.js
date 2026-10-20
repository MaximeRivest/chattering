'use strict';
// The lasso of a handwritten note (design/99): circle lines to select them,
// drag to move them (undoable, and saved as old lines out and new ones in,
// so devices still merge as sets), delete them, or ask about them in a
// conversation with the circled lines as a picture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { viewerBrowser } = require('./helpers/viewer-browser');
const F = require('../ink-format.js');

test('lasso: select, move, undo, delete, ask', { timeout: 180000 }, async t => {
  const b = await viewerBrowser(t);
  const { evaluate: run, until, command } = b;
  const read = file => F.parse(fs.readFileSync(file, 'utf8'));
  await until(`typeof InkNotes!=='undefined'`);
  const file = await run(`InkNotes.create('')`);
  await until(`!!document.querySelector('.ink-view .ink-page') && $('docStatus').textContent==='Saved'`);
  const pen = async (points) => {
    const ev = (type, x, y, buttons) => command('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'pen', force: 0.5 });
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points[0][0], y: points[0][1], pointerType: 'pen' });
    await ev('mousePressed', points[0][0], points[0][1], 1);
    for (const [x, y] of points.slice(1)) await ev('mouseMoved', x, y, 1);
    await ev('mouseReleased', points.at(-1)[0], points.at(-1)[1], 0);
  };
  const box = await run(`(()=>{const r=document.querySelector('.ink-page').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})()`);
  const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy];
  const line = (fy) => Array.from({ length: 10 }, (_, i) => at(0.2 + 0.04 * i, fy + 0.005 * Math.sin(i)));
  const count = `InkNotes.current.note.pages[0].strokes.length`;
  for (const fy of [0.1, 0.16, 0.4]) await pen(line(fy));
  await until(`${count}===3 && $('docStatus').textContent==='Saved'`, 'three lines written');
  const before = read(file).pages[0].strokes.map(s => s.pts.slice(0, 2));

  // The lasso: a loop around the first two lines.
  await run(`document.querySelector('[data-ink-tool=lasso]').click()`);
  assert.equal(await run(`InkNotes.current.tool`), 'lasso');
  const loop = Array.from({ length: 24 }, (_, i) => { const a = i / 23 * Math.PI * 2; return at(0.38 + 0.26 * Math.cos(a), 0.13 + 0.07 * Math.sin(a)); });
  await pen(loop);
  await until(`InkNotes.current.sel && InkNotes.current.sel.list.length===2`, 'the two circled lines are selected');
  assert.equal(await run(`!!document.querySelector('.ink-sel canvas') && !!document.querySelector('.ink-sel-bar [data-sel=ask]')`), true, 'a frame with its buttons');
  assert.equal(await run(`${count}`), 3, 'the loop itself is not a line');

  // Drag the selection with the pen: right and down.
  const k = box.w / F.PAGE_W;
  const [cx, cy] = at(0.38, 0.13);
  await pen([[cx, cy], [cx + 40, cy + 20], [cx + 80, cy + 40], [cx + 100, cy + 50]]);
  await until(`$('docStatus').textContent==='Saved' && !InkNotes.current.drag`);
  let after = read(file).pages[0].strokes;
  assert.equal(after.length, 3, 'moved, not copied');
  const moved = after.filter(s => !before.some(p => Math.abs(p[0] - s.pts[0]) < 0.2 && Math.abs(p[1] - s.pts[1]) < 0.2));
  assert.equal(moved.length, 2, 'the two selected lines moved');
  assert.ok(Math.abs(moved[0].pts[0] - before[0][0] - 100 / k) < 3 && Math.abs(moved[0].pts[1] - before[0][1] - 50 / k) < 3, 'by the drag: ' + moved[0].pts.slice(0, 2) + ' from ' + before[0]);
  assert.equal(await run(`InkNotes.current.sel?.list.length`), 2, 'still selected after the move');

  // Undo puts them back, redo moves them again.
  await run(`$('inkUndo').click()`);
  assert.deepEqual(await run(`InkNotes.current.note.pages[0].strokes.map(s=>[Math.round(s.pts[0]*10)/10,Math.round(s.pts[1]*10)/10]).sort()`), before.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]).sort(), 'undo: where they were');
  assert.equal(await run(`!!InkNotes.current.sel`), false, 'undo lets go of the selection');
  await run(`$('inkRedo').click()`);
  await until(`$('docStatus').textContent==='Saved'`);
  assert.equal(read(file).pages[0].strokes.length, 3);

  // Select again and delete; undo brings them back.
  await pen(Array.from({ length: 24 }, (_, i) => { const a = i / 23 * Math.PI * 2; return at(0.38 + 0.08 + 0.3 * Math.cos(a), 0.13 + 0.035 + 0.09 * Math.sin(a)); }));
  await until(`InkNotes.current.sel && InkNotes.current.sel.list.length===2`, 'the moved lines selected again');
  await run(`document.querySelector('.ink-sel-bar [data-sel=delete]').click()`);
  await until(`${count}===1 && $('docStatus').textContent==='Saved'`);
  assert.equal(read(file).pages[0].strokes.length, 1, 'deleted from the file');
  // The toast says so and undoes it.
  await until(`[...document.querySelectorAll('.toast')].some(t=>/Deleted 2 lines/.test(t.textContent))`, 'a toast with undo');
  await run(`[...document.querySelectorAll('.toast')].find(t=>/Deleted 2 lines/.test(t.textContent)).click()`);
  await until(`${count}===3`, 'undone from the toast');

  // Copy, then a tap in Select offers to paste there; the pasted lines are
  // the selection, one undo step, and saved.
  await pen(Array.from({ length: 24 }, (_, i) => { const a = i / 23 * Math.PI * 2; return at(0.38 + 0.08 + 0.3 * Math.cos(a), 0.13 + 0.035 + 0.09 * Math.sin(a)); }));
  await until(`InkNotes.current.sel && InkNotes.current.sel.list.length===2`, 'selected for copying');
  await run(`document.querySelector('.ink-sel-bar [data-sel=copy]').click()`);
  assert.equal(JSON.parse(await run(`localStorage.getItem('chattering.ink.clip')`)).strokes.length, 2, 'copied on this device');
  await pen([at(0.9, 0.3)]); // a tap lets go of the selection
  assert.equal(await run(`!!InkNotes.current.sel`), false);
  await pen([at(0.2, 0.5), at(0.2005, 0.5)]); // a tap with something copied: Paste here
  await until(`!!document.querySelector('.ink-paste-bar [data-sel=paste]')`, 'the paste bar');
  await run(`document.querySelector('.ink-paste-bar [data-sel=paste]').click()`);
  await until(`${count}===5 && InkNotes.current.sel && InkNotes.current.sel.list.length===2 && $('docStatus').textContent==='Saved'`, 'pasted and selected');
  const pasted = read(file).pages[0].strokes.slice(-2);
  assert.ok(Math.abs(Math.min(...pasted.map(s => Math.min(...s.pts.filter((_, j) => j % 3 === 0)))) - 200) < 4, 'at the tap');
  await run(`$('inkUndo').click()`);
  await until(`${count}===3`, 'undo takes the pasted lines away');
  // Paste (Ctrl+V) pastes in the middle of the page on screen: the clipboard holds the lines' picture, no text.
  await run(`(()=>{const d=new DataTransfer();d.setData('text/html','<img>');document.querySelector('.ink-scroll').dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));return 1})()`);
  await until(`${count}===5`, 'Ctrl+V pastes');
  await run(`$('inkUndo').click()`);
  await until(`${count}===3`);

  // A loop around nothing selects nothing; Done lets go.
  await pen(Array.from({ length: 12 }, (_, i) => { const a = i / 11 * Math.PI * 2; return at(0.8 + 0.05 * Math.cos(a), 0.8 + 0.03 * Math.sin(a)); }));
  assert.equal(await run(`!!InkNotes.current.sel`), false);

  // Ask: no conversation beside, so a new one opens in the note's project,
  // with the circled lines as a picture and a line saying where they are from.
  await pen(Array.from({ length: 24 }, (_, i) => { const a = i / 23 * Math.PI * 2; return at(0.38 + 0.26 * Math.cos(a), 0.4 + 0.05 * Math.sin(a)); }));
  await until(`InkNotes.current.sel && InkNotes.current.sel.list.length===1`);
  await run(`document.querySelector('.ink-sel-bar [data-sel=ask]').click()`);
  await until(`viewKind==='draft' && (window._agentImages||[]).length===1`, 'a new conversation with the picture');
  const text = await run(`$('agentText').value`);
  assert.match(text, /^About this part of my handwritten note \(.*\.ink\.svg, page 1\): $/);
  assert.equal(await run(`window._agentImages[0].mime`), 'image/png');
  const size = await run(`new Promise(r=>{const i=new Image();i.onload=()=>r([i.width,i.height]);i.src=window._agentImages[0].preview})`);
  assert.ok(size[0] > 200 && size[1] > 20, 'a picture of the circled line: ' + size);
  // Back to the note after asking: every line is there, on the page and in the file.
  await run(`openLiveFile(${JSON.stringify(file)}, {project:'work'})`);
  await until(`InkNotes.current && InkNotes.current.note && ${count}===3`, 'the note comes back whole');
  await pen(line(0.5));
  await until(`${count}===4 && $('docStatus').textContent==='Saved'`);
  assert.equal(read(file).pages[0].strokes.length, 4, 'nothing lost after asking');
  assert.deepEqual(b.exceptions, []);
});
