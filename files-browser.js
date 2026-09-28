'use strict';
// A project has one file browser, whether entered from its summary or a conversation.
let filesBrowser = null;
let filesBrowserSeq = 0;
const filesBrowserPlaces = new Map();

function fbStore(key, value) {
  try { if (value === undefined) return JSON.parse(localStorage.getItem('chattering.browser.' + key) || 'null');
    localStorage.setItem('chattering.browser.' + key, JSON.stringify(value));
  } catch {} return null;
}
function fbHash(s) {
  return 'browse=' + encodeURIComponent(JSON.stringify({ project: s.project, conv: s.conv, root: s.root, dir: s.dir, mode: s.mode, range: s.range, count: s.count, actor: s.actor, from: s.from, to: s.to }));
}
function fbCurrent(s) { return filesBrowser === s && viewKind === 'files-browser'; }
async function fbJSON(url) {
  const r = await fetch(url); const d = await r.json();
  if (!r.ok || d.error) throw new Error(d.error || 'Request failed');
  return d;
}
function fbConversationFiles() {
  if (!current) return;
  const project = projectOf(current);
  if (!project || project === '?' || project === LOOSE_PROJECT) return errToast('Assign this conversation to a project first.');
  const ta = $('agentText');
  if (ta) readerDrafts.set(current.key, ta.value);
  const saved = filesBrowserPlaces.get(project + '\0' + current.key);
  if (saved?.file) return openLiveFile(saved.file, { project, root: saved.context?.root || '', browserContext: saved.context });
  return showFilesBrowser(project, { ...saved, conv: current.key });
}
function fbContext(s) {
  return { project: s.project, conv: s.conv, root: s.root, dir: s.dir, mode: s.mode, range: s.range, count: s.count, actor: s.actor, from: s.from, to: s.to, query: s.query, contents: s.contents, only: s.only };
}
function fbOpenFile(s, file, line) {
  const context = fbContext(s);
  filesBrowserPlaces.set(s.project + '\0' + s.conv, { file, context });
  return openLiveFile(file, { project: s.project, root: s.root || '', line, browserContext: context });
}
// A route hash that names a conversation (no "view=" grammar, a source
// prefix). Such a hash as ws.back means the file was opened from that
// conversation's text: a markdown link, a quoted path, a context chip.
function fbConversationHash(hash) {
  return typeof hash === 'string' && /^(?:pi|pi-remote|claude):/.test(hash) ? hash : null;
}
// Return to the place a file was opened from. A conversation return lands
// on the link that opened the file when that was recorded, and otherwise
// where the reader last was — never at the bottom.
function fbReturnTo(hash) {
  const conv = fbConversationHash(hash);
  const recorded = typeof conversationFileReturn !== 'undefined' && conversationFileReturn && conversationFileReturn.key === conv;
  if (conv && !recorded) return open(conv, 'restore');
  return dispatchHash(hash);
}


