'use strict';
require('./win-hide.js'); // first: on Windows nothing this starts opens a window (design/70)
// plan-limits-worker.js — reads what a person's subscriptions still allow,
// AS that person (design/109). It runs in a process of its own, started by
// the person's actor (person-ops.js `plan.read`): for the owner, as this
// server's account; for someone on their own account, by their host, as
// them. So it reads their sign-ins with their rights, and nobody else's.
//
//   node plan-limits-worker.js     one JSON request on stdin, one JSON line out
//
//   request  { agentDir, want: [credential id] | null (every one found),
//              known: { id: { poolKey } }, renew: [credential id] }
//   answer   { found: [{ id, kind, provider, reader }],
//              results: [{ id, ok, reading?, identity?, error? }] }
//
// Credentials, and how each is used (never copied, never sent anywhere but
// to its own provider, never in the answer):
//
//   pi:<provider>    Pi's sign-ins (auth.json), through Pi's own code
//                    (ModelRuntime.getAuth): Pi renews an expired login under
//                    its own lock, as when it answers. Readers for anthropic,
//                    openai-codex and openrouter; other subscriptions (xai,
//                    kimi-coding, …) are found but have nothing to ask.
//   claude:<name>    Claude Code's logins (~/.claude, ~/.claude-accounts/<name>),
//                    read only. Claude Code renews them itself, rotating the
//                    refresh token: renewing one here would sign Claude Code
//                    out. An expired one is renewed by Claude Code, when the
//                    hub asks (`renew`): `claude -p /usage`, which makes no
//                    model call (0 tokens) and saves nothing.
//   agy              Antigravity's saved login, read only, when still valid.
//
// Network requests carry an honest user agent and go to the provider's own
// address, never through a model proxy a person set up for model calls.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const R = require('./plan-limits-read.js');

const UA = 'Chattering/' + (() => { try { return require('./package.json').version; } catch { return '0'; } })() + ' (plan limits)';
const TIMEOUT_MS = 15000;
const EXPIRY_MARGIN_MS = 60 * 1000;
const READERS = { anthropic: 'claude', 'openai-codex': 'chatgpt', openrouter: 'openrouter' };
const CLAUDE_BETA = 'oauth-2025-04-20';
// Tests point the providers' addresses at a local stand-in:
// CHATTERING_PLAN_LIMITS_HOSTS='{"api.anthropic.com":"http://127.0.0.1:9999"}'.
const HOSTS = (() => { try { return JSON.parse(process.env.CHATTERING_PLAN_LIMITS_HOSTS || '{}') || {}; } catch { return {}; } })();
const at = url => { const u = new URL(url); return HOSTS[u.host] ? HOSTS[u.host].replace(/\/+$/, '') + u.pathname + u.search : url; };
const ANTIGRAVITY = 'https://daily-cloudcode-pa.googleapis.com/v1internal:';

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// A JWT's claims, read locally (no check: only to know whose it is).
function jwtClaims(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return null; }
}

