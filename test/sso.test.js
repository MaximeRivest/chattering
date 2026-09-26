'use strict';
// Company sign-in (OpenID Connect), per-person walls and spending limits
// (design/72), against a stand-in identity provider with a real signing
// key: the flow a browser follows, forged tokens refused, the roster
// linked, and a real server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createOidc, admission } = require('../oidc.js');
const { homeEnv } = require('./helpers/home-env.js');
const { registerConsole, consoleFetch } = require('./helpers/console-fetch.js');

// ---- a stand-in identity provider --------------------------------------------
async function provider({ claims = {}, alg = 'RS256' } = {}) {
  const { publicKey, privateKey } = alg === 'ES256' ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }) : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg };
  const codes = new Map();
  const p = { issuer: '', claims, tamper: null };
  const sign = (payload, key = privateKey, a = alg) => {
    const h = Buffer.from(JSON.stringify({ alg: a, kid: 'k1', typ: 'JWT' })).toString('base64url');
    const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = a === 'none' ? '' : crypto.sign(a === 'ES256' ? 'sha256' : 'sha256', Buffer.from(h + '.' + b), a === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key).toString('base64url');
    return h + '.' + b + '.' + sig;
  };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, p.issuer);
    if (u.pathname === '/.well-known/openid-configuration') return res.end(JSON.stringify({ issuer: p.issuer, authorization_endpoint: p.issuer + '/authorize', token_endpoint: p.issuer + '/token', jwks_uri: p.issuer + '/jwks' }));
    if (u.pathname === '/jwks') return res.end(JSON.stringify({ keys: [jwk] }));
    if (u.pathname === '/authorize') {
      const code = crypto.randomBytes(8).toString('hex');
      codes.set(code, { nonce: u.searchParams.get('nonce'), challenge: u.searchParams.get('code_challenge'), client: u.searchParams.get('client_id'), redirect: u.searchParams.get('redirect_uri') });
      res.writeHead(302, { Location: u.searchParams.get('redirect_uri') + '?code=' + code + '&state=' + encodeURIComponent(u.searchParams.get('state')) });
      return res.end();
    }
    if (u.pathname === '/token') {
      let body = ''; for await (const c of req) body += c;
      const f = new URLSearchParams(body), saved = codes.get(f.get('code'));
      codes.delete(f.get('code'));
      const basic = Buffer.from(String(req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString();
      const verified = saved && crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') === saved.challenge && f.get('redirect_uri') === saved.redirect;
      if (!verified || basic !== 'app:shh') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant' })); }
      const t = Math.floor(Date.now() / 1000);
      let payload = { iss: p.issuer, aud: 'app', sub: 'user-1', iat: t, exp: t + 300, nonce: saved.nonce, email: 'ada@acme.test', email_verified: true, name: 'Ada Lovelace', ...p.claims };
      let token = sign(payload);
      if (p.tamper === 'key') token = sign(payload, other);
      if (p.tamper === 'none') token = sign(payload, null, 'none');
      if (p.tamper === 'aud') token = sign({ ...payload, aud: 'someone-else' });
      if (p.tamper === 'expired') token = sign({ ...payload, exp: t - 3600 });
      if (p.tamper === 'nonce') token = sign({ ...payload, nonce: 'other' });
      return res.end(JSON.stringify({ id_token: token, access_token: 'x', token_type: 'Bearer' }));
    }
    res.statusCode = 404; res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  p.issuer = 'http://127.0.0.1:' + server.address().port;
  p.close = () => new Promise(r => server.close(r));
  return p;
}
// A browser's walk through the flow, over plain fetch with manual redirects.
async function walk(oidc, config, redirectUri) {
  const { url } = await oidc.start(config, { redirectUri, next: '/x' });
  const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  return oidc.finish(config, Object.fromEntries(back.searchParams));
}

test('the flow: PKCE, state and nonce; a verified token names the person', async t => {
  for (const alg of ['RS256', 'ES256']) {
    const p = await provider({ alg });
    t.after(() => p.close());
    const config = { issuer: p.issuer, clientId: 'app', clientSecret: 'shh' };
    const oidc = createOidc();
    const { claims, next } = await walk(oidc, config, 'http://localhost/cb');
    assert.equal(claims.sub, 'user-1'); assert.equal(next, '/x');
  }
});

test('forged or stale tokens are refused, and a state works once', async t => {
  const p = await provider();
  t.after(() => p.close());
  const config = { issuer: p.issuer, clientId: 'app', clientSecret: 'shh' };
  const oidc = createOidc();
  for (const [tamper, why] of [['key', /signature/], ['none', /not accepted/], ['aud', /another application/], ['expired', /expired/], ['nonce', /does not answer/]]) {
    p.tamper = tamper;
    await assert.rejects(walk(oidc, config, 'http://localhost/cb'), why, tamper);
  }
  p.tamper = null;
  const { url, state } = await oidc.start(config, { redirectUri: 'http://localhost/cb' });
  const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
  await oidc.finish(config, Object.fromEntries(back.searchParams));
  await assert.rejects(oidc.finish(config, { state, code: back.searchParams.get('code') }), /expired or was already used/, 'a replayed callback');
  await assert.rejects(walk(oidc, { ...config, clientSecret: 'wrong' }, 'http://localhost/cb'), /invalid_grant/, 'the provider refuses a wrong client secret');
});

test('admission: verified email in an allowed domain; admin groups', () => {
  const cfg = { allowedDomains: ['acme.test'], adminGroups: ['ops'], groupsClaim: 'groups' };
  assert.equal(admission(cfg, { email: 'a@acme.test', email_verified: true }).ok, true);
  assert.equal(admission(cfg, { email: 'a@acme.test', email_verified: false }).ok, false, 'an unverified address proves nothing');
  assert.equal(admission(cfg, { email: 'a@evil.test', email_verified: true }).ok, false);
  assert.equal(admission(cfg, { email: 'a@acme.test', email_verified: true, groups: ['OPS'] }).role, 'admin');
  assert.equal(admission({ allowedDomains: [] }, { sub: 'x' }).ok, true, 'no list: the provider decides who exists');
});

test('a real server: company sign-in makes and links the person; walls per person; spending limits', { timeout: 120000 }, async t => {
  const p = await provider({ claims: { groups: ['staff'] } });
  t.after(() => p.close());
  const testHomes = path.join(os.homedir(), '.cache', 'chattering-test-homes');
  fs.mkdirSync(testHomes, { recursive: true });
  const home = fs.mkdtempSync(path.join(testHomes, 'sso-'));
  const agent = path.join(home, '.pi', 'agent');
  const secret = path.join(home, 'Projects', 'secret'), shared = path.join(home, 'Projects', 'shared');
  const line = o => JSON.stringify(o) + '\n';
  for (const [dir, id, text] of [[secret, '01a0secret000000000000000000000000', 'the zebra plan'], [shared, '01a0shared000000000000000000000000', 'the open plan']]) {
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'README.md'), text + '\n');
    const sd = path.join(agent, 'sessions', require('../runtime.js').piSessionDirName(dir)); fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, `2026-09-26T10-00-00-000Z_${id}.jsonl`), line({ type: 'session', version: 3, id, timestamp: '2026-09-26T10:00:00.000Z', cwd: dir })
      + line({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-09-26T10:00:01.000Z', message: { role: 'user', content: text } }));
  }
  const cfgDir = require('./helpers/home-env.js').appDir(home, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  const settings = { settingsVersion: require('../settings.js').SETTINGS_VERSION, backgroundAi: { decidedAt: 'x', names: false, memory: false },
    sso: { issuer: p.issuer, clientId: 'app', clientSecret: 'shh', name: 'Acme', allowedDomains: ['acme.test'], autoProvision: true, adminGroups: [] } };
  fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify(settings));
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const q = s.address().port; s.close(() => r(q)); }); });
  registerConsole(port, 'tok');
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...homeEnv(home), PORT: String(port), CHATTERING_TLS_PORT: '0', CHATTERING_PREVIEW_PORT: '0', CHATTERING_HOST: '127.0.0.1', CHATTERING_PUBLIC_URL: '', CHATTERING_LAN: '', CHATTERING_TOKEN: 'tok', CHATTERING_NO_WATCH: '1', CHATTERING_NO_LEDGER: '1', CHATTERING_NO_SYNC: '1',
      CHATTERING_CACHE_DIR: path.join(home, 'cache'), CHATTERING_CHECKPOINT_DIR: path.join(home, 'checkpoints'), CHATTERING_DELEGATION_ROOT: path.join(home, 'delegations'), PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent } });
  let log = ''; child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(() => require('./helpers/cleanup.js').stopAndRemove(child, home));
  const base = 'http://127.0.0.1:' + port;
  let list = [];
  for (let i = 0; i < 200 && list.length < 2; i++) { try { list = await (await consoleFetch(base + '/api/sessions')).json(); } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert.equal(list.length, 2, log.slice(-1000));

  // The sign-in page offers the company; the flow ends signed in, a person made.
  assert.match(await (await fetch(base + '/')).text(), /Sign in with Acme/);
  const signIn = async () => {
    const toProvider = (await fetch(base + '/auth/sso?next=/%23here', { redirect: 'manual' })).headers.get('location');
    assert.ok(toProvider.startsWith(p.issuer + '/authorize?'), toProvider);
    const callback = (await fetch(toProvider, { redirect: 'manual' })).headers.get('location');
    const done = await fetch(callback, { redirect: 'manual' });
    return done;
  };
  let done = await signIn();
  assert.equal(done.status, 302, await done.text());
  const cookie = (done.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^chattering=/);
  const me = await (await fetch(base + '/api/users', { headers: { Cookie: cookie } })).json();
  assert.equal(me.me.name, 'Ada Lovelace'); assert.equal(me.me.role, 'member');
  done = await signIn();
  assert.equal((await (await consoleFetch(base + '/api/users')).json()).users.filter(u => u.name === 'Ada Lovelace').length, 1, 'the second sign-in finds the same person');
  // An address outside the company is refused, and says why.
  p.claims.email = 'eve@evil.test'; p.claims.sub = 'user-2';
  const refused = await signIn();
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /evil\.test are not admitted/);
  p.claims.email = 'ada@acme.test'; p.claims.sub = 'user-1';
  // A redirect elsewhere is never followed after sign-in.
  const evil = await fetch((await fetch((await fetch(base + '/auth/sso?next=//evil.test', { redirect: 'manual' })).headers.get('location'), { redirect: 'manual' })).headers.get('location'), { redirect: 'manual' });
  assert.equal(evil.headers.get('location'), '/');

  // Household mode: Ada sees both projects. Per-person walls: only what is shared.
  const sessionsAs = async c => (await (await fetch(base + '/api/sessions', { headers: { Cookie: c } })).json()).map(e => e.project).sort();
  assert.deepEqual(await sessionsAs(cookie), ['secret', 'shared']);
  const cur = (await (await consoleFetch(base + '/api/settings')).json()).settings;
  const put = body => consoleFetch(base + '/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cur, ...body }) });
  assert.equal((await put({ isolation: 'per-person' })).status, 200);
  assert.deepEqual(await sessionsAs(cookie), [], 'walled: nothing is hers until shared');
  const ada = (await (await consoleFetch(base + '/api/users')).json()).users.find(u => u.name === 'Ada Lovelace');
  assert.equal((await consoleFetch(base + '/api/access', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'shared', mode: 'listed', listed: { ['user:' + ada.id]: 'act' } }) })).status, 200);
  assert.deepEqual(await sessionsAs(cookie), ['shared']);
  assert.equal((await fetch(base + '/api/records/search?q=plan', { headers: { Cookie: cookie } })).status, 403, 'machine-wide records are not for walled people');
  // A spending limit: at zero, a run is refused before any model is asked.
  assert.equal((await put({ isolation: 'per-person', budgets: { monthlyPerPerson: 0, people: {} } })).status, 200);
  const key = list.find(e => e.project === 'shared').key;
  const run = await fetch(base + '/api/node/send', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: key, prompt: 'hello' }) });
  assert.match(await run.text(), /this month's AI budget/);
  const mine = await (await fetch(base + '/api/settings', { headers: { Cookie: cookie } })).json();
  assert.deepEqual(mine.budget, { limit: 0, spent: 0, left: 0, over: true });
  assert.equal(mine.settings.sso.clientSecret, '', 'the client secret stays with administrators');
});
