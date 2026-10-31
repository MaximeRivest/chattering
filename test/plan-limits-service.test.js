'use strict';
// design/109: who reads what when, live replies, refusals, notices, views.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPlanLimits } = require('../plan-limits-service.js');
const { memoryStore, openStore } = require('../plan-limits-store.js');
const R = require('../plan-limits-read.js');
const L = require('../plan-limits.js');

const fx = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'plan-limits', name), 'utf8'));
const MAX = R.claudePoolKey({ accountUuid: 'acc-max', organizationUuid: 'org-max' });
const TEAM = R.claudePoolKey({ accountUuid: 'acc-team', organizationUuid: 'org-team' });

function clock(start = Date.parse('2026-10-31T12:00:00Z')) { let t = start; const now = () => t; now.tick = ms => { t += ms; }; return now; }
// A worker that answers from fixtures; `say` changes what it says next.
function fakeWorker(now) {
  const calls = [];
  let usage = { session: 20, week: 40 };
  let teamUsage = { session: 3, week: 34 };
  const claudeReading = (key, u, at) => R.claudeUsage({ limits: [
    { kind: 'session', group: 'session', percent: u.session, severity: 'normal', resets_at: new Date(at + 2 * L.HOUR).toISOString(), scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: u.week, severity: 'normal', resets_at: new Date(at + 3 * L.DAY).toISOString(), scope: null },
    { kind: 'weekly_scoped', group: 'weekly', percent: u.fable || 0, severity: 'normal', resets_at: new Date(at + 3 * L.DAY).toISOString(), scope: { model: { id: null, display_name: 'Fable' } } },
  ] }, { at, pool: { key, planLabel: key === MAX ? 'Claude Max 20×' : 'Claude Team 5×' } });
  const found = [
    { id: 'pi:anthropic', kind: 'pi', provider: 'anthropic', reader: true },
    { id: 'pi:xai', kind: 'pi', provider: 'xai', reader: false },
    { id: 'claude:default', kind: 'claude', provider: 'claude-code', reader: true },
    { id: 'claude:bigspin', kind: 'claude', provider: 'claude-code-bigspin', reader: true },
  ];
  let fail = null;
  const readAs = async (account, req) => {
    calls.push({ account, ...req });
    const ids = req.want || found.filter(f => f.reader).map(f => f.id);
    return { found, results: ids.map(id => {
      if (fail && fail.id === id) return { id, ok: false, error: fail.error };
      if (id === 'claude:bigspin') return { id, ok: true, identity: { poolKey: TEAM, planLabel: 'Claude Team 5×' }, reading: claudeReading(TEAM, teamUsage, now()) };
      if (id === 'pi:anthropic' || id === 'claude:default') return { id, ok: true, identity: { poolKey: MAX, planLabel: 'Claude Max 20×' }, reading: claudeReading(MAX, usage, now()) };
      return { id, ok: false, error: { code: 'no-reader', message: 'none' } };
    }) };
  };
  return { readAs, calls, say: u => { usage = { ...usage, ...u }; }, sayTeam: u => { teamUsage = { ...teamUsage, ...u }; }, failNext: f => { fail = f; } };
}
function setup(opts = {}) {
  const now = clock();
  const w = fakeWorker(now);
  const notices = [];
  const store = opts.store || memoryStore();
  const svc = createPlanLimits({ store, now, readAs: w.readAs, onNotice: n => notices.push(n), claudeAccountName: n => n === 'default' ? 'personal' : n,
    catalog: () => [{ provider: 'claude-code', model: 'claude-opus-5-5' }, { provider: 'claude-code', model: 'claude-fable-5-1' }, { provider: 'anthropic', model: 'claude-opus-5-5' }],
    ...(opts.svc || {}) });
  return { now, w, svc, notices, store };
}

