'use strict';
// design/109 end to end: the real server reads a Claude Code login through
// its worker (as this account), the routes show it, a Pi run's report moves
// it, and a refusal is shown at once and confirmed by the read it starts.
// The provider is a local stand-in serving the recorded reply.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const fx = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'plan-limits', name), 'utf8'));
const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };

test('the server reads a plan as its account, shows it, and follows live replies and refusals', { timeout: 90000 }, async t => {
  const root = path.join(__dirname, '..');
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-limits-server-')));
  // The stand-in provider: the recorded Team reply, its 5-hour share settable.
  let session = 3, usageCalls = 0, seenAuth = null, seenAgent = null;
  const provider = http.createServer((req, res) => {
    if (req.url === '/api/oauth/usage') {
      usageCalls++; seenAuth = req.headers.authorization; seenAgent = req.headers['user-agent'];
      const j = fx('anthropic-usage-team.json');
      j.limits[0].percent = session;
      j.limits[0].resets_at = new Date(Date.now() + 2 * 3600e3).toISOString();
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(j));
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => provider.listen(0, '127.0.0.1', r));
  const fake = 'http://127.0.0.1:' + provider.address().port;
  // A Claude Code login, valid for an hour, and its account as Claude Code keeps it.
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat-test', refreshToken: 'r', expiresAt: Date.now() + 3600e3, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acc-test', organizationUuid: 'org-test', organizationType: 'claude_max' } }));
  const agent = path.join(home, '.pi/agent'); fs.mkdirSync(path.join(agent, 'sessions/fixture'), { recursive: true });
  fs.writeFileSync(path.join(agent, 'sessions/fixture/chat.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'fixture', cwd: home }) + '\n');
  require('./helpers/first-run.js').answerFirstRun(home);
  const port = await freePort();
  const token = 'plan-limits-test-token', auth = { Authorization: 'Bearer ' + token };
  let log = '';
  const server = spawn(process.execPath, ['server.js'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...require('./helpers/home-env.js').homeEnv(home),
    PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_PUBLIC_URL: '', CHATTERING_TOKEN: token, CHATTERING_NO_WATCH: '1',
    CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'),
    PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, CHATTERING_PLAN_LIMITS_HOSTS: JSON.stringify({ 'api.anthropic.com': fake }) } });
  server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
  t.after(async () => {
    if (server.exitCode === null) { const gone = new Promise(r => server.once('exit', r)); server.kill('SIGTERM'); setTimeout(() => server.kill('SIGKILL'), 3000).unref(); await gone; }
    provider.close();
    await require('./helpers/cleanup.js').stopAndRemove(null, home);
  });
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(base + '/api/sessions', { headers: auth })).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  const get = async (q = '') => { const r = await fetch(base + '/api/plan-limits' + q, { headers: auth }); assert.equal(r.status, 200, log); return r.json(); };
  const observe = body => fetch(base + '/api/plan-limits/observe', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());

  // Read through the worker, as this account: the login's token went to the provider, with an honest name.
  const v = await get('?wait=1');
  assert.equal(seenAuth, 'Bearer sk-ant-oat-test');
  assert.match(seenAgent, /^Chattering\/.+\(plan limits\)$/);
  assert.equal(v.level, 'full');
  assert.equal(v.pools.length, 1, log);
  const pool = v.pools[0];
  assert.equal(pool.label, 'Claude Max 20×');
  assert.deepEqual(pool.windows.map(w => w.id), ['session', 'week', 'weekly:fable']);
  assert.equal(pool.windows[0].usedPercent, 3);
  assert.equal(v.providers['claude-code'].pool, pool.key);
  assert.equal(v.reserve, 15);
  assert.ok(!JSON.stringify(v).includes('sk-ant'), 'no token in the answer');

  // A Pi run reports a reply: the 5-hour window moves between reads.
  const reset = Math.round((Date.now() + 2 * 3600e3) / 1000);
  assert.equal((await observe({ provider: 'claude-code', model: 'claude-opus-5-5', headers: { 'anthropic-ratelimit-unified-5h-utilization': '0.86', 'anthropic-ratelimit-unified-5h-reset': String(reset), 'anthropic-ratelimit-unified-status': 'allowed', authorization: 'Bearer leaked' } })).ok, true);
  let w = (await get()).pools[0].windows.find(x => x.id === 'session');
  assert.equal(w.usedPercent, 86);
  assert.equal(w.source, 'live');
  assert.equal(w.state, 'near');

  // A refusal: limited at once, and the read it starts says the provider agrees.
  session = 100;
  const before = usageCalls;
  await observe({ provider: 'claude-code', model: 'claude-opus-5-5', error: 'Claude AI usage limit reached|' + reset });
  let now = await get();
  assert.equal(now.models['claude-code/claude-opus-5-5'] ? now.models['claude-code/claude-opus-5-5'].state : now.providers['claude-code'].state, 'limited');
  for (let i = 0; i < 100 && usageCalls === before; i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(usageCalls > before, 'the refusal asked the provider at once');
  for (let i = 0; i < 100; i++) { now = await get(); if (now.providers['claude-code'].state === 'limited') break; await new Promise(r => setTimeout(r, 50)); }
  assert.equal(now.providers['claude-code'].state, 'limited');
  assert.equal(now.providers['claude-code'].window, 'session');
  assert.ok(now.providers['claude-code'].until > Date.now(), 'and says when it is back');
  // The history kept both readings and the live reply.
  const db = path.join(home, 'cache', 'plan-limits.sqlite');
  assert.ok(fs.existsSync(db));
});
