'use strict';
const { randomUUID } = require('node:crypto');
const { READ_ONLY, CheckpointStore } = require('./checkpoint-store');
const { isLooseCwd } = require('./projectfolds');
const { directTargets, inspectShell } = require('./task-locations');

// The files a shell command names as its output (a redirect, tee, cp's
// destination, sed -i) are saved before and after it too, so a step that
// writes an ignored file or one outside the project is observed, not only
// read from the command (design/88). A named output that is a folder, a
// binary file or protected is simply not saved: soft, never a warning.
function shellTargets(name, input, cwd) {
  const command = input && (input.command || input.cmd);
  if (!/^(bash|shell)$/i.test(String(name || '')) || typeof command !== 'string') return [];
  try {
    return inspectShell(command, { host: 'local', cwd }).locations
      .filter(l => l.host === 'local' && l.path && (l.role === 'output' || l.role === 'copy-destination'))
      .slice(0, 16).map(l => ({ ...l, soft: true }));
  } catch { return []; }
}
const stepTargets = (name, input, cwd) => [...directTargets(name, input, cwd), ...shellTargets(name, input, cwd)];

// How long a step may wait for its "before" copy (design/101). Only that
// copy holds the agent: the tool must not run until its starting point is
// saved. Every other copy (the turn's start, a step's end, the end of a
// turn) runs behind the agent, during the model's next answer, and is given
// longer. Captures of one conversation keep their order, so a step's end
// is always saved before the next step starts.
// What a capture left out on purpose, in one message: one artifact in full,
// several by name.
function notesMessage(notes) {
  if (notes.length === 1) return `File history: ${notes[0].path} ${notes[0].text}.`;
  const names = notes.slice(0, 4).map(n => n.path).join(', ') + (notes.length > 4 ? ` and ${notes.length - 4} more` : '');
  return `File history saves only part of ${notes.length} artifacts here (too large, or past the space kept for artifacts): ${names}. The current files are always shown.`;
}
const envMs = (name, fallback) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : fallback; };

function checkpointExtension(pi, options = {}) {
  let store, run = '', review = '', closed = false;
  const wait = options.wait ?? envMs('CHATTERING_CHECKPOINT_WAIT_MS', 2000);
  const behind = options.behind ?? envMs('CHATTERING_CHECKPOINT_BEHIND_MS', 10000);
  const pending = new Map(), inflight = new Set();
  // What the person was told: a reason once per turn (they differ only in
  // their numbers from step to step), a folder note once per conversation.
  const warned = new Set(), noted = new Set();
  const tell = (ui, text) => { try { ui?.notify?.(text, 'warning'); } catch {} };
  // Everything read from ctx is read at once: a capture that finishes later
  // must not touch a context the session may have replaced.
  const where = ctx => ({ cwd: ctx.cwd, session: ctx.sessionManager?.getSessionFile?.() || '', ui: ctx.ui });
  const capture = async (at, meta, opts) => {
    if (closed || process.env.CHATTERING_NO_CHECKPOINTS === '1') return;
    // A loose folder (home, temp) is not scanned, except the artifacts a
    // conversation declared there (design/67) and the files a step names.
    const targetOnly = !options.allowLoose && isLooseCwd(at.cwd);
    try {
      store ||= options.store || new CheckpointStore();
      const result = await store.capture(at.cwd, { session: at.session, run, review, ...meta, targetOnly }, opts);
      if (!result) return;
      const fresh = (result.notes || []).filter(n => !noted.has(n.path + '\0' + n.text));
      for (const n of fresh) noted.add(n.path + '\0' + n.text);
      if (fresh.length) tell(at.ui, notesMessage(fresh));
      if (result.stopped) return result;
      if (result.error || result.targetErrors?.length) throw Error(result.error || result.targetErrors.join('; '));
      return result;
    } catch (e) {
      // History failure must not turn a permitted tool call into a blocked one.
      const kind = e.message.replace(/\d[\d,.]*/g, '#');
      if (!warned.has(kind)) { warned.add(kind); tell(at.ui, 'File history did not save this step: ' + e.message); }
    }
  };
  const later = (at, meta) => {
    const work = capture(at, meta, { budget: behind });
    inflight.add(work); work.finally(() => inflight.delete(work));
  };
  pi.on('before_agent_start', async (e, ctx) => {
    run = randomUUID(); review = /^Review ([0-9a-f-]{36})\n/.exec(e.prompt || '')?.[1] || '';
    warned.clear();
    later(where(ctx), { phase: 'run-before' });
  });
  pi.on('tool_call', async (e, ctx) => {
    const info = pi.getAllTools?.().find(t => t.name === e.toolName);
    if (READ_ONLY.has(e.toolName) && info?.sourceInfo?.source === 'builtin') return;
    const entry = { tool: e.toolName, input: e.input, targets: stepTargets(e.toolName, e.input, ctx.cwd), overlapping: pending.size > 0 };
    if (pending.size) for (const other of pending.values()) other.overlapping = true;
    pending.set(e.toolCallId, entry);
    // Stopping the run stops this wait too: the tool will not run.
    await capture(where(ctx), { call: e.toolCallId, tool: e.toolName, phase: 'before', overlapping: entry.overlapping, targets: entry.targets }, { budget: wait, signal: ctx.signal });
  });
  pi.on('tool_result', async (e, ctx) => {
    const entry = pending.get(e.toolCallId);
    if (!entry) return;
    pending.delete(e.toolCallId);
    later(where(ctx), { call: e.toolCallId, tool: e.toolName, phase: e.isError ? 'after-error' : 'after', overlapping: entry.overlapping, targets: stepTargets(e.toolName, e.input || entry.input, ctx.cwd) });
  });
  pi.on('agent_settled', async (_e, ctx) => {
    // Blocked/aborted tools may have no tool_result. Record the incomplete
    // interval, never manufacture a successful tool completion. One copy
    // stands for all of them and for the turn's end.
    const rows = [...pending].map(([call, entry]) => ({ call, tool: entry.tool, phase: 'settled-incomplete', overlapping: entry.overlapping }));
    pending.clear();
    later(where(ctx), { phase: 'run-settled', rows });
  });
  pi.on('session_shutdown', async (_e, ctx) => {
    await Promise.allSettled([...inflight]);
    await capture(where(ctx), { phase: 'shutdown' }, { budget: wait }); closed = true;
    if (store && !options.store) store.close();
  });
}
module.exports = { checkpointExtension, stepTargets };
