'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function bundleHarness() {
  const begin = source.indexOf('async function writeAttachedContextFile(');
  const end = source.indexOf('// Wait for the session file', begin);
  const loaded = [], writes = [];
  const context = {
    normalizeContextItems: x => x, MEMORY_DOC_KINDS: [], attachedAsAccount: () => null,
    loadAttachedChat: async x => { loaded.push(x); return { text: 'exchange ' + (x.i ?? 'history') }; },
    fsp: { writeFile: async (...x) => writes.push(x) }, path, BRIEFINGS_DIR: '/tmp',
    estimateInputTokens: x => x.length, Date, Map, Set,
  };
  vm.createContext(context); vm.runInContext(source.slice(begin, end), context);
  return { run: context.writeAttachedContextFile, loaded, writes };
}
test('preview preserves distinct exchanges and never writes a briefing file', async () => {
  const h = bundleHarness();
  const out = await h.run([{ type: 'chat', key: 'a', i: 1 }, { type: 'chat', key: 'a', i: 4 }], { preview: true });
  assert.equal(h.loaded.length, 2); assert.equal(out.chats, 2);
  assert.equal(out.file, null); assert.equal(h.writes.length, 0);
});
test('recent history supersedes selected exchanges regardless of order', async () => {
  for (const items of [
    [{ type: 'chat', key: 'a', i: 1 }, { type: 'chat', key: 'a' }],
    [{ type: 'chat', key: 'a' }, { type: 'chat', key: 'a', i: 1 }],
  ]) {
    const h = bundleHarness(); await h.run(items);
    assert.equal(h.loaded.length, 1); assert.equal(h.loaded[0].i, undefined);
    assert.equal(h.writes.length, 1);
  }
});
