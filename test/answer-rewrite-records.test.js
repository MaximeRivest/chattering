'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const vm = require('node:vm');
const { parseUsageFile, PricingCatalog } = require('../usageanalytics');
const { CUSTOM_TYPE, PROMPT } = require('../pisdk-rewrite');

test('saved history hides the request, links both answers, and counts successful and failed rewriting costs', async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'answer-rewrite-records-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const response = text => ({ role: 'assistant', provider: 'test', model: 'one', content: [{ type: 'text', text }], usage: { input: 5, cacheRead: 100, output: 10, cost: { total: 0.1 } } });
  fs.writeFileSync(file, [
    { type: 'session', id: 'session', cwd: dir },
    { type: 'message', id: 'q', parentId: null, message: { role: 'user', content: 'Explain it.' } },
    { type: 'message', id: 'a', parentId: 'q', message: response('Technical original.') },
    { type: 'custom_message', id: 'request', parentId: 'a', customType: CUSTOM_TYPE, content: PROMPT, display: false, details: { sourceEntryId: 'a' } },
    { type: 'message', id: 's', parentId: 'request', message: { ...response('Everyday explanation.'), chatteringRewrite: { sourceEntryId: 'a', requestId: 'request' } } },
    { type: 'custom', id: 'failed', parentId: 's', customType: CUSTOM_TYPE, data: { state: 'failed', response: { ...response('Incomplete'), stopReason: 'length' } } },
  ].map(JSON.stringify).join('\n'));
  const source = fs.readFileSync(require.resolve('../server'), 'utf8');
  const start = source.indexOf('async function parseFile(absPath) {'), end = source.indexOf('\nasync function transcriptImage(', start);
  assert.ok(start >= 0 && end > start);
  const context = { fs, readline, settingsLib: require('../settings'), conversationFlow: require('../conversation-flow'),
    textOf: content => typeof content === 'string' ? content : (content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'),
    toolEventsOf: () => [], directImagesOf: () => [], pathCandidates: () => [], isNoise: () => false };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  const parsed = await context.parseFile(file);
  assert.deepEqual(Array.from(parsed.messages, m => m.text), ['Explain it.', 'Technical original.', 'Everyday explanation.']);
  assert.equal(parsed.messages[2].rewriteOf, 'a');
  assert.ok(parsed.entryParents.some(([id]) => id === 'request'), 'hidden request stays in the ancestry');
  const { facts } = await parseUsageFile(file, { source: 'pi' }, new PricingCatalog());
  assert.equal(facts.length, 3);
  assert.equal(facts.at(-1).category, 'internal');
  assert.equal(facts.at(-1).stopReason, 'length');
  assert.equal(facts.at(-1).cacheRead, 100);
  assert.equal(facts.at(-1).estimatedCost, 0.1);
});
