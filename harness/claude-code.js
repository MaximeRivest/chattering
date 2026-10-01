'use strict';
// Claude Code, driven from Chattering without its terminal screen
// (design/87). One `claude -p` process per open conversation, speaking
// stream-json both ways and the control protocol of Anthropic's own Agent
// SDK: `initialize` (menus), `can_use_tool` (approvals, answered from the
// run card), `interrupt`, `set_model`, `set_permission_mode`,
// `file_suggestions` (Claude Code's own @ completion). The person's own
// installed `claude` and its login are used; Chattering adds no dependency.
//
// A run hands back the handle a Pi run hands back ({ abort, done,
// respondUi, pid }) and emits Pi-shaped events (claude-events.js), so the
// rest of Chattering treats both alike.

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { createClaudeTranslator, permissionDialog, toPermissionResponse } = require('./claude-events.js');

const IDLE_MS = 10 * 60 * 1000;
const CONTROL_TIMEOUT_MS = 30 * 1000;
function createClaudeDriver(hooks = {}) {
const sessions = new Map(); // key → ClaudeSession; a driver belongs to one security scope
const claims = new Set();

function claudeArgs({ sessionId, resume, model, effort, permissionMode, extraArgs = [] }) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
  if (resume) args.push('--resume', resume);
  else if (sessionId) args.push('--session-id', sessionId);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (permissionMode) args.push('--permission-mode', permissionMode);
  return args.concat(extraArgs);
}

// Chattering's images ({ data, mimeType }) as Anthropic content blocks.
function userContent(message, images) {
  const content = [];
  for (const img of images || []) {
    if (img && img.data) content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType || 'image/png', data: img.data } });
  }
  content.push({ type: 'text', text: String(message || '') });
  return content;
}

class ClaudeSession {
  constructor(key, target) {
    this.key = key;
    this.target = target; // { bin, cwd, env, sessionId, resume, model, effort, permissionMode, extraArgs }
    this.pending = new Map(); // control request id → { resolve, reject, timer }
    this.permissions = new Map(); // dialog id → the can_use_tool request
    this.run = null;          // the run in progress: { onEvent, translator, resolve, reject }
    this.menus = null;
    this.buffer = '';
    this.alive = false;
    this.idleTimer = null;
    this.closing = false;
    this.exited = new Promise(resolve => { this.didExit = resolve; });
  }

