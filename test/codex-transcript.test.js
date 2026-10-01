'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCodexRollout, codexImageAt, isRollout, splitIdeContext, toolOutput, patchPaths } = require('../harness/codex-transcript');
const { parseUsageFile } = require('../usageanalytics');
const { linkImportCopies } = require('../harness/codex-links');
const fx = require('./helpers/codex-fixtures');

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-transcript-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, files: fx.writeCodexHome(dir, '/work/zoo') };
}
const roles = r => r.messages.map(m => m.role);

test('current generation: the person\'s words, not the injected context; answers, reasoning, tools and outcomes', async t => {
  const { files } = home(t);
  const r = await parseCodexRollout(files.current);
  const users = r.messages.filter(m => m.role === 'user');
  assert.deepEqual(users.map(m => m.text), ['Why does the parrot fixture fail?', 'Can you also check the owl fixture?', 'What is left?']);
  assert.match(users[0].context, /Active file: src\/app\.ts/, 'IDE context is kept beside the words');
  assert.equal(users[1].input, 'voice');
  assert.ok(!r.messages.some(m => /AGENTS\.md|environment_context|permissions instructions/.test(m.text || '')), 'no injected instructions are shown');
  assert.deepEqual(r.messages.filter(m => m.role === 'assistant').map(m => [m.text, m.model, m.provider]),
    [['The parrot said quack; it now says squawk.', 'gpt-fixture', 'codex'], ['Only the owl.', 'gpt-fixture', 'codex']]);
  assert.equal(r.messages.find(m => m.role === 'thinking').text, '**Checking the tests**');
  const exec = r.messages.find(m => m.role === 'tool' && m.name === 'exec_command');
  assert.equal(exec.text, 'npm test -- parrot');
  const failed = r.messages.find(m => m.role === 'toolresult' && m.tid === 'call_exec');
  assert.equal(failed.err, true, 'exit code 1 is a failure');
  const patch = r.messages.find(m => m.role === 'tool' && m.name === 'apply_patch');
  assert.equal(patch.text, 'update src/parrot.js');
  assert.deepEqual(patch.writes, ['/work/zoo/src/parrot.js']);
  assert.equal(r.messages.find(m => m.tid === 'call_patch').err, false);
  assert.ok(roles(r).includes('abort'));
  assert.ok(r.messages.some(m => m.role === 'event' && m.customType === 'compaction'));
  assert.equal(r.meta.sessionId, '01a0f000-0000-7000-8000-000000000001');
  assert.equal(r.meta.cwd, '/work/zoo');
  assert.equal(r.meta.gitBranch, 'main');
  assert.equal(r.meta.firstTs, '2026-09-20T10:00:00.000Z');
  assert.equal(r.meta.lastTs, '2026-09-20T10:00:16.000Z');
  assert.deepEqual(r.meta.ctx, { used: 830, provider: 'codex', model: 'gpt-fixture', window: 200000 });
  assert.equal(r.meta.codex.effort, 'high');
  assert.equal(users[0].turnId, 'turn-1');
  assert.equal(users[2].turnId, 'turn-2');
});

test('a conversation is a line of stable entries, every message on it', async t => {
  const { files } = home(t);
  const r = await parseCodexRollout(files.current);
  const ids = r.entryParents.map(e => e[0]);
  assert.equal(new Set(ids).size, ids.length);
  r.entryParents.forEach(([id, parent], i) => assert.equal(parent, i ? ids[i - 1] : null));
  for (const m of r.messages) assert.ok(ids.includes(m.eid), m.role + ' ' + m.eid);
  assert.deepEqual((await parseCodexRollout(files.current)).entryParents, r.entryParents, 'ids do not change between reads');
});

test('pasted pictures are served from their own record, lazily', async t => {
  const { files } = home(t);
  const r = await parseCodexRollout(files.current);
  const img = r.messages.find(m => m.role === 'user').images[0];
  assert.deepEqual(img, { entry: img.entry, path: '0', mime: 'image/png' });
  const body = await codexImageAt(files.current, img.entry, img.path);
  assert.equal(body.mime, 'image/png');
  assert.deepEqual(body.body, Buffer.from(fx.PNG, 'base64'));
  await assert.rejects(codexImageAt(files.current, img.entry, '5'), /not found/);
  await assert.rejects(codexImageAt(files.current, img.entry.replace(/L\d+$/, 'L1'), '0'), /not found/);
  await assert.rejects(codexImageAt(files.current, '../x', '0'), /bad image/);
});

test('a Codex fork reads its original\'s history up to the fork point, with the original\'s ids', async t => {
  const { files } = home(t);
  const parent = await parseCodexRollout(files.current);
  const fork = await parseCodexRollout(files.forked);
  assert.deepEqual(fork.messages.filter(m => m.role === 'user').map(m => m.text), ['Why does the parrot fixture fail?', 'In this branch, try the heron instead']);
  assert.deepEqual(fork.messages.filter(m => m.role === 'assistant').map(m => m.text), ['The parrot said quack; it now says squawk.', 'The heron fixture passes.']);
  const inheritedIds = fork.messages.filter(m => m.inherited).map(m => m.eid);
  assert.ok(inheritedIds.length && inheritedIds.every(id => parent.messages.some(m => m.eid === id)), 'inherited entries keep the original\'s ids');
  const shared = new Set(parent.entryParents.map(([id]) => id));
  const firstOwn = fork.entryParents.find(([id]) => !shared.has(id));
  assert.ok(shared.has(firstOwn[1]), 'the fork\'s first entry hangs under an entry of the original: one tree');
  assert.equal(fork.meta.parentSession, files.current);
  assert.equal(fork.meta.rootId, parent.meta.rootId, 'one family');
  assert.equal(fork.meta.codex.forkedFromId, '01a0f000-0000-7000-8000-000000000001');
  const all = fork.entryParents.map(([id]) => id);
  assert.equal(new Set(all).size, all.length);
});

