'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MIN_CALIBRATION_SAMPLES, PricingCatalog, UsageIndex, aggregateFacts, calculateCost, classifyBilling,
  normalizeSpeedSample, normalizeUsage, parseUsageFile, speedStatistics,
} = require('../usageanalytics.js');

test('normalizes Pi and Claude token classes without double counting reasoning', () => {
  assert.deepEqual(normalizeUsage({
    input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 5, reasoning: 7,
    totalTokens: 100, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  }, 'pi'), {
    input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 5,
    reasoning: 7, totalTokens: 100,
    cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
  });
  assert.equal(normalizeUsage({
    input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40,
  }, 'claude').totalTokens, 100);
});

test('Pi cost calculation applies tiers and one-hour cache writes', () => {
  const cost = calculateCost({
    input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25,
    tiers: [{ inputTokensAbove: 100, input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5 }],
  }, { input: 50, output: 10, cacheRead: 20, cacheWrite: 40, cacheWrite1h: 10 });
  assert.equal(cost.input, 0.0005);
  assert.equal(cost.output, 0.00045);
  assert.equal(cost.cacheRead, 0.00002);
  assert.equal(cost.cacheWrite, 0.000575);
  assert.equal(cost.total, 0.001545);
});

test('billing rules override safe provider and credential inferences', () => {
  const fact = { provider: 'anthropic', source: 'pi', estimatedCost: 1 };
  assert.equal(classifyBilling(fact, { providerModes: {} }, { anthropic: 'oauth' }).mode, 'subscription');
  assert.equal(classifyBilling(fact, { providerModes: { anthropic: 'api' } }, { anthropic: 'oauth' }).mode, 'api');
  assert.equal(classifyBilling({ provider: 'openrouter', source: 'pi', estimatedCost: 1 }, { providerModes: {} }, { openrouter: 'oauth' }).mode, 'api');
});

test('parses assistant, compaction, and Claude sidechain usage', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chattering-usage-')));
  const piFile = path.join(dir, 'pi.jsonl');
  fs.writeFileSync(piFile, [
    { type: 'model_change', id: 'm', timestamp: '2026-01-01T00:00:00Z', provider: 'openai', modelId: 'gpt-x' },
    { type: 'message', id: 'a', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', provider: 'openai', model: 'gpt-x', usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, cost: { total: 0.25 } } } },
    { type: 'compaction', id: 'c', timestamp: '2026-01-01T00:00:02Z', usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } },
  ].map(JSON.stringify).join('\n'));
  const { facts } = await parseUsageFile(piFile, { source: 'pi' }, new PricingCatalog());
  assert.deepEqual(facts.map(f => f.category), ['assistant', 'compaction']);
  assert.equal(facts[0].totalTokens, 15);
  assert.equal(facts[1].model, 'gpt-x');

  const claudeFile = path.join(dir, 'claude.jsonl');
  fs.writeFileSync(claudeFile, JSON.stringify({
    type: 'assistant', uuid: 'x', isSidechain: true, timestamp: '2026-01-02T00:00:00Z',
    message: { model: 'claude-x', usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4 } },
  }));
  const { facts: claude } = await parseUsageFile(claudeFile, { source: 'claude' }, new PricingCatalog());
  assert.equal(claude[0].category, 'subagent');
  assert.equal(claude[0].totalTokens, 9);
});

