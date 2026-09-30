'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
// The old reading/continuation split and its comparison workspace were replaced
// by one head (design/66); test/one-tree-app.test.js covers the new reader.

test('each box of steps lists its files (design/88); the turn review gathers every box of one reply', () => {
  const vm = require('node:vm');
  const ctx = {
    console, ConversationFlow: require('../conversation-flow.js'),
    esc: s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    termRegex: s => new RegExp(s, 'i'), toolGroupOpen: new Map(),
    isFileWriteTool: m => m.name === 'write', delegateCallOf: m => ({}),
    msgBlock: m => `<div data-eid="${m.eid}">${m.text || ''}</div>`,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'step-changes-ui.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'conversation-reader.js'), 'utf8'), ctx);
  const tool = (eid, id, name, extra = {}) => ({ eid, role: 'tool', id, name, ts: 't' + id, ...extra });
  const result = (eid, tid) => ({ eid, role: 'toolresult', tid });
  const messages = [
    { eid: 'u1', role: 'user', text: 'Fix it' },
    tool('a1', 'c1', 'bash'), result('a1', 'c1'),
    { eid: 'a2', role: 'assistant', text: 'Now the wrappers.' },
    tool('a3', 'c2', 'write', { path: '/p/x.js' }), result('a3', 'c2'),
    tool('a3', 'c3', 'bash'), result('a3', 'c3'),
    { eid: 'a4', role: 'assistant', text: 'Done.' },
    { eid: 'u2', role: 'user', text: 'Thanks, one more' },
    tool('b1', 'c4', 'bash'), result('b1', 'c4'),
    { eid: 'b2', role: 'assistant', text: 'Done again.' },
  ];
  const html = vm.runInContext('transcriptFragmentHtml', ctx)({ key: 'chat', messages }, messages);
  // Each box: its list, drawn at once with the files its write tools name.
  const strips = [...html.matchAll(/<section class="sc-strip"[^>]*data-sc-calls="([^"]*)"[^>]*>/g)].map(m => [m[1], /hidden/.test(m[0])]);
  assert.deepEqual(strips, [['c1', true], ['c2,c3', false], ['c4', true]], 'a box with no known file waits, hidden, for the changes to be read');
  assert.match(html, /class="sc-row sc-wait" data-file-diff="\/p\/x.js"/);
  // No "Review changes" per box any more: the card has it. The turn keeps its own.
  const reviews = [...html.matchAll(/data-step-review="([^"]*)"/g)].map(m => JSON.parse(m[1].replace(/&quot;/g, '"')));
  assert.deepEqual(reviews.map(r => r.calls), [['c1', 'c2', 'c3']], 'turn review must cover both groups of the first reply only');
  assert.match(html, /tg-review-turn" data-sc-turn[^>]*>Review whole turn · 3 steps<span class="sc-turn-files">\u00a0· 1 file<\/span>/);
  assert.match(html, /class="tg-count">1 step<\/span>/);
  assert.match(html, /class="tg-detail" title="bash">bash<\/span>/);
  assert.equal(html.indexOf('Review whole turn') > html.indexOf('Done.') && html.indexOf('Review whole turn') < html.indexOf('Thanks, one more'), true, 'turn review sits after the final answer of its turn');
  assert.equal((html.match(/tg-review-turn/g) || []).length, 1, 'a reply with one tool group gets no duplicate turn button');
});
