'use strict';
const test = require('node:test');
const path = require('node:path');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPiSdkProxy, workerEnv } = require('../pisdk.js');
const { createRuntimeEngine } = require('../pisdk-runtime.js');
const { createWorkerController } = require('../pisdk-worker.js');

const tick = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function latch() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
  assert.fail('condition did not become true');
}
// Absolute on this system (a drive letter on Windows), as the proxy keys them.
const target = name => ({ sessionPath: path.resolve('/virtual/' + name + '.jsonl'), cwd: path.resolve('/virtual/project') });

// No SDK import, subprocess, network, credentials, or persistent files. The
// production host, IPC controller, runtime, and TUI bridge run against this SDK.
function fakeSdk(config = {}) {
  const sessions = [], runtimes = [], services = [], signatures = new Map();
  let serial = 0;
  function manager(file, cwd = '/virtual/project') {
    // A minimal entry tree: pi appends messages after its listeners ran and
    // custom entries whenever an integrator asks (author, reply speed).
    const entries = [];
    let leafId = null;
    const append = entry => {
      const stored = { ...entry, id: 'e' + ++serial, parentId: leafId, timestamp: new Date().toISOString() };
      entries.push(stored);
      leafId = stored.id;
      return stored.id;
    };
    return { getCwd: () => cwd, getSessionFile: () => file, flushed: true, entries,
      appendCustomEntry: (customType, data) => append({ type: 'custom', customType, data }),
      appendMessage: message => append({ type: 'message', message }),
      getLeafId: () => leafId,
      getBranch: () => entries.slice() };
  }
  class Session {
    constructor(sm) {
      this.sessionManager = sm;
      this.sessionFile = sm.getSessionFile();
      this.sessionId = 'session-' + ++serial;
      this.isStreaming = false;
      this.model = { provider: 'fake', id: 'one' };
      this.modelRuntime = { getAvailableSnapshot: () => [this.model, { provider: 'fake', id: 'two' }] };
      this.thinkingLevel = 'off';
      this.listeners = new Set();
      this.prompts = [];
      this.custom = [];
      this.abortCount = 0;
      this.disposed = false;
      sessions.push(this);
    }
    get isIdle() { return !this.isStreaming; }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(ev) { for (const fn of this.listeners) fn(ev); }
    async bindExtensions(bindings) {
      this.bindings = bindings;
      this.ui = bindings.uiContext;
      if (config.bind) await config.bind(this);
    }
    start() {
      if (this.isStreaming) return;
      this.isStreaming = true;
      this.idle = latch();
      this.emit({ type: 'agent_start' });
    }
    finish() {
      if (!this.isStreaming) return;
      this.emit({ type: 'agent_end', messages: [] });
      this.isStreaming = false;
      signatures.set(this.sessionFile, 'own-' + ++serial);
      this.emit({ type: 'agent_settled' });
      this.idle.resolve();
    }
    async prompt(message, opts) {
      this.prompts.push({ message, opts });
      opts.preflightResult?.(true);
      if (config.prompt) return config.prompt(this, message, opts);
      if (message?.startsWith('/')) { this.ui.notify('command handled', 'info'); return; }
      this.start();
      await this.waitForIdle();
    }
    async sendCustomMessage(message, opts) {
      this.custom.push({ message, opts });
      this.start();
      this.emit({ type: 'message_start', message: { role: 'custom', ...message } });
      await this.waitForIdle();
    }
    async waitForIdle() { if (this.isStreaming) await this.idle.promise; }
    async abort() { this.abortCount++; this.finish(); }
    async setModel(model) { this.model = model; }
    supportsThinking() { return true; }
    setThinkingLevel(level) { this.thinkingLevel = level; }
    cycleThinkingLevel() { this.thinkingLevel = 'high'; }
    getAvailableThinkingLevels() { return ['off', 'high']; }
    setSessionName(name) { this.name = name; }
    dispose() { this.disposed = true; this.listeners.clear(); }
  }
  const SDK = {
    getAgentDir: () => '/virtual/agent',
    SessionManager: {
      open: file => manager(file),
      create: cwd => manager('/virtual/new-' + ++serial + '.jsonl', cwd),
    },
    ProjectTrustStore: class { get() { return false; } },
    hasTrustRequiringProjectResources: () => false,
    SettingsManager: { create: () => ({}) },
    createAgentSessionServices: async opts => { services.push(opts); return { diagnostics: [] }; },
    createAgentSessionFromServices: async ({ sessionManager }) => ({ session: new Session(sessionManager) }),
    createAgentSessionRuntime: async (factory, opts) => {
      const built = await factory(opts);
      const runtime = { ...built, disposed: 0,
        setRebindSession(fn) { this.rebind = fn; },
        async dispose() {
          this.disposed++;
          if (config.shutdown) await config.shutdown(this.session);
          this.session.dispose();
        },
      };
      runtimes.push(runtime);
      return runtime;
    },
  };
  return { sessions, runtimes, services, signatures,
    loadSdk: async () => { if (config.load) await config.load(); return { SDK, theme: {} }; },
    fileSig: file => signatures.get(file) || 'initial',
  };
}
function harness(t, config = {}) {
  const workers = [];
  const proxy = createPiSdkProxy({ shutdownMs: 50, inheritedEnv: { PATH: '/virtual/bin', HOME: '/virtual/home' },
    forkWorker(file, opts) {
      const child = new EventEmitter();
      const sdk = fakeSdk(config);
      child.pid = 9000 + workers.length;
      child.connected = true;
      child.opts = opts;
      child.file = file;
      child.sdk = sdk;
      child.kills = [];
      child.sent = [];
      child.stderr = { resume() {} };
      const exit = code => {
        if (!child.connected) return;
        child.connected = false;
        queueMicrotask(() => { child.emit('exit', code, null); child.emit('disconnect'); });
      };
      child.controller = createWorkerController({ shutdownMs: 40, exit,
        send: packet => queueMicrotask(() => { if (child.connected) child.emit('message', packet); }),
        engineFactory: hooks => createRuntimeEngine({ ...hooks, ...sdk, idleMs: config.idleMs ?? 300000 }),
      });
      child.send = (packet, callback) => {
        child.sent.push(packet);
        queueMicrotask(() => { void child.controller.receive(packet); callback?.(null); });
      };
      child.kill = signal => {
        child.kills.push(signal);
        if (signal === 'SIGTERM') void child.controller.shutdown(); else exit(1);
      };
      child.crash = (code = 17) => exit(code);
      child.breakIpc = () => { child.emit('disconnect'); };
      workers.push(child);
      return child;
    },
  });
  t.after(async () => { proxy.stopAllWarmSessions(); await tick(); await tick(); });
  return { proxy, workers };
}

