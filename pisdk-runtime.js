// Pi SDK engine, hosted by pisdk-worker.js. Never create sessions in the host.
// Utility loading and native file forks remain available without a session.
// Each process owns its SDK globals, extensions, environment, and TUI views.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('node:perf_hooks');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const { installCustomPromptPreparation, waitForCustomTurns } = require('./pisdk-custom.js');
const { forkPiSnapshot } = require('./session-snapshot.js');
const { captureRewriteRequest } = require('./pisdk-rewrite.js');
const { createSpeedMeter } = require('./responsespeed.js');
const { parseExtensionArgs: parseExtraArgs, extensionPolicyFingerprint, requiredExtensionError } = require('./web-extension-policy.js');

const { PI_TESTED_VERSION } = require('./runtime.js'); // runtime/package.json
const WARM_IDLE_MS = 5 * 60 * 1000;
const DIALOG_MAX_MS = 30 * 60 * 1000;

// ---- SDK loading ---------------------------------------------------------

// Which Pi: one answer for the whole app (runtime.js).
function piPackageDir() { return require('./runtime.js').piPackageDir(); }

let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const dir = piPackageDir();
      const SDK = await import(pathToFileURL(path.join(dir, 'dist', 'index.js')).href);
      let theme;
      try {
        const themeMod = await import(pathToFileURL(path.join(dir, 'dist', 'modes', 'interactive', 'theme', 'theme.js')).href);
        // Extensions read ctx.ui.theme and some (prompt modes) fail hard
        // without an initialized theme. Custom views render into the light
        // Chattering page, so default to pi's light theme — dark-terminal
        // colors painted navy stripes on paper. settings.json piTheme
        // overrides. No watcher: this is a server.
        let themeName = 'light';
        try {
          const s = JSON.parse(fs.readFileSync(path.join(require('./platform.js').appDirs().config, 'settings.json'), 'utf8'));
          if (s && typeof s.piTheme === 'string' && s.piTheme) themeName = s.piTheme;
        } catch {}
        try { themeMod.initTheme(themeName, false); }
        catch { try { themeMod.initTheme(undefined, false); } catch {} }
        theme = themeMod.theme;
      } catch {}
      if (SDK.VERSION && SDK.VERSION !== PI_TESTED_VERSION) {
        console.error('[pisdk] pi v' + SDK.VERSION + ' differs from the tested v' + PI_TESTED_VERSION + '. Re-verify the embed after pi upgrades.');
      }
      return { SDK, dir, theme, version: SDK.VERSION };
    })();
    sdkPromise.catch(() => { sdkPromise = null; });
  }
  return sdkPromise;
}

function sdkInfo() {
  return sdkPromise ? sdkPromise.then(l => ({ version: l.version, dir: l.dir, tested: PI_TESTED_VERSION })) : null;
}

