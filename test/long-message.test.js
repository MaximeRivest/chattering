const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Very long messages (app.html): only the opening is built when a
// conversation opens; the whole text waits for a click.
const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const start = html.indexOf('// ---- very long messages ----');
const end = html.indexOf('\nfunction msgBlock(', start);
assert.ok(start > 0 && end > start, 'the long-message block is in app.html');

function load() {
  const rendered = [];
  const ctx = vm.createContext({
    mdRender: (s, q) => { rendered.push({ length: s.length, q }); return `<p>${s.length}</p>`; },
    termRegex: q => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  });
  new vm.Script(html.slice(start, end) + '\n;globalThis.api = { messageBodyHtml, countLines, countWords, LONG_MESSAGE_CHARS, LONG_MESSAGE_PREVIEW_CHARS, LONG_MESSAGE_MARKDOWN_MAX };').runInContext(ctx);
  return { api: ctx.api, rendered };
}
const pasted = chars => {
  const line = 'const value = compute(input, 42); // a pasted log line\n';
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
};

test('an ordinary message renders whole, as before', () => {
  const { api, rendered } = load();
  const text = pasted(50000);
  assert.equal(api.messageBodyHtml(text, 'q', 3), '<p>50000</p>');
  assert.deepEqual(rendered, [{ length: 50000, q: 'q' }]);
});

test('a very long message builds only its opening, cut at a line end, with a button for the rest', () => {
  const { api, rendered } = load();
  const text = pasted(5_000_000);
  const out = api.messageBodyHtml(text, '', 7);
  assert.equal(rendered.length, 1);
  assert.ok(rendered[0].length <= api.LONG_MESSAGE_PREVIEW_CHARS);
  assert.equal(text[rendered[0].length], '\n', 'the opening ends at a line end');
  assert.match(out, /class="msg-show-all" data-msg-index="7"/);
  assert.match(out, /90,910 lines · 5\.0 MB · as plain text/);
});

test('a long message still small enough for Markdown says so', () => {
  const { api } = load();
  const out = api.messageBodyHtml(pasted(api.LONG_MESSAGE_CHARS + 1000), '', 0);
  assert.match(out, /msg-show-all/);
  assert.doesNotMatch(out, /plain text/);
});

test('a search hit past the opening shows the whole message while it can be Markdown', () => {
  const { api, rendered } = load();
  const text = pasted(200000) + 'needle\n';
  api.messageBodyHtml(text, 'needle', 0);
  assert.deepEqual(rendered, [{ length: text.length, q: 'needle' }]);
  // Too long for Markdown: the opening stays, the hit is one click away.
  const { api: api2, rendered: r2 } = load();
  const huge = pasted(api2.LONG_MESSAGE_MARKDOWN_MAX + 1000) + 'needle\n';
  assert.match(api2.messageBodyHtml(huge, 'needle', 0), /msg-show-all/);
  assert.ok(r2[0].length <= api2.LONG_MESSAGE_PREVIEW_CHARS);
});

test('line and word counts match the simple versions', () => {
  const { api } = load();
  for (const s of ['', 'a', 'a b', ' a  b\n\nc ', 'x\ty\u00a0z\n']) {
    assert.equal(api.countLines(s), s.split('\n').length, JSON.stringify(s));
    assert.equal(api.countWords(s), (s.match(/[^\s]+/g) || []).length, JSON.stringify(s));
  }
});
