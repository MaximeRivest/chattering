'use strict';
// The frog's spells, the page (design/94), in a real browser with a pretend
// host that records what the page says: the frog appears and says where the
// pointer may land, the menu asks for the keys and casts by letter, an
// answer that corrects is shown as changes and one that rewrites as text
// (and a long one stays inside its panel: the bug of the first demo), Enter
// replaces, the judge is sent, a problem is said, the theme follows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromiumBinary } = require('./helpers/chromium.js');

const PAGE = 'file://' + path.join(__dirname, '..', 'overlay', 'spells.html');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function browser(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spells-page-'));
  const port = 9200 + Math.floor(Math.random() * 600);
  const child = spawn(chromiumBinary(), ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
  t.after(async () => { child.kill(); await sleep(300); fs.rmSync(dir, { recursive: true, force: true }); });
  let targets;
  for (let i = 0; i < 80; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.some(x => x.type === 'page')) break; } catch {} await sleep(150); }
  const ws = new WebSocket(targets.find(x => x.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  t.after(() => ws.close());
  let id = 0; const pending = new Map(), errors = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async e => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description); return r.result.result.value; };
  const until = async (e, what) => { for (let i = 0; i < 100; i++) { if (await ev(`!!(${e})`).catch(() => false)) return; await sleep(50); } throw new Error('timed out: ' + what); };
  const key = async (k, code) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code || k, text: k.length === 1 ? k : undefined }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code || k }); };
  const click = async sel => {
    const [x, y] = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  const shot = async file => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.result.data, 'base64')); };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__out = []; window.spellsHost = m => window.__out.push(m);' });
  await send('Page.navigate', { url: PAGE });
  await until(`window.Spells && window.__out.some(m => m.type === 'ready')`, 'the page ready');
  return { ev, until, key, click, shot, errors, out: async type => ev(`window.__out.filter(m => m.type === ${JSON.stringify(type)})`) };
}

const SPELLS = [
  { id: 'aaaaaa', label: 'Fix spelling and grammar', letter: 'G', icon: 'fix', output: 'replace', program: 'fix_writing' },
  { id: 'bbbbbb', label: 'Make it shorter', letter: 'S', icon: 'shorter', output: 'replace', program: 'shorter' },
  { id: 'cccccc', label: 'Explain this', letter: 'Y', icon: 'explain', output: 'notify', program: 'explain_text' },
];
const show = extra => JSON.stringify({ type: 'show', monitor: 'DP-1', at: { x: 640, y: 300 }, words: 64, app: 'Mail', spells: SPELLS, model: 'openai-codex/gpt-6-luna', theme: { id: 'rockfrog' }, systemDark: false, linger: 60000, ...extra });