test('two ways to one account are one pool, read once; the other account is its own', async () => {
  const { svc, w, now } = setup();
  await svc.looked('');
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0].want, null); // the first time: everything there is
  const v = svc.view({ account: '', owner: true });
  assert.equal(v.pools.length, 2);
  assert.equal(v.providers.anthropic.pool, MAX);
  assert.equal(v.providers['claude-code'].pool, MAX);
  assert.equal(v.providers['claude-code-bigspin'].pool, TEAM);
  assert.equal(v.providers['claude-code'].usedPercent, 40);
  assert.equal(v.providers['claude-code'].window, 'week');
  // Labels say which login when there are two Claude plans.
  assert.deepEqual(v.pools.map(p => p.label).sort(), ['Claude Max 20× · personal', 'Claude Team 5× · bigspin']);
  // A sign-in found with nothing to ask is named.
  assert.deepEqual(v.quiet, [{ cred: 'pi:xai', provider: 'xai' }]);
  // Looked at again at once: nothing is asked.
  await svc.looked('');
  assert.equal(w.calls.length, 1);
  // Later: one question per pool, not per way to it.
  now.tick(2 * L.MIN);
  await svc.looked('');
  assert.equal(w.calls.length, 2);
  assert.equal(w.calls[1].want.length, 2);
  assert.ok(w.calls[1].want.includes('claude:bigspin'));
  assert.equal(w.calls[1].want.filter(id => id === 'pi:anthropic' || id === 'claude:default').length, 1);
});

test('a live reply moves the window between reads, and its history is kept', async () => {
  const { svc, now, store } = setup();
  await svc.looked('');
  now.tick(30 * 1000);
  const r = svc.observe('', { provider: 'claude-code', model: 'claude-opus-5-5', headers: {
    'anthropic-ratelimit-unified-5h-utilization': '0.35', 'anthropic-ratelimit-unified-5h-reset': String(Math.round((now() + 2 * L.HOUR) / 1000)),
    'anthropic-ratelimit-unified-7d-utilization': '0.41', 'anthropic-ratelimit-unified-7d-reset': String(Math.round((now() + 3 * L.DAY) / 1000)), 'anthropic-ratelimit-unified-status': 'allowed', authorization: 'secret' } });
  assert.equal(r.pool, MAX);
  const v = svc.view({ account: '', owner: true });
  const max = v.pools.find(p => p.key === MAX);
  assert.equal(max.windows.find(w => w.id === 'session').usedPercent, 35);
  assert.equal(max.windows.find(w => w.id === 'session').source, 'live');
  // The Fable window, known only from a read, is still there.
  assert.ok(max.windows.find(w => w.id === 'weekly:fable'));
  assert.deepEqual(store.history(MAX, 0, Infinity, 'session').map(x => x.used), [20, 35]);
  // Headers of another provider on a Claude route are not believed.
  svc.observe('', { provider: 'claude-code', headers: { 'x-codex-primary-used-percent': '99', 'x-codex-primary-window-minutes': '300' } });
  assert.equal(svc.view({ account: '', owner: true }).providers['claude-code'].usedPercent, 41);
});

