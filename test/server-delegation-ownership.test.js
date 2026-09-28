'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const D = require('../delegation');
const S = require('../delegation-store');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function load(box, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  vm.runInContext(source.slice(from, to), box);
}
function setup(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ownership-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const id = crypto.randomUUID(), file = path.join(root, 'child_' + id + '.jsonl');
  const dir = S.taskDir(root, id); fs.mkdirSync(dir, { recursive: true });
  S.atomic(path.join(dir, 'request.json'), { id, sessionPath: file, status: 'succeeded', createdAt: Date.now(), parentTaskId: null });
  fs.writeFileSync(file, '');
  const box = vm.createContext({ path, crypto, console, delegationLib: D, DELEGATION_ROOT: root,
    DELEGATION_TERMINAL: S.TERMINAL, sessionFileOps: new Map(), headlessRuns: new Map(), compactingSessions: new Set(), delegationCoordinator: { refresh: async () => {} },
    stopAnyWarmSession() {}, sleep: async () => {}, index: { child: {} },
    conversationKind: () => 'pi', windowTitleFor: () => 'test', absPathForKey: () => file,
    sessionPathsFor: () => ({ entry: {}, sessionPath: file, cwd: root }),
    findRunningConversation: () => null, focusWindow: () => false, piArgv: args => ['fake', ...args],
    releaseHeadless: async () => {}, spawnAlacritty: async () => { box.spawns++; }, spawns: 0,
    // People (users.js): the account itself drives these runs; nothing recorded.
    principalFor: () => ({ user: { id: 'owner', name: 'Owner' }, spawnAs: null, env: {} }), recordAuthorship() {},
    principalInProject: async p => p, assertPrincipalCanRun() {}, promptArgFor: (p, file) => file, guestModelChoice: () => ({}), guestProviderList: async () => [], projectNameOf: () => 'p',
  });
  load(box, 'async function assertDelegationOwnership(', 'function delegationSessionKey(');
  load(box, 'function withSessionOp(', '// Index a session file');
  load(box, 'async function openConversationInTerminal(', 'function decodeImagePayload(');
  return { box, root, id, dir, file };
}
function runSetup(t) {
  const f = setup(t), b = f.box;
  Object.assign(b, {
    normalizeContextItems: x => x, conversationContextOf: () => [], contextSig: () => '',
    appliedContextBySession: new Map(), agentRunJobs: new Map(), jobChanged() {},
    reindexIfChanged: async () => {}, endLiveRunTail() {}, broadcastRunFinal() {}, maybeSettleFanout() {}, settlePendingFanouts: async () => {}, speakRunDone() {},
    piProviderExtraArgs: () => [], pirpc: { stopWarmSession() {} }, agentEnv: () => ({}), agentCallerEnv: () => ({}), programCallerEnv: () => ({}),
    refreshUsageForKey() {}, runEventForwarder: () => () => {}, inspectDeliverySession: async () => ({ deliveries: new Set(), branch: new Set(['launch']) }),
    pisdk: { stopWarmSession() {}, piHeadlessRun(target) { b.targets.push(target); return { done: Promise.resolve() }; } }, targets: [],
    stopRunningAgent: async () => { b.stops++; }, waitFileQuiet: async () => {}, stops: 0,
    appSettings: { simplifyAnswers: false, simplifyPrompt: '' },
    // Spending limits (design/72) are the server's; none here.
    assertWithinBudget() {}, usersLib: { findUser: () => null }, roster: { users: [] },
  });
  b.piEng = () => b.pisdk;
  load(b, 'async function startAgentRun(', '// Idle extension callbacks');
  return f;
}
const message = ids => ({ customType: 'delegation-complete', details: { taskIds: ids, deliveryId: 'delivery', parentEntryIds: ['launch'] } });