// Injection keeps lifecycle tests independent of installed providers and user files.
function createRuntimeEngine(hooks = {}) {
const getSdk = hooks.loadSdk || loadSdk;

// ---- session pool --------------------------------------------------------

const sdkSessions = new Map(); // resolved session file → S
const sdkQueues = new Map();   // resolved session file → promise chain
const creating = new Map();
const stopping = new Map();
let disposed = false;

function sessionBusy(S) {
  return !!(S.busy || S.preparing || S.session.isStreaming || S.session.isIdle === false);
}
function stateOf(S) {
  const model = S.session.model;
  return { sessionPath: S.file, cwd: S.session.sessionManager.getCwd(),
    model: model ? model.provider + '/' + model.id : S.model,
    busy: sessionBusy(S) || S.pendingUi.size > 0 || S.customViews.size > 0,
    uiAutoCancelled: S.uiAutoCancelled, pid: process.pid, alive: !S.stopped, engine: 'sdk' };
}
function publishState(S) {
  if (hooks.onState) hooks.onState(stateOf(S));
}


function queueOn(key, work) {
  const prev = sdkQueues.get(key) || Promise.resolve();
  const run = prev.then(work, work);
  const tail = run.catch(() => {});
  sdkQueues.set(key, tail);
  tail.then(() => { if (sdkQueues.get(key) === tail) sdkQueues.delete(key); });
  return run;
}

function fileSigOf(file) {
  if (hooks.fileSig) return hooks.fileSig(file);
  try {
    const s = fs.statSync(file);
    return s.ino + ':' + s.size + ':' + s.mtimeMs;
  } catch { return null; }
}

function armIdle(S) {
  clearTimeout(S.idleTimer);
  if (S.stopped) return;
  publishState(S);
  S.idleTimer = setTimeout(() => {
    // Retry delays, quiet tools, and extension-started turns are not idle.
    if (sessionBusy(S) || S.pendingUi.size || S.customViews.size) { armIdle(S); return; }
    stopWarmSession(S.file);
    if (hooks.onIdleStop) hooks.onIdleStop();
  }, hooks.idleMs ?? WARM_IDLE_MS);
  S.idleTimer.unref?.();
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
  return '';
}

// The extension UI context: Chattering's web face. Dialogs park in S.pendingUi
// until /api/run/ui-response answers them; everything else is forwarded as
// RPC-shaped extension_ui_request events, which server.js already renders.
function makeUiContext(S, loaded) {
  let panelBgSgr; // lazily resolved theme customMessageBg SGR params (undefined = not probed yet)
  const emit = req => S.emit({ type: 'extension_ui_request', id: crypto.randomUUID(), ...req });
  const dialog = (opts, defaultValue, request, parse) => {
    if (opts && opts.signal && opts.signal.aborted) return Promise.resolve(defaultValue);
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      let timer = null;
      let onAbort = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (onAbort && opts && opts.signal) opts.signal.removeEventListener('abort', onAbort);
        S.pendingUi.delete(id);
        if (hooks.onUiClosed) hooks.onUiClosed(id);
        publishState(S);
      };
      const finish = resp => { cleanup(); resolve(parse(resp)); };
      onAbort = () => { cleanup(); resolve(defaultValue); };
      if (opts && opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        S.uiAutoCancelled++;
        cleanup(); resolve(defaultValue);
      }, opts && opts.timeout || DIALOG_MAX_MS);
      S.pendingUi.set(id, {
        resolve: finish,
        cancel: () => finish({ cancelled: true }),
      });
      S.emit({ type: 'extension_ui_request', id, ...request });
    });
  };
  return {
    select: (title, options, opts) => dialog(opts, undefined,
      { method: 'select', title, options, timeout: opts && opts.timeout },
      r => r.cancelled ? undefined : r.value),
    confirm: (title, message, opts) => dialog(opts, false,
      { method: 'confirm', title, message, timeout: opts && opts.timeout },
      r => r.cancelled ? false : !!r.confirmed),
    input: (title, placeholder, opts) => dialog(opts, undefined,
      { method: 'input', title, placeholder, timeout: opts && opts.timeout },
      r => r.cancelled ? undefined : r.value),
    editor: (title, prefill) => dialog(undefined, undefined,
      { method: 'editor', title, prefill },
      r => r.cancelled ? undefined : r.value),
    notify(message, type) { emit({ method: 'notify', message, notifyType: type }); },
    setStatus(key, text) { emit({ method: 'setStatus', statusKey: key, statusText: text }); },
    setWidget(key, content, options) {
      if (content === undefined || Array.isArray(content)) {
        emit({ method: 'setWidget', widgetKey: key, widgetLines: content, widgetPlacement: options && options.placement });
      }
    },
    setTitle(title) { emit({ method: 'setTitle', title }); },
    setEditorText(text) { emit({ method: 'set_editor_text', text }); },
    pasteToEditor(text) { this.setEditorText(text); },
    getEditorText() { return S.editorText || ''; },
    onTerminalInput() { return () => {}; },
    setWorkingMessage() {}, setWorkingVisible() {}, setWorkingIndicator() {},
    setHiddenThinkingLabel() {}, setFooter() {}, setHeader() {},
    // TUI custom views, hosted headlessly. A pi-tui Component is only
    // render(width) → styled lines plus handleInput(rawKeyData): run it
    // against a virtual screen, stream the lines to the browser, and feed
    // browser keys back. tui.requestRender is the one TUI method real
    // extensions call (verified across modes/cell/ensemble).
    custom(factory, _options) {
      const id = crypto.randomUUID();
      // The browser panel is sized to exactly 100ch (font autoscales on
      // narrow screens), so no horizontal scrollbar appears.
      const VIEW_WIDTH = 100;
      // The extension's panel fill (theme customMessageBg, a dark navy) looks
      // harsh inside the web modal. Send its raw SGR params along so the
      // browser can render that exact background as transparent.
      if (panelBgSgr === undefined) {
        panelBgSgr = null;
        try {
          const probe = loaded && loaded.theme && loaded.theme.bg ? loaded.theme.bg('customMessageBg', 'X') : '';
          const m = /\x1b\[([0-9;]*)m/.exec(probe);
          if (m && /^(48|10[0-7]|4[0-7])(;|$)/.test(m[1])) panelBgSgr = m[1];
        } catch {}
      }
      return new Promise(resolve => {
        let component = null;
        let closed = false;
        let renderTimer = null;
        const finish = result => {
          if (closed) return;
          closed = true;
          clearTimeout(renderTimer);
          try { if (component && component.dispose) component.dispose(); } catch {}
          S.customViews.delete(id);
          S.emit({ type: 'extension_ui_request', id, method: 'custom_end' });
          resolve(result);
        };
        const pushRender = () => {
          if (closed) return;
          clearTimeout(renderTimer);
          renderTimer = setTimeout(() => {
            if (closed || !component) return;
            let lines;
            try { lines = component.render(VIEW_WIDTH) || []; }
            catch (e) { lines = ['render error: ' + (e && e.message)]; }
            S.emit({ type: 'extension_ui_request', id, method: 'custom_render', lines: lines.slice(0, 200), bgSgr: panelBgSgr });
          }, 16);
        };
        const fakeTui = {
          requestRender: pushRender,
          terminal: { columns: VIEW_WIDTH, rows: 45 },
          width: VIEW_WIDTH,
        };
        const keybindingsStub = new Proxy({}, { get: () => () => undefined });
        // Register before awaiting the factory so abort/dispose can cancel it.
        S.customViews.set(id, { cancel: () => finish(undefined), input: () => {} });
        Promise.resolve()
          .then(() => factory(fakeTui, loaded.theme, keybindingsStub, finish))
          .then(c => {
            if (closed) { try { if (c && c.dispose) c.dispose(); } catch {} return; }
            component = c;
            S.customViews.set(id, {
              input: data => {
                if (closed || !component) return;
                try { if (component.handleInput) component.handleInput(data); } catch {}
                pushRender();
              },
              cancel: () => finish(undefined),
            });
            pushRender();
          })
          .catch(e => {
            S.emit({ type: 'extension_error', extensionPath: '(custom view)', event: 'custom', error: String(e && e.message || e) });
            finish(undefined);
          });
      });
    },
    addAutocompleteProvider() {}, setEditorComponent() {},
    getEditorComponent() { return undefined; },
    get theme() { return loaded.theme; },
    getAllThemes() { return []; },
    getTheme() { return undefined; },
    setTheme() { return { success: false, error: 'Theme switching is not supported in the web face yet' }; },
    getToolsExpanded() { return false; },
    setToolsExpanded() {},
  };
}

