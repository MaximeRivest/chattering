'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { supervisionPlan, spawnSupervised } = require('./process-supervision');
const { randomUUID } = require('node:crypto');
const S = require('./delegation-store');

// How a worker starts Pi: an explicit executable (tests, old records), else
// the one runtime answer (runtime.js): node + Pi's cli.js, never a shim.
function workerPi(options = {}) {
  if (options.piExecutable) return { file: options.piExecutable, args: [...(options.piArgs || [])] };
  const pi = require('./runtime.js').piCommand([]);
  return { file: pi.file, args: [...pi.args, ...(options.piArgs || [])] };
}

function childEnvironment(source, root, id) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^PI_(?:PROMPT_MODE|EFFECTIVE_PROMPT_MODE|ORCHESTRATOR|DELEGATION|SESSION|PARENT|CALLBACK|PROVIDER|MODEL|REASONING_LEVEL)/.test(key)) delete env[key];
  }
  env.PI_DELEGATION_ROOT = root;
  if (id) env.PI_DELEGATION_ID = id;
  return env;
}
function absoluteFile(value, field) {
  S.text(value, field);
  if (!path.isAbsolute(value)) throw new Error(`${field} must be absolute`);
  return path.resolve(value);
}
function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('Delegation spec is required');
  const cwd = fs.realpathSync(absoluteFile(spec.cwd, 'cwd'));
  if (!fs.statSync(cwd).isDirectory()) throw new Error('cwd must be a directory');
  fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
  const parentSessionPath = absoluteFile(spec.parentSessionPath, 'parentSessionPath');
  if (!fs.statSync(parentSessionPath).isFile()) throw new Error('parentSessionPath must be a saved session file');
  const model = S.text(spec.model, 'model', 512);
  if (!/^[a-zA-Z0-9_.-]+\/[^\s:*?\[\]\0]+$/.test(model)) throw new Error('model must be an exact provider/model, without patterns or thinking suffix');
  const thinking = spec.thinking ?? 'off';
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) throw new Error('Invalid thinking level');
  const tools = S.tools(spec.tools);
  const mode = S.normalizeMode(spec.mode);
  if (!S.sameTools(tools, mode.tools)) throw new Error('Requested tools must match explicit mode.tools; no tool override is applied');
  const delivery = spec.delivery ?? 'nextTurn';
  if (!['web', 'nextTurn', 'none'].includes(delivery)) throw new Error('Invalid notification delivery');
  return { title: S.text(spec.title, 'title', 256), role: S.text(spec.role, 'role', 256), prompt: S.text(spec.prompt, 'prompt', 1024 * 1024),
    cwd, parentSessionPath, parentEntryId: S.text(spec.parentEntryId, 'parentEntryId', 256), model, thinking, tools, mode, delivery };
}