function createReader({ home = os.homedir(), agentDir = path.join(home, '.pi', 'agent'), fetchImpl = fetch, now = Date.now, loadPi = null, runClaude = null,
  claudeAccountsDir = process.env.CHATTERING_CLAUDE_ACCOUNTS_DIR || path.join(home, '.claude-accounts') } = {}) {
  async function get(url, { token, headers = {}, method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetchImpl(at(url), { method, headers: { Authorization: 'Bearer ' + token, 'User-Agent': UA, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) { throw fail('network', 'could not reach ' + new URL(url).host + ': ' + (e.cause && e.cause.code || e.message)); }
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) throw fail('signin', new URL(url).host + ' refused the sign-in (' + res.status + ')', { status: res.status });
    if (res.status === 429) throw fail('busy', new URL(url).host + ' asked to wait (429)', { status: 429, retryAfter: Number(res.headers.get && res.headers.get('retry-after')) || null });
    if (!res.ok) throw fail('http', new URL(url).host + ' answered ' + res.status, { status: res.status });
    try { return JSON.parse(text); } catch { throw fail('shape', new URL(url).host + ' answered something that is not JSON'); }
  }

  // ---- Pi's sign-ins ----
  let pi = null;
  async function piRuntime() {
    if (pi) return pi;
    pi = (async () => {
      const load = loadPi || (async () => {
        const dir = require('./runtime.js').piPackageDir();
        return import(pathToFileURL(path.join(dir, 'dist', 'index.js')).href);
      });
      const SDK = await load();
      return SDK.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'),
        allowModelNetwork: false, signal: AbortSignal.timeout(30000) });
    })();
    return pi;
  }
  async function piFound() {
    // No Pi sign-in file: nothing to load.
    if (!fs.existsSync(path.join(agentDir, 'auth.json'))) return [];
    let rt;
    try { rt = await piRuntime(); } catch { return []; }
    const out = [];
    for (const p of rt.getProviders()) {
      let configured = false, oauth = false;
      try { configured = rt.hasConfiguredAuth(p.id); oauth = configured && rt.isUsingOAuth(p.id); } catch {}
      if (!configured) continue;
      // A subscription signs in (OAuth); a key is billed per use, except a
      // key with a budget of its own (OpenRouter).
      if (!oauth && p.id !== 'openrouter') continue;
      out.push({ id: 'pi:' + p.id, kind: 'pi', provider: p.id, reader: !!READERS[p.id] });
    }
    return out;
  }
  async function piToken(provider) {
    const rt = await piRuntime();
    const auth = await rt.getAuth(provider).catch(e => { throw fail('signin', 'Pi could not renew its ' + provider + ' sign-in: ' + e.message); });
    const key = auth && auth.auth && auth.auth.apiKey;
    if (!key) throw fail('signin', 'Pi has no sign-in for ' + provider);
    return key;
  }

  // ---- Claude Code's logins ----
  function claudeAccounts() {
    const out = [{ name: 'default', dir: path.join(home, '.claude'), state: path.join(home, '.claude.json') }];
    let entries = [];
    try { entries = fs.readdirSync(claudeAccountsDir, { withFileTypes: true }); } catch {}
    for (const e of entries) if (e.isDirectory() && /^[a-z0-9][a-z0-9-]{0,30}$/.test(e.name) && e.name !== 'default') out.push({ name: e.name, dir: path.join(claudeAccountsDir, e.name), state: path.join(claudeAccountsDir, e.name, '.claude.json') });
    return out.filter(a => fs.existsSync(path.join(a.dir, '.credentials.json')));
  }
  const claudeLogin = a => { const j = readJson(path.join(a.dir, '.credentials.json')); return j && j.claudeAiOauth && j.claudeAiOauth.accessToken ? j.claudeAiOauth : null; };
  async function renewClaude(a) {
    // Claude Code renews its own login while showing /usage: no model call,
    // nothing saved, no hooks or plug-ins of the person's settings run, no
    // tool servers start. From a folder of Chattering's own.
    const cwd = path.join(home, '.cache', 'chattering', 'plan-limits');
    fs.mkdirSync(cwd, { recursive: true });
    const env = { ...process.env, ...(a.name === 'default' ? {} : { CLAUDE_CONFIG_DIR: a.dir }) };
    const run = runClaude || ((args, opts) => new Promise((resolve, reject) => execFile('claude', args, { ...opts, timeout: 45000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (e, out, err) => e ? reject(fail('renew', 'Claude Code could not renew its sign-in: ' + String(err || e.message).trim().slice(0, 200))) : resolve(out))));
    const out = await run(['-p', '/usage', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'local', '--output-format', 'json'], { cwd, env });
    // A safety check: had this become a model call, say so and stop renewing this way.
    let r = null; try { r = JSON.parse(out); } catch {}
    const last = Array.isArray(r) ? r[r.length - 1] : r;
    if (last && (Number(last.total_cost_usd) > 0 || Number(last.num_turns) > 0)) throw fail('renew', 'Claude Code answered /usage with a model call; Chattering stops renewing this way');
  }
  async function readClaude(a, { known, renew }) {
    let login = claudeLogin(a);
    if (!login) throw fail('signin', 'Claude Code is not signed in for ' + a.name);
    let renewed = false;
    if (Number(login.expiresAt) && login.expiresAt < now() + EXPIRY_MARGIN_MS) {
      if (!renew) throw fail('expired', 'Claude Code\u2019s sign-in for ' + a.name + ' has expired; Claude Code renews it when it next runs', { renewable: true });
      await renewClaude(a);
      login = claudeLogin(a);
      renewed = true;
      if (!login || (Number(login.expiresAt) && login.expiresAt < now() + EXPIRY_MARGIN_MS)) throw fail('expired', 'Claude Code did not renew its sign-in for ' + a.name);
    }
    const st = readJson(a.state);
    const acct = st && st.oauthAccount;
    let identity;
    if (acct && acct.accountUuid) identity = { poolKey: R.claudePoolKey({ accountUuid: acct.accountUuid, organizationUuid: acct.organizationUuid }), ...R.claudePlan({ organizationType: acct.organizationType, rateLimitTier: login.rateLimitTier || acct.organizationRateLimitTier, subscriptionType: login.subscriptionType }) };
    else if (known && known.poolKey) identity = { poolKey: known.poolKey, ...R.claudePlan({ rateLimitTier: login.rateLimitTier, subscriptionType: login.subscriptionType }) };
    else {
      const p = R.claudeProfile(await get('https://api.anthropic.com/api/oauth/profile', { token: login.accessToken, headers: { 'anthropic-beta': CLAUDE_BETA } }));
      identity = { poolKey: R.claudePoolKey(p), plan: p.plan, planLabel: p.planLabel };
    }
    const usage = await get('https://api.anthropic.com/api/oauth/usage', { token: login.accessToken, headers: { 'anthropic-beta': CLAUDE_BETA } });
    const reading = R.claudeUsage(usage, { at: now(), pool: { key: identity.poolKey, plan: identity.plan, planLabel: identity.planLabel } });
    return { identity, reading, renewed };
  }

  // ---- Antigravity's saved login ----
  const AGY_TOKEN = path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  async function readAgy() {
    const j = readJson(AGY_TOKEN);
    const t = j && j.token;
    if (!t || !t.access_token) throw fail('signin', 'Antigravity is not signed in');
    const exp = Date.parse(t.expiry || '');
    if (Number.isFinite(exp) && exp < now() + EXPIRY_MARGIN_MS) throw fail('expired', 'Antigravity keeps its renewed sign-in to itself; its saved one has expired. Its limits are read again when it saves a new one', { renewable: false });
    const sub = (jwtClaims(j.id_token) || {}).sub;
    if (!sub) throw fail('shape', 'Antigravity\u2019s saved login names no account');
    const load = await get(ANTIGRAVITY + 'loadCodeAssist', { token: t.access_token, method: 'POST', body: { metadata: { ideType: 'ANTIGRAVITY' } } });
    const plan = R.antigravityPlan(load);
    const identity = { poolKey: R.antigravityPoolKey(sub), plan: plan.plan, planLabel: plan.planLabel };
    const models = await get(ANTIGRAVITY + 'fetchAvailableModels', { token: t.access_token, method: 'POST', body: plan.project ? { project: plan.project } : {} });
    return { identity, reading: R.antigravityModels(models, { at: now(), pool: { key: identity.poolKey, plan: identity.plan, planLabel: identity.planLabel } }) };
  }

  // ---- one credential ----
  async function readOne(found, { known = {}, renew = [] } = {}) {
    const id = found.id;
    if (found.kind === 'claude') {
      const a = claudeAccounts().find(x => 'claude:' + x.name === id);
      if (!a) throw fail('signin', 'no Claude Code login ' + id.slice(7));
      return readClaude(a, { known: known[id], renew: renew.includes(id) });
    }
    if (found.kind === 'agy') return readAgy();
    if (found.kind === 'pi') {
      const p = found.provider;
      if (!READERS[p]) throw fail('no-reader', p + ' tells its limits only in its replies');
      const token = await piToken(p);
      if (p === 'anthropic') {
        let identity = known[id] && known[id].poolKey ? { poolKey: known[id].poolKey, plan: known[id].plan, planLabel: known[id].planLabel } : null;
        if (!identity) {
          const prof = R.claudeProfile(await get('https://api.anthropic.com/api/oauth/profile', { token, headers: { 'anthropic-beta': CLAUDE_BETA } }));
          identity = { poolKey: R.claudePoolKey(prof), plan: prof.plan, planLabel: prof.planLabel };
        }
        const usage = await get('https://api.anthropic.com/api/oauth/usage', { token, headers: { 'anthropic-beta': CLAUDE_BETA } });
        return { identity, reading: R.claudeUsage(usage, { at: now(), pool: { key: identity.poolKey, plan: identity.plan, planLabel: identity.planLabel } }) };
      }
      if (p === 'openai-codex') {
        const claims = jwtClaims(token) || {};
        const auth = claims['https://api.openai.com/auth'] || {};
        const reading = R.chatgptUsage(await get('https://chatgpt.com/backend-api/wham/usage', { token, headers: auth.chatgpt_account_id ? { 'chatgpt-account-id': auth.chatgpt_account_id } : {} }), { at: now() });
        return { identity: { poolKey: reading.pool.key, plan: reading.pool.plan, planLabel: reading.pool.planLabel }, reading };
      }
      if (p === 'openrouter') {
        const key = await get('https://openrouter.ai/api/v1/key', { token });
        const credits = await get('https://openrouter.ai/api/v1/credits', { token }).catch(() => null);
        const reading = R.openrouterKey(key, { at: now(), credits });
        return { identity: { poolKey: reading.pool.key, plan: reading.pool.plan, planLabel: reading.pool.planLabel }, reading };
      }
    }
    throw fail('no-reader', 'nothing reads ' + id);
  }

  async function found() {
    const out = await piFound();
    for (const a of claudeAccounts()) out.push({ id: 'claude:' + a.name, kind: 'claude', provider: a.name === 'default' ? 'claude-code' : 'claude-code-' + a.name, reader: true });
    if (fs.existsSync(AGY_TOKEN)) out.push({ id: 'agy', kind: 'agy', provider: 'agy', reader: true });
    return out;
  }

  async function read({ want = null, known = {}, renew = [] } = {}) {
    const all = await found();
    const chosen = want ? all.filter(f => want.includes(f.id)) : all.filter(f => f.reader);
    const results = await Promise.all(chosen.map(async f => {
      try {
        const r = await readOne(f, { known, renew });
        return { id: f.id, ok: true, identity: r.identity, reading: r.reading, ...(r.renewed ? { renewed: true } : {}) };
      } catch (e) {
        return { id: f.id, ok: false, error: { code: e.code || 'error', message: String(e.message || e).slice(0, 300), ...(e.status ? { status: e.status } : {}), ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}), ...(e.renewable ? { renewable: true } : {}) } };
      }
    }));
    for (const w of want || []) if (!chosen.some(f => f.id === w)) results.push({ id: w, ok: false, error: { code: 'gone', message: 'no such sign-in any more' } });
    return { found: all, results };
  }
  return { read, found, readOne };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 64 * 1024) break; }
  const req = JSON.parse(input || '{}');
  const reader = createReader({ agentDir: req.agentDir || undefined });
  const out = await reader.read({ want: Array.isArray(req.want) ? req.want.map(String) : null, known: req.known || {}, renew: Array.isArray(req.renew) ? req.renew.map(String) : [] });
  process.stdout.write(JSON.stringify(out) + '\n', () => process.exit(0));
}

if (require.main === module) {
  main().catch(e => { process.stdout.write(JSON.stringify({ error: String(e.message || e) }) + '\n', () => process.exit(1)); });
}

module.exports = { createReader, jwtClaims, UA };
