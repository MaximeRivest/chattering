/* Beside (design/104): what you are using, kept in view next to your work.

   The screen has two places: the main place (the middle: a conversation, a
   project, a file, home) and Beside, the right column. Beside holds tabs,
   the things on the desk: a file in the real editor, a PDF at its page, a
   project's folder, what the conversation made, the Files / Artifacts /
   Programs lists, an artifact, a change. One tab shows; the others wait.

   - A tab follows the place it was opened in (the conversation on screen,
     a project page…): go elsewhere and it steps aside, come back and it is
     there again. Pinned, it stays on the desk wherever you go. Pinning a
     file also keeps it in Open files (design/77), on every device.
   - Each tab has its own ‹ back: a folder, a file opened from it, ‹ is the
     folder again, where it was. The browser's Back moves the middle only.
   - A click opens in the place it was made in: inside Beside, in the tab;
     in the middle, in the middle, except a conversation's links, which open
     beside it (design/83). Shift+click: the other place.
   - Opened from the middle, a thing goes to a tab of its own: the same
     thing already beside is shown again; else the place's unpinned reading
     tab takes it (what it showed stays one ‹ away); else a new tab. A
     folder or a list is never replaced from the middle: it is a place you
     browse, not something you read.
   - Things that open by themselves (an artifact an agent just made) never
     take the screen from a pinned tab, a file being edited, a folder or a
     list: they are offered in a notice instead.

   The artifact panel (artifacts.js) draws the tab that shows; this module
   decides which one, and keeps the desk: per device, in localStorage, so a
   phone and a wide screen can each have theirs. */
