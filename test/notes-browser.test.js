'use strict';
// A note by pen or by keyboard (design/103), in a real browser against a
// real server, with real key presses and pen events: the note opens as the
// device suits, the first mark decides its kind, nothing typed or written
// is ever lost on the way, and typed text lives on a page beside the ink.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { viewerBrowser } = require('./helpers/viewer-browser');
const F = require('../ink-format.js');

test('notes: the first mark decides, typed text on a page, nothing lost', { timeout: 240000 }, async t => {
  const b = await viewerBrowser(t);
  const { evaluate: run, until, command } = b;
  await until(`typeof Notes!=='undefined' && typeof InkNotes!=='undefined' && !!$('sideInk')`);

  // Real key presses (the browser types them where the focus is).
  const key = async (ch, mods = {}) => {
    const named = { Escape: 27, Enter: 13, Backspace: 8, Delete: 46 };
    const up = ch.length === 1 ? ch.toUpperCase() : ch;
    const code = named[ch] ? ch : /[a-z]/i.test(ch) ? 'Key' + up : ch === ' ' ? 'Space' : /\d/.test(ch) ? 'Digit' + ch : '';
    const vk = named[ch] || (ch === ' ' ? 32 : up.charCodeAt(0));
    const modifiers = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.shift ? 8 : 0);
    const text = ch.length === 1 && !mods.alt && !mods.ctrl ? ch : undefined;
    await command('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: ch, code, text, unmodifiedText: text, windowsVirtualKeyCode: vk, modifiers });
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk, modifiers });
  };
  const type = async str => { for (const ch of str) await key(ch); };
  const pen = async (points, { type: kind = 'pen' } = {}) => {
    const [x0, y0] = points[0];
    const ev = (k, x, y, force) => command('Input.dispatchMouseEvent', { type: k, x, y, button: 'left', buttons: k === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: kind, force });
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, pointerType: kind });
    await ev('mousePressed', x0, y0, 0.4);
    for (const [x, y] of points.slice(1)) await ev('mouseMoved', x, y, 0.6);
    const [xn, yn] = points[points.length - 1];
    await ev('mouseReleased', xn, yn, 0);
  };
  // A tap: down, a person's moment, up (a 1 ms touch is the digitiser's, not a dot).
  const tap = async ([x, y], kind = 'pen') => {
    const ev = (k, buttons) => command('Input.dispatchMouseEvent', { type: k, x, y, button: 'left', buttons, clickCount: 1, pointerType: kind, force: 0.4 });
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: kind });
    await ev('mousePressed', 1);
    await new Promise(r => setTimeout(r, 70));
    await ev('mouseReleased', 0);
  };
  const pageBox = () => run(`(()=>{const r=document.querySelector('.ink-page').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})()`);
  const strokes = `InkNotes.current.note.pages.reduce((n,p)=>n+p.strokes.length,0)`;
  const texts = `InkNotes.current.note.pages.flatMap(p=>p.texts.map(b=>b.text))`;
  const saved = `$('docStatus').textContent==='Saved'`;
  // A typed note is shared (one text for every device): the disk follows it.
  const onDisk = async (file, want) => {
    for (let i = 0; i < 100; i++) { try { if (fs.readFileSync(file, 'utf8') === want) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
    assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '(no file)', want);
  };

  // ---- a device that has never seen a pen: the note opens typed ----
  assert.equal(await run(`$('sideInk').hidden`), false, 'the ✎ is there on every device');
  await run(`$('sideInk').click()`);
  await until(`typeof docState!=='undefined' && docState && /\\/notes\\/[^/]+\\.md$/.test(docState.path) && !!document.querySelector('.note-kind-bar:not([hidden])')`, 'a typed note opens, saying the other way in');
  const typedPath = await run(`docState.path`);
  await b.screenshot('note-typed-empty.png');
  assert.match(path.basename(typedPath), /^\d{4}-\d\d-\d\d-\d{4}\.md$/);
  assert.equal(path.basename(path.dirname(typedPath)), 'notes');
  await until(`document.activeElement && !!document.activeElement.closest('.cm-editor')`, 'its editor has the keyboard');
  await type('Milk, eggs');
  await until(`document.querySelector('.note-kind-bar').hidden`, 'once typed in, it is a typed note: the other way in goes');
  await onDisk(typedPath, 'Milk, eggs');

  // ---- an empty typed note → a page (the button; a pen does the same) ----
  await run(`Notes.create('', {kind:'text'})`);
  await until(`docState && docState.path!==${JSON.stringify(typedPath)} && /\\.md$/.test(docState.path) && !!document.querySelector('.note-kind-bar:not([hidden])')`);
  const emptyTyped = await run(`docState.path`);
  const historyBefore = await run(`history.length`);
  await run(`document.querySelector('.note-kind-ink').click()`);
  await until(`!!InkNotes.current && !!InkNotes.current.note && /\\.ink\\.svg$/.test(InkNotes.current.ws.path)`, 'it becomes a page');
  const fromTyped = await run(`InkNotes.current.ws.path`);
  assert.match(await run(`InkNotes.current.note.title`), /^Note · /, 'the page has a note\'s name');
  const stamp = f => path.basename(f).slice(0, 15);
  assert.equal(stamp(fromTyped), stamp(emptyTyped), 'the same stamp (the first free name with it)');
  assert.equal(fs.existsSync(emptyTyped), false, 'the empty typed note went');
  assert.equal(await run(`OpenFiles.isKept(${JSON.stringify(fromTyped)}) && !OpenFiles.isKept(${JSON.stringify(emptyTyped)})`), true, 'the side list follows');
  assert.equal(await run(`history.length`), historyBefore, 'the history entry was replaced: Back never leads to the file that went');
  assert.equal(await run(`decodeURIComponent(location.hash).endsWith(${JSON.stringify(fromTyped)})`), true);

  // A pen on an empty typed note does the same as the button.
  await run(`Notes.create('', {kind:'text'})`);
  await until(`docState && /\.md$/.test(docState.path) && !!document.querySelector('.note-kind-bar:not([hidden])')`);
  const penTyped = await run(`docState.path`);
  const ed = await run(`(()=>{const r=document.querySelector('.cm-content').getBoundingClientRect();return [r.left+40,r.top+20]})()`);
  await tap(ed, 'pen');
  await until(`!!InkNotes.current && /\.ink\.svg$/.test(InkNotes.current.ws.path) && InkNotes.current.ws.path.includes(${JSON.stringify(path.basename(penTyped).slice(0, 15))})`, 'a pen on it: a page');
  assert.equal(fs.existsSync(penTyped), false);
  await run(`localStorage.removeItem('chattering.ink.pen')`); // (the pen was seen; the steps below are a keyboard's)
  await run(`InkNotes.current.ws && openLiveFile(${JSON.stringify(fromTyped)}, {})`);
  await until(`!!InkNotes.current && InkNotes.current.ws.path===${JSON.stringify(fromTyped)} && !!InkNotes.current.note`);

  // ---- an empty page → a typed note, by typing: every key lands ----
  await until(`!!document.querySelector('.ink-empty') && !$('inkTypeNote').hidden`, 'an empty page says both ways in');
  await b.screenshot('note-page-empty.png');
  await run(`document.querySelector('.ink-scroll').focus()`);
  await type('Hello there');
  await until(`typeof docState!=='undefined' && docState && /\.md$/.test(docState.path) && docState.path.includes(${JSON.stringify(stamp(fromTyped))}) && !document.querySelector('.ink-bridge')`, 'the page became a typed note');
  const typedAgain = await run(`docState.path`);
  await type(', friend');
  await until(`docState.editor.getContent()==='Hello there, friend'`, () => run(`JSON.stringify(docState.editor.getContent())`));
  assert.equal(await run(`docState.editor.view.state.selection.main.head`), 'Hello there, friend'.length, 'the caret is where the typing was');
  assert.equal(fs.existsSync(fromTyped), false, 'the empty page went');
  await onDisk(typedAgain, 'Hello there, friend');

  // ---- a page with writing: typed text goes on the page ----
  const file = await run(`InkNotes.create('')`);
  await until(`!!InkNotes.current && InkNotes.current.ws.path===${JSON.stringify(file)} && ${saved}`);
  let box = await pageBox();
  const at = (fx, fy) => [box.x + box.w * fx, box.y + box.h * fy];
  const line = (fx0, fy, fx1, n = 10) => Array.from({ length: n }, (_, i) => at(fx0 + (fx1 - fx0) * i / (n - 1), fy + Math.sin(i) * 0.004));
  await pen(line(0.1, 0.1, 0.5));
  await until(`${strokes}===1 && !document.querySelector('.ink-empty') && $('inkTypeNote').hidden`, 'the first line: the page chose, the hint and its button go');
  assert.equal(await run(`$('sideInk').hidden`), false);
  // A tap with the pen, then keys: the text goes where the tap was, and the tap's dot gives way.
  await tap(at(0.3, 0.3));
  await until(`${strokes}===2 && !InkNotes.current.pending`);
  await run(`new Promise(r=>setTimeout(r,60))`);
  await run(`document.querySelector('.ink-scroll').focus()`);
  await type('Call Ana');
  await until(`!!InkNotes.current.edit && InkNotes.current.edit.ta.value==='Call Ana' && ${strokes}===1`, () => run(`JSON.stringify({edit:!!InkNotes.current.edit,v:InkNotes.current.edit&&InkNotes.current.edit.ta.value,n:${strokes},active:document.activeElement.className})`));
  await b.screenshot('note-typing-on-page.png');
  // Saved while typing, before the text is finished.
  await until(`${saved}`);
  let note = F.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(note.pages[0].texts.map(x => x.text), ['Call Ana'], 'kept while typing');
  assert.equal(note.pages[0].strokes.length, 1, 'the dot is gone from the file too');
  const placed = note.pages[0].texts[0];
  assert.ok(Math.abs(placed.x - 300) < 4, 'at the tap: ' + placed.x);
  assert.equal((placed.y + 5 - 98) % 44, 0, 'on a ruling line: ' + placed.y);
  await key('Escape');
  await until(`!InkNotes.current.edit && JSON.stringify(${texts})==='["Call Ana"]'`);
  assert.equal(await run(`document.querySelector('.ink-typed text').textContent`), 'Call Ana', 'drawn on the page, as the file has it');
  // Letters are never tools: e types an e (it does not take the eraser).
  await run(`document.querySelector('.ink-scroll').focus()`);
  await type('e then more');
  await until(`!!InkNotes.current.edit && InkNotes.current.edit.ta.value==='e then more'`);
  assert.equal(await run(`InkNotes.current.tool`), 'pen');
  await key('Escape');
  await until(`!InkNotes.current.edit && ${texts}.length===2`);
  const under = await run(`(()=>{const p=InkNotes.current.note.pages[0];return {y:p.texts[1].y,x:p.texts[1].x}})()`);
  assert.ok(under.y === placed.y + 44 && under.x === 60, 'no tap: on the next line under the writing, at the margin: ' + JSON.stringify(under));
  // One undo takes the text away; redo brings it back.
  await run(`$('inkUndo').click()`);
  assert.equal(await run(`${texts}.length`), 1);
  await run(`$('inkRedo').click()`);
  assert.equal(await run(`${texts}.length`), 2);

  // Text pasted on the page is typed text, where typing would go.
  await run(`(()=>{const d=new DataTransfer();d.setData('text/plain','pasted words');document.querySelector('.ink-scroll').dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));return 1})()`);
  await until(`!!InkNotes.current.edit && InkNotes.current.edit.ta.value==='pasted words'`);
  await key('Escape');
  await until(`!InkNotes.current.edit && ${texts}.includes('pasted words')`);
  await run(`$('inkUndo').click()`);
  assert.equal(await run(`${texts}.length`), 2);

  // Tools are on Alt: Alt+T is Text; a tap on a typed text changes it.
  await key('t', { alt: true });
  assert.equal(await run(`InkNotes.current.tool`), 'text');
  const textBox = await run(`(()=>{const r=document.querySelector('.ink-typed text').getBoundingClientRect();return {x:r.left+r.width-2,y:r.top+r.height/2}})()`);
  await tap([textBox.x, textBox.y], 'mouse');
  await until(`!!InkNotes.current.edit && InkNotes.current.edit.ta.value==='Call Ana'`, 'the tapped text opens to change');
  await type(' at 5');
  // A click away ends it, and draws nothing.
  await tap(at(0.8, 0.8), 'mouse');
  await until(`!InkNotes.current.edit && ${texts}.includes('Call Ana at 5')`);
  assert.equal(await run(strokes), 1, 'the click away drew nothing');
  assert.equal(await run(`InkNotes.current.note.pages[0].texts.filter(b=>b.id===${JSON.stringify(placed.id)}).length`), 1, 'the same block, changed: one copy');
  // Keyboard only: Tab to a text, Delete removes it, undo brings it back.
  await run(`document.querySelector('.ink-typed text').focus()`);
  await key('Delete');
  assert.equal(await run(`${texts}.length`), 1);
  await key('z', { ctrl: true });
  assert.equal(await run(`${texts}.length`), 2);

  // The eraser takes a text whole, as a line.
  await key('e', { alt: true });
  assert.equal(await run(`InkNotes.current.tool`), 'eraser');
  const eb = await run(`(()=>{const r=document.querySelector('.ink-typed text').getBoundingClientRect();return {x:r.left+4,y:r.top+r.height/2}})()`);
  await pen([[eb.x, eb.y], [eb.x + 10, eb.y]]);
  await until(`${texts}.length===1`);
  await run(`$('inkUndo').click()`);
  assert.equal(await run(`${texts}.length`), 2);

  // Select circles text and lines; a drag moves them together.
  await key('s', { alt: true });
  assert.equal(await run(`InkNotes.current.tool`), 'lasso');
  await run(`document.querySelector('.ink-scroll').scrollTop=0`);
  box = await pageBox();
  const corners = [[0.03, 0.03], [0.9, 0.03], [0.9, 0.42], [0.03, 0.42], [0.03, 0.03]];
  const loop = corners.flatMap(([fx, fy], k) => k ? Array.from({ length: 6 }, (_, j) => at(corners[k - 1][0] + (fx - corners[k - 1][0]) * (j + 1) / 6, corners[k - 1][1] + (fy - corners[k - 1][1]) * (j + 1) / 6)) : [at(fx, fy)]);
  await pen(loop);
  await until(`!!InkNotes.current.sel && InkNotes.current.sel.tlist.length===2 && InkNotes.current.sel.list.length===1`, () => run(`JSON.stringify(InkNotes.current.sel&&{t:InkNotes.current.sel.tlist.length,s:InkNotes.current.sel.list.length})`));
  const before = await run(`InkNotes.current.note.pages[0].texts.map(b=>b.y)`);
  const mid = at(0.3, 0.1);
  await pen([mid, [mid[0], mid[1] + 40], [mid[0], mid[1] + 80]]);
  await until(`(()=>{const y=InkNotes.current.note.pages[0].texts.map(b=>b.y);return y[0]>${before[0]}+20})()`, 'moved down');
  await until(saved);
  note = F.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(note.pages[0].texts.length, 2);
  assert.ok(note.pages[0].texts.every((t2, k) => t2.y > before[k] + 20), 'the file has them moved');

  await run(`InkNotes.current.sel && document.querySelector('[data-sel=done]').click()`);
  await b.screenshot('note-text-and-ink.png');
  // Reopened: the typed text is there as it was.
  fs.writeFileSync(path.join(path.dirname(file), 'other.txt'), 'x');
  await run(`openLiveFile(${JSON.stringify(path.join(path.dirname(file), 'other.txt'))}, {})`);
  await until(`!document.querySelector('.ink-view')`);
  await run(`openLiveFile(${JSON.stringify(file)}, {})`);
  await until(`!!InkNotes.current && !!InkNotes.current.note && document.querySelectorAll('.ink-typed text').length===2`);

  // A device with a pen: the next note is a page. The help says the keys.
  await run(`$('sideInk').click()`);
  await until(`!!InkNotes.current && InkNotes.current.ws.path!==${JSON.stringify(file)} && !!document.querySelector('.ink-empty')`, 'a pen was used here: a page');
  assert.equal(await run(`fileEditorHelp({inEditor:false})[0].label`), 'note page');
  // N makes a note from anywhere (not while typing).
  await run(`goHome()`);
  await until(`viewKind==='home'`);
  const before2 = await run(`InkNotes.current ? InkNotes.current.ws.path : ''`);
  await key('N', { shift: true });
  await until(`viewKind==='file' && !!InkNotes.current && InkNotes.current.ws.path!==${JSON.stringify(before2)}`, 'N: a new note');
  // "Type instead" (the toolbar, for a keyboard on screen): the same as typing.
  await until(`!!InkNotes.current.note && !$('inkTypeNote').hidden`);
  const nPage = await run(`InkNotes.current.ws.path`);
  await run(`$('inkTypeNote').click()`);
  await until(`document.activeElement && document.activeElement.classList.contains('ink-bridge') || (typeof docState!=='undefined' && docState && /\.md$/.test(docState.path))`);
  await type('ok');
  await until(`typeof docState!=='undefined' && docState && docState.path.includes(${JSON.stringify(path.basename(nPage).slice(0, 15))}) && /\.md$/.test(docState.path) && docState.editor.getContent()==='ok'`, () => run(`JSON.stringify({p:typeof docState!=='undefined'&&docState&&docState.path,c:typeof docState!=='undefined'&&docState&&docState.editor.getContent()})`));
  // Typed into at once, while the side list's "keep" of the page is still on
  // its way to the server: the page that went is not left listed.
  await run(`(()=>{const f=window.fetch;window.fetch=(u,o)=>String(u).includes('/api/open-files')&&o&&o.method==='POST'?new Promise(r=>setTimeout(r,600)).then(()=>f(u,o)):f(u,o);return 1})()`);
  const quick = await run(`InkNotes.create('')`);
  await until(`!!InkNotes.current && InkNotes.current.ws.path===${JSON.stringify(quick)} && !!InkNotes.current.note`);
  await run(`new Promise(r=>setTimeout(r,250))`);
  await run(`document.querySelector('.ink-scroll').focus()`);
  await type('q');
  await until(`typeof docState!=='undefined' && docState && /\.md$/.test(docState.path) && docState.path.includes(${JSON.stringify(path.basename(quick).slice(0, 15))}) && docState.editor.getContent()==='q'`);
  const quickMd = await run(`docState.path`);
  await run(`new Promise(r=>setTimeout(r,2500))`);
  const listed = await run(`fetch('/api/open-files').then(r=>r.json()).then(j=>j.files.map(f=>f.path))`);
  assert.equal(listed.includes(quick), false, 'the page that went is not listed');
  assert.equal(listed.includes(quickMd), true, 'the typed note is');
  await run(`document.documentElement.dataset.themeMode='binary'`);
  await b.size(1404, 1872, true);
  await b.screenshot('note-empty-eink.png');
  await run(`delete document.documentElement.dataset.themeMode`);
  assert.deepEqual(b.exceptions, []);
});