test('SQLite index deduplicates copied fork entries and aggregates by project', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chattering-usage-db-')));
  const transcript = path.join(dir, 'one.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({
    type: 'message', id: 'shared', timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'assistant', provider: 'openai', model: 'gpt-x', usage: {
      input: 100, output: 20, cacheRead: 50, cacheWrite: 0, cost: { total: 0.5 },
    } },
  }));
  const idx = new UsageIndex(path.join(dir, 'usage.db'));
  const entry = { source: 'pi', mtimeMs: fs.statSync(transcript).mtimeMs, size: fs.statSync(transcript).size, project: 'Alpha' };
  await idx.updateFile('pi:a', entry, transcript, new PricingCatalog());
  await idx.updateFile('pi:b', entry, transcript, new PricingCatalog());
  const facts = idx.facts(0, Date.now());
  assert.equal(facts.length, 1);
  const data = aggregateFacts(facts, { billing: { providerModes: { openai: 'api' } }, fromMs: 0, toMs: Date.now() });
  assert.equal(data.summary.calls, 1);
  assert.equal(data.summary.tokens, 170);
  assert.equal(data.summary.apiCost, 0.5);
  assert.equal(data.projects[0].project, 'Alpha');
});

const speedSample = (overrides = {}) => ({
  entryId: 'r1', at: 1767225600000, provider: 'acme', model: 'fast-1', stopReason: 'stop', thinkingLevel: 'off',
  waitMs: 900, startMs: 400,
  text: { chars: 1200, timedChars: 1000, ms: 4000, chunks: 30 },
  thinking: { chars: 0, timedChars: 0, ms: 0, chunks: 0 },
  tool: { chars: 0, timedChars: 0, ms: 0, chunks: 0 },
  usage: { output: 300, reasoning: 0 },
  ...overrides,
});

test('reply-speed entries are read from transcripts and deduplicated across forks', async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chattering-usage-speed-')));
  const transcript = path.join(dir, 'one.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'model_change', id: 'm', timestamp: '2026-01-01T00:00:00Z', provider: 'acme', modelId: 'fast-1' },
    { type: 'message', id: 'r1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', provider: 'acme', model: 'fast-1', usage: { input: 1, output: 300, cacheRead: 0, cacheWrite: 0 } } },
    { type: 'custom', customType: 'chattering-speed', id: 's1', timestamp: '2026-01-01T00:00:05Z', data: { v: 1, samples: [
      speedSample(),
      // No entry id (the reply could not be matched): keyed by the entry that holds it.
      speedSample({ entryId: null, provider: null, model: null, text: { chars: 50, timedChars: 0, ms: 0, chunks: 0 } }),
      // Nothing streamed: not a sample.
      speedSample({ entryId: 'r3', text: { chars: 0, timedChars: 0, ms: 0, chunks: 0 } }),
    ] } },
  ].map(JSON.stringify).join('\n'));
  const { facts, speed } = await parseUsageFile(transcript, { source: 'pi' }, new PricingCatalog());
  assert.equal(facts.length, 1);
  assert.deepEqual(speed.map(s => s.sampleKey), ['speed:s1:2026-01-01T00:00:05Z#0', 'speed:s1:2026-01-01T00:00:05Z#1']);
  assert.equal(speed[1].provider, 'acme', 'falls back to the file\'s current model');
  assert.equal(speed[0].ts, 1767225600000);

  const idx = new UsageIndex(path.join(dir, 'usage.db'));
  const entry = { source: 'pi', mtimeMs: fs.statSync(transcript).mtimeMs, size: fs.statSync(transcript).size, project: 'Alpha' };
  await idx.updateFile('pi:a', entry, transcript, new PricingCatalog());
  await idx.updateFile('pi:b', entry, transcript, new PricingCatalog());
  const rows = idx.speedSamples(0, Date.now());
  assert.equal(rows.length, 2, 'the fork copy does not double the samples');
  const rebuilt = new UsageIndex(path.join(dir, 'rebuilt.db'));
  t.after(() => { rebuilt.db.close(); idx.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await rebuilt.updateFile('pi:a', entry, transcript, new PricingCatalog());
  assert.deepEqual(rebuilt.speedSamples(0, Date.now()), rows, 'all timing survives a fresh derived database');
  assert.equal(idx.status().indexedEvents, 1, 'speed records are not extra billed calls');
  assert.deepEqual(rows[0].text, { chars: 1200, timedChars: 1000, ms: 4000, chunks: 30 });
  assert.equal(rows[0].usage.reasoning, 0);
  assert.equal(rows[0].project, 'Alpha');
  // Dropping the last owner sweeps the samples with it.
  await idx.startSync([], () => transcript, new PricingCatalog());
  assert.equal(idx.speedSamples(0, Date.now()).length, 0);
});

