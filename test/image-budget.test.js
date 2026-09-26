'use strict';
// extensions/image-budget.ts: old images stop going out before a request
// passes the provider's size limit; the same history always gives the same
// request, so the provider's prompt cache keeps working.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const extPath = path.resolve(__dirname, '../extensions/image-budget.ts');
const packageDir = require('./helpers/pi-package.js').piPackageForTests() || path.join(__dirname, 'no-pi-package-here');
const loaderPath = path.join(packageDir, 'dist/core/extensions/loader.js');

const MB = 1024 * 1024;
const img = (mb, tag = '') => ({ type: 'image', mimeType: 'image/png', data: tag + 'x'.repeat(Math.round(mb * MB) - tag.length) });
// One turn: the agent reads a file, the tool result carries the image.
function readTurn(i, mb) {
  return [
    { role: 'assistant', content: [{ type: 'toolCall', id: 'c' + i, name: 'read', arguments: { path: `/tmp/shot-${i}.png` } }] },
    { role: 'toolResult', toolCallId: 'c' + i, toolName: 'read', content: [{ type: 'text', text: 'Read image file [image/png]' }, img(mb, 'i' + i)] },
  ];
}
const history = (n, mb) => [{ role: 'user', content: [{ type: 'text', text: 'make the deck' }] }, ...Array.from({ length: n }, (_, i) => readTurn(i, mb)).flat()];
const imageBytes = messages => messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'image').reduce((n, b) => n + b.data.length, 0);

let budgetImages;
test.before(async () => { ({ budgetImages } = await import(pathToFileURL(extPath).href)); });

test('under the high mark nothing changes', () => {
  assert.equal(budgetImages(history(10, 1)), null);
});

test('past the high mark the oldest images give way to a line naming the file', () => {
  const messages = history(20, 1); // 20 MB of images
  const before = JSON.stringify(messages);
  const out = budgetImages(messages);
  assert.ok(out, 'something is dropped');
  assert.equal(JSON.stringify(messages), before, 'the history itself is not touched');
  assert.ok(imageBytes(out.messages) <= 16 * MB, 'what is sent fits');
  // The 17th image passes 16 MB: the oldest nine go, 8 MB remain; three more follow.
  assert.equal(out.dropped, 9, 'past 16 MB the oldest go until 8 MB remain');
  const first = out.messages[2].content;
  assert.equal(first[0].text, 'Read image file [image/png]', 'the tool result keeps its own text');
  assert.match(first[1].text, /read from \/tmp\/shot-0\.png/);
  assert.match(first[1].text, /Read the file again/);
  const last = out.messages.at(-1).content;
  assert.equal(last[1].type, 'image', 'the newest image is always sent');
});

test('the same history gives the same request, and a new image moves the line only past the high mark', () => {
  const a = budgetImages(history(20, 1)), b = budgetImages(history(20, 1));
  assert.equal(JSON.stringify(a.messages), JSON.stringify(b.messages));
  // 20 images: 9 dropped, 11 MB kept. More images keep the line where it
  // was until the kept images pass 16 MB again (the 26th image).
  for (let n = 17; n <= 25; n++) assert.equal(budgetImages(history(n, 1)).dropped, 9, n + ' images');
  assert.equal(budgetImages(history(26, 1)).dropped, 18, 'past the high mark again, one more step');
});

test('an image the person attached is named as theirs; one image larger than the budget is still sent', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'look' }, img(10)] },
    { role: 'user', content: [{ type: 'text', text: 'and this' }, img(10)] },
  ];
  const out = budgetImages(messages);
  assert.match(out.messages[0].content[1].text, /attached here earlier/);
  assert.equal(out.messages[1].content[1].type, 'image');
  assert.ok(budgetImages([{ role: 'user', content: [img(20)] }]) === null, 'nothing older to drop');
});

test('Pi loads the extension and its context handler rewrites the request', { skip: !fs.existsSync(loaderPath) && 'pi package not found' }, async () => {
  const saved = process.env.JITI_FS_CACHE;
  process.env.JITI_FS_CACHE = 'false';
  try {
    const { loadExtensions } = await import(pathToFileURL(loaderPath).href);
    const loaded = await loadExtensions([extPath], process.cwd());
    assert.deepEqual(loaded.errors, []);
    const handlers = loaded.extensions[0].handlers.get('context');
    assert.equal(handlers.length, 1);
    assert.equal(await handlers[0]({ type: 'context', messages: history(5, 1) }, {}), undefined, 'small: untouched');
    const out = await handlers[0]({ type: 'context', messages: history(20, 1) }, {});
    assert.ok(imageBytes(out.messages) <= 16 * MB);
  } finally { if (saved === undefined) delete process.env.JITI_FS_CACHE; else process.env.JITI_FS_CACHE = saved; }
});
