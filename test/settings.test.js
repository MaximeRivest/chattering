// Run: node --test test/
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseTokenCount, formatTokenCount, parseListModels, findModel,
  normalizeSettings, buildPiArgs, modelLabel, resolveContextTokens, DEFAULT_SETTINGS,
  hasClaudeCodeCredential, usageContextTokens,
} = require('../settings.js');

const TABLE = [
  'provider      model                                                     context  max-out  thinking  images',
  'anthropic     claude-fable-5                                            1M       128K     yes       yes   ',
  'openai-codex  gpt-5.6-sol                                               272K     128K     yes       yes   ',
  'fireworks     accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b  262.1K   262.1K   yes       no    ',
  'xai           grok-4.6                                                  500K     500K     yes       yes   ',
  'openai        gpt-4                                                     8.2K     8.2K     no        no    ',
].join('\n');

test('parseTokenCount reads K and M labels', () => {
  assert.strictEqual(parseTokenCount('1M'), 1_000_000);
  assert.strictEqual(parseTokenCount('1.0M'), 1_000_000);
  assert.strictEqual(parseTokenCount('272K'), 272000);
  assert.strictEqual(parseTokenCount('131.1K'), 131100);
  assert.strictEqual(parseTokenCount('8.2K'), 8200);
  assert.strictEqual(parseTokenCount(''), 0);
});

test('formatTokenCount keeps compact labels', () => {
  assert.strictEqual(formatTokenCount(272000), '272K');
  assert.strictEqual(formatTokenCount(1_000_000), '1M');
  assert.strictEqual(formatTokenCount(8200), '8.2K');
});

test('parseListModels reads the pi table', () => {
  const models = parseListModels(TABLE);
  assert.strictEqual(models.length, 5);
  assert.deepStrictEqual(models[1], {
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    id: 'openai-codex/gpt-5.6-sol',
    context: 272000,
    contextLabel: '272K',
    maxOut: 128000,
    thinking: true,
    images: true,
  });
  assert.strictEqual(models[2].model, 'accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b');
  assert.strictEqual(models[2].context, 262100);
  assert.strictEqual(models[4].thinking, false);
});

test('normalizeSettings keeps the built-in default', () => {
  assert.deepStrictEqual(normalizeSettings({}), DEFAULT_SETTINGS);
  // A new install follows Pi's own default model (settings version 2).
  assert.strictEqual(normalizeSettings({ thinking: 'high' }).usePiDefault, true);
  assert.strictEqual(normalizeSettings({ thinking: 'high' }).provider, '');
  // Half a fixed choice is no choice: Pi's default, not a guess.
  assert.strictEqual(normalizeSettings({ usePiDefault: false, provider: 'xai' }).usePiDefault, true);
  const fixed = normalizeSettings({ usePiDefault: false, provider: 'xai', model: 'grok-4.6' });
  assert.deepStrictEqual([fixed.usePiDefault, fixed.provider, fixed.model], [false, 'xai', 'grok-4.6']);
  assert.strictEqual(normalizeSettings({ thinking: 'nope' }).thinking, 'off');
});

test('the reach switch is unset until chosen, then a plain boolean', () => {
  for (const usePiDefault of [false, true]) {
    assert.strictEqual(normalizeSettings({ usePiDefault }).lan, null);
    assert.strictEqual(normalizeSettings({ usePiDefault, lan: true }).lan, true);
    assert.strictEqual(normalizeSettings({ usePiDefault, lan: false }).lan, false);
    assert.strictEqual(normalizeSettings({ usePiDefault, lan: 'yes' }).lan, null);
  }
});

test('semantic search has no default server and keeps custom servers', () => {
  for (const usePiDefault of [false, true]) {
    assert.strictEqual(normalizeSettings({ usePiDefault }).semanticUrl, '');
    assert.strictEqual(normalizeSettings({ usePiDefault, semanticUrl: 'not a url' }).semanticUrl, '');
    assert.strictEqual(normalizeSettings({ usePiDefault, semanticUrl: 'http://search.example:8090/' }).semanticUrl, 'http://search.example:8090');
  }
});