test('speed statistics calibrate per model from clean replies and rate the answer text only', () => {
  const samples = [];
  // Ten clean replies at 5 chars per token, 250 chars/s.
  for (let i = 0; i < MIN_CALIBRATION_SAMPLES; i++) {
    samples.push(speedSample({ ts: i, text: { chars: 1500, timedChars: 1000, ms: 4000, chunks: 20 }, usage: { output: 300, reasoning: 0 } }));
  }
  // One slow reply, one fast reply, one too short to rate, one with thinking on (rated, not calibrated).
  samples.push(speedSample({ ts: 20, text: { chars: 600, timedChars: 500, ms: 5000, chunks: 10 } }));
  samples.push(speedSample({ ts: 21, text: { chars: 2100, timedChars: 2000, ms: 2000, chunks: 40 } }));
  samples.push(speedSample({ ts: 22, text: { chars: 60, timedChars: 50, ms: 100, chunks: 3 }, waitMs: 100 }));
  samples.push(speedSample({ ts: 23, thinkingLevel: 'high', thinking: { chars: 800, timedChars: 700, ms: 3000, chunks: 12 }, text: { chars: 1100, timedChars: 1000, ms: 4000, chunks: 20 } }));
  // Another model with too few clean replies keeps the default ratio.
  samples.push(speedSample({ ts: 30, model: 'slow-2', text: { chars: 500, timedChars: 400, ms: 4000, chunks: 8 } }));
  const stats = speedStatistics(samples);
  assert.deepEqual(stats.models.map(m => m.id), ['acme/fast-1', 'acme/slow-2']);
  const fast = stats.models[0];
  assert.equal(fast.samples, 14);
  // Thinking summaries and tiny replies are left out; the median ratio holds at 5.
  assert.deepEqual(fast.calibration, { charsPerToken: 5, samples: MIN_CALIBRATION_SAMPLES + 2, calibrated: true });
  assert.equal(fast.charsPerSecond.samples, 13, 'the 100 ms reply is not rated');
  assert.equal(fast.charsPerSecond.min, 100);
  assert.equal(fast.charsPerSecond.median, 250);
  assert.equal(fast.charsPerSecond.max, 1000);
  assert.equal(fast.tokensPerSecond.median, 50);
  assert.equal(fast.tokensPerSecond.min, 20);
  assert.equal(fast.waitMs.samples, 14);
  assert.equal(fast.waitMs.min, 100);
  const slow = stats.models[1];
  assert.deepEqual(slow.calibration, { charsPerToken: 4, samples: 1, calibrated: false });
  assert.equal(slow.tokensPerSecond.median, 25);
});

test('provider and day distributions pool replies using their own model ratios, not medians of medians', () => {
  const samples = Array.from({ length: 10 }, () => speedSample({ text: { chars: 1500, timedChars: 1000, ms: 4000, chunks: 20 } }));
  samples.push(speedSample({ model: 'other', text: { chars: 1000, timedChars: 800, ms: 2000, chunks: 10 } }));
  const stats = speedStatistics(samples);
  // fast-1 learns 5 chars/token (50 tok/s); other uses default 4 (100 tok/s).
  for (const group of [stats.providers[0], stats.daily[0]]) {
    assert.equal(group.tokensPerSecond.samples, 11);
    assert.equal(group.tokensPerSecond.min, 50);
    assert.equal(group.tokensPerSecond.median, 50);
    assert.equal(group.tokensPerSecond.max, 100);
  }
});