test('the frog, its book, a correction and a rewrite, in a browser', { timeout: 60000 }, async t => {
  const b = await browser(t);
  const shots = process.env.SPELLS_SHOTS;

  // It appears where it is told, and says where the pointer may land.
  await b.ev(`Spells.receive(${JSON.stringify(show())})`);
  await b.until(`document.querySelector('.frog')`, 'the frog');
  await new Promise(r => setTimeout(r, 700)); // landed from its hop
  const f = await b.ev(`(() => { const r = document.querySelector('.frog').getBoundingClientRect(); return [r.left, r.bottom]; })()`);
  assert.ok(f[0] >= 640 && f[0] < 700 && Math.abs(f[1] - 308) < 4, 'beside the end of the selection, feet on its line: ' + f);
  await b.until(`window.__out.filter(m => m.type === 'rects').pop()?.rects.length === 1`, 'one place to click: the frog');
  assert.equal(await b.ev(`(() => { const f = document.querySelector('.frog'); return [...f.querySelectorAll('*')].some(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible'); })()`), false, 'no scrollbar anywhere in the frog');
  assert.equal((await b.out('keyboard')).length, 0, 'the frog alone never asks for the keys');

  // The book: the keys, the spells with their letters, the model.
  await b.click('.frog');
  await b.until(`document.querySelector('.panel.menu')`, 'the menu');
  assert.deepEqual((await b.out('keyboard')).map(m => m.on), [true]);
  assert.match(await b.ev(`document.querySelector('.menu').innerText`), /Chattering[\s\S]*64 words in Mail[\s\S]*gpt-6-luna[\s\S]*Fix spelling and grammar[\s\S]*G[\s\S]*Make it shorter/);
  await b.until(`window.__out.filter(m => m.type === 'rects').pop()?.rects.length === 2`, 'the frog and the menu take the pointer');
  if (shots) await b.shot(path.join(shots, 'menu-light.png'));

  // A letter casts; the frog works.
  await b.key('s', 'KeyS');
  await b.until(`window.__out.some(m => m.type === 'cast' && m.id === 'bbbbbb')`, 'cast by its letter');
  assert.equal((await b.out('keyboard')).pop().on, false, 'the keys go back while it works');
  assert.ok(await b.ev(`!!document.querySelector('.pill') && document.querySelector('.frog').classList.contains('busy')`));

  // A rewrite (the screenshot's case): shown as the new text, inside its panel.
  const before = 'went to the store yesterday and buyed three apple, its was realy good. their going to the meeting tomorow, can you send me the agenda before\n\nJe vais être en retard ce matin, le métro est encore en panne. On se voit vers 10h?\n\nThe Bank of Canada held its policy rate at 2.25 per cent, citing slowing inflation and a softer labour market.';
  await b.ev(`Spells.receive(${JSON.stringify(JSON.stringify({ type: 'answer', kind: 'replace', label: 'Make it shorter', before, text: 'Went to the store; the apples were good. Running late; see you around 10. The Bank of Canada held its rate at 2.25%.', program: 'shorter', version: 'v1', model: 'openai-codex/gpt-6-luna', secs: 1.4, call: 'call1' }))})`);
  await b.until(`document.querySelector('.panel.answer')`, 'the answer');
  assert.equal(await b.ev(`document.querySelectorAll('.answer del').length`), 0, 'a rewrite is not a wall of struck words');
  assert.equal(await b.ev(`document.querySelector('[data-view]').textContent`), 'show changes');
  await b.click('[data-view]');
  const fits = await b.ev(`(() => { const p = document.querySelector('.answer'), body = p.querySelector('.body'); const r = p.getBoundingClientRect();
    const outside = [...body.querySelectorAll('del, ins')].some(e => [...e.getClientRects()].some(x => x.right > r.right + 1 || x.left < r.left - 1));
    return { outside, wide: body.scrollWidth > body.clientWidth + 1, onScreen: r.right <= innerWidth && r.bottom <= innerHeight && r.left >= 0 && r.top >= 0 }; })()`);
  assert.deepEqual(fits, { outside: false, wide: false, onScreen: true }, 'even shown as changes, every word stays inside the panel');
  if (shots) await b.shot(path.join(shots, 'rewrite-changes.png'));

  // Judge it; Enter replaces.
  await b.click('[data-j="right"]');
  assert.deepEqual((await b.out('judge')).pop(), { type: 'judge', call: 'call1', verdict: 'right' });
  await b.key('Enter');
  await b.until(`window.__out.some(m => m.type === 'replace')`, 'replace');
  await b.ev(`Spells.receive(${JSON.stringify(JSON.stringify({ type: 'done', html: '✓ Replaced', ms: 300 }))})`);
  await b.until(`window.__out.some(m => m.type === 'hidden')`, 'it hops away after');

  // A correction: shown as its changes.
  await b.ev(`window.__out.length = 0; Spells.receive(${JSON.stringify(show())})`);
  await b.until(`document.querySelector('.frog') && !document.querySelector('.frog').classList.contains('leave')`, 'back');
  await b.ev(`Spells.receive(${JSON.stringify(JSON.stringify({ type: 'open' }))})`);
  await b.until(`document.querySelector('.panel.menu')`, 'the menu again');
  await b.click('.row[data-i="0"]');
  await b.ev(`Spells.receive(${JSON.stringify(JSON.stringify({ type: 'answer', kind: 'replace', label: 'Fix spelling and grammar', before: 'i has went to the store and buyed three apple', text: 'I went to the store and bought three apples', program: 'fix_writing', version: 'v2', model: 'openai-codex/gpt-6-luna', secs: 1.1, call: 'call2' }))})`);
  await b.until(`document.querySelector('.answer del')`, 'the changes');
  assert.equal(await b.ev(`[...document.querySelectorAll('.answer del')].map(e => e.textContent).join('|')`), 'i has|buyed|apple');
  assert.equal(await b.ev(`[...document.querySelectorAll('.answer ins')].map(e => e.textContent).join('|')`), 'I|bought|apples');
  assert.match(await b.ev(`document.querySelector('.runline').textContent`), /fix_writing · v2 · openai-codex\/gpt-6-luna · 1.1 s/);
  if (shots) await b.shot(path.join(shots, 'correction-light.png'));

  // Esc closes the answer and gives the keys back; nothing replaced.
  const replaces = (await b.out('replace')).length;
  await b.key('Escape');
  await b.until(`!document.querySelector('.panel')`, 'closed');
  assert.equal((await b.out('replace')).length, replaces);
  assert.equal((await b.out('keyboard')).pop().on, false);

  // The ask line: Tab, typing (the letters do not cast), Enter.
  await b.click('.frog');
  await b.until(`document.querySelector('.panel.menu')`, 'menu');
  await b.key('Tab');
  await b.until(`document.activeElement && document.activeElement.id === 'ask'`, 'the ask line has the keys');
  for (const ch of 'make it formal') await b.key(ch, ch === ' ' ? 'Space' : 'Key' + ch.toUpperCase());
  assert.equal((await b.out('cast')).length, 1, 'letters typed into the ask line cast nothing');
  await b.key('Enter');
  await b.until(`window.__out.some(m => m.type === 'ask' && m.request === 'make it formal')`, 'asked');

  // A problem, said plainly.
  await b.ev(`Spells.receive(${JSON.stringify(JSON.stringify({ type: 'problem', title: '“make it formal”', message: 'The model is paused after repeated failures; try again in a minute.' }))})`);
  await b.until(`document.querySelector('.problem')`, 'the problem');
  assert.match(await b.ev(`document.querySelector('.problem').innerText`), /paused after repeated failures/);

  // Dark: the theme follows the desktop.
  await b.ev(`Spells.receive(${JSON.stringify(JSON.stringify({ type: 'theme', theme: { id: 'rockfrog' }, systemDark: true }))})`);
  assert.equal(await b.ev(`document.documentElement.dataset.theme`), 'rockfrog-dark');
  assert.equal(await b.ev(`getComputedStyle(document.querySelector('.panel')).backgroundColor`), 'rgb(26, 31, 27)', 'Rockfrog dark’s surface');
  if (shots) await b.shot(path.join(shots, 'problem-dark.png'));
  assert.deepEqual(b.errors, []);
});
