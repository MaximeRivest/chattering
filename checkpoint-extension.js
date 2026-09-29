'use strict';
const { randomUUID } = require('node:crypto');
const { READ_ONLY, CheckpointStore } = require('./checkpoint-store');
const { isLooseCwd } = require('./projectfolds');
const { directTargets } = require('./task-locations');

function checkpointExtension(pi, options = {}) {
  let store, run = '', review = '', warned = '', closed = false;
  const pending = new Map();
  // A loose folder (home, temp) is not scanned, except the artifact folders
  // a conversation declared there (design/67). Checked at most every 10 s.
  let artifactCheck = { cwd: '', at: 0, any: false };
  const hasArtifacts = async cwd => {
    if (artifactCheck.cwd === cwd && Date.now() - artifactCheck.at < 10000) return artifactCheck.any;
    let any = false;
    try { store ||= options.store || new CheckpointStore(); any = store.artifactScopes(await store.root(cwd)).length > 0; } catch {}
    artifactCheck = { cwd, at: Date.now(), any };
    return any;
  };
  const capture = async (ctx, meta) => {
    if (closed || process.env.CHATTERING_NO_CHECKPOINTS === '1') return;
    const targetOnly = !options.allowLoose && isLooseCwd(ctx.cwd);
    if (targetOnly && !meta.targets?.length && !(await hasArtifacts(ctx.cwd))) return;
    try {
      store ||= options.store || new CheckpointStore();
      const result = await store.capture(ctx.cwd, { session: ctx.sessionManager.getSessionFile() || '', run, review, ...meta, targetOnly });
      if (result.error || result.targetErrors?.length) throw Error(result.error || result.targetErrors.join('; '));
      return result;
    } catch (e) {
      // History failure must not turn a permitted tool call into a blocked one.
      if (warned !== e.message) { warned = e.message; ctx.ui?.notify?.('File history did not save this step: ' + e.message, 'warning'); }
    }
  };
  pi.on('before_agent_start', async (e, ctx) => {
    run = randomUUID(); review = /^Review ([0-9a-f-]{36})\n/.exec(e.prompt || '')?.[1] || '';
    await capture(ctx, { phase: 'run-before' });
  });
  pi.on('tool_call', async (e, ctx) => {
    const info = pi.getAllTools?.().find(t => t.name === e.toolName);
    if (READ_ONLY.has(e.toolName) && info?.sourceInfo?.source === 'builtin') return;
    const entry = { tool: e.toolName, input: e.input, targets: directTargets(e.toolName, e.input, ctx.cwd), overlapping: pending.size > 0 };
    if (pending.size) for (const other of pending.values()) other.overlapping = true;
    pending.set(e.toolCallId, entry);
    await capture(ctx, { call: e.toolCallId, tool: e.toolName, phase: 'before', overlapping: entry.overlapping, targets: entry.targets });
  });
  pi.on('tool_result', async (e, ctx) => {
    const entry = pending.get(e.toolCallId);
    if (!entry) return;
    try { await capture(ctx, { call: e.toolCallId, tool: e.toolName, phase: e.isError ? 'after-error' : 'after', overlapping: entry.overlapping, targets: directTargets(e.toolName, e.input || entry.input, ctx.cwd) }); }
    finally { pending.delete(e.toolCallId); }
  });
  pi.on('agent_settled', async (_e, ctx) => {
    // Blocked/aborted tools may have no tool_result. Record the incomplete
    // interval, never manufacture a successful tool completion.
    for (const [call, entry] of pending) await capture(ctx, { call, tool: entry.tool, phase: 'settled-incomplete', overlapping: entry.overlapping });
    pending.clear(); await capture(ctx, { phase: 'run-settled' });
  });
  pi.on('session_shutdown', async (_e, ctx) => {
    await capture(ctx, { phase: 'shutdown' }); closed = true;
    if (store && !options.store) store.close();
  });
}
module.exports = { checkpointExtension };
