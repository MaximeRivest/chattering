'use strict';
// list-groups.js — groups in the side list (design/96).
//
// A person gives a name to some of the conversations they keep open
// ("SegBench", "Later", "Lily's setup") and folds the groups they are not
// working in. Folding is the back burner: out of the way, never out of
// reach. A folded group still lets through what needs the person (a reply
// nobody read, a run that stopped) and the conversation on screen; once it
// is read and the person moves on, the row tucks back in. The header says
// the rest: how many, who is working, open questions.
//
// Loose rows (in no group) stay on top, as before; groups follow, in the
// person's order. Pinned rows stay on top whatever their group.
//
// The groups are the household's, like the list: they live in the shared
// list state (agentread.js: groups, member) and every device shows the same
// groups and folds. Two things are this device's own: the arrangement "By
// project" (a view of the list by project, which leaves the groups alone)
// and its folds, and the group used last (first in the picker).
//
// Loaded before app.html's main script; the helpers it calls
// (agentReadState, postAgentMarks, agentMarksChanged, sessions, projectOf,
// toast, esc, closeFileActionMenu, dismissAgentConversation…) are globals of
// that script, resolved at call time.

const ListGroups = (() => {
  const LAST = 'chattering.listGroups.last';
  const ARRANGE = 'chattering.listGroups.arrange';
  const PROJECT_FOLD = 'chattering.listGroups.projectFold';
  const HEAD = 'group:', PROJECT_HEAD = 'project:';
  const LATER = 'Later';

  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  let tidy = null;              // a proposal on screen: { groups, member, moved, created }
  let renaming = null;          // the group whose name is being edited here
  const selection = new Set();  // rows picked with Ctrl/Shift-click or Space
  let anchor = null;            // where a Shift-click range starts
  const names = new Map();      // keys → the model's name for them, this page

  // ---- reading the state ----
  const st = () => tidy || agentReadState;
  const groupsOf = s => (s && s.groups) || {};
  const memberOf = s => (s && s.member) || {};
  function ordered(s = st()) {
    return Object.entries(groupsOf(s)).map(([id, g]) => ({ id, ...g }))
      .sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
  }
  function groupOf(key, s = st()) {
    const id = memberOf(s)[key];
    const g = id && groupsOf(s)[id];
    return g ? { id, ...g } : null;
  }
  const arrange = () => read(ARRANGE, 'groups') === 'project' ? 'project' : 'groups';
  const headKey = id => HEAD + id;
  const isHead = key => typeof key === 'string' && (key.startsWith(HEAD) || key.startsWith(PROJECT_HEAD));
  const headId = key => key.startsWith(HEAD) ? key.slice(HEAD.length) : null;
  const titleOf = key => { const s = sessions.find(x => x.key === key); return (s && (s.title || s.timelineTitle)) || 'conversation'; };
  const short = (t, n = 36) => t.length > n ? t.slice(0, n - 1) + '…' : t;

  // ---- changing it ----
  // Every change: applied here at once, sent as the difference, with an
  // Undo that sends the difference back (design/59's close does the same).
  const snapshot = () => ({ groups: JSON.parse(JSON.stringify(groupsOf(agentReadState))), member: { ...memberOf(agentReadState) } });
  function diff(a, b) {
    const groups = {}, member = {};
    for (const id of new Set([...Object.keys(a.groups), ...Object.keys(b.groups)])) {
      const x = a.groups[id], y = b.groups[id];
      if (!y) { if (x) groups[id] = 0; continue; }
      if (!x) { groups[id] = { ...y }; continue; }
      const d = {};
      for (const f of ['name', 'order', 'folded']) if (x[f] !== y[f]) d[f] = y[f];
      if (Object.keys(d).length) groups[id] = d;
    }
    for (const k of new Set([...Object.keys(a.member), ...Object.keys(b.member)])) if (a.member[k] !== b.member[k]) member[k] = b.member[k] || '';
    return Object.keys(groups).length || Object.keys(member).length ? { groups, member } : null;
  }
  function settle(s) {
    // As the server does: a group nobody is in is gone.
    const used = new Set(Object.values(s.member));
    for (const id of Object.keys(s.groups)) if (!used.has(id)) delete s.groups[id];
  }
  function commit(mutate, { say = '', undo = true } = {}) {
    if (!agentReadState.groups) agentReadState.groups = {};
    if (!agentReadState.member) agentReadState.member = {};
    const before = snapshot();
    mutate(agentReadState);
    settle(agentReadState);
    const change = diff(before, snapshot());
    if (!change) return null;
    agentMarksChanged();
    postAgentMarks({ grouping: change });
    if (say) toast(say + (undo ? ' · Undo' : ''), undo ? () => restore(before) : null, '', { repeat: true });
    return change;
  }
  function restore(to) {
    const change = diff(snapshot(), to);
    if (!change) return;
    agentReadState.groups = JSON.parse(JSON.stringify(to.groups));
    agentReadState.member = { ...to.member };
    agentMarksChanged();
    postAgentMarks({ grouping: change });
  }
  const newId = () => 'g' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const topOrder = s => Math.min(0, ...Object.values(s.groups).map(g => g.order)) - 1;

  // Put `keys` in group `id`, or in a new group called `name`, or out of
  // any group (neither). Says where they went, with Undo.
  function move(keys, id, { name = '', quiet = false, fresh = false } = {}) {
    keys = keys.filter(Boolean);
    if (!keys.length) return null;
    let target = id;
    const what = keys.length === 1 ? '“' + short(titleOf(keys[0])) + '”' : keys.length + ' conversations';
    const dest = id ? (agentReadState.groups[id] || {}).name : name;
    const change = commit(s => {
      if (!target && name) {
        const same = !fresh && Object.entries(s.groups).find(([, g]) => g.name.toLocaleLowerCase() === name.toLocaleLowerCase());
        if (same) target = same[0];
        else { target = newId(); s.groups[target] = { name, order: topOrder(s), folded: false }; }
      }
      for (const k of keys) { if (target) s.member[k] = target; else delete s.member[k]; }
    }, { say: quiet ? '' : dest ? 'Moved ' + what + ' to ' + dest : 'Took ' + what + ' out of its group' });
    if (target) { write(LAST, target); nudge(target); }
    selection.clear();
    return change ? target : null;
  }
  // The header that received the rows glows once: a row that went into a
  // folded group otherwise just vanishes.
  function nudge(id) {
    setTimeout(() => {
      const h = document.querySelector(`#agentsUnread .ag-ghead[data-key="${CSS.escape(headKey(id))}"]`);
      if (h && typeof listMotionOn === 'function' && listMotionOn()) h.animate([{ backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)' }, { backgroundColor: 'transparent' }], { duration: 700, easing: 'ease-out' });
    }, 60);
  }
  function setFolded(id, folded) {
    if (id && id.startsWith(PROJECT_HEAD)) {
      const f = read(PROJECT_FOLD, {});
      if (folded) f[id.slice(PROJECT_HEAD.length)] = 1; else delete f[id.slice(PROJECT_HEAD.length)];
      write(PROJECT_FOLD, f); renderAgentsPop(false); return;
    }
    if (!agentReadState.groups || !agentReadState.groups[id]) return;
    commit(s => { s.groups[id].folded = !!folded; });
  }
  function toggle(key) {
    if (key.startsWith(PROJECT_HEAD)) return setFolded(key, !read(PROJECT_FOLD, {})[key.slice(PROJECT_HEAD.length)]);
    const id = headId(key), g = id && agentReadState.groups && agentReadState.groups[id];
    if (g) setFolded(id, !g.folded);
  }
  function foldAll(folded = true) {
    if (arrange() === 'project') {
      const f = {};
      if (folded) for (const s of listedSessions()) f[projectKeyOf(s)] = 1;
      write(PROJECT_FOLD, f); renderAgentsPop(false); return;
    }
    commit(s => { for (const g of Object.values(s.groups)) g.folded = folded; });
  }
  function rename(id, name) {
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name || !agentReadState.groups[id] || agentReadState.groups[id].name === name) return;
    commit(s => { s.groups[id].name = name; });
  }
  function ungroup(id) {
    const g = agentReadState.groups[id];
    if (!g) return;
    commit(s => { delete s.groups[id]; for (const [k, v] of Object.entries(s.member)) if (v === id) delete s.member[k]; }, { say: 'Ungrouped “' + g.name + '”' });
  }
  function shift(id, by) {
    const list = ordered(agentReadState);
    const at = list.findIndex(g => g.id === id), to = at + by;
    if (at < 0 || to < 0 || to >= list.length) return;
    const [g] = list.splice(at, 1);
    list.splice(to, 0, g);
    commit(s => list.forEach((x, i) => { s.groups[x.id].order = i; }));
  }
  function placeBefore(id, beforeId) {
    const list = ordered(agentReadState).filter(g => g.id !== id);
    const g = ordered(agentReadState).find(x => x.id === id);
    if (!g) return;
    const at = beforeId ? list.findIndex(x => x.id === beforeId) : list.length;
    list.splice(at < 0 ? list.length : at, 0, g);
    commit(s => list.forEach((x, i) => { s.groups[x.id].order = i; }));
  }
  function closeAll(id) {
    const keys = listedSessions().filter(s => memberOf(agentReadState)[s.key] === id).map(s => s.key);
    if (!keys.length) return;
    const before = { ...agentReadState.dismissed };
    for (const k of keys) dismissAgentConversation(k, { undo: false });
    const g = agentReadState.groups[id];
    toast(`Closed ${keys.length} in “${g ? g.name : 'the group'}” · Undo`, () => { for (const k of keys) if (!(k in before)) restoreAgentConversation(k); }, '', { repeat: true });
  }
  // A fork or a conversation started from a grouped one joins its group;
  // so does one started with a group's ＋ (the draft carries the group).
  function follow(fromKey, newKey) {
    const id = fromKey && memberOf(agentReadState)[fromKey];
    if (id && newKey) join(newKey, id);
  }
  function join(key, id) {
    if (!key || !id || !agentReadState.groups || !agentReadState.groups[id]) return;
    commit(s => { s.member[key] = id; });
  }

  // ---- the layout the list is drawn from ----
  const projectKeyOf = s => { const p = projectOf(s); return !p || p === '?' ? LOOSE_PROJECT : p; };
  // listed: [{ key, s }] in the list's order. info(key) → { state, unread }.
  // Returns the loose rows and the sections; each section has its rows, the
  // ones shown (all, or when folded those that need the person and the one
  // on screen), and a key for its header.
  function layout(listed, { info, current }) {
    const shows = r => { const i = info(r.key); return i.unread || i.state === 'stopped' || r.key === current; };
    const sections = [], loose = [];
    if (arrange() === 'project' && !tidy) {
      const folds = read(PROJECT_FOLD, {});
      const by = new Map();
      for (const r of listed) {
        if (!r.s || agentIsPinned(r.key)) { loose.push(r); continue; }
        const p = projectKeyOf(r.s);
        if (!by.has(p)) by.set(p, []);
        by.get(p).push(r);
      }
      for (const [p, rows] of by) {
        const folded = !!folds[p];
        sections.push({ key: PROJECT_HEAD + p, project: p, name: p === LOOSE_PROJECT ? 'No project' : ProjectScope.label(p), folded, rows, visible: folded ? rows.filter(shows) : rows });
      }
      return { loose, sections };
    }
    const s = st(), byGroup = new Map(ordered(s).map(g => [g.id, { g, rows: [] }]));
    for (const r of listed) {
      const id = memberOf(s)[r.key];
      if (r.s && id && byGroup.has(id) && !agentIsPinned(r.key)) byGroup.get(id).rows.push(r);
      else loose.push(r);
    }
    for (const { g, rows } of byGroup.values()) {
      if (!rows.length) continue;
      sections.push({ key: headKey(g.id), id: g.id, name: g.name, folded: g.folded, created: !!(tidy && tidy.created.has(g.id)), rows, visible: g.folded ? rows.filter(shows) : rows });
    }
    return { loose, sections };
  }

  const CHEV = '<svg class="ag-chev" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // A header: fold chevron, name, count; folded, what is going on inside.
  function headHtml(sec, { info, typingHtml }) {
    const hidden = sec.folded ? sec.rows.filter(r => !sec.visible.includes(r)) : [];
    const working = hidden.filter(r => info(r.key).state === 'working').length;
    const asks = hidden.filter(r => info(r.key).state === 'asks').length;
    const sum = (working ? `<span class="ag-gwork" title="${working} working">${typingHtml}${working > 1 ? `<span class="ag-gn">${working}</span>` : ''}</span>` : '')
      + (asks ? `<span class="ag-gask" title="${asks} waiting for your answer">?${asks > 1 ? `<span class="ag-gn">${asks}</span>` : ''}</span>` : '');
    const said = [sec.rows.length + ' conversation' + (sec.rows.length === 1 ? '' : 's'), sec.folded ? 'folded' : 'open', working ? working + ' working' : '', asks ? asks + ' waiting for your answer' : ''].filter(Boolean).join(', ');
    if (renaming && sec.id === renaming) {
      return `<div class="ag-ghead renaming open" data-key="${esc(sec.key)}">${CHEV}<input class="ag-grename" value="${esc(sec.name)}" maxlength="60" aria-label="Group name" spellcheck="false"></div>`;
    }
    const name = sec.project
      ? (sec.project === LOOSE_PROJECT ? `<span class="ag-gname">${esc(sec.name)}</span>` : `<a class="ag-gname" href="#project=${encodeURIComponent(sec.project)}" data-open-project="${esc(sec.project)}" title="Open project · ${esc(sec.project)}">${esc(sec.name)}</a>`)
      : `<span class="ag-gname" title="${esc(sec.name)}">${esc(sec.name)}</span>`;
    const acts = sec.id && !tidy
      ? `<span class="ag-acts"><button class="ag-gnew" data-gnew="${esc(sec.id)}" title="New conversation in this group" aria-label="New conversation in ${esc(sec.name)}">+</button><button class="ag-gmore" data-gmore="${esc(sec.id)}" title="Rename, ungroup, close all…" aria-label="Group actions" aria-haspopup="menu">⋯</button></span>` : '';
    return `<div class="ag-ghead${sec.folded ? '' : ' open'}${sec.created ? ' proposed' : ''}" data-key="${esc(sec.key)}" role="button" aria-expanded="${!sec.folded}" draggable="${sec.id && !tidy && dragOn() ? 'true' : 'false'}" title="${sec.folded ? 'Unfold' : 'Fold'}">` +
      `${CHEV}${name}<span class="ag-gcount">${sec.rows.length}</span>${sec.created ? '<span class="ag-gnewtag">new</span>' : ''}<span class="sr-only">, ${esc(said)}</span>` +
      `<span class="ag-gsum">${sum}</span>${acts}</div>`;
  }
  // The list's items for reconcileList: loose rows, then each section's
  // header and rows, marked so a section reads as one tray.
  function items(lay, { loose, row, info, typingHtml }) {
    const out = loose.map(r => ({ key: r.key, html: row(r.s, r.key) }));
    if (lay.sections.length && !tidy && arrange() === 'groups') out.push({ key: 'loose-drop', cls: 'ag-loose-drop', html: '<div class="ag-drop-out">Drop here to take it out of its group</div>' });
    for (const sec of lay.sections) {
      const last = sec.visible.length - 1;
      out.push({ key: sec.key, cls: 'ag-tray ag-tray-first' + (last < 0 ? ' ag-tray-last' : ''), html: headHtml(sec, { info, typingHtml }) });
      sec.visible.forEach((r, i) => out.push({ key: r.key, cls: 'ag-tray' + (i === last ? ' ag-tray-last' : ''), html: row(r.s, r.key, { peek: sec.folded, inProject: !!sec.project }) }));
    }
    return out;
  }
  // The line above the list: a proposal to apply, or the arrangement in use.
  function barHtml() {
    if (tidy) return `<div class="ag-tidybar" role="status"><span>Tidy up: <b>${tidy.moved}</b> conversation${tidy.moved === 1 ? '' : 's'} into ${tidy.created.size ? `<b>${tidy.created.size}</b> new group${tidy.created.size === 1 ? '' : 's'}` : 'your groups'}. Working, unread and recent ones stay on top.</span><span class="ag-tidyacts"><button type="button" data-tidy="cancel">Cancel</button><button type="button" class="primary" data-tidy="apply">Apply</button></span></div>`;
    if (arrange() === 'project') return `<div class="ag-lensbar">By project · <button type="button" data-arrange="groups">back to your groups</button></div>`;
    return '';
  }
  function selbarHtml() {
    if (selection.size < 2) return '';
    return `<div class="ag-selbar" role="toolbar" aria-label="${selection.size} selected"><span>${selection.size} selected</span><button type="button" class="primary" data-sel="group" title="Move to a group (g)">Group…</button><button type="button" data-sel="close" title="Close them (Delete)">Close</button><button type="button" data-sel="clear" title="Clear the selection (Esc)" aria-label="Clear the selection">✕</button></div>`;
  }

  // ---- tidy up ----
  // A proposal, never a silent change. Rows in use stay loose: working,
  // unread, stopped, on screen, or active in the last hour. Of the rest,
  // two or more from one project gather into a folded group named after it
  // (or join a group of that name); what is left goes to "Later".
  function proposeTidy(listed, info, current) {
    const base = snapshot();
    const s = snapshot();
    const created = new Set();
    const now = Date.now();
    const inUse = r => { const i = info(r.key); return i.state === 'working' || i.state === 'stopped' || i.unread || r.key === current || now - agentActivityAt(r.s) < 3600e3; };
    const free = listed.filter(r => r.s && !agentIsPinned(r.key) && !(s.member[r.key] && s.groups[s.member[r.key]]) && !inUse(r));
    const groupNamed = (name, folded) => {
      const found = Object.entries(s.groups).find(([, g]) => g.name.toLocaleLowerCase() === name.toLocaleLowerCase());
      if (found) return found[0];
      const id = newId();
      s.groups[id] = { name, order: Math.max(-1, ...Object.values(s.groups).map(g => g.order)) + 1, folded };
      created.add(id);
      return id;
    };
    const byProject = new Map();
    for (const r of free) { const p = projectKeyOf(r.s); if (!byProject.has(p)) byProject.set(p, []); byProject.get(p).push(r); }
    const later = [];
    let moved = 0;
    for (const [p, rows] of byProject) {
      if (p === LOOSE_PROJECT || rows.length < 2) { later.push(...rows); continue; }
      const id = groupNamed(ProjectScope.label(p), true);
      for (const r of rows) { s.member[r.key] = id; moved++; }
    }
    if (later.length) { const id = groupNamed(LATER, true); for (const r of later) { s.member[r.key] = id; moved++; } }
    return moved ? { groups: s.groups, member: s.member, moved, created, change: diff(base, s) } : null;
  }
  function startTidy() {
    if (arrange() !== 'groups') write(ARRANGE, 'groups');
    const { listed, info, current } = lastCtx || {};
    const p = listed && proposeTidy(listed, info, current);
    if (!p) { toast('Nothing to tidy: what is open is in use or already in a group'); renderAgentsPop(false); return; }
    tidy = p;
    renderAgentsPop(false);
  }
  function applyTidy() {
    if (!tidy) return;
    const t = tidy; tidy = null;
    // The proposal's difference, on top of whatever changed meanwhile.
    commit(s => {
      for (const [id, g] of Object.entries(t.change.groups)) if (g) s.groups[id] = { ...(s.groups[id] || {}), ...g };
      for (const [k, id] of Object.entries(t.change.member)) if (id && s.groups[id]) s.member[k] = id;
    }, { say: `Tidied ${t.moved} conversation${t.moved === 1 ? '' : 's'}. Double-click a group to rename it` });
  }
  function cancelTidy() { tidy = null; renderAgentsPop(false); }

  // ---- menus and the picker ----
  function menu(anchorEl, title, entries, at) {
    closeFileActionMenu();
    const m = document.createElement('div');
    m.className = 'file-action-menu ag-menu';
    m.setAttribute('role', 'menu');
    const list = entries.filter(Boolean);
    m.innerHTML = (title ? `<div class="file-action-head">${esc(title)}</div>` : '') + list.map((it, i) => it === '-' ? '<hr class="ag-menu-sep">'
      : `<button type="button" role="${it.radio !== undefined ? 'menuitemradio' : 'menuitem'}"${it.radio !== undefined ? ` aria-checked="${!!it.radio}"` : ''} data-ag-action="${i}"${it.tip ? ` title="${esc(it.tip)}"` : ''}>${it.radio !== undefined ? `<span class="ag-radio${it.radio ? ' on' : ''}" aria-hidden="true"></span>` : ''}${esc(it.label)}${it.keys ? `<kbd class="ag-menu-key">${esc(it.keys)}</kbd>` : ''}</button>`).join('');
    document.body.appendChild(m);
    let x = at ? at.x : 0, y = at ? at.y : 0;
    if (anchorEl) { const r = anchorEl.getBoundingClientRect(); x = r.left; y = r.bottom + 2; }
    m.style.left = Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8)) + 'px';
    if (anchorEl) anchorEl.setAttribute('aria-expanded', 'true');
    m.querySelectorAll('[data-ag-action]').forEach(b => b.onclick = ev => { ev.stopPropagation(); const it = list[Number(b.dataset.agAction)]; closeFileActionMenu(); it.run(); });
    m.querySelector('button')?.focus();
  }
  function groupMenu(id, anchorEl, at) {
    const g = agentReadState.groups && agentReadState.groups[id];
    if (!g) return;
    const list = ordered(agentReadState), i = list.findIndex(x => x.id === id);
    const n = listedSessions().filter(s => memberOf(agentReadState)[s.key] === id).length;
    menu(anchorEl, g.name, [
      { label: 'Rename', keys: 'F2', run: () => startRename(id) },
      { label: 'New conversation in this group', run: () => newIn(id) },
      { label: g.folded ? 'Unfold' : 'Fold', keys: g.folded ? '→' : '←', run: () => setFolded(id, !g.folded) },
      '-',
      i > 0 ? { label: 'Move up', run: () => shift(id, -1) } : null,
      i < list.length - 1 ? { label: 'Move down', run: () => shift(id, 1) } : null,
      { label: 'Ungroup', tip: 'The conversations stay open, outside any group.', run: () => ungroup(id) },
      n ? { label: `Close all ${n}`, tip: 'They leave the list; one that replies again comes back, in this group.', run: () => closeAll(id) } : null,
    ], at);
  }
  function arrangeMenu(anchorEl) {
    const a = arrange();
    menu(anchorEl, 'Arrange open conversations', [
      { label: 'Your groups', radio: a === 'groups', run: () => { write(ARRANGE, 'groups'); renderAgentsPop(false); } },
      { label: 'By project', radio: a === 'project', tip: 'A view by project, on this device. Your groups stay as they are.', run: () => { tidy = null; write(ARRANGE, 'project'); renderAgentsPop(false); } },
      '-',
      { label: 'Tidy up…', tip: 'Proposes groups for what you are not using; nothing moves until you apply.', run: startTidy },
      { label: 'Fold every group', keys: '⇧←', run: () => foldAll(true) },
      { label: 'Unfold every group', keys: '⇧→', run: () => foldAll(false) },
    ]);
  }
  // A name for a new group: one project names itself; several ask the
  // model once (per set of conversations, per page).
  function localName(keys) {
    const ps = [...new Set(keys.map(k => { const s = sessions.find(x => x.key === k); return s ? projectKeyOf(s) : LOOSE_PROJECT; }))];
    return ps.length === 1 && ps[0] !== LOOSE_PROJECT ? ProjectScope.label(ps[0]) : '';
  }
  function modelName(keys) {
    const sig = [...keys].sort().join('\n');
    if (!names.has(sig)) names.set(sig, fetch('/api/agent-read/group-name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys }) })
      .then(r => r.ok ? r.json() : null).then(d => (d && d.name) || '').catch(() => ''));
    return names.get(sig);
  }
  function picker(keys, anchorEl) {
    keys = keys.filter(k => sessions.some(s => s.key === k));
    if (!keys.length) return;
    closeFileActionMenu();
    document.querySelectorAll('.mpick').forEach(el => el.remove());
    // The keyboard cursor comes back after the choice only if it was there.
    const fromKeys = sideLayoutOn() && agentsKbd;
    const pop = document.createElement('div');
    pop.className = 'mpick ag-group-picker';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Move to a group');
    pop.innerHTML = `<div class="ag-gp-head">${keys.length > 1 ? `Move ${keys.length} conversations to` : 'Move “' + esc(short(titleOf(keys[0]), 44)) + '” to'}</div><div class="mp-top"><input type="search" class="mp-filter" placeholder="Group name…" aria-label="Group name" autocomplete="off" spellcheck="false"></div><div class="mp-list" role="listbox"></div><div class="ag-gp-hint"><kbd>Enter</kbd> move · <kbd>Esc</kbd> cancel</div>`;
    document.body.appendChild(pop);
    const input = pop.querySelector('input'), list = pop.querySelector('.mp-list');
    const s = agentReadState;
    const all = ordered(s);
    const last = read(LAST, '');
    const visible = new Set(listedSessions().map(x => memberOf(s)[x.key]).filter(Boolean));
    const grouped = keys.some(k => memberOf(s)[k]);
    const local = localName(keys);
    let suggested = local, asking = false, hi = 0, options = [];
    if (!local && keys.length > 1) {
      asking = true;
      modelName(keys).then(n => { asking = false; suggested = n; if (pop.isConnected) paint(); });
    }
    const close = (focus = true) => {
      pop.remove();
      document.removeEventListener('pointerdown', outside, true);
      if (focus && fromKeys) { setAgentsKbd(true); selectAgentRow(keys[keys.length - 1], true); }
    };
    const outside = e => { if (!pop.contains(e.target)) close(false); };
    const choose = o => {
      if (!o || o.pending) return;
      close();
      if (o.kind === 'group') move(keys, o.id);
      else if (o.kind === 'new') move(keys, null, { name: o.name });
      else if (o.kind === 'out') move(keys, null);
    };
    function paint() {
      const q = input.value.replace(/\s+/g, ' ').trim(), ql = q.toLocaleLowerCase();
      options = [];
      const sorted = [...all].sort((a, b) => (b.id === last) - (a.id === last) || visible.has(b.id) - visible.has(a.id));
      for (const g of sorted) {
        if (ql && !g.name.toLocaleLowerCase().includes(ql)) continue;
        if (keys.every(k => memberOf(s)[k] === g.id)) continue;
        options.push({ kind: 'group', id: g.id, label: g.name, note: [g.id === last ? 'last used' : '', !visible.has(g.id) ? 'nothing open' : g.folded ? 'folded' : ''].filter(Boolean).join(' · ') });
      }
      const exists = n => all.some(g => g.name.toLocaleLowerCase() === n.toLocaleLowerCase());
      if (q && !exists(q)) options.push({ kind: 'new', name: q, label: `New group “${q}”` });
      if (!q) {
        if (asking) options.push({ kind: 'new', pending: true, label: 'New group', note: 'naming…' });
        else if (suggested && !exists(suggested)) options.push({ kind: 'new', name: suggested, label: `New group “${suggested}”`, note: local ? 'same project' : 'suggested' });
        if (!exists(LATER) && suggested !== LATER) options.push({ kind: 'new', name: LATER, label: `New group “${LATER}”`, note: 'to fold away' });
      }
      if (grouped && !q) options.push({ kind: 'out', label: 'Take out of its group' });
      hi = Math.max(0, Math.min(hi, options.length - 1));
      list.innerHTML = options.map((o, i) => `<button type="button" class="mp-row${i === hi ? ' hi' : ''}${o.pending ? ' pending' : ''}" role="option" aria-selected="${i === hi}" data-i="${i}"><span class="ag-gp-ic" aria-hidden="true">${o.kind === 'group' ? '▤' : o.kind === 'out' ? '↖' : '+'}</span><b>${esc(o.label)}</b>${o.note ? `<span>${esc(o.note)}</span>` : ''}</button>`).join('')
        || '<div class="mp-empty">Type a name for a new group.</div>';
      list.querySelectorAll('[data-i]').forEach(b => b.onclick = e => { e.stopPropagation(); choose(options[Number(b.dataset.i)]); });
    }
    input.oninput = () => { hi = 0; paint(); };
    pop.onkeydown = e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); hi = (hi + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % Math.max(1, options.length); paint(); list.querySelector('.hi')?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(options[hi]); }
    };
    paint();
    // Below the anchor on a desk; a bottom sheet on a phone (.mpick).
    if (!matchMedia('(max-width: 700px)').matches) {
      const r = (anchorEl || $('agentsUnread')).getBoundingClientRect();
      pop.style.width = '280px';
      pop.style.left = Math.max(8, Math.min(r.left + 8, innerWidth - pop.offsetWidth - 8)) + 'px';
      const below = innerHeight - r.bottom - 12;
      pop.style.top = (below > pop.offsetHeight ? r.bottom + 4 : Math.max(8, r.top - pop.offsetHeight - 4)) + 'px';
    }
    input.focus();
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
  }

  // ---- renaming in place ----
  function startRename(id) {
    if (!agentReadState.groups || !agentReadState.groups[id]) return;
    const fromKeys = sideLayoutOn() && agentsKbd;
    renaming = id;
    renderAgentsPop(false);
    const input = document.querySelector('#agentsUnread .ag-grename');
    if (!input) { renaming = null; return; }
    input.closest('.ag-item')?.scrollIntoView({ block: 'nearest' });
    input.focus({ preventScroll: true }); input.select();
    let done = false;
    const finish = save => {
      if (done) return; done = true;
      const v = input.value;
      renaming = null;
      if (save) rename(id, v);
      renderAgentsPop(false);
      if (fromKeys) { setAgentsKbd(true); selectAgentRow(headKey(id), true); }
    };
    input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    input.onblur = () => finish(true);
    input.onclick = e => e.stopPropagation();
    return input;
  }

  // ---- a new conversation in a group ----
  function newIn(id) {
    const g = agentReadState.groups && agentReadState.groups[id];
    if (!g) return;
    const rows = listedSessions().filter(s => memberOf(agentReadState)[s.key] === id);
    const ps = [...new Set(rows.map(projectKeyOf))];
    let folder = '';
    if (ps.length === 1 && ps[0] !== LOOSE_PROJECT) {
      const p = (typeof sidebarProjectRows === 'function' ? sidebarProjectRows() : []).find(x => x.name === ps[0]);
      folder = (p && p.cwd) || '';
    }
    if (g.folded) setFolded(id, false);
    if (sideLayoutOn()) setAgentsKbd(false); else toggleAgents(false);
    if (typeof closePhoneSheets === 'function') closePhoneSheets();
    // A fresh draft that carries the group (conversation-draft.js).
    const d = { ...newDraft(), folder, group: id };
    saveDraft(d);
    showDraft(d.id);
  }

  // ---- selection ----
  function rowKeys() { return agentRows().map(r => r.dataset.key).filter(k => k && !isHead(k) && sessions.some(s => s.key === k)); }
  function pick(key, { range = false, add = true } = {}) {
    if (range && anchor) {
      const keys = rowKeys(), a = keys.indexOf(anchor), b = keys.indexOf(key);
      if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selection.add(keys[i]);
    } else if (add && !selection.has(key)) selection.add(key);
    else selection.delete(key);
    if (!range) anchor = key;
    renderAgentsPop(false);
  }
  function clearSelection() { if (!selection.size) return false; selection.clear(); renderAgentsPop(false); return true; }
  const picked = cursorKey => selection.size ? [...selection] : cursorKey && !isHead(cursorKey) ? [cursorKey] : [];

  // ---- the list's own events: clicks, keys, drag and drop ----
  // Returns true when the event was a group's (the caller stops there).
  function onClick(e) {
    const tb = e.target.closest('[data-tidy]');
    if (tb) { e.stopPropagation(); tb.dataset.tidy === 'apply' ? applyTidy() : cancelTidy(); return true; }
    const ar = e.target.closest('[data-arrange]');
    if (ar) { e.stopPropagation(); write(ARRANGE, ar.dataset.arrange); renderAgentsPop(false); return true; }
    const sb = e.target.closest('[data-sel]');
    if (sb) {
      e.stopPropagation();
      if (sb.dataset.sel === 'group') picker([...selection], sb);
      else if (sb.dataset.sel === 'close') { const keys = [...selection]; selection.clear(); keys.forEach(k => dismissAgentConversation(k, { undo: false })); toast(`Closed ${keys.length} · Undo`, () => keys.forEach(restoreAgentConversation), '', { repeat: true }); }
      else clearSelection();
      return true;
    }
    const gb = e.target.closest('.ag-group-btn[data-group]');
    if (gb) { e.stopPropagation(); const k = gb.dataset.group; picker(selection.has(k) && selection.size > 1 ? [...selection] : [k], gb.closest('.ag-row')); return true; }
    const gn = e.target.closest('[data-gnew]');
    if (gn) { e.stopPropagation(); newIn(gn.dataset.gnew); return true; }
    const gm = e.target.closest('[data-gmore]');
    if (gm) { e.stopPropagation(); groupMenu(gm.dataset.gmore, gm); return true; }
    const head = e.target.closest('.ag-ghead[data-key]');
    if (head) {
      if (e.target.closest('input, [data-open-project]')) return false;
      e.stopPropagation();
      if (e.detail > 1) return true; // the second click of a double-click renames
      toggle(head.dataset.key);
      return true;
    }
    const row = e.target.closest('.ag-row[data-key]');
    if (row && (e.ctrlKey || e.metaKey || e.shiftKey) && sessions.some(s => s.key === row.dataset.key) && !tidy) {
      e.stopPropagation(); e.preventDefault();
      pick(row.dataset.key, { range: e.shiftKey });
      return true;
    }
    if (row && selection.size) { selection.clear(); }
    return false;
  }
  function onDblClick(e) {
    const head = e.target.closest('.ag-ghead[data-key]');
    const id = head && headId(head.dataset.key);
    if (!id || tidy || e.target.closest('input')) return;
    e.preventDefault();
    toggle(head.dataset.key); // undo the first click's fold
    startRename(id);
  }
  function onContextMenu(e) {
    const head = e.target.closest('.ag-ghead[data-key]');
    const id = head && headId(head.dataset.key);
    if (!id || tidy) return false;
    e.preventDefault(); e.stopPropagation();
    groupMenu(id, null, { x: e.clientX, y: e.clientY });
    return true;
  }
  // Keys while the list has the keyboard (design/59's cursor). Returns true
  // when handled.
  function onKey(e, cursorKey) {
    if (e.target.closest && e.target.closest('input, textarea')) return false;
    const k = e.key;
    const cursorSec = () => {
      if (!cursorKey) return null;
      if (isHead(cursorKey)) return cursorKey;
      if (arrange() === 'project') { const s = sessions.find(x => x.key === cursorKey); return s && !agentIsPinned(cursorKey) ? PROJECT_HEAD + projectKeyOf(s) : null; }
      const g = groupOf(cursorKey, agentReadState);
      return g && !agentIsPinned(cursorKey) ? headKey(g.id) : null;
    };
    const foldedNow = key => key.startsWith(PROJECT_HEAD) ? !!read(PROJECT_FOLD, {})[key.slice(PROJECT_HEAD.length)] : !!(agentReadState.groups[headId(key)] || {}).folded;
    if (k === 'Escape' && (selection.size || tidy)) { e.preventDefault(); if (tidy) cancelTidy(); else clearSelection(); return true; }
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && e.shiftKey) { e.preventDefault(); foldAll(k === 'ArrowLeft'); return true; }
    if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const row = cursorKey && agentRows().find(r => r.dataset.key === cursorKey);
      if (row && row.querySelector(':scope > .ag-expand')) return false; // delegated work folds first
      const sec = cursorSec();
      if (!sec) return false;
      e.preventDefault();
      const fold = k === 'ArrowLeft';
      if (fold !== foldedNow(sec)) setFolded(sec.startsWith(HEAD) ? headId(sec) : sec, fold);
      if (fold) setTimeout(() => selectAgentRow(sec));
      return true;
    }
    if (k === 'Enter' && cursorKey && isHead(cursorKey)) { e.preventDefault(); toggle(cursorKey); return true; }
    if (k === 'F2') { const sec = cursorSec(); if (sec && headId(sec)) { e.preventDefault(); startRename(headId(sec)); return true; } return false; }
    if (k === ' ' && cursorKey && !isHead(cursorKey) && sessions.some(s => s.key === cursorKey)) { e.preventDefault(); pick(cursorKey); return true; }
    if (k === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const keys = picked(cursorKey);
      if (!keys.length || arrange() !== 'groups') return false;
      e.preventDefault();
      picker(keys, agentRows().find(r => r.dataset.key === keys[keys.length - 1]));
      return true;
    }
    if (k === 'G') { e.preventDefault(); arrangeMenu(sideLayoutOn() ? $('sideArrange') : $('agentsSheetArrange')); return true; }
    if (k === 'Delete' && selection.size) { e.preventDefault(); document.querySelector('#agentsUnread [data-sel="close"]')?.click(); return true; }
    if (cursorKey && isHead(cursorKey) && ['p', 'u', 'Delete'].includes(k)) { e.preventDefault(); return true; }
    return false;
  }

  // Drag and drop, with a mouse or a pen (not on touch screens): a row
  // onto a header or into a group moves it there; onto a loose row makes a
  // new group of the two; onto the strip under the loose rows takes it out.
  // A header onto another header moves its group before that one.
  const dragOn = () => !matchMedia('(pointer: coarse)').matches && arrange() === 'groups';
  let drag = null;
  function wireDrag(host) {
    host.addEventListener('dragstart', e => {
      if (!dragOn() || tidy) return;
      const row = e.target.closest('.ag-row[data-key]'), head = e.target.closest('.ag-ghead[data-key]');
      if (row && sessions.some(s => s.key === row.dataset.key)) {
        const k = row.dataset.key;
        drag = { keys: selection.has(k) && selection.size > 1 ? [...selection] : [k] };
        document.body.classList.toggle('ag-dragging-grouped', drag.keys.some(x => memberOf(agentReadState)[x]));
      } else if (head && headId(head.dataset.key)) drag = { group: headId(head.dataset.key) };
      else return;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', drag.keys ? drag.keys.map(titleOf).join('\n') : '');
      document.body.classList.add('ag-dragging');
    });
    const target = e => {
      const head = e.target.closest('.ag-ghead[data-key]'), row = e.target.closest('.ag-row[data-key]'), out = e.target.closest('.ag-loose-drop');
      if (drag.group) return head && headId(head.dataset.key) && headId(head.dataset.key) !== drag.group ? { el: head, before: headId(head.dataset.key) } : null;
      if (head && headId(head.dataset.key)) return { el: head, into: headId(head.dataset.key) };
      if (out) return { el: out, out: true };
      if (row && !drag.keys.includes(row.dataset.key) && sessions.some(s => s.key === row.dataset.key)) {
        const g = memberOf(agentReadState)[row.dataset.key];
        if (g && !agentIsPinned(row.dataset.key)) { const h = host.querySelector(`.ag-ghead[data-key="${CSS.escape(headKey(g))}"]`); return { el: h || row, into: g }; }
        return { el: row, join: row.dataset.key };
      }
      return null;
    };
    const clear = () => host.querySelectorAll('.ag-drop, .ag-drop-join').forEach(x => x.classList.remove('ag-drop', 'ag-drop-join'));
    host.addEventListener('dragover', e => {
      if (!drag) return;
      clear();
      const t = target(e);
      if (!t) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      t.el.classList.add(t.join ? 'ag-drop-join' : 'ag-drop');
    });
    host.addEventListener('dragleave', e => { if (!host.contains(e.relatedTarget)) clear(); });
    host.addEventListener('drop', e => {
      if (!drag) return;
      const t = target(e), d = drag;
      end();
      if (!t) return;
      e.preventDefault();
      if (d.group) return placeBefore(d.group, t.before);
      if (t.into) return move(d.keys, t.into);
      if (t.out) return move(d.keys, null);
      if (t.join) {
        const keys = [t.join, ...d.keys];
        const local = localName(keys);
        const id = move(keys, null, { name: local || 'New group', quiet: true, fresh: true });
        if (!id) return;
        const input = startRename(id);
        if (!local && input) modelName(keys).then(n => { if (n && input.isConnected && input.value === 'New group') { input.value = n; input.select(); } });
      }
    });
    const end = () => { drag = null; clear(); document.body.classList.remove('ag-dragging', 'ag-dragging-grouped'); };
    host.addEventListener('dragend', end);
  }

  // The list as last drawn (renderAgentsPop gives it): what Tidy up reads.
  let lastCtx = null;
  function remember(ctx) { lastCtx = ctx; }

  return {
    HEAD, PROJECT_HEAD, isHead, headKey, arrange, layout, items, barHtml, selbarHtml, remember,
    selected: key => selection.has(key), dragOn, groupOf: key => groupOf(key, agentReadState),
    move, picker, groupMenu, arrangeMenu, startRename, setFolded, foldAll, follow, join, newIn,
    onClick, onDblClick, onContextMenu, onKey, wireDrag, clearSelection, tidying: () => !!tidy,
    groupName: id => (agentReadState.groups && agentReadState.groups[id] || {}).name || '',
  };
})();
window.ListGroups = ListGroups;
