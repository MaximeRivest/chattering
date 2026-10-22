'use strict';
// A project's file browser. It lives in the middle (the page, its own
// route), or beside (a tab of Beside, design/104), or both at once: each
// browser finds its elements inside its own frame (ids carry a prefix
// beside), and says where a file it opens goes.
let filesBrowser = null;   // the one in the middle
let besideBrowser = null;  // the one in Beside's tab shown
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
// This browser's element: ids are its own (prefixed beside).
function fb$(s, id) { return s && s.el ? s.el.querySelector('#' + s.pre + id) : null; }
function fbCurrent(s) {
  if (!s || !s.el || !s.el.isConnected) return false;
  return s.place === 'beside' ? besideBrowser === s : filesBrowser === s && viewKind === 'files-browser';
}
const fbLive = () => [filesBrowser, besideBrowser].filter(fbCurrent);
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
// A click opens in the place it was made in (design/104): in the middle's
// browser, full page; in Beside's, in its tab (‹ back to the folder).
// other: Shift+click, the other place.
function fbOpenFile(s, file, line, { other = false } = {}) {
  const context = fbContext(s);
  const beside = (s.place === 'beside') !== !!other;
  if (beside && typeof Beside !== 'undefined') {
    return Beside.open({ kind: 'document', path: file, project: s.project, line: line || null }, { origin: s.place === 'beside' ? 'beside' : 'middle' });
  }
  filesBrowserPlaces.set(s.project + '\0' + s.conv, { file, context });
  return openLiveFile(file, { project: s.project, root: s.root || '', line, browserContext: s.place === 'beside' ? null : context, back: s.place === 'beside' ? (typeof currentHash !== 'undefined' ? currentHash : null) : undefined });
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
  fb$(s, 'fbFinderPopup').hidden = true;
  fb$(s, 'fbSearch').setAttribute('aria-expanded', 'false');
  fb$(s, 'fbSearch').removeAttribute('aria-activedescendant');
}
function fbFinderOpen(s) {
  if (!fbCurrent(s)) return;
  s.finder.open = true;
  fb$(s, 'fbFinderPopup').hidden = false;
  fb$(s, 'fbSearch').setAttribute('aria-expanded', 'true');
}
function fbFinderSelect(s, index) {
  const f = s.finder;
  f.index = Math.max(0, Math.min(f.items.length - 1, index));
  const rows = fb$(s, 'fbFinderList').querySelectorAll('[role="option"]');
  rows.forEach((row, i) => row.setAttribute('aria-selected', String(i === f.index)));
  const row = rows[f.index];
  if (row) {
    fb$(s, 'fbSearch').setAttribute('aria-activedescendant', row.id);
    row.scrollIntoView({ block: 'nearest' });
  } else fb$(s, 'fbSearch').removeAttribute('aria-activedescendant');
}
function fbFinderActivate(s, index = s.finder.index, other = false) {
  const f = s.finder, entry = f.items[index];
  if (!fbCurrent(s) || !f.open || !entry) return;
  fbFinderClose(s);
  fb$(s, 'fbSearch').value = '';
  fb$(s, 'fbSearch').blur();
  if (entry.directory) {
    s.dir = entry.rel; s.query = ''; s.contents = false;
    fbLoad(s);
  } else fbOpenFile(s, entry.path, entry.line, { other });
}
function fbFinderReset(s, message) {
  s.finder.items = []; s.finder.index = -1;
  fb$(s, 'fbFinderList').innerHTML = '';
  fb$(s, 'fbSearch').removeAttribute('aria-activedescendant');
  fb$(s, 'fbFinderStatus').textContent = message;
}
function fbFinderQueue(s, immediate = false) {
  if (!fbCurrent(s)) return;
  const f = s.finder;
  clearTimeout(f.timer); f.controller?.abort();
  const ticket = ++f.ticket;
  fbFinderOpen(s);
  const query = fb$(s, 'fbSearch').value.trim();
  const contents = fb$(s, 'fbFindMode').value === 'contents';
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
      fb$(s, 'fbFinderList').innerHTML = f.items.map((e, i) => `<div id="${s.pre}fbFindOption${i}" role="option" aria-selected="false" data-fb-result="${i}"><span class="fb-find-icon" aria-hidden="true">${e.directory ? '▸' : '▤'}</span><span class="fb-find-path">${esc(e.rel)}${e.directory ? '/' : ''}${e.snippet != null ? `<small>Line ${e.line}: ${esc(e.snippet)}</small>` : ''}</span></div>`).join('');
      fb$(s, 'fbFinderStatus').textContent = data.truncated ? `Showing ${f.items.length} matches; narrow your search for more.` : f.items.length ? `${f.items.length} match${f.items.length === 1 ? '' : 'es'}` : 'No matching files or folders.';
      fbFinderSelect(s, 0);
    } catch (e) {
      if (e.name !== 'AbortError' && fbCurrent(s) && f.open && f.ticket === ticket) fbFinderReset(s, 'Search unavailable: ' + e.message);
    }
  }, immediate ? 0 : 180);
}
function fbFinderSetup(s) {
  s.finder = { open: false, ticket: 0, items: [], index: -1 };
  const input = fb$(s, 'fbSearch');
  input.onfocus = () => fbFinderQueue(s);
  input.oninput = e => { if (!e.isComposing) fbFinderQueue(s); };
  input.oncompositionend = () => fbFinderQueue(s);
  fb$(s, 'fbSearchForm').onsubmit = e => {
    e.preventDefault();
    if (s.finder.open && s.finder.items.length) fbFinderActivate(s);
    else fbFinderQueue(s, true);
  };
  fb$(s, 'fbFindMode').onchange = () => {
    const contents = fb$(s, 'fbFindMode').value === 'contents';
    input.placeholder = contents ? 'Search contents' : 'Go to file';
    input.setAttribute('aria-label', contents ? 'Search file contents' : 'Go to file');
    fb$(s, 'fbFindSubmit').hidden = !contents;
    input.focus(); fbFinderQueue(s);
  };
  fb$(s, 'fbFindSubmit').onclick = () => { input.focus(); fbFinderQueue(s, true); };
  input.onkeydown = e => {
    if (e.isComposing || e.keyCode === 229) { e.stopPropagation(); return; }
    // Shift+Enter: the file opens in the other place (design/104).
    if (e.key === 'Enter' && e.shiftKey && s.finder.open && s.finder.items.length) { e.preventDefault(); e.stopPropagation(); fbFinderActivate(s, s.finder.index, true); return; }
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      if (!s.finder.open) fbFinderQueue(s);
      else fbFinderSelect(s, s.finder.index + (e.key === 'ArrowDown' ? 1 : -1));
    }
  };
  fb$(s, 'fbFinder').addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      input.focus(); fbFinderClose(s); input.blur();
    }
  });
  fb$(s, 'fbFinder').addEventListener('focusout', e => {
    if (!fb$(s, 'fbFinder').contains(e.relatedTarget)) fbFinderClose(s);
  });
  // Keep input focus while selecting an option with a mouse or touch.
  fb$(s, 'fbFinderList').onmousedown = e => e.preventDefault();
  fb$(s, 'fbFinderList').onclick = e => {
    const row = e.target.closest('[data-fb-result]');
    if (row) fbFinderActivate(s, Number(row.dataset.fbResult), e.shiftKey);
  };
}
document.addEventListener('pointerdown', e => {
  for (const s of fbLive()) if (s.finder?.open && !fb$(s, 'fbFinder').contains(e.target)) fbFinderClose(s);
});

