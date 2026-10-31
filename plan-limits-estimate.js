'use strict';
// plan-limits-estimate.js — what the numbers suggest, said as estimates
// (design/109). Providers give a share of each window and nothing else: no
// tokens per percent, no forecast, no "who". Chattering knows every call
// it and this computer's agents made (the usage index: tokens, the API
// price of each, the person), so it can learn the rest, and says how sure
// it is. Nothing here is ever shown as a provider's number.
//
// · calibration  how many percent of a window one dollar of API-priced use
//                costs, per plan and window: the rise of the window over a
//                whole window instance against the use Chattering saw in it.
//                Chained over an instance, the providers' whole-percent
//                rounding telescopes to at most one point per instance.
//                Use Chattering did not see (claude.ai in a browser, another
//                computer) only raises the rise: the estimate errs high,
//                which is the safe side for "will this reply fit".
// · pace         where the window is heading at the pace of the last hours.
// · attribution  who used the current window, from the usage index; the
//                rest is "outside Chattering" once the calibration knows it.
// · per reply    what one reply of a conversation costs of a window.

const { HOUR, MIN } = require('./plan-limits.js');

const SAME_RESET_MS = 2 * MIN;   // a window's reset time wobbles by a second or so between readings
const MIN_INSTANCES = 3;         // calibrations from fewer whole windows are not shown
const MIN_POINTS = 10;           // nor from less than this many points of rise in total
const PACE_SPAN_MS = 3 * HOUR;   // the pace is that of the last three hours at most
const PACE_MIN_SPAN_MS = 20 * MIN;

// The rows of one window (by time) cut into its instances: one per reset.
function instancesOf(rows) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    if (r.used == null) continue;
    const same = cur && r.resetsAt && cur.resetsAt && Math.abs(r.resetsAt - cur.resetsAt) <= SAME_RESET_MS;
    if (!same || r.used + 0.5 < cur.last.used) { cur = { resetsAt: r.resetsAt || null, first: r, last: r, rows: [r] }; out.push(cur); }
    else { cur.last = r; cur.rows.push(r); }
  }
  return out;
}

const median = xs => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (xs, q) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!s.length) return null; const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };

// samples: [{ rise: percent points, cost: API dollars }] — one per instance.
// → { percentPerDollar, instances, low, high, enough }
function calibrate(samples, { minInstances = MIN_INSTANCES, minPoints = MIN_POINTS } = {}) {
  const use = samples.filter(s => s.cost > 0.01 && s.rise >= 1);
  const rise = use.reduce((n, s) => n + s.rise, 0), cost = use.reduce((n, s) => n + s.cost, 0);
  const each = use.map(s => s.rise / s.cost);
  const k = cost > 0 ? rise / cost : null;
  return { percentPerDollar: k, instances: use.length, points: rise, low: quantile(each, 0.25), high: quantile(each, 0.75),
    enough: use.length >= minInstances && rise >= minPoints && k != null };
}
// The instances of one window with the use seen in each: costOf(from, to) → dollars.
function calibrationSamples(rows, costOf) {
  return instancesOf(rows).filter(i => i.rows.length >= 2 && i.last.at - i.first.at >= 10 * MIN)
    .map(i => ({ rise: i.last.used - i.first.used, cost: costOf(i.first.at, i.last.at), from: i.first.at, to: i.last.at }));
}

// rows: this window instance's readings by time; w: the window now.
// → { perHour, since, projected, hitsAt } or null when there is not enough to say.
function pace(rows, w, now) {
  if (!w || w.usedPercent == null || !w.resetsAt) return null;
  const cur = rows.filter(r => r.used != null && r.at <= now && (!r.resetsAt || Math.abs(r.resetsAt - w.resetsAt) <= SAME_RESET_MS));
  if (cur.length < 2) return null;
  const last = cur[cur.length - 1];
  const first = cur.find(r => r.at >= now - PACE_SPAN_MS) || cur[0];
  const span = last.at - first.at;
  if (span < PACE_MIN_SPAN_MS) return null;
  const perHour = Math.max(0, (last.used - first.used) / (span / HOUR));
  const left = Math.max(0, (w.resetsAt - now) / HOUR);
  const projected = w.usedPercent + perHour * left;
  const hitsAt = perHour > 0 && w.usedPercent < 100 ? now + ((100 - w.usedPercent) / perHour) * HOUR : null;
  return { perHour, since: first.at, projected, hitsAt: hitsAt && hitsAt < w.resetsAt ? Math.round(hitsAt) : null };
}

// facts: usage index rows ({ ts, estimatedCost, person }) of the pool in
// the current window; used: the window's share now; k: percent per dollar.
function attribution(facts, { used = null, k = null } = {}) {
  const by = new Map();
  let total = 0;
  for (const f of facts) {
    const c = Number(f.estimatedCost) || 0;
    if (c <= 0) continue;
    total += c;
    const p = f.person || '';
    by.set(p, (by.get(p) || 0) + c);
  }
  const people = [...by.entries()].map(([person, cost]) => ({ person, cost, share: total ? cost / total : 0, percent: k != null ? cost * k : null }))
    .sort((a, b) => b.cost - a.cost);
  const seen = k != null ? total * k : null;
  return { people, cost: total, seenPercent: seen, outsidePercent: k != null && used != null ? Math.max(0, used - seen) : null };
}

// The share of a window one reply takes: the median API price of the last
// replies of a conversation, times the calibration.
function perReply(costs, k) {
  const m = median(costs.slice(-5));
  return m != null && k != null ? { percent: m * k, dollars: m, replies: Math.min(5, costs.length) } : null;
}

module.exports = { instancesOf, calibrate, calibrationSamples, pace, attribution, perReply, median, MIN_INSTANCES, MIN_POINTS };
