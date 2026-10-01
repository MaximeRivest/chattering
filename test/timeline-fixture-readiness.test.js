'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const TimelineControls = require('../timeline-controls.js');
const { viewerBrowser } = require('./helpers/viewer-browser');

// Run the actual cameraAt fixture helper. until captures its expression; no
// second readiness implementation can pass while the browser helper regresses.
const source = fs.readFileSync(path.join(__dirname, 'timeline-controls-app.test.js'), 'utf8');
const helpers = [...source.matchAll(/  const cameraAt = scale => ([\s\S]+?);\n(?=  assert.equal)/g)];
assert.equal(helpers.length, 1, 'exactly one real cameraAt helper');
const expressionAt = vm.runInNewContext(`scale => ${helpers[0][1]}`, { until: expression => expression });

function publication(scale, label, pressed = []) {
  const buttons = ['hours', 'days', 'weeks'].map(action => ({
    dataset: { action }, getAttribute: name => name === 'aria-pressed' ? String(pressed.includes(action)) : null,
  }));
  const context = {
    PX_DAY_BASE: 160, homeTimeline: { state: { scale: scale * 160 } }, ganttZoom: scale, TimelineControls,
    document: {
      querySelector: selector => { assert.equal(selector, '.tc-scale'); return label === null ? null : { textContent: label }; },
      querySelectorAll: selector => { assert.equal(selector, '.tc-camera [aria-pressed]'); return buttons; },
    },
  };
  return { context, buttons, ready: target => !!vm.runInNewContext(expressionAt(target), context) };
}

test('Given the hours camera but a pending Custom label, When cameraAt checks readiness, Then it waits for publication', () => {
  const state = publication(6, 'Custom ▾');
  assert.equal(state.ready(6), false);
  state.context.document.querySelector = () => ({ textContent: 'Hours ▾' });
  assert.equal(state.ready(6), false, 'label alone is not a coherent publication');
  state.buttons[0].getAttribute = () => 'true';
  assert.equal(state.ready(6), true, 'camera, label and pressed state are now coherent');
});

for (const [scale, label, pressed] of [[6, 'Hours ▾', ['hours']], [1, 'Days ▾', ['days']], [0.15, 'Weeks ▾', ['weeks']], [6 / 1.4, 'Custom ▾', []]]) {
  test(`Given coherent ${label} controls, When cameraAt checks ${scale}, Then it proceeds`, () => {
    assert.equal(publication(scale, label, pressed).ready(scale), true);
  });
  test(`Given ${label} but the wrong camera, When cameraAt checks ${scale}, Then it waits`, () => {
    assert.equal(publication(scale * 1.01, label, pressed).ready(scale), false);
  });
}

for (const pressed of [[], ['days'], ['hours', 'days']]) test(`Given Hours with pressed state ${JSON.stringify(pressed)}, When cameraAt checks readiness, Then it waits`, () => {
  assert.equal(publication(6, 'Hours ▾', pressed).ready(6), false);
});

test('Given custom zoom with a stale preset pressed, When cameraAt checks readiness, Then it waits', () => {
  assert.equal(publication(6 / 1.4, 'Custom ▾', ['hours']).ready(6 / 1.4), false);
});

test('Given the hours camera before controls mount, When cameraAt checks readiness, Then it waits', () => {
  assert.equal(publication(6, null, []).ready(6), false);
});

