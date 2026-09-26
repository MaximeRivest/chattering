// pi RPC bridge worker.
// Session operations for pi run through pi's OWN runtime, not through hand
// surgery on JSONL: a short-lived `pi --mode rpc` process bound to the target
// file. `--no-extensions` keeps global extensions (modes.ts) from appending
// entries to the session; `-e` loads only the Chattering bridge.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PI_BRIDGE_PATH = path.join(__dirname, 'chattering-bridge.ts');

// ---- protocol handshake -------------------------------------------------
// Chattering depends on pi RPC details that have changed across pi versions
// (the settle event was `agent_end` before ~0.75, `agent_settled` after).
// pi updates through npm, silently. Without a version gate a rename would
// make the settle waiter hang forever and every run would die on timeout
// with no explanation. The gate fails fast and names the version instead.
const PI_MIN_VERSION = '0.75.0';    // first protocol with agent_settled
const { PI_TESTED_VERSION } = require('./runtime.js'); // runtime/package.json
let piProtocolPromise = null;
let piProtocol = { version: null, tested: PI_TESTED_VERSION, ok: false, newer: false };

function semverLt(a, b) {
  const x = String(a).trim().split('.').map(n => parseInt(n, 10) || 0);
  const y = String(b).trim().split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}

function ensurePiProtocol(env) {
  if (!piProtocolPromise) {
    piProtocolPromise = new Promise((resolve, reject) => {
      const pi = require('./runtime.js').piCommand(['--version'], { env: env || process.env });
      execFile(pi.file, pi.args, { env: env || process.env, timeout: 15000 }, (err, stdout) => {
        if (err) return reject(new Error('Cannot run `pi --version`: ' + err.message.split('\n')[0]));
        const version = String(stdout).trim().split('\n')[0].trim();
        if (!/^\d+\.\d+\.\d+/.test(version)) return reject(new Error('Unexpected `pi --version` output: ' + version.slice(0, 80)));
        piProtocol = { version, tested: PI_TESTED_VERSION, ok: !semverLt(version, PI_MIN_VERSION), newer: semverLt(PI_TESTED_VERSION, version) };
        if (!piProtocol.ok) {
          return reject(new Error('pi v' + version + ' is older than v' + PI_MIN_VERSION + '; its RPC protocol lacks agent_settled. Upgrade pi or downgrade Chattering.'));
        }
        if (piProtocol.newer) console.error('[pirpc] pi v' + version + ' is newer than the tested v' + PI_TESTED_VERSION + '. The RPC bridge still assumes the tested protocol; re-verify after pi upgrades.');
        resolve(piProtocol);
      });
    });
    // A failed probe (missing binary, transient exec error) retries next call.
    piProtocolPromise.catch(() => { piProtocolPromise = null; });
  }
  return piProtocolPromise;
}

function piVersionHint() {
  return piProtocol.newer
    ? ' pi v' + piProtocol.version + ' is newer than the tested v' + piProtocol.tested + ' — the RPC protocol may have changed.'
    : '';
}

function piProtocolInfo() { return { ...piProtocol, min: PI_MIN_VERSION }; }