// Reply speed, measured where the events are born and stored in the session
// as one `chattering-speed` custom entry per agent run, so it travels with the
// file (forks, copies) and the usage index reads it back. The samples name
// their assistant message's entry id: forks copy entries verbatim, so the
// same reply counts once however many files hold it.
function observeSpeed(S, ev, at) {
  const speed = S.speed;
  if (ev.type === 'agent_start') speed.turnLeafId = leafIdOf(S.session.sessionManager);
  const sample = speed.meter.observe(ev, at);
  if (sample) speed.samples.push({ sample, message: ev.message });
  if (ev.type === 'agent_end' && speed.samples.length) persistSpeedSamples(S);
}
function leafIdOf(sm) {
  try { return typeof sm.getLeafId === 'function' ? sm.getLeafId() || null : null; } catch { return null; }
}
// The listener runs before pi persists a message_end, so entry ids are only
// known at agent_end. Pi persists the same message object it emits; match
// by identity, not timestamps (two replies can share a millisecond).
function assistantEntryIds(sm, stopAtId) {
  const ids = new Map();
  if (typeof sm.getBranch !== 'function') return ids;
  const branch = sm.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.id === stopAtId) break;
    const message = entry.type === 'message' ? entry.message : null;
    if (message && message.role === 'assistant') ids.set(message, entry.id);
  }
  return ids;
}
function persistSpeedSamples(S) {
  const speed = S.speed;
  const samples = speed.samples.splice(0);
  try {
    const sm = S.session.sessionManager;
    if (typeof sm.appendCustomEntry !== 'function') throw new Error('session manager cannot append entries');
    const ids = assistantEntryIds(sm, speed.turnLeafId);
    sm.appendCustomEntry('chattering-speed', {
      v: 1, at: new Date().toISOString(),
      samples: samples.map(({ sample, message }) => ({ entryId: ids.get(message) || null, ...sample })),
      measurementId: crypto.randomUUID(),
    });
  } catch (error) {
    S.emit({ type: 'run_note', text: 'could not record the reply speed: ' + String(error.message || error) });
  }
}