test('Given reduced motion and held control publication, When the real hours action changes the camera, Then cameraAt waits until controls publish', { timeout: 90000 }, async t => {
  const { evaluate: ev, until, command, exceptions } = await viewerBrowser(t);
  await until(`homeTimeline?.state.width > 0 && !$('helpOverlay').checkVisibility() && !document.querySelector('dialog[open]')`);
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await ev(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true);
  // Establish the native failure's previous Custom publication using the real
  // camera and app onChange callback, not a synthetic DOM write.
  await ev(`homeTimeline.zoomTo(PX_DAY_BASE * (6 / 1.4))`);
  await until(`Math.abs(ganttZoom - 6 / 1.4) < 0.000001 && document.querySelector('.tc-scale').textContent === 'Custom ▾'`);
  await ev(`document.querySelector('.tc-scale').click();
    window.fixturePublications=[]; window.fixtureUpdate=timelineControls.updateScale;
    timelineControls.updateScale=scale => fixturePublications.push(scale);
    window.fixtureJumps=0; window.fixtureJump=homeTimeline.jump.bind(homeTimeline);
    homeTimeline.jump=(...args)=>{fixtureJumps++;return fixtureJump(...args)};
    document.querySelector('#timelineControlPanel [data-action=hours]').click()`);
  const pending = await ev(`({scale:homeTimeline.state.scale / PX_DAY_BASE,label:document.querySelector('.tc-scale').textContent,pressed:[...document.querySelectorAll('.tc-camera [aria-pressed=true]')].map(b=>b.dataset.action),publications:fixturePublications.length})`);
  assert.ok(Math.abs(pending.scale - 6) < 0.000001, 'real camera already reached hours');
  assert.equal(pending.label, 'Custom ▾', 'app label awaits the draw callback');
  assert.deepEqual(pending.pressed, []);
  await until(`fixturePublications.some(scale => Math.abs(scale - 6) < 0.000001)`);
  assert.equal(await ev(`Math.abs(ganttZoom - 6) < 0.000001`), true, 'real app onChange reached hours');
  assert.equal(await ev(expressionAt(6)), false, 'actual cameraAt must not proceed before publication');
  await ev(`timelineControls.updateScale=fixtureUpdate; for(const scale of fixturePublications.splice(0)) timelineControls.updateScale(scale)`);
  await until(expressionAt(6));
  assert.equal(await ev(`document.querySelector('.tc-scale').textContent`), 'Hours ▾');
  assert.deepEqual(await ev(`[...document.querySelectorAll('.tc-camera [aria-pressed=true]')].map(b=>b.dataset.action)`), ['hours']);
  assert.equal(await ev(`fixtureJumps`), 0, 'preset changes never jump to now');
  assert.deepEqual(exceptions, []);
});

// The RED browser run separately reached narrow-screen assertions while the
// pinned controls still occupied the desktop slot. Exercise this real wait.
const layoutWaits = [...source.matchAll(/await until\(`([^`]+)`, 'timeline layout ' \+ width\);/g)];
assert.equal(layoutWaits.length, 1, 'exactly one real responsive-layout wait');
const layoutExpression = vm.runInNewContext(`(width, height) => \`${layoutWaits[0][1]}\``);
function layoutReady(width, height, actualWidth, actualHeight, children, phoneVisible) {
  return !!vm.runInNewContext(layoutExpression(width, height), {
    innerWidth: actualWidth, innerHeight: actualHeight,
    document: { querySelector: selector => { assert.equal(selector, '.tc-inline'); return { children: { length: children } }; } },
    $: id => { assert.equal(id, 'phoneBar'); return { checkVisibility: () => phoneVisible }; },
  });
}

for (const [width, height, children, phone] of [[760, 800, 1, false], [390, 844, 0, true], [640, 360, 0, true]]) {
  test(`Given coherent ${width}px layout, When the resized fixture checks readiness, Then it proceeds`, () => {
    assert.equal(layoutReady(width, height, width, height, children, phone), true);
  });
}

test('Given stale viewport metrics, When the resized fixture checks readiness, Then it waits', () => {
  assert.equal(layoutReady(390, 844, 760, 800, 0, true), false);
  assert.equal(layoutReady(390, 844, 390, 800, 0, true), false);
});

test('Given narrow metrics before pinned controls relocate, When the resized fixture checks readiness, Then it waits', () => {
  assert.equal(layoutReady(390, 844, 390, 844, 1, true), false);
});

test('Given narrow metrics before phone navigation publishes, When the resized fixture checks readiness, Then it waits', () => {
  assert.equal(layoutReady(390, 844, 390, 844, 0, false), false);
});

test('Given desktop metrics before pinned controls return, When the resized fixture checks readiness, Then it waits', () => {
  assert.equal(layoutReady(760, 800, 760, 800, 0, false), false);
  assert.equal(layoutReady(760, 800, 760, 800, 1, true), false);
});