function fbState(project, opts, place) {
  return { project, conv: opts.conv || '', root: opts.root || '', dir: opts.dir || '', mode: opts.mode === 'changes' ? 'changes' : 'browse',
    range: opts.range || (opts.conv ? 'conversation' : 'day'), count: opts.count || 20, actor: opts.actor || '', from: opts.from || '', to: opts.to || '',
    since: fbStore('visited:' + project) || Date.now() - 86400000, events: [], seq: ++filesBrowserSeq, query: opts.query || '', contents: !!opts.contents, only: !!opts.only,
    place, pre: place === 'beside' ? 'bs-' : '' };
}
async function showFilesBrowser(project, opts = {}) {
  markSettingsClosed();
  if (progressStream) { progressStream.close(); progressStream = null; }
  const s = fbState(project, opts, 'page');
  if (filesBrowser) fbFinderClose(filesBrowser);
  filesBrowser = s;
  projectOverviewName = project;
  setRoute('files-browser', fbHash(s), { project });
  await fbBuild(s, $('view'));
}
// The project's folder in Beside's tab (artifacts.js draws the tab with it).
// The same folder shown again keeps its browser, scroll and all.
function fbMountBeside(host, spec) {
  const s0 = besideBrowser;
  if (s0 && s0.el && s0.el.parentElement === host && s0.project === spec.project) return;
  if (s0) fbFinderClose(s0);
  const s = fbState(spec.project, { ...spec, range: spec.range || (spec.conv ? 'conversation' : 'day') }, 'beside');
  besideBrowser = s;
  return fbBuild(s, host);
}
function fbDisposeBeside() {
  if (besideBrowser) fbFinderClose(besideBrowser);
  besideBrowser = null;
}
// The middle's folder goes beside, and the middle goes back to where you were.
async function fbToBeside(s) {
  if (!s || s.place !== 'page' || typeof Beside === 'undefined') return false;
  const ctx = fbContext(s);
  await Beside.sendFromMiddle({ kind: 'folder', ...ctx }, () => s.conv ? open(s.conv, 'restore') : showProjectOverview(s.project));
  return true;
}
async function fbBuild(s, host) {
  const beside = s.place === 'beside', project = s.project, P = s.pre;
  const nav = beside ? ''
    : s.conv ? `<nav aria-label="Conversation view"><button id="${P}fbConversation">Conversation</button><button class="on" aria-current="page">Files</button></nav>`
    : `<button id="${P}fbSummary">← Project summary</button>`;
  const section = document.createElement('section');
  section.className = 'fb-view' + (beside ? ' fb-beside' : '');
  section.innerHTML = `
    ${beside ? '' : `<header class="fb-header">${nav}<h1>${esc(project)}</h1><span class="fb-live">● Live files</span><button id="${P}fbToBeside" title="Put this folder beside, and go back to where you were: browse next to your work">◨ Beside</button><button id="${P}fbRefresh">Refresh</button></header>`}
    <div class="fb-toolbar"><nav aria-label="Files view"><button data-fb-mode="browse">Browse</button><button data-fb-mode="changes">Changes</button></nav>
      <label>Highlight <select id="${P}fbRange"><option value="none">Nothing</option><option value="seen">Since last visit</option>${s.conv ? '<option value="conversation">This conversation</option>' : ''}<option value="last">Last X changes</option><option value="hour">Last hour</option><option value="day">Last 24 hours</option><option value="custom">Time range</option></select></label>
      <input id="${P}fbCount" class="fb-count" type="number" min="1" max="5000" aria-label="Number of changes" value="${esc(String(s.count))}" hidden>
      <label id="${P}fbFromLabel" hidden>From <input id="${P}fbFrom" type="datetime-local" value="${esc(s.from)}"></label><label id="${P}fbToLabel" hidden>To <input id="${P}fbTo" type="datetime-local" value="${esc(s.to)}"></label>
      <label>By <select id="${P}fbActor"><option value="">Everyone</option><option value="ai">Agents</option><option value="human">Editor saves</option><option value="external">Unknown / external</option><option value="git">Git commits</option></select></label>
      ${beside ? `<button id="${P}fbRefresh" class="fb-refresh" title="Read the folder again">↻</button>` : ''}
    </div>
    <div class="fb-toolbar fb-browse-bar"><select id="${P}fbRoot" aria-label="Repository" hidden></select><label><input id="${P}fbOnly" type="checkbox"> Changed only</label>
      <div class="fb-finder" id="${P}fbFinder"><form id="${P}fbSearchForm" class="fb-search-form" role="search"><svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="4.5"/><path d="m10 10 4 4"/></svg><input id="${P}fbSearch" class="fb-search" type="search" disabled placeholder="Go to file" aria-label="Go to file" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${P}fbFinderList" ${beside ? '' : 'aria-keyshortcuts="T"'} autocomplete="off" spellcheck="false">${beside ? '' : '<kbd aria-hidden="true">T</kbd>'}</form>
        <div id="${P}fbFinderPopup" class="fb-finder-popup" hidden><div class="fb-finder-tools"><select id="${P}fbFindMode" aria-label="Search mode"><option value="files">File names</option><option value="contents">File contents</option></select><span>Entire repository</span><button id="${P}fbFindSubmit" type="button" hidden>Search</button></div><div id="${P}fbFinderList" class="fb-finder-list" role="listbox" aria-label="Matching files and folders"></div><div id="${P}fbFinderStatus" class="fb-finder-status" role="status"></div><div class="fb-finder-help">↑ ↓ select · Enter open · Shift+Enter ${beside ? 'in the middle' : 'beside'} · Esc close</div></div>
      </div><button id="${P}fbNew" class="fb-new">+ Document</button>${typeof Notes !== 'undefined' ? `<button id="${P}fbInk" title="A note, kept in documents/notes/: write with a pen or type, whichever you do first (N)">✎ Note</button>` : ''}</div>
    <div id="${P}fbNotice" class="fb-notice" role="status"></div><div id="${P}fbBody">Loading files…</div>`;
  s.el = section;
  host.replaceChildren(section);
  fb$(s, 'fbConversation')?.addEventListener('click', () => open(s.conv, 'restore'));
  fb$(s, 'fbSummary')?.addEventListener('click', () => showProjectOverview(project));
  fb$(s, 'fbToBeside')?.addEventListener('click', () => fbToBeside(s));
  fb$(s, 'fbNew').onclick = () => createProjectDocument(project);
  if (fb$(s, 'fbInk')) fb$(s, 'fbInk').onclick = () => Notes.create(project);
  fb$(s, 'fbRefresh').onclick = () => fbLoad(s);
  fb$(s, 'fbRange').value = s.range; fb$(s, 'fbActor').value = s.actor;
  fb$(s, 'fbOnly').checked = s.only;
  fbFinderSetup(s);
  const controls = () => {
    s.range = fb$(s, 'fbRange').value; s.actor = fb$(s, 'fbActor').value;
    s.count = Math.max(1, Math.min(5000, Number(fb$(s, 'fbCount').value) || 20));
    s.from = fb$(s, 'fbFrom').value; s.to = fb$(s, 'fbTo').value;
    fb$(s, 'fbCount').hidden = s.range !== 'last';
    fb$(s, 'fbFromLabel').hidden = fb$(s, 'fbToLabel').hidden = s.range !== 'custom';
  };
  controls();
  for (const id of ['fbRange', 'fbActor', 'fbCount', 'fbFrom', 'fbTo']) fb$(s, id).onchange = () => { controls(); fbLoad(s); };
  fb$(s, 'fbOnly').onchange = () => { s.only = fb$(s, 'fbOnly').checked; fbPaint(s); };
  fb$(s, 'fbRoot').onchange = () => { fbFinderClose(s); s.root = fb$(s, 'fbRoot').value; s.dir = ''; fbLoad(s); };
  s.el.querySelectorAll('[data-fb-mode]').forEach(b => b.onclick = () => { s.mode = b.dataset.fbMode; fbRemember(s); fbPaint(s); });
  await fbLoad(s);
}
// Where the browser is now: the middle's in its route, Beside's in its tab.
function fbRemember(s) {
  if (s.place === 'beside') {
    if (typeof Beside !== 'undefined' && fbCurrent(s)) Beside.update({ root: s.root, dir: s.dir, mode: s.mode });
    return;
  }
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
  fb$(s, 'fbNotice').textContent = 'Loading…';
  try {
    const params = fbActivityParams(s);
    const [tree, activity] = await Promise.all([
      fbJSON('/api/files/browse?' + new URLSearchParams({ name: s.project, root: s.root, dir: s.dir, q: s.query, contents: s.contents ? '1' : '0' })),
      s.range === 'none' ? Promise.resolve({ events: [] }) : fbJSON('/api/files/activity?' + params).catch(e => ({ events: [], error: e.message })),
    ]);
    if (!fbCurrent(s) || ticket !== s.load) return;
    s.tree = tree; s.root = tree.root; s.dir = tree.dir; s.events = activity.events; s.activity = activity;
    fb$(s, 'fbSearch').disabled = false;
    s.groups = new Map();
    for (const e of s.events) { if (!s.groups.has(e.path)) s.groups.set(e.path, []); s.groups.get(e.path).push(e); }
    fb$(s, 'fbRoot').innerHTML = tree.roots.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
    fb$(s, 'fbRoot').value = tree.roots.find(r => r === s.root) || tree.roots[0]; fb$(s, 'fbRoot').hidden = tree.roots.length < 2;
    fbStore('visited:' + s.project, Date.now());
    fbRemember(s); fbPaint(s);
  } catch (e) { if (fbCurrent(s) && ticket === s.load) fb$(s, 'fbNotice').textContent = e.message; }
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
  // The middle's browser, or one in Beside's tab shown.
  if (document.hidden || (viewKind !== 'files-browser' && !(besideBrowser && fbCurrent(besideBrowser)))) return;
  const now = Date.now();
  document.querySelectorAll('.fb-view [data-fb-time]').forEach(el => {
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
  s.el.querySelectorAll('[data-fb-mode]').forEach(b => { b.classList.toggle('on', b.dataset.fbMode === s.mode); b.setAttribute('aria-current', b.dataset.fbMode === s.mode ? 'page' : 'false'); });
  fb$(s, 'fbNotice').textContent = [s.activity.historyWarning || '', s.activity.error ? 'Activity unavailable: ' + s.activity.error : '', s.tree.truncated ? 'Search/listing limit reached. Narrow your search or open a folder.' : '', s.activity.truncated ? `Showing the newest ${s.events.length} recorded changes; narrow the range for more.` : '', s.range === 'conversation' ? 'Highlighting this conversation; files show their current contents.' : '', s.range === 'seen' ? 'Since your previous Files visit on this browser.' : ''].filter(Boolean).join(' ');
  if (s.mode === 'changes') return fbPaintChanges(s);
  const parts = s.dir.split('/').filter(Boolean);
  fb$(s, 'fbBody').innerHTML = `<nav class="fb-crumbs" aria-label="Folder path"><button data-fb-dir="">${esc(s.project)}</button>${parts.map((part, i) => `<span>/</span><button data-fb-dir="${esc(parts.slice(0, i + 1).join('/'))}">${esc(part)}</button>`).join('')}</nav><div class="fb-list" id="${s.pre}fbList"></div><section id="${s.pre}fbReadme" class="fb-readme"></section>`;
  const entries = s.tree.entries.map(e => {
    const events = e.directory ? s.events.filter(x => x.path.startsWith(e.path + '/')) : s.groups.get(e.path) || [];
    return { ...e, events };
  }).filter(e => !s.only || e.events.length);
  s.rows = entries;
  fb$(s, 'fbList').innerHTML = entries.map((e, i) => `<div class="fb-row${e.events.length ? ' changed' : ''}" data-fb-row="${i}"><button data-fb-entry="${i}" ${e.link ? 'aria-disabled="true" title="Symbolic links are not opened by this browser"' : ''} aria-keyshortcuts="F2 Delete"><span aria-hidden="true">${e.directory ? '▸' : '·'}</span> ${esc(s.query ? e.rel : e.name)}${e.link ? ' ↗' : ''}</button><div>${e.directory || typeof presenceFileSlotHtml !== 'function' ? '' : presenceFileSlotHtml(e.path)}${fbBadge(s, e.events)}<span class="fb-row-acts">${e.directory || typeof OpenFiles === 'undefined' ? '' : OpenFiles.keepButtonHtml(e.path, s.project, { cls: 'fb-keep' })}<button type="button" class="fb-more" data-fb-menu="${i}" aria-haspopup="menu" aria-label="More actions for ${esc(e.name)}" title="Rename, duplicate, delete">⋯</button></span></div>${e.snippet != null ? `<code class="fb-snippet">${e.line}: ${esc(e.snippet)}</code>` : ''}</div>`).join('') || '<div class="empty">No matching files.</div>';
  if (typeof renderPresenceMarks === 'function') renderPresenceMarks();
  fb$(s, 'fbList').querySelectorAll('[data-fb-entry]').forEach(b => {
    const e = entries[Number(b.dataset.fbEntry)];
    b.onclick = ev => {
      // A link stays focusable (its actions work by keyboard) but does not open.
      if (e.link) return;
      if (e.directory && ev.shiftKey && typeof Beside !== 'undefined') {
        // Shift: the folder in the other place.
        if (s.place === 'beside') showFilesBrowser(s.project, { ...fbContext(s), dir: e.rel, query: '' });
        else Beside.openFolder(s.project, { conv: s.conv, root: s.root, dir: e.rel });
        return;
      }
      if (e.directory) { s.dir = e.rel; s.query = ''; fb$(s, 'fbSearch').value = ''; fbLoad(s); }
      else fbOpenFile(s, e.path, e.line, { other: ev.shiftKey });
    };
    // A middle click: a new tab beside, as a browser does.
    b.onauxclick = ev => {
      if (ev.button !== 1 || e.link || e.directory || typeof Beside === 'undefined') return;
      ev.preventDefault();
      Beside.open({ kind: 'document', path: e.path, project: s.project }, { origin: 'middle', newTab: true });
    };
    b.onkeydown = ev => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing) return;
      if (ev.key === 'F2') { ev.preventDefault(); ev.stopPropagation(); fbStartRename(s, e); }
      else if (ev.key === 'Delete' || (ev.key === 'Backspace' && ev.shiftKey)) { ev.preventDefault(); ev.stopPropagation(); fbDelete(s, e); }
      else if (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) { ev.preventDefault(); ev.stopPropagation(); fbEntryMenu(s, e, b); }
    };
  });
  fb$(s, 'fbList').querySelectorAll('[data-fb-menu]').forEach(b => b.onclick = ev => {
    ev.stopPropagation();
    fbEntryMenu(s, entries[Number(b.dataset.fbMenu)], b);
  });
  fb$(s, 'fbList').oncontextmenu = ev => {
    const row = ev.target.closest('[data-fb-row]');
    if (!row || ev.target.closest('input, .fb-snippet')) return;
    ev.preventDefault();
    fbEntryMenu(s, entries[Number(row.dataset.fbRow)], null, ev.clientX, ev.clientY);
  };
  fb$(s, 'fbBody').querySelectorAll('[data-fb-dir]').forEach(b => b.onclick = () => { s.dir = b.dataset.fbDir; s.query = ''; fb$(s, 'fbSearch').value = ''; fbLoad(s); });
  if (s.tree.readme && !s.only) fbReadme(s, s.tree.readme, fb$(s, 'fbReadme'));
  fbPaintDeleted(s);
  // After a rename, a copy or a delete: the place the person is working.
  const after = s.after; s.after = null;
  if (after) {
    const i = after.rel != null ? entries.findIndex(e => e.rel === after.rel) : Math.min(after.index, entries.length - 1);
    if (i >= 0) {
      if (after.rename) fbStartRename(s, entries[i]);
      else fb$(s, 'fbList').querySelector(`[data-fb-entry="${i}"]`)?.focus();
    }
  }
}

