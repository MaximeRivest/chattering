'use strict';

// The host reads execution records. It never owns worker PIDs or rewrites sessions.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { createReadStream } = require('node:fs');
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'lost']);

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
      if (e.type === 'custom_message' && e.customType === 'delegation-complete' && typeof e.details?.deliveryId === 'string') {
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

function completionMessage(tasks, id) {
  const lines = tasks.map(t => `- ${t.title}: ${t.status}${t.failure ? ` (${t.failure.kind})` : ''}${Number(t.attempt) > 1 ? `, attempt ${t.attempt}` : ''}; review: ${t.review || 'unreviewed'}. Task ${t.id}. Session: ${t.sessionPath}. Results: ${t.outputDir}.` +
    (t.status === 'failed' || t.status === 'lost' ? ` Stopped work keeps its session; delegation_resume can continue it with the same or another model.` : ''));
  return {
    customType: 'delegation-complete', display: true,
    content: 'Delegated work returned. This is a runner event, not a user request.\n' + lines.join('\n') +
      '\nInspect the results and checks before accepting them. Continue only work already authorized by the user. Process success does not mean review passed.',
    details: { deliveryId: id, taskIds: tasks.map(t => t.id), parentEntryIds: [...new Set(tasks.map(t => t.parentEntryId))] },
  };
}

function createDelegationCoordinator({ root, list, listAll = list, decorate = t => t, canDeliver, deliver,
  inspectSession = inspectDeliverySession, onChange = () => {}, onError = console.error, now = Date.now }) {
  const notificationDir = path.join(root, 'notifications');
  let snapshot = { tasks: [], revision: '' }, refreshing = null, delivering = false, stopped = false;
  const inflight = new Set();
  const signatureCache = new Map();
  async function notification(id) {
    try { return JSON.parse(await fs.readFile(path.join(notificationDir, id + '.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; return null; }
  }
  async function saveNotification(id, data) {
    const previous = await notification(id);
    if (previous) { const { updatedAt, ...body } = previous; if (JSON.stringify(body) === JSON.stringify(data)) return; }
    await atomicJson(path.join(notificationDir, id + '.json'), { ...data, updatedAt: now() });
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
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const raw = await list();
      const tasks = [];
      for (const t of raw) {
        const n = await notification(t.id);
        tasks.push(decorate({ ...t, notificationState: n?.state || (TERMINAL.has(t.status) && t.delivery === 'web' ? 'pending' : null), notificationError: n?.error || null }));
      }
      const listing = raw.listing || { total: tasks.length, omitted: 0 };
      const revision = crypto.createHash('sha256').update(JSON.stringify([tasks, listing])).digest('hex');
      if (revision !== snapshot.revision) { snapshot = { tasks, revision, listing }; onChange(snapshot); }
      return snapshot;
    })().finally(() => { refreshing = null; });
    return refreshing;
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
        let ready = !inflight.has(task.sessionPath) && !decorate(task).sessionActive;
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
        if (t.delivery !== 'web' || !t.parentSessionPath) continue;
        if (!groups.has(t.parentSessionPath)) groups.set(t.parentSessionPath, []);
        groups.get(t.parentSessionPath).push(t);
      }
      for (const [parent, siblings] of groups) {
        if (stopped || inflight.has(parent)) continue;
        // A batch produces one attention point, not one model turn per child.
        if (siblings.some(t => !TERMINAL.has(t.status))) continue;
        const pending = [];
        for (const t of siblings) {
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
        if (!pending.length || !(await canDeliver(parent))) continue;
        let state;
        try { state = await sessionState(parent); }
        catch { continue; }
        // After a crash, inspect the durable transcript before sending again.
        const fresh = [];
        for (const item of pending) {
          if (item.notification?.deliveryId && state.deliveries.has(item.notification.deliveryId)) {
            await saveNotification(item.task.id, { state: 'delivered', deliveryId: item.notification.deliveryId,
              ...(item.notification.error ? { error: item.notification.error } : {}) });
          } else if (item.task.parentEntryId && !state.branch.has(item.task.parentEntryId)) {
            await saveNotification(item.task.id, { state: 'blocked', error: 'The conversation now follows another branch. Open the launch point to review this result.' });
          } else fresh.push(item.task);
        }
        if (!fresh.length) continue;
        const batch = fresh.slice(0, 64), id = deliveryId(batch);
        // Persist the intent before creating a model turn. Its ID also goes into the session.
        for (const t of batch) await saveNotification(t.id, { state: 'delivering', deliveryId: id });
        inflight.add(parent);
        // Different parents progress independently. One long review must not
        // prevent another conversation from receiving its completed batch.
        void (async () => {
          try {
            // The initial snapshot predates ownership checks and notification writes.
            const current = new Map((await listAll()).map(t => [t.id, t]));
            const blocked = batch.some(t => {
              const latest = current.get(t.id);
              return !latest || latest.cancelRequested || latest.status === 'cancelled' || latest.paused;
            });
            if (stopped || blocked) {
              for (const t of batch) {
                const latest = current.get(t.id);
                await saveNotification(t.id, { state: latest?.cancelRequested || latest?.status === 'cancelled' ? 'cancelled' : 'pending' });
              }
              return;
            }
            await deliver(parent, completionMessage(batch, id));
            signatureCache.delete(parent);
            const saved = await sessionState(parent);
            if (!saved.deliveries.has(id)) throw new Error('Callback did not persist in the parent session.');
            for (const t of batch) await saveNotification(t.id, { state: 'delivered', deliveryId: id });
          } catch (e) {
            const current = new Map((await listAll()).map(t => [t.id, t]));
            signatureCache.delete(parent);
            const saved = await sessionState(parent).catch(() => null);
            for (const t of batch) {
              const latest = current.get(t.id);
              await saveNotification(t.id, latest?.cancelRequested || latest?.status === 'cancelled'
                ? { state: 'cancelled', deliveryId: id }
                : saved?.deliveries.has(id)
                  ? { state: 'delivered', deliveryId: id, error: String(e.message || e) }
                  : { state: 'error', deliveryId: id, error: String(e.message || e), retryAt: now() + 60000 });
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

module.exports = { createDelegationCoordinator, inspectDeliverySession, completionMessage, deliveryId, TERMINAL };
