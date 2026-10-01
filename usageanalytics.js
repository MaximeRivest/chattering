'use strict';
// Token and cost analytics over Pi and Claude Code JSONL transcripts.
// The SQLite database is derived data. Delete it to rebuild from transcripts.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const readline = require('readline');
const { execFileSync } = require('child_process');
const responseSpeed = require('./responsespeed.js');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {}

const SCHEMA_VERSION = 3; // v2: reply speed samples; v3: the person each call is for
// A per-model characters-per-token ratio is trusted from this many clean
// replies; until then the default ratio applies and readouts say so.
const MIN_CALIBRATION_SAMPLES = 10;
const BILLING_MODES = new Set(['api', 'subscription', 'free', 'local', 'unknown']);
const SUBSCRIPTION_PROVIDERS = new Set([
  'openai-codex', 'github-copilot', 'claude-code', 'kimi-coding',
  'qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual',
  'xiaomi-token-plan-cn', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp',
]);
const LOCAL_PROVIDER_RE = /^(ollama|llamacpp|lmstudio|lm-studio|vllm|local|faux)(?:[-_/]|$)/i;

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function timestampMs(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : number(fallback);
}

function normalizeUsage(raw, source) {
  const u = raw && typeof raw === 'object' ? raw : {};
  if (source === 'claude') {
    const input = number(u.input_tokens);
    const output = number(u.output_tokens);
    const cacheRead = number(u.cache_read_input_tokens);
    const cacheWrite = number(u.cache_creation_input_tokens);
    return {
      input, output, cacheRead, cacheWrite, cacheWrite1h: 0,
      reasoning: number(u.reasoning_tokens),
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: null,
    };
  }
  const input = number(u.input);
  const output = number(u.output);
  const cacheRead = number(u.cacheRead);
  const cacheWrite = number(u.cacheWrite);
  const rawCost = u.cost && typeof u.cost === 'object' ? u.cost : null;
  const cost = rawCost ? {
    input: number(rawCost.input), output: number(rawCost.output),
    cacheRead: number(rawCost.cacheRead), cacheWrite: number(rawCost.cacheWrite),
    total: number(rawCost.total),
  } : null;
  if (cost && !cost.total) cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return {
    input, output, cacheRead, cacheWrite,
    cacheWrite1h: Math.min(cacheWrite, number(u.cacheWrite1h)),
    reasoning: u.reasoning == null ? null : number(u.reasoning),
    totalTokens: input + output + cacheRead + cacheWrite,
    cost,
  };
}

