'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../app.html'), 'utf8');
const slice = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));

function harness() {
  const calls = [], active = { alive: true };
  const ctx = vm.createContext({
    // Session files held by an agent's own program (design/91): none here.
    liveHeld: new Map(),
    sessionPathsFor: key => ({ entry: { source: 'pi', title: 'Parent' }, sessionPath: '/sessions/' + key, cwd: '/project' }),
    assertDelegationOwnership: async file => { calls.push(['ownership', file]); },
    // A configured RPC agent must still use the detached native file utility.
    piEng: () => { throw Error('fork must not launch an RPC process'); },
    stopAnyWarmSession: () => { active.alive = false; throw Error('must not stop the parent'); },
    pisdk: {
      piForkAt: async (target, node) => { calls.push(['fork', target.sessionPath, node]); return { file: '/sessions/fork', sessionId: 'fork' }; },
      piForkBefore: async (target, node) => { calls.push(['before', target.sessionPath, node]); return { file: '/sessions/before', sessionId: 'before', text: 'saved prompt' }; },
    },
    indexNewSessionFile: async file => 'pi:' + file,
    markForkTitle: async key => calls.push(['title', key]),
    // Forks of mirrored conversations (design/52) take another path; none here.
    syncLib: { isMirrorKey: () => false },
  });
  vm.runInContext(slice(server, 'const sessionFileOps = new Map();', '// Index a session file'), ctx);
  vm.runInContext(slice(server, 'async function forkSession(key, nodeId)', '// In-file branch'), ctx);
  return { ctx, calls, active };
}

test('fork and fork-before complete while the source live turn still owns its queue', { timeout: 3000 }, async t => {
  const { ctx, calls, active } = harness();
  let release, finished = false;
  const live = ctx.withSessionOp('/sessions/parent', () => new Promise(resolve => { release = resolve; }));
  live.then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  t.after(() => { release(); return live; });
  const a = await ctx.forkSession('parent', 'saved-answer');
  const b = await ctx.forkSessionForEdit('parent', 'saved-question');
  assert.equal(a.sessionId, 'fork'); assert.equal(b.text, 'saved prompt');
  assert.equal(finished, false, 'fork waited for the model to finish');
  assert.equal(active.alive, true, 'fork stopped the parent runtime');
  assert.ok(calls.some(c => c[0] === 'fork' && c[2] === 'saved-answer'));
  assert.equal(calls.filter(c => c[0] === 'ownership').length, 3);
});

test('forks still enforce delegated-worker ownership before reading or publishing', async () => {
  const { ctx, calls } = harness();
  ctx.assertDelegationOwnership = async () => { throw Error('delegated worker owns this conversation'); };
  await assert.rejects(ctx.forkSession('worker', 'saved'), /delegated worker owns/);
  await assert.rejects(ctx.forkSessionForEdit('worker', 'saved'), /delegated worker owns/);
  assert.deepEqual(calls, []);
});

function browser(overrides = {}) {
  const calls = [];
  const ctx = vm.createContext({
    fetch: async () => { calls.push('create'); return { ok: true, json: async () => ({ key: 'new-fork' }) }; },
    open: async key => calls.push(['open', key]),
    load: () => { calls.push('refresh-list'); return new Promise(() => {}); },
    toast: () => {}, errToast: text => calls.push(['error', text]), ListGroups: { follow: () => {} }, ...overrides,
  });
  vm.runInContext(slice(app, 'async function forkFrom(key, n, btn)', '// ---- epics ----'), ctx);
  return { ctx, calls };
}

test('opening a fork does not wait for a stalled conversation-list refresh', { timeout: 1000 }, async () => {
  const { ctx, calls } = browser();
  await ctx.forkFrom('source', { id: 'saved' }, {});
  assert.deepEqual(calls, ['create', ['open', 'new-fork'], 'refresh-list']);
});

test('retrying failed navigation opens the existing fork, never creates another copy', async () => {
  let opens = 0;
  const { ctx, calls } = browser({ open: async () => { if (++opens === 1) throw Error('network down'); } });
  const button = {};
  await ctx.forkFrom('source', { id: 'saved' }, button);
  assert.equal(button.textContent, 'open fork'); assert.equal(button.disabled, false);
  await ctx.forkFrom('source', { id: 'saved' }, button);
  assert.equal(calls.filter(c => c === 'create').length, 1);
  assert.equal(opens, 2);
});