test('live engine surface remains exported without loading the installed SDK', () => {
  const api = require('../pisdk.js');
  assert.equal(api.piSetModel, undefined);
  assert.equal(require('../pirpc.js').piSetModel, undefined);
  assert.equal(createRuntimeEngine(fakeSdk()).piSetModel, undefined);
  for (const key of ['piForkAt', 'piForkBefore', 'piSetThinking', 'piHeadlessRun',
    'piQueuePrompt', 'piBeginWarm', 'stopWarmSession', 'stopAllWarmSessions', 'listWarmSessions',
    'setEditorTextFor', 'loadSdk', 'sdkInfo', 'setAutonomousRunHandler']) assert.equal(typeof api[key], 'function');
  assert.equal(api.sdkInfo(), null);
});

test('worker environment removes stale scoped inheritance and preserves deliberate values', () => {
  const base = { PATH: '/bin', HOME: '/virtual/home', PI_ORCHESTRATOR_INBOX: 'old', PI_EFFECTIVE_PROMPT_MODE: 'host',
    PI_SESSION_FILE: 'old-file', PI_PROMPT_MODE_TOOLS: 'old-tools', PI_DELEGATION_ID: 'parent' };
  const copy = { ...base };
  assert.deepEqual(workerEnv({ env: { ...base, DISPLAY: ':1' } }, base), { PATH: '/bin', HOME: '/virtual/home', DISPLAY: ':1' });
  const env = workerEnv({ env: { ...base, PI_EFFECTIVE_PROMPT_MODE: 'child', PI_SESSION_FILE: 'child-file' },
    sessionEnv: { PI_ORCHESTRATOR_INBOX: 'old', PI_DELEGATION_ID: null } }, base);
  assert.equal(env.PI_EFFECTIVE_PROMPT_MODE, 'child');
  assert.equal(env.PI_SESSION_FILE, 'child-file');
  assert.equal(env.PI_ORCHESTRATOR_INBOX, 'old');
  assert.equal(env.PI_DELEGATION_ID, undefined);
  assert.deepEqual(base, copy);
});

