'use strict';
// Actions as closed loops: send keys, then wait until the terminal shows the
// expected state before the next key. A click on "Yes" is never a blind
// "down, down, enter": the highlight is confirmed on the right option first,
// and the action stops if the screen turns out to be something else.

const { readDocument } = require('./reader');

function waitFor(host, test, { timeoutMs = 3000, profile } = {}) {
  return new Promise((resolve, reject) => {
    const check = () => { const d = readDocument(host.snapshot({ screenOnly: true }), profile); if (test(d)) { done(); resolve(d); return true; } return false; };
    const onFrame = () => check();
    const timer = setTimeout(() => { done(); reject(new Error('the screen did not reach the expected state')); }, timeoutMs);
    const done = () => { clearTimeout(timer); host.off('frame', onFrame); };
    host.on('frame', onFrame);
    check();
  });
}

const sameOptions = (a, b) => a && b && a.length === b.length && a.every((o, i) => o.label === b[i].label);

// A key the program never saw (it was still starting, or busy) changes
// nothing: send it again, a few times, before giving up. Never more than
// once per observed non-change, so a slow program does not get extra keys.
async function keyUntil(host, bytes, test, { profile, tries = 6, waitMs = 400 } = {}) {
  for (let i = 0; i < tries; i++) {
    host.input(bytes);
    try { return await waitFor(host, test, { profile, timeoutMs: waitMs * (i + 1) }); }
    catch (e) { if (i === tries - 1) throw e; }
  }
}

// The screen has stopped changing for `ms` (a program may redraw a dialog
// from scratch while it starts: a highlight seen once is not yet trusted).
function quiet(host, ms = 150, maxMs = 3000) {
  return new Promise(resolve => {
    const t0 = performance.now(); let timer;
    const arm = () => { clearTimeout(timer); timer = setTimeout(done, ms); };
    const onFrame = () => { if (performance.now() - t0 > maxMs) return done(); arm(); };
    const done = () => { clearTimeout(timer); host.off('frame', onFrame); resolve(); };
    host.on('frame', onFrame); arm();
  });
}

// Move a highlight to `index` and confirm, as a closed loop:
//   navigate (re-reading the direction every key) → wait for a still screen
//   → check the highlight is on the target → only then the confirm key →
//   the region must disappear; if it is back, start over. Never a blind key.
async function selectAndConfirm(host, { profile, read, index, confirmKey, gone, rounds = 4 }) {
  for (let round = 0; round < rounds; round++) {
    let r = read(readDocument(host.snapshot({ screenOnly: true }), profile));
    if (!r) throw new Error('it is no longer on screen');
    for (let guard = 0; r.selected !== index; guard++) {
      if (guard > r.count * 2 + 2) throw new Error('the highlight did not reach the target');
      const from = r.selected;
      await keyUntil(host, index > from ? '\x1b[B' : '\x1b[A', d => { const x = read(d); return x && x.selected !== from; }, { profile });
      r = read(readDocument(host.snapshot({ screenOnly: true }), profile));
      if (!r) throw new Error('it closed while moving');
    }
    await quiet(host);
    r = read(readDocument(host.snapshot({ screenOnly: true }), profile));
    if (!r) throw new Error('it closed before confirming');
    if (r.selected !== index) continue; // redrawn under us: navigate again
    host.input(confirmKey);
    try { return await waitFor(host, gone, { profile, timeoutMs: 1500 }); } catch {}
    // Still there: look again before doing anything (never a second blind confirm).
  }
  throw new Error('could not confirm the choice');
}

// Choose option `index` of the dialog on screen (as read now).
async function choose(host, index, { profile, confirmKey = '\r' } = {}) {
  const doc = readDocument(host.snapshot({ screenOnly: true }), profile);
  if (!doc.choice) throw new Error('no choice on screen');
  const options = doc.choice.options;
  if (!options[index]) throw new Error('no such option');
  const read = d => d.choice && sameOptions(d.choice.options, options) ? { selected: d.choice.selected, count: options.length } : null;
  return selectAndConfirm(host, { profile, read, index, confirmKey, gone: d => !read(d) });
}

