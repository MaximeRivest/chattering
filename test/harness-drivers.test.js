'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { createClaudeDriver } = require('../harness/claude-code');
const { createCodexDriver } = require('../harness/codex');
const tick = () => new Promise(r => setImmediate(r));
async function until(fn) { for (let n = 0; n < 100; n++) { if (fn()) return; await tick(); } assert.fail('condition never became true'); }
function processes() {
  const children = [];
  function spawn(bin, args, options) {
    const p = new EventEmitter(); Object.assign(p, { bin, args, options, pid: 7000 + children.length, writes: [], kills: [], stdout: new PassThrough(), stderr: new PassThrough() });
    p.stdin = new Writable({ write(chunk, _enc, cb) { for (const line of String(chunk).trim().split('\n')) p.writes.push(JSON.parse(line)); cb(); } });
    let ended = false;
    p.exit = (code = 0) => { if (ended) return; ended = true; p.emit('exit', code); };
    p.stdin.on('finish', () => queueMicrotask(() => p.exit()));
    p.kill = signal => { p.kills.push(signal); queueMicrotask(() => p.exit(1)); };
    p.receive = msg => p.stdout.write(JSON.stringify(msg) + '\n');
    p.answer = (request, result = {}) => p.receive({ id: request.id, result });
    p.ccAnswer = (request, result = {}) => p.receive({ type: 'control_response', response: { request_id: request.request_id, subtype: 'success', response: result } });
    children.push(p); return p;
  }
  return { children, spawn };
}
const env = { PATH: '/fixture', HOME: '/fixture/home' };
const ccTarget = { key: 'one', cwd: '/fixture', sessionId: 'session-one', env };

test('Claude: abort while initialize is pending never sends a prompt', async t => {
  const ps = processes(), d = createClaudeDriver({ spawn: ps.spawn, shutdownMs: 5 }); t.after(() => d.stopAllClaudeSessions());
  const h = d.claudeHeadlessRun(ccTarget, { message: 'must not run' });
  await until(() => ps.children[0]?.writes.length);
  await h.abort(); const p = ps.children[0]; p.ccAnswer(p.writes[0], { commands: [] });
  assert.equal((await h.done).aborted, true); assert.equal(p.writes.filter(w => w.type === 'user').length, 0);
});

test('Claude: concurrent sends are rejected before they change the warm process', async t => {
  const ps = processes(), d = createClaudeDriver({ spawn: ps.spawn }); t.after(() => d.stopAllClaudeSessions());
  const h = d.claudeHeadlessRun(ccTarget, { message: 'first' });
  const second = d.claudeHeadlessRun({ ...ccTarget, model: 'different' }, { message: 'second' });
  await assert.rejects(second.done, /already answering/); assert.equal(ps.children.length, 1);
  const p = ps.children[0]; p.ccAnswer(p.writes[0]); await until(() => p.writes.some(w => w.type === 'user'));
  p.receive({ type: 'result', subtype: 'success', session_id: 'session-one' }); await h.done;
  assert.equal(p.writes.filter(w => w.type === 'user').length, 1);
});