test('simultaneous sessions use separate workers and warm calls reuse them', async t => {
  const { proxy, workers } = harness(t);
  const eventsA = [], eventsB = [];
  const a = proxy.piHeadlessRun(target('a'), { message: 'a', onEvent: ev => eventsA.push(ev.type) });
  const b = proxy.piHeadlessRun(target('b'), { message: 'b', onEvent: ev => eventsB.push(ev.type) });
  await until(() => workers.every(w => w.sdk.sessions[0]?.isStreaming));
  assert.equal(workers.length, 2);
  assert.notEqual(a.pid, b.pid);
  assert.deepEqual(workers[0].opts.execArgv, []);
  assert.equal(workers[0].opts.serialization, 'advanced');
  workers[0].sdk.sessions[0].finish();
  await a.done;
  assert.equal(proxy.listWarmSessions().find(s => s.pid === b.pid).busy, true);
  workers[1].sdk.sessions[0].finish();
  await b.done;
  assert.deepEqual(eventsA, ['agent_start', 'agent_end', 'agent_settled']);
  assert.deepEqual(eventsB, eventsA);
  await proxy.piHeadlessRun(target('a'), { message: '/command' }).done;
  assert.equal(workers.length, 2);
  assert.equal(workers[0].sdk.sessions.length, 1);
});

test('concurrent creation, model changes, and command-only runs share one initialized session', async t => {
  const gate = latch();
  const { proxy, workers } = harness(t, { load: () => gate.promise });
  const begin = proxy.piBeginWarm(target('same'));
  const thinking = proxy.piSetThinking(target('same'), 'cycle');
  const run = proxy.piHeadlessRun(target('same'), { message: '/command', provider: 'fake', modelId: 'two' });
  assert.equal(workers.length, 1);
  gate.resolve();
  await begin;
  assert.deepEqual(await thinking, { level: 'high', levels: ['off', 'high'] });
  await run.done;
  assert.equal(workers[0].sdk.sessions.length, 1);
  assert.equal(proxy.listWarmSessions()[0].model, 'fake/two');
  assert.equal(proxy.listWarmSessions()[0].busy, false);
});

test('runtime ensureS also deduplicates direct concurrent creation', async () => {
  const gate = latch();
  const sdk = fakeSdk({ load: () => gate.promise });
  const engine = createRuntimeEngine(sdk);
  const one = engine.piBeginWarm(target('concurrent'));
  const two = engine.piSetThinking(target('concurrent'), 'high');
  gate.resolve();
  await Promise.all([one, two]);
  assert.equal(sdk.sessions.length, 1);
  await engine.dispose();
});

test('early abort and queued abort never send a prompt', async t => {
  const gate = latch();
  const { proxy, workers } = harness(t, { load: () => gate.promise });
  const first = proxy.piHeadlessRun(target('early'), { message: 'do not send' });
  const rejection = assert.rejects(first.done, /aborted/);
  const aborted = first.abort();
  gate.resolve();
  await aborted;
  await rejection;
  assert.equal(workers[0].sdk.sessions.flatMap(s => s.prompts).length, 0);
  const active = proxy.piHeadlessRun(target('early'), { message: 'active' });
  const worker = workers.at(-1);
  await until(() => worker.sdk.sessions[0]?.isStreaming);
  const queued = proxy.piHeadlessRun(target('early'), { message: 'never queued' });
  const queuedRejection = assert.rejects(queued.done, /aborted/);
  await queued.abort();
  worker.sdk.sessions[0].finish();
  await active.done;
  await queuedRejection;
  assert.deepEqual(worker.sdk.sessions[0].prompts.map(p => p.message), ['active']);
});