function fbFinderClose(s) {
  const f = s?.finder;
  if (!f) return;
  f.open = false; f.ticket++; clearTimeout(f.timer); f.controller?.abort();
  if (!fbCurrent(s)) return;
  $('fbFinderPopup').hidden = true;
  $('fbSearch').setAttribute('aria-expanded', 'false');
  $('fbSearch').removeAttribute('aria-activedescendant');
}
function fbFinderOpen(s) {
  if (!fbCurrent(s)) return;
  s.finder.open = true;
  $('fbFinderPopup').hidden = false;
  $('fbSearch').setAttribute('aria-expanded', 'true');
}
function fbFinderSelect(s, index) {
  const f = s.finder;
  f.index = Math.max(0, Math.min(f.items.length - 1, index));
  const rows = $('fbFinderList').querySelectorAll('[role="option"]');
  rows.forEach((row, i) => row.setAttribute('aria-selected', String(i === f.index)));
  const row = rows[f.index];
  if (row) {
    $('fbSearch').setAttribute('aria-activedescendant', row.id);
    row.scrollIntoView({ block: 'nearest' });
  } else $('fbSearch').removeAttribute('aria-activedescendant');
}
function fbFinderActivate(s, index = s.finder.index) {
  const f = s.finder, entry = f.items[index];
  if (!fbCurrent(s) || !f.open || !entry) return;
  fbFinderClose(s);
  $('fbSearch').value = '';
  $('fbSearch').blur();
  if (entry.directory) {
    s.dir = entry.rel; s.query = ''; s.contents = false;
    fbLoad(s);
  } else fbOpenFile(s, entry.path, entry.line);
}
function fbFinderReset(s, message) {
  s.finder.items = []; s.finder.index = -1;
  $('fbFinderList').innerHTML = '';
  $('fbSearch').removeAttribute('aria-activedescendant');
  $('fbFinderStatus').textContent = message;
}
function fbFinderQueue(s, immediate = false) {
  if (!fbCurrent(s)) return;
  const f = s.finder;
  clearTimeout(f.timer); f.controller?.abort();
  const ticket = ++f.ticket;
  fbFinderOpen(s);
  const query = $('fbSearch').value.trim();
  const contents = $('fbFindMode').value === 'contents';
  if (!query) return fbFinderReset(s, contents ? 'Type text, then press Enter to search contents.' : 'Type a file or folder name.');
  if (contents && !immediate) return fbFinderReset(s, 'Press Enter to search file contents.');
  fbFinderReset(s, 'Searching…');
  // The folder list and change review underneath stay untouched.
  const root = s.root;
  f.timer = setTimeout(async () => {
    if (!fbCurrent(s) || !f.open || f.ticket !== ticket) return;
    const controller = f.controller = new AbortController();
    try {
      const r = await fetch('/api/files/browse?' + new URLSearchParams({ name: s.project, root, dir: '', q: query, contents: contents ? '1' : '0' }), { signal: controller.signal });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || 'Search failed');
      if (!fbCurrent(s) || !f.open || f.ticket !== ticket || s.root !== root) return;
      const q = query.toLowerCase();
      const rank = e => e.name.toLowerCase() === q ? 0 : e.name.toLowerCase().startsWith(q) ? 1 : e.name.toLowerCase().includes(q) ? 2 : 3;
      f.items = data.entries.filter(e => !e.link).sort((a, b) => rank(a) - rank(b) || a.rel.localeCompare(b.rel));
      $('fbFinderList').innerHTML = f.items.map((e, i) => `<div id="fbFindOption${i}" role="option" aria-selected="false" data-fb-result="${i}"><span class="fb-find-icon" aria-hidden="true">${e.directory ? '▸' : '▤'}</span><span class="fb-find-path">${esc(e.rel)}${e.directory ? '/' : ''}${e.snippet != null ? `<small>Line ${e.line}: ${esc(e.snippet)}</small>` : ''}</span></div>`).join('');
      $('fbFinderStatus').textContent = data.truncated ? `Showing ${f.items.length} matches; narrow your search for more.` : f.items.length ? `${f.items.length} match${f.items.length === 1 ? '' : 'es'}` : 'No matching files or folders.';
      fbFinderSelect(s, 0);
    } catch (e) {
      if (e.name !== 'AbortError' && fbCurrent(s) && f.open && f.ticket === ticket) fbFinderReset(s, 'Search unavailable: ' + e.message);
    }
  }, immediate ? 0 : 180);
}
function fbFinderSetup(s) {
  s.finder = { open: false, ticket: 0, items: [], index: -1 };
  const input = $('fbSearch');
  input.onfocus = () => fbFinderQueue(s);
  input.oninput = e => { if (!e.isComposing) fbFinderQueue(s); };
  input.oncompositionend = () => fbFinderQueue(s);
  $('fbSearchForm').onsubmit = e => {
    e.preventDefault();
    if (s.finder.open && s.finder.items.length) fbFinderActivate(s);
    else fbFinderQueue(s, true);
  };
  $('fbFindMode').onchange = () => {
    const contents = $('fbFindMode').value === 'contents';
    input.placeholder = contents ? 'Search contents' : 'Go to file';
    input.setAttribute('aria-label', contents ? 'Search file contents' : 'Go to file');
    $('fbFindSubmit').hidden = !contents;
    input.focus(); fbFinderQueue(s);
  };
  $('fbFindSubmit').onclick = () => { input.focus(); fbFinderQueue(s, true); };
  input.onkeydown = e => {
    if (e.isComposing || e.keyCode === 229) { e.stopPropagation(); return; }
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      if (!s.finder.open) fbFinderQueue(s);
      else fbFinderSelect(s, s.finder.index + (e.key === 'ArrowDown' ? 1 : -1));
    }
  };
  $('fbFinder').addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      input.focus(); fbFinderClose(s); input.blur();
    }
  });
  $('fbFinder').addEventListener('focusout', e => {
    if (!$('fbFinder').contains(e.relatedTarget)) fbFinderClose(s);
  });
  // Keep input focus while selecting an option with a mouse or touch.
  $('fbFinderList').onmousedown = e => e.preventDefault();
  $('fbFinderList').onclick = e => {
    const row = e.target.closest('[data-fb-result]');
    if (row) fbFinderActivate(s, Number(row.dataset.fbResult));
  };
}
document.addEventListener('pointerdown', e => {
  const s = filesBrowser;
  if (s && fbCurrent(s) && s.finder?.open && !$('fbFinder').contains(e.target)) fbFinderClose(s);
});