test('a failed delegation guard is a run error, not an ordinary informational extension notice', () => {
  const dirname = path.resolve(__dirname, '..');
  const box = vm.createContext({ path, performance, responseSpeed: require('../responsespeed.js'), activityWatch: require('../activity-watch.js'), __dirname: dirname, liveRunTails: new Map(), broadcast() {},
    setTimeout, clearTimeout, addRunNotice(job, text) { job.notices = [...(job.notices || []), text]; } });
  load(box, 'function runEventForwarder(', '// Start one headless run');
  const ordinary = { id: 'one' }, guarded = { id: 'two' };
  box.runEventForwarder(ordinary)({ type: 'extension_error', extensionPath: '/ordinary.ts', event: 'before_provider_request', error: 'optional hook failed' });
  assert.equal(ordinary.errorMessage, undefined);
  box.runEventForwarder(guarded)({ type: 'extension_error', extensionPath: path.join(dirname, 'extensions/delegation.ts'), event: 'before_provider_request', error: 'mode contract mismatch' });
  assert.match(guarded.errorMessage, /Delegation guard.*mode contract/);
});

test('lost worker identity blocks mutations, terminal open, send, and actions before release', async t => {
  const { box: b, root, id, dir, file } = setup(t);
  S.atomic(path.join(dir, 'request.json'), { ...S.readJson(path.join(dir, 'request.json')), createdAt: Date.now() - 30000 });
  S.atomic(path.join(dir, 'state.json'), { status: 'running', processIdentity: S.identity(process.pid) });
  const owner = await D.getDelegation(id, { root });
  assert.equal(owner.status, 'lost'); assert.equal(owner.workerAlive, true);
  b.releaseHeadless = async () => assert.fail('released before guard');
  await assert.rejects(b.withSessionOp(file, () => assert.fail('second writer')), /delegated worker/);
  await assert.rejects(b.openConversationInTerminal('child'), /delegated worker/);
  load(b, 'async function actOnConversation(', 'async function openConversationInTerminal(');
  load(b, 'async function sendToConversation(', 'async function sendFileFeedback(');
  await assert.rejects(b.sendToConversation('child', {}), /delegated worker/);
  await assert.rejects(b.actOnConversation('child', { enter: true }), /delegated worker/);
  load(b, 'async function sendFileFeedback(', '// ---------- agent file diffs');
  await assert.rejects(b.sendFileFeedback({ key: 'child' }), /delegated worker/);
  assert.equal(b.spawns, 0);
});

test('callback ownership rejects a lost worker and matches the exact stored session path', async t => {
  const { box: b, dir, file, root } = setup(t);
  S.atomic(path.join(dir, 'state.json'), { status: 'lost', processIdentity: S.identity(process.pid) });
  await assert.rejects(b.assertDelegationLaunch(file, message([])), /delegated worker/);
  assert.equal(await b.delegationOwnerForFile(path.join(root, 'other', path.basename(file))), null);
  S.atomic(path.join(dir, 'state.json'), { status: 'lost', processIdentity: null });
  await assert.rejects(b.assertDelegationLaunch(file, message([])), /cancelled or lost/);
});

test('terminal rechecks ownership after release; ordinary terminal opening still works', async t => {
  const { box: b, dir } = setup(t);
  await b.openConversationInTerminal('child', { focus: false }); assert.equal(b.spawns, 1);
  b.releaseHeadless = async () => S.atomic(path.join(dir, 'state.json'), { status: 'running', createdAt: Date.now() });
  await assert.rejects(b.openConversationInTerminal('child'), /delegated worker/);
  assert.equal(b.spawns, 1);
});

test('force cannot stop a terminal before checking delegated ownership', async t => {
  const { box: b, dir } = runSetup(t);
  S.atomic(path.join(dir, 'state.json'), { status: 'running', createdAt: Date.now() });
  b.findRunningConversation = () => ({ pid: 123 });
  await assert.rejects(b.startAgentRun('child', { message: 'test', force: true }), /delegated worker/);
  assert.equal(b.stops, 0); assert.equal(b.targets.length, 0);
});

