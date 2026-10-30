import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const fn = source.slice(source.indexOf('async function transcriptEditResponse('), source.indexOf('\nasync function fileBlameResponse('));
function fixture(role = 'assistant', active = false) {
  const original = { type: 'message', id: 'old', parentId: 'parent', message: { role, content: [{ type: 'text', text: 'old' }] } };
  const target = { m: { eid: 'old', role }, raw: 'old', lines: ['original', ''], d: structuredClone(original), apply(text) { this.d.message.content[0].text = text; } };
  let appended;
  const ctx = vm.createContext({
    sessionPathsFor: () => ({ entry: { source: 'pi' }, sessionPath: '/session' }), isPiSource: s => s === 'pi', harnessOfSource: s => String(s).split('@')[0],
    withSessionOp: async (_, work) => work(), headlessRuns: new Map(active ? [['/session', {}]] : []), agentRunJobs: new Map(),
    findRunningConversation: () => null, stopAnyWarmSession() {}, transcriptTarget: async () => target,
    sha256Hex: x => x, crypto: { randomBytes: () => ({ toString: () => 'new' }) },
    assertRunsHere() {}, backgroundPrincipalFor: () => null,
    conversationFile: () => ({ append: async text => { appended = JSON.parse(text); } }), reindexIfChanged: async () => {},
  });
  vm.runInContext(fn, ctx);
  return { run: overrides => ctx.transcriptEditResponse({ id: 'key', i: 0, eid: 'old', baseSha: 'old', text: 'corrected', branch: true, ...overrides }), original, get appended() { return appended; } };
}
for (const role of ['assistant', 'user']) test(`${role} correction appends a sibling and preserves original`, async () => {
  const f = fixture(role);
  const result = await f.run();
  assert.equal(result.branched, true);
  assert.equal(f.appended.parentId, 'parent');
  assert.equal(f.appended.id, 'new');
  assert.equal(f.appended.message.content[0].text, 'corrected');
  assert.equal(f.appended.chattering.kind, 'edit');
  assert.equal(f.appended.chattering.sourceEntryId, 'old');
  assert.equal(f.original.message.content[0].text, 'old');
});
test('stale identity and content cannot create branches', async () => {
  for (const overrides of [{ eid: 'other' }, { baseSha: 'stale' }]) {
    const f = fixture();
    await assert.rejects(f.run(overrides), /message changed/);
    assert.equal(f.appended, undefined);
  }
});
test('active runs cannot be edited', async () => {
  const f = fixture('assistant', true);
  await assert.rejects(f.run(), /Stop the active run/);
  assert.equal(f.appended, undefined);
});