function calculateCost(rates, usage) {
  if (!rates) return null;
  let selected = rates;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  let threshold = -1;
  for (const tier of rates.tiers || []) {
    if (inputTokens > number(tier.inputTokensAbove) && number(tier.inputTokensAbove) > threshold) {
      selected = tier;
      threshold = number(tier.inputTokensAbove);
    }
  }
  const inputRate = number(selected.input);
  const outputRate = number(selected.output);
  const readRate = number(selected.cacheRead);
  const writeRate = number(selected.cacheWrite);
  const longWrite = Math.min(usage.cacheWrite, number(usage.cacheWrite1h));
  const shortWrite = usage.cacheWrite - longWrite;
  const cost = {
    input: inputRate * usage.input / 1e6,
    output: outputRate * usage.output / 1e6,
    cacheRead: readRate * usage.cacheRead / 1e6,
    // Pi applies Anthropic's one-hour rate as twice the base input rate.
    cacheWrite: (writeRate * shortWrite + inputRate * 2 * longWrite) / 1e6,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return cost;
}

function normalizeProvider(value) {
  const v = String(value || '').toLowerCase();
  return ({
    bedrock: 'amazon-bedrock', bedrock_converse: 'amazon-bedrock',
    vertex_ai: 'google-vertex', vertex_ai_beta: 'google-vertex',
    gemini: 'google', azure: 'azure-openai-responses',
  })[v] || v;
}

class PricingCatalog {
  constructor() {
    this.exact = new Map();
    this.byModel = new Map();
    this.sources = [];
  }

  add(provider, model, rates, meta = {}) {
    provider = normalizeProvider(provider);
    model = String(model || '');
    if (!provider || !model || !rates) return;
    const normalized = {
      input: number(rates.input), output: number(rates.output),
      cacheRead: number(rates.cacheRead), cacheWrite: number(rates.cacheWrite),
      tiers: Array.isArray(rates.tiers) ? rates.tiers.map(t => ({
        inputTokensAbove: number(t.inputTokensAbove), input: number(t.input), output: number(t.output),
        cacheRead: number(t.cacheRead), cacheWrite: number(t.cacheWrite),
      })) : [],
    };
    const rec = { provider, model, rates: normalized, source: meta.source || 'unknown', updatedAt: meta.updatedAt || null };
    const key = provider + '\0' + model;
    if (!this.exact.has(key) || meta.preferred) this.exact.set(key, rec);
    if (!this.byModel.has(model)) this.byModel.set(model, []);
    this.byModel.get(model).push(rec);
  }

  resolve(provider, model) {
    provider = normalizeProvider(provider);
    model = String(model || '');
    let hit = this.exact.get(provider + '\0' + model);
    if (hit) return { ...hit, confidence: 'exact' };
    // Claude Code and subscription routes often use the direct model id.
    const aliases = [];
    if (provider === 'claude-code' || provider === 'github-copilot') aliases.push('anthropic');
    if (provider === 'openai-codex' || provider === 'github-copilot') aliases.push('openai');
    for (const alias of aliases) {
      hit = this.exact.get(alias + '\0' + model);
      if (hit) return { ...hit, confidence: 'mapped' };
    }
    const matches = this.byModel.get(model) || [];
    const direct = matches.filter(r => ['anthropic', 'openai', 'google'].includes(r.provider));
    const choices = direct.length ? direct : matches;
    if (choices.length === 1) return { ...choices[0], confidence: 'model-only' };
    return null;
  }
}

function fileMtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

// Pi's provider price tables, from the Pi the app runs (runtime.js). The
// pi-ai package sits inside Pi's own node_modules, or beside it when npm
// hoisted it (the locked runtime): look in each node_modules up the tree.
function findPiDataDir() {
  let dir;
  try { dir = require('./runtime.js').piPackageDir(); } catch { return null; }
  for (let i = 0; i < 6 && dir; i++) {
    const candidate = path.join(dir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data');
    if (fs.existsSync(candidate)) return candidate;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function loadPricingCatalog(options = {}) {
  const catalog = new PricingCatalog();
  const piDir = options.piDataDir || findPiDataDir();
  if (piDir) {
    for (const file of fs.readdirSync(piDir).filter(name => name.endsWith('.json'))) {
      const abs = path.join(piDir, file);
      let payload; try { payload = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { continue; }
      for (const models of Object.values(payload)) {
        if (!models || typeof models !== 'object') continue;
        for (const [id, model] of Object.entries(models)) {
          if (!model || typeof model !== 'object' || !model.cost) continue;
          catalog.add(model.provider, model.id || id, model.cost, { source: 'pi', updatedAt: fileMtime(abs), preferred: true });
        }
      }
    }
    catalog.sources.push({ source: 'pi', updatedAt: fileMtime(piDir), path: piDir });
  }

  const aimoDir = options.aimoCacheDir || path.join(os.homedir(), '.cache', 'aimo');
  const liteFile = path.join(aimoDir, 'litellm_models.json');
  if (fs.existsSync(liteFile)) {
    let payload; try { payload = JSON.parse(fs.readFileSync(liteFile, 'utf8')); } catch { payload = {}; }
    for (const [id, m] of Object.entries(payload)) {
      if (!m || typeof m !== 'object' || id === 'sample_spec') continue;
      const rates = {
        input: number(m.input_cost_per_token) * 1e6,
        output: number(m.output_cost_per_token) * 1e6,
        cacheRead: number(m.cache_read_input_token_cost) * 1e6,
        cacheWrite: number(m.cache_creation_input_token_cost || m.cache_write_input_token_cost) * 1e6,
      };
      if (rates.input || rates.output) catalog.add(m.litellm_provider || m.provider, id, rates, { source: 'aimo/litellm', updatedAt: fileMtime(liteFile) });
    }
    catalog.sources.push({ source: 'aimo/litellm', updatedAt: fileMtime(liteFile), path: liteFile });
  }

  const modelsDevFile = path.join(aimoDir, 'models_dev.json');
  if (fs.existsSync(modelsDevFile)) {
    let payload; try { payload = JSON.parse(fs.readFileSync(modelsDevFile, 'utf8')); } catch { payload = {}; }
    for (const [provider, block] of Object.entries(payload)) {
      const models = block && block.models;
      const entries = Array.isArray(models) ? models.map(m => [m && (m.id || m.name), m]) : Object.entries(models || {});
      for (const [id, m] of entries) {
        if (!id || !m || typeof m !== 'object') continue;
        const c = m.cost || m.pricing;
        if (!c || typeof c !== 'object') continue;
        const rates = {
          input: number(c.input != null ? c.input : c.prompt),
          output: number(c.output != null ? c.output : c.completion),
          cacheRead: number(c.cache_read != null ? c.cache_read : c.cacheRead),
          cacheWrite: number(c.cache_write != null ? c.cache_write : c.cacheWrite),
        };
        if (rates.input || rates.output) catalog.add(provider, id, rates, { source: 'aimo/models.dev', updatedAt: fileMtime(modelsDevFile) });
      }
    }
    catalog.sources.push({ source: 'aimo/models.dev', updatedAt: fileMtime(modelsDevFile), path: modelsDevFile });
  }
  return catalog;
}

function speedPart(raw) {
  if (!raw || !['chars', 'timedChars', 'chunks'].every(k => Number.isSafeInteger(raw[k]) && raw[k] >= 0)
    || !Number.isFinite(raw.ms) || raw.ms < 0 || raw.timedChars > raw.chars
    || (raw.timedChars > 0 && raw.chunks < 2)) return null;
  return { chars: raw.chars, timedChars: raw.timedChars, ms: raw.ms, chunks: raw.chunks };
}

// One stored reply-speed sample (pisdk-runtime.js writes them) as a flat
// row. Provider and model fall back to the file's current model, like
// usage facts do.
function normalizeSpeedSample(raw, fallback = {}) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const usage = s.usage && typeof s.usage === 'object' ? s.usage : {};
  const text = speedPart(s.text), thinking = speedPart(s.thinking), tool = speedPart(s.tool);
  if (!text || !thinking || !tool || !Number.isFinite(s.at) || s.at <= 0
    || [s.waitMs, s.startMs].some(v => v != null && (!Number.isFinite(v) || v < 0))) return null;
  return {
    entryId: typeof s.entryId === 'string' ? s.entryId : null,
    at: number(s.at),
    provider: String(s.provider || fallback.provider || 'unknown'),
    model: String(s.model || fallback.model || 'unknown'),
    stopReason: String(s.stopReason || ''),
    thinkingLevel: s.thinkingLevel == null ? null : String(s.thinkingLevel),
    waitMs: s.waitMs == null ? null : number(s.waitMs),
    startMs: s.startMs == null ? null : number(s.startMs),
    text, thinking, tool,
    usage: { output: number(usage.output), reasoning: Number.isFinite(usage.reasoning) && usage.reasoning >= 0 ? usage.reasoning : null },
  };
}

// Facts (token usage per model call) and reply-speed samples from one
// transcript. Speed entries name the reply they measured, so a copied fork
// yields the same sample key and counts once.
// Codex (~/.codex/sessions rollouts): token_count events carry the thread's
// running total. Per-call usage is the growth of that total, so a repeated
// event (Codex emits some twice) never counts twice. OpenAI reports cached
// input inside input_tokens and reasoning inside output_tokens; stored here
// in the same shape as Pi facts (input excludes cache reads).
async function parseCodexUsageFile(file, context, catalog) {
  const facts = [];
  let model = null, previous = null, ordinal = 0, provider = 'openai-codex';
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    ordinal++;
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload;
    if (d.type === 'session_meta' && p && p.model_provider && p.model_provider !== 'openai') provider = String(p.model_provider);
    if (d.type === 'turn_context' && p && p.model) { model = p.model; continue; }
    if (d.type !== 'event_msg' || !p || p.type !== 'token_count' || !p.info || !p.info.total_token_usage) continue;
    const t = p.info.total_token_usage;
    const cur = { input: number(t.input_tokens), cached: number(t.cached_input_tokens), output: number(t.output_tokens), reasoning: number(t.reasoning_output_tokens) };
    const base = previous || { input: 0, cached: 0, output: 0, reasoning: 0 };
    // A total that went down is a new count (a compaction or a resume in
    // another process): take it as a fresh start rather than a negative.
    const shrank = cur.input < base.input || cur.output < base.output;
    const delta = shrank ? cur : { input: cur.input - base.input, cached: Math.max(0, cur.cached - base.cached), output: cur.output - base.output, reasoning: Math.max(0, cur.reasoning - base.reasoning) };
    previous = cur;
    if (!delta.input && !delta.output) continue;
    const cacheRead = Math.min(delta.cached, delta.input);
    const usage = { input: delta.input - cacheRead, output: delta.output, cacheRead, cacheWrite: 0, cacheWrite1h: 0, reasoning: delta.reasoning, totalTokens: delta.input + delta.output, cost: null };
    const price = catalog.resolve(provider, model) || catalog.resolve('openai', model);
    const cost = price ? calculateCost(price.rates, usage) : null;
    facts.push({
      eventKey: 'codex:' + (context.sessionId || file) + ':' + ordinal, id: String(ordinal), ts: timestampMs(d.timestamp, context.mtimeMs), source: 'codex',
      provider, model: String(model || 'unknown'), api: 'openai-codex-responses', category: 'assistant', stopReason: '',
      ...usage, estimatedCost: cost ? cost.total : null,
      costInput: cost ? cost.input : null, costOutput: cost ? cost.output : null,
      costCacheRead: cost ? cost.cacheRead : null, costCacheWrite: cost ? cost.cacheWrite : null,
      priceSource: price ? price.source : null, priceConfidence: price ? price.confidence : null, person: null,
    });
  }
  return { facts, speed: [] };
}

async function parseUsageFile(file, context = {}, catalog = new PricingCatalog()) {
  if (context.source === 'codex') return parseCodexUsageFile(file, context, catalog);
  const facts = [];
  const speed = [];
  const source = context.source === 'claude' ? 'claude' : 'pi';
  let currentProvider = null;
  let currentModel = null;
  let ordinal = 0;
  // Who each call is for (design/72): a person's message is the one right
  // after their chattering-author entry; everything below it on the tree is
  // theirs until the next message. A message with no author entry (typed in
  // a terminal, or before people existed) belongs to nobody known: null.
  const personOf = new Map(), authorEntry = new Set();
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (source === 'pi' && d.id) {
      if (d.type === 'custom' && (d.customType === 'chattering-author' || d.customType === 'aiconvo-author') && d.data && d.data.user && typeof d.data.user.id === 'string') {
        personOf.set(d.id, d.data.user.id); authorEntry.add(d.id);
      } else if (d.type === 'message' && d.message && d.message.role === 'user') {
        personOf.set(d.id, authorEntry.has(d.parentId) ? personOf.get(d.parentId) : null);
      } else personOf.set(d.id, d.parentId != null ? (personOf.get(d.parentId) ?? null) : null);
    }
    if (source === 'pi' && d.type === 'model_change') {
      currentProvider = d.provider || currentProvider;
      currentModel = d.modelId || currentModel;
      continue;
    }
    let rawUsage = null;
    let provider = currentProvider;
    let model = currentModel;
    let api = null;
    let category = 'assistant';
    let stopReason = null;
    let id = d.id || d.uuid || 'line-' + (++ordinal);
    let ts = d.timestamp;
    if (source === 'pi') {
      if (d.type === 'message' && d.message && d.message.role === 'assistant' && d.message.usage) {
        rawUsage = d.message.usage;
        provider = d.message.provider || provider;
        model = d.message.model || model;
        api = d.message.api || null;
        stopReason = d.message.stopReason || null;
        if (d.chatteringCategory === 'internal') category = 'internal';
        currentProvider = provider || currentProvider;
        currentModel = model || currentModel;
      } else if (d.type === 'custom' && d.customType === 'chattering-answer-rewrite' && d.data?.response?.usage) {
        const response = d.data.response;
        rawUsage = response.usage;
        provider = response.provider || provider;
        model = response.model || model;
        api = response.api || null;
        stopReason = response.stopReason || null;
        category = 'internal';
      } else if ((d.type === 'compaction' || d.type === 'branch_summary') && d.usage) {
        rawUsage = d.usage;
        category = d.type === 'compaction' ? 'compaction' : 'branch-summary';
      } else if (d.type === 'custom' && (d.customType === 'chattering-speed' || d.customType === 'aiconvo-speed') && d.data?.v === 1 && Array.isArray(d.data.samples)) {
        d.data.samples.forEach((raw, i) => {
          const sample = normalizeSpeedSample(raw, { provider: currentProvider, model: currentModel });
          if (!responseSpeed.sampleHasContent(sample)) return;
          // Pi entry ids are only 32 bits; a measurement UUID prevents
          // unrelated sessions from colliding, while copies still deduplicate.
          const measurement = d.data.measurementId || String(id) + ':' + String(ts);
          speed.push({ ...sample, sampleKey: 'speed:' + measurement + '#' + i,
            ts: sample.at || timestampMs(ts, context.mtimeMs) });
        });
        continue;
      }
    } else if (d.type === 'assistant' && d.message && d.message.usage) {
      rawUsage = d.message.usage;
      provider = d.message.provider || 'anthropic';
      model = d.message.model || model;
      api = d.message.api || 'anthropic-messages';
      stopReason = d.message.stop_reason || d.message.stopReason || null;
      ts = d.timestamp || d.message.timestamp;
      category = d.isSidechain ? 'subagent' : 'assistant';
    }
    if (!rawUsage) continue;
    const usage = normalizeUsage(rawUsage, source);
    if (!usage.totalTokens && !(usage.cost && usage.cost.total)) continue;
    let cost = usage.cost && usage.cost.total > 0 ? usage.cost : null;
    let priceSource = cost ? 'pi-stored' : null;
    let priceConfidence = cost ? 'historical' : null;
    if (!cost) {
      const price = catalog.resolve(provider, model);
      if (price) {
        cost = calculateCost(price.rates, usage);
        priceSource = price.source;
        priceConfidence = price.confidence;
      }
    }
    facts.push({
      eventKey: source + ':' + id + ':' + category,
      id: String(id), ts: timestampMs(ts, context.mtimeMs), source,
      provider: String(provider || (source === 'claude' ? 'anthropic' : 'unknown')),
      model: String(model || 'unknown'), api: String(api || ''), category, stopReason: String(stopReason || ''),
      ...usage, estimatedCost: cost ? cost.total : null,
      costInput: cost ? cost.input : null, costOutput: cost ? cost.output : null,
      costCacheRead: cost ? cost.cacheRead : null, costCacheWrite: cost ? cost.cacheWrite : null,
      priceSource, priceConfidence,
      // Chattering's own calls name the person they were for (chatteringPerson).
      person: source === 'pi' ? (typeof d.chatteringPerson === 'string' ? d.chatteringPerson : (personOf.get(d.id) ?? null)) : null,
    });
  }
  return { facts, speed };
}

function normalizeBillingConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const providerModes = {};
  for (const [provider, mode] of Object.entries(src.providerModes || {})) {
    const key = String(provider).trim();
    if (key && BILLING_MODES.has(mode)) providerModes[key] = mode;
  }
  const monthlyFees = {};
  for (const [provider, value] of Object.entries(src.monthlyFees || {})) {
    const key = String(provider).trim();
    const fee = number(value);
    if (key && fee > 0) monthlyFees[key] = Math.round(fee * 100) / 100;
  }
  return { providerModes, monthlyFees };
}

function classifyBilling(fact, config, authTypes = {}) {
  const provider = String(fact.provider || 'unknown');
  const explicit = config.providerModes && config.providerModes[provider];
  if (BILLING_MODES.has(explicit)) return { mode: explicit, basis: 'user rule' };
  if (fact.source === 'claude') return { mode: 'subscription', basis: 'Claude Code transcript' };
  if (LOCAL_PROVIDER_RE.test(provider)) return { mode: 'local', basis: 'local provider' };
  if (SUBSCRIPTION_PROVIDERS.has(provider) || /(?:^|-)token-plan(?:-|$)/.test(provider)) {
    return { mode: 'subscription', basis: 'subscription provider' };
  }
  if (provider === 'anthropic' && authTypes.anthropic === 'oauth') {
    return { mode: 'subscription', basis: 'current Anthropic OAuth; historical inference' };
  }
  if (provider === 'openrouter') return { mode: 'api', basis: 'OpenRouter bills API use, including OAuth keys' };
  if (fact.estimatedCost != null && fact.estimatedCost > 0) return { mode: 'api', basis: 'priced provider route' };
  return { mode: 'unknown', basis: 'no billing evidence' };
}

function localDay(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function blankTotals() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, tokens: 0,
    equivalentCost: 0, apiCost: 0, subscriptionValue: 0, freeValue: 0, localValue: 0, unknownValue: 0,
    unpricedCalls: 0 };
}

