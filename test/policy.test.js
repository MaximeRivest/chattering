'use strict';
// policy.js: every API route and every live event type has a decision,
// and the decisions mean what they say.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const policy = require('../policy.js');

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Each branch of the request handler that names an /api/ path, with the
// methods its condition names (none: any method).
function routesInServer() {
  const out = [];
  for (const line of SERVER.split('\n')) {
    if (!/^\s*(\} else )?if \(.*u\.pathname/.test(line)) continue;
    const paths = [...line.matchAll(/u\.pathname === '(\/api\/[^']+)'/g)].map(m => m[1])
      .concat([...line.matchAll(/u\.pathname\.startsWith\('(\/api\/[^']+)'\)/g)].map(m => m[1] + '*'));
    if (!paths.length) continue;
    const methods = [...line.matchAll(/req\.method === '([A-Z]+)'/g)].map(m => m[1]);
    for (const p of paths) out.push({ path: p, methods: methods.length ? methods : ['GET', 'POST'] });
  }
  return out;
}

test('every API route in server.js is classified in policy.js', () => {
  const routes = routesInServer();
  assert.ok(routes.length > 200, 'the parser still finds the routes: ' + routes.length);
  const missing = [];
  for (const r of routes) {
    const p = r.path.endsWith('*') ? r.path + 'x' : r.path; // a path under a prefix route
    if (policy.BEFORE_SIGN_IN.includes(r.path)) continue;
    for (const m of r.methods) if (!policy.routeEntry(m, p.replace(/\*x$/, 'x'))) missing.push(m + ' ' + r.path);
  }
  assert.deepEqual(missing, [], 'add these to ROUTES in policy.js, deciding who may call them');
});

test('policy.js lists no route the server does not have', () => {
  const known = new Set(routesInServer().map(r => r.path).concat(['/api/speech/stream']));
  const stale = Object.keys(policy.ROUTES).map(k => k.replace(/^[A-Z]+ /, '')).filter(p => {
    if (known.has(p)) return false;
    if (p.endsWith('/*')) return !known.has(p.slice(0, -1) + '*');
    return true;
  });
  assert.deepEqual(stale, [], 'remove or rename these entries');
});

test('sockets pass through the same gate as routes', () => {
  const upgrade = SERVER.slice(SERVER.indexOf('function upgradeRequest('), SERVER.indexOf("server.on('upgrade'"));
  assert.match(upgrade, /policy\.checkRoute\(/);
  assert.ok(upgrade.indexOf('checkRoute') < upgrade.indexOf('collabUpgrade'), 'checked before any socket handler runs');
});

test('every event type the server broadcasts has a rule', () => {
  const types = new Set([...SERVER.matchAll(/broadcast\(\{ type: '([a-z-]+)'/g)].map(m => m[1]));
  assert.ok(types.size > 20);
  const missing = [...types].filter(t => !policy.EVENTS[t]);
  assert.deepEqual(missing, [], 'add these to EVENTS in policy.js');
});

const owner = { tier: 'owner', user: { id: 'o', role: 'owner', scope: 'household' } };
const member = { tier: 'member', user: { id: 'l', role: 'member', scope: 'household' } };
const guest = { tier: 'member', user: { id: 'g', role: 'member', scope: 'guest' } };

test('levels: guests reach guest routes, members member routes, the owner tier everything', () => {
  for (const [who, g, m, o] of [[owner, true, true, true], [member, true, true, false], [guest, true, false, false]]) {
    assert.equal(policy.levelAllows(who, 'guest'), g);
    assert.equal(policy.levelAllows(who, 'member'), m);
    assert.equal(policy.levelAllows(who, 'owner'), o);
  }
  assert.equal(policy.levelAllows(null, 'guest'), false);
  assert.equal(policy.levelAllows({ tier: 'console', user: { id: 'o' } }, 'owner'), true);
  assert.equal(policy.levelAllows({ tier: 'admin', user: { id: 'a' } }, 'owner'), true);
});

test('an unclassified route answers the owner tier only', () => {
  const none = () => true;
  assert.equal(policy.checkRoute(owner, 'GET', '/api/nobody-decided', new URLSearchParams(), none).ok, true);
  assert.equal(policy.checkRoute(member, 'GET', '/api/nobody-decided', new URLSearchParams(), none).ok, false);
  assert.equal(policy.checkRoute(guest, 'GET', '/api/nobody-decided', new URLSearchParams(), none).status, 403);
});

test('the routes that hand out the owner\'s powers are the owner tier\'s', () => {
  const check = (who, m, p) => policy.checkRoute(who, m, p, new URLSearchParams(), () => true).ok;
  for (const [m, p] of [['POST', '/api/machines/register'], ['PUT', '/api/settings'], ['POST', '/api/invites'], ['POST', '/api/sync/peers/x/remove'], ['POST', '/api/usage/billing']]) {
    assert.equal(check(member, m, p), false, m + ' ' + p);
    assert.equal(check(guest, m, p), false, m + ' ' + p);
    assert.equal(check(owner, m, p), true, m + ' ' + p);
  }
  assert.equal(check(guest, 'GET', '/api/settings'), true, 'the settings are read by everyone; the handler withholds secrets');
  for (const p of ['/api/transcript/raw', '/api/records/search', '/api/notes', '/api/agents/active', '/api/doc/run-cell']) {
    assert.equal(check(guest, 'GET', p), false, p);
    assert.equal(check(member, 'GET', p), true, p);
  }
});

test('a conversation named in the query is checked before the handler', () => {
  const q = new URLSearchParams({ id: 'hidden' });
  const can = key => key !== 'hidden';
  assert.equal(policy.checkRoute(guest, 'GET', '/api/conversation/media', q, can).ok, false);
  assert.equal(policy.checkRoute(member, 'GET', '/api/conversation/media', q, can).ok, false, 'a listed rule hides it from members too');
  assert.equal(policy.checkRoute(guest, 'GET', '/api/conversation/media', new URLSearchParams({ id: 'open' }), can).ok, true);
  assert.equal(policy.checkRoute(owner, 'GET', '/api/conversation/media', q, can).ok, true);
});

test('events: narrowed to what the person may see, unknown types to the owner tier only', () => {
  const can = { all: false, member: false, key: k => k === 'open', project: p => p === 'open', path: a => a.startsWith('/p/open/') };
  assert.equal(policy.eventView({ type: 'update', key: 'secret', title: 'the secret plan' }, can), null);
  assert.deepEqual(policy.eventView({ type: 'update', key: 'open' }, can), { type: 'update', key: 'open' });
  assert.deepEqual(policy.eventView({ type: 'timeline-titles', titles: [{ key: 'open' }, { key: 'secret' }] }, can).titles, [{ key: 'open' }]);
  assert.equal(policy.eventView({ type: 'timeline-titles', titles: [{ key: 'secret' }] }, can), null);
  assert.deepEqual(policy.eventView({ type: 'agents', keys: ['open', 'secret'] }, can).keys, ['open']);
  assert.equal(policy.eventView({ type: 'job', job: { key: 'secret' } }, can), null);
  assert.equal(policy.eventView({ type: 'job', job: { project: 'secret' } }, can), null);
  assert.equal(policy.eventView({ type: 'job', job: { title: 'memory batch' } }, can), null, 'machine-wide work is the household\'s');
  assert.equal(policy.eventView({ type: 'file-activity', path: '/p/secret/x', project: 'secret' }, can), null);
  assert.equal(policy.eventView({ type: 'collab-people', name: 'compose:secret' }, can), null);
  assert.equal(policy.eventView({ type: 'access', object: 'project:secret' }, can), null);
  const files = policy.eventView({ type: 'recent-files', delta: { upsert: [{ path: '/p/open/a' }, { path: '/p/secret/b' }], remove: [{ path: '/p/secret/c' }] } }, can);
  assert.deepEqual(files.delta, { upsert: [{ path: '/p/open/a' }], remove: [] });
  assert.equal(policy.eventView({ type: 'voice-state', muted: true }, can), null);
  assert.equal(policy.eventView({ type: 'someday-new', secret: 1 }, can), null);
  assert.ok(policy.eventView({ type: 'index' }, can));
  assert.ok(policy.eventView({ type: 'someday-new' }, { ...can, all: true }));
  const read = policy.eventView({ type: 'agent-read', read: { open: 1, secret: 2 }, since: 5 }, { ...can, member: true });
  assert.deepEqual(read, { type: 'agent-read', read: { open: 1 }, since: 5 });
});

test('AI programs live: the household only, and of each call what the person may see of what it is about', () => {
  const member = { all: false, member: true, key: k => k === 'open', project: p => p === 'open', path: a => a.startsWith('/p/open/') };
  const guest = { ...member, member: false };
  const ev = { type: 'program-live', now: 1, ops: [
    { op: 'start', id: 'a', v: 1, scope: { key: 'open' }, call: { id: 'a' } },
    { op: 'text', id: 'b', v: 2, scope: { key: 'secret' }, field: 'title', text: 'the secret plan' },
    { op: 'text', id: 'c', v: 2, scope: { path: '/p/secret/notes.md' }, field: 'result', text: 'hidden' },
    { op: 'text', id: 'd', v: 2, scope: { project: 'open', path: '/p/open/a.md' }, field: 'result', text: 'shown' },
    { op: 'end', id: 'e', v: 3, scope: {}, state: 'done' },
    { op: 'log', seq: 4 },
  ] };
  assert.equal(policy.eventView(ev, guest), null, 'never a guest');
  assert.deepEqual(policy.eventView(ev, member).ops.map(o => o.id || o.op), ['a', 'd', 'e', 'log']);
  const snap = policy.eventView({ type: 'program-live', ops: [{ op: 'snapshot', seq: 1, calls: [{ id: 'a', scope: { key: 'open' } }, { id: 'b', scope: { project: 'secret' } }] }] }, member);
  assert.deepEqual(snap.ops[0].calls.map(c => c.id), ['a']);
  assert.equal(policy.eventView({ type: 'program-live', ops: [{ op: 'text', id: 'b', scope: { key: 'secret' } }] }, member), null, 'nothing left: nothing sent');
  assert.equal(policy.eventView(ev, { ...member, all: true }), ev, 'the owner tier sees every call');
});