// ---- rename, duplicate, delete (file-ops.js on the server) ----
// Delete moves to “Recently deleted”, restorable for 30 days; every action
// offers Undo. Nothing is overwritten: the server refuses a taken name.
async function fbFileOp(s, body) {
  const r = await fetch('/api/files/op', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: s.project, root: s.root, ...body }) });
  const d = await r.json().catch(() => ({ error: 'The server did not answer.' }));
  if (!r.ok || d.error) throw new Error(d.error || 'That did not work.');
  return d;
}
// Paths this page just changed: their watcher echo is not “new activity”.
function fbOwnOp(s, ...paths) {
  const until = Date.now() + 20000;
  s.ownOps = (s.ownOps || []).filter(o => o.until > Date.now()).concat(paths.filter(Boolean).map(path => ({ path, until })));
}
const fbUnder = (p, base) => p === base || p.startsWith(base + '/') || p.startsWith(base + '\\');
// A conversation's remembered place in Files follows its file.
function fbMovePlaces(from, to) {
  for (const [key, place] of filesBrowserPlaces) {
    if (!place?.file || !fbUnder(place.file, from)) continue;
    if (to) filesBrowserPlaces.set(key, { ...place, file: to + place.file.slice(from.length) });
    else filesBrowserPlaces.set(key, place.context);
  }
}
function fbRowOf(s, e) {
  const i = (s.rows || []).indexOf(e);
  return i < 0 ? null : fb$(s, 'fbList')?.querySelector(`[data-fb-row="${i}"]`);
}
function fbEntryMenu(s, e, anchor, x = 0, y = 0) {
  if (!fbCurrent(s) || !e) return;
  closeFileActionMenu();
  const beside = s.place === 'beside', canBeside = typeof Beside !== 'undefined' && !e.link;
  const items = [
    ...(canBeside && !e.directory ? [
      [beside ? 'Open in the middle' : 'Open beside', 'Shift', () => fbOpenFile(s, e.path, e.line, { other: true }), beside ? 'Full page, in the middle; this folder stays beside' : 'Next to your work, in Beside; this folder stays'],
      ['Open in a new tab beside', '', () => Beside.open({ kind: 'document', path: e.path, project: s.project }, { origin: 'middle', newTab: true })],
    ] : []),
    ['Rename', 'F2', () => fbStartRename(s, e)],
    ['Duplicate', '', () => fbDuplicate(s, e)],
    ['Delete', 'Del', () => fbDelete(s, e), 'Moves it to Recently deleted, where it stays 30 days'],
  ];
  const menu = document.createElement('div');
  menu.className = 'file-action-menu fb-entry-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', e.name);
  menu.innerHTML = `<div class="file-action-head">${esc(e.rel)}${e.directory ? '/' : ''}</div>` + items.map(([label, key, , title], i) =>
    `<button type="button" role="menuitem" data-fb-action="${i}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}${key ? `<kbd>${key}</kbd>` : ''}</button>`).join('');
  document.body.appendChild(menu);
  if (anchor) { const r = anchor.getBoundingClientRect(); x = r.right - menu.offsetWidth; y = r.bottom + 2; anchor.setAttribute('aria-expanded', 'true'); }
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  const buttons = [...menu.querySelectorAll('[data-fb-action]')];
  const back = () => { anchor?.setAttribute('aria-expanded', 'false'); };
  buttons.forEach(b => b.onclick = ev => { ev.stopPropagation(); closeFileActionMenu(); back(); items[Number(b.dataset.fbAction)][2](); });
  menu.onkeydown = ev => {
    const at = buttons.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); buttons[(at + (ev.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus(); }
    else if (ev.key === 'Tab') { ev.preventDefault(); closeFileActionMenu(); back(); fbFocusEntry(s, e); }
  };
  // Escape (app.html) closes every action menu; focus returns to the row.
  new MutationObserver((_, obs) => { if (!menu.isConnected) { obs.disconnect(); back(); if (!document.activeElement || document.activeElement === document.body) fbFocusEntry(s, e); } }).observe(document.body, { childList: true });
  buttons[0].focus();
}
function fbFocusEntry(s, e) { fbRowOf(s, e)?.querySelector('[data-fb-entry]')?.focus(); }