async function bindS(S, loaded) {
  const session = S.runtime.session;
  S.session = session;
  const previousFile = S.file;
  S.file = path.resolve(session.sessionFile || S.file);
  if (previousFile !== S.file && sdkSessions.get(previousFile) === S) sdkSessions.delete(previousFile);
  sdkSessions.set(S.file, S);
  if (S.unsub) S.unsub();
  S.speed = { meter: createSpeedMeter({ thinkingLevel: () => session.thinkingLevel ?? null }), samples: [], turnLeafId: null };
  // Subscribe before bindExtensions: session_start hooks can start turns or dialogs.
  S.unsub = session.subscribe(ev => {
    const at = performance.now();
    S.lastEventAt = Date.now();
    observeSpeed(S, ev, at);
    // An autonomous extension turn wins over the optional editing pass.
    if (ev.type === 'agent_start') S.rewriteController?.abort();
    // Source clock travels with the event: IPC and browser batching must
    // not change the observed rate. Never mutate the SDK's event object.
    S.emit({ ...ev, chatteringSpeedAt: at });
    if (ev.type === 'agent_settled') {
      // An extension can start a fresh turn inside agent_settled.
      queueMicrotask(() => {
        if (!sessionBusy(S)) S.fileSig = fileSigOf(S.file);
        armIdle(S);
      });
    }
  });
  installCustomPromptPreparation(session, {
    begin() {
      const epoch = S.abortEpoch || 0;
      S.preparing = (S.preparing || 0) + 1;
      S.emit({ type: 'custom_turn_preflight' });
      publishState(S);
      return () => S.stopped || (S.abortEpoch || 0) !== epoch;
    },
    end() {
      S.preparing = Math.max(0, (S.preparing || 0) - 1);
      publishState(S);
      if (!S.stopped) armIdle(S);
    },
  });
  publishState(S);
  await session.bindExtensions({
    uiContext: makeUiContext(S, loaded),
    mode: 'rpc', // extensions see the documented headless surface
    commandContextActions: {
      waitForIdle: () => session.waitForIdle(),
      newSession: async options => S.runtime.newSession(options),
      fork: async (entryId, forkOptions) => {
        const r = await S.runtime.fork(entryId, forkOptions);
        return { cancelled: r.cancelled };
      },
      navigateTree: async (targetId, options) => {
        const r = await session.navigateTree(targetId, options || {});
        return { cancelled: r.cancelled };
      },
      switchSession: async (p, options) => S.runtime.switchSession(p, options),
      reload: async () => { await session.reload(); },
    },
    shutdownHandler: () => { if (hooks.onShutdown) hooks.onShutdown(); },
    onError: err => {
      if (requiredExtensionError(err)) S.extensionFailure = new Error('Required extension failed: ' + err.extensionPath + ': ' + err.error);
      S.emit({ type: 'extension_error', extensionPath: err.extensionPath, event: err.event, error: err.error });
    },
  });
  if (S.extensionFailure) throw S.extensionFailure;
  S.fileSig = fileSigOf(S.file);
  publishState(S);
}

