'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Flow = require('../conversation-flow.js');
const fanoutLib = require('../fanout.js');
const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
function extract(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return source.slice(a, b); }
function graphFixture(files) {
  const index = Object.fromEntries(Object.keys(files).map(key => [key, { source: 'pi', title: key }]));
  const ctx = vm.createContext({ refuseOwnProgramOnly() {}, ownProgramOnly: () => false,
    index, conversationFlow: Flow, fanoutLib,
    fsp: { readFile: async key => files[key] }, absPathForKey: key => key,
    forkFamily: () => Object.keys(files), keyForSessionPath: value => value,
    textOf: content => typeof content === 'string' ? content : (content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'),
    isNoise: () => false, nodeTitle: text => text.slice(0, 90), settingsLib: { usageContextTokens: () => 0 },
  });
  vm.runInContext([
    extract('function parseTreeEntries(', '\nfunction keyForSessionPath('),
    extract('async function familyEntryGraph(', '// Context meter:'),
    extract('async function compareGroupsResponse(', '// Aggregate:'),
  ].join('\n'), ctx);
  return { ctx, index };
}
const msg = (id, parentId, role, text, extra = {}) => ({ type: 'message', id, parentId, timestamp: '2026-01-01T00:00:00Z', message: { role, content: text, model: 'test' }, ...extra });
const raw = entries => entries.map(e => JSON.stringify(e)).join('\n') + '\n';

test('real tree and comparison APIs preserve complete text and stable answer identity through labels', async () => {
  const text = 'complete '.repeat(3000) + 'THE END';
  const entries = [msg('p', null, 'user', 'question'), msg('a', 'p', 'assistant', text), msg('b', 'p', 'assistant', 'alternative'), { type: 'label', id: 'anchor', parentId: 'a' }];
  const { ctx } = graphFixture({ chat: raw(entries) });
  const result = await ctx.compareGroupsResponse('chat');
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].answers[0].id, 'a');
  assert.equal(result.groups[0].answers[0].text, text);
  assert.ok(result.groups[0].answers[0].entryIds.includes('anchor'));
});
test('merge source subsets and include-all snapshots survive API projection', async () => {
  const sources = [{ id: 'a', key: 'chat', model: 'A', entryIds: ['a'] }, { id: 'b', key: 'chat', model: 'B', entryIds: ['b'] }];
  const entries = [msg('p', null, 'user', 'question'), msg('a', 'p', 'assistant', 'A'), msg('b', 'p', 'assistant', 'B'),
    msg('all', 'p', 'assistant', 'A + B\n<!-- chattering:both -->', { chattering: { kind: 'both', sources } }),
    msg('merge', 'p', 'user', '<!-- chattering:merge -->\n<!-- chattering:operation ' + JSON.stringify({ kind: 'merge', sources }) + ' -->'),
    msg('merged', 'merge', 'assistant', 'Combined answer'), msg('later', 'p', 'assistant', 'C')];
  const { ctx } = graphFixture({ chat: raw(entries) });
  const result = await ctx.compareGroupsResponse('chat');
  assert.equal(result.groups[0].answers.length, 3);
  assert.equal(result.groups[0].both.id, 'all');
  assert.deepEqual(Array.from(result.groups[0].merges[0].sources, s => s.id), ['a', 'b']);
});
test('include-all bridges never swallow an assistant continuation into their snapshot', async () => {
  const entries = [msg('p', null, 'user', 'question'), msg('a', 'p', 'assistant', 'A'), msg('b', 'p', 'assistant', 'B'),
    msg('all', 'p', 'assistant', 'A + B\n<!-- chattering:both -->'), msg('follow', 'all', 'assistant', 'Unprompted follow-up')];
  const { ctx } = graphFixture({ chat: raw(entries) });
  const result = await ctx.compareGroupsResponse('chat');
  assert.equal(result.groups[0].both.id, 'all');
  const tree = await ctx.sessionTreeFor('chat', { withTexts: true });
  assert.equal(tree.nodes.find(n => n.id === 'follow').fullText, 'Unprompted follow-up');
});
test('different prompts become labelled paths; separate conversation origin remains linked', async () => {
  const common = [msg('p', null, 'user', 'question'), msg('a', 'p', 'assistant', 'answer')];
  const { ctx, index } = graphFixture({ chat: raw([...common, msg('q1', 'a', 'user', 'first direction')]), fork: raw([...common, msg('q2', 'a', 'user', 'edited direction', { chattering: { kind: 'edit', sourceEntryId: 'q1' } })]) });
  index.fork.parentSession = 'chat';
  const result = await ctx.compareGroupsResponse('fork');
  assert.equal(result.groups.length, 0);
  assert.equal(result.branches.length, 1);
  assert.equal(result.origin.key, 'chat');
  assert.equal(result.origin.entryId, 'a');
});
test('stale continuation confirmation cannot append a branch anchor', async () => {
  let appended = false;
  const ctx = vm.createContext({ refuseOwnProgramOnly() {}, ownProgramOnly: () => false,
    index: { chat: { source: 'pi' } }, absPathForKey: key => key, conversationFlow: Flow,
    headlessRuns: new Map(), agentRunJobs: new Map(), findRunningConversation: () => null,
    withSessionOp: async (_, fn) => fn(), stopAnyWarmSession() {},
    fsp: { readFile: async () => raw([msg('p', null, 'user', 'question'), msg('new', 'p', 'assistant', 'new answer')]), appendFile: async () => { appended = true; } },
  });
  vm.runInContext(extract('async function branchSession(', '\n// ----------'), ctx);
  await assert.rejects(ctx.branchSession('chat', 'p', 'old'), /advanced on another screen/);
  assert.equal(appended, false);
});