function addFact(total, fact, billing) {
  total.calls++;
  total.input += fact.input;
  total.output += fact.output;
  total.cacheRead += fact.cacheRead;
  total.cacheWrite += fact.cacheWrite;
  total.reasoning += fact.reasoning || 0;
  total.tokens += fact.totalTokens;
  if (fact.estimatedCost == null) total.unpricedCalls++;
  else {
    total.equivalentCost += fact.estimatedCost;
    if (billing.mode === 'api') total.apiCost += fact.estimatedCost;
    else if (billing.mode === 'subscription') total.subscriptionValue += fact.estimatedCost;
    else if (billing.mode === 'free') total.freeValue += fact.estimatedCost;
    else if (billing.mode === 'local') total.localValue += fact.estimatedCost;
    else total.unknownValue += fact.estimatedCost;
  }
}

function mapRows(map, keyName) {
  return [...map.entries()].map(([key, totals]) => ({ [keyName]: key, ...totals }))
    .sort((a, b) => b.equivalentCost - a.equivalentCost || b.tokens - a.tokens);
}

function aggregateFacts(facts, options = {}) {
  const config = normalizeBillingConfig(options.billing);
  const authTypes = options.authTypes || {};
  const filters = options.filters || {};
  const summary = blankTotals();
  const daily = new Map(), models = new Map(), projects = new Map(), providers = new Map(), billing = new Map(), categories = new Map(), people = new Map();
  const facets = { projects: new Set(), providers: new Set(), models: new Set(), billing: new Set(), people: new Set() };
  // Calls no person asked for directly: background work (titles, memory)
  // and messages with no author (typed in a terminal, older history).
  const personKey = fact => fact.person || (fact.category === 'internal' ? 'background' : 'unattributed');
  const quality = { pricedCalls: 0, unpricedCalls: 0, exactPrices: 0, mappedPrices: 0, historicalPrices: 0, inferredBillingCalls: 0 };
  let minTs = null, maxTs = null;
  for (const fact of facts) {
    const mode = classifyBilling(fact, config, authTypes);
    const project = fact.project || 'Unknown project';
    facets.projects.add(project); facets.providers.add(fact.provider); facets.models.add(fact.model); facets.billing.add(mode.mode);
    facets.people.add(personKey(fact));
    if (filters.project && project !== filters.project) continue;
    if (filters.person && personKey(fact) !== filters.person) continue;
    if (filters.provider && fact.provider !== filters.provider) continue;
    if (filters.model && fact.model !== filters.model) continue;
    if (filters.billing && mode.mode !== filters.billing) continue;
    minTs = minTs == null ? fact.ts : Math.min(minTs, fact.ts);
    maxTs = maxTs == null ? fact.ts : Math.max(maxTs, fact.ts);
    addFact(summary, fact, mode);
    const day = localDay(fact.ts);
    if (!daily.has(day)) daily.set(day, blankTotals());
    addFact(daily.get(day), fact, mode);
    const modelKey = fact.provider + '/' + fact.model;
    if (!models.has(modelKey)) models.set(modelKey, blankTotals());
    addFact(models.get(modelKey), fact, mode);
    if (!projects.has(project)) projects.set(project, blankTotals());
    addFact(projects.get(project), fact, mode);
    if (!providers.has(fact.provider)) providers.set(fact.provider, blankTotals());
    addFact(providers.get(fact.provider), fact, mode);
    if (!billing.has(mode.mode)) billing.set(mode.mode, blankTotals());
    addFact(billing.get(mode.mode), fact, mode);
    if (!people.has(personKey(fact))) people.set(personKey(fact), blankTotals());
    addFact(people.get(personKey(fact)), fact, mode);
    if (!categories.has(fact.category)) categories.set(fact.category, blankTotals());
    addFact(categories.get(fact.category), fact, mode);
    if (fact.estimatedCost == null) quality.unpricedCalls++;
    else quality.pricedCalls++;
    if (fact.priceConfidence === 'historical') quality.historicalPrices++;
    else if (fact.priceConfidence === 'exact') quality.exactPrices++;
    else if (fact.priceConfidence) quality.mappedPrices++;
    if (/inference|provider|transcript|route/.test(mode.basis)) quality.inferredBillingCalls++;
  }
  const fromMs = number(options.fromMs) || minTs;
  const toMs = number(options.toMs) || maxTs;
  const periodDays = fromMs != null && toMs != null ? Math.max(1, (toMs - fromMs) / 86400000) : 0;
  summary.subscriptionFees = Object.values(config.monthlyFees).reduce((n, v) => n + number(v), 0) * periodDays / 30.4375;
  summary.subscriptionFees = Math.round(summary.subscriptionFees * 1e6) / 1e6;
  return {
    summary,
    daily: mapRows(daily, 'day').sort((a, b) => a.day.localeCompare(b.day)),
    models: mapRows(models, 'model'), projects: mapRows(projects, 'project'), providers: mapRows(providers, 'provider'),
    billing: mapRows(billing, 'billing'), categories: mapRows(categories, 'category'), people: mapRows(people, 'person'), quality,
    facets: Object.fromEntries(Object.entries(facets).map(([k, set]) => [k, [...set].sort()])),
  };
}

