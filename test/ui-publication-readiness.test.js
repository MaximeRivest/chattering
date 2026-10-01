'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
function wait(file, label) {
  const m = [...source(file).matchAll(/await (?:until|waitFor)\(`([^`]+)`, ([^\n]+)\);/g)].filter(m => m[2].includes(label));
  assert.equal(m.length, 1, 'one actual fixture predicate: ' + label);
  return m[0][1];
}

for (const n of [undefined, 0, 2]) test(`Given unrelated voice hints and target number ${n}, When the real fixture checks publication, Then it waits`, () => {
  const expression = wait('voice-app.test.js', 'nothing is numbered on screen');
  const ready = vm.runInNewContext(expression, {
    voice: { numbers: new Map(n === undefined ? [] : [['conv:pi:fixture/media.jsonl', n]]) },
    document: { querySelectorAll: () => [{ textContent: '1' }] },
  });
  assert.equal(!!ready, false);
});
test('Given the target conversation and its painted number, When the real fixture checks publication, Then it proceeds', () => {
  assert.equal(!!vm.runInNewContext(wait('voice-app.test.js', 'nothing is numbered on screen'), {
    voice: { numbers: new Map([['conv:pi:fixture/media.jsonl', 2]]) },
    document: { querySelectorAll: () => [{ textContent: '2' }] },
  }), true);
});

// Run the actual chrome scroll listener with keyboard focus and a queued
// scroll from before focus. No reimplementation of the scroll rules.
function scrollWithFocus(top, typing) {
  const app = source('../app.html');
  const start = app.indexOf("$('view').addEventListener('scroll', () => {\n  if (!chromeAutoHideOn())");
  assert.ok(start >= 0);
  const end = app.indexOf('}, { passive: true });', start) + '}, { passive: true });'.length;
  let listener, min = true;
  const ta = {}, view = { scrollTop: top, addEventListener: (_, fn) => listener = fn };
  const context = {
    $: id => id === 'view' ? view : ta,
    document: { activeElement: typing ? ta : {} },
    phoneLayout: () => true, chromeAutoHideOn: () => true,
    CHROME_TOP: 48, chromeScrollLast: 600, chromeUpAcc: 0, chromeDownAcc: 0,
    setChromeMin: value => min = value,
  };
  vm.runInNewContext(app.slice(start, end), context); listener();
  return min;
}
for (const top of [0, 560]) test(`Given the phone composer focused, When a queued scroll at ${top} arrives, Then typing still owns the screen`, () => {
  assert.equal(scrollWithFocus(top, true), true);
});
test('Given the phone composer blurred, When scrolling reaches the top, Then chrome recovers', () => {
  assert.equal(scrollWithFocus(0, false), false);
});

// Windows paths are native API identity, not CSS selector suffixes. Execute
// the real fixture wait with exactly the path a Windows server publishes.
test('Given a published Windows changed-file row, When the conversation fixture checks it, Then it can proceed', () => {
  const row = { dataset: { fileDiff: 'C:\\fixture\\work\\docs\\example.js' } };
  const document = { querySelector: () => null, querySelectorAll: () => [row] };
  const expression = wait('conversation-app.test.js', 'the file under the steps');
  const context = { document };
  vm.runInNewContext('var scFile = ' + require('./helpers/changed-file').changedFile.toString(), context);
  assert.equal(!!vm.runInNewContext(expression, context), true);
});

for (const value of ['light', 'dark']) test(`Given system ${value} CSS before the media event, When the real theme fixture waits, Then it waits for the manifest too`, async () => {
  const scheme = source('side-panel.test.js').match(/const scheme = (async value => \{[^\n]+\});/);
  assert.ok(scheme, 'actual theme fixture helper');
  let published = false, probes = 0;
  const opposite = value === 'dark' ? 'light' : 'dark';
  const paletteContext = {
    matchMedia: () => ({ matches: true }),
    window: { shownTheme: () => 'rockfrog-' + value },
    $: () => ({ getAttribute: () => '/manifest.webmanifest?theme=rockfrog-' + (published ? value : opposite) }),
  };
  const context = {
    send: async () => {}, sid: 'fixture',
    // Deterministically withhold publication past the original fixed sleep.
    setTimeout: fn => fn(),
    until: async expression => {
      probes++;
      assert.equal(!!vm.runInNewContext(expression, paletteContext), false, 'not ready before the media callback publishes');
      published = true;
      assert.equal(!!vm.runInNewContext(expression, paletteContext), true, 'ready once the actual predicate matches publication');
    },
  };
  await vm.runInNewContext('(' + scheme[1] + ')(' + JSON.stringify(value) + ')', context);
  assert.equal(published, true, 'scheme returned before installed-app manifest publication');
  assert.equal(probes, 1);
});

function swipeStrip(width, scrollWidth) {
  const m = source('one-tree-app.test.js').match(/const swipe = `([\s\S]*?)`;/);
  assert.ok(m, 'actual swipe fixture');
  const strip = { dataset: { wired: '1', placed: '1' }, clientWidth: width, scrollWidth, offsetLeft: 0,
    dispatchEvent() {}, querySelectorAll: () => [{ offsetLeft: 360, getAttribute: () => 'false' }] };
  vm.runInNewContext(m[1], { document: { querySelector: () => strip }, PointerEvent: function () {} });
  return strip;
}
for (const [width, scrollWidth] of [[0, 0], [370, 370]]) test(`Given a wired strip with ${width}/${scrollWidth} geometry, When the real swipe fixture tries, Then it does not consume a swipe before overflow publishes`, () => {
  assert.equal(swipeStrip(width, scrollWidth).dataset.swiped, undefined);
});
test('Given a wired overflowing strip, When the real swipe fixture tries, Then it scrolls to the other answer', () => {
  const strip = swipeStrip(370, 693);
  assert.equal(strip.dataset.swiped, '1');
  assert.equal(strip.scrollLeft, 360);
});