test('startup subscription captures autonomous first agent_start and tracks the full retry lifecycle', async t => {
  const { proxy, workers } = harness(t, { bind: s => { s.start(); } });
  const events = [];
  let automatic;
  proxy.setAutonomousRunHandler((info, handle) => {
    assert.equal(info.cwd, '/virtual/project');
    assert.equal(info.model, 'fake/one');
    assert.equal(typeof handle.abort, 'function');
    assert.ok(handle.done instanceof Promise);
    automatic = handle;
    events.push('registered');
    return ev => events.push(ev.type);
  });
  const begun = await proxy.piBeginWarm({ cwd: '/virtual/project' });
  await until(() => automatic);
  assert.equal(proxy.listWarmSessions()[0].sessionPath, begun.file);
  const s = workers[0].sdk.sessions[0];
  s.emit({ type: 'agent_end', willRetry: true });
  s.emit({ type: 'auto_retry_start' });
  await tick();
  assert.equal(proxy.listWarmSessions()[0].busy, true);
  s.emit({ type: 'auto_retry_end', success: true });
  s.emit({ type: 'agent_start' });
  s.finish();
  await automatic.done;
  assert.deepEqual(events, ['registered', 'agent_start', 'agent_end', 'auto_retry_start',
    'auto_retry_end', 'agent_start', 'agent_end', 'agent_settled']);
});

test('idle extension turns retain listeners and an extension restart inside settled does not finish early', async t => {
  const { proxy, workers } = harness(t);
  await proxy.piHeadlessRun(target('idle'), { message: '/command' }).done;
  const runs = [], events = [];
  proxy.setAutonomousRunHandler((info, handle) => { runs.push(handle); return ev => events.push(ev.type); });
  const s = workers[0].sdk.sessions[0];
  s.start();
  await until(() => runs.length === 1);
  s.emit({ type: 'agent_end' });
  // Simulate SDK agent_settled after an extension has already begun a new turn.
  s.emit({ type: 'agent_settled' });
  s.emit({ type: 'agent_start' });
  await tick();
  assert.equal(proxy.listWarmSessions()[0].busy, true);
  s.finish();
  await runs[0].done;
  assert.equal(runs.length, 1);
  s.start();
  await until(() => runs.length === 2);
  await runs[1].abort();
  await runs[1].done;
  assert.equal(events[0], 'agent_start');
  assert.equal(events.at(-1), 'agent_settled');
});

test('queued followup acceptance does not finish the active handle', async t => {
  const { proxy, workers } = harness(t);
  const run = proxy.piHeadlessRun(target('queue'), { message: 'first' });
  await until(() => workers[0].sdk.sessions[0]?.isStreaming);
  let done = false;
  run.done.then(() => { done = true; });
  assert.equal(await proxy.piQueuePrompt(target('queue'), 'next', 'followUp', [{ type: 'image', data: 'fixture' }]), true);
  await tick();
  assert.equal(done, false);
  const s = workers[0].sdk.sessions[0];
  assert.equal(s.prompts[1].opts.streamingBehavior, 'followUp');
  assert.equal(s.prompts[1].opts.images[0].data, 'fixture');
  s.finish();
  await run.done;
  assert.equal(await proxy.piQueuePrompt(target('queue'), 'too late'), false);
});