// ---- reply speed --------------------------------------------------------

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function distribution(values) {
  const sorted = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return { samples: 0, min: null, p10: null, median: null, p90: null, max: null };
  return { samples: sorted.length, min: sorted[0], p10: quantile(sorted, 0.1), median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9), max: sorted[sorted.length - 1] };
}
function scaled(dist, factor) {
  const out = { samples: dist.samples };
  for (const k of ['min', 'p10', 'median', 'p90', 'max']) out[k] = dist[k] == null ? null : dist[k] * factor;
  return out;
}

// Per model: how many characters one token is worth (from replies whose
// hidden share is known), the answer-text rate in characters and estimated
// tokens per second, and the wait before the first visible text. Rates come
// from answer text only: streamed tool arguments and visible thinking are
// counted but often arrive in lumps, which would look like infinite speed.
function speedStatistics(samples, options = {}) {
  const defaultRatio = Number.isFinite(options.defaultCharsPerToken) && options.defaultCharsPerToken > 0
    ? options.defaultCharsPerToken : responseSpeed.DEFAULT_CHARS_PER_TOKEN;
  const groups = new Map();
  for (const s of samples) {
    const key = s.provider + '/' + s.model;
    if (!groups.has(key)) groups.set(key, { provider: s.provider, model: s.model, ratios: [], rates: [], waits: [], count: 0, lastAt: 0 });
    const g = groups.get(key);
    g.count++;
    g.lastAt = Math.max(g.lastAt, number(s.ts));
    const ratio = responseSpeed.calibrationOf(s);
    if (ratio != null) g.ratios.push(ratio);
    const complete = ['stop', 'length', 'toolUse'].includes(s.stopReason);
    const rate = complete ? responseSpeed.charsPerSecond(s.text) : null;
    if (rate != null) g.rates.push(rate);
    if (complete && s.waitMs != null && s.text.chars) g.waits.push(s.waitMs);
  }
  const models = [...groups.values()].map(g => {
    const ratioDist = distribution(g.ratios);
    const calibrated = ratioDist.samples >= MIN_CALIBRATION_SAMPLES;
    const charsPerToken = calibrated ? ratioDist.median : defaultRatio;
    const chars = distribution(g.rates);
    return {
      id: g.provider + '/' + g.model, provider: g.provider, model: g.model,
      samples: g.count, lastAt: g.lastAt,
      calibration: { charsPerToken, samples: ratioDist.samples, calibrated },
      charsPerSecond: chars,
      tokensPerSecond: scaled(chars, 1 / charsPerToken),
      waitMs: distribution(g.waits),
    };
  }).sort((a, b) => b.tokensPerSecond.samples - a.tokensPerSecond.samples || b.samples - a.samples || a.id.localeCompare(b.id));
  const calibrations = new Map(models.map(m => [m.id, m.calibration.charsPerToken]));
  return { models, providers: groupedSpeedStatistics(samples, s => s.provider, calibrations),
    daily: groupedSpeedStatistics(samples, s => localDay(s.ts || s.at), calibrations).sort((a, b) => a.id.localeCompare(b.id)),
    defaultCharsPerToken: defaultRatio, minCalibrationSamples: MIN_CALIBRATION_SAMPLES };
}