test('normalizeSettings can follow the pi default', () => {
  const s = normalizeSettings({ usePiDefault: true, thinking: 'low' });
  assert.strictEqual(s.usePiDefault, true);
  assert.strictEqual(s.provider, '');
  assert.strictEqual(s.model, '');
  assert.strictEqual(s.thinking, 'low');
});

test('normalizeSettings keeps safe usage billing rules', () => {
  const s = normalizeSettings({ usageBilling: {
    providerModes: { anthropic: 'subscription', openai: 'bad' },
    monthlyFees: { anthropic: 100, openai: -2 },
  } });
  assert.deepStrictEqual(s.usageBilling, {
    providerModes: { anthropic: 'subscription' },
    monthlyFees: { anthropic: 100 },
  });
});

test('buildPiArgs includes the selected model', () => {
  const args = buildPiArgs({ provider: 'xai', model: 'grok-4.6', thinking: 'high' });
  assert.deepStrictEqual(args.slice(-6), ['--thinking', 'high', '--provider', 'xai', '--model', 'grok-4.6']);
  assert.ok(args.includes('--no-tools'));
});

test('buildPiArgs omits provider flags for the pi default', () => {
  const args = buildPiArgs({ usePiDefault: true, thinking: 'off' });
  assert.ok(!args.includes('--provider'));
  assert.ok(!args.includes('--model'));
  assert.ok(args.includes('--no-tools'));
});

test('buildPiArgs loads the claude-code extension', () => {
  const ext = '/home/maxime/.pi/agent/extensions/claude-code-fable-5/index.ts';
  const args = buildPiArgs({ provider: 'claude-code', model: 'claude-fable-5' }, { claudeCodeExtension: ext });
  assert.deepStrictEqual(args.slice(-6), ['--provider', 'claude-code', '--model', 'claude-fable-5', '-e', ext]);
  assert.ok(args.includes('--no-extensions'));
  const other = buildPiArgs({ provider: 'xai', model: 'grok-4.6' }, { claudeCodeExtension: ext });
  assert.ok(!other.includes('-e'));
});

test('hasClaudeCodeCredential only checks the login object', () => {
  assert.strictEqual(hasClaudeCodeCredential({ claudeAiOauth: { accessToken: 'x' } }), true);
  assert.strictEqual(hasClaudeCodeCredential({}), false);
  assert.strictEqual(hasClaudeCodeCredential(null), false);
});

test('usageContextTokens counts the whole window footprint', () => {
  // pi usage: cache fields sit outside `input`, so they must be added.
  assert.strictEqual(usageContextTokens({
    input: 89127, output: 454, cacheRead: 2560, cacheWrite: 0, reasoning: 140, totalTokens: 92141,
  }, 'pi'), 92141);
  assert.strictEqual(usageContextTokens({ input: 100, output: 50, cacheWrite: 25 }, 'pi'), 175);
  // claude usage: cache reads and cache creation are also in the window.
  assert.strictEqual(usageContextTokens({
    input_tokens: 12, output_tokens: 88, cache_read_input_tokens: 40000, cache_creation_input_tokens: 500,
  }, 'claude'), 40600);
  // Missing fields never throw and count as zero.
  assert.strictEqual(usageContextTokens({}, 'pi'), 0);
  assert.strictEqual(usageContextTokens(null, 'claude'), 0);
});

test('resolveContextTokens uses the catalog when present', () => {
  const models = parseListModels(TABLE);
  assert.strictEqual(resolveContextTokens({ provider: 'xai', model: 'grok-4.6' }, models), 500000);
  assert.strictEqual(resolveContextTokens({ usePiDefault: true }, models, { provider: 'xai', model: 'grok-4.6' }), 500000);
  assert.strictEqual(findModel(models, 'openai-codex', 'gpt-5.6-sol').id, 'openai-codex/gpt-5.6-sol');
  assert.strictEqual(modelLabel({ provider: 'xai', model: 'grok-4.6' }), 'xai/grok-4.6');
  assert.strictEqual(modelLabel({ usePiDefault: true }, { provider: 'xai', model: 'grok-4.6' }), 'pi default (xai/grok-4.6)');
});

