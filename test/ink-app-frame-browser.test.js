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
    setEnabled(on){calls.push(['enabled',on])},setRegion(l,t,r,b){calls.push(['region',l,t,r,b])},setPixelRatio(x){calls.push(['ratio',x])},setPen(id,tone,argb){calls.push(['pen',id,tone,argb])},
    setErase(){},setWidth(){},setPressureTypical(){},clearLive(){},clearAll(){},fastNib(){return true},strokeDrawn(){this.drawn++}};return 1})()`);
  const file = await run(`${W}.InkNotes.create('')`);
  await until(`!!${W}.document.querySelector('.ink-view .ink-page') && ${W}.document.getElementById('docStatus').textContent==='Saved'`, () => run(`JSON.stringify({file:${JSON.stringify(String(file))},page:!!${W}.document.querySelector('.ink-page'),status:${W}.document.getElementById('docStatus')?.textContent,hash:${W}.location.hash,view:${W}.eval('typeof viewKind==="undefined"?null:viewKind')})`));

  const calls = await run(`${W}.ChatteringInk.calls`);
  assert.ok(calls.some(c => c[0] === 'enabled' && c[1] === true), 'the app\'s pen is turned on in the frame: ' + JSON.stringify(calls));
  assert.ok(calls.some(c => c[0] === 'ratio' && c[1] > 0), 'the page says its pixel ratio');
  assert.deepEqual(calls.filter(c => c[0] === 'pen').pop().slice(0, 3), ['pen', 'ballpoint', 0], 'the app is told the pen in hand');
  // The pencil, from the second slot: the app's nib gets its grain.
  await run(`${W}.document.querySelector('[data-ink-slot="1"]').click()`);
  const pencil = (await run(`${W}.ChatteringInk.calls`)).filter(c => c[0] === 'pen').pop();
  assert.equal(pencil[1], 'pencil'); assert.ok(pencil[2] > 256, 'a grain tone: ' + pencil[2]);
  // A pop-up over the page hands the pen back to the page.
  await run(`${W}.document.querySelector('[data-ink-slot="1"]').click()`);
  assert.deepEqual((await run(`${W}.ChatteringInk.calls`)).filter(c => c[0] === 'enabled').pop(), ['enabled', false], 'the palette is open: the app does not take the pen');
  await run(`${W}.document.querySelector('[data-ink-slot="1"]').click()`);
  assert.deepEqual((await run(`${W}.ChatteringInk.calls`)).filter(c => c[0] === 'enabled').pop(), ['enabled', true], 'closed: the app takes it again');
  await run(`${W}.document.querySelector('[data-ink-slot="0"]').click()`);
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

// Anything of the page over the writing area is a hole in the app's layer:
// a pen landing there is the page's (a menu dropping from the side list
// drew a line instead of being tapped, on the AINOTE). And the lasso goes
// through the app's fast layer, its selection a hole.
test('the app leaves covered parts of the note to the page; the lasso is fast', { timeout: 180000 }, async t => {
  const b = await viewerBrowser(t);
  const { evaluate: run, until } = b;
  await until(`typeof InkNotes!=='undefined'`);
  const stub = precise => `(()=>{const calls=[];window.ChatteringInk={calls,drawn:0,live:0,
    setEnabled(on){calls.push(['enabled',on])},setRegion(l,t,r,b){calls.push(['region',l,t,r,b])},setPixelRatio(){},setPen(id,tone){calls.push(['pen',id,tone])},
    ${precise ? "setHoles(h){calls.push(['holes',h])}," : ''}
    setErase(){},setWidth(){},setPressureTypical(){},clearLive(){this.live++},clearAll(){},fastNib(){return true},strokeDrawn(){this.drawn++}};return 1})()`;
  await run(stub(true));
  const file = await run(`InkNotes.create('')`);
  await until(`!!document.querySelector('.ink-view .ink-page') && $('docStatus').textContent==='Saved'`);
  const last = kind => run(`(ChatteringInk.calls.filter(c=>c[0]==='${kind}').pop()||[])`);
  await until(`ChatteringInk.calls.some(c=>c[0]==='holes')`, 'the app is told what covers the note');
  assert.deepEqual(await last('holes'), ['holes', ''], 'nothing covers it yet');
  // A menu of the page dropping over the note (as the side list's do).
  await run(`(()=>{const m=document.createElement('div');m.id='fakeMenu';const r=document.querySelector('.ink-scroll').getBoundingClientRect();
    m.style.cssText='position:fixed;z-index:999;background:#fff;border:1px solid;left:'+(r.left+40)+'px;top:'+(r.top+60)+'px;width:200px;height:120px';document.body.appendChild(m);return 1})()`);
  await until(`(ChatteringInk.calls.filter(c=>c[0]==='holes').pop()||[])[1]!==''`, 'the menu is a hole');
  const hole = (await last('holes'))[1].split(';').map(q => q.split(',').map(Number));
  const menu = await run(`(()=>{const r=$('fakeMenu').getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})()`);
  const covers = hole.some(q => q[0] <= menu[0] + 1 && q[1] <= menu[1] + 1 && q[2] >= menu[2] - 1 && q[3] >= menu[3] - 1);
  assert.ok(covers, 'the hole covers the menu: ' + JSON.stringify({ hole, menu }));
  assert.ok(hole.every(q => (q[2] - q[0]) * (q[3] - q[1]) < 340 * 260), 'and not much more');
  await run(`$('fakeMenu').remove()`);
  await until(`(ChatteringInk.calls.filter(c=>c[0]==='holes').pop()||[])[1]===''`, 'closed: no hole');

  // The lasso: drawn by the app, dashed; its loop comes back marked as such.
  await run(`document.querySelector('[data-ink-tool=lasso]').click()`);
  assert.deepEqual(await last('pen'), ['pen', 'lasso', 0xa00], 'the app draws the loop dotted (dashed on an app without dots)');
  assert.deepEqual(await last('enabled'), ['enabled', true], 'the app keeps the pen in Select');
  await run(`(()=>{const n=InkNotes.current.note;n.pages[0].strokes.push({pts:[200,200,.5,260,205,.5,320,200,.5],w:2.6,t0:1,dur:1,color:''});return 1})()`);
  const page = await run(`(()=>{const r=document.querySelector('.ink-page').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})()`);
  const k = page.w / 1000;
  const loop = Array.from({ length: 20 }, (_, i) => { const a = i / 19 * Math.PI * 2; return [page.x + (260 + 120 * Math.cos(a)) * k, page.y + (202 + 40 * Math.sin(a)) * k]; });
  await run(`fileInkAcceptPacked(${JSON.stringify(loop.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1) + ',0.5,0').join(' '))}, false, 'lasso')`);
  await until(`InkNotes.current.sel && InkNotes.current.sel.list.length===1`, 'the app\'s loop selects');
  assert.equal(await run(`InkNotes.current.note.pages[0].strokes.length`), 1, 'a loop is not ink');
  assert.ok(await run(`ChatteringInk.live`) > 0, 'the dashed loop is wiped from the panel');
  await until(`(ChatteringInk.calls.filter(c=>c[0]==='holes').pop()||[])[1]!==''`, 'the selection and its buttons are holes');
  const selHoles = (await last('holes'))[1].split(';').map(q => q.split(',').map(Number));
  const bar = await run(`(()=>{const r=document.querySelector('.ink-sel-bar').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
  assert.ok(selHoles.some(q => bar[0] >= q[0] && bar[0] <= q[2] && bar[1] >= q[1] && bar[1] <= q[3]), 'the buttons are the page\'s');
  // A tap (a one-point loop) lets go.
  await run(`fileInkAcceptPacked(${JSON.stringify((page.x + 700 * k).toFixed(1) + ',' + (page.y + 900 * k).toFixed(1) + ',0.5,0')}, false, 'lasso')`);
  assert.equal(await run(`!!InkNotes.current.sel`), false);
  assert.deepEqual(b.exceptions, []);
  void file;
});