// Pool reply observations, not averages/medians of model aggregates. Token
// rates are converted with each reply's own model ratio before grouping.
function groupedSpeedStatistics(samples, keyOf, calibrations) {
  const groups = new Map();
  for (const s of samples) {
    const id = keyOf(s);
    if (!groups.has(id)) groups.set(id, { id, samples: 0, chars: [], tokens: [], waits: [] });
    const g = groups.get(id);
    g.samples++;
    if (!['stop', 'length', 'toolUse'].includes(s.stopReason)) continue;
    const rate = responseSpeed.charsPerSecond(s.text);
    if (rate != null) {
      g.chars.push(rate);
      g.tokens.push(rate / calibrations.get(s.provider + '/' + s.model));
    }
    if (s.waitMs != null && s.text.chars) g.waits.push(s.waitMs);
  }
  return [...groups.values()].map(g => ({ id: g.id, samples: g.samples,
    charsPerSecond: distribution(g.chars), tokensPerSecond: distribution(g.tokens), waitMs: distribution(g.waits) }))
    .sort((a, b) => b.samples - a.samples || a.id.localeCompare(b.id));
}

class UsageIndex {
  constructor(dbPath) {
    if (!DatabaseSync) throw new Error('node:sqlite is unavailable');
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version !== SCHEMA_VERSION) {
      this.db.exec('DROP TABLE IF EXISTS usage_owners; DROP TABLE IF EXISTS usage_events; DROP TABLE IF EXISTS usage_speed; DROP TABLE IF EXISTS usage_files;');
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_files (
        session_key TEXT PRIMARY KEY, source TEXT NOT NULL, mtime_ms REAL NOT NULL, size INTEGER NOT NULL,
        project TEXT, first_ts TEXT, scanned_at INTEGER NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        event_key TEXT PRIMARY KEY, ts INTEGER NOT NULL, source TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        api TEXT, category TEXT NOT NULL, stop_reason TEXT, person TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER, cache_write_1h INTEGER,
        reasoning INTEGER, total_tokens INTEGER, estimated_cost REAL, cost_input REAL, cost_output REAL,
        cost_cache_read REAL, cost_cache_write REAL, price_source TEXT, price_confidence TEXT
      );
      CREATE TABLE IF NOT EXISTS usage_speed (
        sample_key TEXT PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        stop_reason TEXT, thinking_level TEXT, wait_ms REAL, start_ms REAL, usage_event_key TEXT,
        text_chars INTEGER, text_timed INTEGER, text_ms REAL, text_chunks INTEGER,
        think_chars INTEGER, think_timed INTEGER, think_ms REAL, think_chunks INTEGER,
        tool_chars INTEGER, tool_timed INTEGER, tool_ms REAL, tool_chunks INTEGER,
        output_tokens INTEGER, reasoning_tokens INTEGER
      );
      -- Owners cover usage events and speed samples alike: the key says which.
      CREATE TABLE IF NOT EXISTS usage_owners (
        event_key TEXT NOT NULL, session_key TEXT NOT NULL,
        PRIMARY KEY (event_key, session_key)
      );
      CREATE INDEX IF NOT EXISTS usage_events_ts ON usage_events(ts);
      CREATE INDEX IF NOT EXISTS usage_speed_ts ON usage_speed(ts);
      CREATE INDEX IF NOT EXISTS usage_owners_session ON usage_owners(session_key);
    `);
    this.progress = { running: false, total: 0, done: 0, errors: 0, current: null, startedAt: null, finishedAt: null };
    this.syncPromise = null;
    this.fileUpdates = new Map();
    this.revision = 0;
  }

  status() {
    const files = this.db.prepare('SELECT COUNT(*) n, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) errors FROM usage_files').get();
    const events = this.db.prepare('SELECT COUNT(*) n FROM usage_events WHERE event_key IN (SELECT event_key FROM usage_owners)').get();
    return { ...this.progress, indexedFiles: number(files.n), indexedEvents: number(events.n), storedErrors: number(files.errors) };
  }

  needs(entry, key) {
    const row = this.db.prepare('SELECT mtime_ms,size,project FROM usage_files WHERE session_key=?').get(key);
    const project = entry.project || 'Unknown project';
    return !row || row.mtime_ms !== entry.mtimeMs || row.size !== entry.size || row.project !== project;
  }

  updateFile(key, entry, absPath, catalog) {
    // A completion refresh can overlap the background sweep. Serialize
    // each file so an earlier parse cannot overwrite a newer snapshot.
    const previous = this.fileUpdates.get(key) || Promise.resolve();
    const work = previous.catch(() => {}).then(() => this._updateFile(key, entry, absPath, catalog));
    this.fileUpdates.set(key, work);
    const clear = () => { if (this.fileUpdates.get(key) === work) this.fileUpdates.delete(key); };
    work.then(clear, clear);
    return work;
  }

  async _updateFile(key, entry, absPath, catalog) {
    let facts = [], speed = [], error = null;
    try { ({ facts, speed } = await parseUsageFile(absPath, { source: entry.source, mtimeMs: entry.mtimeMs, sessionId: entry.sessionId }, catalog)); }
    catch (e) { error = String(e.message || e).slice(0, 500); }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM usage_owners WHERE session_key=?').run(key);
      const putEvent = this.db.prepare(`INSERT INTO usage_events
        (event_key,ts,source,provider,model,api,category,stop_reason,input_tokens,output_tokens,cache_read,cache_write,cache_write_1h,reasoning,total_tokens,estimated_cost,cost_input,cost_output,cost_cache_read,cost_cache_write,price_source,price_confidence,person)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(event_key) DO UPDATE SET ts=excluded.ts,source=excluded.source,provider=excluded.provider,model=excluded.model,
        api=excluded.api,category=excluded.category,stop_reason=excluded.stop_reason,input_tokens=excluded.input_tokens,
        output_tokens=excluded.output_tokens,cache_read=excluded.cache_read,cache_write=excluded.cache_write,
        cache_write_1h=excluded.cache_write_1h,reasoning=excluded.reasoning,total_tokens=excluded.total_tokens,
        estimated_cost=excluded.estimated_cost,cost_input=excluded.cost_input,cost_output=excluded.cost_output,
        cost_cache_read=excluded.cost_cache_read,cost_cache_write=excluded.cost_cache_write,
        price_source=excluded.price_source,price_confidence=excluded.price_confidence,person=excluded.person`);
      const putOwner = this.db.prepare('INSERT OR IGNORE INTO usage_owners(event_key,session_key) VALUES (?,?)');
      for (const f of facts) {
        putEvent.run(f.eventKey, f.ts, f.source, f.provider, f.model, f.api, f.category, f.stopReason,
          f.input, f.output, f.cacheRead, f.cacheWrite, f.cacheWrite1h, f.reasoning, f.totalTokens,
          f.estimatedCost, f.costInput, f.costOutput, f.costCacheRead, f.costCacheWrite, f.priceSource, f.priceConfidence, f.person || null);
        putOwner.run(f.eventKey, key);
      }
      const putSpeed = this.db.prepare(`INSERT OR REPLACE INTO usage_speed
        (sample_key,ts,provider,model,stop_reason,thinking_level,wait_ms,start_ms,
         text_chars,text_timed,text_ms,text_chunks,think_chars,think_timed,think_ms,think_chunks,
         tool_chars,tool_timed,tool_ms,tool_chunks,output_tokens,reasoning_tokens,usage_event_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const s of speed) {
        putSpeed.run(s.sampleKey, s.ts, s.provider, s.model, s.stopReason, s.thinkingLevel, s.waitMs, s.startMs,
          s.text.chars, s.text.timedChars, s.text.ms, s.text.chunks,
          s.thinking.chars, s.thinking.timedChars, s.thinking.ms, s.thinking.chunks,
          s.tool.chars, s.tool.timedChars, s.tool.ms, s.tool.chunks,
          s.usage.output, s.usage.reasoning, s.entryId ? 'pi:' + s.entryId + ':assistant' : null);
        putOwner.run(s.sampleKey, key);
      }
      this.db.prepare(`INSERT INTO usage_files(session_key,source,mtime_ms,size,project,first_ts,scanned_at,error)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_key) DO UPDATE SET source=excluded.source,mtime_ms=excluded.mtime_ms,
        size=excluded.size,project=excluded.project,first_ts=excluded.first_ts,scanned_at=excluded.scanned_at,error=excluded.error`)
        .run(key, entry.source, entry.mtimeMs, entry.size, entry.project || 'Unknown project', entry.firstTs || null, Date.now(), error);
      this.db.exec('COMMIT');
      this.revision++;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    if (error) throw new Error(error);
  }