// The name is edited where it is shown. Enter or leaving the field keeps
// it; Escape keeps the old one. A refusal (taken, invalid) stays in the
// field with the reason, so nothing typed is lost.
function fbStartRename(s, e) {
  const row = fbRowOf(s, e);
  if (!fbCurrent(s) || !row || row.querySelector('.fb-rename')) return;
  const button = row.querySelector('[data-fb-entry]');
  const form = document.createElement('form');
  form.className = 'fb-rename';
  form.innerHTML = `<input type="text" aria-label="New name for ${esc(e.name)}" spellcheck="false" autocomplete="off" autocapitalize="off" enterkeyhint="done"><span class="fb-rename-error" role="alert"></span>`;
  const input = form.querySelector('input'), error = form.querySelector('.fb-rename-error');
  input.value = e.name;
  button.hidden = true;
  button.after(form);
  input.focus();
  // The name, not its ending: typing replaces “report” in “report.md”.
  const ending = e.directory ? null : /(\.ink\.svg|\.tar\.(?:gz|bz2|xz|zst)|\.d\.ts|\.[^.]+)$/i.exec(e.name);
  input.setSelectionRange(0, ending && ending.index > 0 ? ending.index : e.name.length);
  let done = false;
  const finish = (focus = true) => {
    done = true; form.remove(); button.hidden = false;
    if (focus) button.focus();
  };
  const commit = async ({ leaving = false } = {}) => {
    if (done || form.dataset.busy) return;
    const name = input.value.trim();
    if (!name || name === e.name) return finish(!leaving);
    if (name.includes('/')) { error.textContent = 'A name cannot contain “/”.'; input.setAttribute('aria-invalid', 'true'); if (!leaving) input.focus(); return; }
    form.dataset.busy = '1'; input.readOnly = true;
    try {
      const out = await fbFileOp(s, { op: 'rename', rel: e.rel, to: name });
      done = true;
      fbOwnOp(s, out.from, out.to);
      fbMovePlaces(out.from, out.to);
      const oldName = e.name;
      toast('Renamed to ' + name + ' · Undo', () => fbUndo(s, { op: 'rename', rel: out.rel, to: oldName }, 'Renamed back to ' + oldName, { from: out.to, to: out.from }), '', { repeat: true });
      s.after = leaving ? null : { rel: out.rel };
      fbLoad(s);
    } catch (err) {
      delete form.dataset.busy; input.readOnly = false;
      if (!form.isConnected) return errToast(err.message);
      error.textContent = err.message; input.setAttribute('aria-invalid', 'true');
      // Leaving a refused name: say so, and keep the field for a second try.
      if (leaving) errToast(err.message); else { input.focus(); input.select(); }
    }
  };
  form.onsubmit = ev => { ev.preventDefault(); commit(); };
  input.oninput = () => { error.textContent = ''; input.removeAttribute('aria-invalid'); };
  input.onkeydown = ev => {
    ev.stopPropagation(); // typing a name is not a shortcut
    if (ev.key === 'Escape') { ev.preventDefault(); finish(); }
  };
  input.onblur = () => setTimeout(() => { if (!done && form.isConnected && document.activeElement !== input) commit({ leaving: true }); });
}

