'use strict';
// plan-limits.js — what a subscription still allows (design/109).
//
// The unit is the POOL: one subscription account at one provider, however
// many ways lead to it. Claude Max is one pool whether Pi's `anthropic`,
// Pi's `claude-code` or Claude Code itself sends the request, and whether
// Maxime or Lilly (signed in to the same account) asks. A pool has WINDOWS
// (five hours, a week, a week for one model family, a month's budget), each
// with how much is used, when it resets, and which models it covers. A
// model's state is its tightest window.
//
// Everything here is plain data and pure functions: readings in, a view
// out. Who reads, when and as whom is plan-limits-service.js; how a
// provider's reply becomes a reading is plan-limits-read.js and
// plan-limits-live.js.
//
//   Reading  { pool: { key, kind, label?, plan?, planLabel? }, at, source,
//              partial, windows: [Window], credits?: Credits|null }
//   Window   { id, label, usedPercent|null, resetsAt|null, durationMs|null,
//              limited, severity?, scope: null | { family } | { models: [] } }
//   Credits  { label, used, limit, currency, enabled, limited }  (money after the plan)
//
// `source` says where a number came from: 'read' (asked the provider),
// 'live' (the limit headers of a reply), 'error' (a reply refused for a
// limit), 'estimate' (never stored as a reading: computed for display).

const crypto = require('crypto');

const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
// A window at or past this share is "near": the picker and the composer say so.
const NEAR_PERCENT = 80;
// A reading older than this is shown with its age, not as "now".
const FRESH_MS = 2 * MIN;
const SOURCES = ['read', 'live', 'error'];

// The pool's key: the provider family and the provider's own account id,
// hashed (no address, no id in Chattering's records or on a page). The
// same account reached by two routes, or by two people, is one key.
function poolKey(kind, ...ids) {
  const parts = ids.map(v => String(v == null ? '' : v).trim());
  if (!kind || !parts.some(Boolean)) throw new Error('a pool needs its provider account id');
  return kind + ':' + crypto.createHash('sha256').update(kind + '\0' + parts.join('\0')).digest('hex').slice(0, 16);
}
const kindOfPool = key => String(key || '').split(':')[0];

const num = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
// Times arrive as ISO strings, epoch seconds or epoch milliseconds.
function timeMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}
const clampPercent = p => p == null ? null : Math.max(0, Math.min(100, p));

// "5 hours", "week", "month": how people name a window by its length.
function durationLabel(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (Math.abs(ms - 7 * DAY) < HOUR) return 'week';
  if (Math.abs(ms - DAY) < 10 * MIN) return 'day';
  if (ms >= 27 * DAY && ms <= 32 * DAY) return 'month';
  if (ms < DAY) { const h = Math.round(ms / HOUR); return h + '-hour'; }
  return Math.round(ms / DAY) + '-day';
}

// A window as stored and shown. Unknown fields are dropped; numbers are
// numbers or null, never strings, never NaN.
function cleanWindow(w) {
  if (!w || typeof w !== 'object' || !w.id) return null;
  const used = num(w.usedPercent);
  const scope = w.scope && typeof w.scope === 'object'
    ? (w.scope.family ? { family: String(w.scope.family).toLowerCase() }
      : Array.isArray(w.scope.models) && w.scope.models.length ? { models: w.scope.models.map(String) } : null)
    : null;
  return {
    id: String(w.id),
    label: String(w.label || durationLabel(num(w.durationMs)) || w.id),
    usedPercent: used == null ? null : Math.max(0, used),
    resetsAt: timeMs(w.resetsAt),
    durationMs: num(w.durationMs),
    limited: !!w.limited || (used != null && used >= 100),
    severity: w.severity ? String(w.severity) : null,
    scope,
    // A refusal that did not say when it ends holds for a while, then lapses
    // (a read normally replaces it long before).
    ...(num(w.expiresAt) ? { expiresAt: num(w.expiresAt) } : {}),
    ...(w.money ? { money: { used: num(w.money.used), limit: num(w.money.limit), currency: String(w.money.currency || 'USD') } } : {}),
    ...(w.count ? { count: { used: num(w.count.used), limit: num(w.count.limit), unit: String(w.count.unit || 'requests') } } : {}),
  };
}
function cleanCredits(c) {
  if (!c || typeof c !== 'object') return null;
  return { label: String(c.label || 'extra usage'), used: num(c.used), limit: num(c.limit), currency: String(c.currency || 'USD'),
    enabled: c.enabled !== false, limited: !!c.limited, balance: num(c.balance) };
}
function cleanReading(r) {
  if (!r || !r.pool || !r.pool.key) throw new Error('a reading names its pool');
  const source = SOURCES.includes(r.source) ? r.source : 'read';
  return {
    pool: { key: String(r.pool.key), kind: kindOfPool(r.pool.key), ...(r.pool.plan ? { plan: String(r.pool.plan) } : {}), ...(r.pool.planLabel ? { planLabel: String(r.pool.planLabel) } : {}) },
    at: num(r.at) || Date.now(), source, partial: !!r.partial,
    windows: (r.windows || []).map(cleanWindow).filter(Boolean),
    credits: r.credits === undefined ? undefined : cleanCredits(r.credits),
  };
}

