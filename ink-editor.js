'use strict';
// ink-editor.js — a handwritten note on screen (design/98).
//
// A note is a file like any other (ink-format.js): it opens in the file
// view, stays in the side list under Open files, shows in recent files, and
// can sit beside a conversation. This is the page you write on.
//
// Input, one rule per pointer kind:
//   pen       writes (its eraser end, or the Eraser tool, erases);
//   mouse     writes too (a Wacom tablet is a pen, a mouse is a slow one);
//   finger    scrolls, 1:1, and never writes unless "Draw with a finger" is on;
//             a hand resting on the screen while the pen is near is ignored.
//
// Fast, the way the handwriting keyboard taught (~/Projects/iflytek,
// handwriting-ime/fastink and research/ebc; remarkable_customization's
// meridian ink.rs and inkpen):
//   - wet, then set: while the pen moves the line is drawn at the raw
//     samples on a low-latency layer (latency first); on lift it settles
//     once (ink-format.js settle: jitter filter, follower, pressure
//     low-pass) and is painted on its page;
//   - every sample counts: pointerrawupdate where the browser has it (the
//     web's unbuffered dispatch), coalesced samples otherwise, the browser's
//     prediction for the last frame on screens that are not e-ink;
//   - a finished line costs one fill: each page's ink is a canvas, painted
//     one stroke at a time; an eraser repaints only around what it took;
//     pages far from the screen give their canvas back;
//   - on the Android app the app's nib draws the live line (on the e-ink
//     panel's overlay where there is one) and the page only settles it.
//
// Saving: on its own, a moment after the pen stops, on leaving, and when
// the tab hides. If another device saved the note meanwhile, the two are
// merged (strokes added on both sides kept, strokes erased on either side
// gone), never one over the other. A save that cannot reach the computer
// keeps the note on this device and tries again.
//
// Later layers (design/98 "what comes next") plug in here: the page as a
// picture (pageImage) for reading the writing and for AI commands on a
// selection; an extra layer per page for what an AI adds, kept apart from
// the pen so it can be erased as one.
(function () {
  const F = window.InkFormat;
  if (!F) return;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const PREF = 'chattering.ink.';
  const WIDTHS = [{ w: 1.7, label: 'Fine' }, { w: 2.6, label: 'Medium' }, { w: 4.2, label: 'Bold' }];
  const SAVE_AFTER_MS = 1400;
  const PALM_MS = 1500;      // a touch this soon after the pen was near is a hand
  const JOIN_MS = 40;        // a pen that lifts and lands again this fast, this close, never left
  const JOIN_PX = 12;
  const TAP_MIN_MS = 20;     // a one-point touch shorter than this is the digitiser, not a dot
  const PEN_LOG = '~/notes/chattering/pen-log.md';
  const PALM_SIZE = 46;      // css px: a contact wider than this is a hand
  const pref = (k, d) => { try { const v = localStorage.getItem(PREF + k); return v == null ? d : v; } catch { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem(PREF + k, String(v)); } catch {} };
  const e = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const einkNow = () => typeof isEink === 'function' && isEink();
  const draftKey = p => 'chattering.ink.draft:' + p;

  let view = null; // the note on screen (one at a time, like the file view)

  // A pen has been used on this device: the side list then offers a note
  // in one tap (✎ beside + new). The e-ink tablet's app says so up front.
  function penSeen() { return pref('pen', '') === '1' || document.documentElement.dataset.form === 'eink'; }
  function notePen() {
    if (pref('pen', '') === '1') return;
    setPref('pen', '1');
    if (typeof renderSideNew === 'function') renderSideNew();
  }
  window.addEventListener('pointerdown', ev => { if (ev.pointerType === 'pen') notePen(); }, { capture: true, passive: true });

  // ---- a new note ----
  async function create(project = '', opts = {}) {
    const now = new Date();
    const title = 'Note · ' + now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    let out;
    try { out = await postJson('/api/ink/new', { project: project || '', when: now.getTime(), tzOffset: now.getTimezoneOffset(), title, paper: pref('paper', F.DEFAULT_PAPER) }); }
    catch { out = { error: 'Could not reach this computer. Check the connection and try again.' }; }
    if (!out || out.error) { errToast(out && out.error === 'project not found' ? 'That project has no folder on this computer.' : (out && out.error) || 'Could not make the note'); return null; }
    if (typeof OpenFiles !== 'undefined') OpenFiles.keep(out.path, project || '', 'pin');
    if (opts.beside && typeof openLiveFileBeside === 'function') await openLiveFileBeside(out.path, { project: project || null, beside: opts.beside });
    else await openLiveFile(out.path, { project: project || null, back: typeof currentHash !== 'undefined' ? currentHash : null });
    return out.path;
  }

  // ---- mounting into the file view (filesmode.js calls this) ----
  async function mount(ws) {
    const host = $('ffCompare');
    if (!host || fileWs !== ws) return;
    ws.inkView?.dispose();
    ws.readOnly = false;
    const width = Number(pref('width', WIDTHS[1].w)) || WIDTHS[1].w;
    host.innerHTML = `<div class="doc-view ink-view" data-tool="pen">
      <header class="live-file-head ink-head">
        <button id="liveBack" title="${e(liveBackLabel(ws).slice(2))}: return to the previous view"><span class="lf-back-arrow">←</span><span class="lf-wide">${e(liveBackLabel(ws).slice(2))}</span></button>
        ${liveFileNameHtml(ws)}
        <span id="docStatus" role="status">Opening…</span>
        <div class="ink-tools" role="toolbar" aria-label="Writing tools">
          <button type="button" data-ink-tool="pen" aria-pressed="true" title="Pen (P): write and draw">${icon('pen')}<span class="ink-label">Pen</span></button>
          <button type="button" data-ink-tool="eraser" aria-pressed="false" title="Eraser (E): touch a line to remove it. The pen's eraser end works too">${icon('eraser')}<span class="ink-label">Eraser</span></button>
          <span class="ink-widths" role="group" aria-label="Line width">${WIDTHS.map(o => `<button type="button" data-ink-width="${o.w}" aria-pressed="${o.w === width}" title="${o.label} line">${widthDot(o.w)}</button>`).join('')}</span>
          <button type="button" id="inkUndo" disabled title="Undo (${e(modKey('Z'))})">${icon('undo')}</button>
          <button type="button" id="inkRedo" disabled title="Redo (${e(modKey('Shift+Z'))})">${icon('redo')}</button>
        </div>
        <details class="live-more ink-more"><summary aria-label="Note options">⋯</summary><div>
          <span class="ink-menu-label">Paper</span>
          <div class="ink-papers" role="group" aria-label="Paper">${F.PAPERS.map(p => `<button type="button" data-ink-paper="${p}">${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}</div>
          <button type="button" id="inkFinger" aria-pressed="false">Draw with a finger</button>
          <button type="button" id="inkAddPage">Add a page</button>
          <button type="button" id="inkPng">Download this page as a picture</button>
          ${typeof OpenFiles !== 'undefined' ? `<button type="button" data-keep-menu="${e(ws.path)}">${e(OpenFiles.menuLabel(ws.path))}</button>` : ''}
          ${typeof Pair !== 'undefined' && ws.placement !== 'beside' ? '<button type="button" id="inkBeside">☷ A conversation beside</button>' : ''}
          ${ws.project ? '<button type="button" id="liveBrowse">Browse this folder</button>' : ''}
          <span class="ink-menu-hint">Pen writes · finger scrolls · ${e(modKey('Z'))} undoes</span>
          <span class="ink-menu-hint" id="inkPenMode"></span>
        </div></details>
      </header>
      <div class="fw-banner" id="fwBanner" hidden></div>
      <div class="ink-stage">
        <div class="ink-scroll" tabindex="0" aria-label="Handwritten note. Write with a pen or the mouse; scroll with a finger or the wheel."><div class="ink-pages"></div></div>
        <canvas class="ink-live" aria-hidden="true"></canvas>
        <canvas class="ink-live ink-predict" aria-hidden="true"></canvas>
      </div>
    </div>`;
    const root = host.querySelector('.ink-view');
    const v = view = ws.inkView = {
      ws, root, disposed: false, note: null, base: null, baseSha: '', rev: 0, savedRev: 0, saving: false, again: false, timer: 0,
      tool: 'pen', width, finger: pref('finger', '0') === '1', undo: [], redo: [], pages: [], pageW: 0,
      scroll: root.querySelector('.ink-scroll'), pagesEl: root.querySelector('.ink-pages'), canvas: root.querySelector('.ink-live:not(.ink-predict)'), predict: root.querySelector('.ink-predict'),
      status: $('docStatus'), cleanups: [], draw: null, pan: null, lastPen: 0, scale: 1,
      dispose() { disposeView(v); },
    };
    $('liveBack').onclick = () => liveFileGoBack(ws);
    wireHeader(v);
    let d;
    try { d = await (await fetch('/api/file/read?' + new URLSearchParams({ path: ws.path }))).json(); }
    catch { d = { error: 'Could not reach this computer.' }; }
    if (v.disposed || fileWs !== ws) return;
    if (d.error) return fail(v, 'Could not open the note. ' + d.error);
    let note;
    try { note = F.parse(d.text); } catch (err) { return fail(v, 'This file is not a note Chattering can read: ' + err.message + '. It opens as text from Browse.'); }
    v.base = F.parse(d.text); v.baseSha = d.sha; v.note = note;
    restoreDraft(v, d);
    showTitle(v);
    ensureTrail(v);
    layout(v);
    renderAll(v);
    wireInput(v);
    wireLifecycle(v);
    startLog(v);
    paintTools(v);
    setStatus(v, v.rev !== v.savedRev ? 'Unsaved' : 'Saved');
    if (typeof liveFileRememberOpen === 'function') liveFileRememberOpen(ws);
    if (typeof liveFilePlaced === 'function' && ws.placement === 'beside') liveFilePlaced(ws);
    // Opening a note puts you where you left it, else on its last page.
    const at = Number(pref('place:' + ws.path, ''));
    requestAnimationFrame(() => {
      if (v.disposed) return;
      if (Number.isFinite(at) && at > 0) v.scroll.scrollTop = at * v.scroll.scrollHeight;
      else if (v.note.pages.length > 2) v.pages[v.note.pages.length - 2]?.el.scrollIntoView({ block: 'start' });
      v.scroll.focus({ preventScroll: true });
    });
    native(v, true);
  }

  // The note's own name (its <title>) instead of the file's; a tap renames
  // it. The file keeps its dated name, so links to it never break.
  function showTitle(v) {
    const el = $('ffTitle');
    if (!el || v.disposed) return;
    el.textContent = v.note.title || el.textContent;
    el.classList.add('ink-title');
    el.title = (v.note.title ? v.note.title + '\n' : '') + v.ws.path + '\nClick to rename';
    el.onclick = () => {
      const name = prompt('Name this note', v.note.title || '');
      if (name == null || !name.trim() || name.trim() === v.note.title) return;
      commit(v, { type: 'title', from: v.note.title, to: name.trim().slice(0, 200) });
      v.note.title = name.trim().slice(0, 200);
      showTitle(v);
    };
  }
  function fail(v, text) {
    v.status.textContent = 'Could not open';
    v.pagesEl.innerHTML = `<p class="ink-message" role="alert">${e(text)}</p>`;
  }
  function setStatus(v, text) { if (!v.disposed && v.status) v.status.textContent = text; }

  // ---- header ----
  function icon(name) {
    const paths = {
      pen: '<path d="M3 13l1-3 7-7 2 2-7 7-3 1z"/><path d="M9.5 4.5l2 2"/>',
      eraser: '<path d="M6 13h7"/><path d="M2.5 9.5l6-6 4 4-5.5 5.5H5z"/><path d="M5.5 6.5l4 4"/>',
      undo: '<path d="M5 3L2 6l3 3"/><path d="M2 6h7a4 4 0 010 8H6"/>',
      redo: '<path d="M11 3l3 3-3 3"/><path d="M14 6H7a4 4 0 000 8h3"/>',
    };
    return `<svg class="ink-icon" viewBox="0 0 16 16" aria-hidden="true">${paths[name]}</svg>`;
  }
  function widthDot(w) { const r = Math.min(5.5, 1 + w); return `<svg class="ink-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="${r}" class="ink-dot"/></svg>`; }

  function wireHeader(v) {
    const root = v.root;
    root.querySelectorAll('[data-ink-tool]').forEach(b => b.onclick = () => setTool(v, b.dataset.inkTool));
    root.querySelectorAll('[data-ink-width]').forEach(b => b.onclick = () => { v.width = Number(b.dataset.inkWidth); setPref('width', v.width); if (v.tool !== 'pen') setTool(v, 'pen'); paintTools(v); });
    $('inkUndo').onclick = () => undo(v);
    $('inkRedo').onclick = () => redo(v);
    root.querySelectorAll('[data-ink-paper]').forEach(b => b.onclick = () => setPaper(v, b.dataset.inkPaper));
    $('inkFinger').onclick = () => { v.finger = !v.finger; setPref('finger', v.finger ? '1' : '0'); paintTools(v); closeMenu(v); };
    $('inkAddPage').onclick = () => { closeMenu(v); addPage(v); };
    $('inkPng').onclick = () => { closeMenu(v); downloadPage(v); };
    if ($('inkBeside')) $('inkBeside').onclick = () => { closeMenu(v); Pair.withConversation(v.ws); };
    if ($('liveBrowse')) $('liveBrowse').onclick = () => liveFileBrowseFolder(v.ws);
    const more = root.querySelector('.ink-more');
    // The app's pen overlay must not take the pen while the menu is over the page.
    more.addEventListener('toggle', () => { native(v, !more.open); if (more.open) paintPenMode(); });
  }
  // Which pen draws here, said plainly: the way to tell an app update took.
  function paintPenMode() {
    const el = $('inkPenMode');
    if (!el) return;
    const n = nativeInk();
    let fast = false;
    try { fast = !!(n && typeof n.fastNib === 'function' && n.fastNib()); } catch {}
    el.textContent = !n ? (window.ChatteringInk && typeof window.ChatteringInk.setRegion !== 'function' ? 'Pen drawn by the page (an older app: update it for the fast pen)' : 'Pen drawn by the page')
      : fast ? 'Pen: the e-ink fast layer'
      : typeof n.fastNib === 'function' ? 'Pen drawn by the app (on e-ink, the fast layer starts with your first line)'
      : 'Pen drawn by the app';
  }
  function closeMenu(v) { const m = v.root.querySelector('.ink-more'); if (m && m.open) m.open = false; }
  function setTool(v, tool) { v.tool = tool; v.root.dataset.tool = tool; paintTools(v); native(v, true); }
  function paintTools(v) {
    if (v.disposed) return;
    v.root.querySelectorAll('[data-ink-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.inkTool === v.tool)));
    v.root.querySelectorAll('[data-ink-width]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.inkWidth) === v.width && v.tool === 'pen')));
    v.root.querySelectorAll('[data-ink-paper]').forEach(b => b.setAttribute('aria-pressed', String(v.note && b.dataset.inkPaper === v.note.paper)));
    const f = $('inkFinger'); if (f) { f.setAttribute('aria-pressed', String(v.finger)); f.textContent = v.finger ? 'Draw with a finger: on' : 'Draw with a finger: off'; }
    if ($('inkUndo')) $('inkUndo').disabled = !v.undo.length;
    if ($('inkRedo')) $('inkRedo').disabled = !v.redo.length;
  }

  // ---- pages on screen ----
  // A page is three layers: the paper and anything the file adds (an SVG,
  // drawn once, never touched while writing), the ink (a canvas holding the
  // finished strokes, painted one stroke at a time), and the page number.
  // Only pages near the screen keep a canvas; the others give their memory
  // back and are painted again when they come near.
  function ensureTrail(v) {
    const pages = v.note.pages;
    if (!pages.length || !F.isBlankPage(pages[pages.length - 1])) pages.push(F.blankPage());
  }
  function pageWidth(v) {
    const avail = v.scroll.clientWidth || v.root.clientWidth || 800;
    const pad = avail < 560 ? 6 : 24;
    return Math.max(160, Math.min(avail - pad * 2, 900));
  }
  const dprOf = () => Math.min(window.devicePixelRatio || 1, 2);
  function layout(v) {
    const w = Math.round(pageWidth(v));
    const changed = w !== v.pageW;
    v.pageW = w;
    v.scale = w / F.PAGE_W;
    setMinR(v);
    v.pagesEl.style.setProperty('--ink-page-w', w + 'px');
    v.pagesEl.style.setProperty('--ink-page-h', Math.round(w * F.PAGE_H / F.PAGE_W) + 'px');
    sizeLive(v);
    if (changed) for (let i = 0; i < v.pages.length; i++) if (v.pages[i]?.backed) back(v, i);
  }
  // The live layers cover the stage. Their context asks for low latency
  // (desynchronized): where the browser can, it draws straight to the screen
  // without waiting for the next composited frame, as Android's front-buffer
  // canvas does.
  function sizeLive(v) {
    const r = v.scroll.getBoundingClientRect(), dpr = dprOf();
    for (const c of [v.canvas, v.predict]) {
      const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      c.style.width = r.width + 'px'; c.style.height = r.height + 'px';
    }
    v.ctx ||= v.canvas.getContext('2d', { desynchronized: true });
    v.pctx ||= v.predict.getContext('2d', { desynchronized: true });
    v.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    v.pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    v.liveDirty = false; v.tail = null;
  }
  function renderAll(v) {
    v.observer?.disconnect();
    v.pagesEl.replaceChildren();
    v.pages = [];
    v.note.pages.forEach((page, i) => v.pagesEl.appendChild(pageEl(v, page, i)));
    paintTools(v);
  }
  function pageEl(v, page, i) {
    const el = document.createElement('div');
    el.className = 'ink-page';
    el.dataset.page = String(i);
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${F.PAGE_W} ${F.PAGE_H}`);
    svg.setAttribute('class', 'ink-sheet');
    svg.setAttribute('aria-label', 'Page ' + (i + 1));
    svg.appendChild(paperEl(v.note.paper));
    const extra = document.createElementNS(SVGNS, 'g'); extra.setAttribute('class', 'ink-extra');
    for (const node of page.extra) { const n = safeSvg(node, v.ws.path); if (n) extra.appendChild(n); }
    svg.appendChild(extra);
    const canvas = document.createElement('canvas');
    canvas.className = 'ink-layer';
    canvas.width = canvas.height = 0;
    const no = document.createElement('span'); no.className = 'ink-page-no'; no.textContent = String(i + 1);
    el.append(svg, canvas, no);
    v.pages[i] = { el, canvas, ctx: null, backed: false };
    observe(v, el);
    return el;
  }
  function observe(v, el) {
    if (!('IntersectionObserver' in window)) { back(v, Number(el.dataset.page)); return; }
    v.observer ||= new IntersectionObserver(entries => {
      for (const en of entries) {
        const i = Number(en.target.dataset.page);
        if (!v.pages[i] || v.disposed) continue;
        if (en.isIntersecting) { if (!v.pages[i].backed) back(v, i, { slices: !onScreen(v, i) }); }
        else if (v.pages[i].backed) unback(v, i);
      }
    }, { root: v.scroll, rootMargin: '150% 0px' });
    v.observer.observe(el);
  }
  function onScreen(v, i) {
    const r = v.pages[i].el.getBoundingClientRect(), s = v.scroll.getBoundingClientRect();
    return r.bottom > s.top && r.top < s.bottom;
  }
  // Give a page its canvas and paint every stroke on it. A page on screen
  // is painted at once; one coming near is painted a few milliseconds at a
  // time between frames, so scrolling and the pen never wait for it.
  function back(v, i, { slices = false } = {}) {
    const pg = v.pages[i];
    if (!pg) return;
    const dpr = dprOf();
    const w = Math.round(v.pageW * dpr), h = Math.round(v.pageW * F.PAGE_H / F.PAGE_W * dpr);
    if (pg.canvas.width !== w || pg.canvas.height !== h) { pg.canvas.width = w; pg.canvas.height = h; }
    pg.ctx = pg.canvas.getContext('2d');
    pg.ctx.setTransform(w / F.PAGE_W, 0, 0, w / F.PAGE_W, 0, 0);
    pg.ctx.clearRect(0, 0, F.PAGE_W, F.PAGE_H);
    pg.backed = true;
    const gen = pg.gen = (pg.gen || 0) + 1;
    const list = v.note.pages[i].strokes.slice();
    pg.slicing = false;
    if (!slices) { for (const s of list) paintStroke(v, i, s); return; }
    let k = 0;
    pg.slicing = true;
    const step = () => {
      if (v.disposed || pg.gen !== gen || !pg.backed) return;
      const until = performance.now() + 5;
      while (k < list.length && performance.now() < until) paintStroke(v, i, list[k++]);
      if (k < list.length) setTimeout(step, 0); else pg.slicing = false;
    };
    step();
  }
  function unback(v, i) {
    const pg = v.pages[i];
    pg.gen = (pg.gen || 0) + 1;
    pg.canvas.width = pg.canvas.height = 0;
    pg.ctx = null; pg.backed = false;
  }
  // A stroke's shape, built once (page units) and kept with it.
  const shapes = new WeakMap();
  // Never thinner than the screen shows cleanly: on e-ink a line under two
  // device pixels breaks into grey dots.
  let minR = 0.3;
  function setMinR(v) { minR = (einkNow() ? 0.8 : 0.5) / Math.max(0.05, v.scale); }
  function shapeOf(s) {
    let e = shapes.get(s);
    if (!e || e.minR !== minR) { e = { minR, path: F.trace(new Path2D(), s, { minR }) }; shapes.set(s, e); }
    return e.path;
  }
  function paintStroke(v, i, s) {
    const pg = v.pages[i];
    if (!pg || !pg.backed) return;
    pg.ctx.fillStyle = s.color || inkColor(v);
    pg.ctx.fill(shapeOf(s), 'nonzero');
  }
  function boxOf(s) { return s.box || (s.box = F.bounds(s)); }
  // Paint again only where something changed (an erased line, an undo).
  function repaint(v, i, box) {
    const pg = v.pages[i];
    if (!pg || !pg.backed) return;
    if (pg.slicing) return back(v, i, { slices: true }); // still being painted: start over from the page as it is
    const pad = 12, x0 = box.x0 - pad, y0 = box.y0 - pad, x1 = box.x1 + pad, y1 = box.y1 + pad;
    const c = pg.ctx;
    c.save();
    c.beginPath(); c.rect(x0, y0, x1 - x0, y1 - y0); c.clip();
    c.clearRect(x0, y0, x1 - x0, y1 - y0);
    for (const s of v.note.pages[i].strokes) {
      const b = boxOf(s);
      if (b.x1 + 10 < x0 || b.x0 - 10 > x1 || b.y1 + 10 < y0 || b.y0 - 10 > y1) continue;
      c.fillStyle = s.color || inkColor(v);
      c.fill(shapeOf(s), 'nonzero');
    }
    c.restore();
  }
  function unionBox(list) {
    const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const s of list) { const o = boxOf(s); b.x0 = Math.min(b.x0, o.x0); b.y0 = Math.min(b.y0, o.y0); b.x1 = Math.max(b.x1, o.x1); b.y1 = Math.max(b.y1, o.y1); }
    return b;
  }
  function paperEl(paper) {
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'ink-paper ink-paper-' + paper);
    const add = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); for (const [k, val] of Object.entries(attrs)) n.setAttribute(k, val); g.appendChild(n); return n; };
    add('rect', { class: 'ink-paper-bg', width: F.PAGE_W, height: F.PAGE_H });
    let d = '';
    if (paper === 'lines') for (let y = 98; y < F.PAGE_H - 30; y += 44) d += `M60 ${y}H${F.PAGE_W - 60}`;
    if (paper === 'grid') { for (let y = 40; y < F.PAGE_H; y += 40) d += `M0 ${y}H${F.PAGE_W}`; for (let x = 40; x < F.PAGE_W; x += 40) d += `M${x} 0V${F.PAGE_H}`; }
    if (d) add('path', { class: 'ink-rule', d });
    if (paper === 'dots') {
      let dots = '';
      for (let y = 40; y < F.PAGE_H; y += 40) for (let x = 40; x < F.PAGE_W; x += 40) dots += `M${x - 1.5} ${y}a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0`;
      add('path', { class: 'ink-dotgrid', d: dots });
    }
    return g;
  }

  // The extra layer, drawn from the parsed tree and never as markup: only
  // shapes, text and pictures with safe addresses, no scripts, no handlers,
  // no outside requests (a note an agent wrote must not run code here).
  const SAFE_TAGS = new Set(['g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'image', 'title', 'desc']);
  const SAFE_ATTRS = /^(d|x|y|x1|y1|x2|y2|cx|cy|r|rx|ry|width|height|points|transform|fill|fill-opacity|fill-rule|stroke|stroke-width|stroke-opacity|stroke-linecap|stroke-linejoin|stroke-dasharray|opacity|font-size|font-family|font-weight|font-style|text-anchor|dominant-baseline|preserveAspectRatio|data-[\w-]+)$/;
  function safeSvg(node, notePath) {
    if (node.text != null) return document.createTextNode(node.text);
    if (!node.tag || !SAFE_TAGS.has(node.tag)) return null;
    const el = document.createElementNS(SVGNS, node.tag);
    for (const [k, val] of Object.entries(node.attrs)) {
      if (SAFE_ATTRS.test(k) && !/url\s*\(|javascript:|expression\s*\(/i.test(val)) el.setAttribute(k, val);
    }
    if (node.tag === 'image') {
      const href = node.attrs.href || node.attrs['xlink:href'] || '';
      if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(href)) el.setAttribute('href', href);
      else if (href && !/^[a-z][\w+.-]*:|^\/\//i.test(href)) el.setAttribute('href', '/api/doc/asset?' + new URLSearchParams({ doc: notePath, src: href }));
    }
    for (const c of node.children || []) { const n = safeSvg(c, notePath); if (n) el.appendChild(n); }
    return el;
  }

  // ---- input ----
  // pointerrawupdate, where there is one (Chromium, secure pages), hands
  // each pen sample over as it arrives instead of once per frame: the web's
  // requestUnbufferedDispatch. Elsewhere pointermove with its coalesced
  // samples, so a fast stroke keeps every point either way.
  const RAW = 'onpointerrawupdate' in window && window.isSecureContext;
  function wireInput(v) {
    const sc = v.scroll;
    const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); v.cleanups.push(() => el.removeEventListener(type, fn, opts)); };
    on(sc, 'pointerdown', ev => pointerDown(v, ev));
    on(sc, RAW ? 'pointerrawupdate' : 'pointermove', ev => pointerMove(v, ev));
    if (RAW) on(sc, 'pointermove', ev => { if (v.draw || v.pan) ev.preventDefault(); });
    on(sc, 'pointerup', ev => pointerUp(v, ev));
    on(sc, 'pointercancel', ev => pointerUp(v, ev, true));
    // Only our own capture ending counts. On a touch screen the browser first
    // gives the pen to the element under it; taking it for the page makes
    // that element report a lost capture, which bubbles here: read as a
    // lift, it ended every line after its first point (a note from the
    // tablet held only one-point strokes of 7 ms).
    on(sc, 'lostpointercapture', ev => { if (ev.target === sc && v.draw && v.draw.id === ev.pointerId) pointerUp(v, ev); });
    // No long-press menu, no text selection, no drag of the page's pictures.
    on(sc, 'contextmenu', ev => { if (v.draw || ev.pointerType === 'pen' || ev.pointerType === 'touch') ev.preventDefault(); });
    on(sc, 'dragstart', ev => ev.preventDefault());
    on(sc, 'scroll', () => { if (!v.draw) settleLive(v, true); rememberPlace(v); }, { passive: true });
    on(v.root, 'keydown', ev => keyDown(v, ev));
    const ro = new ResizeObserver(() => { if (!v.disposed && !v.draw) { layout(v); native(v, true, { regionOnly: true }); } });
    ro.observe(sc);
    v.cleanups.push(() => ro.disconnect());
  }

  function pageAt(v, clientY) {
    let best = 0, bestD = Infinity;
    v.pages.forEach((p, i) => {
      const r = p.el.getBoundingClientRect();
      const d = clientY < r.top ? r.top - clientY : clientY > r.bottom ? clientY - r.bottom : 0;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }
  function toPage(rect, x, y) { return [(x - rect.left) / rect.width * F.PAGE_W, (y - rect.top) / rect.height * F.PAGE_H]; }

  function pointerDown(v, ev) {
    if (v.disposed || !v.note) return;
    const now = performance.now();
    if (ev.pointerType === 'pen') {
      v.lastPen = now; notePen();
      // The pen wins over a hand that landed first and started to scroll.
      if (v.pan) { try { v.scroll.releasePointerCapture(v.pan.id); } catch {} v.pan = null; logTouch(v, 'pan stopped by the pen'); }
      // The digitiser lost the pen for a few milliseconds: the same line goes on.
      const j = v.pending;
      if (j && now - j.at < JOIN_MS && Math.hypot(ev.clientX - j.x, ev.clientY - j.y) < JOIN_PX) {
        clearTimeout(j.timer); v.pending = null;
        ev.preventDefault();
        v.draw = j.d; v.draw.id = ev.pointerId; v.draw.joined = (v.draw.joined || 0) + 1;
        try { v.scroll.setPointerCapture(ev.pointerId); } catch {}
        addPoint(v, ev);
        return;
      }
    }
    if (v.draw) { if (ev.pointerType === 'touch') { ev.preventDefault(); logTouch(v, 'ignored while writing', ev); } return; } // one line at a time; a hand meanwhile is ignored
    const touch = ev.pointerType === 'touch';
    const palm = touch && (now - v.lastPen < PALM_MS || Math.max(ev.width || 0, ev.height || 0) > PALM_SIZE);
    if (touch && palm) { ev.preventDefault(); logTouch(v, 'palm', ev); return; }
    // A finger writes only when asked to, and never on a device with a pen
    // (there, a touch on the page is a hand or a scroll).
    const fingerWrites = v.finger && !penSeen() && now - v.lastPen > 4000;
    if (touch && !fingerWrites) { logTouch(v, 'scroll', ev); startPan(v, ev); return; }
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    ev.preventDefault();
    v.scroll.focus({ preventScroll: true });
    const erase = v.tool === 'eraser' || ev.button === 5 || (ev.buttons & 32) === 32;
    const i = pageAt(v, ev.clientY);
    const rect = v.pages[i].el.getBoundingClientRect();
    const stage = v.scroll.getBoundingClientRect();
    clearTimeout(v.settleTimer);
    finishPending(v);
    v.draw = { id: ev.pointerId, page: i, rect, stage, erase, pts: [], t0: Date.now(), start: now, erased: [], last: null, kind: ev.pointerType, p: -1,
      box: { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity } };
    try { v.scroll.setPointerCapture(ev.pointerId); } catch {}
    addPoint(v, ev);
  }
  function pressureOf(ev) {
    if (ev.pointerType === 'mouse' || !(ev.pressure > 0)) return 0.5;
    return Math.max(0.01, Math.min(1, ev.pressure));
  }
  // Pens differ: the AINOTE's reports about 0.1 for ordinary writing, which
  // the width curve read as barely touching. This device's typical pressure
  // (the median of its recent lines) is learned and counts as 0.5.
  let typicalP = Number(pref('pressure', '')) || 0;
  function normP(p) { return Math.max(0.03, Math.min(1, 0.5 * p / (typicalP || 0.5))); }
  function learnP(raw) {
    const list = raw.filter(p => p > 0 && p !== 0.5).sort((a, b) => a - b);
    if (list.length < 3) return;
    const med = list[list.length >> 1];
    typicalP = Math.max(0.02, typicalP ? typicalP * 0.8 + med * 0.2 : med);
    setPref('pressure', typicalP.toFixed(4));
  }
  function normalise(pts, kind) {
    if (kind === 'mouse') return pts;
    const raw = [];
    for (let i = 2; i < pts.length; i += 3) raw.push(pts[i]);
    learnP(raw);
    for (let i = 2; i < pts.length; i += 3) pts[i] = normP(pts[i]);
    return pts;
  }
  function addPoint(v, ev) {
    const d = v.draw;
    const list = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
    for (const c of (list.length ? list : [ev])) {
      const [x, y] = toPage(d.rect, c.clientX, c.clientY);
      const p = pressureOf(c);
      if (d.last) {
        const dx = (x - d.last[0]) * v.scale, dy = (y - d.last[1]) * v.scale;
        if (dx * dx + dy * dy < 0.25) { d.pts[d.pts.length - 1] = p; continue; } // under half a pixel: the same place
      }
      if (d.erase) {
        // Along the whole move, not only where the events landed: a quick
        // swipe of the eraser still crosses every line in its way.
        const radius = eraseRadius(v);
        const [lx, ly] = d.last || [x, y];
        const steps = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / (radius * 0.8)));
        for (let k = 1; k <= steps; k++) eraseNear(v, d.page, lx + (x - lx) * k / steps, ly + (y - ly) * k / steps, d.erased);
      } else liveSegment(v, d, c.clientX, c.clientY, p);
      d.pts.push(x, y, p);
      d.last = [x, y, c.clientX, c.clientY];
    }
    if (!d.erase) predictTail(v, d, ev);
  }
  // The live line: raw samples, round ends, width from pressure as the
  // finished line will have it (smoothed the same way), so the settle is a
  // smoothing, not a jump.
  function liveSegment(v, d, cx, cy, p) {
    const ctx = v.ctx;
    if (!ctx) return;
    d.p = d.p < 0 ? p : d.p + (p - d.p) * 0.35;
    const w = Math.max(einkNow() ? 1.6 : 1, v.width * v.scale * F.pressureFactor(d.kind === 'mouse' ? 0.5 : normP(d.p)));
    const x = cx - d.stage.left, y = cy - d.stage.top;
    ctx.fillStyle = ctx.strokeStyle = inkColor(v);
    if (!d.last) { ctx.beginPath(); ctx.arc(x, y, w / 2, 0, Math.PI * 2); ctx.fill(); }
    else {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = w;
      ctx.beginPath(); ctx.moveTo(d.last[2] - d.stage.left, d.last[3] - d.stage.top); ctx.lineTo(x, y); ctx.stroke();
    }
    v.liveDirty = true;
  }
  // Where the pen is about to be (the browser's own prediction), drawn on a
  // layer of its own and replaced at every sample: it hides about a frame
  // of delay. Not on e-ink, where every guess would stay as a ghost.
  function predictTail(v, d, ev) {
    if (!v.pctx || einkNow() || typeof ev.getPredictedEvents !== 'function' || !d.last) return;
    const c = v.pctx;
    if (v.tail) c.clearRect(v.tail.x0, v.tail.y0, v.tail.x1 - v.tail.x0, v.tail.y1 - v.tail.y0);
    v.tail = null;
    const pred = ev.getPredictedEvents();
    if (!pred.length) return;
    const w = Math.max(einkNow() ? 1.6 : 1, v.width * v.scale * F.pressureFactor(d.kind === 'mouse' ? 0.5 : normP(d.p)));
    let lx = d.last[2] - d.stage.left, ly = d.last[3] - d.stage.top;
    const box = { x0: lx, y0: ly, x1: lx, y1: ly };
    c.strokeStyle = inkColor(v); c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = w;
    c.beginPath(); c.moveTo(lx, ly);
    for (const pe of pred.slice(0, 3)) {
      lx = pe.clientX - d.stage.left; ly = pe.clientY - d.stage.top;
      c.lineTo(lx, ly);
      box.x0 = Math.min(box.x0, lx); box.y0 = Math.min(box.y0, ly); box.x1 = Math.max(box.x1, lx); box.y1 = Math.max(box.y1, ly);
    }
    c.stroke();
    v.tail = { x0: box.x0 - w - 2, y0: box.y0 - w - 2, x1: box.x1 + w + 2, y1: box.y1 + w + 2 };
  }
  function clearTail(v) {
    if (v.tail && v.pctx) v.pctx.clearRect(v.tail.x0, v.tail.y0, v.tail.x1 - v.tail.x0, v.tail.y1 - v.tail.y0);
    v.tail = null;
  }
  function inkColor(v) {
    if (!v.inkColor) v.inkColor = getComputedStyle(v.root).getPropertyValue('--ink-pen').trim() || '#1d1f21';
    return v.inkColor;
  }
  function pointerMove(v, ev) {
    if (ev.pointerType === 'pen') v.lastPen = performance.now();
    if (v.pan && ev.pointerId === v.pan.id) return panMove(v, ev);
    if (!v.draw || ev.pointerId !== v.draw.id) return;
    if (ev.cancelable) ev.preventDefault();
    addPoint(v, ev);
  }
  function pointerUp(v, ev, cancelled = false) {
    if (v.pan && ev.pointerId === v.pan.id) return panEnd(v, ev);
    const d = v.draw;
    if (!d || ev.pointerId !== d.id) return;
    if (!cancelled && !d.erase && ev.type === 'pointerup') addPoint(v, ev);
    v.draw = null;
    clearTail(v);
    if (d.erase) { finishErase(v, d.page, d.erased); return; }
    if (cancelled || !d.pts.length) { settleLive(v, true); return; }
    d.end = performance.now();
    if (d.kind !== 'pen') return finishStroke(v, d);
    // Held a moment: if the pen lands again right here, it is the same line.
    const pend = v.pending = { d, at: d.end, x: ev.clientX, y: ev.clientY, timer: 0 };
    pend.timer = setTimeout(() => { if (v.pending === pend) { v.pending = null; finishStroke(v, d); } }, JOIN_MS);
  }
  function finishPending(v) {
    const j = v.pending;
    if (!j) return;
    clearTimeout(j.timer); v.pending = null;
    finishStroke(v, j.d);
  }
  function finishStroke(v, d) {
    const dur = Math.round((d.end || performance.now()) - d.start);
    // One point, shorter than a person can tap: the digitiser's, not the hand's.
    if (d.pts.length === 3 && dur < TAP_MIN_MS) { logStroke(v, d, 'page', { dropped: 'tap ' + dur + ' ms' }); settleLive(v, true); return; }
    const raw = d.pts.filter((_, i) => i % 3 === 2);
    const stroke = { pts: F.settle(normalise(d.pts, d.kind), { minStep: 0.6 / v.scale }), w: v.width, t0: d.t0, dur, color: '' };
    addStroke(v, d.page, stroke);
    logStroke(v, d, 'page', { raw, dur });
    settleLive(v);
  }

  // ---- the pen log (design/98): on while ~/notes/chattering/pen-log.md exists ----
  // What each line and each touch was, so delay and palms are measured, not
  // guessed: which path drew it, the samples, their pressure and rate.
  async function startLog(v) {
    try {
      const d = await (await fetch('/api/file/read?' + new URLSearchParams({ path: PEN_LOG }))).json();
      if (d.error || v.disposed) return;
      v.log = { text: d.text || '', lines: [], timer: 0 };
      const n = window.ChatteringInk;
      logLine(v, { event: 'open', note: v.ws.path.split('/').pop(), ua: navigator.userAgent, dpr: devicePixelRatio, secure: isSecureContext, rawupdate: RAW,
        app: !!n, appRegion: !!(n && n.setRegion), appStrokeDrawn: !!(n && n.strokeDrawn), framed: window.top !== window,
        appPen: !!nativeInk(), eink: einkNow(), scale: +v.scale.toFixed(3), typicalP });
    } catch {}
  }
  function logLine(v, o) {
    if (!v.log) return;
    v.log.lines.push(JSON.stringify({ at: new Date().toISOString().slice(11, 23), ...o }));
    clearTimeout(v.log.timer);
    v.log.timer = setTimeout(() => flushLog(v), 1500);
  }
  function flushLog(v) {
    const L = v.log;
    if (!L || !L.lines.length) return;
    L.text += L.lines.join('\n') + '\n'; L.lines = [];
    if (L.text.length > 400000) L.text = L.text.slice(-300000);
    postJson('/api/file/save', { path: PEN_LOG, text: L.text, actor: 'human', input: 'keyboard' }).catch(() => {});
  }
  function logTouch(v, what, ev) {
    if (!v.log) return;
    logLine(v, { event: 'touch', what, type: ev && ev.pointerType, w: ev && Math.round(ev.width || 0), h: ev && Math.round(ev.height || 0), sincePen: Math.round(performance.now() - v.lastPen) });
  }
  function logStroke(v, d, path, extra) {
    if (!v.log) return;
    const raw = extra.raw || [];
    const sorted = raw.slice().sort((a, b) => a - b);
    const n = window.ChatteringInk;
    let fast = null;
    try { fast = n && typeof n.fastNib === 'function' ? n.fastNib() : null; } catch {}
    logLine(v, { event: 'stroke', path, type: d.kind, samples: d.pts.length / 3, dur: extra.dur, dropped: extra.dropped,
      rateHz: extra.dur ? Math.round(d.pts.length / 3 / extra.dur * 1000) : null, joined: d.joined || 0,
      p: sorted.length ? [sorted[0], sorted[sorted.length >> 1], sorted[sorted.length - 1]].map(x => +x.toFixed(3)) : null,
      typicalP: +(typicalP || 0).toFixed(3), fastNib: fast });
  }
  // The finished line is on its page; the live one goes once the page has
  // been shown (two frames: a low-latency layer can reach the screen before
  // the page does, and clearing it first would blink). A line started
  // meanwhile keeps the layer until it ends.
  function settleLive(v, now = false) {
    if (!v.liveDirty || !v.ctx) return;
    const clear = () => {
      if (v.draw || v.disposed) return;
      v.ctx.save(); v.ctx.setTransform(1, 0, 0, 1, 0, 0); v.ctx.clearRect(0, 0, v.canvas.width, v.canvas.height); v.ctx.restore();
      v.liveDirty = false;
    };
    if (now) return clear();
    requestAnimationFrame(() => requestAnimationFrame(clear));
  }

  function addStroke(v, page, stroke, { record = true } = {}) {
    v.note.pages[page].strokes.push(stroke);
    paintStroke(v, page, stroke);
    if (record) commit(v, { type: 'add', page, stroke });
    if (page === v.note.pages.length - 1) { // the last page has writing: a fresh one waits below
      v.note.pages.push(F.blankPage());
      v.pagesEl.appendChild(pageEl(v, v.note.pages[v.note.pages.length - 1], v.note.pages.length - 1));
    }
  }
  // About ten screen pixels around the eraser, never finer than the line.
  function eraseRadius(v) { return Math.max(6, 10 / v.scale); }
  // Erased lines leave the page at once; the canvas is painted again only
  // around them, a few times a second while the eraser moves.
  function eraseNear(v, page, x, y, into) {
    const list = v.note.pages[page].strokes;
    const radius = eraseRadius(v);
    let hit = false;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      const b = boxOf(s);
      if (x < b.x0 - radius - 4 || x > b.x1 + radius + 4 || y < b.y0 - radius - 4 || y > b.y1 + radius + 4) continue;
      if (!F.hits(s, x, y, radius)) continue;
      list.splice(i, 1);
      into.push({ stroke: s, index: i });
      (v.eraseQ ||= []).push(s);
      hit = true;
    }
    if (hit && !v.eraseRaf) v.eraseRaf = requestAnimationFrame(() => flushErase(v, page));
  }
  function flushErase(v, page) {
    v.eraseRaf = 0;
    const q = v.eraseQ || [];
    v.eraseQ = [];
    if (q.length) repaint(v, page, unionBox(q));
  }
  function finishErase(v, page, items) {
    if (v.eraseRaf) { cancelAnimationFrame(v.eraseRaf); flushErase(v, page); }
    if (items.length) commit(v, { type: 'erase', page, items });
  }

  // ---- one finger scrolls ----
  function startPan(v, ev) {
    if (v.pan) return; // a second finger rides along with the first
    ev.preventDefault();
    settleLive(v, true);
    v.pan = { id: ev.pointerId, y: ev.clientY, x: ev.clientX, top: v.scroll.scrollTop, left: v.scroll.scrollLeft, t: performance.now(), vy: 0 };
    try { v.scroll.setPointerCapture(ev.pointerId); } catch {}
  }
  function panMove(v, ev) {
    const p = v.pan, now = performance.now();
    const dy = ev.clientY - p.y;
    const before = v.scroll.scrollTop;
    v.scroll.scrollTop = p.top - dy;
    v.scroll.scrollLeft = p.left - (ev.clientX - p.x);
    const dt = now - (p.lt || p.t);
    if (dt > 0) p.vy = 0.7 * p.vy + 0.3 * ((v.scroll.scrollTop - before) / dt);
    p.lt = now;
  }
  function panEnd(v, ev) {
    const p = v.pan; v.pan = null;
    // A flick keeps going and slows down; e-ink scrolls exactly as far as the finger.
    if (einkNow() || Math.abs(p.vy) < 0.3 || performance.now() - (p.lt || 0) > 80) return;
    let vy = p.vy, last = performance.now();
    const step = t => {
      if (v.disposed || v.pan || v.draw) return;
      const dt = t - last; last = t;
      v.scroll.scrollTop += vy * dt;
      vy *= Math.pow(0.995, dt);
      if (Math.abs(vy) > 0.02) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---- keys ----
  function keyDown(v, ev) {
    if (ev.target.closest && ev.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const k = ev.key.toLowerCase();
    let done = true;
    if (mod && k === 'z' && !ev.shiftKey) undo(v);
    else if (mod && ((k === 'z' && ev.shiftKey) || k === 'y')) redo(v);
    else if (mod && k === 's') save(v);
    else if (!mod && !ev.altKey && k === 'p') setTool(v, 'pen');
    else if (!mod && !ev.altKey && k === 'e') setTool(v, 'eraser');
    else if (!mod && !ev.altKey && (k === 'pagedown' || k === 'pageup')) { v.scroll.scrollBy({ top: (k === 'pagedown' ? 1 : -1) * v.scroll.clientHeight * 0.9 }); }
    else done = false;
    if (done) { ev.preventDefault(); ev.stopPropagation(); }
  }

  // ---- undo, pages, paper ----
  function commit(v, op) {
    v.undo.push(op);
    if (v.undo.length > 500) v.undo.shift();
    v.redo = [];
    changed(v);
  }
  function apply(v, op, back) {
    if (op.type === 'add') {
      const list = v.note.pages[op.page].strokes;
      if (back) { const i = list.indexOf(op.stroke); if (i >= 0) list.splice(i, 1); repaint(v, op.page, boxOf(op.stroke)); }
      else { list.push(op.stroke); paintStroke(v, op.page, op.stroke); }
    } else if (op.type === 'erase') {
      const list = v.note.pages[op.page].strokes;
      if (back) for (const it of op.items.slice().reverse()) { list.splice(Math.min(it.index, list.length), 0, it.stroke); }
      else for (const it of op.items) { const i = list.indexOf(it.stroke); if (i >= 0) list.splice(i, 1); }
      repaint(v, op.page, unionBox(op.items.map(it => it.stroke)));
    } else if (op.type === 'paper') {
      v.note.paper = back ? op.from : op.to;
      renderAll(v);
    } else if (op.type === 'title') {
      v.note.title = back ? op.from : op.to;
      showTitle(v);
    }
  }
  function undo(v) { const op = v.undo.pop(); if (!op) return; apply(v, op, true); v.redo.push(op); changed(v); }
  function redo(v) { const op = v.redo.pop(); if (!op) return; apply(v, op, false); v.undo.push(op); changed(v); }
  function setPaper(v, paper) {
    if (!v.note || v.note.paper === paper) return;
    commit(v, { type: 'paper', from: v.note.paper, to: paper });
    v.note.paper = paper;
    setPref('paper', paper);
    renderAll(v);
  }
  function addPage(v) {
    // A page after the last written one: the blank one already waiting, shown.
    ensureTrail(v);
    const last = v.pages[v.note.pages.length - 1];
    last?.el.scrollIntoView({ block: 'start', behavior: einkNow() ? 'auto' : 'smooth' });
  }

  // ---- saving ----
  function changed(v) {
    v.rev++;
    paintTools(v);
    setStatus(v, 'Unsaved');
    clearTimeout(v.timer);
    v.timer = setTimeout(() => save(v), SAVE_AFTER_MS);
    if (typeof OpenFiles !== 'undefined') OpenFiles.edited(v.ws.path, v.ws.project || '');
  }
  async function save(v) {
    clearTimeout(v.timer);
    if (!v.note || v.rev === v.savedRev) return;
    // Never while a line is being drawn: the pen gets every millisecond.
    if (v.draw && !v.disposed) { v.timer = setTimeout(() => save(v), 600); return; }
    if (v.saving) { v.again = true; return; }
    v.saving = true;
    setStatus(v, 'Saving…');
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const rev = v.rev;
        const text = F.serialize(v.note);
        let out;
        try { out = await postJson('/api/file/save', { path: v.ws.path, baseSha: v.baseSha, text, actor: 'human', input: 'pen', project: v.ws.project || '' }); }
        catch { out = { error: 'offline' }; }
        if (out && !out.error) {
          v.baseSha = out.sha; v.base = F.parse(text); v.savedRev = rev;
          dropDraft(v);
          setStatus(v, v.rev === rev ? 'Saved' : 'Unsaved');
          break;
        }
        if (out && /changed on disk/.test(out.error)) { if (!(await mergeFromDisk(v))) break; continue; }
        // Not reachable, or refused: the note stays here and on this device.
        keepDraft(v, text);
        setStatus(v, out.error === 'offline' ? 'Not saved: no connection. Kept on this device; retrying' : '⚠ Not saved: ' + out.error);
        clearTimeout(v.timer);
        v.timer = setTimeout(() => save(v), out.error === 'offline' ? 5000 : 15000);
        break;
      }
    } finally {
      v.saving = false;
    }
    if (v.again) { v.again = false; if (v.rev !== v.savedRev) save(v); }
  }
  // Another device (or an agent) saved this note: merge, don't overwrite.
  async function mergeFromDisk(v) {
    let d;
    try { d = await (await fetch('/api/file/read?' + new URLSearchParams({ path: v.ws.path }))).json(); } catch { return false; }
    if (d.error || v.disposed && !v.note) return false;
    let theirs;
    try { theirs = F.parse(d.text); } catch { setStatus(v, '⚠ The file on disk is no longer a note; not saved over it'); return false; }
    v.note = F.merge(v.base, v.note, theirs);
    v.base = theirs; v.baseSha = d.sha;
    ensureTrail(v);
    if (!v.disposed) { renderAll(v); showTitle(v); toastOnce(v, 'This note changed on another device. Both versions are merged.'); }
    return true;
  }
  // Coming back to a note left open while another device wrote in it.
  async function refreshFromDisk(v) {
    if (v.disposed || v.saving || v.draw) return;
    let d;
    try { d = await (await fetch('/api/file/read?' + new URLSearchParams({ path: v.ws.path }))).json(); } catch { return; }
    if (v.disposed || d.error || d.sha === v.baseSha || v.saving || v.draw) return;
    let theirs; try { theirs = F.parse(d.text); } catch { return; }
    const clean = v.rev === v.savedRev;
    v.note = clean ? theirs : F.merge(v.base, v.note, theirs);
    v.base = F.parse(d.text); v.baseSha = d.sha;
    if (clean) { v.undo = []; v.redo = []; }
    ensureTrail(v);
    renderAll(v); showTitle(v);
    setStatus(v, clean ? 'Updated from another device' : 'Unsaved');
    if (!clean) save(v);
  }
  function toastOnce(v, text) { if (v.toasted === text) return; v.toasted = text; if (typeof toast === 'function') toast(text); }
  function keepDraft(v, text) { try { localStorage.setItem(draftKey(v.ws.path), JSON.stringify({ sha: v.baseSha, text, at: Date.now() })); } catch {} }
  function dropDraft(v) { try { localStorage.removeItem(draftKey(v.ws.path)); } catch {} }
  // Writing that never reached the computer comes back the next time the
  // note opens on this device, merged with what is on disk now.
  function restoreDraft(v, disk) {
    let draft;
    try { draft = JSON.parse(localStorage.getItem(draftKey(v.ws.path)) || 'null'); } catch { draft = null; }
    if (!draft || !draft.text || draft.text === disk.text) { if (draft) dropDraft(v); return; }
    let mine; try { mine = F.parse(draft.text); } catch { dropDraft(v); return; }
    v.note = draft.sha === disk.sha ? mine : F.merge(null, mine, F.parse(disk.text));
    v.rev++;
    setTimeout(() => save(v), 300);
    toastOnce(v, 'Writing from this device that had not been saved is back in the note.');
  }

  function wireLifecycle(v) {
    const hide = () => { if (document.visibilityState === 'hidden') flush(v); else refreshFromDisk(v); };
    const unload = () => flush(v, true);
    const online = () => { if (v.rev !== v.savedRev) save(v); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', unload);
    window.addEventListener('online', online);
    v.cleanups.push(() => { document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', unload); window.removeEventListener('online', online); });
  }
  // Leaving: the last strokes are kept on this device first (that never
  // fails), then sent; a page that is closing sends what fits in a beacon.
  function flush(v, closing = false) {
    if (!v.note || v.rev === v.savedRev) return;
    const text = F.serialize(v.note);
    keepDraft(v, text);
    if (closing) {
      const body = JSON.stringify({ path: v.ws.path, baseSha: v.baseSha, text, actor: 'human', input: 'pen', project: v.ws.project || '' });
      if (body.length < 60000) { try { fetch('/api/file/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }); } catch {} }
      return;
    }
    save(v);
  }
  function rememberPlace(v) {
    clearTimeout(v.placeTimer);
    v.placeTimer = setTimeout(() => {
      if (v.disposed) return;
      const sc = v.scroll, max = sc.scrollHeight;
      setPref('place:' + v.ws.path, max > 0 ? (sc.scrollTop / max).toFixed(4) : '0');
    }, 400);
  }

  function disposeView(v) {
    if (v.disposed) return;
    finishPending(v);
    flushLog(v);
    flush(v);
    v.disposed = true;
    native(v, false);
    v.observer?.disconnect();
    if (v.eraseRaf) cancelAnimationFrame(v.eraseRaf);
    for (const fn of v.cleanups) { try { fn(); } catch {} }
    v.cleanups = [];
    if (view === v) view = null;
  }

  // ---- the page as a picture (download now; reading and AI later) ----
  async function pageImage(v, i, { scale = 2, background = '#ffffff' } = {}) {
    const one = { ...v.note, pages: [v.note.pages[i]] };
    const svg = F.serialize(one);
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    try {
      await new Promise((ok, no) => { img.onload = ok; img.onerror = () => no(new Error('could not draw the page')); img.src = url; });
      const c = document.createElement('canvas');
      c.width = Math.round(F.PAGE_W * scale); c.height = Math.round(F.PAGE_H * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return await new Promise(ok => c.toBlob(ok, 'image/png'));
    } finally { URL.revokeObjectURL(url); }
  }
  function visiblePage(v) {
    const mid = v.scroll.getBoundingClientRect();
    return pageAt(v, mid.top + mid.height / 2);
  }
  async function downloadPage(v) {
    const i = visiblePage(v);
    try {
      const blob = await pageImage(v, i);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = v.ws.path.split(/[\\/]/).pop().replace(/\.ink\.svg$/i, '') + '-page-' + (i + 1) + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (err) { errToast(err.message); }
  }

  // ---- the Android app's pen nib ----
  // On the app, the pen is the app's (InkOverlay.kt): it draws the live line
  // itself, on the e-ink panel's own overlay where the device has one (the
  // /dev/ebc nib of the handwriting keyboard), else on a view over the page,
  // and hands each finished line here. The page settles it, paints it, and
  // says so (strokeDrawn); the app then wipes its nib once the pen has
  // rested, so the panel only ever shows one copy of a line.
  // Only an app that confines the pen to a rectangle (setRegion) is used: an
  // older one took the pen over the toolbar too.
  //
  // Through the encrypted link this page is a frame of the app's shell
  // (anywhere/public/shell.js), on the same site, so it can read where it
  // sits; the app's coordinates are the window's, so the region goes out
  // shifted by the frame's corner and lines come back shifted the other
  // way. This page once refused the app's pen in any frame, and every line
  // on the AINOTE took the slow path (the page, ~43 points a second, the
  // panel's full refresh): the pen log of 10 Oct showed fastNib false with
  // the current app. A frame of another site, whose place cannot be read,
  // still keeps the page's pen.
  function frameOffset() {
    let x = 0, y = 0, w = window;
    try {
      while (w !== w.top) {
        const f = w.frameElement;
        if (!f) return null;
        const r = f.getBoundingClientRect(), cs = w.parent.getComputedStyle(f);
        x += r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
        y += r.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
        w = w.parent;
      }
    } catch { return null; }
    return [x, y];
  }
  function nativeInk() {
    const n = window.ChatteringInk;
    return n && typeof n.setRegion === 'function' && frameOffset() ? n : null;
  }
  function native(v, want, { regionOnly = false } = {}) {
    const n = nativeInk();
    if (!n) return;
    try {
      const on = want && !v.disposed && !!v.note;
      if (!on) { if (!regionOnly) { n.setEnabled(false); } return; }
      const r = v.scroll.getBoundingClientRect(), [ox, oy] = frameOffset();
      // The page's css pixel in device pixels, so the app maps the region and
      // the lines with the page's own ratio, not one it assumes.
      n.setPixelRatio?.(devicePixelRatio);
      n.setRegion(Math.round(r.left + ox), Math.round(r.top + oy), Math.round(r.right + ox), Math.round(r.bottom + oy));
      if (!regionOnly) { n.setErase(v.tool === 'eraser'); n.setWidth?.(v.width * v.scale); if (typicalP) n.setPressureTypical?.(typicalP); n.setEnabled(true); }
    } catch {}
  }
  // A line the app drew: "x,y[,pressure[,ms]] …" in the page's css pixels.
  function acceptPacked(packed, erase) {
    const v = view;
    if (!v || v.disposed || !v.note) return;
    const pts = [], [ox, oy] = frameOffset() || [0, 0];
    for (const part of String(packed || '').split(' ')) {
      const n = part.split(',').map(Number);
      if (n.length >= 2 && Number.isFinite(n[0]) && Number.isFinite(n[1])) { n[0] -= ox; n[1] -= oy; pts.push(n); }
    }
    if (!pts.length) return;
    const i = pageAt(v, pts[0][1]);
    const rect = v.pages[i].el.getBoundingClientRect();
    if (erase || v.tool === 'eraser') {
      const items = [], radius = eraseRadius(v);
      let last = null;
      for (const [cx, cy] of pts) {
        const [x, y] = toPage(rect, cx, cy);
        const [lx, ly] = last || [x, y];
        const steps = Math.max(1, Math.ceil(Math.hypot(x - lx, y - ly) / (radius * 0.8)));
        for (let k = 1; k <= steps; k++) eraseNear(v, i, lx + (x - lx) * k / steps, ly + (y - ly) * k / steps, items);
        last = [x, y];
      }
      finishErase(v, i, items);
    } else {
      const flat = [];
      for (const [cx, cy, p] of pts) { const [x, y] = toPage(rect, cx, cy); flat.push(x, y, Number.isFinite(p) && p > 0 ? Math.min(1, p) : 0.5); }
      const t = pts[pts.length - 1][3];
      const dur = Number.isFinite(t) ? t : 0;
      const d = { kind: 'pen', pts: flat };
      if (flat.length === 3 && dur < TAP_MIN_MS) logStroke(v, d, 'app', { dropped: 'tap ' + dur + ' ms', dur });
      else {
        const raw = flat.filter((_, k) => k % 3 === 2);
        const stroke = { pts: F.settle(normalise(flat.slice(), 'pen'), { minStep: 0.6 / v.scale }), w: v.width, t0: Date.now() - dur, dur, color: '' };
        addStroke(v, i, stroke);
        logStroke(v, d, 'app', { raw, dur });
        try { nativeInk()?.setPressureTypical?.(typicalP); } catch {}
      }
    }
    // Once the page has shown it, the app may wipe its own copy.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const n = nativeInk();
      try { if (n && typeof n.strokeDrawn === 'function') n.strokeDrawn(); else n?.clearAll(); } catch {}
    }));
  }
  window.fileInkAcceptPacked = acceptPacked;

  window.InkNotes = { isInkPath: F.isInkPath, mount, create, penSeen, acceptPacked,
    pageImage: (i, opts) => view && pageImage(view, i, opts), get current() { return view; } };
})();
