'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgentRecovery, failureKind, probeOrigin, probe, fileVersion } = require('../agent-recovery');
const { normalizeSettings } = require('../settings');

function fixture(t, options = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-recovery-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 100000, enabled = true;
  const launches = [], checks = [];
  const config = { file: path.join(dir, 'interruptions.json'), now: () => clock, enabled: () => enabled,
    validate: async () => null, endpoint: () => 'https://example.test',
    check: async url => { checks.push(url); return { ok: true, latencyMs: 20 }; },
    launch: async (r, attempts) => { launches.push({ ...r, attempts }); return { id: 'next' }; }, ...options };
  const recovery = new AgentRecovery(config);
  const add = (extra = {}) => recovery.observe({ id: 'one', key: 'chat', model: 'anthropic/model', reason: 'fetch failed', version: 'v1', eligible: true, ...extra });
  return { recovery, config, dir, add, launches, checks, advance: ms => { clock += ms; }, enabled: value => { enabled = value; } };
}

test('network classification is conservative; stop, auth, capacity and context failures win', () => {
  for (const e of ['fetch failed', 'TypeError: fetch failed\ncause: ECONNRESET', 'Connection error.', 'getaddrinfo EAI_AGAIN', 'UND_ERR_SOCKET']) assert.equal(failureKind(e), 'network', e);
  for (const e of ['API timeout', 'model activity timeout', 'Worker exited', '429 network request failed', 'invalid_grant: fetch failed', 'context length exceeded', '503 connection error', 'quota exhausted']) assert.equal(failureKind(e), 'other', e);
  for (const e of ['aborted by you', 'stopped — chattering restarted', 'cancelled: network error']) assert.equal(failureKind(e), 'stopped', e);
});
test('automatic recovery is strict opt-in in both settings modes', () => {
  for (const usePiDefault of [true, false]) {
    assert.equal(normalizeSettings({ usePiDefault }).autoResumeNetwork, false);
    assert.equal(normalizeSettings({ usePiDefault, autoResumeNetwork: 'true' }).autoResumeNetwork, false);
    assert.equal(normalizeSettings({ usePiDefault, autoResumeNetwork: true }).autoResumeNetwork, true);
  }
});
test('only known or configured provider origins are probed without credentials or paths', () => {
  assert.equal(probeOrigin('openai-codex/m'), 'https://chatgpt.com');
  assert.equal(probeOrigin('unknown/m'), null);
  assert.equal(probeOrigin('local/m', { providers: { local: { baseUrl: 'http://localhost:9000/v1?key=secret' } } }), 'http://localhost:9000');
  assert.equal(probeOrigin('local/m', { providers: { local: { baseUrl: 'https://user:secret@host' } } }), null);
});
test('probes accept reachability but reject captive redirects, rate limits and server failures', async () => {
  for (const [status, ok] of [[200, true], [401, true], [403, true], [404, true], [302, false], [429, false], [503, false]]) {
    const result = await probe('https://example.test', async (_, options) => {
      assert.equal(options.method, 'HEAD'); assert.equal(options.redirect, 'manual'); assert.ok(options.signal); assert.equal(options.headers, undefined);
      return { status, body: { cancel: async () => {} } };
    });
    assert.equal(result.ok, ok);
  }
  assert.equal((await probe('https://example.test', async () => { throw Error('offline'); })).ok, false);
});
test('waits for two separated healthy checks; resumes only one record per tick', async t => {
  const f = fixture(t); f.add(); f.add({ id: 'two', key: 'other' });
  await f.recovery.tick(); assert.equal(f.checks.length, 0);
  f.advance(30000); await f.recovery.tick(); assert.equal(f.launches.length, 0);
  f.advance(15000); await f.recovery.tick(); assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].attempts, 1);
  assert.equal(f.recovery.snapshot().interrupted.length, 1);
});
test('offline checks back off and reset the stable-connection counter', async t => {
  let healthy = true, checks = 0;
  const f = fixture(t, { check: async () => { checks++; return { ok: healthy }; } }); f.add();
  f.advance(30000); await f.recovery.tick(); healthy = false;
  f.advance(15000); await f.recovery.tick(); healthy = true;
  f.advance(15000); await f.recovery.tick(); assert.equal(checks, 2);
  f.advance(15000); await f.recovery.tick(); assert.equal(f.launches.length, 0);
  f.advance(15000); await f.recovery.tick(); assert.equal(f.launches.length, 1);
});
test('disabled recovery does not probe or launch; disabling during a probe prevents launch', async t => {
  let resolve;
  const f = fixture(t, { check: () => new Promise(r => { resolve = r; }) }); f.add(); f.enabled(false);
  f.advance(30000); await f.recovery.tick(); assert.equal(resolve, undefined);
  f.enabled(true); f.recovery.records.get('one').goodChecks = 1;
  const pending = f.recovery.tick(); await new Promise(r => setImmediate(r));
  f.enabled(false); resolve({ ok: true }); await pending;
  assert.equal(f.launches.length, 0);
});
test('double-clicks and two screens cannot launch a recovery twice', async t => {
  let resolve;
  const f = fixture(t, { validate: () => new Promise(r => { resolve = r; }) }); f.add();
  const first = f.recovery.resume('one');
  await assert.rejects(f.recovery.resume('one'), /no longer waiting/);
  resolve(null); await first;
  assert.equal(f.launches.length, 1);
  await assert.rejects(f.recovery.resume('one'), /no longer waiting/);
});
test('stale history, terminal ownership and running conversations remain stopped', async t => {
  const f = fixture(t, { validate: async () => 'The conversation changed.' }); f.add();
  await assert.rejects(f.recovery.resume('one'), /changed/);
  assert.equal(f.recovery.snapshot().interrupted[0].waiting, false);
  assert.equal(f.recovery.snapshot().interrupted[0].note, 'The conversation changed.');
  assert.equal(f.launches.length, 0);
});
test('dismiss cancels an in-flight connection check without deleting history', async t => {
  let resolve;
  const f = fixture(t, { check: () => new Promise(r => { resolve = r; }) }); f.add();
  f.recovery.records.get('one').goodChecks = 1; f.advance(30000);
  const pending = f.recovery.tick(); await new Promise(r => setImmediate(r));
  f.recovery.dismiss('one'); resolve({ ok: true }); await pending;
  assert.equal(f.launches.length, 0); assert.equal(f.recovery.snapshot().interrupted.length, 0);
});
test('old records, exhausted attempts, intentional stops and specialized runs never auto-resume', async t => {
  const f = fixture(t);
  f.add({ id: 'historical', historical: true });
  f.add({ id: 'quota', key: 'quota', reason: 'usage limit' });
  f.add({ id: 'stopped', key: 'stopped', reason: 'aborted by you' });
  f.add({ id: 'fanout', key: 'fanout', eligible: false });
  f.add({ id: 'exhausted', key: 'exhausted', attempts: 3 });
  f.advance(240000); await f.recovery.tick(); assert.equal(f.checks.length, 0);
  f.add({ id: 'old', key: 'old' }); f.advance(86400000); await f.recovery.tick(); assert.equal(f.checks.length, 0);
  await f.recovery.resume('exhausted'); assert.equal(f.launches[0].attempts, 0);
});
test('records survive restart and an uncertain launch never automatically repeats', async t => {
  const f = fixture(t); f.add(); f.recovery.records.get('one').state = 'resuming'; f.recovery.save();
  const restored = new AgentRecovery(f.config);
  assert.equal(restored.snapshot().interrupted[0].state, 'pending');
  assert.equal(restored.snapshot().interrupted[0].waiting, false);
  assert.match(restored.snapshot().interrupted[0].note, /interrupted/);
});
test('ordinary continuation clears the interruption; old startup snapshots cannot clear newer failures', t => {
  const f = fixture(t); f.add();
  f.recovery.advance('chat', 1); assert.equal(f.recovery.snapshot().interrupted.length, 1);
  f.recovery.advance('chat'); assert.equal(f.recovery.snapshot().interrupted.length, 0);
});
test('file version catches edits and replacing a file with the same length', t => {
  const f = fixture(t), file = path.join(f.dir, 'session.jsonl'); fs.writeFileSync(file, 'old');
  const old = fileVersion(file); fs.writeFileSync(file + '.new', 'new'); fs.renameSync(file + '.new', file);
  assert.notEqual(fileVersion(file), old);
});