// ---- a pool's state: readings merged ----
// Each window keeps the newest thing said about it, with when and by which
// source. A full read also forgets windows the provider no longer reports
// (a model's own limit that ended); a live reading only adds or updates.
function emptyPool(key) { return { key, kind: kindOfPool(key), plan: null, planLabel: null, windows: {}, credits: null, creditsAt: 0, readAt: 0, liveAt: 0, errorAt: 0 }; }
function mergeReading(state, reading) {
  const r = cleanReading(reading);
  const s = state ? { ...state, windows: { ...state.windows } } : emptyPool(r.pool.key);
  if (r.pool.plan) s.plan = r.pool.plan;
  if (r.pool.planLabel) s.planLabel = r.pool.planLabel;
  for (const w of r.windows) {
    const prev = s.windows[w.id];
    if (prev && prev.at > r.at) continue; // an older answer arriving late
    // A live header carries only the numbers: keep what a read knew about
    // the window (its scope, its name) when the header does not say.
    s.windows[w.id] = { ...(prev || {}), ...w, scope: w.scope || (prev && prev.scope) || null, label: w.label !== w.id || !prev ? w.label : prev.label, at: r.at, source: r.source };
  }
  if (r.source === 'read' && !r.partial) {
    const seen = new Set(r.windows.map(w => w.id));
    for (const id of Object.keys(s.windows)) if (!seen.has(id) && s.windows[id].at <= r.at) delete s.windows[id];
  }
  if (r.credits !== undefined && r.at >= (s.creditsAt || 0)) { s.credits = r.credits; s.creditsAt = r.at; }
  if (r.source === 'read') s.readAt = Math.max(s.readAt || 0, r.at);
  if (r.source === 'live') s.liveAt = Math.max(s.liveAt || 0, r.at);
  if (r.source === 'error') s.errorAt = Math.max(s.errorAt || 0, r.at);
  return s;
}

// ---- which windows hold a model back ----
const tokensOf = id => String(id || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
function covers(win, modelId) {
  if (!win.scope) return true;
  const bare = String(modelId || '').split('/').pop().toLowerCase();
  if (win.scope.models) return win.scope.models.some(m => String(m).toLowerCase() === bare);
  if (win.scope.family) {
    const fam = tokensOf(win.scope.family);
    const toks = tokensOf(bare);
    // Every word of the family's name, in order, among the model's: "fable"
    // in claude-fable-5-1, "gemini 4 argon" in gemini-4-argon-high.
    for (let i = 0; i + fam.length <= toks.length; i++) if (fam.every((t, j) => toks[i + j] === t)) return true;
    return false;
  }
  return true;
}

// A window as it is now: past its reset with nothing newer said, its old
// number no longer holds (the provider started counting again; what was
// used since is not known until someone reads or a reply says).
function windowNow(w, now) {
  const reset = (w.resetsAt && w.resetsAt <= now && w.at < w.resetsAt) || (w.expiresAt && w.expiresAt <= now);
  const used = reset ? null : w.usedPercent;
  const limited = reset ? false : !!w.limited;
  const state = limited ? 'limited' : used == null ? (reset ? 'reset' : 'unknown')
    : used >= 100 ? 'limited' : used >= NEAR_PERCENT || w.severity === 'warning' || w.severity === 'critical' ? 'near' : 'ok';
  return { ...w, usedPercent: used, limited, state, reset, age: Math.max(0, now - (w.at || now)), fresh: now - (w.at || 0) < FRESH_MS,
    // When a window that reset is next to fill is not known: the next one starts at the first use.
    resetsAt: reset ? null : w.resetsAt, resetAt: reset ? w.resetsAt : null };
}
const STATE_RANK = { limited: 4, near: 3, ok: 2, reset: 1, unknown: 0 };
// The tightest of some windows: a limit reached first, then the highest share.
function tightest(windows) {
  let best = null;
  for (const w of windows) {
    if (!best) { best = w; continue; }
    const a = STATE_RANK[w.state] || 0, b = STATE_RANK[best.state] || 0;
    if (a > b || (a === b && (w.usedPercent ?? -1) > (best.usedPercent ?? -1))
      || (a === b && w.state === 'limited' && (w.resetsAt || Infinity) > (best.resetsAt || Infinity))) best = w;
  }
  return best;
}
function modelState(pool, modelId, now = Date.now()) {
  if (!pool) return null;
  const wins = Object.values(pool.windows || {}).filter(w => covers(w, modelId)).map(w => windowNow(w, now));
  const t = tightest(wins);
  if (!t) return { pool: pool.key, state: 'unknown', windows: [] };
  // Limited: back when every window that blocks has reset.
  const blocking = wins.filter(w => w.state === 'limited');
  const until = blocking.length ? Math.max(...blocking.map(w => w.resetsAt || 0)) || null : null;
  return { pool: pool.key, state: t.state, usedPercent: t.usedPercent, window: t.id, label: t.label, resetsAt: t.resetsAt, until,
    scoped: !!t.scope, windows: wins.map(w => w.id) };
}
function poolSummary(pool, now = Date.now()) {
  const wins = Object.values(pool.windows || {}).map(w => windowNow(w, now));
  const t = tightest(wins.filter(w => !w.scope)) || tightest(wins);
  return { state: t ? t.state : 'unknown', usedPercent: t ? t.usedPercent : null, window: t ? t.id : null };
}

// Windows in a stable reading order: the shortest first (the one that
// bites soonest), whole-plan before model-specific, then by name.
function sortWindows(list) {
  return list.slice().sort((a, b) => (!!a.scope - !!b.scope)
    || ((a.durationMs || Infinity) - (b.durationMs || Infinity))
    || String(a.label).localeCompare(String(b.label)));
}

module.exports = {
  MIN, HOUR, DAY, NEAR_PERCENT, FRESH_MS,
  poolKey, kindOfPool, timeMs, num, clampPercent, durationLabel,
  cleanWindow, cleanCredits, cleanReading, emptyPool, mergeReading,
  covers, windowNow, tightest, modelState, poolSummary, sortWindows,
};