test('callback reloads cancellation after session inspection and finishes without launch', async t => {
  const { box: b, root, id, file } = runSetup(t);
  b.inspectDeliverySession = async () => {
    await D.controlDelegation(id, 'cancel', { root });
    return { deliveries: new Set(), branch: new Set(['launch']) };
  };
  const job = await b.startAgentRun('child', { customMessage: message([id]) });
  await b.headlessRuns.get(file)?.completion;
  assert.equal(b.targets.length, 0); assert.equal(job.status, 'error'); assert.equal(b.headlessRuns.size, 0);
});

test('callback uses target task identity; root review gets no child identity', async t => {
  const { box: b, id, file } = runSetup(t);
  await b.startAgentRun('child', { customMessage: message([id]) });
  await b.headlessRuns.get(file)?.completion;
  assert.equal(b.targets[0].sessionEnv.PI_DELEGATION_ID, id);
  b.delegationOwnerForFile = async () => null;
  await b.startAgentRun('child', { customMessage: message([id]) });
  await b.headlessRuns.get(file)?.completion;
  assert.equal(b.targets[1].sessionEnv.PI_DELEGATION_ID, undefined);
});

test('subtree cancellation aborts resumed descendants, but not running root work', async t => {
  const { box: b, root, id, file } = setup(t);
  const childId = crypto.randomUUID(), childDir = S.taskDir(root, childId);
  const childFile = path.join(root, 'descendant_' + childId + '.jsonl');
  fs.mkdirSync(childDir);
  S.atomic(path.join(childDir, 'request.json'), { id: childId, sessionPath: childFile, parentTaskId: id, status: 'succeeded', createdAt: Date.now() });
  const aborted = [];
  for (const f of [file, childFile, path.join(root, 'root.jsonl')]) {
    b.headlessRuns.set(f, { launchStarted: true, handle: { abort: async () => aborted.push(f) }, completion: Promise.resolve() });
  }
  await D.controlDelegation(id, 'cancel', { root });
  await b.abortCancelledDelegationRuns();
  assert.deepEqual(aborted.sort(), [file, childFile].sort());
});

test('aborted startup cannot launch later when a pending inspection completes', async t => {
  const { box: b, file } = runSetup(t);
  let release, entered;
  const ready = new Promise(r => { entered = r; });
  b.inspectDeliverySession = async () => { entered(); await new Promise(r => { release = r; }); return { deliveries: new Set(), branch: new Set(['launch']) }; };
  const job = await b.startAgentRun('child', { customMessage: message([]) });
  await ready;
  const record = b.headlessRuns.get(file); record.yielded = 'terminal opened';
  release(); await record.completion;
  assert.equal(b.targets.length, 0); assert.equal(job.status, 'done'); assert.equal(b.headlessRuns.size, 0);
});

