'use strict';
// The frog's controller (design/94) with a pretend desktop, host and
// Chattering: when it appears and where, what it stays away from, a spell
// cast and its answer, a free question, the safe replace (pasted only over
// the same selection, else the clipboard), judging, and a hotkey press
// sending it away.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFrog, appName } = require('../hotkeys-device.js');

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

function world({ focused = { id: 'w1', app: 'org.mozilla.thunderbird', terminal: false }, pointer = { x: 900, y: 420 }, selectionNow = null } = {}) {
  const did = [], sent = [];
  let pageHandler = null;
  const desk = {
    async focused() { return world.focus; },
    async pointer() { return pointer; },
    async monitors() { return [{ name: 'DP-1', x: 0, y: 0, w: 1920, h: 1080, focused: true }, { name: 'HDMI-A-1', x: 1920, y: 0, w: 1920, h: 1080 }]; },
    async windowRect() { return { x: 100, y: 80, w: 1200, h: 800 }; },
    async windowRects() { const r = { x: 100, y: 80, w: 1200, h: 800 }; return { w1: r, w2: r, other: r }; },
    async selection() { return world.selectionNow; },
    async primaryText() { return world.primary || ''; },
    async setClipboard(t) { did.push(['clipboard', t]); },
    async paste(w, t) { did.push(['paste', w.id, t]); },
    async focus(w) { did.push(['focus', w.id]); },
  };
  world.focus = focused;
  world.selectionNow = selectionNow;
  const listeners = new Set();
  const helper = {
    link: { server: 'http://x', credential: 'chk_x' },
    spells: [{ id: 'aaaaaa', label: 'Fix spelling and grammar', letter: 'G', icon: 'fix', output: 'replace', program: 'fix_writing' },
      { id: 'cccccc', label: 'Explain this', letter: 'Y', icon: 'explain', output: 'notify', program: 'explain_text' }],
    frog: { on: true, skip: ['terminal'], minWords: 2, theme: { id: 'rockfrog' }, askModel: 'openai-codex/gpt-6-luna' },
    busy: false, frogStatus: null,
    onChange(f) { listeners.add(f); },
    fire(why) { for (const f of listeners) f(why); },
  };
  const host = { send: m => sent.push(m), onMessage: h => { pageHandler = h; } };
  const calls = [];
  const api = async (route, body) => {
    calls.push([route, body]);
    if (route === '/api/hotkeys/device/run') return body.id === 'cccccc'
      ? { text: 'It means you went shopping.', program: 'explain_text', version: 'v1', model: 'openai-codex/gpt-6-luna', call: 'c-explain' }
      : { text: 'I went to the store.', program: 'fix_writing', version: 'v2', model: 'openai-codex/gpt-6-luna', call: 'c-fix' };
    if (route === '/api/hotkeys/device/ask') return { kind: 'replace', text: 'I have gone to the store.', program: 'selection_ask', model: 'x', call: 'c-ask' };
    if (route === '/api/hotkeys/device/rate') return { ok: true };
    throw new Error('no route ' + route);
  };
  const frog = createFrog({ desk, helper, host, api, settleMs: 5 });
  const page = m => pageHandler(m);
  return { frog, sent, did, calls, page, helper };
}

test('it appears beside a settled selection of a few words, and stays away when it should', async () => {
  const w = world();
  w.frog.onSelection('i');
  await tick(20);
  assert.equal(w.sent.length, 0, 'one word: not enough');
  w.frog.onSelection('i has');
  w.frog.onSelection('i has went to the store');
  await tick(20);
  const show = w.sent.filter(m => m.type === 'show');
  assert.equal(show.length, 1, 'a drag that changes the selection quickly shows the frog once, when it settles');
  assert.deepEqual({ monitor: show[0].monitor, at: show[0].at, corner: show[0].corner, words: show[0].words, app: show[0].app },
    { monitor: 'DP-1', at: { x: 900, y: 420 }, corner: false, words: 6, app: 'Thunderbird' });
  assert.equal(show[0].spells.length, 2);
  assert.equal(show[0].model, 'openai-codex/gpt-6-luna');

  // Pointer outside the window: the keys made the selection; it waits in the corner.
  const k = world({ pointer: { x: 1800, y: 1000 } });
  k.frog.onSelection('selected with the keyboard');
  await tick(20);
  assert.deepEqual(k.sent.find(m => m.type === 'show').at, { x: 1282, y: 866 });
  assert.equal(k.sent.find(m => m.type === 'show').corner, true);

  // A terminal: you select there to copy.
  const t = world({ focused: { id: 'w2', app: 'Alacritty', terminal: true } });
  t.frog.onSelection('ls -la some folder');
  await tick(20);
  assert.equal(t.sent.length, 0);

  // Off in settings.
  const off = world(); off.helper.frog.on = false;
  off.frog.onSelection('a few words here');
  await tick(20);
  assert.equal(off.sent.length, 0);
});

