#!/usr/bin/env node
'use strict';
// A stand-in for `codex app-server` in tests: the JSON-RPC shapes recorded
// from Codex 0.153.4 (test/fixtures/harness/codex-appserver-tool.jsonl),
// writing rollout files the way Codex does. No model, no network.
// Behaviour switches (environment):
//   FAKE_CODEX_LOCKED=<threadId>  resume of that thread is refused (another writer)
//   FAKE_CODEX_APPROVE=1          each turn asks to run a command first
//   FAKE_CODEX_SLOW=1             replies wait until interrupted
//   FAKE_CODEX_LOG=<file>         append every request received
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');

if (process.argv[2] !== 'app-server') { process.stderr.write('fake codex: only app-server\n'); process.exit(2); }
const home = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
const threads = new Map(); // id → { path, cwd, model, lines }
let nextServerId = 1000;
const waiting = new Map(); // our server-request id → resolve
const out = obj => process.stdout.write(JSON.stringify(obj) + '\n');
const log = obj => { if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(obj) + '\n'); };
const now = () => new Date().toISOString();
function append(t, type, payload) { fs.mkdirSync(path.dirname(t.path), { recursive: true }); fs.appendFileSync(t.path, JSON.stringify({ timestamp: now(), type, payload }) + '\n'); }
function findRollout(id) {
  const walk = d => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) { const r = walk(p); if (r) return r; } else if (e.name.includes(id)) return p; } return null; };
  return walk(path.join(home, 'sessions'));
}
const thread = (t) => ({ id: t.id, path: t.path, cwd: t.cwd, forkedFromId: null, preview: '', status: { type: 'idle' } });
let current = null; // the running turn { threadId, turnId, interrupted }