test('Claude: approval handles are single-use, stay with their run, and never persist settings', async t => {
  const ps = processes(), d = createClaudeDriver({ spawn: ps.spawn }); t.after(() => d.stopAllClaudeSessions());
  const events = [], h = d.claudeHeadlessRun(ccTarget, { message: 'first', onEvent: e => events.push(e) });
  const p = ps.children[0]; p.ccAnswer(p.writes[0]); await until(() => p.writes.some(w => w.type === 'user'));
  p.receive({ type: 'control_request', request_id: 'ask', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo ok' }, permission_suggestions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'userSettings' }] } });
  assert.deepEqual(events.at(-1).options, ['Allow', 'Refuse']);
  assert.equal(h.respondUi('ask', { value: 'Allow' }), true);
  assert.equal(p.writes.at(-1).response.response.updatedPermissions, undefined);
  assert.equal(h.respondUi('ask', { value: 'Allow' }), false);
  p.receive({ type: 'result', subtype: 'success' }); await h.done;
  const next = d.claudeHeadlessRun(ccTarget, { message: 'second' });
  await until(() => p.writes.filter(w => w.type === 'user').length === 2);
  p.receive({ type: 'control_request', request_id: 'ask2', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {} } });
  assert.equal(h.respondUi('ask2', { value: 'Allow' }), false, 'old handle cannot authorize a later run');
  assert.equal(next.respondUi('ask2', { cancelled: true }), true);
  assert.equal(p.writes.at(-1).response.response.behavior, 'deny');
  p.receive({ type: 'result', subtype: 'success' }); await next.done;
});

test('Claude: a changed environment retires the old process before resuming, not while it runs', async t => {
  const ps = processes(), d = createClaudeDriver({ spawn: ps.spawn }); t.after(() => d.stopAllClaudeSessions());
  const h = d.claudeHeadlessRun(ccTarget, { message: 'one' }), p = ps.children[0];
  p.ccAnswer(p.writes[0]); await until(() => p.writes.some(w => w.type === 'user'));
  p.receive({ type: 'result', subtype: 'success' }); await h.done;
  const h2 = d.claudeHeadlessRun({ ...ccTarget, env: { ...env, PROFILE: 'other' } }, { message: 'two' });
  await until(() => ps.children.length === 2);
  assert.equal(p.stdin.writableFinished, true);
  const p2 = ps.children[1]; p2.ccAnswer(p2.writes[0]); await until(() => p2.writes.some(w => w.type === 'user'));
  p2.receive({ type: 'result', subtype: 'success' }); await h2.done;
});

test('Claude: initialization timeout cleans up; unsupported sandbox launches never spawn', async () => {
  const ps = processes(), d = createClaudeDriver({ spawn: ps.spawn, controlTimeoutMs: 10, shutdownMs: 5 });
  await assert.rejects(d.claudeHeadlessRun(ccTarget, { message: 'one' }).done, /did not answer initialize/);
  await tick(); assert.equal(ps.children[0].stdin.writableFinished, true);
  await assert.rejects(d.claudeHeadlessRun({ ...ccTarget, sandbox: {} }, { message: 'x' }).done, /sandboxed/);
  assert.equal(ps.children.length, 1);
});

// Codex: one app-server process per conversation (Codex locks a thread to
// the process that resumed it). ps.children[n] is the n-th process.
async function openCodex(ps, n, threadId = 'thread-one') {
  await until(() => ps.children.length > n);
  const p = ps.children[n];
  await until(() => p.writes.some(w => w.method === 'initialize'));
  p.answer(p.writes.find(w => w.method === 'initialize'));
  await until(() => p.writes.some(w => ['thread/start', 'thread/resume'].includes(w.method)));
  p.answer(p.writes.findLast(w => ['thread/start', 'thread/resume'].includes(w.method)), { thread: { id: threadId, path: '/fixture/rollout.jsonl' }, model: 'fixture' });
  return p;
}
async function startCodex(d, ps, target = {}, n = 0) {
  const events = [], threadId = target.threadId || 'thread-one';
  let opened = null;
  const h = d.codexHeadlessRun({ env, cwd: '/fixture', ...target }, { message: 'hello', onEvent: e => events.push(e), onThread: t => { opened = t; } });
  const p = await openCodex(ps, n, threadId);
  await until(() => p.writes.some(w => w.method === 'turn/start'));
  p.receive({ method: 'turn/started', params: { threadId, turn: { id: 'turn-one' } } });
  p.answer(p.writes.findLast(w => w.method === 'turn/start'), { turn: { id: 'turn-one' } });
  return { h, p, events, threadId, opened: () => opened };
}
const complete = (p, threadId, status = 'completed') => p.receive({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-one', status } } });

test('Codex: early abort sends no turn and frees the conversation at once', async t => {
  const ps = processes(), d = createCodexDriver({ spawn: ps.spawn, shutdownMs: 5 }); t.after(() => d.stopCodex());
  const h = d.codexHeadlessRun({ env, cwd: '/fixture', threadId: 'thread-one' }, { message: 'must not run' });
  await h.abort();
  await openCodex(ps, 0);
  assert.equal((await h.done).aborted, true);
  assert.ok(!ps.children[0].writes.some(w => w.method === 'turn/start'));
  assert.equal(ps.children[0].stdin.writableFinished, true, 'the lock is released, not held for the idle time');
});

test('Codex: a new conversation reports its thread and file once Codex created them', async t => {
  const ps = processes(), d = createCodexDriver({ spawn: ps.spawn }); t.after(() => d.stopCodex());
  const { h, p, opened } = await startCodex(d, ps, { developerInstructions: 'project notes' });
  const start = p.writes.find(w => w.method === 'thread/start');
  assert.equal(start.params.developerInstructions, 'project notes');
  assert.deepEqual(opened(), { threadId: 'thread-one', path: '/fixture/rollout.jsonl', model: 'fixture' });
  complete(p, 'thread-one'); await h.done;
});

test('Codex: competing sends cannot resume or change policy under an active turn', async t => {
  const ps = processes(), d = createCodexDriver({ spawn: ps.spawn }); t.after(() => d.stopCodex());
  const { h, p } = await startCodex(d, ps, { threadId: 'thread-one' });
  const other = d.codexHeadlessRun({ env, threadId: 'thread-one', cwd: '/fixture', sandboxMode: 'danger-full-access' }, { message: 'second' });
  await assert.rejects(other.done, /already answering/);
  assert.equal(ps.children.length, 1);
  complete(p, 'thread-one'); await h.done;
  assert.equal(p.writes.filter(w => w.method === 'thread/resume').length, 1);
});

test('Codex: a follow-up reuses the warm process; the idle time then frees the lock', async t => {
  const ps = processes(), d = createCodexDriver({ spawn: ps.spawn, idleMs: 30, shutdownMs: 5 }); t.after(() => d.stopCodex());
  const first = await startCodex(d, ps, { threadId: 'thread-one', model: 'm1', effort: 'low' });
  assert.deepEqual(first.p.writes.find(w => w.method === 'thread/resume').params, { threadId: 'thread-one', excludeTurns: true, cwd: '/fixture', model: 'm1' });
  assert.equal(first.p.writes.find(w => w.method === 'turn/start').params.effort, 'low');
  complete(first.p, 'thread-one'); await first.h.done;
  const second = d.codexHeadlessRun({ env, cwd: '/fixture', threadId: 'thread-one' }, { message: 'again' });
  await until(() => first.p.writes.filter(w => w.method === 'thread/resume').length === 2);
  first.p.answer(first.p.writes.findLast(w => w.method === 'thread/resume'), { thread: { id: 'thread-one' } });
  await until(() => first.p.writes.filter(w => w.method === 'turn/start').length === 2);
  first.p.answer(first.p.writes.findLast(w => w.method === 'turn/start'), { turn: { id: 'turn-two' } });
  first.p.receive({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'turn-two', status: 'completed' } } });
  await second.done;
  assert.equal(ps.children.length, 1, 'no second process for a quick follow-up');
  for (let i = 0; i < 100 && !first.p.stdin.writableFinished; i++) await new Promise(r => setTimeout(r, 5)); // the idle timer is real time
  assert.equal(first.p.stdin.writableFinished, true, 'the lock is released after the idle time');
  assert.deepEqual(d.holding(), []);
});

test('Codex: a conversation another Codex holds is refused with a clear reason, never shared', async t => {
  const ps = processes(), d = createCodexDriver({ spawn: ps.spawn, shutdownMs: 5 }); t.after(() => d.stopCodex());
  const h = d.codexHeadlessRun({ env, cwd: '/fixture', threadId: 'thread-one' }, { message: 'x' });
  await until(() => ps.children.length);
  const p = ps.children[0];
  p.answer(p.writes.find(w => w.method === 'initialize'));
  await until(() => p.writes.some(w => w.method === 'thread/resume'));
  p.receive({ id: p.writes.find(w => w.method === 'thread/resume').id, error: { code: -32600, message: 'thread thread-one already has an active writer' } });
  await assert.rejects(h.done, e => e.code === 'CODEX_LOCKED' && /open in another Codex/.test(e.message));
  assert.equal(p.stdin.writableFinished, true);
});

test('Codex: separate conversations and separate accounts get separate processes', async t => {
  const ps = processes(), d = createCodexDriver({ spawn: ps.spawn }); t.after(() => d.stopCodex());
  const a = await startCodex(d, ps, { threadId: 'thread-one' }, 0);
  const b = await startCodex(d, ps, { threadId: 'thread-two', env: { ...env, CODEX_HOME: '/other' } }, 1);
  assert.equal(ps.children.length, 2);
  assert.equal(ps.children[1].options.env.CODEX_HOME, '/other');
  complete(a.p, 'thread-one'); complete(b.p, 'thread-two');
  await a.h.done; await b.h.done;
});

test('Codex: approvals are scoped to the turn and cancelled requests cannot be answered', async t => {
  const ps = processes(), d = createCodexDriver({ spawn: ps.spawn }); t.after(() => d.stopCodex());
  const { h, p, events, threadId } = await startCodex(d, ps);
  p.receive({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 12 } } } });
  assert.equal(events.at(-1).type, 'harness_limits');
  p.receive({ id: 55, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn-one', command: 'echo x' } });
  assert.equal(h.respondUi('codex:55', { value: 'Allow' }), true); assert.equal(h.respondUi('codex:55', { value: 'Allow' }), false);
  p.receive({ id: 56, method: 'item/fileChange/requestApproval', params: { threadId, turnId: 'turn-one' } });
  p.receive({ method: 'serverRequest/resolved', params: { threadId, requestId: 56 } });
  assert.equal(h.respondUi('codex:56', { value: 'Allow' }), false);
  p.receive({ id: 57, method: 'item/commandExecution/requestApproval', params: { threadId: 'someone-else', turnId: 'x', command: 'rm' } });
  assert.equal(p.writes.find(w => w.id === 57).result.decision, 'decline', 'a request no run owns is refused');
  complete(p, threadId); await h.done;
  assert.equal(h.respondUi('codex:55', { value: 'Allow' }), false);
});