test('normalizeSettings keeps a valid doneSound and falls back to the chime', () => {
  const { DONE_SOUND_MODES } = require('../settings.js');
  assert.deepStrictEqual(DONE_SOUND_MODES, ['off', 'chime', 'title', 'summary', 'voice']);
  for (const mode of DONE_SOUND_MODES) {
    assert.strictEqual(normalizeSettings({ doneSound: mode }).doneSound, mode);
    assert.strictEqual(normalizeSettings({ usePiDefault: true, doneSound: mode }).doneSound, mode);
  }
  assert.strictEqual(normalizeSettings({}).doneSound, 'chime');
  assert.strictEqual(normalizeSettings({ doneSound: 'loud' }).doneSound, 'chime');
  assert.strictEqual(normalizeSettings({ doneSound: 3 }).doneSound, 'chime');
});

// ---- settings version 2: neutral new installs, unchanged old ones ----
const { migrateSettings, normalizeBackgroundAi, settingsInputError, LEGACY_DEFAULTS, SETTINGS_VERSION } = require('../settings.js');

test('a new install gets neutral defaults: no personal address, background AI undecided', () => {
  const { settings, migrated } = migrateSettings(null, { priorInstall: false });
  assert.equal(migrated, true);
  const s = normalizeSettings(settings);
  assert.equal(s.settingsVersion, SETTINGS_VERSION);
  assert.deepStrictEqual(s.backgroundAi, { decidedAt: null, names: false, memory: false });
  for (const k of ['semanticUrl', 'speechUrl', 'ttsUrl', 'ttsVoice', 'voiceModelUrl', 'voiceModel']) assert.equal(s[k], '', k);
  assert.doesNotMatch(JSON.stringify(s), /100\.86\.|192\.168\./);
});

test('an old install keeps every value it was already using, and its background work', () => {
  // No file at all, but the machine ran before: the old code defaults.
  let s = normalizeSettings(migrateSettings(null, { priorInstall: true }).settings);
  for (const [k, v] of Object.entries(LEGACY_DEFAULTS)) assert.equal(s[k], v, k);
  assert.equal(s.usePiDefault, false);
  assert.deepStrictEqual(s.backgroundAi, { decidedAt: 'before-consent', names: true, memory: true });
  // A saved file: what it says wins; only what the old code filled in silently is added.
  const file = { usePiDefault: false, provider: 'anthropic', model: 'claude-x', semanticUrl: 'http://192.168.2.24:8090', doneSound: 'chime', lan: true };
  s = normalizeSettings(migrateSettings(file, { priorInstall: true }).settings);
  assert.deepStrictEqual([s.provider, s.model, s.semanticUrl, s.doneSound, s.lan], ['anthropic', 'claude-x', 'http://192.168.2.24:8090', 'chime', true]);
  assert.equal(s.ttsUrl, LEGACY_DEFAULTS.ttsUrl);
  // The old normalizer treated an empty provider and a missing doneSound as the defaults.
  s = normalizeSettings(migrateSettings({ provider: '', doneSound: 'loud' }, { priorInstall: true }).settings);
  assert.deepStrictEqual([s.provider, s.model, s.doneSound], ['openai-codex', 'gpt-5.6-sol', 'voice']);
  // Pi's default stays Pi's default.
  s = normalizeSettings(migrateSettings({ usePiDefault: true }, { priorInstall: true }).settings);
  assert.equal(s.usePiDefault, true);
});

