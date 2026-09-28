'use strict';

// The host reads execution records. It never owns worker PIDs or rewrites sessions.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { createReadStream } = require('node:fs');
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'lost']);
const { quietLevel, quietLabel } = require('./activity-watch.js');

async function atomicJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(data) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await require('./platform.js').renameRetry(tmp, file);
  } finally { await fs.unlink(tmp).catch(() => {}); }
}

// Runner events a parent session carries, each with a stable delivery ID:
// a returned result, or a worker that went quiet. The ID is how a restarted
// host sees that a callback already landed.
const CALLBACK_TYPES = new Set(['delegation-complete', 'delegation-attention']);

// Inspect only parents with pending deliveries, not the full session corpus.
async function inspectDeliverySession(file) {
  const parents = new Map(), deliveries = new Set();
  let leaf = null;
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'session' && typeof e.id === 'string') {
        parents.set(e.id, e.parentId || null); leaf = e.id;
      }
      if (e.type === 'custom_message' && CALLBACK_TYPES.has(e.customType) && typeof e.details?.deliveryId === 'string') {
        deliveries.add(e.details.deliveryId);
      }
    }
  } finally { lines.close(); stream.destroy(); }
  const branch = new Set();
  while (leaf && parents.has(leaf) && !branch.has(leaf)) { branch.add(leaf); leaf = parents.get(leaf); }
  return { branch, deliveries };
}

// A resumed attempt is a new outcome: it must reach the parent again.
function deliveryId(tasks) {
  return crypto.createHash('sha256').update(tasks.map(t => t.id + (Number(t.attempt) > 1 ? ':' + t.attempt : '')).sort().join('\n')).digest('hex');
}
// One quiet stretch of one attempt, at one reminder level.
function attentionId(items) {
  return crypto.createHash('sha256').update('attention\n' + items.map(i => `${i.task.id}:${Number(i.task.attempt) || 1}:${i.quietSince}:${i.level}`).sort().join('\n')).digest('hex');
}

// Siblings still at work when a result returns. The parent reads what it is
// still waiting for, with the facts of any that went quiet.
function runningLines(running) {
  if (!running.length) return '';
  return '\nStill running:\n' + running.map(r => r.report
    ? `* ${r.report}`
    : `* ${r.task.title} (task ${r.task.id})${r.elapsed ? `, ${r.elapsed} so far` : ''}${r.lastOutput ? `, last output ${r.lastOutput} ago` : ''}.`).join('\n');
}

function completionMessage(tasks, id, { running = [], attention = [] } = {}) {
  const lines = tasks.map(t => `- ${t.title}: ${t.status}${t.failure ? ` (${t.failure.kind})` : ''}${Number(t.attempt) > 1 ? `, attempt ${t.attempt}` : ''}; review: ${t.review || 'unreviewed'}. Task ${t.id}. Session: ${t.sessionPath}. Results: ${t.outputDir}.` +
    (t.status === 'failed' || t.status === 'lost' ? ` Stopped work keeps its session; delegation_resume can continue it with the same or another model.` : ''));
  return {
    customType: 'delegation-complete', display: true,
    content: 'Delegated work returned. This is a runner event, not a user request.\n' + lines.join('\n') + runningLines(running) +
      '\nInspect the results and checks before accepting them. Continue only work already authorized by the user. Process success does not mean review passed.',
    details: { deliveryId: id, taskIds: tasks.map(t => t.id), parentEntryIds: [...new Set(tasks.map(t => t.parentEntryId))],
      ...(attention.length ? { attention: attention.map(a => ({ taskId: a.task.id, level: a.level, quietSince: a.quietSince })) } : {}) },
  };
}

// Nothing is stopped: the parent decides, and says so to the person when it
// cannot tell. Long work is allowed; silence alone is not failure.
function attentionMessage(items, id) {
  return {
    customType: 'delegation-attention', display: true,
    content: 'Delegated work has gone quiet. This is a runner event, not a user request. Nothing was stopped.\n' +
      items.map(i => '* ' + i.report).join('\n') +
      '\nDecide what it needs: keep waiting if the work is legitimately slow; read its log or session to see what it is doing; stop only a stuck process (its pid is listed) so the worker gets its tool result and continues; or cancel it with delegation_control and continue it later with delegation_resume. If you cannot tell, tell the user. Do not treat this as a result.',
    details: { deliveryId: id, taskIds: items.map(i => i.task.id), parentEntryIds: [...new Set(items.map(i => i.task.parentEntryId))],
      attention: items.map(i => ({ taskId: i.task.id, level: i.level, quietSince: i.quietSince })) },
  };
}