test('custom completion uses SDK custom message, visible followUp, and no forged user prompt', async t => {
  const { proxy, workers } = harness(t);
  const events = [];
  const customMessage = { customType: 'delegation-completion', content: 'Worker finished', display: false, details: { taskId: 'fixture' } };
  const run = proxy.piHeadlessRun(target('custom'), { customMessage, onEvent: ev => events.push(ev) });
  await until(() => workers[0].sdk.sessions[0]?.custom.length);
  const s = workers[0].sdk.sessions[0];
  assert.equal(s.prompts.length, 0);
  assert.deepEqual(s.custom[0], { message: { ...customMessage, display: true }, opts: { triggerTurn: true, deliverAs: 'followUp' } });
  s.finish();
  await run.done;
  assert.equal(events.find(ev => ev.type === 'message_start').message.role, 'custom');
});

test('startup dialogs and custom TUI views preserve response and input capabilities', async t => {
  let answer, key, disposed = false;
  const { proxy } = harness(t, { bind: async s => {
    answer = await s.ui.confirm('startup', 'allow?');
  }, prompt: async s => {
    await s.ui.custom((_tui, _theme, _bindings, done) => ({
      render: () => ['fixture view'],
      handleInput: data => { key = data; done('selected'); },
      dispose: () => { disposed = true; },
    }));
  } });
  let run;
  const events = [];
  run = proxy.piHeadlessRun(target('ui'), { message: '/view', onEvent: ev => {
    events.push(ev);
    if (ev.method === 'confirm') assert.equal(run.respondUi(ev.id, { confirmed: true }), true);
    if (ev.method === 'custom_render') assert.equal(run.uiInput(ev.id, '\u001b[B'), true);
  } });
  await run.done;
  assert.equal(answer, true);
  assert.equal(key, '\u001b[B');
  assert.equal(disposed, true);
  assert.equal(events.at(-1).method, 'custom_end');
  assert.equal(run.respondUi, null);
});

test('abort during startup dialog releases startup and prevents the model prompt', async t => {
  const { proxy, workers } = harness(t, { bind: async s => { await s.ui.input('startup'); } });
  let run;
  run = proxy.piHeadlessRun(target('startup-abort'), { message: 'never sent', onEvent: ev => {
    if (ev.method === 'input') void run.abort();
  } });
  await assert.rejects(run.done, /aborted/);
  assert.equal(workers[0].sdk.sessions[0].prompts.length, 0);
});

test('quiet tools and autonomous turns are not stopped by the idle timer', async t => {
  const { proxy, workers } = harness(t, { idleMs: 10 });
  await proxy.piHeadlessRun(target('quiet'), { message: '/command' }).done;
  let run;
  proxy.setAutonomousRunHandler((_info, handle) => { run = handle; return () => {}; });
  const s = workers[0].sdk.sessions[0];
  s.start();
  s.emit({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'quiet' });
  await delay(35);
  assert.equal(workers[0].connected, true);
  assert.deepEqual(run.runningTools().map(tool => tool.name), ['bash']);
  assert.equal(proxy.listWarmSessions()[0].busy, true);
  s.finish();
  await run.done;
  await delay(25);
  assert.equal(workers[0].connected, false);
  assert.equal(workers[0].sdk.runtimes[0].disposed, 1);
});

test('worker exit rejects active run, queued run, and waiting utilities; error remains on handles', async t => {
  const { proxy, workers } = harness(t);
  const active = proxy.piHeadlessRun(target('crash'), { message: 'active' });
  await until(() => workers[0].sdk.sessions[0]?.isStreaming);
  const queued = proxy.piHeadlessRun(target('crash'), { message: 'queued' });
  const utility = proxy.piSetThinking(target('crash'), 'high');
  const rejected = [assert.rejects(active.done, /exited.*17/), assert.rejects(queued.done, /exited.*17/), assert.rejects(utility, /exited.*17/)];
  workers[0].crash();
  await Promise.all(rejected);
  assert.match(active.error, /exited/);
  assert.equal(proxy.listWarmSessions().length, 0);
  // Fake crash cannot remove engine timers itself; release its in-memory turn.
  await workers[0].controller.shutdown();
});

