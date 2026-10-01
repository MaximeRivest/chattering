'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const source = app.slice(app.indexOf('function wireCodeCopyButtons('), app.indexOf('// Every bash fence in a reply'));

function fixture(copyText = async () => {}) {
  const blocks = ['', '  a < b && c\n\tsecond line  '].map(text => ({
    code: { textContent: text }, button: null,
    querySelector(selector) { return selector === 'code' ? this.code : this.button; },
    appendChild(button) { this.button = button; },
  }));
  const root = { querySelectorAll: () => blocks };
  const timers = [], errors = [];
  const context = vm.createContext({
    $: () => root,
    document: { createElement: () => ({ setAttribute(name, value) { this[name] = value; } }) },
    copyText, errToast: error => errors.push(error), setTimeout: fn => timers.push(fn),
  });
  vm.runInContext(source, context);
  const wire = context.wireCodeCopyButtons;
  wire();
  return { blocks, root, wire, timers, errors };
}
const click = () => ({ preventDefault() {}, stopPropagation() {} });

test('code copy wires every fence once, including unlabelled and empty code', () => {
  const { blocks, wire, root } = fixture();
  const buttons = blocks.map(b => b.button);
  wire(root);
  for (const [i, block] of blocks.entries()) {
    assert.equal(block.button, buttons[i]);
    assert.equal(block.button.type, 'button');
    assert.equal(block.button['aria-label'], 'Copy code');
  }
});

test('copy reads current code only and preserves whitespace, with temporary feedback', async () => {
  const copied = [];
  const { blocks, timers } = fixture(async text => copied.push(text));
  const block = blocks[1];
  block.code.textContent += '\nnew streamed line';
  let stopped = false, prevented = false;
  await block.button.onclick({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.deepEqual(copied, ['  a < b && c\n\tsecond line  \nnew streamed line']);
  assert.ok(stopped && prevented);
  assert.equal(block.button.textContent, 'copied ✓');
  await block.button.onclick(click());
  assert.equal(copied.length, 1, 'repeat click does not stack feedback timers');
  timers.shift()();
  assert.equal(block.button.textContent, 'copy');
  assert.equal(block.button.disabled, false);
});

test('clipboard failure is reported and the button can be tried again', async () => {
  const { blocks, timers, errors } = fixture(async () => { throw new Error('Clipboard unavailable'); });
  await blocks[0].button.onclick(click());
  assert.deepEqual(errors, ['Clipboard unavailable']);
  assert.equal(blocks[0].button.textContent, 'copy');
  assert.equal(blocks[0].button.disabled, false);
  assert.equal(timers.length, 0);
});