  startSync(entries, absPathForKey, catalog) {
    if (this.syncPromise) return this.syncPromise;
    const live = new Set(entries.map(([key]) => key));
    for (const row of this.db.prepare('SELECT session_key FROM usage_files').all()) {
      if (live.has(row.session_key)) continue;
      this.db.prepare('DELETE FROM usage_owners WHERE session_key=?').run(row.session_key);
      this.db.prepare('DELETE FROM usage_files WHERE session_key=?').run(row.session_key);
      this.revision++;
    }
    this.db.exec('DELETE FROM usage_events WHERE event_key NOT IN (SELECT event_key FROM usage_owners)');
    this.db.exec('DELETE FROM usage_speed WHERE sample_key NOT IN (SELECT event_key FROM usage_owners)');
    const pending = entries.filter(([key, entry]) => this.needs(entry, key))
      .sort((a, b) => String(b[1].lastTs || '').localeCompare(String(a[1].lastTs || '')));
    if (!pending.length) {
      this.progress = { running: false, total: 0, done: 0, errors: 0, current: null, startedAt: null, finishedAt: Date.now() };
      return Promise.resolve();
    }
    this.progress = { running: true, total: pending.length, done: 0, errors: 0, current: null, startedAt: Date.now(), finishedAt: null };
    this.syncPromise = (async () => {
      let next = 0;
      const worker = async () => {
        while (next < pending.length) {
          const [key, entry] = pending[next++];
          this.progress.current = key;
          try { await this.updateFile(key, entry, absPathForKey(key), catalog); }
          catch { this.progress.errors++; }
          this.progress.done++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, pending.length) }, worker));
      this.progress.running = false;
      this.progress.current = null;
      this.progress.finishedAt = Date.now();
      this.syncPromise = null;
    })();
    return this.syncPromise;
  }

  facts(fromMs, toMs) {
    return this.db.prepare(`
      WITH chosen AS (
        SELECT event_key, MIN(session_key) AS session_key FROM usage_owners GROUP BY event_key
      )
      SELECT e.ts,e.source,e.provider,e.model,e.api,e.category,e.stop_reason AS stopReason,
        e.input_tokens AS input,e.output_tokens AS output,e.cache_read AS cacheRead,e.cache_write AS cacheWrite,
        e.cache_write_1h AS cacheWrite1h,e.reasoning,e.total_tokens AS totalTokens,e.estimated_cost AS estimatedCost,
        e.price_source AS priceSource,e.price_confidence AS priceConfidence,e.person,f.project
      FROM usage_events e JOIN chosen c ON c.event_key=e.event_key
      JOIN usage_files f ON f.session_key=c.session_key
      WHERE e.ts>=? AND e.ts<=? ORDER BY e.ts`).all(fromMs, toMs);
  }

  // Reply-speed samples in the range, as speedStatistics() reads them.
  speedSamples(fromMs, toMs) {
    return this.db.prepare(`
      WITH chosen AS (
        SELECT event_key, MIN(session_key) AS session_key FROM usage_owners GROUP BY event_key
      )
      SELECT s.ts,s.provider,s.model,s.stop_reason AS stopReason,s.thinking_level AS thinkingLevel,
        s.wait_ms AS waitMs,s.start_ms AS startMs,
        s.text_chars,s.text_timed,s.text_ms,s.text_chunks,
        s.think_chars,s.think_timed,s.think_ms,s.think_chunks,
        s.tool_chars,s.tool_timed,s.tool_ms,s.tool_chunks,
        s.output_tokens,s.reasoning_tokens,f.project,e.estimated_cost AS estimatedCost
      FROM usage_speed s JOIN chosen c ON c.event_key=s.sample_key
      JOIN usage_files f ON f.session_key=c.session_key
      LEFT JOIN usage_events e ON e.event_key=s.usage_event_key
      WHERE s.ts>=? AND s.ts<=? ORDER BY s.ts`).all(fromMs, toMs).map(r => ({
      ts: r.ts, source: 'pi', estimatedCost: r.estimatedCost, provider: r.provider, model: r.model, stopReason: r.stopReason, thinkingLevel: r.thinkingLevel,
      waitMs: r.waitMs, startMs: r.startMs, project: r.project,
      text: { chars: r.text_chars, timedChars: r.text_timed, ms: r.text_ms, chunks: r.text_chunks },
      thinking: { chars: r.think_chars, timedChars: r.think_timed, ms: r.think_ms, chunks: r.think_chunks },
      tool: { chars: r.tool_chars, timedChars: r.tool_timed, ms: r.tool_ms, chunks: r.tool_chunks },
      usage: { output: r.output_tokens, reasoning: r.reasoning_tokens },
    }));
  }
}

function openUsageIndex(dbPath) {
  if (!DatabaseSync) return null;
  try { return new UsageIndex(dbPath); } catch { return null; }
}

module.exports = {
  MIN_CALIBRATION_SAMPLES,
  PricingCatalog, UsageIndex, aggregateFacts, calculateCost, classifyBilling, loadPricingCatalog,
  normalizeBillingConfig, normalizeSpeedSample, normalizeUsage, openUsageIndex, parseUsageFile, speedStatistics,
};
