'use strict';
// design/109: the pool model, and each provider's real reply read as windows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../plan-limits.js');
const R = require('../plan-limits-read.js');
const live = require('../plan-limits-live.js');

const fx = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'plan-limits', name), 'utf8'));
const headersOf = name => Object.fromEntries(fs.readFileSync(path.join(__dirname, 'fixtures', 'plan-limits', name), 'utf8')
  .split('\n').filter(Boolean).map(l => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const byId = r => Object.fromEntries(r.windows.map(w => [w.id, w]));

test('a pool key is the account, hashed: the same account by two routes is one pool, and no id shows', () => {
  const a = R.claudePoolKey({ accountUuid: 'acc-1', organizationUuid: 'org-1' });
  const b = R.claudePoolKey({ accountUuid: 'acc-1', organizationUuid: 'org-1' });
  assert.equal(a, b);
  assert.notEqual(a, R.claudePoolKey({ accountUuid: 'acc-2', organizationUuid: 'org-1' }));
  assert.match(a, /^claude:[0-9a-f]{16}$/);
  assert.ok(!a.includes('acc-1'));
  assert.throws(() => L.poolKey('claude', '', ''), /account id/);
});

test('Claude: the usage list becomes the 5-hour, the week and the Fable week, with resets and extra usage', () => {
  const r = R.claudeUsage(fx('anthropic-usage-team.json'), { at: Date.parse('2026-10-31T12:00:00Z'), pool: { key: 'claude:x' } });
  const w = byId(r);
  assert.deepEqual(Object.keys(w).sort(), ['session', 'week', 'weekly:fable']);
  assert.equal(w.session.usedPercent, 3);
  assert.equal(w.session.durationMs, 5 * L.HOUR);
  assert.equal(w.session.label, '5-hour');
  assert.equal(w.session.resetsAt, Date.parse('2026-10-31T16:40:00.461648Z'));
  assert.equal(w.week.usedPercent, 34);
  assert.equal(w.week.label, 'week');
  assert.equal(w['weekly:fable'].label, 'week · Fable');
  assert.deepEqual(w['weekly:fable'].scope, { family: 'fable' });
  assert.deepEqual(r.credits, { label: 'extra usage', used: 1.85, limit: 600, currency: 'USD', enabled: true, limited: false });
  // The Max plan with its extra usage switched off for lack of credits.
  const max = R.claudeUsage(fx('anthropic-usage-max.json'), { pool: { key: 'claude:y' } });
  assert.equal(max.credits.enabled, false);
  assert.equal(max.credits.limit, 2);
  assert.equal(max.credits.currency, 'CAD');
});

test('Claude: a kind of limit nobody has seen is a window named by its words, not dropped', () => {
  const j = { limits: [{ kind: 'daily_oauth_apps', group: 'daily', percent: 91, severity: 'warning', resets_at: '2026-11-01T00:00:00Z', scope: null }] };
  const w = R.claudeUsage(j, { pool: { key: 'claude:z' } }).windows[0];
  assert.equal(w.id, 'daily_oauth_apps');
  assert.equal(w.label, 'day');
  assert.equal(w.severity, 'warning');
  // The older named fields still read when the list is missing.
  const old = R.claudeUsage({ five_hour: { utilization: 12, resets_at: '2026-11-01T00:00:00Z' }, seven_day_opus: { utilization: 50, resets_at: null } }, { pool: { key: 'claude:z' } });
  assert.deepEqual(old.windows.map(x => [x.id, x.usedPercent]), [['session', 12], ['weekly:opus', 50]]);
  assert.throws(() => R.claudeUsage({ error: 'x' }), e => e.code === 'PLAN_SHAPE');
});

test('Claude: the profile names the pool and the plan; Claude Code\u2019s saved login names the plan too', () => {
  const p = R.claudeProfile(fx('anthropic-profile-team.json'));
  assert.equal(p.accountUuid, '00000000-0000-4000-8000-00000000a002');
  assert.equal(p.planLabel, 'Claude Team 5×');
  assert.equal(R.claudePlan({ subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }).planLabel, 'Claude Max 20×');
  assert.equal(R.claudePlan({ organizationType: 'claude_pro' }).planLabel, 'Claude Pro');
});

test('ChatGPT: the weekly window, the plan, and a model the plan does not serve now', () => {
  const at = Date.parse('2026-10-31T12:00:00Z');
  const j = fx('chatgpt-wham-usage.json');
  const r = R.chatgptUsage(j, { at });
  assert.equal(r.pool.key, R.chatgptPoolKey('00000000-0000-4000-8000-00000000c001'));
  assert.equal(r.pool.planLabel, 'ChatGPT Pro');
  const w = byId(r)['codex:primary'];
  assert.equal(w.usedPercent, 1);
  assert.equal(w.label, 'week');
  assert.equal(w.resetsAt, j.rate_limit.primary_window.reset_at * 1000);
  assert.equal(r.credits, null);
  const off = R.chatgptUsage({ ...j, model_usage: { 'gpt-6-astra': { available: false, available_at: 1793800000 } }, rate_limit: { ...j.rate_limit, limit_reached: true } }, { at });
  const ids = byId(off);
  assert.equal(ids['codex:primary'].limited, true);
  assert.deepEqual(ids['model:gpt-6-astra'].scope, { models: ['gpt-6-astra'] });
  assert.equal(ids['model:gpt-6-astra'].resetsAt, 1793800000000);
});

test('Codex: its own protocol\u2019s limits read the same window ids as the ChatGPT reply and the headers', () => {
  const r = R.codexRateLimits(fx('codex-app-server-rate-limits.json'));
  assert.equal(r.pool.key, R.chatgptPoolKey('00000000-0000-4000-8000-00000000c001'));
  assert.deepEqual(r.windows.map(w => [w.id, w.usedPercent, w.label]), [['codex:primary', 1, 'week']]);
  const h = live.fromHeaders(headersOf('codex-headers.txt'), { at: 1 });
  assert.equal(h.family, 'chatgpt');
  assert.deepEqual(h.windows.map(w => [w.id, w.usedPercent, w.label, w.resetsAt]), [['codex:primary', 1, 'week', 1793525922000]]);
  assert.equal(h.plan, 'pro');
  // A second named limit (an update notification) stays its own window.
  const upd = R.codexRateLimits({ rateLimits: { limitId: 'gpt-6-astra', limitName: 'GPT-6 Astra', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1793500000 } } }, { partial: true, pool: { key: 'chatgpt:x' } });
  assert.equal(upd.source, 'live');
  assert.deepEqual(upd.windows.map(w => [w.id, w.label]), [['gpt-6-astra:primary', '5-hour · GPT-6 Astra']]);
});

test('OpenRouter: the key\u2019s monthly budget in dollars, free models\u2019 daily requests, and the credits left', () => {
  const r = R.openrouterKey(fx('openrouter-key.json'), { credits: { data: { total_credits: 735, total_usage: 727.8 } } });
  const w = byId(r);
  assert.equal(Math.round(w.budget.usedPercent * 100) / 100, 3.05);
  assert.deepEqual(w.budget.money, { used: 12.20423015, limit: 400, currency: 'USD' });
  assert.equal(w.budget.label, 'month · budget');
  assert.equal(w.budget.resetsAt, Date.parse('2026-11-01T00:00:00.000Z'));
  assert.deepEqual(w['free:day'].scope, { family: 'free' });
  assert.equal(Math.round(r.credits.balance * 100) / 100, 7.2);
  assert.ok(L.covers(w['free:day'], 'deepseek/deepseek-r1:free'));
  assert.ok(!L.covers(w['free:day'], 'deepseek/deepseek-r1'));
});

test('Antigravity: levels of one model share an allowance, and a protobuf zero (no fraction) means nothing left', () => {
  const j = fx('antigravity-available-models.json');
  const at = Date.parse('2026-10-30T02:00:00Z');
  const r = R.antigravityModels(j, { at, pool: { key: 'antigravity:x' } });
  const w = byId(r);
  assert.ok(w['model:gemini-4-argon']);
  assert.equal(w['model:gemini-4-argon'].durationMs, 7 * L.DAY);
  assert.equal(w['model:claude-opus-5-5'].durationMs, 5 * L.HOUR);
  assert.ok(!Object.keys(w).some(k => k.includes('tab') || k.includes('chat')));
  j.models['gemini-4-argon-medium'].quotaInfo = { resetTime: '2026-11-06T01:18:58Z' };
  const empty = byId(R.antigravityModels(j, { at, pool: { key: 'antigravity:x' } }))['model:gemini-4-argon'];
  assert.equal(empty.usedPercent, 100);
  assert.equal(empty.limited, true);
  assert.ok(L.covers(empty, 'gemini-4-argon-medium'));
});

test('Claude headers: fractions as percents, a refusal marks the claim that refused', () => {
  const h = headersOf('anthropic-headers.txt');
  const r = live.fromHeaders({ ...h, authorization: 'Bearer secret', 'set-cookie': 'x' }, { at: 1 });
  assert.equal(r.family, 'claude');
  assert.equal(r.partial, true);
  assert.deepEqual(r.windows.map(w => [w.id, w.usedPercent, w.resetsAt, w.limited]), [['session', 3, 1793453400000, false], ['week', 6, 1793980800000, false]]);
  assert.equal(r.credits.limited, true); // extra usage refused: out of credits
  const refused = live.fromHeaders({ ...h, 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'seven_day' }, { at: 1 });
  assert.equal(refused.windows.find(w => w.id === 'week').limited, true);
  assert.equal(refused.windows.find(w => w.id === 'session').limited, false);
});

test('only limit headers ever leave a run: keys and cookies are filtered out', () => {
  const kept = live.limitHeaders({ Authorization: 'Bearer sk', 'x-api-key': 'k', 'set-cookie': 'c', 'anthropic-ratelimit-unified-5h-utilization': '0.1', 'x-codex-primary-used-percent': '3', 'retry-after': '30', 'request-id': 'r' });
  assert.deepEqual(Object.keys(kept).sort(), ['anthropic-ratelimit-unified-5h-utilization', 'retry-after', 'x-codex-primary-used-percent']);
  const fetchHeaders = new Headers({ 'anthropic-ratelimit-unified-status': 'allowed', authorization: 'x' });
  assert.deepEqual(live.limitHeaders(fetchHeaders), { 'anthropic-ratelimit-unified-status': 'allowed' });
});

test('Claude Code\u2019s rate_limit_event reads like the headers', () => {
  const line = fs.readFileSync(path.join(__dirname, 'fixtures', 'harness', 'claude-stream-tool.jsonl'), 'utf8').split('\n').find(l => l.includes('rate_limit_event'));
  const r = live.claudeEvent(JSON.parse(line).rate_limit_info, { at: 1 });
  assert.deepEqual(r.windows.map(w => [w.id, w.usedPercent]), [['session', 9], ['week', 8]]);
  const hit = live.claudeEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1790796600 }, { at: 1 });
  assert.equal(hit.windows[0].limited, true);
  assert.equal(hit.windows[0].resetsAt, 1790796600000);
});