// Highlight menu item `index` and accept it with Tab (completion, not run).
async function pickMenu(host, index, { profile, acceptKey = '\t' } = {}) {
  const doc = readDocument(host.snapshot({ screenOnly: true }), profile);
  if (!doc.menu) throw new Error('no menu on screen');
  const items = doc.menu.items.map(i => i.label), label = items[index];
  if (!label) throw new Error('no such item');
  const read = d => d.menu && d.menu.items.length === items.length && d.menu.items.every((x, i) => x.label === items[i]) ? { selected: d.menu.selected, count: items.length } : null;
  // Done when the box holds the pick (Pi lists commands without their "/").
  const bare = t => String(t).replace(/^[/@]/, '');
  return selectAndConfirm(host, { profile, read, index, confirmKey: acceptKey, gone: d => d.composer && bare(d.composer.text).startsWith(bare(label)) && !read(d) });
}

// The terminal does not record whether a line break was typed or is a
// wrap; compare texts as words (see reader.js).
const sameText = (a, b) => String(a).replace(/\s+/g, ' ').trim() === String(b).replace(/\s+/g, ' ').trim();

// Bring the program's own editor to `target` (a touch keyboard's text,
// edited in the page): move the cursor to the end, delete back to the
// longest common start, type or paste the rest — each step checked on the
// screen. Never clears with a shortcut (Esc Esc opens Claude Code's rewind
// on an empty box; Ctrl+U clears one line).
async function setComposerText(host, target, { profile, timeoutMs = 3000 } = {}) {
  const read = () => readDocument(host.snapshot({ screenOnly: true }), profile);
  let d = read();
  if (!d.composer) throw new Error('the input box is not on screen');
  if (d.composer.text === target) return d;
  // 1. The cursor at the very end (Down only while not on the last line:
  //    on the last line it would bring back an earlier message).
  for (let guard = 0; guard < 40; guard++) {
    const c = d.composer;
    if (c.caret == null || c.caret >= c.text.length) break;
    const onLastLine = c.text.indexOf('\n', c.caret) < 0;
    const before = c.caret;
    host.input(onLastLine ? '\x1b[F' : '\x1b[B');
    d = await waitFor(host, x => x.composer && x.composer.caret !== before, { profile, timeoutMs: 800 }).catch(() => read());
    if (d.composer && d.composer.caret === before && onLastLine) break; // End changed nothing: already there as far as it can tell
  }
  // 2. Delete back to the common start.
  const cur = d.composer.text;
  let p = 0;
  while (p < cur.length && p < target.length && cur[p] === target[p]) p++;
  if (cur.length > p) {
    host.input('\x7f'.repeat(cur.length - p));
    d = await waitFor(host, x => x.composer && sameText(x.composer.text, cur.slice(0, p)), { profile, timeoutMs });
  }
  // 3. The rest: typed, or pasted when it holds a line break.
  const add = target.slice(p);
  if (add) {
    if (/\n/.test(add)) host.paste(add); else host.input(add);
    d = await waitFor(host, x => x.composer && (sameText(x.composer.text, target) || /\[Pasted text #\d+/.test(x.composer.text)), { profile, timeoutMs });
  }
  return d;
}

// Send `target`: the editor brought to it, any suggestion list closed
// (Enter would pick from it, not send), Enter, and the box seen empty.
async function submitComposer(host, target, { profile } = {}) {
  let d = await setComposerText(host, target, { profile });
  if (!sameText(d.composer.text, target) && !/\[Pasted text #\d+/.test(d.composer.text)) throw new Error('the input box does not hold the message');
  if (d.menu) {
    const text = d.composer.text;
    host.input('\x1b');
    d = await waitFor(host, x => !x.menu && x.composer && x.composer.text === text, { profile, timeoutMs: 1500 });
  }
  // Enter, checked: sent, the box empties (or it works, asks, shows a
  // panel). A program settling (just resumed, an interrupted turn) may not
  // read it: Enter again only while the box still holds exactly the message.
  const sentOff = x => x.status || x.choice || x.panel || (x.composer && x.composer.text === '');
  const stillThere = () => { const x = readDocument(host.snapshot({ screenOnly: true }), profile); return x.composer && !sentOff(x) && sameText(x.composer.text, d.composer.text); };
  for (let i = 0; i < 6; i++) {
    host.input('\r');
    try { return await waitFor(host, sentOff, { profile, timeoutMs: 700 * (i + 1) }); }
    catch (e) { if (!stillThere()) return waitFor(host, sentOff, { profile, timeoutMs: 5000 }); }
  }
  throw new Error('the program did not take the message');
}

module.exports = { waitFor, keyUntil, quiet, choose, pickMenu, setComposerText, submitComposer, sameText };
