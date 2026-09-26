/* Recent file activity: one latest observation per actor and local path.
   Shared by the server store and the sidebar's filtering/render selection. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RecentFiles = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ACTORS = ['human', 'agent'];
  const KINDS = new Set(['opened', 'saved', 'read', 'written', 'edited']);
  const PER_PROJECT = 100, PER_ACTOR = 3000;
  const id = f => f.actor + '\0' + f.path;
  // An absolute local path on any system: /x, C:\x or C:/x, \\server\share.
  // (Shared with the browser, so no path module.)
  const isAbsolute = p => typeof p === 'string' && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
  const newest = (a, b) => b.at - a.at || a.path.localeCompare(b.path) || a.actor.localeCompare(b.actor);
  function observation(raw) {
    if (!raw || typeof raw.path !== 'string' || !isAbsolute(raw.path) || raw.path.includes('\0')) return null;
    const at = Number(raw.at);
    if (!Number.isFinite(at) || at <= 0) return null;
    if (raw.actor != null && !ACTORS.includes(raw.actor)) return null;
    return { path: raw.path, actor: raw.actor || 'human', at, project: String(raw.project || ''),
      kind: KINDS.has(raw.kind) ? raw.kind : 'opened', key: typeof raw.key === 'string' ? raw.key : '' };
  }
  function prune(files) {
    const groups = new Map(), actors = new Map();
    return files.sort(newest).filter(f => {
      const group = f.actor + '\0' + f.project;
      const n = groups.get(group) || 0, total = actors.get(f.actor) || 0;
      if (n >= PER_PROJECT || total >= PER_ACTOR) return false;
      groups.set(group, n + 1); actors.set(f.actor, total + 1); return true;
    });
  }
  function normalize(raw) {
    const state = { version: 2, files: [], dismissed: {} };
    if (!raw) return state;
    for (const [key, at] of Object.entries(raw.dismissed || {})) {
      if (/^(human|agent)\0\//.test(key) && Number.isFinite(Number(at)) && Number(at) > 0) state.dismissed[key] = Number(at);
    }
    merge(state, Array.isArray(raw) ? raw : Array.isArray(raw.files) ? raw.files : []);
    return state;
  }
  function merge(state, incoming) {
    const files = new Map(state.files.map(f => [id(f), f]));
    let changed = false;
    for (const raw of incoming) {
      const f = observation(raw); if (!f) continue;
      const key = id(f), old = files.get(key);
      if (f.at <= (state.dismissed[key] || 0) || (old && old.at >= f.at)) continue;
      files.set(key, { ...f, project: f.project || old?.project || '' }); changed = true;
    }
    if (!changed) return false;
    const next = prune([...files.values()]);
    if (next.length === state.files.length && next.every((f, i) => f === state.files[i])) return false;
    state.files = next;
    return true;
  }
  function forget(state, path, actor = 'human', now = Date.now()) {
    const actors = actor === 'both' ? ACTORS : ACTORS.includes(actor) ? [actor] : [];
    if (!actors.length || typeof path !== 'string' || !isAbsolute(path)) return false;
    for (const who of actors) {
      const key = id({ path, actor: who });
      const record = state.files.find(f => id(f) === key);
      state.dismissed[key] = Math.max(now, record?.at || 0, state.dismissed[key] || 0);
    }
    state.files = state.files.filter(f => f.path !== path || !actors.includes(f.actor));
    return true;
  }
  // Live updates carry only changed paths; scanning a large history must
  // not resend thousands of entries on every new read or edit.
  function diff(previous, next) {
    const before = new Map(previous.map(f => [id(f), f])), after = new Map(next.map(f => [id(f), f]));
    return {
      upsert: next.filter(f => { const old = before.get(id(f)); return !old || old.at !== f.at || old.kind !== f.kind || old.project !== f.project || old.key !== f.key; }),
      remove: previous.filter(f => !after.has(id(f))).map(f => ({ actor: f.actor, path: f.path })),
    };
  }
  function applyDelta(rows, delta) {
    const files = new Map(rows.map(observation).filter(Boolean).map(f => [id(f), f]));
    for (const f of delta.remove || []) if (f && ACTORS.includes(f.actor) && typeof f.path === 'string') files.delete(id(f));
    for (const raw of delta.upsert || []) { const f = observation(raw); if (f) files.set(id(f), f); }
    return [...files.values()].sort(newest);
  }
  // Filter before deduplicating: the newest agent edit must not displace an
  // older human visit when the person chooses the human-only view.
  function select(rows, { actor = 'human', project = '', projectOf = f => f.project, limit = 8 } = {}) {
    const seen = new Set();
    return rows.map(observation).filter(Boolean).filter(f =>
      (actor === 'both' || f.actor === actor) && (!project || projectOf(f) === project))
      .sort(newest).filter(f => { if (seen.has(f.path)) return false; seen.add(f.path); return true; }).slice(0, limit);
  }
  // Successful named local file operations only. Ignore pending/failed calls,
  // arbitrary paths in prose and shell commands. Original times make rescans
  // and copied fork histories idempotent rather than fresh activity.
  function fromMessages(messages, { project = '', key = '', resolvePath } = {}) {
    const results = new Map();
    for (const m of messages) if (m.role === 'toolresult' && m.tid) results.set(m.tid, m);
    const latest = new Map();
    for (const m of messages) {
      if (m.role !== 'tool' || !m.id || !m.path) continue;
      const result = results.get(m.id);
      if (!result || result.err) continue;
      const name = String(m.name || '').toLowerCase().split('.').pop();
      const kind = name === 'read' ? 'read' : name === 'write' ? 'written'
        : ['edit', 'multiedit', 'multi_edit', 'notebookedit', 'notebook_edit'].includes(name) ? 'edited' : '';
      if (!kind) continue;
      const at = Date.parse(result.ts || m.ts || '');
      if (!Number.isFinite(at) || at <= 0) continue;
      const path = resolvePath(m.path);
      const f = observation({ path, at, kind, actor: 'agent', project, key });
      if (f && (!latest.has(path) || latest.get(path).at < at)) latest.set(path, f);
    }
    return [...latest.values()];
  }
  return { normalize, merge, forget, select, fromMessages, diff, applyDelta, PER_PROJECT, PER_ACTOR };
});