// reach(parent): 'ready' (a turn can start now), 'busy' (someone is at work
// in it: wait), or 'unreachable' (no agent turn will start there: a
// terminal owns it, it is not indexed, its worker is lost or cancelled).
// Results wait in both of the last two cases; a quiet worker is told to the
// person instead, since waiting could mean never.
//
// Quiet work (activity options, all optional; no activityOf: no watching):
//   activityOf(task)     { lastActivityAt } in ms, or null when unknown. Cheap:
//                        called for every live worker on every pass.
//   reportOf(task, facts) the paragraph describing a quiet worker. Costly
//                        (reads logs, the process table): called only when a
//                        reminder is due or a result lists a quiet sibling.
//   quietMs()            the threshold; 0 turns the watch off.
//   onQuiet(item)        the person must hear: { task, level, quietSince,
//                        quietMs, report, reason }.
function createDelegationCoordinator({ root, list, listAll = list, decorate = t => t, canDeliver, reach, deliver,
  inspectSession = inspectDeliverySession, onChange = () => {}, onError = console.error, now = Date.now,
  settleMs = 60000, maxBatchWaitMs = 180000,
  activityOf = null, reportOf = null, quietMs = () => 0, onQuiet = () => {} }) {
  const notificationDir = path.join(root, 'notifications');
  const attentionDir = path.join(root, 'attention');
  let snapshot = { tasks: [], revision: '' }, refreshing = null, delivering = false, stopped = false;
  const inflight = new Set();
  const signatureCache = new Map();
  // When this host first saw an outcome that has no recorded finish time.
  const firstSeen = new Map();
  const reachOf = reach || (async parent => (await canDeliver(parent)) ? 'ready' : 'busy');
  async function readRecord(dir, id) {
    try { return JSON.parse(await fs.readFile(path.join(dir, id + '.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; return null; }
  }
  const notification = id => readRecord(notificationDir, id);
  const attention = id => readRecord(attentionDir, id);
  async function saveRecord(dir, id, data, previous) {
    if (previous) { const { updatedAt, ...body } = previous; if (JSON.stringify(body) === JSON.stringify(data)) return; }
    await atomicJson(path.join(dir, id + '.json'), { ...data, updatedAt: now() });
  }
  async function saveNotification(id, data) { await saveRecord(notificationDir, id, data, await notification(id)); }
  async function saveAttention(id, data) { await saveRecord(attentionDir, id, data, await attention(id)); }
  async function dropAttention(id) {
    await fs.unlink(path.join(attentionDir, id + '.json')).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
  async function sessionState(file) {
    const st = await fs.stat(file), sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
    let cached = signatureCache.get(file);
    if (!cached || cached.sig !== sig) {
      cached = { sig, data: await inspectSession(file) };
      signatureCache.set(file, cached);
      if (signatureCache.size > 64) signatureCache.delete(signatureCache.keys().next().value);
    }
    return cached.data;
  }
  // A worker the watch looks at: its own process at work, not a person
  // continuing its conversation in the web (that run is watched as a run).
  const sessionActive = t => t.sessionActive !== undefined ? !!t.sessionActive : !!decorate(t).sessionActive;
  // Paused workers still run (pause only stops new descendants): watched.
  const watched = t => !!activityOf && !TERMINAL.has(t.status) && !t.cancelRequested && !sessionActive(t);
  // Facts of one live worker now: how long quiet, and the reminder due.
  async function quietFacts(t) {
    const threshold = Number(quietMs()) || 0;
    if (!watched(t) || threshold <= 0) return null;
    let a = null;
    try { a = await activityOf(t); } catch (e) { onError('[delegation activity]', e); }
    const last = Number(a?.lastActivityAt);
    if (!Number.isFinite(last) || last <= 0) return null;
    const quiet = Math.max(0, now() - last);
    return { task: t, quietSince: last, quietMs: quiet, level: quietLevel(quiet, threshold) };
  }
  async function reportFor(facts) {
    if (reportOf) {
      try { const text = await reportOf(facts.task, facts); if (text) return text; }
      catch (e) { onError('[delegation quiet report]', e); }
    }
    return `${facts.task.title} (task ${facts.task.id}): no new output for ${quietLabel(facts.quietMs)}.`;
  }
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const raw = await list();
      const tasks = [];
      for (const t of raw) {
        const n = await notification(t.id);
        const view = { ...t, notificationState: n?.state || (TERMINAL.has(t.status) && t.delivery === 'web' ? 'pending' : null), notificationError: n?.error || null };
        // The quiet flag, for every screen: set only once the threshold is
        // passed, and it changes only per stretch and reminder, so the
        // revision (and the broadcast) does not tick with every token.
        const decorated = decorate(view);
        const facts = await quietFacts(decorated);
        if (facts && facts.level >= 0) {
          const a = await attention(t.id);
          const told = a && a.quietSince === facts.quietSince ? a.state : null;
          decorated.quiet = { since: facts.quietSince, level: facts.level,
            told: told === 'delivered' || told === 'delivering' ? 'parent' : told === 'person' ? 'person' : null };
        }
        tasks.push(decorated);
      }
      const listing = raw.listing || { total: tasks.length, omitted: 0 };
      const revision = crypto.createHash('sha256').update(JSON.stringify([tasks, listing])).digest('hex');
      if (revision !== snapshot.revision) { snapshot = { tasks, revision, listing }; onChange(snapshot); }
      return snapshot;
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  // When an outcome came back. finishedAt is the worker's own record; an
  // outcome without one counts from the moment this host first saw it.
  function returnedAt(t) {
    const recorded = Number(t.finishedAt);
    if (Number.isFinite(recorded) && recorded > 0) return recorded;
    const k = t.id + ':' + (Number(t.attempt) || 1);
    if (!firstSeen.has(k)) firstSeen.set(k, now());
    return firstSeen.get(k);
  }
  // Tell the person a quiet worker could not be told to an agent.
  async function tellPerson(facts, reason) {
    const report = facts.report || await reportFor(facts);
    await saveAttention(facts.task.id, { state: 'person', quietSince: facts.quietSince, level: facts.level, reason });
    try { await onQuiet({ ...facts, report, reason }); } catch (e) { onError('[delegation quiet]', e); }
  }
  // Live workers whose next quiet reminder is due. A reminder already sent
  // for this stretch at this level is not due. One still marked delivering
  // is due again: the callers skip a parent with a delivery in flight, so
  // the mark is left over from a stopped host, and the transcript check
  // below decides whether it landed.
  async function dueAttention(live) {
    const due = [];
    for (const t of live) {
      const facts = await quietFacts(t);
      let stored = await attention(t.id);
      if (stored && (!facts || facts.level < 0 || stored.quietSince !== facts.quietSince)) {
        // Output resumed (or the watch is off): the next quiet stretch starts over.
        await dropAttention(t.id); stored = null;
      }
      if (!facts || facts.level < 0) continue;
      if (stored && stored.level >= facts.level && stored.state !== 'delivering') continue;
      due.push({ ...facts, stored });
    }
    return due;
  }
  async function processPending() {
    if (delivering || stopped) return;
    delivering = true;
    try {
      await refresh();
      const tasks = await listAll();
      const children = new Map();
      for (const task of tasks) {
        if (!task.parentTaskId) continue;
        if (!children.has(task.parentTaskId)) children.set(task.parentTaskId, []);
        children.get(task.parentTaskId).push(task);
      }
      const readiness = new Map();
      const returned = async (task, seen = new Set()) => {
        if (readiness.has(task.id)) return readiness.get(task.id);
        if (seen.has(task.id)) return false;
        seen.add(task.id);
        let ready = !inflight.has(task.sessionPath) && !sessionActive(task);
        for (const child of children.get(task.id) || []) {
          const notice = await notification(child.id);
          if (!TERMINAL.has(child.status) || child.workerAlive ||
            (child.delivery === 'web' && !child.cancelRequested && child.status !== 'cancelled' && !['delivered', 'cancelled'].includes(notice?.state)) ||
            !(await returned(child, new Set(seen)))) ready = false;
        }
        readiness.set(task.id, ready); return ready;
      };
      const groups = new Map();
      for (const t of tasks) {
        if (!t.parentSessionPath) continue;
        if (t.delivery !== 'web') {
          // No callback reaches a terminal parent's model: a quiet worker
          // there is the person's to hear.
          if (!TERMINAL.has(t.status)) for (const facts of await dueAttention([t])) await tellPerson(facts, 'terminal-parent');
          continue;
        }
        if (!groups.has(t.parentSessionPath)) groups.set(t.parentSessionPath, []);
        groups.get(t.parentSessionPath).push(t);
      }
      for (const [parent, siblings] of groups) {
        if (stopped || inflight.has(parent)) continue;
        const pending = [];
        for (const t of siblings) {
          if (!TERMINAL.has(t.status)) continue;
          const n = await notification(t.id);
          if (n?.state === 'delivered' || n?.state === 'cancelled') continue;
          if (t.status === 'cancelled' || t.cancelRequested || t.paused) {
            if (t.status === 'cancelled' || t.cancelRequested) await saveNotification(t.id, { state: 'cancelled' });
            continue;
          }
          if (n?.retryAt && n.retryAt > now()) continue;
          // A parent's initial print process can finish before its children.
          // Deliver upward only after nested callbacks have finished their work.
          if (!(await returned(t))) continue;
          pending.push({ task: t, notification: n });
        }
        const running = siblings.filter(t => !TERMINAL.has(t.status));
        // Results that come back close together share one parent turn; a
        // result never waits on a sibling that is still at work (one stuck
        // worker once held three finished ones back for four hours). It
        // waits until no other result arrived for settleMs, at most
        // maxBatchWaitMs after the first; when nothing else is running,
        // there is nothing to wait for.
        let hold = false;
        if (pending.length && running.length) {
          const times = pending.map(p => returnedAt(p.task));
          hold = now() - Math.max(...times) < settleMs && now() - Math.min(...times) < maxBatchWaitMs;
        }
        const quiet = [];
        for (const facts of await dueAttention(running)) {
          // A paused subtree is being handled by hand: its parent is not
          // woken about it, the person hears.
          if (facts.task.paused) await tellPerson(facts, 'paused');
          else quiet.push(facts);
        }
        // A parent woken for a quiet worker also gets every result waiting.
        if (!quiet.length && (!pending.length || hold)) continue;
        const state = await reachOf(parent);
        if (state !== 'ready') {
          // Results wait for the parent. A quiet worker waits too while the
          // parent is at work (it hears when it is free); when no agent
          // turn can start there, the person hears now.
          if (state === 'unreachable') for (const facts of quiet) await tellPerson(facts, 'parent-unreachable');
          continue;
        }
        let session;
        try { session = await sessionState(parent); }
        catch { continue; }
        // After a crash, inspect the durable transcript before sending again.
        const fresh = [];
        for (const item of pending) {
          if (item.notification?.deliveryId && session.deliveries.has(item.notification.deliveryId)) {
            await saveNotification(item.task.id, { state: 'delivered', deliveryId: item.notification.deliveryId,
              ...(item.notification.error ? { error: item.notification.error } : {}) });
          } else if (item.task.parentEntryId && !session.branch.has(item.task.parentEntryId)) {
            await saveNotification(item.task.id, { state: 'blocked', error: 'The conversation now follows another branch. Open the launch point to review this result.' });
          } else fresh.push(item.task);
        }
        const tellable = [];
        for (const facts of quiet) {
          if (facts.stored?.deliveryId && session.deliveries.has(facts.stored.deliveryId) && facts.stored.level >= facts.level) {
            await saveAttention(facts.task.id, { ...facts.stored, state: 'delivered' });
          } else if (facts.task.parentEntryId && !session.branch.has(facts.task.parentEntryId)) {
            await tellPerson(facts, 'parent-branch-moved');
          } else tellable.push(facts);
        }
        if (!fresh.length && !tellable.length) continue;
        // Everything still running goes with a result, quiet ones with their
        // facts; a quiet reminder alone is its own, smaller event.
        for (const facts of tellable) facts.report = await reportFor(facts);
        const batch = fresh.slice(0, 64);
        let message, id;
        if (batch.length) {
          id = deliveryId(batch);
          const quietById = new Map(tellable.map(f => [f.task.id, f]));
          const runningFacts = [];
          for (const t of running) {
            if (quietById.has(t.id)) { runningFacts.push(quietById.get(t.id)); continue; }
            const f = await quietFacts(t);
            runningFacts.push({ task: t, elapsed: Number(t.startedAt) > 0 ? quietLabel(now() - Number(t.startedAt)) : '',
              lastOutput: f ? quietLabel(f.quietMs) : '' });
          }
          message = completionMessage(batch, id, { running: runningFacts, attention: tellable });
        } else {
          id = attentionId(tellable);
          message = attentionMessage(tellable, id);
        }
        // Persist the intent before creating a model turn. Its ID also goes into the session.
        for (const t of batch) await saveNotification(t.id, { state: 'delivering', deliveryId: id });
        for (const f of tellable) await saveAttention(f.task.id, { state: 'delivering', deliveryId: id, quietSince: f.quietSince, level: f.level });
        inflight.add(parent);
        // Different parents progress independently. One long review must not
        // prevent another conversation from receiving its completed batch.
        void (async () => {
          try {
            // The initial snapshot predates ownership checks and notification writes.
            const current = new Map((await listAll()).map(t => [t.id, t]));
            const halted = t => { const latest = current.get(t.id); return !latest || latest.cancelRequested || latest.status === 'cancelled' || latest.paused; };
            if (stopped || batch.some(halted) || (!batch.length && tellable.every(f => halted(f.task)))) {
              for (const t of batch) {
                const latest = current.get(t.id);
                await saveNotification(t.id, { state: latest?.cancelRequested || latest?.status === 'cancelled' ? 'cancelled' : 'pending' });
              }
              for (const f of tellable) await dropAttention(f.task.id);
              return;
            }
            await deliver(parent, message);
            signatureCache.delete(parent);
            const saved = await sessionState(parent);
            if (!saved.deliveries.has(id)) throw new Error('Callback did not persist in the parent session.');
            for (const t of batch) await saveNotification(t.id, { state: 'delivered', deliveryId: id });
            for (const f of tellable) await saveAttention(f.task.id, { state: 'delivered', deliveryId: id, quietSince: f.quietSince, level: f.level });
          } catch (e) {
            const current = new Map((await listAll()).map(t => [t.id, t]));
            signatureCache.delete(parent);
            const saved = await sessionState(parent).catch(() => null);
            const landed = !!saved?.deliveries.has(id);
            for (const t of batch) {
              const latest = current.get(t.id);
              await saveNotification(t.id, latest?.cancelRequested || latest?.status === 'cancelled'
                ? { state: 'cancelled', deliveryId: id }
                : landed
                  ? { state: 'delivered', deliveryId: id, error: String(e.message || e) }
                  : { state: 'error', deliveryId: id, error: String(e.message || e), retryAt: now() + 60000 });
            }
            // A parent that cannot take a turn (a usage limit, no model) is
            // exactly when the person must hear about a stuck worker.
            for (const f of tellable) {
              if (landed) await saveAttention(f.task.id, { state: 'delivered', deliveryId: id, quietSince: f.quietSince, level: f.level });
              else await tellPerson(f, 'parent-failed');
            }
          } finally { inflight.delete(parent); await refresh(); }
        })().catch(e => onError('[delegation delivery]', e));
      }
    } finally { delivering = false; await refresh(); }
  }
  // Workers whose results a parent turn already carried. Reading that parent
  // reads them too, but only up to the delivery moment: later activity in a
  // worker conversation is new and stays unread.
  async function reportedDescendants(parentSessionPath) {
    const tasks = await listAll();
    const children = new Map();
    for (const t of tasks) {
      const parent = t.parentTaskId ? tasks.find(p => p.id === t.parentTaskId)?.sessionPath : t.parentSessionPath;
      if (!parent) continue;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(t);
    }
    const out = [], seen = new Set();
    const walk = async session => {
      for (const t of children.get(session) || []) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        const n = await notification(t.id);
        if (!TERMINAL.has(t.status) || n?.state !== 'delivered' || !n.updatedAt) continue;
        out.push({ task: t, deliveredAt: n.updatedAt });
        await walk(t.sessionPath);
      }
    };
    await walk(parentSessionPath);
    return out;
  }
  // Forget a delivered outcome so the next attempt's outcome is delivered.
  async function forget(id) {
    await fs.unlink(path.join(notificationDir, id + '.json')).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
  return { refresh, processPending, snapshot: () => snapshot, stop: () => { stopped = true; }, reportedDescendants, forget };
}

module.exports = { createDelegationCoordinator, inspectDeliverySession, completionMessage, attentionMessage, deliveryId, attentionId, CALLBACK_TYPES, TERMINAL };