test('stop dispatches extension shutdown, cancels dialogs, and cannot reclaim a replacement worker', async t => {
  let shutdowns = 0;
  const { proxy, workers } = harness(t, { shutdown: () => { shutdowns++; } });
  const run = proxy.piHeadlessRun(target('stop'), { message: 'active' });
  await until(() => workers[0].sdk.sessions[0]?.isStreaming);
  const rejected = assert.rejects(run.done, /stopped/);
  assert.equal(proxy.stopWarmSession(target('stop').sessionPath), true);
  assert.equal(proxy.stopWarmSession(target('stop').sessionPath), false);
  const next = proxy.piHeadlessRun(target('stop'), { message: '/command' });
  await rejected;
  await next.done;
  assert.equal(shutdowns, 1);
  assert.equal(workers[0].connected, false);
  assert.equal(proxy.listWarmSessions()[0].pid, workers[1].pid);
});

test('external file changes reload only idle sessions; own autonomous writes are not stale', async t => {
  const { proxy, workers } = harness(t);
  const T = target('stale');
  await proxy.piHeadlessRun(T, { message: '/command' }).done;
  const sdk = workers[0].sdk;
  sdk.signatures.set(T.sessionPath, 'external-edit');
  await proxy.piSetThinking(T, 'high');
  assert.equal(sdk.sessions.length, 2);
  assert.equal(sdk.sessions[0].disposed, true);
  let automatic;
  proxy.setAutonomousRunHandler((_info, handle) => { automatic = handle; return () => {}; });
  sdk.sessions[1].start();
  await until(() => automatic);
  sdk.sessions[1].finish();
  await automatic.done;
  await proxy.piSetThinking(T, 'off');
  assert.equal(sdk.sessions.length, 2);
});

test('shutdown during SDK load does not leave a session after startup completes', async t => {
  const gate = latch();
  const { proxy, workers } = harness(t, { load: () => gate.promise });
  const run = proxy.piHeadlessRun(target('loading'), { message: 'never' });
  const rejected = assert.rejects(run.done, /stopped/);
  await tick();
  proxy.stopAllWarmSessions();
  gate.resolve();
  await rejected;
  await tick();
  assert.equal(workers[0].sdk.sessions.length, 0);
  assert.equal(workers[0].connected, false);
});

test('replacement waits for slow extension shutdown before opening the same file', async t => {
  const gate = latch();
  const { proxy, workers } = harness(t, { shutdown: () => gate.promise });
  await proxy.piHeadlessRun(target('handoff'), { message: '/command' }).done;
  proxy.stopWarmSession(target('handoff').sessionPath);
  const replacement = proxy.piHeadlessRun(target('handoff'), { message: '/command' });
  await tick();
  assert.equal(workers.length, 2);
  assert.equal(workers[1].sdk.sessions.length, 0);
  gate.resolve();
  await replacement.done;
  assert.equal(workers[0].connected, false);
  assert.equal(workers[1].sdk.sessions.length, 1);
});

test('IPC disconnect and fatal error reject autonomous handles instead of silently losing them', async t => {
  const { proxy, workers } = harness(t);
  await proxy.piHeadlessRun(target('disconnect'), { message: '/command' }).done;
  let automatic;
  proxy.setAutonomousRunHandler((_info, handle) => { automatic = handle; return () => {}; });
  workers[0].sdk.sessions[0].start();
  await until(() => automatic);
  const rejected = assert.rejects(automatic.done, /disconnected/);
  workers[0].breakIpc();
  await rejected;
  assert.match(automatic.error, /disconnected/);
  assert.ok(workers[0].kills.includes('SIGTERM'));

  const fatalRun = proxy.piHeadlessRun(target('fatal'), { message: 'active' });
  await until(() => workers.at(-1).sdk.sessions[0]?.isStreaming);
  const fatalRejected = assert.rejects(fatalRun.done, /fixture fatal/);
  workers.at(-1).controller.fatal(new Error('fixture fatal'));
  await fatalRejected;
  assert.match(fatalRun.error, /fixture fatal/);
});