(function () {
  'use strict';
  const STORE = 'chattering.beside.v1';
  const LEGACY = 'chattering.artifact.v1:';   // a conversation's one thing beside it, before design/104
  const MAX_TABS = 40;                        // the whole desk, every place
  const MAX_FOLLOWING = 6;                    // unpinned tabs of one place
  const MAX_BACK = 20;
  // What survives a reload. A widget's or a picture's HTML is not kept: it
  // can be large, and its conversation shows it again.
  const LASTING = new Set(['files', 'document', 'file', 'folder', 'lists', 'change']);
  // What the app reads without an editor (file-media.js serves these).
  const MEDIA = /\.(pdf|png|jpe?g|gif|webp|avif|bmp|ico|mp4|m4v|webm|ogv|mov)$/i;
  const NAVIGATORS = new Set(['folder', 'lists']);
  const LIST_NAMES = { made: 'Made', files: 'Files', artifacts: 'Artifacts', programs: 'Programs' };

  let tabs = [];          // { id, spec, pinned, owner, back: [spec], at }
  let activeId = null;
  let hidden = false;     // the person put Beside away; its tabs stay
  let quiet = false;      // a floating window was closed: nothing else pops up until the middle moves
  let afterMove = null;   // { spec, opts }: opens beside the place the middle is about to go to
  let place = null;       // the main place on screen
  let seq = 0;
  let strip = null;
  // Lists shown or not: app.html keeps its own flag in step (rightFilesOpen).
  let onListsShown = null;

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const baseName = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
  const now = () => Date.now();

  // ---- what a tab shows --------------------------------------------------------

  /** A file opened beside: a PDF, a picture, a video or a sound is read (no editor); anything else is the editor. */
  function normalize(spec) {
    if (!spec || !spec.kind) return null;
    spec = { ...spec };
    if (spec.kind === 'document' && MEDIA.test(String(spec.path || ''))) spec.kind = 'file';
    if ((spec.kind === 'document' || spec.kind === 'file') && !spec.title) spec.title = baseName(spec.path);
    if (spec.kind === 'lists') spec.view = LIST_NAMES[spec.view] ? spec.view : 'files';
    delete spec.fromList;
    return spec;
  }
  /** Two specs show the same thing. */
  function ident(spec) {
    if (!spec) return '';
    switch (spec.kind) {
      case 'document': case 'file': return 'f|' + spec.path;
      case 'files': return 'a|' + spec.key + '|' + spec.path;
      case 'folder': return 'd|' + spec.project;
      case 'lists': return 'lists';
      case 'change': return 'c|' + spec.key + '|' + (spec.call || spec.ts || '') + '|' + spec.path;
      case 'html': return 'h|' + spec.key + '|' + (spec.site || spec.title || '');
      case 'media': return 'm|' + spec.src;
      case 'context': return 'ctx|' + spec.key;
      default: return spec.kind + '|' + (spec.path || spec.key || '');
    }
  }
  const isFile = spec => !!spec && (spec.kind === 'document' || spec.kind === 'file');
  const GLYPH = { pdf: '▯', image: '◩', video: '▷', md: '¶', ink: '✎', code: '‹›' };
  function fileGlyph(path) {
    const p = String(path || '');
    if (/\.ink\.svg$/i.test(p)) return GLYPH.ink;
    if (/\.pdf$/i.test(p)) return GLYPH.pdf;
    if (/\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(p)) return GLYPH.image;
    if (/\.(mp4|m4v|webm|ogv|mov)$/i.test(p)) return GLYPH.video;
    if (/\.(md|markdown|mdx|qmd|rmd)$/i.test(p)) return GLYPH.md;
    return GLYPH.code;
  }
  function folderTitle(spec) {
    const dir = String(spec.dir || '').split('/').filter(Boolean).pop();
    return dir ? dir + '/' : (spec.project || 'Folder');
  }
  /** [glyph, name] of what a spec shows. */
  function label(spec) {
    if (!spec) return ['', ''];
    switch (spec.kind) {
      case 'document': case 'file': return [fileGlyph(spec.path), spec.title || baseName(spec.path)];
      case 'files': return ['◧', spec.title || baseName(spec.path) || 'Artifact'];
      case 'folder': return ['▦', folderTitle(spec)];
      case 'lists': return ['☰', LIST_NAMES[spec.view] || 'Files'];
      case 'change': return ['±', spec.title || baseName(spec.path)];
      case 'html': return ['◫', spec.title || 'Widget'];
      case 'media': return ['▣', spec.title || 'Picture'];
      case 'context': return ['@', 'Context'];
      default: return ['◧', spec.title || 'Beside'];
    }
  }
  /** What a tab is, in words, for its tooltip. */
  function describe(tab) {
    const s = tab.spec;
    const what = s.kind === 'context' ? 'Context for the next message: find it, choose how much'
      : s.kind === 'folder' ? 'Folder ' + (s.project || '') + (s.dir ? '/' + s.dir : '')
      : s.kind === 'lists' ? LIST_NAMES[s.view] + ' list'
      : isFile(s) || s.kind === 'change' || s.kind === 'files' ? String(s.path || s.title || '')
      : s.title || '';
    const how = tab.pinned ? 'Pinned: stays beside wherever you go' : 'Follows ' + placeName(tab.owner) + ': steps aside elsewhere, back when you return';
    return what + '\n' + how;
  }
  function placeName(key) {
    if (!key) return 'this page';
    if (key.startsWith('project:')) return 'the project ' + key.slice(8);
    if (key.startsWith('file:')) return baseName(key.slice(5));
    if (key.startsWith('draft:')) return 'this new conversation';
    if (key === 'home') return 'home';
    const s = typeof sessions !== 'undefined' && Array.isArray(sessions) ? sessions.find(x => x && x.key === key) : null;
    return s ? '“' + String(s.title || s.timelineTitle || 'its conversation').replace(/\s+/g, ' ').slice(0, 60) + '”' : 'its conversation';
  }

  // ---- the main place ---------------------------------------------------------------

  /** Which place is in the middle now: the key unpinned tabs follow. */
  function placeNow() {
    const vk = typeof viewKind !== 'undefined' ? viewKind : 'home';
    const rel = typeof activeRel !== 'undefined' ? activeRel : null;
    if ((vk === 'conversation' || vk === 'draft') && rel) return rel;
    if (vk === 'project' || vk === 'files-browser') return 'project:' + (typeof projectOverviewName !== 'undefined' && projectOverviewName || '');
    if (vk === 'file' && typeof fileWs !== 'undefined' && fileWs && fileWs.placement !== 'beside') return 'file:' + fileWs.path;
    // Settings opens over the page: the place stays the one under it.
    if (vk === 'settings') return place || 'home';
    return vk || 'home';
  }

  // ---- the desk, kept per device ---------------------------------------------------------

  function save() {
    try {
      const keep = tabs.filter(t => LASTING.has(t.spec.kind)).map(t => ({ ...t, back: t.back.filter(b => LASTING.has(b.kind)) }));
      localStorage.setItem(STORE, JSON.stringify({ tabs: keep, activeId, hidden }));
    } catch {}
  }
  function load() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch {}
    if (!d || !Array.isArray(d.tabs)) return;
    tabs = d.tabs.map(t => ({ id: String(t.id || 't' + (++seq)), spec: normalize(t.spec), pinned: !!t.pinned, owner: t.owner || null, lists: !!t.lists,
      back: (Array.isArray(t.back) ? t.back : []).map(normalize).filter(Boolean), at: Number(t.at) || 0 }))
      .filter(t => t.spec && LASTING.has(t.spec.kind));
    activeId = d.activeId || null;
    hidden = !!d.hidden;
    for (const t of tabs) { const n = Number(String(t.id).slice(1)); if (n > seq) seq = n; }
  }

  // ---- which tabs are on the desk here ---------------------------------------------------

  // A floating window stays over every page (design/67): its tab with it.
  const floatingId = () => typeof Artifacts !== 'undefined' && Artifacts.floating() ? activeId : null;
  // The project a place is in: a folder tab follows its project, beside
  // the project's page, its files and every conversation in it.
  function projectOfPlace(key) {
    if (!key) return '';
    if (key.startsWith('project:')) return key.slice(8);
    if (key.startsWith('file:')) return typeof fileWs !== 'undefined' && fileWs && fileWs.placement !== 'beside' ? fileWs.project || '' : '';
    const s = typeof sessions !== 'undefined' && Array.isArray(sessions) ? sessions.find(x => x && x.key === key) : null;
    const p = s && typeof projectOf === 'function' ? projectOf(s) : '';
    return p && p !== '?' && (typeof LOOSE_PROJECT === 'undefined' || p !== LOOSE_PROJECT) ? p : '';
  }
  /** The tab is on the desk here: pinned, or following this place (or its project). */
  function here(t) {
    if (t.pinned || t.owner === place) return true;
    return !!t.owner && t.owner.startsWith('project:') && t.owner.slice(8) === projectOfPlace(place);
  }
  /** Whom an unpinned tab follows: a folder its project, anything else the place it is opened in. */
  const ownerFor = spec => spec && spec.kind === 'folder' && spec.project ? 'project:' + spec.project : place;
  const visible = () => { const f = floatingId(); return tabs.filter(t => here(t) || t.id === f); };
  const byId = id => tabs.find(t => t.id === id) || null;
  function active() {
    const vis = visible();
    const a = byId(activeId);
    if (a && vis.includes(a)) return a;
    return vis.slice().sort((x, y) => y.at - x.at)[0] || null;
  }
  const shown = () => !hidden && !quiet && !!active();

  // ---- the files a tab holds warm --------------------------------------------------------
  // A file in a tab keeps its editor when another tab shows (parked by Open
  // files' mechanism, within its budget), as a browser tab keeps its page.
  function holdFiles() {
    if (typeof OpenFiles === 'undefined' || !OpenFiles.hold) return;
    // What a tab shows, and what its ‹ goes back to (the budget of warm editors still applies).
    OpenFiles.hold(new Set(tabs.flatMap(t => [t.spec, ...t.back]).filter(x => x.kind === 'document').map(x => x.path)));
  }

  // ---- changing the desk ----------------------------------------------------------------

  function trim() {
    // Too many unpinned tabs of one place: the one shown longest ago goes.
    const a = active();
    const following = tabs.filter(t => !t.pinned && here(t) && t !== a).sort((x, y) => x.at - y.at);
    while (following.length >= MAX_FOLLOWING) { const t = following.shift(); tabs = tabs.filter(x => x !== t); }
    // The whole desk: tabs of places left long ago go first.
    if (tabs.length > MAX_TABS) {
      const old = tabs.filter(t => !t.pinned && t !== a && !here(t)).sort((x, y) => x.at - y.at);
      while (tabs.length > MAX_TABS && old.length) { const t = old.shift(); tabs = tabs.filter(x => x !== t); }
    }
  }
  function add(spec, { pinned = false, owner = ownerFor(spec) } = {}) {
    const t = { id: 't' + (++seq), spec, pinned, owner: pinned ? null : owner, back: [], at: now() };
    // New tabs go right after the one shown, as in a browser.
    const a = active(), i = a ? tabs.indexOf(a) : -1;
    if (i >= 0) tabs.splice(i + 1, 0, t); else tabs.push(t);
    trim();
    return t;
  }
  /** The tab goes to `spec`; what it showed is one ‹ away. */
  function navigate(tab, spec) {
    if (ident(tab.spec) === ident(spec)) { tab.spec = { ...tab.spec, ...spec }; return; }
    tab.back.push(tab.spec);
    if (tab.back.length > MAX_BACK) tab.back.shift();
    tab.spec = spec;
  }

  // The last thing the person touched was inside Beside: a click or a key
  // there opens there (design/104: "a click opens in the place it was made in").
  let paneTouch = 0;
  const inPane = el => !!el && typeof el.closest === 'function' && !!el.closest('#artifactPane');
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, e => {
    // The tab strip is Beside's own furniture, not a place things open from.
    if (inPane(e.target) && !e.target.closest('.bs-strip')) paneTouch = now();
    else if (!inPane(e.target)) paneTouch = 0;
  }, true);
  const touchedPane = () => paneTouch && now() - paneTouch < 2000;

  /**
   * Show `spec` beside. opts.origin: 'beside' (navigate the tab shown),
   * 'middle', or nothing (where the last click was). opts.newTab: always a
   * tab of its own. opts.pin: pinned at once. opts.auto: it opened by
   * itself; it never takes the screen from what the person is using.
   * opts.focus: false keeps the overlay (narrow screens) aside.
   */
  function open(spec, opts = {}) {
    spec = normalize(spec);
    if (!spec) return null;
    if (place == null) place = placeNow();
    const fromPane = opts.origin === 'beside' || (opts.origin == null && touchedPane());
    const vis = visible();
    let a = active();
    let tab = null;
    if (opts.auto) {
      const same = vis.find(t => ident(t.spec) === ident(spec));
      const busy = a && (a.pinned || NAVIGATORS.has(a.spec.kind) || a.spec.kind === 'document' || a.spec.kind === 'change' || a.owner !== place);
      if (same) tab = same;
      else if (busy || hidden || quiet) { offer(spec); return null; }
    }
    if (!tab && fromPane && a && !opts.newTab) { navigate(a, spec); tab = a; }
    if (!tab) tab = vis.find(t => ident(t.spec) === ident(spec)) || null;
    if (tab && tab.spec !== spec && ident(tab.spec) === ident(spec)) tab.spec = { ...tab.spec, ...spec };
    // A folder or a list is a place to browse: its own tab, never in place of something read.
    if (!tab && !opts.newTab && !NAVIGATORS.has(spec.kind)) {
      const reading = t => !t.pinned && t.owner === place && !NAVIGATORS.has(t.spec.kind) && !t.lists;
      const slot = a && reading(a) ? a : vis.filter(reading).sort((x, y) => y.at - x.at)[0];
      if (slot) { navigate(slot, spec); tab = slot; }
    }
    if (!tab) tab = add(spec, { pinned: !!opts.pin });
    if (opts.pin && !tab.pinned) setPinned(tab, true, { silent: true });
    hidden = false; quiet = false;
    activate(tab, { focus: opts.focus !== false });
    return tab;
  }
  function offer(spec) {
    if (typeof toast !== 'function') return;
    const [, name] = label(spec);
    toast('◨ New: ' + name + ' — open it beside', () => open(spec, { origin: 'middle' }));
  }

  /** Show this tab. */
  function activate(tab, { focus = true } = {}) {
    if (!tab) return;
    tab.at = now();
    activeId = tab.id;
    if (!tab.pinned && !here(tab)) tab.owner = ownerFor(tab.spec);
    save();
    holdFiles();
    render({ focus });
  }

  /** The tab's ‹: what it showed before. */
  function back(tab = active()) {
    if (!tab || !tab.back.length) return false;
    tab.spec = tab.back.pop();
    activate(tab);
    return true;
  }

  /** Close a tab. Its file's editor lets go (a kept file stays in Open files). */
  function close(tab = active()) {
    if (!tab) return;
    const was = active();
    // Closing a floating window closes the window: what the place had
    // docked beside does not take its place (it comes back with the next move).
    if (was === tab && typeof Artifacts !== 'undefined' && Artifacts.floating()) quiet = true;
    const i = tabs.indexOf(tab);
    tabs = tabs.filter(t => t !== tab);
    if (was === tab) {
      // The neighbour on the desk here takes its place, as in a browser.
      const vis = visible();
      const next = vis.find(t => tabs.indexOf(t) >= i) || vis[vis.length - 1] || null;
      activeId = next ? next.id : null;
      if (next) next.at = now();
    }
    save();
    holdFiles();
    render({ focus: false });
  }

  function setPinned(tab, on, { silent = false } = {}) {
    if (!tab) return;
    tab.pinned = !!on;
    tab.owner = on ? null : ownerFor(tab.spec);
    // A file pinned beside is kept in Open files too: the side list on every device.
    if (on && isFile(tab.spec) && typeof OpenFiles !== 'undefined' && !OpenFiles.isKept(tab.spec.path)) {
      OpenFiles.keep(tab.spec.path, tab.spec.project || '', 'pin');
    }
    if (!silent && typeof toast === 'function') {
      toast(on ? '📌 Pinned: ' + label(tab.spec)[1] + ' stays beside wherever you go' + (isFile(tab.spec) ? ' (and in Open files)' : '')
        : 'Unpinned: ' + label(tab.spec)[1] + ' now follows ' + placeName(tab.owner));
    }
    save();
    paintStrip();
  }

  /** The tab shown changed what it shows by itself (a folder moved to another folder): no ‹ step. */
  function update(patch, tab = active()) {
    if (!tab) return;
    tab.spec = { ...tab.spec, ...patch };
    save();
    paintStrip();
  }

  // ---- drawing ----------------------------------------------------------------------------

  let rendering = false;
  function render({ focus = false } = {}) {
    if (typeof Artifacts === 'undefined') return;
    const a = active();
    if (rendering) return;
    rendering = true;
    try {
      if (!a || hidden || quiet) Artifacts.hide();
      // One file is edited at a time: while one is open in the middle, a
      // file tab shows a copy to read, with the way to edit it here.
      else Artifacts.show(a.spec, { focus, readOnly: middleEdits(a.spec) });
    } finally { rendering = false; }
    paintStrip();
    paintToggle();
    syncLists();
  }
  // The lists are on screen: their tab shows, and (narrow) is not stepped aside.
  function syncLists() {
    const a = active();
    const on = !!a && !hidden && !quiet && a.spec.kind === 'lists' && !(window.Pair && Pair.overlay() && Pair.tilt() === 'talk');
    if (typeof onListsShown === 'function') onListsShown(on);
  }

  function ensureStrip() {
    const pane = document.getElementById('artifactPane');
    if (!pane) return null;
    if (strip && pane.contains(strip)) return strip;
    strip = pane.querySelector('.bs-strip');
    if (!strip) return null;
    strip.addEventListener('click', e => {
      const x = e.target.closest('[data-bs-close]');
      if (x) { e.stopPropagation(); close(byId(x.dataset.bsClose)); return; }
      const t = e.target.closest('[data-bs-tab]');
      if (t) { e.stopPropagation(); activate(byId(t.dataset.bsTab)); return; }
      if (e.target.closest('[data-bs-new]')) { e.stopPropagation(); newTabMenu(e.target.closest('[data-bs-new]')); }
    });
    // Middle click closes, as in a browser.
    strip.addEventListener('auxclick', e => {
      const t = e.target.closest('[data-bs-tab]');
      if (t && e.button === 1) { e.preventDefault(); close(byId(t.dataset.bsTab)); }
    });
    strip.addEventListener('contextmenu', e => {
      const t = e.target.closest('[data-bs-tab]');
      if (!t) return;
      e.preventDefault();
      tabMenu(byId(t.dataset.bsTab), e.clientX, e.clientY);
    });
    strip.addEventListener('keydown', e => {
      const t = e.target.closest('[data-bs-tab]');
      if (!t) return;
      const all = [...strip.querySelectorAll('[data-bs-tab]')];
      const i = all.indexOf(t);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]?.focus();
      } else if (e.key === 'Delete') { e.preventDefault(); close(byId(t.dataset.bsTab)); }
      else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); const r = t.getBoundingClientRect(); tabMenu(byId(t.dataset.bsTab), r.left, r.bottom + 2); }
    });
    return strip;
  }

  function paintStrip() {
    const s = ensureStrip();
    if (!s) return;
    const a = active();
    const vis = visible();
    // Keys move between tabs: the focus stays on the tab chosen after a redraw.
    const hadFocus = s.contains(document.activeElement);
    s.innerHTML = vis.map(t => {
      const [glyph, name] = label(t.spec);
      const on = t === a;
      return `<div class="bs-tab${on ? ' on' : ''}${t.pinned ? ' pinned' : ''}" role="presentation">`
        + `<button type="button" role="tab" class="bs-tab-main" data-bs-tab="${esc(t.id)}" aria-selected="${on}" tabindex="${on ? 0 : -1}" title="${esc(describe(t))}">`
        + `<span class="bs-glyph" aria-hidden="true">${esc(glyph)}</span><span class="bs-name">${esc(name)}</span>${t.pinned ? '<span class="bs-pin" aria-label="pinned">📌</span>' : ''}</button>`
        + `<button type="button" class="bs-x" tabindex="-1" data-bs-close="${esc(t.id)}" title="Close this tab${isFile(t.spec) ? ' (a file kept in Open files stays there)' : ''}" aria-label="Close ${esc(name)}">✕</button></div>`;
    }).join('') + `<button type="button" class="bs-new" data-bs-new title="Put something else beside: this project's folder, what the conversation made, the lists" aria-label="Open something beside" aria-haspopup="menu">+</button>`;
    s.setAttribute('role', 'tablist');
    s.setAttribute('aria-label', 'Beside');
    const on = s.querySelector('.bs-tab.on');
    if (on && s.scrollWidth > s.clientWidth) on.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    if (hadFocus) (on?.querySelector('.bs-tab-main') || s.querySelector('.bs-new'))?.focus({ preventScroll: true });
    paintHead(a);
  }

  // The head's own controls for the tab shown: ‹ back and the pin.
  function paintHead(a) {
    const pane = document.getElementById('artifactPane');
    if (!pane) return;
    const b = pane.querySelector('[data-art-act="back"]');
    if (b) {
      const prev = a && a.back.length ? a.back[a.back.length - 1] : null;
      b.hidden = !prev;
      if (prev) {
        const name = label(prev)[1];
        b.querySelector('.bs-back-name').textContent = name;
        b.title = 'Back to ' + name + ' (in this tab)';
        b.setAttribute('aria-label', b.title);
      }
    }
    const p = pane.querySelector('[data-art-act="pin"]');
    if (p) {
      p.hidden = !a;
      const on = !!a && a.pinned;
      p.setAttribute('aria-pressed', String(on));
      p.classList.toggle('on', on);
      p.title = on ? 'Pinned: stays beside wherever you go. Unpin: it follows ' + placeName(ownerFor(a.spec)) + ' again'
        : 'Pin: keep this beside wherever you go' + (a && isFile(a.spec) ? ', and in Open files on every device' : '');
      p.setAttribute('aria-label', on ? 'Unpin' : 'Pin');
    }
  }

  // The corner button: shows or puts away Beside, and says how many tabs wait.
  function paintToggle() {
    const t = document.getElementById('filesToggle');
    if (!t) return;
    const n = visible().length;
    const open = shown();
    t.setAttribute('aria-expanded', String(open));
    t.classList.toggle('bs-has', n > 0);
    t.innerHTML = '<span aria-hidden="true">◨</span>' + (n && !open ? `<span class="bs-count">${n}</span>` : '');
    t.title = open ? 'Put Beside away (Alt+B) — its tabs stay' : n ? `Beside: ${n} tab${n === 1 ? '' : 's'} (Alt+B)` : 'Beside: put a folder, a file or a list next to your work (Alt+B)';
    t.setAttribute('aria-label', t.title.replace(/ \(Alt\+B\).*$/, ''));
  }

  // ---- menus ------------------------------------------------------------------------------

  function menu(items, x, y, labelText) {
    if (typeof closeFileActionMenu === 'function') closeFileActionMenu();
    const m = document.createElement('div');
    m.className = 'file-action-menu bs-menu';
    m.setAttribute('role', 'menu');
    if (labelText) m.setAttribute('aria-label', labelText);
    m.innerHTML = items.map((it, i) => it.section ? `<div class="file-action-head">${esc(it.section)}</div>`
      : `<button type="button" role="menuitem" data-bs-item="${i}"${it.title ? ` title="${esc(it.title)}"` : ''}${it.disabled ? ' disabled' : ''}>${esc(it.label)}${it.key ? `<kbd>${esc(it.key)}</kbd>` : ''}</button>`).join('');
    document.body.appendChild(m);
    m.style.left = Math.max(8, Math.min(x, window.innerWidth - m.offsetWidth - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, window.innerHeight - m.offsetHeight - 8)) + 'px';
    m.querySelectorAll('[data-bs-item]').forEach(b => b.onclick = ev => { ev.stopPropagation(); m.remove(); items[Number(b.dataset.bsItem)].run(); });
    const buttons = [...m.querySelectorAll('button:not([disabled])')];
    m.onkeydown = ev => {
      const i = buttons.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); buttons[(i + (ev.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus(); }
      else if (ev.key === 'Escape' || ev.key === 'Tab') { ev.preventDefault(); m.remove(); }
    };
    const outside = ev => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('pointerdown', outside, true); } };
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
    buttons[0]?.focus();
    return m;
  }

  function tabMenu(tab, x, y) {
    if (!tab) return;
    const others = visible().filter(t => t !== tab && !t.pinned);
    menu([
      { label: tab.pinned ? 'Unpin' : 'Pin — keep it beside everywhere', run: () => setPinned(tab, !tab.pinned) },
      ...(canMiddle(tab.spec) ? [{ label: 'Open in the middle', run: () => toMiddle(tab) }] : []),
      { label: 'Close', key: 'Del', run: () => close(tab) },
      ...(others.length ? [{ label: 'Close the other unpinned tabs', run: () => { tabs = tabs.filter(t => !others.includes(t)); save(); holdFiles(); render(); } }] : []),
    ], x, y, label(tab.spec)[1]);
  }

  // What the + offers: the places and lists one reaches for most.
  function newTabMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    const project = currentProject();
    const conv = typeof viewKind !== 'undefined' && viewKind === 'conversation' && typeof activeRel !== 'undefined' ? activeRel : '';
    const items = [];
    if (project) items.push({ label: '▦ The folder of ' + project, run: () => openFolder(project, { conv }) });
    if (conv) items.push({ label: '☰ What this conversation made', run: () => showLists('made') });
    items.push({ label: '☰ Recent files', run: () => showLists('files') });
    items.push({ label: '☰ Artifacts', run: () => showLists('artifacts') });
    items.push({ label: '☰ Programs', run: () => showLists('programs') });
    menu(items, r.right - 260, r.bottom + 4, 'Open beside');
  }

  function currentProject() {
    const vk = typeof viewKind !== 'undefined' ? viewKind : '';
    if ((vk === 'project' || vk === 'files-browser') && typeof projectOverviewName !== 'undefined' && projectOverviewName) return projectOverviewName;
    if (vk === 'conversation' && typeof current !== 'undefined' && current && typeof projectOf === 'function') {
      const s = typeof sessions !== 'undefined' ? sessions.find(x => x.key === current.key) : null;
      const p = s ? projectOf(s) : null;
      if (p && p !== '?' && (typeof LOOSE_PROJECT === 'undefined' || p !== LOOSE_PROJECT)) return p;
    }
    if (vk === 'file' && typeof fileWs !== 'undefined' && fileWs && fileWs.project) return fileWs.project;
    const scope = typeof workspaceScope === 'function' ? workspaceScope() : '';
    return scope && (typeof LOOSE_PROJECT === 'undefined' || scope !== LOOSE_PROJECT) ? scope : '';
  }

  // ---- ways in -------------------------------------------------------------------------------

  /** A project's folder beside: the files browser, placed in the panel. */
  function openFolder(project, { conv = '', root = '', dir = '', origin = 'middle', newTab = false } = {}) {
    if (!project) return null;
    return open({ kind: 'folder', project, conv: conv || '', root: root || '', dir: dir || '', mode: 'browse' }, { origin, newTab });
  }
  /** The lists (Made, Files, Artifacts, Programs): one tab, pinned by default (it was always the column's). */
  function showLists(view, { focus = true } = {}) {
    view = LIST_NAMES[view] ? view : (typeof rightFilesView !== 'undefined' ? rightFilesView : 'files');
    if (typeof rightFilesView !== 'undefined' && rightFilesView !== view && typeof setRightViewQuiet === 'function') setRightViewQuiet(view);
    // The lists' tab, even if a file opened from them shows in it now: the
    // lists come back on top (the file stays one ‹ away).
    let tab = tabs.find(t => t.lists) || tabs.find(t => t.spec.kind === 'lists');
    if (tab) {
      if (tab.spec.kind === 'lists') tab.spec = { ...tab.spec, view };
      else navigate(tab, { kind: 'lists', view });
      if (!tab.pinned && !here(tab)) tab.owner = place;
    } else tab = add({ kind: 'lists', view }, { pinned: true });
    tab.lists = true;
    hidden = false; quiet = false;
    activate(tab, { focus });
    return tab;
  }
  /** At start: the lists were open in the old right column; they become a pinned tab. */
  function adoptLists(view) {
    if (tabs.some(t => t.lists)) return;
    const t = add({ kind: 'lists', view: LIST_NAMES[view] ? view : 'files' }, { pinned: true });
    t.lists = true;
    save();
  }
  /** The lists' own ✕ (and the phone's sheet closing): their tab goes. */
  function hideLists() {
    const tab = tabs.find(t => t.lists) || tabs.find(t => t.spec.kind === 'lists');
    if (tab) close(tab);
  }
  const listsShowing = () => { const a = active(); return shown() && !!a && a.spec.kind === 'lists'; };

  const canMiddle = spec => !!spec && ['document', 'file', 'folder', 'change'].includes(spec.kind);
  /** The tab's thing goes to the middle (full page); the tab closes. */
  function toMiddle(tab = active()) {
    if (!tab || !canMiddle(tab.spec)) return false;
    const s = tab.spec;
    if (s.kind === 'folder') {
      close(tab);
      if (typeof showFilesBrowser === 'function') showFilesBrowser(s.project, { conv: s.conv || '', root: s.root || '', dir: s.dir || '', mode: s.mode || 'browse' });
      return true;
    }
    if (s.kind === 'change') {
      close(tab);
      if (typeof openToolCallFile === 'function') openToolCallFile(s.key, s.path, s.ts, s.anchor, s.call);
      return true;
    }
    // A file: the editor moves as it is (live-file.js), or the reader opens full page.
    const ws = typeof fileWs !== 'undefined' ? fileWs : null;
    const moving = s.kind === 'document' && ws && ws.placement === 'beside' && ws.path === s.path && typeof fileWsToPage === 'function';
    tabs = tabs.filter(t => t !== tab);
    if (activeId === tab.id) activeId = null;
    save(); holdFiles();
    if (moving) {
      // The panel lets go of the frame without closing the editor.
      Artifacts.hide({ keepEditor: true });
      fileWsToPage(ws);
    } else if (typeof openLiveFile === 'function') {
      openLiveFile(s.path, { project: s.project || null, back: typeof currentHash !== 'undefined' ? currentHash : null });
    }
    render({ focus: false });
    return true;
  }

  /**
   * The middle is about to leave `spec` (◨ Beside): it opens beside the
   * place the middle goes to, as if opened there. go() moves the middle.
   */
  async function sendFromMiddle(spec, go) {
    afterMove = { spec, opts: { origin: 'middle' } };
    try { await go(); } finally {
      await new Promise(r => setTimeout(r));
      // The middle did not move (nowhere to go back to): it opens here.
      if (afterMove) { const m = afterMove; afterMove = null; open(m.spec, m.opts); }
    }
  }
  /** Put what the middle shows beside, and go back to where you were before it. */
  async function fromMiddle() {
    const vk = typeof viewKind !== 'undefined' ? viewKind : '';
    if (vk === 'file' && typeof fileWs !== 'undefined' && fileWs && fileWs.placement === 'page' && typeof fileWsToBeside === 'function') return fileWsToBeside(fileWs);
    if (vk === 'files-browser' && typeof filesBrowser !== 'undefined' && filesBrowser && typeof fbToBeside === 'function') return fbToBeside(filesBrowser);
    if (typeof toast === 'function') toast('Only a file or a folder in the middle can go beside; ＋ in Beside\'s tabs opens the folder and the lists');
    return false;
  }

  // ---- following the main place ---------------------------------------------------------------

  function placeChanged() {
    const next = placeNow();
    const moved = next !== place;
    place = next;
    if (moved) quiet = false;
    if (moved) adoptLegacy(place);
    const a = active();
    // A file being edited beside is with the conversation on screen now
    // (its ask box sends there; the pair's ☷ names it), or with none.
    if (a && a.spec.kind === 'document' && typeof fileWs !== 'undefined' && fileWs && fileWs.placement === 'beside' && fileWs.path === a.spec.path) {
      const vk = typeof viewKind !== 'undefined' ? viewKind : '';
      const conv = (vk === 'conversation' || vk === 'draft') && typeof activeRel !== 'undefined' ? activeRel : null;
      fileWs.besideKey = conv;
      a.spec = { ...a.spec, key: conv };
      if (window.Pair && Pair.repaint) Pair.repaint();
    }
    if (!moved) { paintStrip(); paintToggle(); return; }
    // Something sent beside on its way out of the middle (◨): it opens here,
    // in place of what this place had in front.
    if (afterMove) { const m = afterMove; afterMove = null; open(m.spec, m.opts); return; }
    // On a narrow screen the middle comes first after a move: what is
    // beside waits behind its pill, one tap away.
    if (a && window.Pair && Pair.overlay()) Pair.stepAside();
    render({ focus: false });
  }
  // A conversation's one thing beside it, remembered before Beside had tabs.
  function adoptLegacy(key) {
    if (!key || key.includes(':') && !/^(pi|pi-remote|claude|codex)[:]/.test(key)) return;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LEGACY + key) || 'null'); localStorage.removeItem(LEGACY + key); } catch {}
    if (!saved || !saved.path || tabs.some(t => t.owner === key)) return;
    const spec = normalize(saved.kind === 'document' ? { kind: 'document', key, path: saved.path, title: saved.title, project: saved.project || null }
      : { kind: 'files', key, path: saved.path, title: saved.title, type: saved.type || 'auto' });
    if (spec) { const t = add(spec, { owner: key }); t.at = 0; save(); }
  }
  window.addEventListener('chattering:route', () => queueMicrotask(placeChanged));

  /** The conversation `key` should find `spec` beside it (it may not be on screen yet). */
  function remember(key, spec) {
    spec = normalize({ ...spec, key: spec.key || key });
    if (!key || !spec) return;
    const t = tabs.find(x => !x.pinned && x.owner === key && ident(x.spec) === ident(spec));
    if (t) { t.spec = { ...t.spec, ...spec }; t.at = now(); }
    else { const n = add(spec, { owner: key }); if (key !== place) n.at = now(); }
    save();
  }
  /** The thing shown beside now belongs with another conversation (the pair's ☷ picker, a draft sent). */
  function rekey(key) {
    const a = active();
    if (!a || !key) return;
    if (!a.pinned) a.owner = key;
    if (a.spec.kind === 'document' || a.spec.kind === 'files') a.spec = { ...a.spec, key };
    // The new conversation comes on screen right after: it is the place then.
    place = key;
    activeId = a.id;
    save();
    paintStrip();
  }

  const middleEdits = spec => spec.kind === 'document' && typeof fileWs !== 'undefined' && !!fileWs && fileWs.placement !== 'beside';
  /** "Edit it here": the file in the middle steps back to where it came from, and this tab's file gets the editor. */
  async function editHere() {
    const a = active();
    if (!a || a.spec.kind !== 'document') return;
    const ws = typeof fileWs !== 'undefined' ? fileWs : null;
    if (ws && ws.placement !== 'beside') {
      if (typeof liveFileGoBack === 'function') await liveFileGoBack(ws);
      await new Promise(r => setTimeout(r));
      // Nowhere to go back to: the file closes, the page under it stays.
      if (typeof fileWs !== 'undefined' && fileWs === ws && typeof goHome === 'function') { goHome(); await new Promise(r => setTimeout(r)); }
    }
    if (!tabs.includes(a)) return;
    place = placeNow();
    if (!a.pinned) a.owner = place;
    hidden = false;
    activate(a, { focus: true });
  }
  /** The file editor beside was closed by another file opening full page: the tab shows a copy to read. */
  function displaced(path) {
    const a = active();
    if (a && a.spec.kind === 'document' && a.spec.path === path && !hidden) Artifacts.show(a.spec, { readOnly: true });
  }

  // ---- keys ------------------------------------------------------------------------------------

  const typing = el => !!el && !!el.closest && !!el.closest('input, textarea, select, [contenteditable="true"]') && !el.closest('.cm-editor');
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    if (e.code === 'KeyB') {
      if (typing(e.target)) return;
      e.preventDefault(); e.stopPropagation();
      // Alt+Shift+B: what the middle shows goes beside (a file, a folder).
      if (e.shiftKey) fromMiddle(); else toggle();
    } else if ((e.code === 'BracketLeft' || e.code === 'BracketRight') && !e.shiftKey && shown()) {
      e.preventDefault(); e.stopPropagation();
      step(e.code === 'BracketRight' ? 1 : -1);
    }
  }, true);
  function step(dir) {
    const vis = visible();
    const i = vis.indexOf(active());
    if (vis.length < 2 || i < 0) return;
    activate(vis[(i + dir + vis.length) % vis.length], { focus: true });
  }
  /** Show Beside, or put it away. With nothing on the desk here, the lists open. */
  function toggle() {
    if (shown()) {
      if (window.Pair && Pair.overlay()) { Pair.stepAside(); paintToggle(); return; }
      hidden = true; save(); render();
      return;
    }
    hidden = false; quiet = false;
    if (!active()) return showLists(typeof rightFilesView !== 'undefined' ? rightFilesView : 'files');
    activate(active());
  }

  // Open files changed (a file kept or let go on any device): the pins' labels follow.
  window.addEventListener('chattering:open-files', () => paintStrip());

  function init() {
    load();
    holdFiles();
  }
  init();

  window.Beside = {
    open, close, back, activate, setPinned, update, toggle, step, render,
    openFolder, showLists, hideLists, adoptLists, listsShowing, syncLists, toMiddle, fromMiddle,
    remember, rekey, displaced, placeChanged, editHere, sendFromMiddle,
    active, visible, shown, tabs: () => tabs.slice(), place: () => place, label, ident, normalize, isFile, canMiddle,
    hidden: () => hidden,
    onLists(fn) { onListsShown = fn; },
    togglePin() { const a = active(); if (a) setPinned(a, !a.pinned); },
  };
})();
