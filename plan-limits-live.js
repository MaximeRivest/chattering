'use strict';
// plan-limits-live.js — what a reply says about the plan, while it happens
// (design/109). Pure parsers for the three things that arrive with model
// traffic, at no cost:
//
// · the limit headers of a reply: Claude's `anthropic-ratelimit-unified-*`
//   (the five-hour and the weekly share, as fractions, with reset times in
//   seconds) and ChatGPT's `x-codex-*` (Codex's limits by name, in percent);
// · Claude Code's `rate_limit_event` and Codex's `account/rateLimits/updated`;
// · the words of a reply refused for a limit, and when it says it is back.
//
// A live reading is partial: it updates the windows it names and leaves
// the others (a model family's own weekly limit is only in a full read).
// Headers carry no account: the hub knows which pool a route leads to.

const L = require('./plan-limits.js');
const { num, timeMs, HOUR, DAY, MIN } = L;
const { codexWindowId } = require('./plan-limits-read.js');

// The only response headers a Pi run may send to the hub: limit headers.
// Never a request header (they hold the key), never anything else.
const HEADER_ALLOW = /^(anthropic-ratelimit-unified-[a-z0-9-]+|x-codex-[a-z0-9-]+|x-[a-z0-9]+(?:-[a-z0-9]+)*-(?:primary|secondary)-(?:used-percent|window-minutes|reset-at|reset-after-seconds)|retry-after)$/;
const HEADER_FAMILY = h => Object.keys(h).some(k => k.startsWith('anthropic-ratelimit-unified-')) ? 'claude'
  : Object.keys(h).some(k => /^x-[a-z0-9-]+-primary-used-percent$/.test(k) || k.startsWith('x-codex-')) ? 'chatgpt' : null;
function limitHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  // A fetch Headers object, or the plain record Pi passes extensions.
  const entries = typeof headers.get === 'function' && typeof headers.entries === 'function' ? [...headers.entries()] : Object.entries(headers);
  for (const [k, v] of entries) {
    const key = String(k).toLowerCase();
    if (HEADER_ALLOW.test(key) && v != null) out[key] = String(Array.isArray(v) ? v[0] : v).slice(0, 200);
  }
  return out;
}

// ---- Claude ----
// The claims Claude's headers and events name, as Chattering's window ids.
const CLAUDE_CLAIM = { five_hour: 'session', '5h': 'session', seven_day: 'week', '7d': 'week', seven_day_opus: 'weekly:opus', seven_day_sonnet: 'weekly:sonnet' };
const CLAUDE_CLAIM_MS = { session: 5 * HOUR, week: 7 * DAY, 'weekly:opus': 7 * DAY, 'weekly:sonnet': 7 * DAY };
function claudeWindow(id, { utilization, reset, rejected }) {
  const used = num(utilization);
  return L.cleanWindow({ id, durationMs: CLAUDE_CLAIM_MS[id] || null, label: L.durationLabel(CLAUDE_CLAIM_MS[id]) || id,
    // Headers and events give a fraction (0.03 is 3%).
    usedPercent: used == null ? null : used * 100, resetsAt: reset, limited: !!rejected });
}
function claudeHeaders(h, { at = Date.now() } = {}) {
  const get = k => h['anthropic-ratelimit-unified-' + k];
  if (!get('status') && !get('5h-utilization') && !get('7d-utilization')) return null;
  const windows = [];
  for (const [short, id] of [['5h', 'session'], ['7d', 'week']]) {
    if (get(short + '-utilization') == null && get(short + '-reset') == null) continue;
    windows.push(claudeWindow(id, { utilization: get(short + '-utilization'), reset: get(short + '-reset'), rejected: get(short + '-status') === 'rejected' }));
  }
  // Refused: the claim that refused, until the reset it names.
  if (get('status') === 'rejected') {
    const id = CLAUDE_CLAIM[get('representative-claim')] || 'session';
    const w = windows.find(x => x.id === id);
    if (w) { w.limited = true; w.resetsAt = w.resetsAt || timeMs(get('reset')); }
    else windows.push(L.cleanWindow({ id, durationMs: CLAUDE_CLAIM_MS[id] || null, label: L.durationLabel(CLAUDE_CLAIM_MS[id]) || id, usedPercent: 100, limited: true, resetsAt: get('reset') }));
  }
  const over = get('overage-status');
  return { at, source: 'live', partial: true, windows,
    credits: over ? { label: 'extra usage', enabled: over !== 'rejected' || get('overage-disabled-reason') !== 'out_of_credits' && get('overage-disabled-reason') !== 'org_level_disabled', limited: over === 'rejected' && get('overage-disabled-reason') === 'out_of_credits' } : undefined };
}
// Claude Code's stream-json `rate_limit_event.rate_limit_info`.
function claudeEvent(info, { at = Date.now() } = {}) {
  if (!info || typeof info !== 'object') return null;
  const windows = [];
  const uw = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {};
  for (const [claim, w] of Object.entries(uw)) {
    const id = CLAUDE_CLAIM[claim];
    if (!id || !w || typeof w !== 'object') continue;
    windows.push(claudeWindow(id, { utilization: w.utilization, reset: w.resetsAt, rejected: false }));
  }
  const claimed = CLAUDE_CLAIM[info.rateLimitType];
  if (claimed) {
    const rejected = info.status === 'rejected';
    const w = windows.find(x => x.id === claimed);
    if (w) { if (rejected) w.limited = true; if (!w.resetsAt) w.resetsAt = timeMs(info.resetsAt); }
    else if (rejected || num(info.utilization) != null) windows.push(claudeWindow(claimed, { utilization: rejected && num(info.utilization) == null ? 1 : info.utilization, reset: info.resetsAt, rejected }));
  }
  if (!windows.length) return null;
  return { at, source: 'live', partial: true, windows,
    credits: info.overageStatus ? { label: 'extra usage', enabled: info.overageStatus !== 'rejected', limited: info.overageStatus === 'rejected' && info.overageDisabledReason === 'out_of_credits' } : undefined };
}