test('failed startup rejects work and exits; next attempt creates a fresh worker', async t => {
  let rejectStartup = true;
  const { proxy, workers } = harness(t, { load: () => { if (rejectStartup) throw new Error('fixture startup error'); } });
  const failed = proxy.piHeadlessRun(target('startup-fail'), { message: '/command' });
  await assert.rejects(failed.done, /fixture startup error/);
  rejectStartup = false;
  await proxy.piHeadlessRun(target('startup-fail'), { message: '/command' }).done;
  assert.equal(workers.length, 2);
  assert.equal(workers[0].connected, false);
});

test('an autonomous dialog can finish without a model turn', async t => {
  const { proxy, workers } = harness(t);
  await proxy.piHeadlessRun(target('idle-dialog'), { message: '/command' }).done;
  let automatic;
  proxy.setAutonomousRunHandler((_info, handle) => {
    automatic = handle;
    return ev => { if (ev.method === 'confirm') handle.respondUi(ev.id, { confirmed: true }); };
  });
  const answer = await workers[0].sdk.sessions[0].ui.confirm('idle', 'allow?');
  assert.equal(answer, true);
  await automatic.done;
  assert.equal(proxy.listWarmSessions()[0].busy, false);
});

test('explicit runs wait for autonomous completion without stealing its events', async t => {
  const { proxy, workers } = harness(t);
  await proxy.piHeadlessRun(target('ownership'), { message: '/command' }).done;
  let automatic;
  const autoEvents = [], explicitEvents = [];
  proxy.setAutonomousRunHandler((_info, handle) => { automatic = handle; return ev => autoEvents.push(ev.type); });
  const s = workers[0].sdk.sessions[0];
  s.start();
  await until(() => automatic);
  const explicit = proxy.piHeadlessRun(target('ownership'), { message: '/command', onEvent: ev => explicitEvents.push(ev.type) });
  await tick();
  assert.equal(s.prompts.length, 1);
  s.finish();
  await automatic.done;
  await explicit.done;
  assert.deepEqual(autoEvents, ['agent_start', 'agent_end', 'agent_settled']);
  assert.deepEqual(explicitEvents, ['extension_ui_request']);
});

test('extension shutdown requests wait for command response and then exit', async t => {
  let shutdowns = 0;
  const { proxy, workers } = harness(t, {
    prompt: async s => { s.bindings.shutdownHandler(); },
    shutdown: () => { shutdowns++; },
  });
  await proxy.piHeadlessRun(target('extension-shutdown'), { message: '/quit' }).done;
  await tick();
  assert.equal(shutdowns, 1);
  assert.equal(workers[0].connected, false);
});

test('synchronous spawn and IPC send errors reject handles with a recorded error', async () => {
  const throwing = createPiSdkProxy({ inheritedEnv: {}, forkWorker: () => { throw new Error('fixture spawn failure'); } });
  const spawnRun = throwing.piHeadlessRun(target('spawn'), { message: '/command' });
  await assert.rejects(spawnRun.done, /fixture spawn failure/);
  assert.match(spawnRun.error, /fixture spawn failure/);
  const child = new EventEmitter();
  Object.assign(child, { pid: undefined, connected: true, send() { throw new Error('fixture send failure'); } });
  const broken = createPiSdkProxy({ inheritedEnv: {}, forkWorker: () => child });
  const sendRun = broken.piHeadlessRun(target('send'), { message: '/command' });
  await assert.rejects(sendRun.done, /fixture send failure/);
  assert.match(sendRun.error, /fixture send failure/);
  assert.deepEqual(broken.listWarmSessions(), []);
});

test('timed dialogs close on the proxy and preserve the automatic cancellation count', async t => {
  const next = latch();
  let expiredId;
  const { proxy } = harness(t, { prompt: async s => {
    await s.ui.confirm('timed', 'fixture', { timeout: 5 });
    await next.promise;
  } });
  const run = proxy.piHeadlessRun(target('timed'), { message: '/timed', onEvent: ev => {
    if (ev.method === 'confirm') expiredId = ev.id;
  } });
  await delay(20);
  assert.ok(expiredId);
  assert.equal(run.respondUi(expiredId, { confirmed: true }), false);
  next.resolve();
  await run.done;
  assert.equal(run.uiAutoCancelled, 1);
});

