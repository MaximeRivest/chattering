'use strict';
require('./win-hide.js'); // first: on Windows nothing this starts opens a window (design/70)
// Private IPC endpoint. Export the controller for tests with an injected SDK.
const { createRuntimeEngine } = require('./pisdk-runtime.js');
const { randomUUID } = require('crypto');

// The stack crosses too (bounded): a failure inside the worker is found
// where it happened, not where the parent rethrew it.
function serializedError(error) {
  return { name: error?.name || 'Error', message: String(error?.message || error).slice(0, 8000), code: error?.code,
    stack: typeof error?.stack === 'string' ? error.stack.slice(0, 4000) : undefined };
}
function createWorkerController({ send, exit, engineFactory = createRuntimeEngine, shutdownMs = 4000 }) {
  let active = null;
  let closing = false;
  let shutdownRequested = false;
  let shutdownPromise = null;
  let chain = Promise.resolve();
  let lastState = null;
  let settleScheduled = false;
  const cancelled = new Set();
  const queuedRuns = new Set();
  const engine = engineFactory({ onEvent, onState, onIdleStop: shutdown,
    onUiClosed: id => send({ type: 'ui_closed', id }),
    onShutdown: () => { shutdownRequested = true; checkShutdown(); }, onError: fatal });

  function state() { return engine.listWarmSessions()[0] || lastState; }
  function result() { return { pid: process.pid, engine: 'sdk', warm: true, uiAutoCancelled: 0 }; }
  function finishAuto(error) {
    if (!active || active.kind !== 'auto') return;
    const run = active;
    active = null;
    send({ type: 'autonomous_done', runId: run.id,
      result: { ...result(), uiAutoCancelled: (state()?.uiAutoCancelled || 0) - run.beforeCancelled },
      error: error ? serializedError(error) : undefined, state: state() });
    run.resolve();
    checkShutdown();
  }
  function maybeSettle() {
    // Extension agent_settled handlers can already have started another turn.
    // Do not close a lifecycle on agent_end or a timer's guess about silence.
    if (settleScheduled) return;
    settleScheduled = true;
    setImmediate(() => {
      settleScheduled = false;
      if (active?.kind === 'auto' && !state()?.busy) finishAuto();
      checkShutdown();
    });
  }
  function onState(next) {
    lastState = next;
    send({ type: 'state', state: next });
    maybeSettle();
  }
  function onEvent(event, next) {
    lastState = next;
    if (!active && !closing && (next.busy || event.type === 'agent_start' ||
      (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor', 'custom_render'].includes(event.method)))) {
      let resolve;
      const done = new Promise(yes => { resolve = yes; });
      active = { id: 'auto:' + randomUUID(), kind: 'auto', done, resolve,
        beforeCancelled: next.uiAutoCancelled || 0 };
      send({ type: 'autonomous_start', runId: active.id,
        info: { sessionPath: next.sessionPath, cwd: next.cwd, model: next.model }, state: next });
    }
    send({ type: 'event', runId: active?.id || null, event, state: next });
    if (event.type === 'agent_settled' || event.type === 'extension_ui_request' && event.method === 'custom_end') maybeSettle();
  }
  function checkShutdown() {
    if (shutdownRequested && !active && !state()?.busy) void shutdown();
  }
  function fatal(error) {
    send({ type: 'fatal', error: serializedError(error) });
    void shutdown();
  }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    // The only deadline is teardown, never a model/tool run deadline.
    const timer = setTimeout(() => exit(1), shutdownMs);
    timer.unref?.();
    shutdownPromise = (async () => {
      let code = 0;
      try { await engine.dispose(); }
      catch (error) { code = 1; send({ type: 'fatal', error: serializedError(error) }); }
      finally {
        clearTimeout(timer);
        finishAuto(new Error('Pi session stopped'));
        send({ type: 'stopped' });
        exit(code);
      }
    })();
    return shutdownPromise;
  }
  async function operation(message) {
    const { id, method, args = [] } = message;
    if (closing) throw new Error('Pi worker is stopping');
    // Thinking changes and explicit prompts must not steal the event
    // stream from a turn started by an idle extension.
    while (active?.kind === 'auto') await active.done;
    if (closing) throw new Error('Pi worker is stopping');
    if (cancelled.has(id)) throw new Error('Pi run aborted before start');
    if (method === 'run') {
      active = { id, kind: 'explicit', handle: null };
      try {
        active.handle = engine.piHeadlessRun(...args);
        const output = await active.handle.done;
        return { ...output, uiAutoCancelled: active.handle.uiAutoCancelled };
      } finally {
        // Even a command which throws can have queued an extension followup.
        if (!closing) await engine.waitForIdle();
        active = null;
      }
    }
    if (method === 'begin') return engine.piBeginWarm(...args);
    if (method === 'derive') {
      // An explicit lifecycle like 'run': the snapshot session's events must
      // not be mistaken for an autonomous extension turn (which the host
      // may cancel).
      active = { id, kind: 'explicit', handle: null };
      try { return await engine.piDeriveAt(...args); }
      finally { active = null; }
    }
    if (method === 'thinking') return engine.piSetThinking(...args);
    if (method === 'compact') return engine.piCompact(...args);
    throw new Error('Unknown Pi worker method: ' + method);
  }
  function reply(message, work) {
    return Promise.resolve().then(work).then(
      value => send({ type: 'response', id: message.id, result: value, state: state() }),
      error => {
        const retire = !engine.listWarmSessions().length && !['abort', 'queue'].includes(message.method);
        send({ type: 'response', id: message.id, error: serializedError(error), state: state(), retire });
        // Failed startup has no idle timer. Do not leave an empty warm process.
        if (retire) void shutdown();
      },
    ).finally(checkShutdown);
  }
  function receive(message) {
    if (!message) return;
    if (message.type === 'shutdown') return shutdown();
    if (message.type === 'ui') {
      try {
        if (message.method === 'respondUi') engine.respondUi(...message.args);
        else if (message.method === 'uiInput') engine.uiInput(...message.args);
        else if (message.method === 'editor') engine.setEditorTextFor(...message.args);
      } catch (error) { fatal(error); }
      return;
    }
    if (message.type !== 'request') return;
    if (message.method === 'abort') {
      const runId = message.args[0];
      if (queuedRuns.has(runId)) cancelled.add(runId);
      return reply(message, async () => {
        if (active?.id === runId) {
          // The latch on the run handle covers abort during SDK startup.
          const aborting = active.handle?.abort?.();
          await engine.abort(); // Also cancel startup dialogs before ensureS returns.
          await aborting;
          return true;
        }
        return cancelled.has(runId);
      });
    }
    if (message.method === 'queue') return reply(message, () => engine.piQueuePrompt(...message.args));
    if (message.method === 'run') queuedRuns.add(message.id);
    chain = chain.then(() => reply(message, () => operation(message))).finally(() => {
      queuedRuns.delete(message.id);
      cancelled.delete(message.id);
    });
    chain.catch(fatal);
    return chain;
  }
  return { receive, shutdown, fatal };
}

if (require.main === module) {
  let controller;
  const send = packet => {
    if (!process.connected) return;
    try { process.send(packet, error => { if (error) void controller?.shutdown(); }); }
    catch { void controller?.shutdown(); }
  };
  controller = createWorkerController({ send,
    exit: code => {
      // Flush final responses before closing the channel.
      if (process.connected) {
        try { process.send({ type: 'stopped' }, () => process.exit(code)); }
        catch { process.exit(code); }
      } else process.exit(code);
    },
  });
  process.on('message', message => { void controller.receive(message); });
  process.on('disconnect', () => { void controller.shutdown(); });
  process.on('SIGTERM', () => { void controller.shutdown(); });
  process.on('SIGINT', () => { void controller.shutdown(); });
  process.on('uncaughtException', error => controller.fatal(error));
  process.on('unhandledRejection', error => controller.fatal(error));
}
module.exports = { createWorkerController };