async function createS(target) {
  const loaded = await getSdk();
  if (disposed) throw new Error('Pi runtime is stopped');
  const { SDK } = loaded;
  const agentDir = SDK.getAgentDir();
  // `sessionDir` pins where a new session's file lands (a sandboxed guest
  // writes into the project's own session folder, the only one bound in).
  const sm = target.sessionPath
    ? SDK.SessionManager.open(path.resolve(target.sessionPath), target.sessionDir || undefined)
    : SDK.SessionManager.create(target.cwd, target.sessionDir || undefined);
  const cwd = sm.getCwd() || target.cwd;
  const trustStore = new SDK.ProjectTrustStore(agentDir);
  const parsed = parseExtraArgs(target.extraArgs);
  let loadErrors = [];
  const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const projectTrusted = !SDK.hasTrustRequiringProjectResources(cwd) || trustStore.get(cwd) === true;
    const settingsManager = SDK.SettingsManager.create(cwd, agentDir, { projectTrusted });
    const services = await SDK.createAgentSessionServices({
      cwd, agentDir, settingsManager,
      modelRuntimeSignal: AbortSignal.timeout(15000),
      extensionFlagValues: parsed.flags.size ? parsed.flags : undefined,
      resourceLoaderOptions: {
        noExtensions: parsed.noExtensions,
        extensionFactories: [{ name: 'workspace-checkpoints', factory: require('./checkpoint-extension.js').checkpointExtension }],
        additionalExtensionPaths: parsed.extensionPaths.length ? parsed.extensionPaths : undefined,
        // pi's resource loader treats appendSystemPromptSource as an array of
        // paths/texts (each resolved through resolvePromptInput).
        appendSystemPrompt: parsed.appendSystemPrompt ? [parsed.appendSystemPrompt] : undefined,
      },
    });
    const errors = services.resourceLoader?.getExtensions().errors || [];
    const fatal = errors.filter(error => parsed.noExtensions || requiredExtensionError({ extensionPath: error.path }) ||
      parsed.extensionPaths.some(file => path.resolve(cwd, file) === path.resolve(error.path)));
    const diagnostics = (services.diagnostics || []).filter(d => d.type === 'error');
    if (fatal.length || diagnostics.length) {
      throw new Error([...fatal.map(e => 'Extension ' + e.path + ': ' + e.error), ...diagnostics.map(d => d.message)].join('\n'));
    }
    loadErrors = errors;
    return {
      ...(await SDK.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  const runtime = await SDK.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: sm });
  if (disposed) { await runtime.dispose(); throw new Error('Pi runtime is stopped'); }
  const file = runtime.session.sessionFile || sm.getSessionFile();
  const S = {
    file: path.resolve(file),
    runtime, session: runtime.session,
    policyFingerprint: extensionPolicyFingerprint(target),
    busy: false, idleTimer: null, model: null,
    fileSig: fileSigOf(file),
    pendingUi: new Map(),
    customViews: new Map(),
    lastEventAt: Date.now(),
    uiAutoCancelled: 0, stopped: false,
    onEvent: null,
    editorText: '',
    unsub: null,
    emit(ev) {
      if (hooks.onEvent) hooks.onEvent(ev, stateOf(S));
      if (S.onEvent) S.onEvent(ev);
    },
  };
  const reportLoadErrors = () => {
    for (const error of loadErrors) S.emit({ type: 'extension_error', extensionPath: error.path, event: 'load', error: error.error });
  };
  runtime.setRebindSession(async () => { reportLoadErrors(); await bindS(S, loaded); });
  reportLoadErrors();
  try { await bindS(S, loaded); }
  catch (error) {
    stopWarmSession(S.file);
    if (stopping.has(S.file)) await stopping.get(S.file);
    throw error;
  }
  if (disposed || S.stopped) throw new Error('Pi runtime is stopped');
  if (parsed.name && typeof S.session.setSessionName === 'function') {
    try { S.session.setSessionName(parsed.name); } catch {}
  }
  sdkSessions.set(S.file, S);
  return S;
}

async function ensureS(target) {
  if (disposed) throw new Error('Pi runtime is stopped');
  const key = path.resolve(target.sessionPath);
  if (creating.has(key)) return creating.get(key);
  const work = (async () => {
    const S = sdkSessions.get(key);
    if (S) {
      const changed = S.policyFingerprint !== extensionPolicyFingerprint(target);
      const busy = sessionBusy(S) || S.pendingUi.size || S.customViews.size;
      // A required extension failure belongs to this runtime, not the next
      // prompt. Never send new work through it or abort an active run to reset
      // it; once idle, await its teardown before opening the replacement.
      if (S.extensionFailure) {
        if (busy) throw S.extensionFailure;
      } else if (busy || (!changed && S.fileSig === fileSigOf(key))) return S;
      stopWarmSession(key);
    }
    if (stopping.has(key)) await stopping.get(key);
    return createS(target);
  })();
  creating.set(key, work);
  try { return await work; }
  finally { if (creating.get(key) === work) creating.delete(key); }
}

// ---- exported surface (mirrors pirpc.js) ---------------------------------