  start() {
    const t = this.target;
    const child = (hooks.spawn || spawn)(t.bin || 'claude', claudeArgs(t), { cwd: t.cwd, env: t.env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.alive = true;
    this.stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.onData(chunk));
    child.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-4000); });
    child.on('error', e => this.onExit(null, e));
    child.stdin.on('error', e => { this.failRun(e); this.stop(); });
    child.on('exit', code => this.onExit(code));
    this.ready = this.control('initialize', {}).then(r => { this.menus = r; return r; }).catch(e => { this.stop(); throw e; });
    return this.ready;
  }

  onExit(code, error) {
    if (!this.alive) return;
    this.alive = false;
    clearTimeout(this.idleTimer); clearTimeout(this.termTimer); clearTimeout(this.killTimer);
    this.didExit(); this.permissions.clear();
    const why = error ? error.message : 'Claude Code exited' + (code != null ? ' (code ' + code + ')' : '') + (this.stderr ? ': ' + this.stderr.trim().split('\n').pop() : '');
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(why)); }
    this.pending.clear();
    if (this.run) { const r = this.run; this.run = null; r.reject(new Error(why)); }
    if (sessions.get(this.key) === this) sessions.delete(this.key);
  }

  write(obj) {
    if (!this.alive) throw new Error('Claude Code is not running.');
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  control(subtype, fields = {}) {
    const request_id = 'ch-' + crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(request_id); reject(new Error('Claude Code did not answer ' + subtype)); }, hooks.controlTimeoutMs ?? CONTROL_TIMEOUT_MS);
      this.pending.set(request_id, { resolve, reject, timer });
      try { this.write({ type: 'control_request', request_id, request: { subtype, ...fields } }); }
      catch (e) { clearTimeout(timer); this.pending.delete(request_id); reject(e); }
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 16 * 1024 * 1024) { this.failRun(new Error('Claude Code record exceeded the size limit')); this.stop(); return; }
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); this.onRecord(record); }
      catch (e) { this.failRun(new Error('Invalid Claude Code stream: ' + e.message)); this.stop(); return; }
    }
  }

  failRun(error) {
    if (this.run) { const r = this.run; this.run = null; r.reject(error); }
  }

  onRecord(record) {
    if (record.type === 'control_cancel_request') { this.permissions.delete(record.request_id); return; }
    if (record.type === 'control_response' && record.response) {
      const p = this.pending.get(record.response.request_id);
      if (!p) return;
      this.pending.delete(record.response.request_id);
      clearTimeout(p.timer);
      if (record.response.subtype === 'error') p.reject(new Error(record.response.error || 'Claude Code refused the request'));
      else p.resolve(record.response.response || {});
      return;
    }
    if (record.type === 'control_request' && record.request) {
      if (record.request.subtype === 'can_use_tool') {
        const dialog = permissionDialog(record);
        this.permissions.set(dialog.id, record);
        if (this.run) this.run.onEvent(dialog);
        else this.answerPermission(dialog.id, { cancelled: true });
      } else {
        // Hooks, MCP bridges and dialogs Chattering does not host yet: say so,
        // so Claude Code never waits on a question nobody will answer.
        this.write({ type: 'control_response', response: { subtype: 'error', request_id: record.request_id, error: 'Chattering does not handle ' + record.request.subtype + ' yet.' } });
      }
      return;
    }
    if (!this.run) return;
    for (const event of this.run.translator.push(record)) this.run.onEvent(event);
    if (record.type === 'result') {
      const r = this.run;
      this.run = null;
      this.permissions.clear();
      r.resolve({ sessionId: record.session_id || null, cost: record.total_cost_usd ?? null });
      this.armIdle();
    }
  }

  answerPermission(id, answer) {
    const request = this.permissions.get(id);
    if (!request || !this.run || this.closing || !this.alive) return false;
    this.permissions.delete(id);
    this.write(toPermissionResponse(request, answer));
    return true;
  }

  armIdle() {
    clearTimeout(this.idleTimer);
    if (this.closing) return;
    this.idleTimer = setTimeout(() => this.stop(), hooks.idleMs ?? IDLE_MS);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  stop() {
    clearTimeout(this.idleTimer);
    if (!this.alive || this.closing) return;
    this.closing = true;
    this.permissions.clear();
    try { this.child.stdin.end(); } catch {}
    const child = this.child;
    this.termTimer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, hooks.shutdownMs ?? 3000);
    this.killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, (hooks.shutdownMs ?? 3000) * 2);
    this.termTimer.unref?.(); this.killTimer.unref?.();
  }
}

async function sessionFor(key, target) {
  let s = sessions.get(key);
  // A different model or effort starts a fresh process on the same
  // conversation: both are fixed at launch. (set_model exists, but a
  // restart also picks up a changed CLAUDE.md, settings or skills.)
  if (s && s.alive && (s.closing || s.target.model !== target.model || s.target.effort !== target.effort || s.target.cwd !== target.cwd ||
    s.target.permissionMode !== target.permissionMode || s.target.bin !== target.bin || (s.target.resume || s.target.sessionId) !== (target.resume || target.sessionId) ||
    JSON.stringify(s.target.env) !== JSON.stringify(target.env) || JSON.stringify(s.target.extraArgs) !== JSON.stringify(target.extraArgs))) {
    s.stop(); await s.exited; s = null;
  }
  if (!s || !s.alive) {
    s = new ClaudeSession(key, target);
    sessions.set(key, s);
    s.start().catch(() => {});
  }
  return s;
}