test('Codex: stop declines waiting permissions and interrupts the exact turn', async t => {
  const ps = processes(), d = createCodexDriver({ spawn: ps.spawn }); t.after(() => d.stopCodex());
  const { h, p, threadId } = await startCodex(d, ps);
  p.receive({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn-one', command: 'echo x' } });
  const stop = h.abort();
  assert.equal(p.writes.find(w => w.result && w.result.decision).result.decision, 'decline');
  const interrupt = p.writes.find(w => w.method === 'turn/interrupt');
  assert.deepEqual(interrupt.params, { threadId, turnId: 'turn-one' }); p.answer(interrupt);
  complete(p, threadId, 'interrupted');
  await stop; assert.equal((await h.done).aborted, true);
});

test('Codex: an acknowledged interrupt without an ended turn locks the thread instead of pretending it stopped', async t => {
  const ps = processes(), d = createCodexDriver({ spawn: ps.spawn, abortTimeoutMs: 15 }); t.after(() => d.stopCodex());
  const { h, p, threadId } = await startCodex(d, ps, { threadId: 'thread-one' });
  const stop = h.abort(); const stopped = assert.rejects(stop, /did not confirm stopping/);
  p.answer(p.writes.find(w => w.method === 'turn/interrupt'));
  await assert.rejects(h.done, /did not confirm stopping/); await stopped;
  await assert.rejects(d.codexHeadlessRun({ env, threadId, cwd: '/fixture' }, { message: 'must not run' }).done, /not confirmed/);
  assert.equal(p.writes.filter(w => w.method === 'turn/start').length, 1);
});

test('Codex: the turn Codex announces is the one waited for, whichever message is handled first', async t => {
  const ps = processes(), d = createCodexDriver({ spawn: ps.spawn }); t.after(() => d.stopCodex());
  const h = d.codexHeadlessRun({ env, cwd: '/fixture', threadId: 'thread-one' }, { message: 'x' });
  const p = await openCodex(ps, 0);
  await until(() => p.writes.some(w => w.method === 'turn/start'));
  const start = p.writes.find(w => w.method === 'turn/start');
  // One chunk: the reply (a provisional id) and the announcement (the real one).
  p.stdout.write(JSON.stringify({ id: start.id, result: { turn: { id: 'provisional' } } }) + '\n' + JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-one', turn: { id: 'real-turn' } } }) + '\n');
  await tick(); await tick();
  p.receive({ method: 'turn/completed', params: { threadId: 'thread-one', turn: { id: 'real-turn', status: 'completed' } } });
  const out = await Promise.race([h.done, new Promise(r => setTimeout(() => r('hung'), 500))]);
  assert.notEqual(out, 'hung');
  assert.equal(out.turnId, 'real-turn');
});

test('Codex: server loss rejects the run; a missing Codex says so', async t => {
  const ps = processes(), d = createCodexDriver({ spawn: ps.spawn }); t.after(() => d.stopCodex());
  const { h, p } = await startCodex(d, ps);
  p.exit(7); await assert.rejects(h.done, /stopped \(code 7\)/);
  const missing = createCodexDriver({ spawn: () => { const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new Writable({ write(_c, _e, cb) { cb(); } }); c.kill = () => {}; queueMicrotask(() => c.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }))); return c; } });
  await assert.rejects(missing.codexHeadlessRun({ env, cwd: '/fixture' }, { message: 'x' }).done, /not installed/);
});
