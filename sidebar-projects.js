/* The project directory uses existing index/fold/catalog facts. No disk work
   is needed until the person explicitly asks for folder date or disk size. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SidebarProjects = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MODES = ['recent', 'name', 'count', 'born', 'size'];
  function build(sessions, created, catalog, projectOf, loose = 'Loose conversations', files = []) {
    const rows = new Map(), authoritativePaths = new Set();
    const get = name => {
      if (typeof name !== 'string' || !name || name === '?' || name === loose) return null;
      if (!rows.has(name)) rows.set(name, { name, title: '', cwd: '', count: 0, latest: 0, createdAt: 0 });
      return rows.get(name);
    };
    for (const p of catalog || []) {
      const r = get(p.name); if (!r) continue;
      r.title = p.title || ''; r.cwd = p.cwd || '';
      if (r.cwd) authoritativePaths.add(r.name);
    }
    for (const p of created || []) {
      const r = get(p.name); if (!r) continue;
      r.cwd ||= p.cwd || p.path || ''; r.createdAt = Number(p.createdAt) || 0;
      if (r.cwd) authoritativePaths.add(r.name);
    }
    for (const s of sessions || []) {
      if (s.hiddenFanout) continue;
      const r = get(projectOf(s)); if (!r) continue;
      r.count++;
      r.latest = Math.max(r.latest, Number(s.mtimeMs) || 0, Date.parse(s.lastTs || '') || 0);
      // A folder speaks for the project only if it is the project's own
      // (projectOf the folder alone, folds included): a conversation run in
      // the home folder and assigned to the project would otherwise make
      // the home folder the project's, the shortest parent winning.
      if (!s.cwd || projectOf({ cwd: s.cwd }) !== r.name) continue;
      if (!r.cwd || (!authoritativePaths.has(r.name) && r.cwd.startsWith(s.cwd.replace(/\/$/, '') + '/'))) r.cwd = s.cwd;
    }
    // Editing or opening a file is project activity too. Only enrich known
    // projects; an arbitrary old file label must not invent a broken link.
    for (const f of files) {
      const r = rows.get(f.project), at = Number(f.at);
      if (r && Number.isFinite(at)) r.latest = Math.max(r.latest, at);
    }
    return [...rows.values()];
  }
  function select(rows, { query = '', sort = 'recent', stats = {} } = {}) {
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const list = rows.filter(r => {
      const text = `${r.name} ${r.title} ${r.cwd}`.toLocaleLowerCase();
      return terms.every(term => text.includes(term));
    });
    const metric = r => {
      if (sort === 'name') return r.title || r.name;
      if (sort === 'count') return r.count;
      if (sort === 'recent') return r.latest || r.createdAt;
      const n = stats[r.name]?.[sort];
      return typeof n === 'number' && Number.isFinite(n) && (sort === 'born' ? n > 0 : n >= 0) ? n : null;
    };
    return list.sort((a, b) => {
      const x = metric(a), y = metric(b);
      // Unknown disk facts go last, never masquerade as a measured zero.
      if (x == null && y != null) return 1;
      if (y == null && x != null) return -1;
      const order = sort === 'name' ? String(x).localeCompare(String(y)) : (y ?? 0) - (x ?? 0);
      return order || a.name.localeCompare(b.name);
    });
  }
  return { MODES, build, select };
});