test('a refused reply: a plan limit with its return time, or plain throttling', () => {
  const at = Date.parse('2026-10-31T12:00:00Z');
  assert.deepEqual(live.fromError('You have hit your ChatGPT usage limit (pro plan). Try again in ~95 min.', { at }), { kind: 'limit', resetsAt: at + 95 * L.MIN, text: 'You have hit your ChatGPT usage limit (pro plan). Try again in ~95 min.' });
  assert.equal(live.fromError('Claude AI usage limit reached|1793453400', { at }).resetsAt, 1793453400000);
  assert.equal(live.fromError('RESOURCE_EXHAUSTED: You have exhausted your capacity on this model. Your quota will reset after 2h3m4s.', { at }).resetsAt, at + (2 * 3600 + 3 * 60 + 4) * 1000);
  assert.equal(live.fromError('429 Too Many Requests: rate_limit_error', { at }).kind, 'throttle');
  assert.equal(live.fromError('fetch failed', { at }), null);
});

test('a model\u2019s state is its tightest window; a window past its reset no longer counts', () => {
  const at = Date.parse('2026-10-31T12:00:00Z');
  let pool = L.mergeReading(null, R.claudeUsage(fx('anthropic-usage-team.json'), { at, pool: { key: 'claude:t' } }));
  // The week is the tightest for any model; Fable's own week is 0%.
  assert.equal(L.modelState(pool, 'claude-fable-5-1', at).window, 'week');
  assert.equal(L.modelState(pool, 'claude-opus-5-5', at).windows.includes('weekly:fable'), false);
  // A live reply says the 5-hour is now refused.
  pool = L.mergeReading(pool, { pool: { key: 'claude:t' }, at: at + 1000, source: 'live', partial: true, windows: [{ id: 'session', usedPercent: 100, resetsAt: at + 2 * L.HOUR, limited: true }] });
  const s = L.modelState(pool, 'claude-opus-5-5', at + 2000);
  assert.equal(s.state, 'limited');
  assert.equal(s.until, at + 2 * L.HOUR);
  // The live reading kept the window's name and did not drop the others.
  assert.equal(pool.windows.session.label, '5-hour');
  assert.ok(pool.windows['weekly:fable']);
  // After its reset, with nothing newer: no longer limited, its share unknown.
  const later = L.modelState(pool, 'claude-opus-5-5', at + 3 * L.HOUR);
  assert.notEqual(later.state, 'limited');
  const w = L.windowNow(pool.windows.session, at + 3 * L.HOUR);
  assert.equal(w.state, 'reset');
  assert.equal(w.usedPercent, null);
  // A full read forgets a window the provider no longer reports; an older answer arriving late changes nothing.
  pool = L.mergeReading(pool, { pool: { key: 'claude:t' }, at: at + 4 * L.HOUR, source: 'read', windows: [{ id: 'session', usedPercent: 1 }, { id: 'week', usedPercent: 35 }] });
  assert.equal(pool.windows['weekly:fable'], undefined);
  pool = L.mergeReading(pool, { pool: { key: 'claude:t' }, at: at, source: 'live', partial: true, windows: [{ id: 'session', usedPercent: 99 }] });
  assert.equal(pool.windows.session.usedPercent, 1);
});

test('family scopes match words in order, not substrings', () => {
  const w = { scope: { family: 'gemini 4 argon' } };
  assert.ok(L.covers(w, 'gemini-4-argon-high'));
  assert.ok(!L.covers(w, 'gemini-3.8-flash-high'));
  assert.ok(!L.covers({ scope: { family: 'opus' } }, 'claude-opusx-5'));
  assert.ok(L.covers({ scope: { family: 'opus' } }, 'anthropic/claude-opus-5-5'));
});
