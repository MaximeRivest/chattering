'use strict';
// plan-limits-service.js — the hub's knowledge of every plan (design/109):
// who reads which sign-in when, what live replies said, how it is merged,
// kept, estimated and shown, and to whom.
//
// Accounts: '' is this server's own (the owner, the household, guests and
// people on the owner's models draw on it); a name is a person on their own
// account with their own sign-ins (design/105). Credentials of an account:
// `pi:<provider>`, `claude:<name>`, `codex`, `agy` (plan-limits-worker.js).
// A route is how a request reaches a credential: a Pi provider, or an
// agent's own program (Claude Code with one of its accounts, Codex, agy).
//
// Reading costs a network call per sign-in and never a model call; it
// happens when someone looks (at most every READ_LOOKING_MS), while a pool
// is in use (every READ_ACTIVE_MS), right after a refusal or a reset, and
// otherwise rarely (READ_IDLE_MS, which also keeps each reader checked).
// Failures back off; a refused sign-in waits longer.

const L = require('./plan-limits.js');
const R = require('./plan-limits-read.js');
const live = require('./plan-limits-live.js');
const E = require('./plan-limits-estimate.js');

const { MIN, HOUR, DAY } = L;
const READ_LOOKING_MS = 90 * 1000;
const READ_ACTIVE_MS = 10 * MIN;
const READ_IDLE_MS = 6 * HOUR;
const LOOKING_MS = 3 * MIN;           // someone opened a picker or the plans page this recently
const ACTIVE_MS = 6 * HOUR;           // a pool used this recently is "in use"
const RENEW_EVERY_MS = 30 * MIN;      // Claude Code renews an expired login for us at most this often
const BACKOFF_MS = [MIN, 2 * MIN, 5 * MIN, 15 * MIN, HOUR];
const SIGNIN_BACKOFF_MS = 30 * MIN;
const REFUSED_HOLD_MS = 30 * MIN;     // a refusal that names no end holds this long without a read
const ESTIMATE_TTL_MS = 10 * MIN;
const CALIBRATION_DAYS = 60;
// The reader behind each credential, for the reader check (the canary).
const READER_OF = cred => cred.startsWith('claude:') || cred === 'pi:anthropic' ? 'claude' : cred === 'pi:openai-codex' ? 'chatgpt' : cred === 'pi:openrouter' ? 'openrouter' : cred === 'agy' ? 'antigravity' : cred === 'codex' ? 'codex' : null;
const READER_LABEL = { claude: 'Claude', chatgpt: 'ChatGPT', openrouter: 'OpenRouter', antigravity: 'Antigravity', codex: 'Codex' };
// Errors that say the reader itself is broken (the reply changed), not the sign-in or the network.
const READER_FAULT = new Set(['shape', 'http']);

// The credential a route reaches. `claudeAccount` names which Claude Code
// login a Claude Code conversation runs with.
function credOfRoute({ provider = '', harness = '', claudeAccount = '' } = {}) {
  if (harness === 'codex' || provider === 'codex') return 'codex';
  if (harness === 'agy' || provider === 'agy') return 'agy';
  if (harness === 'claude') return 'claude:' + (claudeAccount || 'default');
  if (provider === 'claude-code') return 'claude:default';
  const m = /^claude-code-([a-z0-9][a-z0-9-]*)$/.exec(provider);
  if (m) return 'claude:' + m[1];
  return provider ? 'pi:' + provider : null;
}
// The model-picker providers a credential serves.
function providersOfCred(cred) {
  if (cred === 'codex' || cred === 'agy') return [cred];
  if (cred.startsWith('claude:')) return [cred === 'claude:default' ? 'claude-code' : 'claude-code-' + cred.slice(7)];
  if (cred.startsWith('pi:')) return [cred.slice(3)];
  return [];
}
const routeKey = (account, cred) => (account || '') + '\n' + cred;

