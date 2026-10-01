'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../harness-composer-ui');
const gate = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function setup() {
  let state = { text: '/choose b', cursor: 9, end: 9 };
  const pending = [], displays = [], writes = [];
  let fallbacks = 0;
  const client = createClient({ clientId: 'tab', read: () => state,
    write: v => writes.push(v), display: v => displays.push(v), unsupported: () => fallbacks++,
    request: (body, signal) => { const g = gate(); pending.push({ ...g, body, signal }); return g.promise; },
  });
  return { client, pending, displays, writes, state: v => { state = v; }, fallbacks: () => fallbacks };
}
const suggestion = { snapshot: 'snap', items: [{ label: 'blue', value: 'blue' }] };
test('late suggestions do not replace the menu for a newer draft', async () => {
  const h = setup(); const a = h.client.query(); const b = h.client.query();
  assert.equal(h.pending[0].signal.aborted, true);
  h.pending[1].resolve(suggestion); await b;
  h.pending[0].resolve({ ...suggestion, items: [{ label: 'stale', value: 'stale' }] }); await a;
  assert.deepEqual(h.displays.at(-1).items, suggestion.items);
});
test('the native edit applies once, using the exact suggestion token', async () => {
  const h = setup(); const q = h.client.query(); h.pending[0].resolve(suggestion); await q;
  const p = h.client.pick(0);
  assert.equal(h.pending[1].body.snapshot, 'snap'); assert.equal(h.pending[1].body.itemIndex, 0);
  h.pending[1].resolve({ text: '/choose blue', cursor: 12 }); await p;
  assert.deepEqual(h.writes, [{ text: '/choose blue', cursor: 12 }]);
  await h.client.pick(0); assert.equal(h.pending.length, 2);
});
test('typing, caret changes or disposal while applying never overwrite the newer draft', async () => {
  for (const kind of ['typing', 'cursor', 'selection', 'dispose']) {
    const h = setup(); const q = h.client.query(); h.pending[0].resolve(suggestion); await q;
    const p = h.client.pick(0);
    if (kind === 'dispose') h.client.dispose();
    else h.state({ text: kind === 'typing' ? 'new draft' : '/choose b', cursor: kind === 'cursor' ? 2 : 9, end: kind === 'selection' ? 3 : 9 });
    h.pending[1].resolve({ text: 'old completion', cursor: 4 }); await p;
    assert.deepEqual(h.writes, [], kind);
  }
});
test('a cancelled or expired completion is visible as an error, not a prompt or a terminal launch', async () => {
  const h = setup(); const q = h.client.query(); h.pending[0].resolve(suggestion); await q;
  const p = h.client.pick(0); h.pending[1].reject(new Error('Completion expired')); await p;
  assert.match(h.displays.at(-1).error, /expired/); assert.deepEqual(h.writes, []);
});
test('only an explicit unsupported engine triggers the legacy fallback', async () => {
  const h = setup(); const q = h.client.query(); h.pending[0].reject(new Error('Forbidden')); await q;
  assert.equal(h.fallbacks(), 0);
  const q2 = h.client.query(); h.pending[1].resolve({ supported: false }); await q2;
  assert.equal(h.fallbacks(), 1);
});

test('the page code runs on plain-HTTP network pages: no secure-context-only APIs', () => {
  // Chattering is also served over http:// on a local network, where
  // crypto.randomUUID and navigator.clipboard do not exist. One throw while
  // wiring the composer breaks everything wired after it.
  const fs = require('node:fs');
  for (const file of ['harness-composer-ui.js', 'codex-ui.js', 'harness/compose-commands.js']) {
    const src = fs.readFileSync(require('node:path').join(__dirname, '..', file), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/crypto\.randomUUID\s*\(/.test(src), file + ' calls crypto.randomUUID');
    assert.ok(!/navigator\.clipboard/.test(src), file + ' uses navigator.clipboard');
  }
});

test('an empty box asks nothing unless asked on purpose (opening a conversation must not start the harness)', async () => {
  const h = setup();
  for (const text of ['', '   ', '\n']) { h.state({ text, cursor: text.length, end: text.length }); await h.client.query(); }
  assert.equal(h.pending.length, 0);
  h.state({ text: '', cursor: 0, end: 0 }); const q = h.client.query(true);
  assert.equal(h.pending.length, 1); assert.equal(h.pending[0].body.force, true);
  h.pending[0].resolve({ items: [] }); await q;
});
