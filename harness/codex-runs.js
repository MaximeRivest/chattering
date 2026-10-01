'use strict';
// Codex runs inside Chattering (design/87): the glue between the Codex
// driver (codex.js) and Chattering's run machinery (jobs, live tails, run
// cards, approvals, re-indexing). The server hands its machinery in as
// `deps`; nothing here reaches into server.js directly.
//
// Choices a person makes per conversation (kept in `prefs`):
//   model    one of Codex's own models (model/list), never a Pi model
//   effort   one of the efforts that model advertises
//   access   'config' (default: Codex's own config.toml decides),
//            'read-only', 'workspace' (writes in the folder, asks before
//            anything else), 'full' (no sandbox, never asks)
// Access is applied when a thread is resumed or started; Codex keeps it
// for the thread from then on.

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const ACCESS = {
  config: {},
  'read-only': { sandboxMode: 'read-only', approvalPolicy: 'on-request' },
  workspace: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
  full: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
};
const ACCESS_LABELS = {
  config: 'As in Codex settings', 'read-only': 'Read only', workspace: 'This folder (asks first)', full: 'Full access (never asks)',
};

function createCodexRuns(deps) {
  const {
    index, headlessRuns, agentRunJobs, driver, prefs,
    sessionPathsFor, jobChanged, runEventForwarder, reindexIfChanged, refreshUsageForKey,
    endLiveRunTail, broadcastRunFinal, speakRunDone, recordAuthorship, indexNewSessionFile,
    agentEnv, codexBin, withSessionOp = (_p, f) => f(), sleep = ms => new Promise(r => setTimeout(r, ms)),
  } = deps;
  const followUps = new Map(); // sessionPath → [{ message, images, principal, ... }] queued behind a running reply

  function assertOwner(principal) {
    if (principal && (principal.guest || principal.sandbox)) {
      throw Object.assign(new Error('Codex runs from Chattering for this machine\'s own account only. Guests use Pi conversations.'), { status: 403 });
    }
  }
  function prefsOf(key) {
    const p = (key && prefs.get(key)) || {};
    const e = key && index[key];
    return {
      model: p.model || (e && e.codex && e.codex.model) || null,
      effort: p.effort || (e && e.codex && e.codex.effort) || null,
      access: ACCESS[p.access] ? p.access : 'config',
    };
  }
  function targetFor({ threadId = null, cwd, principal, model, effort, access, developerInstructions }) {
    return { threadId, cwd, env: agentEnv(principal), bin: codexBin(), model: model || null, effort: effort || null,
      ...(ACCESS[access] || {}), ...(developerInstructions ? { developerInstructions } : {}) };
  }
  function newJob({ key, model, message, images }) {
    return {
      id: 'run:' + crypto.randomUUID().slice(0, 8), type: 'agent-run', key, harness: 'codex',
      title: (model ? model + ' · ' : '') + (images && images.length ? '[' + images.length + ' img] ' : '') + String(message).replace(/\s+/g, ' ').slice(0, 60),
      status: 'running', statusText: 'starting', startedAt: Date.now(), recoveryAttempts: 0,
      model: model ? 'codex/' + model : 'codex', node: null, intent: null, recoveryEligible: false,
    };
  }

  // One reply, on a conversation that already has its record. `record` is
  // registered in headlessRuns under sessionPath before this runs.
  async function drive({ job, record, sessionPath, key, target, message, images, author, principal, input, coauthors, onThread }) {
    const finish = async (status, statusText, error) => {
      // The record may have moved (a new conversation's temporary slot to
      // its file): clear it wherever it is.
      for (const [k, r] of [...headlessRuns]) if (r === record) headlessRuns.delete(k);
      const queuePath = record.sessionPath || sessionPath;
      job.status = status; job.statusText = statusText; job.uiRequests = [];
      if (error) job.error = error;
      job.finishedAt = Date.now();
      if (job.key) { await reindexIfChanged(job.key).catch(() => {}); refreshUsageForKey(job.key); }
      if (status === 'done' && !record.yielded) job.doneSpeechSource = job.lastAssistantText || '';
      endLiveRunTail(job.id);
      jobChanged(job);
      broadcastRunFinal(job, job.key);
      speakRunDone(job);
      // A follow-up written while this reply ran goes next, as in Codex.
      const queue = followUps.get(queuePath);
      if (queue && queue.length && job.key) {
        const next = queue.shift();
        if (!queue.length) followUps.delete(queuePath);
        send(job.key, next).catch(e => console.error('codex follow-up failed:', e.message));
      }
    };
    try {
      const handle = driver.codexHeadlessRun(target, { message, images, onEvent: runEventForwarder(job), onThread });
      record.handle = handle;
      if (author) recordAuthorship(key || job.key, author, { via: 'codex', chars: String(message || '').length, input, coauthors });
      job.statusText = 'running'; jobChanged(job);
      const out = await handle.done;
      if (target.onInjected && !out.aborted) target.onInjected();
      if (record.yielded) await finish('done', 'stopped — ' + record.yielded);
      else if (out.aborted) await finish('done', 'stopped');
      else if (job.errorMessage) await finish('error', job.errorMessage, job.errorMessage);
      else await finish('done', 'settled');
      return out;
    } catch (e) {
      await finish('error', e.message, e.message);
      throw e;
    }
  }

  // A message on an existing Codex conversation.
  async function send(key, { message, images = [], principal, model, effort, author = null, input = 'keyboard', coauthors = null, node = null, allowQueue = false, brief = null }) {
    assertOwner(principal);
    const { entry, sessionPath, cwd } = sessionPathsFor(key);
    if (!entry.sessionId) throw new Error('This Codex conversation has no thread id in its file; it cannot be continued.');
    if (entry.importCopyOf || (entry.codex && entry.codex.imported)) throw new Error('This is a text-only copy Codex imported from another agent. Continue the original instead.');
    if (!String(message || '').trim()) throw new Error('empty prompt');
    const leaf = entry && lastEntryIdOf(key);
    if (node && leaf && node !== leaf) throw Object.assign(new Error('Codex continues from its newest message. To continue from an earlier point, fork the conversation.'), { status: 409 });
    const p = prefsOf(key);
    if (headlessRuns.has(sessionPath)) {
      if (!allowQueue) throw new Error('Codex is already answering in this conversation. Wait or stop it.');
      if (!followUps.has(sessionPath)) followUps.set(sessionPath, []);
      followUps.get(sessionPath).push({ message, images, principal, model, effort, author, input, coauthors });
      const running = agentRunJobs.get(headlessRuns.get(sessionPath).jobId);
      if (running) { running.statusText = 'follow-up queued'; jobChanged(running); }
      return { queued: true, job: running || null };
    }
    const target = targetFor({ threadId: entry.sessionId, cwd, principal, model: model || p.model, effort: effort || p.effort, access: p.access });
    // Attached context (Chattering's @ chips): Pi reads it in its system
    // prompt on every run; Codex is given it once, as developer instructions,
    // whenever it changed since last given.
    const ctx = deps.contextFor ? await deps.contextFor(key) : null;
    const given = (prefs.get(key) || {}).contextSig || '';
    if (ctx && ctx.sig !== given) {
      target.injectItems = ctx.text ? [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Context the person attached in Chattering (replaces any earlier attached context):\n\n' + ctx.text }] }]
        : [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'The person removed the context they had attached in Chattering; disregard it.' }] }];
      target.onInjected = () => prefs.set(key, { contextSig: ctx.sig });
    }
    // Instructions for this request only (the file ask box's brief). Pi
    // reads them in this run's system prompt; Codex keeps what it is given,
    // so they are marked as being for this request.
    if (brief && String(brief).trim()) {
      target.injectItems = [...(target.injectItems || []), { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Instructions from Chattering for the next request only:\n\n' + String(brief).trim() }] }];
    }
    const job = newJob({ key, model: target.model, message, images });
    agentRunJobs.set(job.id, job); jobChanged(job);
    const record = { jobId: job.id, key, startedAt: job.startedAt, model: job.model, handle: null, yielded: null, harness: 'codex', sessionPath };
    headlessRuns.set(sessionPath, record);
    record.completion = withSessionOp(sessionPath, () => drive({ job, record, sessionPath, key, target, message, images, author, principal, input, coauthors }).catch(() => {}));
    return job;
  }

  // The first message of a new Codex conversation. Codex writes the file
  // when the reply begins; the conversation is listed once it exists.
  async function start({ folder, message, images = [], principal, model, effort, access = 'config', developerInstructions = null, author = null, input = 'keyboard', coauthors = null, describeStartFolder }) {
    assertOwner(principal);
    if (!String(message || '').trim()) throw new Error('write the first message');
    const where = describeStartFolder(folder || '');
    if (!where.exists) throw new Error('folder not found: ' + where.display);
    const target = targetFor({ cwd: where.path, principal, model, effort, access, developerInstructions });
    const job = newJob({ key: null, model, message, images });
    agentRunJobs.set(job.id, job); jobChanged(job);
    const pendingPath = 'codex-new:' + job.id;
    const record = { jobId: job.id, key: null, startedAt: job.startedAt, model: job.model, handle: null, yielded: null, harness: 'codex' };
    headlessRuns.set(pendingPath, record);
    let resolveThread, rejectThread;
    const threadKnown = new Promise((res, rej) => { resolveThread = res; rejectThread = rej; });
    const run = drive({ job, record, sessionPath: pendingPath, key: null, target, message, images, author: null, principal, input, coauthors,
      onThread: t => resolveThread(t) });
    run.catch(e => rejectThread(e));
    const thread = await threadKnown;
    if (!thread.path) throw new Error('Codex did not say where it keeps this conversation.');
    // The file appears when the reply begins.
    for (let t0 = Date.now(); Date.now() - t0 < 30000;) {
      if (fs.existsSync(thread.path)) break;
      if (job.status !== 'running') break;
      await sleep(100);
    }
    if (!fs.existsSync(thread.path)) throw new Error(job.error || 'Codex did not create the conversation file.');
    const key = await indexNewSessionFile(thread.path);
    job.key = key;
    record.key = key;
    // From now on the run is known under the conversation's real file.
    record.sessionPath = path.resolve(thread.path);
    if (headlessRuns.get(pendingPath) === record) { headlessRuns.delete(pendingPath); headlessRuns.set(record.sessionPath, record); }
    jobChanged(job);
    // Events that came before the conversation had a name (an approval
    // Codex asked for at once) were sent nameless: send the live state again.
    if (deps.repaintRun) deps.repaintRun(job);
    if (author) recordAuthorship(key, author, { via: 'codex', chars: String(message).length, input, coauthors });
    prefs.set(key, { model: model || thread.model || null, effort: effort || null, access });
    return { key, job, cwd: where.path, threadId: thread.threadId };
  }

  // The newest message of the conversation (the reader's head when it is
  // at the end): Codex can only continue from there.
  function lastEntryIdOf(key) {
    const e = index[key];
    return e && e.codex && e.codex.lastMessageEid || null;
  }

  return { send, start, prefsOf, ACCESS, ACCESS_LABELS, followUps };
}

module.exports = { createCodexRuns, ACCESS, ACCESS_LABELS };