async function launchDelegation(spec, options = {}) {
  const input = validateSpec(spec);
  const root = S.rootPath(options);
  const matched = S.allIds(root).map(id => S.readTask(root, id)).filter(t => t.sessionPath === input.parentSessionPath);
  if (matched.length > 1) throw new Error('Ambiguous parent session identity');
  const parent = matched[0];
  if (spec.parentTaskId != null && (!parent || parent.id !== spec.parentTaskId)) throw new Error('parentTaskId does not match the exact parent session');
  if (parent) {
    const blocked = S.gate(root, parent);
    if (blocked.cancelled || blocked.paused) throw new Error(`Delegation ancestor is ${blocked.cancelled ? 'cancelled' : 'paused'}`);
    if (S.ancestors(root, parent).length >= 256) throw new Error('Maximum delegation depth reached');
    input.delivery = parent.delivery;
  }
  if (spec.retryOf !== undefined) S.readTask(root, spec.retryOf);
  const id = randomUUID(), now = Date.now();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = S.taskDir(root, id);
  fs.mkdirSync(dir, { mode: 0o700 });
  const customRoot = options.root || root !== path.join(require('./platform.js').appDirs().data, 'delegations');
  const sessionDir = options.sessionDir ? path.resolve(options.sessionDir) : customRoot
    ? path.join(root, 'sessions') : path.join(require('./runtime.js').piAgentDir(), 'sessions', '--delegated--');
  fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const sessionPath = path.join(sessionDir, `${new Date(now).toISOString().replace(/[:.]/g, '-')}_${id}.jsonl`);
  const outputDir = path.join(dir, 'output');
  fs.mkdirSync(outputDir, { mode: 0o700 });
  const promptPath = path.join(dir, 'prompt.md'), modePath = path.join(dir, 'mode.json');
  const record = { version: 1, id, parentTaskId: parent?.id ?? null, parentSessionPath: input.parentSessionPath,
    parentEntryId: input.parentEntryId, sessionPath, title: input.title, role: input.role, cwd: input.cwd,
    model: input.model, thinking: input.thinking, delivery: input.delivery, status: 'starting', review: 'unreviewed',
    createdAt: now, updatedAt: now, startedAt: null, finishedAt: null, pid: null,
    logPath: path.join(dir, 'stdout.jsonl'), stderrPath: path.join(dir, 'stderr.log'), eventLogPath: path.join(dir, 'events.jsonl'),
    promptPath, modePath, modeHash: S.sha256(input.mode), tools: input.tools, outputDir,
    ...(spec.retryOf ? { retryOf: spec.retryOf } : {}),
    permissions: 'Same user permissions. Prompt scopes are advisory, not a sandbox.',
    callbackPurpose: 'Request parent review. Completion never accepts the work.' };
  const argv = workerArgv({ sessionPath, model: input.model, thinking: input.thinking, title: input.title, modePath, tools: input.tools, promptPath }, options);
  // The request is the commit marker. No supervisor runs before all inputs are durable.
  S.atomic(promptPath, input.prompt + `\n\nDelegation ID: ${id}\nRole: ${input.role}\nOutput directory: ${outputDir}\nCompletion requests parent review. Do not accept your own work.\nScopes in this prompt are advisory, not a sandbox.\n`);
  S.atomic(modePath, input.mode);
  S.atomic(sessionPath, JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date(now).toISOString(), cwd: input.cwd }) + '\n');
  S.atomic(path.join(dir, 'launch.json'), { command: workerPi(options).file, args: [...workerPi(options).args, ...argv] });
  S.atomic(path.join(dir, 'request.json'), record);
  S.appendEvent(dir, 'requested');
  S.syncDir(root);
  await startSupervisor(root, id, options);
  return S.readTask(root, id);
}
function workerArgv({ sessionPath, model, thinking, title, modePath, tools, promptPath }, options = {}) {
  const argv = ['--mode', 'json', '--session', sessionPath, '--model', model, '--thinking', thinking,
    '--name', title, '-e', path.join(__dirname, 'extensions/delegation.ts'),
    '-e', path.join(__dirname, 'extensions/records.ts'),
    '-e', path.join(__dirname, 'extensions/image-budget.ts')];
  if (options.modeExtensionPath) argv.push('-e', path.resolve(options.modeExtensionPath));
  argv.push('--prompt-mode-file', modePath);
  if (tools.length) argv.push('--tools', tools.join(','));
  else argv.push('--no-tools');
  argv.push('-p', `@${promptPath}`);
  return argv;
}
async function startSupervisor(root, id, options = {}) {
  const dir = S.taskDir(root, id);
  const failed = (error, event) => {
    S.atomic(path.join(dir, 'state.json'), { status: 'failed', updatedAt: Date.now(), finishedAt: Date.now(), error, failure: S.classifyFailure(error) });
    if (event) S.appendEvent(dir, 'failed', { error });
  };
  let fd;
  try {
    const env = childEnvironment(options.env || process.env, root, id);
    const plan = supervisionPlan(process.execPath, [path.join(__dirname, 'delegation-supervisor.js'), root, id], {
      id, env, mode: options.supervision || process.env.PI_DELEGATION_SUPERVISION || 'auto',
    });
    S.atomic(path.join(dir, 'supervision.json'), { kind: plan.kind, survivesServiceRestart: plan.survivesServiceRestart });
    fd = fs.openSync(path.join(dir, 'supervisor.log'), 'a', 0o600);
    const supervisor = spawnSupervised(plan, {
      stdio: ['ignore', fd, fd], cwd: __dirname, env,
    });
    await new Promise((resolve, reject) => { supervisor.once('spawn', resolve); supervisor.once('error', reject); });
    supervisor.once('exit', code => {
      if (code && !fs.existsSync(path.join(dir, 'supervisor.json'))) {
        try { failed('Supervisor could not start. Inspect supervisor.log.'); } catch {}
      }
    });
    supervisor.unref();
  } catch (error) {
    failed(`Supervisor launch failed: ${error.message}`, true);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Restart a stopped worker on its own saved session. History, files and the
// mode contract stay. Only model, reasoning and a short instruction can change.
async function resumeDelegation(id, spec = {}, options = {}) {
  const root = S.rootPath(options), dir = S.taskDir(root, id);
  const task = reconcile(root, S.readTask(root, id));
  if (!S.RESUMABLE.has(task.status)) throw new Error(`Only failed or lost delegations can continue; this one is ${task.status}`);
  if (task.workerAlive || (task.processIdentity && S.sameProcess(task.processIdentity))) throw new Error('The previous worker process is still alive. Inspect it before you continue');
  // The terminal state is written before the supervisor exits. Give it a moment to leave.
  for (let i = 0; task.supervisorIdentity && S.sameProcess(task.supervisorIdentity); i++) {
    if (i >= 30) throw new Error('The previous supervisor is still running');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const gate = S.gate(root, task);
  if (task.cancelRequested || gate.cancelled) throw new Error('This delegation or an ancestor is cancelled');
  if (gate.paused) throw new Error('This delegation or an ancestor is paused');
  if (task.takenOver) throw new Error('A user continued this conversation by hand. The worker cannot take it back');
  if (task.failure && task.failure.resumable === false) throw new Error(`This failure is not resumable (${task.failure.kind}): ${task.failure.message}`);
  if (spec.parentSessionPath !== undefined && path.resolve(spec.parentSessionPath) !== task.parentSessionPath) throw new Error('Only the exact parent session can continue this delegation');
  if (task.leafId && (await S.sessionLeaf(task.sessionPath)) !== task.leafId) throw new Error('The session changed since the worker stopped. Inspect it before you continue');
  const model = spec.model === undefined ? task.model : S.text(spec.model, 'model', 512);
  if (!/^[a-zA-Z0-9_.-]+\/[^\s:*?\[\]\0]+$/.test(model)) throw new Error('model must be an exact provider/model, without patterns or thinking suffix');
  const thinking = spec.thinking === undefined ? task.thinking : spec.thinking;
  if (!S.THINKING.includes(thinking)) throw new Error('Invalid thinking level');
  const instructions = spec.instructions === undefined || spec.instructions === null ? '' : S.text(spec.instructions, 'instructions', 64 * 1024);
  const n = task.attempt, now = Date.now();
  const promptPath = path.join(dir, `resume-${n}.md`), launchPath = path.join(dir, `launch-${n}.json`);
  const why = task.failure ? `${task.failure.kind}: ${task.failure.message}` : String(task.error || task.status);
  const prompt = `Your previous attempt on this task stopped. Reason: ${why}\n` +
    `This is attempt ${n + 1}. Your full history for this task is loaded above.\n` +
    `First inspect the working tree and your output directory (${task.outputDir}) for unfinished or half-applied work; a stopped tool may have run partly. ` +
    `Then continue the task from where it stopped. Do not redo finished work.\n` +
    (model !== task.model ? `You now run as ${model}; earlier messages came from ${task.model}.\n` : '') +
    (instructions ? `\nInstructions from the delegating conversation:\n${instructions}\n` : '') +
    `\nDelegation ID: ${id}\nRole: ${task.role}\nOutput directory: ${task.outputDir}\nCompletion requests parent review. Do not accept your own work.\n`;
  const record = { at: now, by: spec.by === 'user' ? 'user' : 'parent', model, thinking, instructions, promptPath, launchPath,
    previousStatus: task.status, previousFailure: task.failure || null, previousError: task.error || null, previousLeafId: task.leafId || null };
  // Old attempt records stay readable. New ones are complete before the state flips.
  for (const name of ['supervisor.json', 'lost.json']) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) fs.renameSync(file, path.join(dir, `${name.replace('.json', '')}-${n}.json`));
  }
  S.atomic(promptPath, prompt);
  S.atomic(launchPath, { command: workerPi(options).file, args: [...workerPi(options).args,
    ...workerArgv({ sessionPath: task.sessionPath, model, thinking, title: task.title, modePath: task.modePath, tools: task.tools, promptPath }, options)] });
  S.atomic(path.join(dir, `resume-${n}.json`), record);
  S.atomic(path.join(dir, 'state.json'), { status: 'starting', attempt: n + 1, updatedAt: now });
  S.appendEvent(dir, 'resume-requested', { attempt: n + 1, by: record.by, model, thinking, previousStatus: task.status });
  S.syncDir(dir);
  await startSupervisor(root, id, options);
  return getDelegation(id, options);
}
// A person continued the worker's conversation directly. The task keeps its
// last outcome, the parent can see it, and no worker restarts on that session.
async function markDelegationTakeover(id, details = {}, options = {}) {
  const root = S.rootPath(options), dir = S.taskDir(root, id);
  const task = S.readTask(root, id);
  if (task.takenOver) return task;
  S.atomic(path.join(dir, 'takeover.json'), { at: Date.now(), model: details.model || null });
  S.appendEvent(dir, 'takeover', { model: details.model || null });
  return S.readTask(root, id);
}

function reconcile(root, task) {
  if (S.TERMINAL.has(task.status)) return task;
  const dir = S.taskDir(root, task.id);
  const owner = S.readJson(path.join(dir, 'supervisor.json'), null);
  if (owner ? !S.sameProcess(owner) : Date.now() - task.attemptRequestedAt > 15000) {
    // Never kill an orphan from a saved PID and never infer success from an exit.
    const error = 'Supervisor is missing. Worker outcome is unknown; inspect saved logs before any new attempt.';
    const lost = { status: 'lost', updatedAt: Date.now(), finishedAt: Date.now(), error, failure: { kind: 'interrupted', message: error, resumable: true } };
    if (!fs.existsSync(path.join(dir, 'lost.json'))) {
      S.atomic(path.join(dir, 'lost.json'), lost);
      S.appendEvent(dir, 'lost');
    }
    return S.readTask(root, task.id);
  }
  return task;
}
async function getDelegation(id, options = {}) {
  const root = S.rootPath(options);
  const task = reconcile(root, S.readTask(root, id));
  const effects = S.gate(root, task);
  return { ...task, paused: effects.paused, cancelRequested: effects.cancelled,
    workerAlive: !!task.processIdentity && S.sameProcess(task.processIdentity) };
}
async function listDelegations(options = {}) {
  const root = S.rootPath(options);
  const tasks = S.allIds(root).map(id => {
    const task = reconcile(root, S.readTask(root, id));
    task.workerAlive = !!task.processIdentity && S.sameProcess(task.processIdentity);
    return task;
  });
  tasks.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const activeSessions = new Set((options.includeSessionPaths || []).map(file => path.resolve(file)));
  const live = tasks.filter(t => t.workerAlive || activeSessions.has(t.sessionPath) || !S.TERMINAL.has(t.status));
  const byId = new Map(tasks.map(t => [t.id, t]));
  const keep = new Map(live.map(t => [t.id, t]));
  // Keep the recorded ancestry of live tasks so recursive grouping remains possible.
  for (const task of live) {
    let parent = byId.get(task.parentTaskId);
    const seen = new Set();
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id); keep.set(parent.id, parent); parent = byId.get(parent.parentTaskId);
    }
  }
  for (const task of tasks) { if (!options.all && keep.size >= 2000) break; keep.set(task.id, task); }
  const beforeAncestors = keep.size;
  for (const task of [...keep.values()]) {
    let parent = byId.get(task.parentTaskId);
    const seen = new Set();
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id); keep.set(parent.id, parent); parent = byId.get(parent.parentTaskId);
    }
  }
  const retainedAncestors = keep.size - beforeAncestors;
  const selected = [...keep.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  // Metadata is already loaded. Do not reread every ancestor's files for
  // every row, which turns a deep tree into quadratic filesystem work.
  const effectsById = new Map();
  for (const task of selected) {
    const chain = [], seen = new Set();
    let current = task;
    while (current && !effectsById.has(current.id)) {
      if (seen.has(current.id) || chain.length >= 256) throw new Error('Invalid or excessive delegation ancestry');
      seen.add(current.id); chain.push(current); current = byId.get(current.parentTaskId);
    }
    let effects = current ? effectsById.get(current.id) : { paused: false, cancelled: false };
    for (const member of chain.reverse()) {
      effects = { paused: effects.paused || member.paused, cancelled: effects.cancelled || member.cancelRequested || member.status === 'cancelled' };
      effectsById.set(member.id, effects);
    }
    const own = effectsById.get(task.id);
    task.paused = own.paused; task.cancelRequested = own.cancelled;
  }
  // Array metadata is available to hosts; JSON callers should expose it separately.
  selected.listing = { total: tasks.length, omitted: tasks.length - selected.length, limit: options.all ? null : 2000, live: live.length, retainedAncestors };
  return selected;
}
async function controlDelegation(id, action, options = {}) {
  if (!['pause', 'resume', 'cancel'].includes(action)) throw new Error('Invalid delegation control action');
  const root = S.rootPath(options), dir = S.taskDir(root, id);
  S.readTask(root, id);
  const at = Date.now();
  if (action === 'cancel') {
    // This monotonic ancestor marker covers existing children and concurrent launches.
    S.atomic(path.join(dir, 'cancel.json'), { at });
  } else S.atomic(path.join(dir, 'pause.json'), { at, paused: action === 'pause' });
  S.appendEvent(dir, 'control', { action });
  return getDelegation(id, options);
}
async function reportDelegationReview(id, review, evidence, options = {}) {
  if (!['accepted', 'rejected'].includes(review)) throw new Error('Review must be accepted or rejected');
  S.text(evidence, 'review evidence', 16000);
  const root = S.rootPath(options), task = S.readTask(root, id);
  if (!S.TERMINAL.has(task.status)) throw new Error('Wait for a terminal outcome before review');
  if (!options.reviewerSessionPath || path.resolve(options.reviewerSessionPath) !== task.parentSessionPath) throw new Error('Only the exact parent session can record review');
  S.atomic(path.join(S.taskDir(root, id), 'review.json'), { review, reviewEvidence: evidence, reviewerSessionPath: task.parentSessionPath, updatedAt: Date.now() });
  S.appendEvent(S.taskDir(root, id), 'review', { review, evidence, reviewerSessionPath: task.parentSessionPath });
  return getDelegation(id, options);
}
module.exports = { launchDelegation, resumeDelegation, markDelegationTakeover, listDelegations, getDelegation, controlDelegation, reportDelegationReview,
  normalizeMode: S.normalizeMode, modeSha256: S.sha256, childEnvironment };