// One JSONL RPC process. Forks keep it short-lived. Headless sends keep it
// warm (discoverExtensions) so follow-ups skip startup. target:
// { sessionPath, cwd, extraArgs?, onEvent?, discoverExtensions? }
function spawnPiRpc(target) {
  const sessionArgs = target.sessionPath ? ['--session', target.sessionPath] : [];
  const args = target.discoverExtensions
    ? ['--mode', 'rpc', ...sessionArgs, ...(target.extraArgs || [])]
    : ['--mode', 'rpc', '--no-extensions', '-e', PI_BRIDGE_PATH, ...sessionArgs, ...(target.extraArgs || [])];
  const pi = require('./runtime.js').piCommand(args, { env: target.env || process.env });
  const child = spawn(pi.file, pi.args, { cwd: target.cwd, env: target.env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', buffer = '', onEvent = target.onEvent || null;
  const waiters = [];
  const tail = () => stderr ? ' pi said: ' + stderr.trim().slice(-400) : '';
  const sess = {
    alive: true,
    pid: child.pid,
    setOnEvent(fn) { onEvent = fn; },
    kill() { try { child.kill('SIGTERM'); } catch {} },
    dead: null,
    request: null,
    waitFor: null,
    send: null,
    tail,
  };
  let deadResolve;
  sess.dead = new Promise(r => { deadResolve = r; });
  const failWaiters = err => {
    const pending = waiters.splice(0);
    for (const w of pending) { try { w.reject ? w.reject(err) : w.resolve({ type: 'error', error: err.message }); } catch {} }
  };
  child.stderr.on('data', d => { stderr += d; });
  child.on('error', err => {
    sess.alive = false;
    failWaiters(err);
    deadResolve(err);
  });
  child.on('exit', code => {
    sess.alive = false;
    const err = new Error('pi exited (code ' + code + ').' + tail());
    failWaiters(err);
    deadResolve(code);
  });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    // Strict JSONL framing: split on \n only. pi RPC forbids line readers
    // that also split on U+2028/U+2029 (Node readline does).
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'extension_error' && !target.discoverExtensions) {
        // Bridge-only mode loads exactly one extension — the Chattering bridge —
        // and the whole operation depends on it, so its failure is fatal.
        const err = new Error('pi bridge error: ' + (event.error || 'unknown'));
        failWaiters(err);
        sess.kill();
        return;
      }
      // With discovered extensions an extension_error is informational, the
      // same as in the pi TUI: surface it through onEvent and keep running.
      // Killing here was the main cause of web runs dying while TUI runs
      // never did — any global extension hiccup aborted the whole run.
      if (onEvent) { try { onEvent(event); } catch {} }
      const i = waiters.findIndex(w => w.test(event));
      if (i >= 0) waiters.splice(i, 1)[0].resolve(event);
    }
  });
  sess.request = cmd => {
    if (!sess.alive) return Promise.reject(new Error('pi RPC process is gone.' + tail()));
    const id = crypto.randomUUID();
    const matched = new Promise((res, rej) => waiters.push({ test: e => e.type === 'response' && e.id === id, resolve: res, reject: rej }));
    try { child.stdin.write(JSON.stringify({ id, ...cmd }) + '\n'); }
    catch (e) { return Promise.reject(e); }
    return matched.then(response => {
      if (!response.success) throw new Error(response.error || cmd.type + ' failed' + tail());
      return response;
    });
  };
  sess.waitFor = test => new Promise((res, rej) => waiters.push({ test, resolve: res, reject: rej }));
  sess.send = obj => { try { child.stdin.write(JSON.stringify(obj) + '\n'); } catch {} };
  return sess;
}

function piRpcOperation(target, run, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const sess = spawnPiRpc(target);
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sess.kill();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('The pi session operation timed out.' + sess.tail() + piVersionHint())), timeoutMs);
    const io = { waitFor: sess.waitFor, send: sess.send };
    Promise.resolve()
      .then(() => ensurePiProtocol(target.env))
      .then(() => run(sess.request, io))
      .then(v => finish(null, v), finish);
  });
}

const WARM_IDLE_MS = 5 * 60 * 1000;
const warmSessions = new Map(); // resolved sessionPath → { sess, busy, idleTimer, model, fileSig }
const warmQueues = new Map();   // resolved sessionPath → promise chain (serializes prompts per file)

function warmKey(sessionPath) { return path.resolve(sessionPath); }

// On-disk identity of the session file. The warm process caches the whole
// session tree in memory, exactly like the pi TUI — but the TUI is reliable
// because it loads the file fresh at every open and stays the only writer
// while it runs. A warm process that outlives other writers (a terminal
// session, an edit, a remote device) would continue from a stale leaf and
// silently branch the conversation. The signature detects that.
function fileSigOf(key) {
  try {
    const s = fs.statSync(key);
    return s.ino + ':' + s.size + ':' + s.mtimeMs;
  } catch { return null; }
}

// One queue per session file, independent of process lifetime: back-to-back
// prompts stay serialized even when a stale process is replaced in between.
function queueOn(key, work) {
  const prev = warmQueues.get(key) || Promise.resolve();
  const run = prev.then(work, work);
  warmQueues.set(key, run.catch(() => {}));
  return run;
}

function armWarmIdle(w, key) {
  clearTimeout(w.idleTimer);
  w.idleTimer = setTimeout(() => {
    // Never idle-kill a process that is mid-run: re-arm and check again later.
    if (w.busy) { armWarmIdle(w, key); return; }
    stopWarmSession(key);
  }, WARM_IDLE_MS);
}

function getWarmSession(target) {
  const key = warmKey(target.sessionPath);
  let w = warmSessions.get(key);
  if (w && w.sess.alive) {
    // The file changed on disk behind this warm process: its in-memory tree
    // is stale, and a continuation would branch from an old leaf. Do what
    // the TUI does at open — load the current file — by respawning. A busy
    // process is never yanked; its own writes update the signature after.
    if (!w.busy && w.fileSig && w.fileSig !== fileSigOf(key)) stopWarmSession(key);
    else return w;
  }
  const sess = spawnPiRpc({ ...target, discoverExtensions: true });
  w = { sess, busy: false, idleTimer: null, model: null, fileSig: fileSigOf(key) };
  warmSessions.set(key, w);
  sess.dead.then(() => { if (warmSessions.get(key) === w) warmSessions.delete(key); });
  return w;
}