function createPlanLimits({ store, now = Date.now, readAs, codexRead = null, accounts = () => [''], ledger = null, catalog = () => [],
  claudeAccountName = id => id, personName = id => id, onChange = () => {}, onNotice = () => {}, log = () => {} } = {}) {
  const pools = new Map(Object.entries(store.pools()));
  const routes = new Map(); // account\ncred → { account, cred, pool, plan, planLabel, seenAt }
  for (const r of store.routes()) routes.set(routeKey(r.account, r.cred), r);
  const found = new Map(); // account → { at, creds: [{ id, kind, provider, reader }] }
  const creds = new Map(); // account\ncred → { readAt, okAt, nextAt, failures, error, renewAt }
  const checks = store.checks();
  const waiting = new Map(); // account\ncred → [live readings waiting for their pool]
  const reading = new Map(); // account → Promise (one read at a time per account)
  const looking = new Map(); // account → last time someone looked
  const usedAt = new Map(); // pool → last time a reply used it
  const changed = new Set();
  let changeTimer = null;
  let estimates = { at: 0, byPool: new Map() };

  // ---- changes: kept, then announced once per moment ----
  function touch(pool) {
    changed.add(pool);
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      const keys = [...changed]; changed.clear();
      for (const k of keys) if (pools.has(k)) store.savePool(k, pools.get(k), now());
      try { onChange(keys); } catch (e) { log('plan limits: change listener: ' + e.message); }
    }, 250);
    if (changeTimer.unref) changeTimer.unref();
  }

  // A reading merged into its pool; each window's numbers into the history;
  // a limit reached or back, said once.
  function apply(reading) {
    const r = L.cleanReading(reading);
    const before = pools.get(r.pool.key) || null;
    const after = L.mergeReading(before, r);
    pools.set(r.pool.key, after);
    for (const w of r.windows) store.record(r.pool.key, w, r.at, r.source);
    noticeChanges(r.pool.key, before, after);
    touch(r.pool.key);
    return after;
  }
  // As stored, not as now: a limit whose reset passed unread was still a
  // limit; only a read says it is over.
  const heldBack = w => !!w && (w.limited || (w.usedPercent != null && w.usedPercent >= 100));
  function noticeChanges(key, before, after) {
    const t = now();
    // Said from the provider's own numbers only: a refusal's words start a
    // read, and the read decides (no "limited… back" from a misread error).
    for (const w of Object.values(after.windows)) {
      if (w.source === 'error') continue;
      const was = before ? before.windows[w.id] : null;
      if (L.windowNow(w, t).state === 'limited' && !heldBack(was) && store.once('limited:' + key + ':' + w.id + ':' + (w.resetsAt || Math.floor(w.at / HOUR)), t)) {
        safeNotice({ kind: 'limited', pool: key, window: w.id, label: w.label, resetsAt: w.resetsAt || null, scope: w.scope || null });
      }
    }
    if (!before || !(after.readAt > (before.readAt || 0))) return;
    // A read: limits it shows over (or no longer reports), said once.
    for (const was of Object.values(before.windows)) {
      if (!heldBack(was) || was.source === 'error') continue;
      const is = after.windows[was.id];
      if (is && heldBack(is)) continue;
      if (Object.values(after.windows).some(x => heldBack(x) && (!x.scope || !was.scope || JSON.stringify(x.scope) === JSON.stringify(was.scope)))) continue;
      if (store.once('back:' + key + ':' + was.id + ':' + (was.resetsAt || Math.floor(was.at / HOUR)), t)) safeNotice({ kind: 'back', pool: key, window: was.id, label: was.label, scope: was.scope || null });
    }
  }
  function safeNotice(n) {
    try { onNotice({ ...n, accounts: accountsOfPool(n.pool), planLabel: labelOf(n.pool, accountsOfPool(n.pool)[0] ?? null) }); } catch (e) { log('plan limits: notice: ' + e.message); }
  }
  const accountsOfPool = key => [...new Set([...routes.values()].filter(r => r.pool === key).map(r => r.account))];

  // ---- reading ----
  function credStateOf(account, cred) {
    const k = routeKey(account, cred);
    if (!creds.has(k)) creds.set(k, { readAt: 0, okAt: 0, nextAt: 0, failures: 0, error: null, renewAt: 0 });
    return creds.get(k);
  }
  // Which of the account's readable sign-ins are due; one per pool: two
  // ways to the same account need one question.
  function due(account, maxAgeMs) {
    const t = now();
    const f = found.get(account);
    if (!f) return null; // never looked: ask for everything there is
    const list = f.creds.filter(c => c.reader).map(c => c.id);
    if (codexRead && !list.includes('pi:openai-codex')) list.push('codex');
    const byPool = new Map();
    const out = [];
    for (const id of list) {
      const s = credStateOf(account, id);
      const route = routes.get(routeKey(account, id));
      if (t < s.nextAt) continue;
      const pool = route && route.pool ? pools.get(route.pool) : null;
      if (pool && pool.readAt && t - pool.readAt < maxAgeMs) continue; // read through another way
      if (s.readAt && t - s.readAt < maxAgeMs) continue;
      if (route && route.pool) { if (byPool.has(route.pool)) continue; byPool.set(route.pool, id); }
      out.push(id);
    }
    return out;
  }
  // One read of an account's due sign-ins, at a time. `renew`: may Claude
  // Code be asked to renew an expired login (someone is looking).
  function readAccount(account, { maxAgeMs = READ_LOOKING_MS, renew = false, force = [] } = {}) {
    if (reading.has(account)) return reading.get(account);
    let want = due(account, maxAgeMs);
    // Forced (a refusal just came): that sign-in now, if anything reads it
    // and it is not backing off.
    if (want && force.length) {
      const readable = new Set(((found.get(account) || { creds: [] }).creds.filter(c => c.reader).map(c => c.id)).concat(codexRead ? ['codex'] : []));
      want = [...new Set([...want, ...force.filter(id => readable.has(id) && now() >= credStateOf(account, id).nextAt)])];
    }
    if (want && !want.length) return Promise.resolve(false);
    const p = (async () => {
      const t = now();
      const known = {};
      for (const r of routes.values()) if (r.account === account && r.pool) known[r.cred] = { poolKey: r.pool, plan: r.plan, planLabel: r.planLabel };
      const renewIds = renew ? [...routes.values()].filter(r => r.account === account && r.cred.startsWith('claude:')).map(r => r.cred)
        .concat((found.get(account) || { creds: [] }).creds.filter(c => c.kind === 'claude').map(c => c.id))
        .filter((id, i, a) => a.indexOf(id) === i && t - credStateOf(account, id).renewAt >= RENEW_EVERY_MS) : [];
      const piWant = want ? want.filter(id => id !== 'codex') : null;
      let answer = { found: (found.get(account) || {}).creds || [], results: [] };
      if (!piWant || piWant.length) {
        try { answer = await readAs(account, { want: piWant, known, renew: renewIds }); }
        catch (e) {
          log('plan limits: reading as ' + (account || 'this server') + ' failed: ' + e.message);
          for (const id of piWant || []) failed(account, id, { code: 'worker', message: e.message });
          answer = null;
        }
      }
      if (answer) {
        if (Array.isArray(answer.found)) found.set(account, { at: t, creds: answer.found });
        for (const id of renewIds) credStateOf(account, id).renewAt = t;
        for (const r of answer.results || []) result(account, r);
      }
      if (codexRead && (!want || want.includes('codex')) && !(found.get(account) || { creds: [] }).creds.some(c => c.id === 'pi:openai-codex')) {
        await readCodex(account);
      }
      return true;
    })().finally(() => reading.delete(account));
    reading.set(account, p);
    return p;
  }
  async function readCodex(account) {
    const s = credStateOf(account, 'codex');
    if (now() < s.nextAt) return;
    let raw = null;
    try { raw = await codexRead(account); }
    catch (e) { failed(account, 'codex', { code: /not signed|login|auth/i.test(e.message) ? 'signin' : 'error', message: e.message }); return; }
    if (!raw) { s.readAt = now(); s.nextAt = now() + READ_IDLE_MS; return; } // no Codex here
    observeCodex(account, raw, { source: 'read' });
  }
  function result(account, r) {
    if (!r || !r.id) return;
    if (!r.ok) return failed(account, r.id, r.error || {});
    const s = credStateOf(account, r.id);
    const t = now();
    Object.assign(s, { readAt: t, okAt: t, failures: 0, error: null, nextAt: 0 });
    if (r.identity && r.identity.poolKey) setRoute(account, r.id, r.identity, t);
    checked(r.id, { ok: true });
    if (r.reading && r.reading.pool && r.reading.pool.key) {
      apply(r.reading);
      flushWaiting(account, r.id);
    }
  }
  function failed(account, id, err) {
    const s = credStateOf(account, id);
    const t = now();
    s.readAt = t;
    s.failures = (s.failures || 0) + 1;
    s.error = { code: err.code || 'error', message: String(err.message || '').slice(0, 300), at: t, ...(err.renewable ? { renewable: true } : {}) };
    const wait = err.code === 'signin' || err.code === 'expired' ? SIGNIN_BACKOFF_MS
      : err.code === 'no-reader' || err.code === 'gone' ? DAY
      : err.code === 'busy' && err.retryAfter ? Math.max(MIN, err.retryAfter * 1000)
      : BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, s.failures - 1)];
    s.nextAt = t + wait;
    if (READER_FAULT.has(err.code)) checked(id, { ok: false, code: err.code, message: err.message });
    const route = routes.get(routeKey(account, id));
    if (route && route.pool) touch(route.pool);
  }
  function checked(cred, { ok, code = null, message = null }) {
    const reader = READER_OF(cred);
    if (!reader) return;
    const t = now();
    const prev = checks[reader] || {};
    checks[reader] = { reader, at: t, ok, code, message, lastOkAt: ok ? t : prev.lastOkAt || null };
    store.saveCheck(reader, checks[reader]);
  }
  function setRoute(account, cred, identity, t) {
    const k = routeKey(account, cred);
    const prev = routes.get(k);
    const next = { account: account || '', cred, pool: identity.poolKey, plan: identity.plan || null, planLabel: identity.planLabel || null, seenAt: t };
    routes.set(k, next);
    if (!prev || prev.pool !== next.pool || prev.planLabel !== next.planLabel || t - (prev.seenAt || 0) > HOUR) store.saveRoute(account, cred, { poolKey: next.pool, plan: next.plan, planLabel: next.planLabel }, t);
  }

  // ---- live: what replies say ----
  // obs: { provider, harness, claudeAccount, model, at, headers?, claudeEvent?, codexLimits?, error? }
  function observe(account, obs = {}) {
    const cred = credOfRoute(obs);
    if (!cred) return { ok: false, reason: 'no route' };
    const at = Number(obs.at) || now();
    const route = routes.get(routeKey(account, cred));
    const pool = route && route.pool;
    if (pool) usedAt.set(pool, at);
    let partial = null;
    if (obs.headers) {
      const h = live.fromHeaders(obs.headers, { at });
      // Headers of the wrong provider for the route are not believed (a
      // proxy in between, an extension that mislabels its replies).
      const want = cred.startsWith('claude:') || cred === 'pi:anthropic' ? 'claude' : cred === 'pi:openai-codex' || cred === 'codex' ? 'chatgpt' : null;
      if (h && h.family === want) partial = { ...h, pool: pool ? { key: pool, ...(h.plan ? { plan: h.plan, planLabel: R.chatgptPlanLabel(h.plan) } : {}) } : null };
    }
    if (obs.claudeEvent) { const r = live.claudeEvent(obs.claudeEvent, { at }); if (r) partial = { ...r, pool: pool ? { key: pool } : null }; }
    if (obs.codexLimits) return observeCodex(account, obs.codexLimits, { at, source: 'live', cred });
    if (obs.error) {
      const e = live.fromError(obs.error, { at });
      if (e) {
        if (e.kind === 'limit') {
          const model = String(obs.model || '').split('/').pop();
          partial = { at, source: 'error', partial: true, pool: pool ? { key: pool } : null,
            windows: [{ id: 'refused' + (model ? ':' + model : ''), label: 'refused', usedPercent: null, limited: true, resetsAt: e.resetsAt,
              expiresAt: e.resetsAt ? null : at + REFUSED_HOLD_MS, scope: model ? { models: [model] } : null }] };
        }
        // A refusal (or a throttle) asks for the truth at once.
        readAccount(account, { maxAgeMs: 0, force: [cred] }).catch(() => {});
      }
    }
    if (!partial) return { ok: true, pool: pool || null };
    if (!pool) {
      const k = routeKey(account, cred);
      const q = (waiting.get(k) || []).filter(x => at - x.at < 10 * MIN).slice(-19);
      q.push(partial); waiting.set(k, q);
      readAccount(account, { maxAgeMs: READ_ACTIVE_MS }).catch(() => {});
      return { ok: true, pool: null, waiting: true };
    }
    apply(partial);
    if (partial.windows.some(w => w.limited)) readAccount(account, { maxAgeMs: MIN, force: [cred] }).catch(() => {});
    return { ok: true, pool };
  }
  function flushWaiting(account, cred) {
    const k = routeKey(account, cred);
    const q = waiting.get(k);
    const route = routes.get(k);
    if (!q || !route || !route.pool) return;
    waiting.delete(k);
    for (const r of q) apply({ ...r, pool: { ...(r.pool || {}), key: route.pool } });
  }
  // Codex's own report (its menus, its notifications): a full read or a live update.
  function observeCodex(account, raw, { at = now(), source = 'read', cred = 'codex' } = {}) {
    let r;
    try { r = R.codexRateLimits(raw, { at, partial: source !== 'read', pool: (routes.get(routeKey(account, cred)) || {}).pool ? { key: routes.get(routeKey(account, cred)).pool } : null }); }
    catch (e) { if (source === 'read') { failed(account, cred, { code: 'shape', message: e.message }); } return { ok: false }; }
    if (!r.pool) {
      const known = routes.get(routeKey(account, 'pi:openai-codex'));
      if (!known || !known.pool) return { ok: false, reason: 'no account' };
      r.pool = { key: known.pool };
    }
    if (source === 'read') {
      const s = credStateOf(account, cred);
      Object.assign(s, { readAt: at, okAt: at, failures: 0, error: null, nextAt: 0 });
      checked('codex', { ok: true });
    }
    setRoute(account, cred, { poolKey: r.pool.key, plan: r.pool.plan, planLabel: r.pool.planLabel }, at);
    apply(r);
    return { ok: true, pool: r.pool.key };
  }

  // ---- the clock ----
  // Reads what is due: for accounts someone is looking at, for pools in
  // use, at each reset of a refused window, and the rest rarely.
  function tick() {
    const t = now();
    // Accounts with a plan known here, or that someone looked at: a person's
    // account nobody uses is not woken up to be read.
    const known = new Set([...routes.values()].map(r => r.account));
    for (const account of accounts()) {
      if (!known.has(account) && !looking.has(account) && account !== '') continue;
      const look = t - (looking.get(account) || 0) < LOOKING_MS;
      const mine = [...routes.values()].filter(r => r.account === account && r.pool);
      const active = mine.some(r => t - (usedAt.get(r.pool) || 0) < ACTIVE_MS);
      const resetDue = mine.some(r => {
        const p = pools.get(r.pool);
        return p && Object.values(p.windows).some(w => w.limited && w.resetsAt && w.resetsAt <= t && (p.readAt || 0) < w.resetsAt + 20000);
      });
      const maxAgeMs = resetDue ? 0 : look ? READ_LOOKING_MS : active ? READ_ACTIVE_MS : READ_IDLE_MS;
      readAccount(account, { maxAgeMs, renew: look }).catch(e => log('plan limits: ' + e.message));
    }
    if (t - (tick.prunedAt || 0) > DAY) { tick.prunedAt = t; try { store.prune(t); } catch {} }
  }
  // A route was used where no reply passed through here (an agent's own
  // program in a terminal: its conversation file grew). Its pool is in use.
  function used(account, route) {
    const cred = credOfRoute(route);
    const r = cred && routes.get(routeKey(account || '', cred));
    if (r && r.pool) usedAt.set(r.pool, now());
    return !!(r && r.pool);
  }
  // Someone looks at this account's plans: fresh numbers, soon.
  // `fresh`: someone asked to read again now (at most every 10 s).
  function looked(account, { fresh = false } = {}) {
    looking.set(account, now());
    return readAccount(account, { maxAgeMs: fresh ? 10000 : READ_LOOKING_MS, renew: true });
  }

  // ---- views ----
  // A pool's name: its plan, and which Claude Code login it is when an
  // account has more than one (two "Claude Max" would say nothing).
  function labelOf(key, account = null) {
    const p = pools.get(key);
    const rs = [...routes.values()].filter(r => r.pool === key && (account == null || r.account === account));
    const plan = (p && p.planLabel) || (rs.find(r => r.planLabel) || {}).planLabel || L.kindOfPool(key);
    const logins = [...new Set(rs.filter(r => r.cred.startsWith('claude:')).map(r => r.cred.slice(7)))];
    const several = account != null && new Set([...routes.values()].filter(r => r.account === account && r.cred.startsWith('claude:') && r.pool).map(r => r.pool)).size > 1;
    return logins.length && several ? plan + ' · ' + logins.map(n => claudeAccountName(n)).join(', ') : plan;
  }
  function estimateFor(key, t) {
    if (t - estimates.at > ESTIMATE_TTL_MS) estimates = { at: t, byPool: new Map(), facts: null };
    if (estimates.byPool.has(key)) return estimates.byPool.get(key);
    const out = {};
    const p = pools.get(key);
    if (!p || !ledger) { estimates.byPool.set(key, out); return out; }
    if (!estimates.facts) { try { estimates.facts = ledger.facts(t - CALIBRATION_DAYS * DAY, t) || []; } catch { estimates.facts = []; } }
    const facts = factsOf(key, estimates.facts);
    for (const w of Object.values(p.windows)) {
      if (w.source === 'error' || w.usedPercent == null && !w.limited) continue;
      const rows = store.history(key, t - CALIBRATION_DAYS * DAY, t, w.id);
      const scoped = w.scope ? facts.filter(f => L.covers(w, f.model)) : facts;
      const cal = E.calibrate(E.calibrationSamples(rows, (from, to) => scoped.reduce((n, f) => n + (f.ts > from && f.ts <= to ? Number(f.estimatedCost) || 0 : 0), 0)));
      const now_ = L.windowNow(w, t);
      const pace = E.pace(rows, now_, t);
      const start = windowStart(w);
      // Only the calls the window counts: a model family's own week, its models.
      const counted = w.scope ? facts.filter(f => L.covers(w, f.model)) : facts;
      const who = start ? E.attribution(counted.filter(f => f.ts > start && f.ts <= t), { used: now_.usedPercent, k: cal.enough ? cal.percentPerDollar : null }) : null;
      out[w.id] = { calibration: cal, pace, attribution: who, windowStart: start };
    }
    estimates.byPool.set(key, out);
    return out;
  }
  // When a window began: its reset less its length; a monthly budget, the
  // same day a calendar month before its reset.
  function windowStart(w) {
    if (!w.resetsAt) return null;
    if (w.durationMs) return w.resetsAt - w.durationMs;
    if (/^month\b/.test(w.label || '')) { const d = new Date(w.resetsAt); d.setUTCMonth(d.getUTCMonth() - 1); return d.getTime(); }
    return null;
  }
  // The usage index's calls that drew on a pool: by the route each took.
  function factsOf(key, rows) {
    const routesTo = [...routes.values()].filter(r => r.pool === key);
    if (!routesTo.length) return [];
    return rows.filter(f => {
      const account = f.account || '';
      const cred = credOfRoute({ provider: f.provider, harness: f.harness, claudeAccount: f.claudeAccount });
      return routesTo.some(r => r.account === account && r.cred === cred);
    });
  }

  // What one viewer sees. who: { account, level: 'full'|'status', owner,
  // userId, hideCreds: (cred) => bool, providers: Set|null (allowed providers) }.
  function view(who = {}) {
    const t = now();
    const account = who.account || '';
    const full = who.level !== 'status';
    const mine = [...routes.values()].filter(r => r.account === account && r.pool && !(who.hideCreds && who.hideCreds(r.cred)));
    const keys = [...new Set(mine.map(r => r.pool))];
    const providers = {};
    const models = {};
    const allowed = p => !who.providers || who.providers.has(p);
    for (const r of mine) {
      const p = pools.get(r.pool);
      if (!p) continue;
      for (const prov of providersOfCred(r.cred)) {
        if (!allowed(prov)) continue;
        const wins = Object.values(p.windows).map(w => L.windowNow(w, t));
        const whole = L.tightest(wins.filter(w => !w.scope));
        const blocking = wins.filter(w => !w.scope && w.state === 'limited');
        providers[prov] = whole ? { pool: r.pool, state: whole.state, ...(full ? { usedPercent: whole.usedPercent, window: whole.id, label: whole.label } : {}),
          resetsAt: whole.resetsAt, until: blocking.length ? Math.max(...blocking.map(w => w.resetsAt || 0)) || null : null, age: whole.age }
          : { pool: r.pool, state: 'unknown' };
        // Models with a window of their own: their state where it differs.
        if (wins.some(w => w.scope)) {
          for (const m of catalog().filter(m => m.provider === prov)) {
            const s = L.modelState(p, m.model, t);
            if (!s || !s.scoped && s.state === providers[prov].state) continue;
            models[prov + '/' + m.model] = { pool: r.pool, state: s.state, ...(full ? { usedPercent: s.usedPercent, window: s.window, label: s.label } : {}), resetsAt: s.resetsAt, until: s.until };
          }
          for (const w of wins.filter(w => w.scope && w.scope.models)) for (const id of w.scope.models) {
            if (models[prov + '/' + id]) continue;
            const s = L.modelState(p, id, t);
            models[prov + '/' + id] = { pool: r.pool, state: s.state, ...(full ? { usedPercent: s.usedPercent, window: s.window, label: s.label } : {}), resetsAt: s.resetsAt, until: s.until };
          }
        }
      }
    }
    // Another Claude account with room, for a Claude route that is short of it.
    const claudeRoutes = Object.keys(providers).filter(p => p === 'anthropic' || p === 'claude-code' || p.startsWith('claude-code-'));
    for (const p of claudeRoutes) {
      const s = providers[p];
      if (s.state !== 'limited' && s.state !== 'near') continue;
      const better = claudeRoutes.filter(q => q !== p && providers[q].pool !== s.pool && (providers[q].state === 'ok' || providers[q].state === 'reset'))
        .filter(q => q !== 'anthropic' || !p.startsWith('claude-code')); // the same kind of route: Claude Code's models by Claude Code
      if (better.length) s.better = better.map(q => ({ provider: q, label: labelOf(providers[q].pool, account), ...(full ? { usedPercent: providers[q].usedPercent } : {}) }));
    }
    if (!full) return { at: t, level: 'status', providers, models };
    const out = [];
    for (const key of keys) {
      const p = pools.get(key);
      if (!p) continue;
      const est = estimateFor(key, t);
      const rs = mine.filter(r => r.pool === key);
      const wins = L.sortWindows(Object.values(p.windows).map(w => L.windowNow(w, t))).map(w => {
        const e = est[w.id] || {};
        const who_ = e.attribution;
        const people = who_ ? (who.owner ? who_.people.map(x => ({ ...x, name: x.person ? personName(x.person) : 'not recorded' }))
          : (() => { const me = who_.people.find(x => x.person === who.userId); const rest = who_.people.filter(x => x.person !== who.userId); const others = rest.reduce((a, x) => ({ cost: a.cost + x.cost, share: a.share + x.share, percent: a.percent == null || x.percent == null ? null : a.percent + x.percent }), { cost: 0, share: 0, percent: 0 });
            return [...(me ? [{ ...me, name: 'you' }] : []), ...(rest.length ? [{ person: null, name: 'others', ...others }] : [])]; })()) : null;
        return { id: w.id, label: w.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt, resetAt: w.resetAt, durationMs: w.durationMs, state: w.state,
          limited: w.limited, scope: w.scope, source: w.source, at: w.at, age: w.age, fresh: w.fresh, ...(w.money ? { money: w.money } : {}), ...(w.count ? { count: w.count } : {}),
          ...(e.pace ? { pace: e.pace } : {}),
          ...(e.calibration && e.calibration.enough ? { calibration: { percentPerDollar: e.calibration.percentPerDollar, low: e.calibration.low, high: e.calibration.high, instances: e.calibration.instances } } : {}),
          ...(people ? { use: { people, cost: who_.cost, seenPercent: who_.seenPercent, outsidePercent: who_.outsidePercent, since: e.windowStart } } : {}) };
      });
      const credsOut = rs.map(r => {
        const s = credStateOf(account, r.cred);
        return { cred: r.cred, providers: providersOfCred(r.cred), readAt: s.okAt || null, error: s.error ? { code: s.error.code, message: s.error.message, at: s.error.at } : null };
      });
      const lastRead = Math.max(0, ...credsOut.map(c => c.readAt || 0)) || p.readAt || null;
      out.push({ key, kind: p.kind, label: labelOf(key, account), plan: p.plan || null, planLabel: p.planLabel || null, windows: wins, credits: p.credits || null,
        state: L.poolSummary(p, t).state, readAt: lastRead, liveAt: p.liveAt || null, routes: credsOut,
        error: credsOut.every(c => c.error) && credsOut.length ? credsOut[0].error : null });
    }
    out.sort((a, b) => (STATE_ORDER[b.state] || 0) - (STATE_ORDER[a.state] || 0) || a.label.localeCompare(b.label));
    // Sign-ins found that tell their limits only in replies (xAI, Kimi): named, so their absence is not a mystery.
    const f = found.get(account);
    const quiet = f ? f.creds.filter(c => !c.reader && !mine.some(r => r.cred === c.id)).map(c => ({ cred: c.id, provider: c.provider })) : [];
    // Sign-ins found whose plan could not be read yet, and why: a plan that
    // is not shown says so.
    const unread = f ? f.creds.filter(c => c.reader && !mine.some(r => r.cred === c.id) && !(who.hideCreds && who.hideCreds(c.id))).map(c => {
      const st = creds.get(routeKey(account, c.id));
      return { cred: c.id, provider: c.provider, error: st && st.error ? { code: st.error.code, message: st.error.message, at: st.error.at } : null };
    }) : [];
    const readers = Object.values(checks).map(c => ({ ...c, label: READER_LABEL[c.reader] || c.reader }));
    return { at: t, level: 'full', pools: out, providers, models, quiet, unread, readers };
  }
  const STATE_ORDER = { limited: 4, near: 3, ok: 2, reset: 1, unknown: 0 };

  // A window's history, for someone who sees that pool in full.
  function history(who = {}, pool, win, from, to) {
    if (who.level === 'status') throw Object.assign(new Error('the numbers of this plan are not yours to see'), { status: 403 });
    const mine = [...routes.values()].some(r => r.account === (who.account || '') && r.pool === pool && !(who.hideCreds && who.hideCreds(r.cred)));
    if (!mine) throw Object.assign(new Error('no such plan here'), { status: 404 });
    return store.history(pool, from, to, win || null);
  }
  // A model's state for the hub's own decisions (background work, recovery).
  function stateOf(account, { provider, harness, model, claudeAccount }) {
    const cred = credOfRoute({ provider, harness, claudeAccount });
    const r = cred && routes.get(routeKey(account || '', cred));
    const p = r && r.pool ? pools.get(r.pool) : null;
    return p ? L.modelState(p, model || '', now()) : null;
  }

  return { observe, observeCodex, readAccount, looked, used, tick, view, history, stateOf, credOfRoute, providersOfCred,
    _pools: pools, _routes: routes, _creds: creds, _found: found };
}

module.exports = { createPlanLimits, credOfRoute, providersOfCred, READ_LOOKING_MS, READ_ACTIVE_MS, READ_IDLE_MS, LOOKING_MS };