function piHeadlessRun(target, opts = {}) {
  let aborted = false;
  let current = null;
  const key = path.resolve(target.sessionPath);
  const handle = { done: null, uiAutoCancelled: 0, pid: process.pid, engine: 'sdk',
    abort: async () => {
      aborted = true;
      if (current) { current.abortEpoch = (current.abortEpoch || 0) + 1; current.rewriteController?.abort(); cancelUi(current); await current.session.abort(); }
    },
    respondUi: (id, response) => respondUi(id, response),
    uiInput: (id, data) => uiInput(id, data),
  };
  const work = async () => {
    if (aborted) throw new Error('Pi run aborted before start');
    const S = current = await ensureS(target);
    if (aborted) { cancelUi(S); throw new Error('Pi run aborted before start'); }
    clearTimeout(S.idleTimer);
    S.busy = true;
    S.onEvent = opts.onEvent || null;
    const beforeCancelled = S.uiAutoCancelled;
    publishState(S);
    let rewrite;
    try {
      const want = opts.provider && opts.modelId ? opts.provider + '/' + opts.modelId : null;
      if (want && stateOf(S).model !== want) {
        const models = S.session.modelRuntime.getAvailableSnapshot();
        const model = models.find(m => m.provider === opts.provider && m.id === opts.modelId);
        if (!model) throw new Error('Model not found: ' + opts.provider + '/' + opts.modelId);
        await S.session.setModel(model);
        S.model = want;
      }
      // A reasoning level asked for with this prompt: set before it, and
      // persisted by pi (a thinking_level_change entry), like the composer's
      // control. A model without the level keeps its nearest one (pi clamps).
      if (opts.thinking) {
        try {
          if (S.session.supportsThinking()) S.session.setThinkingLevel(opts.thinking);
          else S.emit({ type: 'run_note', text: 'this model has no reasoning control; the reasoning level was not changed' });
        } catch (error) { S.emit({ type: 'run_note', text: 'could not set the reasoning level: ' + String(error.message || error) }); }
      }
      if (aborted) throw new Error('Pi run aborted before prompt');
      if (S.extensionFailure) throw S.extensionFailure;
      if (opts.simplifyAnswers && !opts.customMessage) rewrite = captureRewriteRequest(S.session, opts.simplifyPrompt);
      // Who is sending: one entry in the session tree right before the user
      // message, so it travels with the file (forks, copies) and the index
      // reads it back. Not for callbacks: nobody typed those.
      if (opts.author && opts.author.id && !opts.customMessage) {
        try { S.session.sessionManager.appendCustomEntry('chattering-author', { v: 1, user: { id: String(opts.author.id), name: String(opts.author.name || '') }, input: String(opts.author.input || 'keyboard'), coauthors: Array.isArray(opts.author.coauthors) ? opts.author.coauthors.slice(0, 20) : undefined, at: new Date().toISOString() }); }
        catch (error) { S.emit({ type: 'run_note', text: 'could not record the author: ' + String(error.message || error) }); }
      }
      if (opts.customMessage) {
        const { customType, content, details } = opts.customMessage;
        if (typeof customType !== 'string' || !customType) throw new Error('customMessage.customType is required');
        await S.session.sendCustomMessage({ customType, content, display: true, details },
          { triggerTurn: true, deliverAs: 'followUp' });
      } else {
        await S.session.prompt(opts.message, {
          images: Array.isArray(opts.images) && opts.images.length ? opts.images : undefined,
          source: 'rpc', streamingBehavior: 'followUp',
        });
      }
      // Commands and queued custom messages can return before their turn.
      // Use SDK idle state, not agent_end (which precedes retries/followups).
      await waitForCustomTurns(S.session);
      await S.session.waitForIdle();
      if (S.extensionFailure) throw S.extensionFailure;
      rewrite?.restore();
      if (rewrite && !aborted && !S.stopped && S.uiAutoCancelled === beforeCancelled) {
        S.rewriteController = new AbortController();
        try { await rewrite.run({ signal: S.rewriteController.signal, emit: ev => S.emit(ev) }); }
        catch (error) { S.emit({ type: 'answer_rewrite', state: 'failed', error: String(error.message || error) }); }
        finally { S.rewriteController = null; }
        // A real extension callback may have superseded the optional pass.
        // It still owns this run until its retries/follow-ups have settled.
        await waitForCustomTurns(S.session);
        await S.session.waitForIdle();
      }
      if (S.extensionFailure) throw S.extensionFailure;
      return { uiAutoCancelled: S.uiAutoCancelled - beforeCancelled, pid: process.pid, warm: true, engine: 'sdk' };
    } finally {
      rewrite?.restore();
      S.busy = false;
      S.onEvent = null;
      if (!sessionBusy(S)) { cancelUi(S); S.fileSig = fileSigOf(S.file); }
      handle.uiAutoCancelled = S.uiAutoCancelled - beforeCancelled;
      current = null;
      if (sdkSessions.get(S.file) === S) armIdle(S);
    }
  };
  handle.done = queueOn(key, work);
  return handle;
}

