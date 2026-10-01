'use strict';
// Codex, driven from Chattering without its terminal screen (design/87),
// through the person's own installed `codex app-server` (JSON-RPC over
// stdio) and its own login.
//
// One app-server process per conversation. Codex allows one writer per
// thread and holds that lock for as long as the process that resumed it
// lives (verified: thread/unsubscribe does not release it). A long-lived
// shared process would lock the Codex app and the Codex terminal out of
// every conversation Chattering ever touched. So each conversation's
// process stays warm for a short while after a reply (quick follow-ups skip
// the resume: 0.15 s start, ~0.7 s for a 15 MB thread) and then exits,
// which releases the lock. release(threadId) exits at once. A thread
// another Codex holds is refused by Codex itself ("already has an active
// writer"); that becomes CODEX_LOCKED, never a second writer.
//
// Menus and file search use one separate process that resumes no thread
// and therefore locks nothing.
//
// A run hands back the handle a Pi run hands back ({ abort, done,
// respondUi, pid }) and emits Pi-shaped events (codex-events.js).

const { spawn } = require('node:child_process');
const { createCodexTranslator, approvalDialog, toApprovalResult, APPROVAL_METHODS } = require('./codex-events.js');

const REQUEST_TIMEOUT_MS = 60 * 1000;
const IDLE_MS = 60 * 1000;
const MAX_BUFFER = 16 * 1024 * 1024;

function lockedError(threadId) {
  const e = new Error('This conversation is open in another Codex (the Codex app or a Codex terminal). Close it there, then send again.');
  e.code = 'CODEX_LOCKED'; e.threadId = threadId; e.status = 409;
  return e;
}

class CodexServer {
  constructor({ bin, env, spawnFn, requestTimeoutMs, name }) {
    this.bin = bin || 'codex';
    this.env = { ...(env || process.env) };
    this.spawnFn = spawnFn || spawn;
    this.requestTimeoutMs = requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.name = name || 'codex';
    this.nextId = 1;
    this.pending = new Map();   // our request id → { resolve, reject, timer, method }
    this.threads = new Map();   // threadId → listener { onEvent, onNotification, onClose }
    this.approvals = new Map(); // dialog id → the server request
    this.buffer = '';
    this.alive = false;
    this.exited = new Promise(r => { this.didExit = r; });
  }

  start() {
    const child = this.spawnFn(this.bin, ['app-server'], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.alive = true;
    this.stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', c => this.onData(c));
    child.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-4000); });
    child.on('error', e => this.onExit(null, e.code === 'ENOENT' ? Object.assign(new Error('Codex is not installed (no `codex` command found).'), { code: 'CODEX_MISSING' }) : e));
    child.stdin.on('error', e => { this.onExit(null, e); this.kill(); });
    child.on('exit', code => this.onExit(code));
    this.ready = this.request('initialize', { clientInfo: { name: 'chattering', title: 'Chattering', version: '1' } })
      .then(r => { this.notify('initialized'); this.info = r; return r; })
      .catch(e => { this.kill(); throw e; });
    this.ready.catch(() => {});
    return this.ready;
  }

  kill() { try { this.child.kill('SIGTERM'); } catch {} }

  onExit(code, error) {
    if (!this.alive) return;
    this.alive = false;
    clearTimeout(this.idleTimer); clearTimeout(this.termTimer); clearTimeout(this.killTimer);
    const why = error || new Error('Codex stopped' + (code != null ? ' (code ' + code + ')' : '') + (this.stderr ? ': ' + this.stderr.trim().split('\n').pop() : ''));
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(why); }
    this.pending.clear(); this.approvals.clear();
    for (const l of this.threads.values()) l.onClose(why);
    this.threads.clear();
    this.didExit();
    if (this.onGone) this.onGone(this);
  }

  send(obj) {
    if (!this.alive) throw new Error('Codex is not running.');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); }
  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const e = new Error('Codex did not answer ' + method); e.unknownDelivery = true; reject(e);
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFER) { this.onExit(null, new Error('A Codex message exceeded the size limit.')); this.kill(); return; }
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch (e) { this.onExit(null, new Error('Codex sent something unreadable: ' + e.message)); this.kill(); return; }
      this.onMessage(msg);
    }
  }

  onMessage(msg) {
    if (msg.id != null && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = new Error(msg.error.message || p.method + ' failed');
        e.rpcCode = msg.error.code;
        p.reject(e);
      } else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'serverRequest/resolved') {
      for (const [id, ask] of this.approvals) if (ask.id === (msg.params && msg.params.requestId)) this.approvals.delete(id);
    }
    const threadId = msg.params && (msg.params.threadId || (msg.params.thread && msg.params.thread.id));
    const listener = threadId && this.threads.get(threadId);
    if (msg.id != null && msg.method) {
      if (APPROVAL_METHODS.has(msg.method) && listener) {
        const dialog = approvalDialog(msg);
        this.approvals.set(dialog.id, msg);
        listener.onEvent(dialog);
      } else if (APPROVAL_METHODS.has(msg.method)) {
        this.send(toApprovalResult(msg, { cancelled: true })); // nobody to ask: no permission
      } else {
        this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Chattering does not handle ' + msg.method + ' yet.' } });
      }
      return;
    }
    if (listener) listener.onNotification(msg);
    else if (msg.method === 'account/rateLimits/updated') for (const l of this.threads.values()) l.onNotification(msg);
  }

  answerApproval(id, answer) {
    const request = this.approvals.get(id);
    if (!request || !this.alive) return false;
    this.approvals.delete(id);
    this.send(toApprovalResult(request, answer));
    return true;
  }

  // Close stdin (Codex exits cleanly), then escalate.
  stop(shutdownMs = 3000) {
    if (!this.alive || this.stopping) return this.exited;
    this.stopping = true;
    try { this.child.stdin.end(); } catch {}
    this.termTimer = setTimeout(() => this.kill(), shutdownMs);
    this.killTimer = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch {} }, shutdownMs * 2);
    this.termTimer.unref?.(); this.killTimer.unref?.();
    return this.exited;
  }
}