test('an app without holes gives the page the pen while something covers the note', { timeout: 120000 }, async t => {
  const b = await viewerBrowser(t);
  const { evaluate: run, until } = b;
  await until(`typeof InkNotes!=='undefined'`);
  await run(`(()=>{const calls=[];window.ChatteringInk={calls,setEnabled(on){calls.push(['enabled',on])},setRegion(){},setPixelRatio(){},setPen(){},setErase(){},setWidth(){},setPressureTypical(){},clearLive(){},clearAll(){},fastNib(){return true},strokeDrawn(){}};return 1})()`);
  await run(`InkNotes.create('')`);
  await until(`!!document.querySelector('.ink-view .ink-page') && $('docStatus').textContent==='Saved'`);
  const enabled = `(ChatteringInk.calls.filter(c=>c[0]==='enabled').pop()||[])[1]`;
  await until(`${enabled}===true`);
  await run(`(()=>{const m=document.createElement('div');m.id='fakeMenu';const r=document.querySelector('.ink-scroll').getBoundingClientRect();
    m.style.cssText='position:fixed;z-index:999;background:#fff;left:'+(r.left+40)+'px;top:'+(r.top+60)+'px;width:200px;height:120px';document.body.appendChild(m);return 1})()`);
  await until(`${enabled}===false`, 'covered: the page has the pen');
  await run(`$('fakeMenu').remove()`);
  await until(`${enabled}===true`, 'uncovered: the app again');
  await run(`document.querySelector('[data-ink-tool=lasso]').click()`);
  assert.equal(await run(enabled), false, 'the lasso stays the page\'s on that app');
});

