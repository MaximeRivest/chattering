'use strict';
// plan-limits-read.js — a provider's own answer about a subscription, as a
// reading (design/109). Pure parsers: JSON in, windows out. The requests
// themselves are made by plan-limits-worker.js, as the person whose sign-in
// it is. Every parser here was written against a real reply, kept (with its
// ids replaced) in test/fixtures/plan-limits/:
//
//   Claude      GET  api.anthropic.com/api/oauth/usage        (what Claude Code's /usage shows)
//               GET  api.anthropic.com/api/oauth/profile      (account, organization, plan)
//   ChatGPT     GET  chatgpt.com/backend-api/wham/usage       (what Codex reads)
//   Codex       app-server account/rateLimits/read             (Codex's own protocol)
//   OpenRouter  GET  openrouter.ai/api/v1/key, /api/v1/credits
//   Antigravity POST cloudcode-pa…/v1internal:loadCodeAssist, :fetchAvailableModels
//
// A reply whose shape is not the one expected is refused with
// `ShapeError`, never read as zeros: a provider that changes its format
// shows "this reader stopped working", not "0% used" (design/109, the canary).

const L = require('./plan-limits.js');
const { num, timeMs, HOUR, DAY } = L;

class ShapeError extends Error {
  constructor(provider, what) { super(`${provider}: the reply no longer has ${what}`); this.name = 'ShapeError'; this.code = 'PLAN_SHAPE'; }
}
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const words = s => String(s || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---- Claude (claude.ai subscriptions) ----
// The plan's name from what the profile (or Claude Code's saved login) says.
function claudePlan({ organizationType, rateLimitTier, subscriptionType } = {}) {
  const type = String(organizationType || subscriptionType || '').toLowerCase().replace(/^claude_/, '');
  const tier = /max_(\d+)x/i.exec(String(rateLimitTier || ''));
  const base = { max: 'Claude Max', pro: 'Claude Pro', team: 'Claude Team', enterprise: 'Claude Enterprise', free: 'Claude Free' }[type] || (type ? 'Claude ' + words(type) : 'Claude');
  return { plan: [type || null, tier ? tier[1] + 'x' : null].filter(Boolean).join('-') || null, planLabel: base + (tier ? ' ' + tier[1] + '×' : '') };
}
function claudeProfile(json) {
  if (!isObj(json) || !isObj(json.account) || !json.account.uuid) throw new ShapeError('Claude profile', 'an account');
  const org = isObj(json.organization) ? json.organization : {};
  return { accountUuid: String(json.account.uuid), organizationUuid: org.uuid ? String(org.uuid) : '',
    ...claudePlan({ organizationType: org.organization_type, rateLimitTier: org.rate_limit_tier }) };
}
// The pool of a claude.ai login: its account in its organization (a Team
// seat is the person's own allowance within the organization).
const claudePoolKey = ({ accountUuid, organizationUuid }) => L.poolKey('claude', organizationUuid || '', accountUuid);

const CLAUDE_GROUP_MS = { session: 5 * HOUR, weekly: 7 * DAY, daily: DAY, monthly: null };
// One entry of the usage reply's `limits` list. The list describes itself
// (kind, group, percent, severity, reset, the model it is for): a kind
// nobody has seen yet still becomes a window, named by its words.
function claudeLimit(l) {
  if (!isObj(l) || !l.kind) return null;
  const model = isObj(l.scope) && isObj(l.scope.model) ? l.scope.model : null;
  const family = model && (model.display_name || model.id) ? String(model.display_name || model.id) : '';
  const group = String(l.group || '');
  const durationMs = group in CLAUDE_GROUP_MS ? CLAUDE_GROUP_MS[group] : l.kind === 'session' ? 5 * HOUR : null;
  const id = l.kind === 'session' ? 'session' : l.kind === 'weekly_all' ? 'week' : family ? group + ':' + slug(family) : String(l.kind);
  const base = durationMs ? L.durationLabel(durationMs) : words(l.kind);
  return L.cleanWindow({
    id, durationMs, usedPercent: num(l.percent), resetsAt: l.resets_at,
    label: family ? base + ' · ' + family : base,
    severity: l.severity && l.severity !== 'normal' ? l.severity : null,
    limited: /^(blocked|exceeded|limited|rejected)$/i.test(String(l.severity || '')) || num(l.percent) >= 100,
    scope: model && model.id ? { models: [String(model.id)] } : family ? { family } : null,
  });
}
// The older named fields, for a reply without `limits`.
const CLAUDE_NAMED = [
  ['five_hour', 'session', 5 * HOUR, null], ['seven_day', 'week', 7 * DAY, null],
  ['seven_day_opus', 'weekly:opus', 7 * DAY, 'Opus'], ['seven_day_sonnet', 'weekly:sonnet', 7 * DAY, 'Sonnet'],
];
function claudeCredits(json) {
  const s = isObj(json.spend) ? json.spend : null;
  const minor = m => isObj(m) && num(m.amount_minor) != null ? num(m.amount_minor) / 10 ** (num(m.exponent) ?? 2) : null;
  if (s && isObj(s.limit)) {
    return { label: 'extra usage', used: minor(s.used), limit: minor(s.limit), currency: (s.limit.currency || (s.used && s.used.currency) || 'USD'),
      enabled: s.enabled === true, limited: s.enabled === true && minor(s.limit) != null && minor(s.used) >= minor(s.limit) };
  }
  const e = isObj(json.extra_usage) ? json.extra_usage : null;
  if (e && num(e.monthly_limit) != null) {
    const scale = 10 ** (num(e.decimal_places) ?? 2);
    return { label: 'extra usage', used: (num(e.used_credits) || 0) / scale, limit: num(e.monthly_limit) / scale, currency: e.currency || 'USD',
      enabled: e.is_enabled === true, limited: e.spend_limit_reached === true };
  }
  return null;
}
function claudeUsage(json, { at = Date.now(), pool } = {}) {
  if (!isObj(json)) throw new ShapeError('Claude usage', 'an object');
  let windows;
  if (Array.isArray(json.limits)) windows = json.limits.map(claudeLimit).filter(Boolean);
  else {
    windows = [];
    for (const [field, id, durationMs, family] of CLAUDE_NAMED) {
      const w = json[field];
      if (!isObj(w)) continue;
      windows.push(L.cleanWindow({ id, durationMs, usedPercent: num(w.utilization), resetsAt: w.resets_at,
        label: L.durationLabel(durationMs) + (family ? ' · ' + family : ''), scope: family ? { family } : null }));
    }
  }
  if (!windows.length && !isObj(json.five_hour) && !Array.isArray(json.limits)) throw new ShapeError('Claude usage', 'its limits');
  return { pool, at, source: 'read', partial: false, windows, credits: claudeCredits(json) };
}

// ---- ChatGPT (Codex usage) ----
function chatgptPlanLabel(plan) {
  const p = String(plan || '').toLowerCase();
  return p ? 'ChatGPT ' + ({ pro: 'Pro', plus: 'Plus', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', free: 'Free', go: 'Go' }[p] || words(p)) : 'ChatGPT';
}
const chatgptPoolKey = accountId => L.poolKey('chatgpt', accountId);
// A Codex limit's id in Chattering: the limit's name (the default one is
// "codex", as Codex's own headers and protocol call it) and the slot.
const codexWindowId = (limitId, slot) => (limitId || 'codex') + ':' + slot;
function codexWindow(limitId, slot, w, { limitName = null, snake = false } = {}) {
  if (!isObj(w)) return null;
  const used = num(snake ? w.used_percent : w.usedPercent);
  const mins = snake ? (num(w.limit_window_seconds) != null ? num(w.limit_window_seconds) / 60 : null) : num(w.windowDurationMins);
  if (used == null && !mins) return null; // an empty slot ("secondary": 0 minutes)
  const durationMs = mins ? mins * 60 * 1000 : null;
  const named = limitName && limitId !== 'codex' ? ' · ' + words(limitName) : limitId && limitId !== 'codex' ? ' · ' + words(limitId) : '';
  return L.cleanWindow({ id: codexWindowId(limitId, slot), durationMs, usedPercent: used, resetsAt: snake ? w.reset_at : w.resetsAt,
    label: (L.durationLabel(durationMs) || slot) + named });
}
function chatgptUsage(json, { at = Date.now() } = {}) {
  if (!isObj(json) || !json.account_id || !isObj(json.rate_limit) && json.rate_limit !== null) throw new ShapeError('ChatGPT usage', 'its account and rate limit');
  const pool = { key: chatgptPoolKey(json.account_id), plan: json.plan_type || null, planLabel: chatgptPlanLabel(json.plan_type) };
  const windows = [];
  const rl = json.rate_limit || {};
  for (const [slot, field] of [['primary', 'primary_window'], ['secondary', 'secondary_window']]) {
    const w = codexWindow('codex', slot, rl[field], { snake: true });
    if (w) windows.push(w);
  }
  // The plan says it is spent without saying which window: the fullest one.
  if ((rl.limit_reached === true || rl.allowed === false) && windows.length) {
    windows.reduce((a, b) => (b.usedPercent ?? -1) > (a.usedPercent ?? -1) ? b : a).limited = true;
  }
  if (Array.isArray(json.additional_rate_limits)) {
    for (const extra of json.additional_rate_limits) {
      if (!isObj(extra)) continue;
      const id = String(extra.limit_id || extra.metered_feature || extra.limit_name || '').trim();
      const r = isObj(extra.rate_limit) ? extra.rate_limit : null;
      if (!id || !r) continue;
      for (const [slot, field] of [['primary', 'primary_window'], ['secondary', 'secondary_window']]) {
        const w = codexWindow(slug(id), slot, r[field], { snake: true, limitName: extra.limit_name || id });
        if (w) { if (r.limit_reached === true) w.limited = true; windows.push(w); }
      }
    }
  }
  // A model the plan does not serve now, and from when it does again.
  if (isObj(json.model_usage)) {
    for (const [model, u] of Object.entries(json.model_usage)) {
      if (!isObj(u) || u.available !== false) continue;
      windows.push(L.cleanWindow({ id: 'model:' + model, label: model, usedPercent: null, limited: true, resetsAt: u.available_at, scope: { models: [model] } }));
    }
  }
  if (isObj(json.spend_control) && json.spend_control.reached === true) {
    windows.push(L.cleanWindow({ id: 'spend', label: 'spending limit', usedPercent: 100, limited: true }));
  }
  const c = isObj(json.credits) ? json.credits : null;
  const credits = c && (c.has_credits || c.unlimited || num(c.balance) > 0)
    ? { label: 'credits', balance: num(c.balance), currency: 'credits', enabled: true, limited: c.overage_limit_reached === true } : null;
  return { pool, at, source: 'read', partial: false, windows, credits };
}
// Codex's own answer (`account/rateLimits/read`, `account/rateLimits/updated`).
function codexRateLimits(json, { at = Date.now(), pool = null, partial = false } = {}) {
  if (!isObj(json)) throw new ShapeError('Codex', 'its rate limits');
  const byId = isObj(json.rateLimitsByLimitId) ? json.rateLimitsByLimitId : null;
  const snaps = byId ? Object.values(byId) : isObj(json.rateLimits) ? [json.rateLimits] : json.limitId || json.primary ? [json] : null;
  if (!snaps) throw new ShapeError('Codex', 'its rate limits');
  const windows = [];
  let plan = null;
  for (const s of snaps) {
    if (!isObj(s)) continue;
    plan = plan || s.planType || null;
    for (const slot of ['primary', 'secondary']) {
      const w = codexWindow(s.limitId || 'codex', slot, s[slot], { limitName: s.limitName });
      if (w) { if (s.rateLimitReachedType && s[slot] && num(s[slot].usedPercent) >= 100) w.limited = true; windows.push(w); }
    }
    if (s.spendControlReached === true) windows.push(L.cleanWindow({ id: 'spend', label: 'spending limit', usedPercent: 100, limited: true }));
  }
  const accountId = json.accountId || null;
  const key = pool && pool.key ? pool.key : accountId ? chatgptPoolKey(accountId) : null;
  const first = snaps.find(isObj) || {};
  const c = isObj(first.credits) ? first.credits : null;
  return {
    pool: key ? { key, plan, planLabel: chatgptPlanLabel(plan) } : null, at, source: partial ? 'live' : 'read', partial,
    windows, credits: c && (c.hasCredits || c.unlimited || num(c.balance) > 0) ? { label: 'credits', balance: num(c.balance), currency: 'credits', enabled: true } : partial ? undefined : null,
  };
}

// ---- OpenRouter (a key's budget, the account's credits) ----
const openrouterPoolKey = k => L.poolKey('openrouter', k.workspace_id || k.creator_user_id || '', k.label || '');
function openrouterKey(json, { at = Date.now(), credits = null } = {}) {
  const k = isObj(json) && isObj(json.data) ? json.data : null;
  if (!k || !('limit' in k) && !('usage' in k)) throw new ShapeError('OpenRouter', 'its key');
  const windows = [];
  const b = isObj(k.effective_budget) ? k.effective_budget : null;
  const limit = b ? num(b.limit_usd) : num(k.limit);
  const spent = b ? num(b.spend_usd) : num(k.limit) != null && num(k.limit_remaining) != null ? num(k.limit) - num(k.limit_remaining) : null;
  if (limit != null && limit > 0) {
    const interval = String((b && b.reset_interval) || k.limit_reset || '');
    windows.push(L.cleanWindow({ id: 'budget', label: (interval ? words(interval).replace(/ly$/, '') : 'key') + ' · budget', usedPercent: spent != null ? 100 * spent / limit : null,
      resetsAt: b && b.resets_at, money: { used: spent, limit, currency: 'USD' }, limited: spent != null && spent >= limit }));
  }
  const free = isObj(k.free_model_daily_requests) ? k.free_model_daily_requests : null;
  if (free && num(free.limit) > 0) {
    windows.push(L.cleanWindow({ id: 'free:day', label: 'day · free models', durationMs: DAY, usedPercent: 100 * (num(free.used) || 0) / num(free.limit),
      count: { used: num(free.used), limit: num(free.limit), unit: 'requests' }, scope: { family: 'free' } }));
  }
  let money = null;
  if (isObj(credits) && isObj(credits.data) && num(credits.data.total_credits) != null) {
    const left = num(credits.data.total_credits) - (num(credits.data.total_usage) || 0);
    money = { label: 'credits', balance: left, currency: 'USD', enabled: true, limited: left <= 0 };
  }
  return { pool: { key: openrouterPoolKey(k), plan: k.is_free_tier ? 'free' : 'paid', planLabel: 'OpenRouter' + (k.is_free_tier ? ' free' : '') }, at, source: 'read', partial: false, windows, credits: money };
}

// ---- Antigravity (Google's coding plan) ----
const antigravityPoolKey = subject => L.poolKey('antigravity', subject);
// "Gemini 4 Argon (High)" and "(Low)" share one allowance: the name without its level.
const quotaGroup = name => String(name || '').replace(/\s*\((?:low|medium|high|minimal|xhigh|max|thinking)\)\s*$/i, '').trim();
function antigravityModels(json, { at = Date.now(), pool } = {}) {
  if (!isObj(json) || !isObj(json.models)) throw new ShapeError('Antigravity', 'its models');
  const groups = new Map();
  for (const [id, m] of Object.entries(json.models)) {
    if (!isObj(m) || !m.displayName || !isObj(m.quotaInfo)) continue; // internal models (tab_, chat_)
    const q = m.quotaInfo;
    // Google writes protobuf as JSON: a zero is left out. A model with a
    // reset time and no remaining fraction has nothing left.
    const remaining = num(q.remainingFraction) ?? (q.resetTime ? 0 : null);
    const name = quotaGroup(m.displayName);
    const g = groups.get(name) || { name, ids: [], remaining, resetsAt: timeMs(q.resetTime) };
    g.ids.push(id);
    if (remaining != null && (g.remaining == null || remaining < g.remaining)) g.remaining = remaining;
    groups.set(name, g);
  }
  const windows = [...groups.values()].map(g => {
    const left = g.resetsAt ? g.resetsAt - at : null;
    // The window's length is not said; a reset within five hours reads as the five-hour one.
    const durationMs = left != null && left <= 5 * HOUR + 60000 ? 5 * HOUR : left != null && left <= 7 * DAY + 3600000 && left > DAY ? 7 * DAY : null;
    return L.cleanWindow({ id: 'model:' + slug(g.name), label: g.name, durationMs, usedPercent: g.remaining == null ? null : 100 * (1 - g.remaining),
      resetsAt: g.resetsAt, scope: { models: g.ids }, limited: g.remaining === 0 });
  });
  return { pool, at, source: 'read', partial: false, windows, credits: null };
}
function antigravityPlan(load) {
  const tier = isObj(load) ? (isObj(load.paidTier) ? load.paidTier : isObj(load.currentTier) ? load.currentTier : null) : null;
  return { project: isObj(load) && load.cloudaicompanionProject ? String(load.cloudaicompanionProject) : null,
    plan: tier && tier.id ? String(tier.id) : null, planLabel: tier && tier.name ? 'Antigravity · ' + tier.name : 'Antigravity' };
}

module.exports = {
  ShapeError, claudePlan, claudeProfile, claudePoolKey, claudeUsage, claudeLimit,
  chatgptPlanLabel, chatgptPoolKey, chatgptUsage, codexRateLimits, codexWindowId,
  openrouterKey, openrouterPoolKey, antigravityModels, antigravityPlan, antigravityPoolKey, quotaGroup,
};