async function fbDuplicate(s, e) {
  try {
    const out = await fbFileOp(s, { op: 'duplicate', rel: e.rel });
    fbOwnOp(s, out.to);
    const name = out.rel.split('/').pop();
    toast('Duplicated as ' + name + ' · Undo', () => fbUndo(s, { op: 'delete', rel: out.rel }, 'Removed the copy (it is in Recently deleted)', { from: out.to }), '', { repeat: true });
    // The copy, ready to be named; Enter keeps “… copy”. In a search the
    // copy may not match the query: the list is refreshed and nothing more.
    s.after = { rel: out.rel, rename: true };
    fbLoad(s);
  } catch (err) { errToast(err.message); }
}

async function fbDelete(s, e) {
  const row = fbRowOf(s, e);
  if (row?.dataset.busy) return;
  if (row) row.dataset.busy = '1';
  try {
    const out = await fbFileOp(s, { op: 'delete', rel: e.rel });
    fbOwnOp(s, out.from);
    fbMovePlaces(out.from, null);
    toast('Deleted ' + e.name + ' · Undo', () => fbRestore(s, out.id), '', { repeat: true });
    s.after = { index: Math.max(0, (s.rows || []).indexOf(e)) };
    fbLoad(s);
  } catch (err) {
    if (row) delete row.dataset.busy;
    errToast(err.message);
  }
}
async function fbUndo(s, body, message, own) {
  try {
    const out = await fbFileOp(s, body);
    fbOwnOp(s, own.from, own.to);
    if (body.op === 'rename') fbMovePlaces(own.from, own.to);
    toast(message);
    if (fbCurrent(s)) { s.after = out.rel ? { rel: out.rel } : null; fbLoad(s); }
  } catch (err) { errToast('Could not undo: ' + err.message); }
}
async function fbRestore(s, id, root = '') {
  try {
    const out = await fbFileOp(s, { op: 'restore', id, ...(root ? { root } : {}) });
    fbOwnOp(s, out.to);
    toast(out.renamed ? 'Restored as ' + out.to.split(/[\\/]/).pop() + ' (its name was taken)' : 'Restored ' + out.to.split(/[\\/]/).pop());
    if (fbCurrent(s)) { s.after = !root || root === s.root ? { rel: out.rel } : null; fbLoad(s); }
  } catch (err) { errToast('Could not restore: ' + err.message); }
}