test('malformed timing is rejected instead of manufacturing a zero or infinite rate', () => {
  for (const bad of [null, {}, { ...speedSample(), at: 0 }, { ...speedSample(), waitMs: '12' },
    { ...speedSample(), text: { chars: 3, timedChars: 200, ms: 1000, chunks: 2 } },
    { ...speedSample(), text: { chars: 500, timedChars: 400, ms: Infinity, chunks: 2 } },
    { ...speedSample(), text: { chars: 500, timedChars: 400, ms: 2000, chunks: 1 } }]) {
    assert.equal(normalizeSpeedSample(bad), null);
  }
  assert.equal(normalizeSpeedSample(speedSample({ usage: { output: 300, reasoning: '0' } })).usage.reasoning, null);
});

test('failed and aborted replies remain recorded but never enter comparison distributions', () => {
  const stats = speedStatistics([speedSample(), speedSample({ stopReason: 'aborted', waitMs: 1 }), speedSample({ stopReason: 'error', waitMs: 2 })]);
  assert.equal(stats.models[0].samples, 3);
  assert.equal(stats.models[0].tokensPerSecond.samples, 1);
  assert.equal(stats.models[0].waitMs.samples, 1);
  assert.equal(stats.models[0].calibration.samples, 1);
});

test('measurement UUIDs keep identical short Pi entry ids from unrelated sessions separate', async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'chattering-speed-identities-')));
  const idx = new UsageIndex(path.join(dir, 'usage.db'));
  t.after(() => { idx.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const measurementId of ['record-one', 'record-two']) {
    const file = path.join(dir, measurementId + '.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'custom', id: 'same-short-id', customType: 'chattering-speed', data: { v: 1, measurementId, samples: [speedSample()] } }));
    const st = fs.statSync(file);
    await idx.updateFile('pi:' + measurementId, { source: 'pi', project: 'test', mtimeMs: st.mtimeMs, size: st.size }, file, new PricingCatalog());
  }
  assert.equal(idx.speedSamples(0, Date.now()).length, 2);
});

test('each call belongs to the person whose message it answers; a terminal message to nobody known', async () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-people-')));
  try {
    const f = path.join(dir, 's.jsonl');
    const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } };
    const rows = [
      { type: 'session', id: 's', cwd: '/x' },
      { type: 'custom', customType: 'chattering-author', id: 'a1', parentId: null, data: { v: 1, user: { id: 'u_lilly', name: 'Lilly' } } },
      { type: 'message', id: 'm1', parentId: 'a1', timestamp: '2026-09-26T10:00:00Z', message: { role: 'user', content: 'hi' } },
      { type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-09-26T10:00:01Z', message: { role: 'assistant', provider: 'p', model: 'm', usage } },
      { type: 'message', id: 't1', parentId: 'm2', timestamp: '2026-09-26T10:00:02Z', message: { role: 'toolResult', content: [] } },
      { type: 'message', id: 'm3', parentId: 't1', timestamp: '2026-09-26T10:00:03Z', message: { role: 'assistant', provider: 'p', model: 'm', usage } },
      { type: 'message', id: 'm4', parentId: 'm3', timestamp: '2026-09-26T10:00:04Z', message: { role: 'user', content: 'typed in a terminal' } },
      { type: 'message', id: 'm5', parentId: 'm4', timestamp: '2026-09-26T10:00:05Z', message: { role: 'assistant', provider: 'p', model: 'm', usage } },
    ];
    fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const { facts } = await require('../usageanalytics.js').parseUsageFile(f, { source: 'pi' });
    assert.deepEqual(facts.map(x => x.person), ['u_lilly', 'u_lilly', null], 'the tool round stays hers; the terminal message is not guessed');
    const agg = require('../usageanalytics.js').aggregateFacts(facts.map(x => ({ ...x, project: 'x' })));
    assert.deepEqual(agg.people.map(p => [p.person, p.calls]).sort(), [['u_lilly', 2], ['unattributed', 1]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
