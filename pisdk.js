'use strict';
// Host proxy: one warm child per session. SDK globals and extension timers never
// share the server process. Cold starts pay a process + SDK load (typically
// seconds and hundreds of MB); warm calls reuse it until five idle minutes.
// Children exit on IPC disconnect. This is not a restart-surviving supervisor.
const path = require('path');
const { fork } = require('child_process');
const { randomUUID } = require('crypto');

const SCOPED_ENV = /^(?:PI_ORCHESTRATOR_|PI_EFFECTIVE_|PI_SESSION_|PI_PROMPT_MODE|PI_DELEGATION_ID$|PI_PROVIDER$|PI_MODEL$|PI_REASONING_LEVEL$)/;
// The per-session scoped variables, for a sandboxed spawn whose base
// environment is the sandbox's own (never the host's).
function pickScoped(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (SCOPED_ENV.test(k) && v != null) out[k] = String(v);
  return out;
}
function workerEnv(target = {}, inherited = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (!SCOPED_ENV.test(key) && value != null) env[key] = String(value);
  }
  for (const [key, value] of Object.entries(target.env || {})) {
    // agentEnv() spreads process.env. An unchanged scoped value is inherited,
    // not a session-specific choice. sessionEnv explicitly opts in even when
    // the intended value happens to equal the host value.
    if (SCOPED_ENV.test(key) && value === inherited[key]) continue;
    if (value == null) delete env[key]; else env[key] = String(value);
  }
  for (const [key, value] of Object.entries(target.sessionEnv || {})) {
    if (value == null) delete env[key]; else env[key] = String(value);
  }
  return env;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Consumers often attach after the synchronous autonomous callback returns.
  promise.catch(() => {});
  return { promise, resolve, reject };
}
function errorOf(value) {
  const error = new Error(value && value.message || String(value || 'Pi worker failed'));
  if (value && value.name) error.name = value.name;
  if (value && value.code) error.code = value.code;
  if (value && typeof value.stack === 'string') { error.workerStack = value.stack; error.stack += '\n  -- in the Pi worker:\n' + value.stack; }
  return error;
}