// ---- ChatGPT / Codex ----
function codexHeaders(h, { at = Date.now() } = {}) {
  const windows = [];
  for (const k of Object.keys(h)) {
    const m = /^x-([a-z0-9-]+)-(primary|secondary)-used-percent$/.exec(k);
    if (!m) continue;
    const [, limit, slot] = m;
    const p = 'x-' + limit + '-' + slot + '-';
    const mins = num(h[p + 'window-minutes']);
    const used = num(h[k]);
    if (!mins && !used) continue; // an empty slot: 0% of a 0-minute window
    const reset = timeMs(h[p + 'reset-at']) || (num(h[p + 'reset-after-seconds']) ? at + num(h[p + 'reset-after-seconds']) * 1000 : null);
    const durationMs = mins ? mins * MIN : null;
    windows.push(L.cleanWindow({ id: codexWindowId(limit, slot), durationMs, usedPercent: used, resetsAt: reset,
      label: (L.durationLabel(durationMs) || slot) + (limit === 'codex' ? '' : ' · ' + limit.replace(/-/g, ' ')) }));
  }
  if (h['x-codex-rate-limit-reached-type'] && windows.length) windows.reduce((a, b) => (b.usedPercent ?? -1) > (a.usedPercent ?? -1) ? b : a).limited = true;
  if (!windows.length) return null;
  const has = String(h['x-codex-credits-has-credits'] || '').toLowerCase() === 'true';
  const unlimited = String(h['x-codex-credits-unlimited'] || '').toLowerCase() === 'true';
  const plan = h['x-codex-plan-type'] || null;
  return { at, source: 'live', partial: true, windows, plan,
    credits: has || unlimited ? { label: 'credits', balance: num(h['x-codex-credits-balance']), currency: 'credits', enabled: true } : undefined };
}

// The limit headers of one reply, whichever provider: a partial reading
// (its pool is the hub's to name), or null.
function fromHeaders(headers, { at = Date.now() } = {}) {
  const h = limitHeaders(headers);
  const family = HEADER_FAMILY(h);
  const r = family === 'claude' ? claudeHeaders(h, { at }) : family === 'chatgpt' ? codexHeaders(h, { at }) : null;
  return r ? { family, ...r } : null;
}

// ---- a reply refused for a limit ----
// The words providers and agents use. Plain throttling ("too many requests
// per minute") is not a plan limit: it asks for a fresh read, nothing more.
const LIMIT_WORDS = /usage limit|hit your (?:usage )?limit|limit reached|(?:weekly|session|5-hour|five-hour|daily|monthly) limit|quota (?:exceeded|exhausted|reached)|exhausted your (?:capacity|quota)|out of (?:credits|usage)|RESOURCE_EXHAUSTED|usage_limit_reached|usage_not_included|insufficient_quota|spend(?:ing)? limit/i;
const THROTTLE_WORDS = /\b429\b|rate.limit|too many requests|overloaded|rate_limit_error/i;
function durationIn(text) {
  const s = String(text);
  let m = /(?:try again|retry|resets?|available again|back)\s+(?:in|after)\s+~?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i.exec(s);
  if (m) {
    const n = Number(m[1]), u = m[2].toLowerCase()[0];
    return n * (u === 's' ? 1000 : u === 'm' ? MIN : u === 'h' ? HOUR : DAY);
  }
  // Google: "reset after 2h3m4s".
  m = /reset(?:s)? after\s+((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/i.exec(s);
  if (m && m[1]) {
    const p = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/.exec(m[1]);
    const ms = ((Number(p[1]) || 0) * 3600 + (Number(p[2]) || 0) * 60 + (Number(p[3]) || 0)) * 1000;
    if (ms > 0) return ms;
  }
  return null;
}
function fromError(text, { at = Date.now() } = {}) {
  const s = String(text || '');
  if (!s) return null;
  const limit = LIMIT_WORDS.test(s);
  if (!limit && !THROTTLE_WORDS.test(s)) return null;
  let resetsAt = null;
  // Claude Code's own form: "Claude AI usage limit reached|1793453400".
  const epoch = /limit reached\|(\d{10,13})/i.exec(s);
  if (epoch) resetsAt = timeMs(epoch[1]);
  if (!resetsAt) { const d = durationIn(s); if (d) resetsAt = at + d; }
  if (!resetsAt) { const iso = /(?:resets?|until|after)\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))/i.exec(s); if (iso) resetsAt = timeMs(iso[1]); }
  return { kind: limit ? 'limit' : 'throttle', resetsAt, text: s.slice(0, 300) };
}

module.exports = { HEADER_ALLOW, limitHeaders, claudeHeaders, claudeEvent, codexHeaders, fromHeaders, fromError, durationIn, CLAUDE_CLAIM };
