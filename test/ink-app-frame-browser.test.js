'use strict';
// The Android app's fast pen through the encrypted link (design/98, design/99).
//
// There, Chattering is a frame of the app's shell page, on the same site.
// The note page refused the app's pen in any frame, so on the AINOTE every
// line was drawn by the page (pen log of 2026-10-10: fastNib false, ~43
// points a second) although the app's fast e-ink layer was installed.
// Here the frame sits away from the window's corner, behind a border, and
// a stand-in for the app's bridge (ChatteringInk) records what the page
// tells it: the writing area must be given in the window's pixels, and a
// line the app sends back in the window's pixels must land where the pen was.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { viewerBrowser } = require('./helpers/viewer-browser');
const F = require('../ink-format.js');

test('a note in the shell\'s frame hands the pen to the app, in window coordinates', { timeout: 180000 }, async t => {
  const b = await viewerBrowser(t);
  const { base, evaluate: run, until, command } = b;
  // The shell: a same-site page holding Chattering in a frame at (40, 70) with a 3 px border.
  await command('Page.navigate', { url: base + '/health' });
  await until(`location.pathname==='/health' && document.readyState==='complete'`);
  await run(`(()=>{document.open();document.write('<!doctype html><body style="margin:0"><iframe id="app" src="/" style="position:fixed;left:40px;top:70px;width:1200px;height:880px;border:3px solid #000"></iframe></body>');document.close();return 1})()`);
  const W = `document.getElementById('app').contentWindow`;
  await until(`typeof ${W}.InkNotes!=='undefined' && typeof ${W}.load==='function'`, 'Chattering loads in the frame');
  // The app's bridge exists in every frame of its WebView.
  await run(`(()=>{const calls=[];${W}.ChatteringInk={calls,drawn:0,
    setEnabled(on){calls.push(['enabled',on])},setRegion(l,t,r,b){calls.push(['region',l,t,r,b])},setPixelRatio(x){calls.push(['ratio',x])},
    setErase(){},setWidth(){},setPressureTypical(){},clearLive(){},clearAll(){},fastNib(){return true},strokeDrawn(){this.drawn++}};return 1})()`);
  const file = await run(`${W}.InkNotes.create('')`);
  await until(`!!${W}.document.querySelector('.ink-view .ink-page') && ${W}.document.getElementById('docStatus').textContent==='Saved'`, () => run(`JSON.stringify({file:${JSON.stringify(String(file))},page:!!${W}.document.querySelector('.ink-page'),status:${W}.document.getElementById('docStatus')?.textContent,hash:${W}.location.hash,view:${W}.eval('typeof viewKind==="undefined"?null:viewKind')})`));

  const calls = await run(`${W}.ChatteringInk.calls`);
  assert.ok(calls.some(c => c[0] === 'enabled' && c[1] === true), 'the app\'s pen is turned on in the frame: ' + JSON.stringify(calls));
  assert.ok(calls.some(c => c[0] === 'ratio' && c[1] > 0), 'the page says its pixel ratio');
  const region = calls.filter(c => c[0] === 'region').pop();
  const scroll = await run(`(()=>{const r=${W}.document.querySelector('.ink-scroll').getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})()`);
  assert.deepEqual(region.slice(1), [Math.round(scroll[0] + 43), Math.round(scroll[1] + 73), Math.round(scroll[2] + 43), Math.round(scroll[3] + 73)],
    'the writing area in the window\'s pixels (frame corner + border)');

  // A line from the app: window pixels, as InkOverlay packs them.
  const page = await run(`(()=>{const r=${W}.document.querySelector('.ink-page').getBoundingClientRect();return {x:r.left+43,y:r.top+73,w:r.width,h:r.height}})()`);
  const pts = Array.from({ length: 10 }, (_, i) => [page.x + page.w * (0.1 + 0.05 * i), page.y + page.h * 0.2, 0.12, i * 16]);
  const packed = pts.map(p => p.map((v, k) => k < 2 ? v.toFixed(1) : k === 2 ? v.toFixed(2) : String(v)).join(',')).join(' ');
  await run(`${W}.fileInkAcceptPacked(${JSON.stringify(packed)}, false)`);
  await until(`${W}.InkNotes.current.note.pages[0].strokes.length===1`, 'the line is on the page');
  await until(`${W}.ChatteringInk.drawn>0`, 'the page tells the app it shows the line');
  await until(`${W}.document.getElementById('docStatus').textContent==='Saved'`, 'saved');
  const s = F.parse(fs.readFileSync(file, 'utf8')).pages[0].strokes[0];
  assert.ok(Math.abs(s.pts[0] - 100) < 3 && Math.abs(s.pts[1] - 0.2 * F.PAGE_H) < 3,
    'the line starts where the pen was, not shifted by the frame: ' + s.pts.slice(0, 2));
  assert.equal(await run(`${W}.document.getElementById('inkPenMode')?.textContent || ''`).then(x => /older app/.test(x)), false,
    'a current app is not told to update');
});
