'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const controls = require('../timeline-controls.js');

test('presets are exact camera scales; manual zoom is not mislabeled', () => {
  for (const [id, scale] of Object.entries(controls.PRESETS)) assert.equal(controls.presetAt(scale), id);
  for (const scale of [1.01, 0.99, 1.4, 4, NaN]) assert.equal(controls.presetAt(scale), null);
});
test('shortcuts and their guide share action definitions', () => {
  for (const a of controls.ACTIONS) {
    assert.equal(controls.actionForKey({ key: a.key }), a.id);
    if (a.id !== 'help') assert.ok(controls.helpRows().some(([key, text]) => key === a.hint && text === a.label));
  }
  assert.equal(controls.actionForKey({ key: 'h' }), null, 'keep existing lowercase h help binding');
  assert.equal(controls.actionForKey({ key: 'Home' }), 'start');
  assert.equal(controls.actionForKey({ key: 'End' }), 'now');
  assert.equal(controls.actionForKey({ key: '0' }), 'days');
});
test('typing, composition, handled keys and browser modifiers are never intercepted', () => {
  for (const flag of ['ctrlKey', 'altKey', 'metaKey', 'isComposing', 'defaultPrevented']) {
    assert.equal(controls.actionForKey({ key: '+', [flag]: true }), null);
  }
  assert.equal(controls.actionForKey({ key: 'D', target: { closest: () => ({}) } }), null);
});