const sameEnv = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function createCodexDriver(hooks = {}) {
  const idleMs = hooks.idleMs ?? IDLE_MS;
  const conversations = new Map(); // threadId → CodexServer holding that thread
  const claims = new Set();        // threadIds with a send in progress
  const uncertain = new Set();     // stop/start not confirmed: never send another turn blindly
  let utility = null;              // menus and file search: holds no thread

  function newServer(target, name) {
    if (target.sandbox && typeof target.sandbox === 'object') throw new Error('Codex does not run inside a guest\'s walls yet.');
    const srv = new CodexServer({ bin: target.bin, env: target.env, spawnFn: hooks.spawn, requestTimeoutMs: hooks.requestTimeoutMs, name });
    srv.start();
    return srv;
  }
  function armIdle(threadId, srv) {
    clearTimeout(srv.idleTimer);
    srv.idleTimer = setTimeout(() => { if (conversations.get(threadId) === srv && !srv.threads.size) release(threadId); }, idleMs);
    srv.idleTimer.unref?.();
  }
  // Exit a conversation's process now: its Codex lock is freed.
  function release(threadId) {
    const srv = conversations.get(threadId);
    if (!srv) return Promise.resolve(false);
    if (srv.threads.size) return Promise.reject(Object.assign(new Error('Codex is answering in this conversation. Stop it first.'), { status: 409 }));
    conversations.delete(threadId);
    return srv.stop(hooks.shutdownMs).then(() => true);
  }
  function busy(threadId) { return claims.has(threadId) || !!(conversations.get(threadId) && conversations.get(threadId).threads.size); }

  // Open a thread in its own process: resume an existing one (reapplying the
  // requested model/access: resume is also how Codex takes new settings),
  // or start a new one.
  async function openThread(target) {
    let srv = target.threadId && conversations.get(target.threadId);
    if (srv && (!srv.alive || srv.stopping || srv.bin !== (target.bin || 'codex') || !sameEnv(srv.env, { ...(target.env || process.env) }))) {
      conversations.delete(target.threadId); await srv.stop(hooks.shutdownMs); srv = null;
    }
    if (!srv) srv = newServer(target, 'codex:' + (target.threadId || 'new'));
    clearTimeout(srv.idleTimer);
    await srv.ready;
    const common = { cwd: target.cwd, ...(target.model ? { model: target.model } : {}), ...(target.sandboxMode ? { sandbox: target.sandboxMode } : {}), ...(target.approvalPolicy ? { approvalPolicy: target.approvalPolicy } : {}) };
    let r;
    try {
      r = target.threadId
        ? await srv.request('thread/resume', { threadId: target.threadId, excludeTurns: true, ...common })
        : await srv.request('thread/start', { ...common, ...(target.developerInstructions ? { developerInstructions: target.developerInstructions } : {}) });
    } catch (e) {
      if (/already has an active writer/i.test(e.message)) { await srv.stop(hooks.shutdownMs); throw lockedError(target.threadId); }
      if (!target.threadId || !conversations.has(target.threadId)) srv.stop(hooks.shutdownMs);
      throw e;
    }
    const id = r.thread.id;
    conversations.set(id, srv);
    srv.onGone = s => { if (conversations.get(id) === s) conversations.delete(id); };
    return { srv, threadId: id, model: r.model || target.model || null, effort: r.reasoningEffort || null, path: r.thread.path || null, thread: r.thread };
  }

  // One message on a Codex conversation, as a Pi-compatible run.
  // target: { threadId (existing) or none (new), cwd, env, bin, model, effort,
  // sandboxMode, approvalPolicy, developerInstructions (new threads) }.
  // opts.onThread({ threadId, path }) fires once the thread exists.
  function codexHeadlessRun(target, { message, images, onEvent, onThread } = {}) {
    const handle = { abort: null, done: null, respondUi: null, uiAutoCancelled: 0, pid: null, engine: 'codex' };
    let srv = null, threadId = target.threadId || null, turnId = null, aborted = false, finishedRun = false, stopTimer = null;
    handle.respondUi = (id, answer) => {
      const ask = srv && srv.approvals.get(id);
      return !finishedRun && !aborted && !!ask && ask.params && ask.params.threadId === threadId && srv.answerApproval(id, answer);
    };
    async function interruptCurrent() {
      if (!srv || !threadId || !turnId || finishedRun) return;
      for (const [id, ask] of [...srv.approvals]) if (ask.params && ask.params.threadId === threadId) srv.answerApproval(id, { cancelled: true });
      if (!stopTimer) {
        stopTimer = setTimeout(() => {
          if (finishedRun) return;
          uncertain.add(threadId);
          const l = srv.threads.get(threadId);
          if (l) l.onClose(new Error('Codex did not confirm stopping. This conversation waits until Codex confirms the reply ended.'));
        }, hooks.abortTimeoutMs ?? 5000);
      }
      await srv.request('turn/interrupt', { threadId, turnId });
    }
    handle.abort = async () => {
      aborted = true;
      if (finishedRun || !srv || !turnId) return; // startup sees the abort before sending
      await Promise.race([interruptCurrent().then(() => handle.done), handle.done]);
    };
    handle.done = (async () => {
      if (threadId && uncertain.has(threadId)) throw new Error('Codex has not confirmed that the previous reply ended. Wait a moment, or restart Chattering\'s Codex connection.');
      if (threadId && busy(threadId)) throw new Error('Codex is already answering in this conversation.');
      const claimed = threadId;
      if (claimed) claims.add(claimed);
      try {
        const opened = await openThread(target);
        srv = opened.srv; threadId = opened.threadId; handle.pid = srv.child && srv.child.pid;
        if (onThread) { try { onThread({ threadId, path: opened.path, model: opened.model }); } catch {} }
        // Items handed to the model before this message (attached context
        // that changed since it was last given): model-visible, and kept in
        // the thread like everything Codex saw.
        if (Array.isArray(target.injectItems) && target.injectItems.length && !aborted) await srv.request('thread/inject_items', { threadId, items: target.injectItems });
        // Stopped before anything was sent: let go of the lock at once.
        if (aborted) { await release(threadId).catch(() => {}); return { aborted: true, threadId, pid: handle.pid }; }
        const translator = createCodexTranslator({ model: target.model || opened.model || null });
        translator.info.threadId = threadId;
        const emit = e => { try { onEvent && onEvent(e); } catch {} };
        let ended = false;
        const finished = new Promise((resolve, reject) => {
          srv.threads.set(threadId, {
            onEvent: emit,
            onNotification: msg => {
              if (msg.method === 'turn/started' && msg.params.turn) turnId = msg.params.turn.id;
              // Another client's turn on this thread (none should exist:
              // Codex's lock makes us the only writer) is not ours to show.
              if (turnId && msg.params && msg.params.turnId && msg.params.turnId !== turnId) return;
              for (const e of translator.push(msg)) emit(e);
              if (msg.method === 'turn/completed' && (!turnId || !msg.params.turn || msg.params.turn.id === turnId)) { ended = true; uncertain.delete(threadId); resolve(msg.params.turn || {}); }
            },
            onClose: reject,
          });
        });
        finished.catch(() => {});
        emit({ type: 'harness_info', harness: 'codex', threadId, model: translator.info.model, path: opened.path });
        try {
          const input = [{ type: 'text', text: String(message || ''), text_elements: [] }];
          for (const img of images || []) if (img && img.data) input.push({ type: 'image', url: 'data:' + (img.mimeType || 'image/png') + ';base64,' + img.data });
          const started = await Promise.race([
            srv.request('turn/start', { threadId, input, ...(target.model ? { model: target.model } : {}), ...(target.effort ? { effort: target.effort } : {}) }),
            finished.then(turn => ({ turn })),
          ]);
          // The turn/started notice can be handled before this reply's
          // continuation runs: never replace the id Codex already announced.
          if (started && started.turn && !turnId) turnId = started.turn.id;
          if (aborted && turnId && !ended) await Promise.race([interruptCurrent(), finished]);
          const turn = await finished;
          return { threadId, turnId: turn.id || turnId, status: turn.status || null, aborted, pid: handle.pid, path: opened.path };
        } catch (error) {
          if (error.unknownDelivery && srv.alive && !ended) uncertain.add(threadId);
          throw error;
        } finally {
          srv.threads.delete(threadId);
          for (const [id, ask] of [...srv.approvals]) if (ask.params && ask.params.threadId === threadId) srv.approvals.delete(id);
          if (srv.alive && conversations.get(threadId) === srv) armIdle(threadId, srv);
        }
      } finally { if (claimed) claims.delete(claimed); }
    })().finally(() => { finishedRun = true; clearTimeout(stopTimer); });
    handle.done.catch(() => {});
    return handle;
  }

  // Codex's own fork (thread/fork): a new conversation through a turn of
  // this one. Codex refers to the original's history rather than copying
  // it; only conversations with saved turn ids (Codex 0.150+) can fork at a
  // chosen turn. The new thread's process exits at once: nothing holds it.
  async function forkThread(target, lastTurnId) {
    const srv = newServer(target, 'codex:fork');
    try {
      await srv.ready;
      const r = await srv.request('thread/fork', { threadId: target.threadId, excludeTurns: true, cwd: target.cwd, ...(lastTurnId ? { lastTurnId } : {}) });
      return { threadId: r.thread.id, path: r.thread.path || null, forkedFromId: r.thread.forkedFromId || target.threadId };
    } catch (e) {
      if (/not a persisted canonical turn/i.test(e.message)) throw Object.assign(new Error('This conversation comes from an older Codex that did not save its turns, so it cannot fork at a chosen message. It can still continue from its newest message.'), { status: 409 });
      throw e;
    } finally { srv.stop(hooks.shutdownMs); }
  }

  // Codex's own compaction of a thread (what /compact does in its terminal).
  async function compactThread(target) {
    if (busy(target.threadId)) throw new Error('Codex is answering in this conversation. Wait for it, then compact.');
    claims.add(target.threadId);
    try {
      const { srv, threadId } = await openThread(target);
      const done = new Promise((resolve, reject) => {
        srv.threads.set(threadId, { onEvent() {}, onClose: reject, onNotification: m => { if (m.method === 'thread/compacted' || m.method === 'turn/completed') resolve(m.params); } });
      });
      try { await srv.request('thread/compact/start', { threadId }); return await done; }
      finally { srv.threads.delete(threadId); armIdle(threadId, srv); }
    } finally { claims.delete(target.threadId); }
  }

  function utilityServer(target) {
    if (utility && (!utility.alive || utility.stopping || !sameEnv(utility.env, { ...(target.env || process.env) }) || utility.bin !== (target.bin || 'codex'))) { utility.stop(hooks.shutdownMs); utility = null; }
    if (!utility) { utility = newServer(target, 'codex:utility'); const u = utility; u.onGone = () => { if (utility === u) utility = null; }; }
    clearTimeout(utility.idleTimer);
    const u = utility;
    u.idleTimer = setTimeout(() => { if (utility === u) { utility = null; u.stop(hooks.shutdownMs); } }, hooks.utilityIdleMs ?? 5 * 60 * 1000);
    u.idleTimer.unref?.();
    return u;
  }

  // The compose box's menus, straight from Codex (no model call, no lock).
  async function codexMenus(target) {
    const srv = utilityServer(target);
    await srv.ready;
    const ask = (m, p) => srv.request(m, p).catch(e => ({ error: e.message }));
    const [models, account, limits, skills] = await Promise.all([
      ask('model/list', {}), ask('account/read', {}), ask('account/rateLimits/read', {}), ask('skills/list', { cwds: [target.cwd] }),
    ]);
    return { models, account, limits, skills, version: srv.info && srv.info.userAgent ? srv.info.userAgent : null };
  }

  // Codex's own fuzzy file search, for "@query".
  async function codexFileSuggestions(target, query) {
    const srv = utilityServer(target);
    await srv.ready;
    return srv.request('fuzzyFileSearch', { query: String(query || ''), roots: [target.cwd] });
  }

  function stopCodex() {
    for (const [threadId, srv] of [...conversations]) { conversations.delete(threadId); srv.stop(hooks.shutdownMs); }
    if (utility) { utility.stop(hooks.shutdownMs); utility = null; }
  }
  function holding() { return [...conversations.entries()].map(([threadId, s]) => ({ threadId, pid: s.child && s.child.pid, busy: s.threads.size > 0 })); }

  return { codexHeadlessRun, compactThread, forkThread, codexMenus, codexFileSuggestions, release, busy, holding, stopCodex };
}

module.exports = { ...createCodexDriver(), createCodexDriver, lockedError };