// The real case: the side list's ⋯ menu on a conversation, opened while a
// note is on screen, hangs over the note: it must be the page's to tap.
test('a side list menu over the note is a hole', { timeout: 120000 }, async t => {
  const b = await viewerBrowser(t);
  const { evaluate: run, until, size } = b;
  await until(`typeof InkNotes!=='undefined'`);
  await size(960, 1280);
  await run(`(()=>{const calls=[];window.ChatteringInk={calls,setEnabled(on){calls.push(['enabled',on])},setRegion(){},setPixelRatio(){},setPen(){},setHoles(h){calls.push(['holes',h])},setErase(){},setWidth(){},setPressureTypical(){},clearLive(){},clearAll(){},fastNib(){return true},strokeDrawn(){}};return 1})()`);
  // The conversation in the side list, then a note.
  await run(`location.hash='#pi:fixture/media.jsonl'`);
  await until(`!!document.querySelector('.ag-more')`, 'the conversation is in the side list');
  await run(`InkNotes.create('')`);
  await until(`!!document.querySelector('.ink-view .ink-page') && $('docStatus').textContent==='Saved'`);
  const holes = `(ChatteringInk.calls.filter(c=>c[0]==='holes').pop()||[])[1]`;
  await until(`${holes}===''`);
  await run(`document.querySelector('.ag-more').click()`);
  const menu = await run(`new Promise(r=>setTimeout(()=>{const m=[...document.querySelectorAll('[role=menu],.mpick,.ag-menu,.side-menu')].find(e=>e.getBoundingClientRect().width>0);if(!m)return r(null);const q=m.getBoundingClientRect();r({cls:m.className,box:[q.left,q.top,q.right,q.bottom]})},300))`);
  assert.ok(menu, 'the menu opened');
  const area = await run(`(()=>{const r=document.querySelector('.ink-scroll').getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})()`);
  if (menu.box[2] <= area[0]) { t.diagnostic('the menu stays in the side list here: ' + JSON.stringify({ menu, area })); return; }
  await until(`${holes}!==''`, 'the menu over the note is a hole');
  const hs = (await run(holes)).split(';').map(q => q.split(',').map(Number));
  const over = [Math.max(menu.box[0], area[0]), Math.max(menu.box[1], area[1]), Math.min(menu.box[2], area[2]), Math.min(menu.box[3], area[3])];
  assert.ok(hs.some(q => q[0] <= over[0] + 1 && q[1] <= over[1] + 1 && q[2] >= over[2] - 1 && q[3] >= over[3] - 1), 'covering where it overlaps: ' + JSON.stringify({ hs, over }));
  await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await run(`document.body.click()`);
  await until(`${holes}===''`, 'closed: the app has the whole note again');
});