async function showFilesBrowser(project, opts = {}) {
  const seq = ++filesBrowserSeq;
  markSettingsClosed();
  if (progressStream) { progressStream.close(); progressStream = null; }
  const s = { project, conv: opts.conv || '', root: opts.root || '', dir: opts.dir || '', mode: opts.mode === 'changes' ? 'changes' : 'browse',
    range: opts.range || (opts.conv ? 'conversation' : 'day'), count: opts.count || 20, actor: opts.actor || '', from: opts.from || '', to: opts.to || '',
    since: fbStore('visited:' + project) || Date.now() - 86400000, events: [], seq, query: opts.query || '', contents: !!opts.contents, only: !!opts.only };
  if (filesBrowser) fbFinderClose(filesBrowser);
  filesBrowser = s;
  projectOverviewName = project;
  setRoute('files-browser', fbHash(s), { project });
  $('view').innerHTML = `<section class="fb-view">
    <header class="fb-header">${s.conv ? '<nav aria-label="Conversation view"><button id="fbConversation">Conversation</button><button class="on" aria-current="page">Files</button></nav>' : '<button id="fbSummary">← Project summary</button>'}<h1>${esc(project)}</h1><span class="fb-live">● Live files</span><button id="fbRefresh">Refresh</button></header>
    <div class="fb-toolbar"><nav aria-label="Files view"><button data-fb-mode="browse">Browse</button><button data-fb-mode="changes">Changes</button></nav>
      <label>Highlight <select id="fbRange"><option value="none">Nothing</option><option value="seen">Since last visit</option>${s.conv ? '<option value="conversation">This conversation</option>' : ''}<option value="last">Last X changes</option><option value="hour">Last hour</option><option value="day">Last 24 hours</option><option value="custom">Time range</option></select></label>
      <input id="fbCount" type="number" min="1" max="5000" aria-label="Number of changes" value="${esc(String(s.count))}" hidden>
      <label id="fbFromLabel" hidden>From <input id="fbFrom" type="datetime-local" value="${esc(s.from)}"></label><label id="fbToLabel" hidden>To <input id="fbTo" type="datetime-local" value="${esc(s.to)}"></label>
      <label>By <select id="fbActor"><option value="">Everyone</option><option value="ai">Agents</option><option value="human">Editor saves</option><option value="external">Unknown / external</option><option value="git">Git commits</option></select></label>
    </div>
    <div class="fb-toolbar fb-browse-bar"><select id="fbRoot" aria-label="Repository" hidden></select><label><input id="fbOnly" type="checkbox"> Changed only</label>
      <div class="fb-finder" id="fbFinder"><form id="fbSearchForm" role="search"><svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="4.5"/><path d="m10 10 4 4"/></svg><input id="fbSearch" type="search" disabled placeholder="Go to file" aria-label="Go to file" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="fbFinderList" aria-keyshortcuts="T" autocomplete="off" spellcheck="false"><kbd aria-hidden="true">T</kbd></form>
        <div id="fbFinderPopup" class="fb-finder-popup" hidden><div class="fb-finder-tools"><select id="fbFindMode" aria-label="Search mode"><option value="files">File names</option><option value="contents">File contents</option></select><span>Entire repository</span><button id="fbFindSubmit" type="button" hidden>Search</button></div><div id="fbFinderList" role="listbox" aria-label="Matching files and folders"></div><div id="fbFinderStatus" role="status"></div><div class="fb-finder-help">↑ ↓ select · Enter open · Esc close</div></div>
      </div><button id="fbNew">+ Document</button></div>
    <div id="fbNotice" role="status"></div><div id="fbBody">Loading files…</div>
  </section>`;
  $('fbConversation')?.addEventListener('click', () => open(s.conv, 'restore'));
  $('fbSummary')?.addEventListener('click', () => showProjectOverview(project));
  $('fbNew').onclick = () => createProjectDocument(project);
  $('fbRefresh').onclick = () => fbLoad(s);
  $('fbRange').value = s.range; $('fbActor').value = s.actor;
  $('fbOnly').checked = s.only;
  fbFinderSetup(s);
  const controls = () => {
    s.range = $('fbRange').value; s.actor = $('fbActor').value;
    s.count = Math.max(1, Math.min(5000, Number($('fbCount').value) || 20));
    s.from = $('fbFrom').value; s.to = $('fbTo').value;
    $('fbCount').hidden = s.range !== 'last';
    $('fbFromLabel').hidden = $('fbToLabel').hidden = s.range !== 'custom';
  };
  controls();
  for (const id of ['fbRange', 'fbActor', 'fbCount', 'fbFrom', 'fbTo']) $(id).onchange = () => { controls(); fbLoad(s); };
  $('fbOnly').onchange = () => { s.only = $('fbOnly').checked; fbPaint(s); };
  $('fbRoot').onchange = () => { fbFinderClose(s); s.root = $('fbRoot').value; s.dir = ''; fbLoad(s); };
  $('view').querySelectorAll('[data-fb-mode]').forEach(b => b.onclick = () => { s.mode = b.dataset.fbMode; fbRemember(s); fbPaint(s); });
  await fbLoad(s);
}
function fbRemember(s) {
  filesBrowserPlaces.set(s.project + '\0' + s.conv, fbContext(s));
  replaceRoute(fbHash(s));
}
function fbActivityParams(s) {
  const now = Date.now();
  let from = now - 86400000, to = now;
  if (s.range === 'hour') from = now - 3600000;
  if (s.range === 'seen') from = s.since;
  if (s.range === 'conversation' || s.range === 'last') from = 0;
  if (s.range === 'custom') {
    from = s.from ? new Date(s.from).getTime() : 0;
    to = s.to ? new Date(s.to).getTime() : now;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error('Choose a valid time range, with From before To.');
  }
  return new URLSearchParams({ name: s.project, from, to, limit: s.range === 'last' ? s.count : 5000, actor: s.actor, ...(s.range === 'conversation' ? { conv: s.conv } : {}) });
}
async function fbLoad(s) {
  const ticket = s.load = (s.load || 0) + 1;
  if (!fbCurrent(s)) return;
  $('fbNotice').textContent = 'Loading…';
  try {
    const params = fbActivityParams(s);
    const [tree, activity] = await Promise.all([
      fbJSON('/api/files/browse?' + new URLSearchParams({ name: s.project, root: s.root, dir: s.dir, q: s.query, contents: s.contents ? '1' : '0' })),
      s.range === 'none' ? Promise.resolve({ events: [] }) : fbJSON('/api/files/activity?' + params).catch(e => ({ events: [], error: e.message })),
    ]);
    if (!fbCurrent(s) || ticket !== s.load) return;
    s.tree = tree; s.root = tree.root; s.dir = tree.dir; s.events = activity.events; s.activity = activity;
    $('fbSearch').disabled = false;
    s.groups = new Map();
    for (const e of s.events) { if (!s.groups.has(e.path)) s.groups.set(e.path, []); s.groups.get(e.path).push(e); }
    $('fbRoot').innerHTML = tree.roots.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
    $('fbRoot').value = tree.roots.find(r => r === s.root) || tree.roots[0]; $('fbRoot').hidden = tree.roots.length < 2;
    fbStore('visited:' + s.project, Date.now());
    fbRemember(s); fbPaint(s);
  } catch (e) { if (fbCurrent(s) && ticket === s.load) $('fbNotice').textContent = e.message; }
}
function fbRelativeTime(ts, now = Date.now()) {
  const ms = ts == null || ts === '' ? NaN : new Date(ts).getTime();
  if (!Number.isFinite(ms)) return 'Unknown time';
  const seconds = Math.abs(now - ms) / 1000;
  if (seconds < 60) return 'just now';
  const [unit, size] = seconds < 3600 ? ['min', 60] : seconds < 86400 ? ['hour', 3600]
    : seconds < 2592000 ? ['day', 86400] : seconds < 31536000 ? ['month', 2592000] : ['year', 31536000];
  const count = Math.floor(seconds / size);
  const age = `${count} ${unit}${count === 1 ? '' : 's'}`;
  return ms > now ? `in ${age}` : `${age} ago`;
}
function fbTimeHTML(ts) {
  const date = new Date(ts == null || ts === '' ? NaN : ts);
  if (!Number.isFinite(date.getTime())) return 'Unknown time';
  return `<time data-fb-time="${date.getTime()}" datetime="${date.toISOString()}" title="${esc(date.toLocaleString())}">${fbRelativeTime(date.getTime())}</time>`;
}
function fbRefreshTimes() {
  if (document.hidden || viewKind !== 'files-browser') return;
  const now = Date.now();
  document.querySelectorAll('[data-fb-time]').forEach(el => {
    const text = fbRelativeTime(Number(el.dataset.fbTime), now);
    if (el.textContent !== text) el.textContent = text;
  });
}
// Update only the labels, not the list: preserve focus, selection and open diffs.
setInterval(fbRefreshTimes, 30000);
document.addEventListener('visibilitychange', fbRefreshTimes);
function fbEventLabel(e) {
  const actor = (e.actor === 'ai' ? 'Agent' : e.actor === 'human' ? 'Editor save' : e.actor === 'git' ? 'Git commit' : 'Unknown / external') + (e.outcome === 'attempted' ? ' (attempt recorded)' : '');
  return esc(actor) + ' · ' + fbTimeHTML(e.ts);
}
function fbBadge(s, events) {
  if (!events.length) return '';
  const latest = events[0];
  const live = events.some(e => e.conv_key && [...activeRuns.values()].some(run => run.key === e.conv_key && run.status === 'running'));
  return `<span class="fb-badge">${live ? 'Active conversation · ' : ''}${events.length} change${events.length === 1 ? '' : 's'}</span><span class="dim">${fbEventLabel(latest)}</span>`;
}
function fbPaint(s) {
  if (!fbCurrent(s) || !s.tree) return;
  $('view').querySelectorAll('[data-fb-mode]').forEach(b => { b.classList.toggle('on', b.dataset.fbMode === s.mode); b.setAttribute('aria-current', b.dataset.fbMode === s.mode ? 'page' : 'false'); });
  $('fbNotice').textContent = [s.activity.historyWarning || '', s.activity.error ? 'Activity unavailable: ' + s.activity.error : '', s.tree.truncated ? 'Search/listing limit reached. Narrow your search or open a folder.' : '', s.activity.truncated ? `Showing the newest ${s.events.length} recorded changes; narrow the range for more.` : '', s.range === 'conversation' ? 'Highlighting this conversation; files show their current contents.' : '', s.range === 'seen' ? 'Since your previous Files visit on this browser.' : ''].filter(Boolean).join(' ');
  if (s.mode === 'changes') return fbPaintChanges(s);
  const parts = s.dir.split('/').filter(Boolean);
  $('fbBody').innerHTML = `<nav class="fb-crumbs" aria-label="Folder path"><button data-fb-dir="">${esc(s.project)}</button>${parts.map((part, i) => `<span>/</span><button data-fb-dir="${esc(parts.slice(0, i + 1).join('/'))}">${esc(part)}</button>`).join('')}</nav><div class="fb-list" id="fbList"></div><section id="fbReadme"></section>`;
  const entries = s.tree.entries.map(e => {
    const events = e.directory ? s.events.filter(x => x.path.startsWith(e.path + '/')) : s.groups.get(e.path) || [];
    return { ...e, events };
  }).filter(e => !s.only || e.events.length);
  $('fbList').innerHTML = entries.map((e, i) => `<div class="fb-row${e.events.length ? ' changed' : ''}"><button data-fb-entry="${i}" ${e.link ? 'disabled title="Symbolic links are not opened by this browser"' : ''}><span aria-hidden="true">${e.directory ? '▸' : '·'}</span> ${esc(s.query ? e.rel : e.name)}${e.link ? ' ↗' : ''}</button><div>${e.directory || typeof presenceFileSlotHtml !== 'function' ? '' : presenceFileSlotHtml(e.path)}${fbBadge(s, e.events)}${e.directory || typeof OpenFiles === 'undefined' ? '' : OpenFiles.keepButtonHtml(e.path, s.project, { cls: 'fb-keep' })}</div>${e.snippet != null ? `<code class="fb-snippet">${e.line}: ${esc(e.snippet)}</code>` : ''}</div>`).join('') || '<div class="empty">No matching files.</div>';
  if (typeof renderPresenceMarks === 'function') renderPresenceMarks();
  $('fbList').querySelectorAll('[data-fb-entry]').forEach(b => b.onclick = () => {
    const e = entries[Number(b.dataset.fbEntry)];
    if (e.directory) { s.dir = e.rel; s.query = ''; $('fbSearch').value = ''; fbLoad(s); }
    else fbOpenFile(s, e.path, e.line);
  });
  $('fbBody').querySelectorAll('[data-fb-dir]').forEach(b => b.onclick = () => { s.dir = b.dataset.fbDir; s.query = ''; $('fbSearch').value = ''; fbLoad(s); });
  if (s.tree.readme && !s.only) fbReadme(s, s.tree.readme, $('fbReadme'));
}
async function fbReadme(s, path, host) {
  try {
    const d = await fbJSON('/api/file/read?path=' + encodeURIComponent(path));
    if (!fbCurrent(s) || !host.isConnected) return;
    host.innerHTML = `<header><b>README</b><button>Edit & run</button></header><div class="fb-markdown">${mdRender(d.text)}</div>`;
    host.querySelector('button').onclick = () => fbOpenFile(s, path);
  } catch (e) { if (host.isConnected) host.textContent = 'README: ' + e.message; }
}
function fbPaintChanges(s) {
  let groups = [...s.groups.entries()];
  if (s.query) {
    const matches = new Set(s.tree.entries.map(e => e.path));
    groups = groups.filter(([path]) => matches.has(path) || path.toLowerCase().includes(s.query.toLowerCase()));
  }
  $('fbBody').innerHTML = `<div class="fb-change-summary"><b>${groups.length} files · ${s.events.length} recorded changes</b><p>Combined comparisons use the nearest recorded versions. Filters select activity and files, not authorship of every line in a combined diff. Unknown external writes are not assumed to be human.</p><label>Diff layout <select id="fbDiffLayout"><option value="split">Side by side</option><option value="unified">Unified</option></select></label></div><div id="fbChanges"></div>`;
  $('fbDiffLayout').value = s.layout || 'split';
  $('fbDiffLayout').onchange = () => { s.layout = $('fbDiffLayout').value; $('fbChanges').classList.toggle('unified', s.layout === 'unified'); };
  $('fbChanges').classList.toggle('unified', s.layout === 'unified');
  if (!groups.length) $('fbChanges').innerHTML = '<div class="empty">No recorded changes in this selection.</div>';
  groups.forEach(([path, events]) => {
    const stateKey = s.project + ':' + path;
    const record = fbStore('review:' + stateKey) || {};
    // A larger range must not inherit approval from a smaller one just because
    // they share the same newest event. Review applies to the complete selection.
    const latest = events.map(e => e.id).sort().join('\n');
    const card = document.createElement('details'); card.className = 'fb-change';
    const rel = path.startsWith(s.root + '/') ? path.slice(s.root.length + 1) : path;
    card.innerHTML = `<summary><b>${esc(rel)}</b>${fbBadge(s, events)}<span class="fb-review-status"></span></summary><div class="fb-change-actions"><button data-open>Open live file</button><button data-history>History</button><button data-review></button><button data-flag></button></div><div class="fb-diff-host"></div><details class="fb-steps"><summary>Individual changes (${events.length})</summary>${events.map((e, i) => `<div>${fbEventLabel(e)} · +${e.added} −${e.removed}${e.conv_key ? ` <button data-event="${i}">Go to conversation</button>` : ''}</div>`).join('')}</details>`;
    const paintReview = () => {
      card.querySelector('.fb-review-status').textContent = (record.reviewed === latest ? 'Reviewed' : record.viewed !== latest ? 'New to you' : 'Not reviewed') + (record.flagged ? ' · Flagged' : '');
      card.querySelector('[data-review]').textContent = record.reviewed === latest ? 'Mark not reviewed' : 'Mark reviewed';
      card.querySelector('[data-flag]').textContent = record.flagged ? 'Remove flag' : 'Flag for follow-up';
    };
    const save = () => { fbStore('review:' + stateKey, record); paintReview(); };
    card.querySelector('[data-review]').onclick = () => { record.reviewed = record.reviewed === latest ? null : latest; save(); };
    card.querySelector('[data-flag]').onclick = () => { record.flagged = !record.flagged; save(); };
    card.querySelector('[data-open]').onclick = () => fbOpenFile(s, path);
    card.querySelector('[data-history]').onclick = () => openLiveFile(path, { project: s.project, root: s.root || '', to: 'current', browserContext: fbContext(s) });
    card.querySelectorAll('[data-event]').forEach(b => b.onclick = () => { const e = events[Number(b.dataset.event)]; openConversationAtEvent(e.conv_key, e.id); });
    card.ontoggle = () => {
      if (!card.open || card.dataset.loaded) return;
      card.dataset.loaded = '1'; record.viewed = latest; save();
      fbLoadDiff(s, path, events, card.querySelector('.fb-diff-host'));
    };
    paintReview(); $('fbChanges').append(card);
  });
}
async function fbLoadDiff(s, path, events, host) {
  host.textContent = 'Loading recorded versions…';
  try {
    const root = events.find(e => e.repo_root)?.repo_root || s.root;
    const params = new URLSearchParams({ scope: 'project', name: s.project, repo: root, path: path.startsWith(root + '/') ? path.slice(root.length + 1) : path });
    const doc = await fbJSON('/api/file-history/points?' + params);
    const first = Math.min(...events.map(e => e.ts)), last = Math.max(...events.map(e => e.ts));
    const historical = doc.points.filter(p => p.kind !== 'current').sort((a, b) => a.ms - b.ms || a.order - b.order);
    const earliest = events.reduce((a, b) => a.ts < b.ts ? a : b);
    const latest = events.reduce((a, b) => a.ts > b.ts ? a : b);
    const before = doc.points.find(p => p.id === earliest.fromVersion) || historical.filter(p => p.ms < first).pop();
    const after = historical.filter(p => p.ms <= last).pop();
    const end = doc.points.find(p => p.id === latest.toVersion) || (after && after.ms >= last ? after : doc.points.find(p => p.kind === 'current'));
    if (!before || !end || before.id === end.id) { host.textContent = 'Activity was recorded, but there are not enough saved versions to compare this range. Open History to inspect the available versions.'; return; }
    const [old, next] = await Promise.all([fbJSON('/api/file-history/snapshot?' + params + '&point=' + encodeURIComponent(before.id)), fbJSON('/api/file-history/snapshot?' + params + '&point=' + encodeURIComponent(end.id))]);
    if (!fbCurrent(s) || !host.isConnected) return;
    if (old.content.length + next.content.length > 500000) { host.textContent = 'This comparison is large. Use History for the full, scrollable comparison.'; return; }
    const a = old.content.split('\n'), b = next.content.split('\n');
    const script = LineDiff.diffLines(old.content, next.content);
    let i = 0, j = 0;
    const rows = [];
    for (let k = 0; k < script.length; k++) {
      const op = script[k], same = op === LineDiff.SAME;
      // Keep three context lines around a change, collapsing long unchanged spans.
      if (same && k > 3 && k < script.length - 3 && Array.from(script.slice(k - 3, k + 4)).every(x => x === LineDiff.SAME)) {
        i++; j++; if (rows[rows.length - 1] !== '<div class="fb-diff-gap">⋯</div>') rows.push('<div class="fb-diff-gap">⋯</div>'); continue;
      }
      const left = op !== LineDiff.NEW ? `<span class="fb-ln">${i + 1}</span>${esc(a[i++])}` : '';
      const right = op !== LineDiff.OLD ? `<span class="fb-ln">${j + 1}</span>${esc(b[j++])}` : '';
      rows.push(`<div class="fb-diff-row ${same ? 'same' : op === LineDiff.OLD ? 'removed' : 'added'}"><pre>${left}</pre><pre>${right}</pre></div>`);
    }
    host.innerHTML = `<p class="fb-history-note">${fbTimeHTML(before.ms)} → ${end.kind === 'current' ? 'Live file (not the range endpoint)' : fbTimeHTML(end.ms)}. ${old.exact && next.exact ? 'Exact contents of these versions.' : 'Reconstructed version: some intervening edits may be missing.'} ${next.state === 'deleted' ? 'Deletion observed.' : ''} ${esc(doc.truth || '')}</p>${rows.join('')}`;
  } catch (e) { if (host.isConnected) host.textContent = 'Comparison unavailable: ' + e.message; }
}
function fbActivity(d) {
  const s = filesBrowser;
  if (!s || !fbCurrent(s)) return;
  if (d.project && d.project !== s.project) return;
  // Never replace a review or move focus under the reader. Refresh is explicit.
  $('fbNotice').textContent = 'New file activity is available. Refresh to include it; your current review stays in place.';
}