test('reply speed is measured at the source and stored once per run with the reply entry ids', async t => {
  const chunk = n => 'x'.repeat(n);
  const reply = (ts, text) => ({ role: 'assistant', provider: 'fake', model: 'one', timestamp: ts, stopReason: 'stop',
    usage: { output: 50, reasoning: 0 }, content: [{ type: 'text', text }] });
  const { proxy, workers } = harness(t, { prompt: async (s, message) => {
    const sm = s.sessionManager;
    s.start();
    s.emit({ type: 'turn_start' });
    s.emit({ type: 'message_start', message: { role: 'user', content: message } });
    s.emit({ type: 'message_end', message: { role: 'user', content: message } });
    sm.appendMessage({ role: 'user', content: message });
    for (const ts of [1000, 1000]) { // Timestamp collisions must not attach both samples to one reply.
      const message = reply(ts, chunk(120));
      s.emit({ type: 'message_start', message });
      s.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: chunk(20) } });
      await delay(15);
      s.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: chunk(100) } });
      s.emit({ type: 'message_end', message });
      sm.appendMessage(message);
    }
    s.finish();
  } });
  await proxy.piHeadlessRun(target('speed'), { message: 'go', author: { id: 'u_max', name: 'Max' } }).done;
  const entries = workers[0].sdk.sessions[0].sessionManager.entries;
  const speed = entries.filter(e => e.type === 'custom' && e.customType === 'chattering-speed');
  assert.equal(speed.length, 1, 'one entry per run, appended after the replies');
  assert.equal(entries.indexOf(speed[0]), entries.length - 1);
  const { samples } = speed[0].data;
  assert.equal(speed[0].data.v, 1);
  assert.equal(samples.length, 2);
  const replyEntries = entries.filter(e => e.type === 'message' && e.message.role === 'assistant');
  assert.deepEqual(samples.map(s => s.entryId), replyEntries.map(e => e.id));
  for (const sample of samples) {
    assert.equal(sample.provider, 'fake');
    assert.equal(sample.model, 'one');
    assert.equal(sample.thinkingLevel, 'off');
    assert.deepEqual({ chars: sample.text.chars, timedChars: sample.text.timedChars, chunks: sample.text.chunks }, { chars: 120, timedChars: 100, chunks: 2 });
    assert.ok(sample.text.ms >= 10 && sample.text.ms < 1000, 'timed between the two chunks: ' + sample.text.ms);
    assert.ok(sample.waitMs >= 0);
    assert.deepEqual(sample.usage, { output: 50, reasoning: 0 });
  }
  // The author entry still sits right before the prompt.
  assert.equal(entries[0].customType, 'chattering-author');
});

test('warm startup keeps extension flags, name, system prompt, and per-child environment', async t => {
  const { proxy, workers } = harness(t);
  const begun = await proxy.piBeginWarm({ cwd: '/virtual/project', env: { DISPLAY: ':7', PI_PROMPT_MODE: 'explicit-fixture' },
    extraArgs: ['-e', '/virtual/extension.ts', '--name', 'fixture', '--prompt-mode', 'review', '--append-system-prompt', 'fixture prompt'] });
  assert.equal(workers[0].opts.env.DISPLAY, ':7');
  assert.equal(workers[0].opts.env.PI_PROMPT_MODE, 'explicit-fixture');
  const service = workers[0].sdk.services[0];
  assert.equal(service.extensionFlagValues.get('prompt-mode'), 'review');
  assert.deepEqual(service.resourceLoaderOptions.additionalExtensionPaths, ['/virtual/extension.ts']);
  assert.deepEqual(service.resourceLoaderOptions.appendSystemPrompt, ['fixture prompt']);
  assert.equal(workers[0].sdk.sessions[0].name, 'fixture');
  await proxy.piHeadlessRun({ sessionPath: begun.file, cwd: '/virtual/project' }, { message: '/command' }).done;
  assert.equal(workers.length, 1);
});