test('early JSONL: no UI records, so model-visible user items minus injected context; approximate times', async t => {
  const { files } = home(t);
  const r = await parseCodexRollout(files.early, { mtimeMs: Date.parse('2025-08-21T13:00:00Z') });
  assert.deepEqual(r.messages.filter(m => m.role === 'user').map(m => m.text), ['List the heron files']);
  assert.equal(r.messages.find(m => m.role === 'tool').text, 'ls herons');
  assert.equal(r.messages.find(m => m.role === 'toolresult').text, 'heron.md\n');
  assert.equal(r.messages.find(m => m.role === 'assistant').text, 'One heron file: heron.md');
  assert.equal(r.meta.codex.generation, 2);
  assert.equal(r.meta.firstTs, '2025-08-21T12:52:33.287Z');
  assert.equal(r.meta.lastTs, '2025-08-21T13:00:00.000Z');
  assert.equal(r.meta.codex.timesApproximate, true);
});

test('mid-2025 single-document conversations read the same way', async t => {
  const { files } = home(t);
  assert.ok(isRollout(files.legacy) && isRollout('x/rollout-a.jsonl') && !isRollout('chat.jsonl') && !isRollout('rollout.txt'));
  const r = await parseCodexRollout(files.legacy);
  assert.equal(r.meta.codex.generation, 1);
  assert.deepEqual(roles(r), ['user', 'tool', 'toolresult', 'assistant']);
  assert.equal(r.messages[1].text, 'ls');
  assert.equal(r.meta.sessionId, 'b0000000-0000-4000-8000-000000000003');
});

test('imported copies: marked, their command echoes and import marker not shown, linked only on strong evidence', async t => {
  const { files } = home(t);
  const r = await parseCodexRollout(files.imported);
  assert.equal(r.meta.codex.imported, true);
  assert.deepEqual(r.messages.filter(m => m.role === 'user').map(m => m.text), ['Explain the kestrel parser']);
  assert.ok(!r.messages.some(m => /EXTERNAL SESSION|command-name/.test(m.text)));
  const copy = { source: 'codex', cwd: '/work/zoo', title: 'Explain the kestrel parser', firstTs: '2026-09-21T09:00:00Z', codex: { imported: true } };
  const original = { source: 'claude', cwd: '/work/zoo', title: 'Explain  the kestrel parser', firstTs: '2026-09-01T10:00:00Z', lastTs: '2026-09-01T11:00:00Z' };
  assert.deepEqual([...linkImportCopies([['codex:c', copy], ['claude:o', original]])], [['codex:c', 'claude:o']]);
  assert.equal(linkImportCopies([['codex:c', copy], ['claude:o', { ...original, cwd: '/elsewhere' }]]).size, 0, 'another folder is another conversation');
  assert.equal(linkImportCopies([['codex:c', copy], ['claude:o', { ...original, title: 'Explain the kestrel lexer' }]]).size, 0);
  assert.equal(linkImportCopies([['codex:c', copy], ['claude:o', { ...original, firstTs: '2026-09-22T10:00:00Z' }]]).size, 0, 'a copy cannot predate its original');
  assert.equal(linkImportCopies([['codex:c', { ...copy, codex: {} }], ['claude:o', original]]).size, 0, 'only imports are copies');
});

test('usage: per-call tokens from the growth of Codex\'s running total, a repeated count counted once', async t => {
  const { files } = home(t);
  const { facts } = await parseUsageFile(files.current, { source: 'codex', sessionId: 's' });
  assert.equal(facts.length, 2);
  assert.deepEqual(facts.map(f => [f.input, f.cacheRead, f.output, f.reasoning, f.totalTokens, f.provider, f.model, f.source]),
    [[400, 600, 50, 20, 1050, 'openai-codex', 'gpt-fixture', 'codex'], [400, 400, 30, 0, 830, 'openai-codex', 'gpt-fixture', 'codex']]);
  assert.notEqual(facts[0].eventKey, facts[1].eventKey);
});

test('small readers: IDE context, tool outputs, patch headers', () => {
  assert.deepEqual(splitIdeContext('plain'), { text: 'plain', context: null });
  assert.equal(splitIdeContext('# Context from my IDE setup:\n\n## My request for Codex:\ndo it').text, 'do it');
  assert.deepEqual(toolOutput('{"output":"ok","metadata":{"exit_code":2}}'), { text: 'ok', exit: 2 });
  assert.deepEqual(toolOutput('Process exited with code 0\nOutput:\nhi'), { text: 'Process exited with code 0\nOutput:\nhi', exit: 0 });
  assert.deepEqual(toolOutput('just text'), { text: 'just text', exit: null });
  assert.deepEqual(patchPaths('*** Add File: a.js\n*** Update File: b.js\n*** Move to: c.js\n*** Delete File: d.js'), ['a.js', 'b.js', 'd.js', 'c.js']);
});

test('a partly written last line is skipped, not an error', async t => {
  const { dir } = home(t);
  const f = path.join(dir, 'rollout-partial.jsonl');
  fs.writeFileSync(f, fx.currentRollout('/w').split('\n').slice(0, 8).join('\n') + '\n{"timestamp":"2026-09-20T10:00:09.000Z","type":"respo');
  const r = await parseCodexRollout(f);
  assert.equal(r.messages.filter(m => m.role === 'user').length, 1);
});