// One message on a Claude Code conversation, as a Pi-compatible run.
// target: { key, cwd, env, bin, sessionId (existing conversation's id) or
// newSessionId, model, effort, permissionMode, extraArgs }.
function claudeHeadlessRun(target, { message, images, onEvent }) {
  const handle = { abort: null, done: null, respondUi: null, uiAutoCancelled: 0, pid: null };
  let s = null, finished = false, aborted = false;
  handle.respondUi = (id, answer) => !finished && !aborted && !!s?.answerPermission(id, answer);
  handle.abort = async () => {
    aborted = true;
    if (finished || !s?.run) return;
    for (const id of [...s.permissions.keys()]) s.answerPermission(id, { cancelled: true });
    const timer = setTimeout(() => s.stop(), hooks.abortTimeoutMs ?? 5000);
    timer.unref?.();
    handle.done.finally(() => clearTimeout(timer)).catch(() => {});
    try { await Promise.race([s.control('interrupt', { cancel_queued: true }).then(() => handle.done), handle.done]); }
    catch (error) { s.stop(); throw error; }
  };
  handle.done = (async () => {
    if (!target.key || target.sandbox) throw new Error('Claude driver needs an owner-scoped conversation key; sandboxed launches are not wired yet');
    if (claims.has(target.key)) throw new Error('Claude Code is already answering in this conversation.');
    claims.add(target.key);
    try {
    s = await sessionFor(target.key, {
      bin: target.bin, cwd: target.cwd, env: { ...(target.env || process.env) }, model: target.model || null, effort: target.effort || null,
      permissionMode: target.permissionMode || null, extraArgs: target.extraArgs || [],
      resume: target.sessionId || null, sessionId: target.sessionId ? null : (target.newSessionId || null),
    });
    handle.pid = s.child && s.child.pid;
    await s.ready;
    if (aborted) { s.armIdle(); return { aborted: true, pid: handle.pid }; }
    if (s.run) throw new Error('Claude Code is already answering in this conversation.');
    const result = new Promise((resolve, reject) => {
      s.run = { onEvent: e => { try { onEvent && onEvent(e); } catch {} }, translator: createClaudeTranslator(), resolve, reject };
    });
    clearTimeout(s.idleTimer);
    try { s.write({ type: 'user', message: { role: 'user', content: userContent(message, images) } }); }
    catch (e) { s.failRun(e); s.stop(); }
    const out = await result;
    return { ...out, aborted, pid: s.child.pid, warm: true };
    } finally { claims.delete(target.key); }
  })().finally(() => { finished = true; });
  return handle;
}

// The compose box's menus, straight from Claude Code (no model call):
// commands, helper agents, models, answer styles, the plan.
async function claudeMenus(target) {
  if (target.sandbox) throw new Error('Sandboxed Claude menus are not wired yet');
  const live = target.key && sessions.get(target.key);
  if (live && live.alive && !live.closing && live.menus) return live.menus;
  const s = new ClaudeSession('menus:' + target.cwd, { bin: target.bin, cwd: target.cwd, env: target.env, extraArgs: ['--no-session-persistence'] });
  try { return await s.start(); } finally { s.stop(); }
}

// Claude Code's own file suggestions for "@query", from a live session.
async function claudeFileSuggestions(key, query) {
  const s = sessions.get(key);
  if (!s || !s.alive) return null;
  await s.ready;
  return s.control('file_suggestions', { query: String(query || '') });
}

async function claudeControl(key, subtype, fields) {
  const s = sessions.get(key);
  if (!s || !s.alive) throw new Error('This Claude Code conversation is not running.');
  await s.ready;
  return s.control(subtype, fields);
}

function stopAllClaudeSessions() { for (const s of sessions.values()) s.stop(); }
function claudeSessionAlive(key) { const s = sessions.get(key); return !!(s && s.alive); }

return { claudeHeadlessRun, claudeMenus, claudeFileSuggestions, claudeControl, stopAllClaudeSessions, claudeSessionAlive, claudeArgs, userContent };
}
module.exports = { ...createClaudeDriver(), createClaudeDriver };