test('coordinator reloads durable cancellation written during canDeliver', async t => {
  const { root, id, dir, file } = setup(t);
  const parent = path.join(root, 'parent.jsonl');
  fs.writeFileSync(parent, JSON.stringify({ type: 'message', id: 'launch', parentId: null }) + '\n');
  S.atomic(path.join(dir, 'state.json'), { status: 'succeeded', parentSessionPath: parent,
    parentEntryId: 'launch', delivery: 'web', title: 'fixture', outputDir: root });
  const { createDelegationCoordinator } = require('../server-delegations');
  let calls = 0;
  const host = createDelegationCoordinator({ root, list: () => D.listDelegations({ root }),
    canDeliver: async () => { await D.controlDelegation(id, 'cancel', { root }); return true; },
    deliver: async () => { calls++; } });
  t.after(() => host.stop());
  await host.processPending();
  for (let i = 0; i < 100; i++) {
    if ((await host.refresh()).tasks[0].notificationState === 'cancelled') break;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.equal((await host.refresh()).tasks[0].notificationState, 'cancelled');
  assert.equal(calls, 0); assert.equal(fs.readFileSync(file, 'utf8'), '');
});

test('ordinary force workflow stops its terminal and starts one run', async t => {
  const { box: b, file } = runSetup(t);
  let terminal = { pid: 123 };
  b.findRunningConversation = () => terminal;
  b.stopRunningAgent = async () => { b.stops++; terminal = null; };
  const job = await b.startAgentRun('child', { message: 'test', force: true });
  await b.headlessRuns.get(file)?.completion;
  assert.equal(job.status, 'done'); assert.equal(b.stops, 1); assert.equal(b.targets.length, 1);
});

test('terminal release refuses to launch while a web run retains ownership', async t => {
  const { box: b, file } = setup(t);
  load(b, 'async function releaseHeadless(', 'async function lastEntryIdOf(');
  b.headlessRuns.set(file, { handle: null, completion: new Promise(() => {}) });
  await assert.rejects(b.openConversationInTerminal('child'), /has not released/);
  assert.equal(b.spawns, 0);
});

test('sessionActive reports resumed ownership without changing assignment result', async t => {
  const { box: b, file, id } = setup(t);
  b.headlessOwner = f => b.headlessRuns.get(f);
  b.delegationSessionKey = () => 'child';
  load(b, 'function delegationView(', 'const delegationCoordinator =');
  b.headlessRuns.set(file, {});
  const view = b.delegationView({ id, sessionPath: file, status: 'succeeded' });
  assert.equal(view.status, 'succeeded'); assert.equal(view.sessionActive, true);
  b.headlessRuns.delete(file);
  assert.equal(b.delegationView({ id, sessionPath: file }).sessionActive, false);
});

test('subtree control stops a pending root callback without assigning it a child identity', async t => {
  const { box: b, root, id, file } = runSetup(t);
  b.delegationOwnerForFile = async () => null;
  let release, entered;
  const ready = new Promise(r => { entered = r; });
  b.inspectDeliverySession = async () => { entered(); await new Promise(r => { release = r; }); return { deliveries: new Set(), branch: new Set(['launch']) }; };
  const job = await b.startAgentRun('child', { customMessage: message([id]) });
  await ready;
  await D.controlDelegation(id, 'cancel', { root });
  const cancelling = b.abortCancelledDelegationRuns();
  for (let i = 0; i < 20 && !b.headlessRuns.get(file).yielded; i++) await Promise.resolve();
  assert.equal(b.headlessRuns.get(file).yielded, 'delegated subtree cancelled');
  release(); await cancelling;
  assert.equal(job.status, 'done'); assert.equal(b.targets.length, 0);
});

test('lock refusal finishes a registered job cleanly', async t => {
  const { box: b, file, dir } = runSetup(t);
  let release;
  b.sessionFileOps.set(file, new Promise(r => { release = r; }));
  const job = await b.startAgentRun('child', { message: 'test' });
  const completion = b.headlessRuns.get(file).completion;
  S.atomic(path.join(dir, 'state.json'), { status: 'running', createdAt: Date.now() });
  release(); await completion;
  assert.equal(job.status, 'error'); assert.equal(b.targets.length, 0); assert.equal(b.headlessRuns.size, 0);
});

test('a person continuing a stopped worker records a takeover; a callback does not', async t => {
  const { box: b, root, id, dir, file } = runSetup(t);
  S.atomic(path.join(dir, 'state.json'), { status: 'failed', error: '429', failure: { kind: 'usage-limit', message: '429', resumable: true } });
  fs.writeFileSync(file, JSON.stringify({ type: 'session', id }) + '\n');
  const job = await b.startAgentRun('child', { message: 'Review returned delegated work', customMessage: message([id]) }).catch(e => ({ status: 'error', error: e.message }));
  await b.headlessRuns.get(file)?.completion;
  assert.equal((await D.getDelegation(id, { root })).takenOver, null, 'a runner callback is not a takeover: ' + (job.error || ''));
  await b.startAgentRun('child', { message: 'I will finish this myself', provider: 'fake', modelId: 'human' });
  await b.headlessRuns.get(file)?.completion;
  const taken = await D.getDelegation(id, { root });
  assert.equal(taken.takenOver.model, 'fake/human');
  await assert.rejects(D.resumeDelegation(id, {}, { root }), /continued this conversation by hand/);
});