test('the welcome waits for a new install, and an install that ran before has had it', () => {
  assert.deepStrictEqual(normalizeSettings(migrateSettings(null, { priorInstall: false }).settings).welcome, { doneAt: null });
  assert.deepStrictEqual(normalizeSettings(migrateSettings(null, { priorInstall: true }).settings).welcome, { doneAt: 'before-welcome' });
  // A version 2 file was written by a run of Chattering: done, and nothing else changes.
  const v2 = { settingsVersion: 2, speechUrl: '', provider: 'anthropic', model: 'm', usePiDefault: false, backgroundAi: { decidedAt: null } };
  const { settings, migrated } = migrateSettings(v2, { priorInstall: false });
  assert.equal(migrated, true);
  const s = normalizeSettings(settings);
  assert.deepStrictEqual(s.welcome, { doneAt: 'before-welcome' });
  assert.deepStrictEqual([s.speechUrl, s.provider, s.backgroundAi.decidedAt], ['', 'anthropic', null]);
  assert.equal(s.settingsVersion, SETTINGS_VERSION);
});

test('a migrated file is never migrated again', () => {
  const once = migrateSettings({ settingsVersion: SETTINGS_VERSION, speechUrl: '', backgroundAi: { decidedAt: null } }, { priorInstall: true });
  assert.equal(once.migrated, false);
  assert.equal(normalizeSettings(once.settings).speechUrl, '');
  assert.equal(normalizeSettings(once.settings).backgroundAi.decidedAt, null);
});

test('background AI cannot be on without a dated decision', () => {
  assert.deepStrictEqual(normalizeBackgroundAi({ names: true, memory: true }), { decidedAt: null, names: false, memory: false });
  assert.deepStrictEqual(normalizeBackgroundAi({ decidedAt: '2026-09-23T10:00:00Z', names: true, memory: 'yes' }), { decidedAt: '2026-09-23T10:00:00Z', names: true, memory: false });
});

test('hand-typed service addresses and names are checked, not saved wrong', () => {
  assert.equal(settingsInputError({}), null);
  assert.equal(settingsInputError({ speechUrl: 'http://box:8078', voiceModelUrl: 'https://api.example/v1/chat/completions', voiceModel: 'qwen/qwen3.8-27b', ttsVoice: 'bm_george' }), null);
  assert.match(settingsInputError({ speechUrl: 'box:8078' }), /speech-to-text.*http/);
  assert.match(settingsInputError({ ttsUrl: 'http://a b' }), /read-aloud/);
  assert.match(settingsInputError({ ttsVoice: 'bad voice!' }), /voice name/);
  assert.equal(normalizeSettings({ ttsUrl: 'http://kokoro:8880/' }).ttsUrl, 'http://kokoro:8880');
  assert.equal(normalizeSettings({ voiceModelUrl: 'http://q:8000/v1/chat/completions' }).voiceModelUrl, 'http://q:8000/v1/chat/completions');
});

test('the resume message is editable, trimmed, bounded, and defaults when blank', () => {
  const { DEFAULT_RESUME_PROMPT } = require('../settings.js');
  assert.equal(DEFAULT_RESUME_PROMPT, 'Sorry, you were interrupted, continue');
  for (const usePiDefault of [true, false]) {
    const custom = normalizeSettings({ usePiDefault, resumePrompt: '  Reprends où tu étais.\nVérifie d’abord les résultats.  ' });
    assert.equal(custom.resumePrompt, 'Reprends où tu étais.\nVérifie d’abord les résultats.');
    assert.equal(normalizeSettings(custom).resumePrompt, custom.resumePrompt);
    for (const resumePrompt of [undefined, '', '   ', null, 42]) {
      assert.equal(normalizeSettings({ usePiDefault, resumePrompt }).resumePrompt, DEFAULT_RESUME_PROMPT);
    }
    assert.equal(normalizeSettings({ usePiDefault, resumePrompt: 'x'.repeat(5000) }).resumePrompt.length, 4000);
  }
  assert.equal(DEFAULT_SETTINGS.resumePrompt, DEFAULT_RESUME_PROMPT);
});