async function turn(t, input, params, turnId = crypto.randomUUID()) { // Codex's saved turn ids are UUIDs
  current = { threadId: t.id, turnId, interrupted: false };
  const text = input.filter(i => i.type === 'text').map(i => i.text).join('\n');
  if (!fs.existsSync(t.path)) append(t, 'session_meta', { id: t.id, session_id: t.id, timestamp: now(), cwd: t.cwd, originator: 'chattering', cli_version: '0.0.0-fake', source: 'appServer', model_provider: 'openai' });
  append(t, 'event_msg', { type: 'task_started', turn_id: turnId });
  append(t, 'turn_context', { turn_id: turnId, cwd: t.cwd, model: params.model || t.model, effort: params.effort || 'medium' });
  append(t, 'event_msg', { type: 'user_message', message: text, images: input.filter(i => i.type === 'image').map(i => i.url) });
  out({ method: 'turn/started', params: { threadId: t.id, turn: { id: turnId, status: 'inProgress' } } });
  out({ method: 'item/started', params: { threadId: t.id, turnId, item: { type: 'userMessage', id: 'u-' + turnId, content: [{ type: 'text', text }] } } });
  if (process.env.FAKE_CODEX_APPROVE) {
    const id = nextServerId++;
    out({ id, method: 'item/commandExecution/requestApproval', params: { threadId: t.id, turnId, itemId: 'exec-1', command: 'echo approved-by-fixture', startedAtMs: Date.now() } });
    const decision = await new Promise(r => waiting.set(id, r));
    const accepted = decision && (decision.decision === 'accept' || decision.decision === 'acceptForSession');
    if (accepted) {
      append(t, 'response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'echo approved-by-fixture' }), call_id: 'call-1' });
      out({ method: 'item/started', params: { threadId: t.id, turnId, item: { type: 'commandExecution', id: 'exec-1', command: 'echo approved-by-fixture', commandActions: [{ type: 'unknown', command: 'echo approved-by-fixture' }], status: 'inProgress' } } });
      append(t, 'response_item', { type: 'function_call_output', call_id: 'call-1', output: 'Process exited with code 0\nOutput:\napproved-by-fixture' });
      out({ method: 'item/completed', params: { threadId: t.id, turnId, item: { type: 'commandExecution', id: 'exec-1', command: 'echo approved-by-fixture', commandActions: [{ type: 'unknown', command: 'echo approved-by-fixture' }], aggregatedOutput: 'approved-by-fixture\n', exitCode: 0, status: 'completed' } } });
    }
  }
  if (process.env.FAKE_CODEX_SLOW) await new Promise(r => { const iv = setInterval(() => { if (current.interrupted) { clearInterval(iv); r(); } }, 10); });
  if (current.interrupted) {
    append(t, 'event_msg', { type: 'turn_aborted', reason: 'interrupted' });
    out({ method: 'turn/completed', params: { threadId: t.id, turn: { id: turnId, status: 'interrupted', items: [] } } });
    current = null; return;
  }
  const reply = 'Fake Codex heard: ' + text;
  const itemId = 'msg-' + turnId;
  out({ method: 'item/started', params: { threadId: t.id, turnId, item: { type: 'agentMessage', id: itemId, text: '' } } });
  for (const piece of reply.match(/.{1,8}/g)) out({ method: 'item/agentMessage/delta', params: { threadId: t.id, turnId, itemId, delta: piece } });
  append(t, 'response_item', { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: reply }] });
  out({ method: 'item/completed', params: { threadId: t.id, turnId, item: { type: 'agentMessage', id: itemId, text: reply } } });
  append(t, 'event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 }, last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 }, model_context_window: 100000 } });
  out({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 42, windowDurationMins: 10080 } } } });
  append(t, 'event_msg', { type: 'task_complete', turn_id: turnId });
  out({ method: 'turn/completed', params: { threadId: t.id, turn: { id: turnId, status: 'completed', items: [] } } });
  current = null;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  log(msg);
  if (msg.id != null && !msg.method) { const r = waiting.get(msg.id); if (r) { waiting.delete(msg.id); r(msg.result); } return; }
  const { id, method, params = {} } = msg;
  const reply = result => out({ id, result });
  const fail = message => out({ id, error: { code: -32600, message } });
  if (method === 'initialize') return reply({ userAgent: 'fake-codex/0.0.0' });
  if (method === 'initialized') return;
  if (method === 'thread/start') {
    const tid = '01a0fake-' + crypto.randomUUID().slice(9);
    const d = new Date(); const day = d.toISOString().slice(0, 10).split('-');
    const t = { id: tid, cwd: params.cwd, model: params.model || 'fake-model', path: path.join(home, 'sessions', day[0], day[1], day[2], 'rollout-' + d.toISOString().slice(0, 19).replace(/:/g, '-') + '-' + tid + '.jsonl') };
    threads.set(tid, t);
    if (params.developerInstructions) t.developer = params.developerInstructions;
    out({ method: 'thread/started', params: { thread: thread(t) } });
    return reply({ thread: thread(t), model: t.model, modelProvider: 'openai', cwd: t.cwd, approvalPolicy: params.approvalPolicy || 'never', sandbox: { type: 'dangerFullAccess' } });
  }
  if (method === 'thread/resume') {
    if (process.env.FAKE_CODEX_LOCKED === params.threadId) return fail('thread ' + params.threadId + ' already has an active writer');
    const p = findRollout(params.threadId);
    if (!p) return fail('no rollout found for thread id ' + params.threadId);
    const t = threads.get(params.threadId) || { id: params.threadId, path: p, cwd: params.cwd, model: params.model || 'fake-model' };
    if (params.model) t.model = params.model;
    threads.set(t.id, t);
    return reply({ thread: thread(t), model: t.model, modelProvider: 'openai', cwd: t.cwd, approvalPolicy: params.approvalPolicy || 'never', sandbox: { type: 'dangerFullAccess' } });
  }
  if (method === 'turn/start') {
    const t = threads.get(params.threadId);
    if (!t) return fail('thread not loaded');
    // Codex answers turn/start with the turn it began (its id), and also
    // announces it (turn/started); either can be handled first.
    const turnId = crypto.randomUUID();
    reply({ turn: { id: turnId, status: 'inProgress', items: [] } });
    return turn(t, params.input || [], params, turnId);
  }
  if (method === 'thread/fork') {
    // As Codex 0.153: the new file refers to the original's history before
    // an ordinal (the first line after lastTurnId's turn) instead of copying it.
    const src = findRollout(params.threadId);
    if (!src) return fail('no rollout found for thread id ' + params.threadId);
    const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const ord = (r, i) => Number.isInteger(r.ordinal) ? r.ordinal : i;
    let until = lines.length, seen = false;
    if (params.lastTurnId) {
      if (!lines.some(r => r.payload && r.payload.turn_id === params.lastTurnId)) return fail("lastTurnId '" + params.lastTurnId + "' is not a persisted canonical turn in the source thread");
      for (let i = 0; i < lines.length; i++) {
        const r = lines[i];
        if (r.type === 'event_msg' && r.payload.type === 'task_started') { if (seen) { until = ord(r, i); break; } if (r.payload.turn_id === params.lastTurnId) seen = true; }
      }
    }
    const tid = '01a0fork-' + crypto.randomUUID().slice(9);
    const d = new Date(); const day = d.toISOString().slice(0, 10).split('-');
    const t = { id: tid, cwd: params.cwd, model: 'fake-model', path: path.join(home, 'sessions', day[0], day[1], day[2], 'rollout-' + d.toISOString().slice(0, 19).replace(/:/g, '-') + '-' + tid + '.jsonl') };
    threads.set(tid, t);
    append(t, 'session_meta', { id: tid, session_id: tid, forked_from_id: params.threadId, forked_from_ordinal_exclusive: until, timestamp: now(), cwd: t.cwd, originator: 'chattering', cli_version: '0.0.0-fake', source: 'appServer', model_provider: 'openai' });
    return reply({ thread: { ...thread(t), forkedFromId: params.threadId } });
  }
  if (method === 'thread/inject_items') {
    const t = threads.get(params.threadId);
    if (!t) return fail('thread not loaded');
    for (const item of params.items || []) append(t, 'response_item', item);
    return reply({});
  }
  if (method === 'turn/interrupt') { if (current && current.turnId === params.turnId) current.interrupted = true; return reply({}); }
  if (method === 'thread/compact/start') {
    const t = threads.get(params.threadId);
    append(t, 'compacted', { message: '', replacement_history: [] });
    reply({});
    return out({ method: 'thread/compacted', params: { threadId: t.id } });
  }
  if (method === 'model/list') return reply({ data: [
    { id: 'fake-model', model: 'fake-model', displayName: 'Fake Model', description: 'The fixture model', isDefault: true, hidden: false, defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'],
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick' }, { reasoningEffort: 'medium', description: 'Balanced' }, { reasoningEffort: 'high', description: 'Thorough' }] },
    { id: 'fake-mini', model: 'fake-mini', displayName: 'Fake Mini', description: 'Smaller', isDefault: false, hidden: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick' }] },
    { id: 'fake-hidden', model: 'fake-hidden', displayName: 'Hidden', hidden: true, supportedReasoningEfforts: [] },
  ] });
  if (method === 'account/read') return reply({ account: { type: 'chatgpt', email: 'private@example.com', planType: 'pro' }, requiresOpenaiAuth: true });
  if (method === 'account/rateLimits/read') return reply({ rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1790000000 } } });
  if (method === 'skills/list') return reply({ data: [] });
  if (method === 'fuzzyFileSearch') {
    const files = [];
    for (const root of params.roots || []) for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      if (name.toLowerCase().includes(String(params.query || '').toLowerCase())) files.push({ root, path: name, file_name: name, match_type: fs.statSync(path.join(root, name)).isDirectory() ? 'directory' : 'file', score: 1 });
    }
    return reply({ files });
  }
  fail('fake codex does not implement ' + method);
});
rl.on('close', () => process.exit(0));
