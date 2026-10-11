'use strict';
// A note's finger taps and toolbar (design/99): two fingers undo, three
// redo; a moving or hand-sized touch is not a tap; the app's layer, when it
// has the note, reports the taps itself. The toolbar never overlaps the
// page, also through the encrypted link (whose inset rule once gave every
// header a fixed height, so the tools spilled over the note).
const test = require('node:test');
const assert = require('node:assert/strict');
const { viewerBrowser } = require('./helpers/viewer-browser');

test('two fingers undo, three redo; the toolbar stays off the page', { timeout: 180000 }, async t => {
  const b = await viewerBrowser(t);
  const { evaluate: run, until, command, size } = b;
  await until(`typeof InkNotes!=='undefined'`);
  await run(`InkNotes.create('')`);
  await until(`!!document.querySelector('.ink-view .ink-page') && $('docStatus').textContent==='Saved'`);
  const count = `InkNotes.current.note.pages[0].strokes.length`;
  const box = await run(`(()=>{const r=document.querySelector('.ink-page').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})()`);
  const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy];
  const pen = async pts => {
    const ev = (type, x, y, buttons) => command('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'pen', force: 0.5 });
    await ev('mousePressed', pts[0][0], pts[0][1], 1); for (const [x, y] of pts.slice(1)) await ev('mouseMoved', x, y, 1); await ev('mouseReleased', pts.at(-1)[0], pts.at(-1)[1], 0);
  };
  for (const fy of [0.1, 0.15]) await pen(Array.from({ length: 8 }, (_, i) => at(0.2 + 0.05 * i, fy)));
  await until(`${count}===2`);
  const fingers = async (n, { move = 0, radius = 8, hold = 60 } = {}) => {
    const pts = Array.from({ length: n }, (_, i) => ({ x: box.x + box.w * (0.3 + 0.1 * i), y: box.y + box.h * 0.3, radiusX: radius, radiusY: radius, id: i + 1 }));
    await command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts });
    if (move) await command('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts.map(p => ({ ...p, y: p.y + move })) });
    await run(`new Promise(r=>setTimeout(r,${hold}))`);
    await command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await run(`new Promise(r=>setTimeout(r,120))`);
  };
  await fingers(2);
  await until(`${count}===1`, 'two fingers undo');
  await fingers(2);
  await until(`${count}===0`, 'and again');
  await fingers(3);
  await until(`${count}===1`, 'three fingers redo');
  await fingers(2, { move: 80 });
  assert.equal(await run(count), 1, 'two fingers moving scroll, they do not undo');
  await fingers(2, { radius: 40 });
  assert.equal(await run(count), 1, 'a hand-sized contact is not a tap');
  await fingers(2, { hold: 600 });
  assert.equal(await run(count), 1, 'a long press is not a tap');
  await fingers(1);
  assert.equal(await run(count), 1, 'one finger does nothing');
  // The app's layer reports taps itself; the page then leaves fingers alone.
  await run(`window.fileInkGesture('redo')`);
  await until(`${count}===2`, "the app's redo");
  await run(`InkNotes.current.nativeOn=true`);
  await fingers(2);
  assert.equal(await run(count), 2, "with the app's layer on, the page does not count the same tap again");
  await run(`InkNotes.current.nativeOn=false`);

  // The toolbar: through the encrypted link, on the tablet's width, beside the side list.
  for (const [w, h] of [[960, 1280], [700, 1100], [1404, 1872]]) {
    await size(w, h, true);
    await run(`document.documentElement.setAttribute('data-anywhere-inset','');document.documentElement.style.setProperty('--anywhere-inset-top','0px')`);
    await run(`new Promise(r=>setTimeout(r,200))`);
    const lay = await run(`(()=>{const head=document.querySelector('.ink-head').getBoundingClientRect(),sc=document.querySelector('.ink-scroll').getBoundingClientRect();
      const out=[...document.querySelectorAll('.ink-tools button')].filter(b=>b.getBoundingClientRect().width>0).map(b=>b.getBoundingClientRect()).filter(r=>r.bottom>sc.top+0.5||r.right>innerWidth);
      return {headBottom:head.bottom,scrollTop:sc.top,spill:out.length}})()`);
    assert.ok(lay.headBottom <= lay.scrollTop + 0.5 && lay.spill === 0, `${w}px: the tools stay above the page ` + JSON.stringify(lay));
  }
  await b.screenshot('ink-toolbar-960.png');
  assert.deepEqual(b.exceptions, []);
});