test('a spell: the selected text goes out, the answer comes back with its facts', async () => {
  const w = world();
  w.frog.onSelection('  i has went to the store ');
  await tick(20);
  w.page({ type: 'keyboard', on: true });
  await w.page({ type: 'cast', id: 'aaaaaa' });
  assert.deepEqual(w.calls[0], ['/api/hotkeys/device/run', { id: 'aaaaaa', text: '  i has went to the store ' }]);
  const a = w.sent.find(m => m.type === 'answer');
  assert.equal(a.kind, 'replace');
  assert.equal(a.before, 'i has went to the store');
  assert.equal(a.text, 'I went to the store.');
  assert.equal(a.program, 'fix_writing'); assert.equal(a.version, 'v2'); assert.equal(a.call, 'c-fix');
  assert.ok(typeof a.secs === 'number');

  // A spell that shows its answer.
  await w.page({ type: 'cast', id: 'cccccc' });
  assert.equal(w.sent.filter(m => m.type === 'answer').pop().kind, 'answer');

  // Judged from the page: to Chattering.
  await w.page({ type: 'judge', call: 'c-explain', verdict: 'wrong' });
  assert.deepEqual(w.calls.pop(), ['/api/hotkeys/device/rate', { call: 'c-explain', verdict: 'wrong' }]);
});

test('replace: pasted over the same selection with its spaces kept, else left on the clipboard', async () => {
  const w = world({ selectionNow: '  i has went to the store ' });
  w.frog.onSelection('  i has went to the store ');
  await tick(20);
  await w.page({ type: 'cast', id: 'aaaaaa' });
  await w.page({ type: 'replace' });
  assert.deepEqual(w.did.find(d => d[0] === 'paste'), ['paste', 'w1', '  I went to the store. ']);
  assert.match(w.sent.pop().html, /Replaced/);

  // The selection changed meanwhile: nothing pasted, the answer on the clipboard.
  const c = world({ selectionNow: '' });
  c.frog.onSelection('i has went to the store');
  await tick(20);
  await c.page({ type: 'cast', id: 'aaaaaa' });
  await c.page({ type: 'replace' });
  assert.ok(!c.did.some(d => d[0] === 'paste'));
  assert.deepEqual(c.did.find(d => d[0] === 'clipboard'), ['clipboard', 'I went to the store.']);
  assert.match(c.sent.pop().html, /selection changed/);
});

test('a question typed into the book, and the answer it decides', async () => {
  const w = world({ selectionNow: 'i has went to the store' });
  w.frog.onSelection('i has went to the store');
  await tick(20);
  await w.page({ type: 'ask', request: 'make it present perfect' });
  assert.deepEqual(w.calls[0], ['/api/hotkeys/device/ask', { request: 'make it present perfect', text: 'i has went to the store' }]);
  assert.equal(w.sent.find(m => m.type === 'answer').kind, 'replace');
  await w.page({ type: 'again' });
  assert.equal(w.calls.filter(c => c[0] === '/api/hotkeys/device/ask').length, 2, 'again asks again');
});

test('a hotkey pressed sends the frog away; while a panel is open new selections wait', async () => {
  const w = world();
  w.frog.onSelection('some words to fix');
  await tick(20);
  w.helper.fire('press');
  assert.equal(w.sent.pop().type, 'hide');
  w.frog.onSelection('again some words');
  await tick(20);
  w.page({ type: 'keyboard', on: true });
  const n = w.sent.length;
  w.frog.onSelection('typed in the ask line');
  await tick(20);
  assert.equal(w.sent.length, n, 'nothing while the menu is open');
  assert.equal(appName({ app: 'chromium-browser' }), 'Chromium');
  assert.equal(appName({ app: 'org.gnome.TextEditor' }), 'TextEditor');
});

test('its key calls it with the book open, even where it stays away', async () => {
  const w = world({ focused: { id: 'w2', app: 'Alacritty', terminal: true } });
  world.primary = 'git commit -m "fix the thing"';
  w.helper.fire('summon');
  await tick(20);
  const show = w.sent.find(m => m.type === 'show');
  assert.ok(show && show.open === true, 'opened on the selection, in a terminal');
  assert.equal(show.words, 6);
  world.primary = '';
  const e = world();
  e.helper.fire('summon');
  await tick(20);
  assert.equal(e.sent.pop().type, 'problem', 'nothing selected: it says so');
});

test('the app does not take the keyboard back: nothing pasted, the answer on the clipboard', async () => {
  const w = world({ selectionNow: 'i has went to the store' });
  w.frog.onSelection('i has went to the store');
  await tick(20);
  await w.page({ type: 'cast', id: 'aaaaaa' });
  world.focus = { id: 'other', app: 'x', terminal: false }; // focus went elsewhere
  await w.page({ type: 'replace' });
  assert.ok(!w.did.some(d => d[0] === 'paste'));
  assert.deepEqual(w.did.find(d => d[0] === 'clipboard'), ['clipboard', 'I went to the store.']);
  assert.match(w.sent.pop().html, /did not take the keyboard back[\s\S]*clipboard/);
});

test('a Chattering older than the frog sends no frog settings: it stays off', async () => {
  const w = world(); w.helper.frog = null;
  w.frog.onSelection('a few words here');
  w.helper.fire('summon');
  await tick(20);
  assert.equal(w.sent.length, 0);
});
