'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the conditions used by the real browser fixtures, not another
// implementation. Stream body, completion label and hydrated row contents
// may arrive in separate renders. The existing exact assertions stay intact.
function condition(file, label) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const waits = [...source.matchAll(/await until\(`([^`]+)`, ([^\n]+)\);/g)];
  const matches = waits.filter(m => m[2].includes(label));
  assert.equal(matches.length, 1, 'exactly one real browser wait must be found: ' + label);
  return matches[0][1];
}
function ready(expression, elements) {
  return !!vm.runInNewContext(expression, { document: { querySelector: selector => elements[selector] || null } });
}
const form = () => condition('programs-make-app.test.js', 'the form answered');
const example = () => condition('programs-live-app.test.js', 'the finished example replaces');

test('Given a streamed answer body but a pending completion label, When the form fixture checks readiness, Then it waits', () => {
  assert.equal(ready(form(), { '[data-out="result"]': { textContent: 'billing' }, '#state': { textContent: 'writing…' } }), false);
});

test('Given both the answer and its completion label, When the form fixture checks readiness, Then it proceeds', () => {
  assert.equal(ready(form(), { '[data-out="result"]': { textContent: 'billing' }, '#state': { textContent: 'answered by v2' } }), true);
});

test('Given a completion label but no expected answer, When the form fixture checks readiness, Then it still waits', () => {
  assert.equal(ready(form(), { '[data-out="result"]': { textContent: 'shipping' }, '#state': { textContent: 'answered by v2' } }), false);
});

const row = (pair = '', ask = '') => ({ '.pg-tr.open[data-run]': {}, '.pg-tr.open[data-run] .pg-pair': { textContent: pair }, '.pg-tr.open[data-run] .pg-ask': { textContent: ask } });
test('Given a replacement example before its contents hydrate, When the live fixture checks readiness, Then it waits', () => {
  assert.equal(ready(example(), row()), false);
});

test('Given the answer but no judgment prompt, When the live fixture checks readiness, Then it waits', () => {
  assert.equal(ready(example(), row('File viewer fixture check')), false);
});

test('Given a hydrated example and judgment prompt, When the live fixture checks readiness, Then it proceeds', () => {
  assert.equal(ready(example(), row('File viewer fixture check', 'Is File viewer fixture check right')), true);
});

test('Given a hydrated example with the live row still present, When the fixture checks readiness, Then it waits', () => {
  assert.equal(ready(example(), { ...row('File viewer fixture check', 'Is File viewer fixture check right'), '.pg-live-tr': {} }), false);
});

test('Given contents without a replacement row, When the fixture checks readiness, Then it waits', () => {
  const elements = row('File viewer fixture check', 'Is File viewer fixture check right');
  delete elements['.pg-tr.open[data-run]'];
  assert.equal(ready(example(), elements), false);
});

for (const pair of ['', 'different answer']) test(`Given the judgment but ${pair || 'no'} answer content, When the fixture checks readiness, Then it waits`, () => {
  assert.equal(ready(example(), row(pair, 'Is File viewer fixture check right')), false);
});