// One raw completion against the exact context a session would send from
// a given node, with no tool runner. Used for derivations (a notebook from
// an answer): the provider sees the same system prompt, tool schemas and
// history as the conversation — so the cached prefix can be reused — but
// nothing in this path can execute a tool. The session is a PRIVATE
// snapshot (target.sessionPath is a staged fork); nothing is written to
// the real conversation, and the caller discards the snapshot afterwards.
const DERIVE_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
async function piDeriveAt(target, opts = {}) {
  const prompt = String(opts.prompt || '').trim();
  if (!prompt) throw new Error('derive: prompt is required');
  const S = await createS(target);
  const textOf = message => (message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  try {
    clearTimeout(S.idleTimer);
    S.busy = true;
    // Lowest supported reasoning: this is an editing pass, not new thinking.
    let level = 'off';
    try {
      if (S.session.supportsThinking()) {
        const levels = S.session.getAvailableThinkingLevels();
        level = DERIVE_LEVELS.find(l => levels.includes(l)) || 'off';
      }
    } catch {}
    const agent = S.session.agent;
    if (typeof agent?.streamFunction !== 'function') throw new Error('derive: session has no stream function');
    const original = agent.streamFunction;
    let captured = null;
    // Capture the prepared request and refuse the turn: the agent loop never
    // gets a response to act on, so no tool can run in this pass.
    agent.streamFunction = async (model, context, options) => {
      if (!captured) captured = { model, context: { ...context, messages: context.messages.slice() }, options: { ...options } };
      const refusal = new Error('Chattering derive: context captured');
      refusal.chatteringDerive = true;
      throw refusal;
    };
    try {
      await S.session.prompt(prompt, { source: 'rpc', streamingBehavior: 'followUp' });
      await S.session.waitForIdle();
    } catch (error) {
      if (!captured) throw error;
    } finally {
      if (agent.streamFunction !== original) agent.streamFunction = original;
    }
    if (!captured) throw new Error('derive: the session did not prepare a request');
    const controller = new AbortController();
    S.rewriteController = controller;
    const stream = await original(captured.model, captured.context, { ...captured.options, signal: controller.signal, reasoning: level === 'off' ? undefined : level });
    for await (const _event of stream) { /* drain; the caller reads the complete result */ }
    const response = await stream.result();
    if (response.stopReason !== 'stop' || !textOf(response).trim()) {
      throw new Error(response.errorMessage || (response.stopReason === 'toolUse' ? 'The model tried to use tools; none were executed' : 'The model did not finish'));
    }
    if (response.content.some(b => b.type === 'toolCall')) throw new Error('The model tried to use tools; none were executed');
    return {
      text: textOf(response),
      model: captured.model.provider + '/' + captured.model.id,
      reasoning: level,
      usage: response.usage || null,
      timestamp: response.timestamp || Date.now(),
    };
  } finally {
    S.rewriteController = null;
    S.busy = false;
    stopWarmSession(S.file);
  }
}

// Queue into a run that is ALREADY STREAMING (same semantics as typing in
// the TUI while the model works). Resolves at prompt acceptance, not end.
async function piQueuePrompt(target, message, behavior, images) {
  const key = path.resolve(target.sessionPath);
  const S = sdkSessions.get(key);
  if (!S || S.rewriteController || !S.session.isStreaming) return false;
  if (S.extensionFailure) throw S.extensionFailure;
  return await new Promise((resolve, reject) => {
    S.session.prompt(message, {
      streamingBehavior: behavior || 'followUp',
      images: Array.isArray(images) && images.length ? images : undefined,
      source: 'rpc',
      preflightResult: ok => resolve(!!ok),
    }).catch(e => reject(e));
  });
}

// Independent native file forks. Even SDK migration happens on a private
// snapshot, never on the source owned by a running agent.
async function piForkAt(target, nodeId, options) {
  const { SDK } = await getSdk();
  return forkPiSnapshot(SDK.SessionManager, target, nodeId, options);
}

async function piForkBefore(target, nodeId) {
  const { SDK } = await getSdk();
  return forkPiSnapshot(SDK.SessionManager, target, nodeId, { before: true });
}

// Set the session's reasoning (thinking) level through pi's own runtime
// (persists a native thinking_level_change entry, so resumes and branches
// inherit it). level 'cycle' steps to the next available level.
async function piSetThinking(target, level) {
  const S = await ensureS(target);
  clearTimeout(S.idleTimer);
  try {
    if (!S.session.supportsThinking()) throw new Error('This model has no reasoning control.');
    if (level === 'cycle') S.session.cycleThinkingLevel();
    else S.session.setThinkingLevel(level);
    return { level: S.session.thinkingLevel, levels: S.session.getAvailableThinkingLevels() };
  } finally {
    S.fileSig = fileSigOf(S.file);
    armIdle(S);
  }
}

// Compact through pi's own runtime, as /compact in the terminal: older
// messages become a written summary (text only; images are not carried), a
// compaction entry lands in the session, and the next request starts from
// the summary plus the recent messages. instructions: optional focus for
// the summary.
async function piCompact(target, instructions) {
  const S = await ensureS(target);
  clearTimeout(S.idleTimer);
  if (sessionBusy(S)) throw new Error('This conversation is busy. Wait for the reply to finish, then compact.');
  S.busy = true;
  publishState(S);
  try {
    const result = await S.session.compact(instructions || undefined);
    return { tokensBefore: result.tokensBefore, tokensAfter: result.estimatedTokensAfter ?? null };
  } finally {
    S.busy = false;
    S.fileSig = fileSigOf(S.file);
    publishState(S);
    armIdle(S);
  }
}

// Start a new pi session in cwd and keep it in the pool.
async function piBeginWarm(target) {
  const S = target.sessionPath ? await ensureS(target) : await createS(target);
  // pi buffers a new session in memory until the FIRST assistant reply
  // (SessionManager._persist checks hasAssistant), so a silent start never
  // creates the file and the server aborts with "pi did not write the
  // session file". Force the initial flush: _rewriteFile opens with "w"
  // and later appends key off flushed=true, so this is safe and durable.
  const sm = S.session.sessionManager;
  if (sm && sm.flushed === false && typeof sm._rewriteFile === 'function') {
    sm._rewriteFile();
    sm.flushed = true;
  }
  S.fileSig = fileSigOf(S.file);
  armIdle(S);
  return { file: S.file, sessionId: S.session.sessionId, pid: process.pid, engine: 'sdk' };
}

function cancelUi(S) {
  for (const p of [...S.pendingUi.values()]) { S.uiAutoCancelled++; p.cancel(); }
  for (const v of [...S.customViews.values()]) v.cancel();
}
function respondUi(id, response) {
  for (const S of sdkSessions.values()) {
    const p = S.pendingUi.get(id);
    if (!p) continue;
    if (response && response.cancelled) p.cancel(); else p.resolve(response || {});
    return true;
  }
  return false;
}
function uiInput(id, data) {
  for (const S of sdkSessions.values()) {
    const view = S.customViews.get(id);
    if (!view) continue;
    if (data === null) view.cancel(); else view.input(String(data));
    return true;
  }
  return false;
}
async function abort() {
  await Promise.all([...sdkSessions.values()].map(async S => {
    S.abortEpoch = (S.abortEpoch || 0) + 1;
    S.rewriteController?.abort();
    cancelUi(S);
    await S.session.abort();
  }));
}
async function waitForIdle() {
  await Promise.all([...sdkSessions.values()].map(async S => { await waitForCustomTurns(S.session); await S.session.waitForIdle(); }));
}
function stopWarmSession(sessionPath) {
  const key = path.resolve(sessionPath);
  const S = sdkSessions.get(key);
  if (!S) return false;
  S.stopped = true;
  S.rewriteController?.abort();
  clearTimeout(S.idleTimer);
  sdkSessions.delete(key);
  cancelUi(S);
  const done = (async () => {
    // Start abort and extension teardown together: shutdown hooks can release
    // resources that the active turn is waiting for.
    // dispose disconnects SDK event listeners. An abort waiter can then remain
    // unresolved, so teardown completion (not that waiter) owns process exit.
    Promise.resolve().then(() => S.session.abort()).catch(error => {
      if (hooks.onError) hooks.onError(error);
    });
    try { await S.runtime.dispose(); }
    finally { if (S.unsub) S.unsub(); }
  })();
  stopping.set(key, done);
  done.catch(error => { if (hooks.onError) hooks.onError(error); });
  done.finally(() => { if (stopping.get(key) === done) stopping.delete(key); }).catch(() => {});
  return true;
}
async function dispose() {
  disposed = true;
  stopAllWarmSessions();
  await Promise.allSettled([...creating.values()]);
  stopAllWarmSessions();
  await Promise.all([...stopping.values()]);
}

function stopAllWarmSessions() {
  let n = 0;
  for (const key of [...sdkSessions.keys()]) { if (stopWarmSession(key)) n++; }
  return n;
}

function listWarmSessions() {
  const out = [];
  for (const [key, S] of sdkSessions) {
    out.push(stateOf(S));
  }
  return out;
}

// The web composer's current text, for extensions that call getEditorText().
function setEditorTextFor(sessionPath, text) {
  const S = sdkSessions.get(path.resolve(sessionPath));
  if (S) S.editorText = String(text || '');
}

return {
  piForkAt, piForkBefore, piSetThinking, piCompact, piHeadlessRun, piQueuePrompt, piBeginWarm, piDeriveAt,
  stopWarmSession, stopAllWarmSessions, listWarmSessions,
  setEditorTextFor, abort, respondUi, uiInput, waitForIdle, dispose,
};
}

// These utilities do not instantiate sessions or load extensions in the host.
const utilities = createRuntimeEngine();
module.exports = { createRuntimeEngine, loadSdk, sdkInfo, piPackageDir,
  piForkAt: utilities.piForkAt, piForkBefore: utilities.piForkBefore };