function createPiSdkProxy(options = {}) {
  const spawnWorker = options.forkWorker || ((file, opts) => fork(file, [], opts));
  const sessions = new Map();
  const children = new Set(); // Includes unnamed starts and workers shutting down.
  let autonomousHandler = null;

  function send(W, message) {
    if (W.dead || !W.child.connected) throw W.error || new Error('Pi worker disconnected');
    W.child.send(message, error => { if (error) fail(W, error); });
  }
  function request(W, method, args = [], id = randomUUID()) {
    const waiting = deferred();
    W.pending.set(id, waiting);
    const dispatch = () => {
      if (!W.pending.has(id)) return; // Stopped while a previous worker exited.
      try { send(W, { type: 'request', id, method, args }); }
      catch (error) { W.pending.delete(id); waiting.reject(error); fail(W, error); }
    };
    if (W.barrier) W.barrier.then(dispatch); else dispatch();
    return waiting.promise;
  }
  function finishRun(W, id, error, result) {
    const R = W.runs.get(id);
    if (!R) return;
    W.runs.delete(id);
    R.handle.uiAutoCancelled = result?.uiAutoCancelled ?? R.handle.uiAutoCancelled;
    R.handle.error = error ? error.message : null;
    R.handle.abort = R.handle.respondUi = R.handle.uiInput = R.handle.runningTools = null;
    R.tools.clear();
    if (error) R.done.reject(error); else R.done.resolve(result);
  }
  function fail(W, error) {
    if (W.dead) return;
    W.dead = true;
    W.error = errorOf(error);
    W.state = { ...W.state, alive: false, busy: false, error: W.error.message };
    clearTimeout(W.stopTimer);
    if (W.key && sessions.get(W.key) === W) sessions.delete(W.key);
    for (const p of W.pending.values()) p.reject(W.error);
    W.pending.clear();
    for (const id of W.runs.keys()) finishRun(W, id, W.error);
    if (!W.stopping && options.onWorkerError) options.onWorkerError(W.error, W.state);
    if (!W.child.pid) {
      W.exited = true;
      W.exitDone.resolve();
      children.delete(W);
    }
    // A broken IPC channel is not permission to leave an untracked runtime.
    if (!W.exited) {
      try { W.child.kill('SIGTERM'); } catch {}
      W.stopTimer = setTimeout(() => { try { W.child.kill('SIGKILL'); } catch {} }, options.shutdownMs ?? 5000);
      W.stopTimer.unref?.();
    }
  }
  function makeRun(W, id, onEvent) {
    const done = deferred();
    const R = { done, onEvent, tools: new Map(), dialogs: new Set(), views: new Set(), handle: null };
    const control = (method, args) => {
      if (!W.runs.has(id) || W.dead) return Promise.resolve(false);
      return request(W, method, args);
    };
    R.handle = {
      done: done.promise, pid: W.child.pid, engine: 'sdk', uiAutoCancelled: 0, error: null,
      abort: () => control('abort', [id]),
      respondUi: (uiId, response) => {
        if (!R.dialogs.delete(uiId) || W.dead) return false;
        try { send(W, { type: 'ui', method: 'respondUi', args: [uiId, response] }); return true; }
        catch (error) { fail(W, error); return false; }
      },
      uiInput: (uiId, data) => {
        if (!R.views.has(uiId) || W.dead) return false;
        try { send(W, { type: 'ui', method: 'uiInput', args: [uiId, data] }); return true; }
        catch (error) { fail(W, error); return false; }
      },
      runningTools: () => [...R.tools.values()],
    };
    W.runs.set(id, R);
    return R;
  }
  function event(W, packet) {
    const R = W.runs.get(packet.runId);
    if (!R) return; // Passive idle notifications have no run owner.
    const ev = packet.event;
    if (ev.type === 'extension_ui_request') {
      if (['select', 'confirm', 'input', 'editor'].includes(ev.method)) R.dialogs.add(ev.id);
      if (ev.method === 'custom_render') R.views.add(ev.id);
      if (ev.method === 'custom_end') R.views.delete(ev.id);
    }
    if (ev.type === 'tool_execution_start') R.tools.set(ev.toolCallId,
      { id: ev.toolCallId, name: ev.toolName, since: Date.now() });
    if (ev.type === 'tool_execution_end') R.tools.delete(ev.toolCallId);
    if (ev.type === 'agent_settled') R.tools.clear();
    if (R.onEvent) {
      try { R.onEvent(ev); }
      catch (error) { fail(W, new Error('Pi event forwarding failed: ' + error.message)); }
    }
  }
  function updateState(W, state) {
    if (!state || W.dead) return;
    W.state = { ...W.state, ...state, pid: W.child.pid, engine: 'sdk' };
    if (state.sessionPath) {
      const key = path.resolve(state.sessionPath);
      if (W.key && W.key !== key && sessions.get(W.key) === W) sessions.delete(W.key);
      const other = sessions.get(key);
      if (other && other !== W) { fail(W, new Error('Pi session already has a worker')); return; }
      W.key = key;
      sessions.set(key, W);
    }
  }
  function receive(W, message) {
    if (!message || W.dead || W.stopping) return;
    if (message.state) updateState(W, message.state);
    if (message.type === 'response') {
      const p = W.pending.get(message.id);
      if (!p) return;
      W.pending.delete(message.id);
      if (message.error) {
        const error = errorOf(message.error);
        p.reject(error);
        finishRun(W, message.id, error);
        if (message.retire) fail(W, error);
      } else {
        p.resolve(message.result);
        // Settle synchronously before a following stopped/exit packet can
        // reject a run whose successful response already arrived.
        finishRun(W, message.id, null, message.result);
      }
    } else if (message.type === 'autonomous_start') {
      if (W.runs.has(message.runId)) return;
      const R = makeRun(W, message.runId, null);
      // Synchronous by contract: the integrator installs its job and run record
      // before the next packet (including the first agent_start) is forwarded.
      try {
        R.onEvent = autonomousHandler ? autonomousHandler(message.info, R.handle) : null;
        if (R.onEvent != null && typeof R.onEvent !== 'function') throw new Error('Autonomous handler must return an event function');
      } catch (error) { fail(W, error); }
    } else if (message.type === 'ui_closed') {
      for (const R of W.runs.values()) R.dialogs.delete(message.id);
    } else if (message.type === 'event') event(W, message);
    else if (message.type === 'autonomous_done') finishRun(W, message.runId,
      message.error ? errorOf(message.error) : null, message.result);
    else if (message.type === 'fatal') fail(W, errorOf(message.error));
    else if (message.type === 'stopped') {
      W.stopping = true;
      if (W.key && sessions.get(W.key) === W) sessions.delete(W.key);
    }
  }
  function start(target) {
    const key = target.sessionPath ? path.resolve(target.sessionPath) : null;
    // A worker carries the walls of whoever started it. The same session
    // driven by a guest and by the owner needs two different workers: a
    // warm one behind other walls is retired first, never reused.
    const wallsId = target.sandbox ? target.sandbox.id : null;
    const existing = key ? sessions.get(key) : null;
    if (existing && existing.wallsId === wallsId) return existing;
    if (existing) stop(existing);
    // stopWarmSession is synchronous for legacy callers. A replacement must
    // still wait for the old process to exit before it opens the session file.
    const retiring = [...children].filter(W => key && W.key === key && !W.exited);
    const barrier = retiring.length ? Promise.all(retiring.map(W => W.exitDone.promise)) : null;
    const workerFile = path.join(__dirname, 'pisdk-worker.js');
    const baseOpts = {
      cwd: target.cwd || process.cwd(), env: workerEnv(target, options.inheritedEnv || process.env),
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced',
      // Do not inherit the server's inspector or test-runner arguments.
      execArgv: [],
    };
    let child;
    if (target.sandbox) {
      // Inside the walls: bwrap, then node, then the worker. The IPC channel
      // is an inherited descriptor, which bubblewrap passes through.
      const launched = target.sandbox.launch(process.execPath, [workerFile], { cwd: target.cwd });
      child = (options.spawnSandboxed || require('child_process').spawn)(launched.file, launched.args, { ...baseOpts, cwd: undefined, env: { ...launched.env, ...pickScoped(baseOpts.env) } });
    } else child = spawnWorker(workerFile, baseOpts);
    const W = { child, key, wallsId, barrier, exitDone: deferred(), pending: new Map(), runs: new Map(), dead: false,
      stopping: false, exited: false, error: null, stopTimer: null,
      state: { sessionPath: key, cwd: target.cwd, pid: child.pid, busy: false, model: null, alive: true, engine: 'sdk', sandboxed: !!target.sandbox } };
    children.add(W);
    if (key) sessions.set(key, W);
    child.on('message', message => receive(W, message));
    child.on('error', error => fail(W, error));
    child.on('disconnect', () => {
      if (W.stopping) return;
      // Give the exit event a tick: it carries the reason from stderr.
      setImmediate(() => { if (!W.exited) fail(W, new Error('Pi worker disconnected')); });
    });
    child.on('exit', (code, signal) => {
      W.exited = true;
      W.exitDone.resolve();
      clearTimeout(W.stopTimer);
      children.delete(W);
      const why = W.stderrTail && W.stderrTail();
      fail(W, new Error('Pi worker exited' + (signal ? ' (' + signal + ')' : ' (code ' + code + ')') + (why ? ': ' + why.split('\n').filter(l => !/differs from the tested/.test(l)).slice(-3).join(' | ') : '')));
    });
    // Drain stderr to avoid a blocked worker. Do not retain extension output,
    // which can contain user data. Fatal IPC errors carry a bounded message.
    // A sandboxed worker keeps its last lines: when the walls themselves
    // refuse to stand (a missing bind, a bwrap error), that is the only
    // place the reason appears.
    if (target.sandbox) {
      let tail = '';
      child.stderr?.on('data', d => { tail = (tail + String(d)).slice(-2000); });
      W.stderrTail = () => tail.trim();
    } else child.stderr?.resume();
    return W;
  }
  function wireTarget(target) {
    return { sessionPath: target.sessionPath && path.resolve(target.sessionPath), cwd: target.cwd, extraArgs: target.extraArgs, sessionDir: target.sessionDir };
  }
  function piHeadlessRun(target, opts = {}) {
    let W;
    try { W = start(target); }
    catch (error) {
      const done = deferred(); done.reject(error);
      return { done: done.promise, abort: async () => false, respondUi: null, uiInput: null,
        uiAutoCancelled: 0, pid: null, engine: 'sdk', error: error.message };
    }
    const id = randomUUID();
    const R = makeRun(W, id, opts.onEvent);
    // Register the handle before starting: startup extension events need it too.
    const { onEvent, ...wireOpts } = opts;
    request(W, 'run', [wireTarget(target), wireOpts], id).then(
      result => finishRun(W, id, null, result), error => finishRun(W, id, error));
    return R.handle;
  }
  async function piBeginWarm(target) {
    const W = start(target);
    try { return await request(W, 'begin', [wireTarget(target)]); }
    catch (error) { stop(W); throw error; }
  }
  function stop(W) {
    if (W.stopping || W.dead) return false;
    W.stopping = true;
    if (W.key && sessions.get(W.key) === W) sessions.delete(W.key);
    const error = new Error('Pi session stopped');
    W.state = { ...W.state, busy: false, alive: false };
    for (const p of W.pending.values()) p.reject(error);
    W.pending.clear();
    for (const id of W.runs.keys()) finishRun(W, id, error);
    try { send(W, { type: 'shutdown' }); } catch (error) { fail(W, error); }
    W.stopTimer = setTimeout(() => { try { W.child.kill('SIGKILL'); } catch {} }, options.shutdownMs ?? 5000);
    W.stopTimer.unref?.();
    return true;
  }
  return {
    piHeadlessRun, piBeginWarm,
    piComposer: async (target, input) => request(start(target), 'composer', [wireTarget(target), input]),
    piQueuePrompt: async (target, message, behavior, images) => {
      const W = sessions.get(path.resolve(target.sessionPath));
      return W && !W.dead ? request(W, 'queue', [wireTarget(target), message, behavior, images]) : false;
    },
    piSetThinking: async (target, level) => request(start(target), 'thinking', [wireTarget(target), level]),
    piCompact: async (target, instructions) => request(start(target), 'compact', [wireTarget(target), instructions]),
    // A derivation on a private snapshot session: its own worker, stopped
    // when the completion returns. Nothing reaches the real conversation.
    piDeriveAt: async (target, opts) => {
      const W = start(target);
      try { return await request(W, 'derive', [wireTarget(target), opts]); }
      finally { stop(W); }
    },
    stopWarmSession: sessionPath => { const W = sessions.get(path.resolve(sessionPath)); return W ? stop(W) : false; },
    stopAllWarmSessions: () => { let count = 0; for (const W of children) if (stop(W)) count++; return count; },
    listWarmSessions: () => [...sessions.values()].filter(W => !W.dead && !W.stopping).map(W => ({ ...W.state,
      busy: W.state.busy || W.runs.size > 0 })),
    // The kill switch: every worker behind one set of walls.
    stopWalls: wallsId => { let n = 0; for (const W of children) if (W.wallsId === wallsId && stop(W)) n++; return n; },
    setEditorTextFor: (sessionPath, text) => {
      const W = sessions.get(path.resolve(sessionPath));
      if (W && !W.dead) {
        try { send(W, { type: 'ui', method: 'editor', args: [sessionPath, String(text || '')] }); }
        catch (error) { fail(W, error); }
      }
    },
    setAutonomousRunHandler: fn => {
      if (fn != null && typeof fn !== 'function') throw new TypeError('Autonomous handler must be a function');
      autonomousHandler = fn || null;
    },
  };
}

const proxy = createPiSdkProxy();
module.exports = { ...proxy, createPiSdkProxy, workerEnv,
  // Keep the original complete utility surface. Loading the SDK alone does not
  // create a ModelRuntime or access credentials; session work only runs in IPC.
  loadSdk: (...args) => require('./pisdk-runtime.js').loadSdk(...args),
  sdkInfo: () => require('./pisdk-runtime.js').sdkInfo(),
  piForkAt: (...args) => require('./pisdk-runtime.js').piForkAt(...args),
  piForkBefore: (...args) => require('./pisdk-runtime.js').piForkBefore(...args),
};