test('a reply on a route whose pool is not known yet waits for the read that names it', async () => {
  const { svc, w } = setup();
  const r = svc.observe('', { provider: 'claude-code-bigspin', headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.5', 'anthropic-ratelimit-unified-5h-reset': '1893456000', 'anthropic-ratelimit-unified-status': 'allowed' } });
  assert.equal(r.waiting, true);
  await new Promise(res => setImmediate(res));
  await svc.readAccount(''); // the read it asked for (already running: the same one)
  assert.equal(w.calls.length, 1);
  const team = svc.view({ account: '', owner: true }).pools.find(p => p.key === TEAM);
  // The live reply came after the read had been asked for, and is newer.
  assert.ok(team.windows.find(x => x.id === 'session').usedPercent >= 3);
});

test('a refused reply: limited at once, said once, the truth asked at once, and back after its reset', async () => {
  const { svc, w, now, notices } = setup();
  await svc.looked('');
  now.tick(5 * L.MIN);
  svc.observe('', { provider: 'claude-code', model: 'claude-opus-5-5', error: 'Claude AI usage limit reached|' + Math.round((now() + 90 * L.MIN) / 1000) });
  let s = svc.stateOf('', { provider: 'claude-code', model: 'claude-opus-5-5' });
  assert.equal(s.state, 'limited');
  assert.equal(s.until, Math.round((now() + 90 * L.MIN) / 1000) * 1000);
  // Not announced from the error's words: the read decides.
  assert.equal(notices.length, 0);
  await new Promise(res => setImmediate(res));
  // The forced read: the provider now says the 5-hour window is spent.
  w.say({ session: 100 });
  assert.ok(w.calls.length >= 2);
  now.tick(L.MIN);
  await svc.readAccount('', { maxAgeMs: 0, force: ['claude:default'] });
  s = svc.stateOf('', { provider: 'claude-code', model: 'claude-fable-5-1' });
  assert.equal(s.state, 'limited');
  assert.equal(s.window, 'session');
  // Said once, from the provider's numbers.
  assert.deepEqual(notices.map(n => [n.kind, n.window]), [['limited', 'session']]);
  assert.equal(notices[0].planLabel, 'Claude Max 20× · personal');
  await svc.readAccount('', { maxAgeMs: 0 });
  assert.equal(notices.length, 1);
  // Past the reset, the clock reads, the provider says 0%: back, once.
  now.tick(2 * L.HOUR + L.MIN);
  w.say({ session: 0 });
  svc.tick();
  await svc.readAccount('');
  assert.equal(svc.stateOf('', { provider: 'claude-code', model: 'claude-opus-5-5' }).state, 'ok');
  assert.equal(notices.filter(n => n.kind === 'back').length, 1, JSON.stringify(notices.map(n => [n.kind, n.window])));
});

test('failures back off; a refused sign-in waits longer; a changed reply marks the reader broken', async () => {
  const { svc, w, now } = setup();
  await svc.looked('');
  now.tick(2 * L.MIN);
  w.failNext({ id: 'claude:bigspin', error: { code: 'signin', message: 'api.anthropic.com refused the sign-in (401)' } });
  await svc.looked('');
  const n = w.calls.length;
  now.tick(2 * L.MIN);
  await svc.looked('');
  assert.ok(!w.calls.slice(n).some(c => (c.want || []).includes('claude:bigspin')), 'a refused sign-in is not asked again two minutes later');
  const team = svc.view({ account: '', owner: true }).pools.find(p => p.key === TEAM);
  assert.equal(team.routes[0].error.code, 'signin');
  w.failNext({ id: 'pi:anthropic', error: { code: 'shape', message: 'Claude usage: the reply no longer has its limits' } });
  now.tick(2 * L.MIN);
  await svc.readAccount('', { maxAgeMs: 0 });
  const readers = svc.view({ account: '', owner: true }).readers;
  const claude = readers.find(r => r.reader === 'claude');
  // Another way to the same reader worked before: it is not "never worked".
  assert.ok(claude.lastOkAt);
});

test('people drawing on someone else\u2019s plan see whether a model answers, not the numbers', async () => {
  const { svc } = setup();
  await svc.looked('');
  const v = svc.view({ account: '', level: 'status', providers: new Set(['claude-code']) });
  assert.equal(v.level, 'status');
  assert.equal(v.pools, undefined);
  assert.deepEqual(Object.keys(v.providers), ['claude-code']);
  assert.equal(v.providers['claude-code'].usedPercent, undefined);
  assert.equal(v.providers['claude-code'].state, 'ok');
});

test('a Claude route short of room points to the other Claude account', async () => {
  const { svc, w, now } = setup();
  w.say({ week: 95 });
  await svc.looked('');
  const v = svc.view({ account: '', owner: true });
  assert.equal(v.providers['claude-code'].state, 'near');
  assert.deepEqual(v.providers['claude-code'].better.map(b => b.provider), ['claude-code-bigspin']);
  assert.equal(v.providers['claude-code-bigspin'].better, undefined);
  // A model with a window of its own is listed where it is the tighter one.
  w.say({ week: 10, fable: 85 });
  now.tick(2 * L.MIN);
  await svc.looked('');
  const m = svc.view({ account: '', owner: true }).models;
  assert.equal(m['claude-code/claude-fable-5-1'].window, 'weekly:fable');
});

test('estimates: calibration from whole windows, pace, and who used the window', async () => {
  const now = clock(Date.parse('2026-10-01T00:00:00Z'));
  const store = memoryStore();
  // Five past 5-hour windows, each rising 20 points for $10 of use.
  const facts = [];
  for (let i = 0; i < 5; i++) {
    const start = now() + i * 6 * L.HOUR, reset = start + 5 * L.HOUR;
    for (let j = 0; j <= 4; j++) store.record(MAX, { id: 'session', usedPercent: 5 * j, resetsAt: reset }, start + j * L.HOUR, 'read');
    for (let j = 0; j < 4; j++) facts.push({ ts: start + j * L.HOUR + 30 * L.MIN, estimatedCost: 2.5, provider: 'claude-code', person: j % 2 ? 'lilly' : 'maxime', account: '' });
  }
  now.tick(5 * 6 * L.HOUR + 3 * L.HOUR);
  // The current window: 30% now, rising 10 points an hour.
  const start = now() - 3 * L.HOUR, reset = now() + 2 * L.HOUR;
  for (let j = 0; j <= 3; j++) store.record(MAX, { id: 'session', usedPercent: 10 * j, resetsAt: reset }, start + j * L.HOUR, 'read');
  for (let j = 0; j < 3; j++) facts.push({ ts: start + j * L.HOUR + 1, estimatedCost: 2.5, provider: 'claude-code', person: 'maxime', account: '' });
  const readAs = async () => ({ found: [{ id: 'claude:default', kind: 'claude', provider: 'claude-code', reader: true }],
    results: [{ id: 'claude:default', ok: true, identity: { poolKey: MAX, planLabel: 'Claude Max 20×' }, reading: { pool: { key: MAX }, at: now(), source: 'read', windows: [{ id: 'session', usedPercent: 30, resetsAt: reset, durationMs: 5 * L.HOUR }] } }] });
  const svc = createPlanLimits({ store, now, readAs, ledger: { facts: (from, to) => facts.filter(f => f.ts >= from && f.ts <= to) }, personName: id => id[0].toUpperCase() + id.slice(1) });
  await svc.looked('');
  const w = svc.view({ account: '', owner: true, userId: 'maxime' }).pools[0].windows.find(x => x.id === 'session');
  // 5 past windows: 20 points for $10 each; this one so far: 30 points for $7.50.
  assert.equal(Math.round(w.calibration.percentPerDollar * 100) / 100, Math.round(130 / 57.5 * 100) / 100);
  assert.equal(w.calibration.instances, 6);
  assert.equal(w.calibration.low, 2);
  assert.equal(Math.round(w.pace.perHour), 10);
  assert.equal(w.pace.hitsAt, null); // 30% + 2 h × 10 = 50%: it holds
  assert.equal(w.use.people[0].name, 'Maxime');
  assert.ok(w.use.outsidePercent >= 0);
  // Someone else sees themselves and "others", never another person's name.
  const lilly = svc.view({ account: '', owner: false, userId: 'lilly' }).pools[0].windows.find(x => x.id === 'session');
  assert.deepEqual(lilly.use.people.map(p => p.name), ['others']);
});

test('the store keeps a window\u2019s row when it changes, and a heartbeat when it does not', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'plan-limits-'));
  try {
    const s = openStore(path.join(dir, 'p.sqlite'));
    const w = { id: 'session', usedPercent: 10, resetsAt: 1000 };
    assert.equal(s.record('claude:x', w, 1, 'read'), true);
    assert.equal(s.record('claude:x', w, 2, 'live'), false);
    assert.equal(s.record('claude:x', { ...w, usedPercent: 11 }, 3, 'live'), true);
    assert.equal(s.record('claude:x', { ...w, usedPercent: 11 }, 3 + 16 * 60 * 1000, 'read'), true);
    assert.deepEqual(s.history('claude:x', 0, Infinity).map(r => r.used), [10, 11, 11]);
    assert.equal(s.once('a', 1), true);
    assert.equal(s.once('a', 2), false);
    s.saveRoute('', 'claude:default', { poolKey: 'claude:x', planLabel: 'Claude Max' }, 5);
    assert.equal(s.routes()[0].pool, 'claude:x');
    s.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