// Recently deleted: under the list, folded, only when something is there.
function fbPaintDeleted(s) {
  const host = document.createElement('section');
  host.id = s.pre + 'fbDeleted'; host.className = 'fb-deleted';
  fb$(s, 'fbList').after(host);
  const n = s.tree.deleted || 0;
  if (!n || s.query) return;
  host.innerHTML = `<button type="button" class="fb-deleted-toggle" aria-expanded="${!!s.deletedOpen}" aria-controls="${s.pre}fbDeletedList">Recently deleted (${n})</button><div id="${s.pre}fbDeletedList" class="fb-deleted-list"${s.deletedOpen ? '' : ' hidden'}></div>`;
  const list = host.querySelector('.fb-deleted-list');
  const toggle = host.querySelector('.fb-deleted-toggle');
  const load = async () => {
    list.textContent = 'Loading…';
    try {
      const d = await fbJSON('/api/files/deleted?' + new URLSearchParams({ name: s.project }));
      if (!list.isConnected) return;
      const many = new Set(d.items.map(i => i.root)).size > 1;
      list.innerHTML = `<p class="fb-deleted-note">Kept for 30 days, then removed for good.</p>` + (d.items.map((item, i) => `<div class="fb-deleted-row"><span title="${esc(item.root + '/' + item.rel)}">${esc(many ? item.root.split(/[\\/]/).pop() + '/' + item.rel : item.rel)}${item.directory ? '/' : ''}</span><span class="dim">deleted ${fbTimeHTML(item.at)}</span><button type="button" data-fb-restore="${i}">Restore</button></div>`).join('') || '<div class="empty">Nothing is waiting here any more.</div>');
      list.querySelectorAll('[data-fb-restore]').forEach(b => b.onclick = () => { b.disabled = true; const item = d.items[Number(b.dataset.fbRestore)]; fbRestore(s, item.id, item.root); });
    } catch (err) { if (list.isConnected) list.textContent = err.message; }
  };
  toggle.onclick = () => {
    s.deletedOpen = !s.deletedOpen;
    toggle.setAttribute('aria-expanded', String(s.deletedOpen));
    list.hidden = !s.deletedOpen;
    if (s.deletedOpen) load();
  };
  if (s.deletedOpen) load();
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
  fb$(s, 'fbBody').innerHTML = `<div class="fb-change-summary"><b>${groups.length} files · ${s.events.length} recorded changes</b><p>Combined comparisons use the nearest recorded versions. Filters select activity and files, not authorship of every line in a combined diff. Unknown external writes are not assumed to be human.</p><label>Diff layout <select id="${s.pre}fbDiffLayout"><option value="split">Side by side</option><option value="unified">Unified</option></select></label></div><div id="${s.pre}fbChanges"></div>`;
  fb$(s, 'fbDiffLayout').value = s.layout || 'split';
  fb$(s, 'fbDiffLayout').onchange = () => { s.layout = fb$(s, 'fbDiffLayout').value; fb$(s, 'fbChanges').classList.toggle('unified', s.layout === 'unified'); };
  fb$(s, 'fbChanges').classList.toggle('unified', s.layout === 'unified');
  if (!groups.length) fb$(s, 'fbChanges').innerHTML = '<div class="empty">No recorded changes in this selection.</div>';
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
    paintReview(); fb$(s, 'fbChanges').append(card);
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
  for (const s of fbLive()) fbActivityOne(s, d);
}
function fbActivityOne(s, d) {
  if (d.project && d.project !== s.project) return;
  // The echo of a rename, copy or delete made here: the list already shows it.
  if (d.path && (s.ownOps || []).some(o => o.until > Date.now() && fbUnder(d.path, o.path))) return;
  // Never replace a review or move focus under the reader. Refresh is explicit.
  fb$(s, 'fbNotice').textContent = 'New file activity is available. Refresh to include it; your current review stays in place.';
}