// The agents view lists these: every warm RPC process the server owns.
function listWarmSessions() {
  const out = [];
  for (const [key, w] of warmSessions) {
    out.push({ sessionPath: key, pid: w.sess.pid, busy: !!w.busy, model: w.model, alive: !!w.sess.alive });
  }
  return out;
}

// Shutdown helper: kill every warm pi process (their runs were aborted first).
function stopAllWarmSessions() {
  let n = 0;
  for (const key of [...warmSessions.keys()]) { if (stopWarmSession(key)) n++; }
  return n;
}

function stopWarmSession(sessionPath) {
  const key = warmKey(sessionPath);
  const w = warmSessions.get(key);
  if (!w) return false;
  clearTimeout(w.idleTimer);
  warmSessions.delete(key);
  try { w.sess.kill(); } catch {}
  return true;
}

// pi's command palette for a cwd: extension commands, prompt templates,
// and skills, straight from pi's own runtime. A short-lived --no-session
// process keeps this safe on conversations a terminal owns (no session
// file is bound, nothing is written).
async function piListCommands(target) {
  return piRpcOperation(
    { cwd: target.cwd, env: target.env, discoverExtensions: true, extraArgs: ['--no-session', ...(target.extraArgs || [])] },
    async request => {
      const r = await request({ type: 'get_commands' });
      return ((r.data || {}).commands || []).map(c => ({
        name: String(c.name || '').replace(/^\//, ''),
        description: c.description || '',
        source: c.source || '',
      })).filter(c => c.name);
    },
    45000,
  );
}

// Verify the bridge command is registered BEFORE sending it as a prompt.
// An unregistered command would go to the model as a real prompt: it would
// cost money and pollute the session we are operating on.
async function piBridgeHandshake(request) {
  const commands = await request({ type: 'get_commands' });
  const names = ((commands.data || {}).commands || []).map(c => String(c.name || '').replace(/^\//, ''));
  if (!names.includes('chattering-fork-at')) {
    throw new Error('The Chattering bridge extension did not load; refusing to send bridge commands.');
  }
}

async function piSessionFileOf(request) {
  const state = await request({ type: 'get_state' });
  return {
    file: state.data && state.data.sessionFile || null,
    sessionId: state.data && state.data.sessionId || null,
  };
}

// Fork THROUGH a node (the fork keeps the node), via the bridge extension:
// ctx.fork(entryId, { position: "at" }) → SessionManager.createBranchedSession.
async function piForkAt(target, nodeId) {
  return piRpcOperation(target, async request => {
    await piBridgeHandshake(request);
    const before = await piSessionFileOf(request);
    await request({ type: 'prompt', message: '/chattering-fork-at ' + nodeId });
    // The prompt response only means "accepted". Completion is observed as
    // pi's runtime replacing the active session with the new fork file.
    const deadline = Date.now() + 30000;
    for (;;) {
      const now = await piSessionFileOf(request);
      if (now.file && now.file !== before.file) return now;
      if (Date.now() > deadline) throw new Error('The fork did not complete.');
      await new Promise(r => setTimeout(r, 150));
    }
  });
}

// Fork BEFORE a user message (pi's native RPC fork). The new session stops
// before that message; pi returns its text so the UI can prefill the composer
// for an edit-and-resubmit flow.
async function piForkBefore(target, nodeId) {
  return piRpcOperation(target, async request => {
    const before = await piSessionFileOf(request);
    const forked = await request({ type: 'fork', entryId: nodeId });
    if (forked.data && forked.data.cancelled) throw new Error('The fork was cancelled.');
    const now = await piSessionFileOf(request);
    if (!now.file || now.file === before.file) throw new Error('The fork did not complete.');
    return { ...now, text: (forked.data && forked.data.text) || '' };
  });
}

// Set the session's reasoning (thinking) level through pi's own runtime.
// pi writes its native thinking_level_change entry, so resumes, branches,
// and forks inherit it. level 'cycle' steps to the next available level.
async function piSetThinking(target, level) {
  await ensurePiProtocol(target.env);
  const w = getWarmSession({ ...target, discoverExtensions: true });
  clearTimeout(w.idleTimer);
  try {
    const avail = await w.sess.request({ type: 'get_available_thinking_levels' });
    const levels = (avail.data && avail.data.levels) || [];
    if (levels.length <= 1) throw new Error('This model has no reasoning control.');
    if (level === 'cycle') await w.sess.request({ type: 'cycle_thinking_level' });
    else await w.sess.request({ type: 'set_thinking_level', level });
    const state = await w.sess.request({ type: 'get_state' });
    return { level: (state.data && state.data.thinkingLevel) || level, levels };
  } finally {
    // pi persisted its thinking_level_change entry: this is the new baseline.
    w.fileSig = fileSigOf(warmKey(target.sessionPath));
    armWarmIdle(w, target.sessionPath);
  }
}

// Compact through pi's own runtime (the RPC `compact` command), as /compact
// in the terminal. No timeout: summarizing a long conversation takes a while.
async function piCompact(target, instructions) {
  await ensurePiProtocol(target.env);
  const w = getWarmSession({ ...target, discoverExtensions: true });
  clearTimeout(w.idleTimer);
  if (w.busy) throw new Error('This conversation is busy. Wait for the reply to finish, then compact.');
  w.busy = true;
  try {
    const out = await w.sess.request({ type: 'compact', ...(instructions ? { customInstructions: instructions } : {}) });
    const r = out.data || {};
    return { tokensBefore: r.tokensBefore ?? null, tokensAfter: r.estimatedTokensAfter ?? null };
  } finally {
    w.busy = false;
    w.fileSig = fileSigOf(warmKey(target.sessionPath));
    armWarmIdle(w, target.sessionPath);
  }
}

// Queue a message into a run that is ALREADY STREAMING on the warm process.
// pi's own runtime queues it (streamingBehavior): "followUp" waits for the
// current turn, "steer" interrupts after the current step. agent_settled of
// the original run fires only after queued continuations finish, so the
// existing job keeps covering the whole exchange.
async function piQueuePrompt(target, message, behavior, images) {
  const key = warmKey(target.sessionPath);
  const w = warmSessions.get(key);
  if (!w || !w.sess.alive || !w.busy) return false;
  const cmd = { type: 'prompt', message, streamingBehavior: behavior || 'followUp' };
  if (Array.isArray(images) && images.length) cmd.images = images;
  await w.sess.request(cmd);
  return true;
}

// A run is "stalled" only when pi emits nothing while waiting for the model
// (see stallwatch.js). Wall-clock timeouts killed legitimate long runs; the
// TUI has no timeout at all, and a tool that is still executing (a quiet
// build, a training job) is legitimate silence. There is deliberately NO
// absolute cap: the agents view lists every process and the user kills
// runs there.
const { createStallWatch } = require('./stallwatch.js');
// An extension dialog with no own timeout gets cancelled after this long.
const DIALOG_MAX_MS = 30 * 60 * 1000;
const DIALOG_METHODS = ['confirm', 'select', 'input', 'editor'];

// One headless prompt on a WARM rpc process. Follow-ups reuse the process.
// Idle timeout (5 min) kills it. Extension dialogs (confirm/select/input/
// editor) are forwarded through onEvent; the owner answers them with
// handle.respondUi(id, resp). Unanswered dialogs are cancelled after
// DIALOG_MAX_MS (pi handles dialogs that carry their own timeout).
// Returns { done, abort, respondUi, uiAutoCancelled, pid }.
function piHeadlessRun(target, opts) {
  const handle = { abort: null, done: null, respondUi: null, uiAutoCancelled: 0, pid: null };
  const key = warmKey(target.sessionPath);
  // Eager spawn hides startup latency; the freshness check runs again inside
  // work(), at the moment this run actually starts.
  handle.pid = getWarmSession({ ...target, discoverExtensions: true }).sess.pid;
  const work = async () => {
    await ensurePiProtocol(target.env);
    const w = getWarmSession({ ...target, discoverExtensions: true });
    handle.pid = w.sess.pid;
    if (!w.sess.alive) throw new Error('pi RPC process is gone.');
    clearTimeout(w.idleTimer);
    w.busy = true;
    const pendingUi = new Map(); // dialog id → { timer }
    const stall = createStallWatch({ stallMs: opts.stallMs, hasPendingUi: () => pendingUi.size > 0 });
    handle.runningTools = () => stall.runningTools;
    const dropDialog = id => {
      const p = pendingUi.get(id);
      if (!p) return;
      pendingUi.delete(id);
      clearTimeout(p.timer);
    };
    const cancelDialog = id => {
      if (!pendingUi.has(id)) return;
      dropDialog(id);
      handle.uiAutoCancelled++;
      w.sess.send({ type: 'extension_ui_response', id, cancelled: true });
    };
    handle.respondUi = (id, resp) => {
      if (!pendingUi.has(id)) return false;
      dropDialog(id);
      w.sess.send({ type: 'extension_ui_response', id, ...resp });
      return true;
    };
    const onEvent = event => {
      stall.note(event);
      if (event.type === 'extension_ui_request' && event.id && DIALOG_METHODS.includes(event.method)) {
        // Dialogs with their own timeout are auto-resolved by pi; just track
        // them until expiry so a late answer is ignored. Dialogs without one
        // would block forever, so Chattering cancels them after DIALOG_MAX_MS.
        const timer = event.timeout
          ? setTimeout(() => dropDialog(event.id), event.timeout + 2000)
          : setTimeout(() => cancelDialog(event.id), DIALOG_MAX_MS);
        pendingUi.set(event.id, { timer });
      }
      if (opts.onEvent) opts.onEvent(event);
    };
    w.sess.setOnEvent(onEvent);
    handle.abort = async () => { try { await w.sess.request({ type: 'abort' }); } catch {} };
    try {
      const want = opts.provider && opts.modelId ? opts.provider + '/' + opts.modelId : null;
      if (want && w.model !== want) {
        await w.sess.request({ type: 'set_model', provider: opts.provider, modelId: opts.modelId });
        w.model = want;
      }
      // A reasoning level asked for with this prompt (see pisdk-runtime.js).
      if (opts.thinking) {
        try { await w.sess.request({ type: 'set_thinking_level', level: opts.thinking }); }
        catch (e) { onEvent({ type: 'run_note', text: 'could not set the reasoning level: ' + e.message }); }
      }
      let isSettled = false;
      const settled = w.sess.waitFor(e => e.type === 'agent_settled');
      settled.then(() => { isSettled = true; }, () => {});
      const promptCmd = { type: 'prompt', message: opts.message };
      if (Array.isArray(opts.images) && opts.images.length) promptCmd.images = opts.images;
      await w.sess.request(promptCmd);
      const stalled = stall.watch().catch(e => { throw new Error(e.message + piVersionHint()); });
      stalled.catch(() => {});
      try {
        await Promise.race([settled, stalled]);
      } catch (e) {
        // A stopped run must actually stop: ask pi to abort, give it a
        // moment to settle and save partial output, then hard-kill if it
        // does not respond. Without this the process kept working and the
        // idle timer later killed it mid-run with no visible reason.
        try { await w.sess.request({ type: 'abort' }); } catch {}
        await Promise.race([settled.catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
        if (!isSettled) { try { w.sess.kill(); } catch {} }
        throw e;
      }
      return { uiAutoCancelled: handle.uiAutoCancelled, pid: w.sess.pid, warm: true };
    } finally {
      stall.stop();
      handle.runningTools = null;
      // Unanswered dialogs must not block the (still warm) extension forever.
      for (const id of [...pendingUi.keys()]) cancelDialog(id);
      w.busy = false;
      w.sess.setOnEvent(null);
      handle.abort = null;
      handle.respondUi = null;
      // The run appended entries: our own writes become the new baseline.
      w.fileSig = fileSigOf(key);
      if (w.sess.alive) armWarmIdle(w, target.sessionPath);
    }
  };
  handle.done = queueOn(key, work);
  return handle;
}

// Start a new pi session in cwd (no --session) and keep the RPC process warm.
async function piBeginWarm(target) {
  await ensurePiProtocol(target.env);
  const sess = spawnPiRpc({ cwd: target.cwd, env: target.env, extraArgs: target.extraArgs || [], discoverExtensions: true });
  const t0 = Date.now();
  let file = null, sessionId = null;
  while (Date.now() - t0 < 15000) {
    try {
      const state = await sess.request({ type: 'get_state' });
      file = state.data && state.data.sessionFile;
      sessionId = state.data && state.data.sessionId;
      if (file) break;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  if (!file) {
    sess.kill();
    throw new Error('pi did not create a session file');
  }
  const key = warmKey(file);
  // The file may not exist until the first prompt lands; a null signature
  // means "no baseline yet" and the freshness check stays quiet.
  const w = { sess, busy: false, idleTimer: null, model: null, fileSig: fileSigOf(key) };
  warmSessions.set(key, w);
  sess.dead.then(() => { if (warmSessions.get(key) === w) warmSessions.delete(key); });
  armWarmIdle(w, file);
  return { file, sessionId, pid: sess.pid };
}

module.exports = { piRpcOperation, piForkAt, piForkBefore, piSetThinking, piCompact, piHeadlessRun, piQueuePrompt, piListCommands, stopWarmSession, stopAllWarmSessions, listWarmSessions, piBeginWarm, ensurePiProtocol, piProtocolInfo };
