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
  // The pens a person keeps at hand: three slots in the toolbar, each a pen,
  // a size (an index into its sizes) and a colour ('' = the theme's ink).
  // Tapping a slot takes it; tapping the slot in hand opens the palette.
  const DEFAULT_SLOTS = [{ pen: 'ballpoint', size: 2, color: '' }, { pen: 'pencil', size: 1, color: '' }, { pen: 'highlighter', size: 2, color: '' }];
  // Greys for every screen; colours only where the screen has them.
  const INKS = [{ c: '', label: 'Ink' }, { c: '#5c5c5c', label: 'Dark grey' }, { c: '#a0a0a0', label: 'Light grey' }, { c: '#ffffff', label: 'White' }];
  const COLOURS = [{ c: '#1f5fbf', label: 'Blue' }, { c: '#c62828', label: 'Red' }, { c: '#2e7d32', label: 'Green' }];
  const HIGHLIGHTS = [{ c: '', label: 'Yellow' }, { c: '#8ee08e', label: 'Green' }, { c: '#ffa3cf', label: 'Pink' }, { c: '#8fd2ff', label: 'Blue' }];
  const HIGHLIGHT = '#ffe04a', HIGHLIGHT_EINK = '#c8c8c8';
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
    const slots = loadSlots();
    const slotNow = Math.max(0, Math.min(2, Number(pref('slot', '0')) || 0));
    host.innerHTML = `<div class="doc-view ink-view" data-tool="pen">
      <header class="live-file-head ink-head">
        <button id="liveBack" title="${e(liveBackLabel(ws).slice(2))}: return to the previous view"><span class="lf-back-arrow">←</span><span class="lf-wide">${e(liveBackLabel(ws).slice(2))}</span></button>
        ${liveFileNameHtml(ws)}
        <span id="docStatus" role="status">Opening…</span>
        <div class="ink-tools" role="toolbar" aria-label="Writing tools">
          <span class="ink-slots" role="group" aria-label="Your pens">${[0, 1, 2].map(i => `<button type="button" class="ink-slot" data-ink-slot="${i}" aria-pressed="false"></button>`).join('')}</span>
          <button type="button" class="ink-tool" data-ink-tool="eraser" aria-pressed="false" title="Eraser (E): touch a line to remove it. The pen's eraser end works too. Tap again for more">${icon('eraser')}<span class="ink-label">Eraser</span></button>
          <button type="button" class="ink-tool" data-ink-tool="lasso" aria-pressed="false" title="Select (L): circle lines to move them, delete them, or ask about them">${icon('lasso')}<span class="ink-label">Select</span></button>
          <button type="button" class="ink-tool" id="inkUndo" disabled title="Undo (${e(modKey('Z'))})">${icon('undo')}</button>
          <button type="button" class="ink-tool" id="inkRedo" disabled title="Redo (${e(modKey('Shift+Z'))})">${icon('redo')}</button>
          <button type="button" class="ink-tool" id="inkPageBtn" aria-haspopup="dialog" aria-expanded="false" title="Paper, pages, picture, finger">${icon('page')}<span class="ink-label">Page</span></button>
        </div>
        <div class="ink-pop ink-palette" id="inkPalette" role="dialog" aria-label="Pen" hidden>
          <div class="ink-pens" role="group" aria-label="Pen">${F.PEN_ORDER.map(id => `<button type="button" class="ink-pen" data-ink-pen="${id}" aria-pressed="false"><svg class="ink-sample" viewBox="0 0 120 56" aria-hidden="true"></svg><span>${e(F.PENS[id].label)}</span></button>`).join('')}</div>
          <div class="ink-pop-row"><span class="ink-pop-label">Size</span><div class="ink-sizes" role="group" aria-label="Size">${[0, 1, 2, 3, 4].map(k => `<button type="button" class="ink-size" data-ink-size="${k}" aria-pressed="false" title="Size ${k + 1}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/></svg></button>`).join('')}</div></div>
          <div class="ink-pop-row"><span class="ink-pop-label">Colour</span><div class="ink-colours" role="group" aria-label="Colour"></div></div>
          <svg class="ink-preview" viewBox="0 0 360 70" aria-hidden="true"></svg>
        </div>
        <div class="ink-pop ink-erasemenu" id="inkEraseMenu" role="dialog" aria-label="Eraser" hidden>
          <span class="ink-menu-hint">Touch a line to remove the whole line. The pen's eraser end does the same.</span>
          <button type="button" id="inkClearPage">Clear this page</button>
        </div>
        <div class="ink-pop ink-pagemenu" id="inkPageMenu" role="dialog" aria-label="Page" hidden>
          <span class="ink-pop-label">Paper</span>
          <div class="ink-papers" role="group" aria-label="Paper">${F.PAPERS.map(p => `<button type="button" data-ink-paper="${p}">${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}</div>
          <button type="button" id="inkAddPage">Add a page</button>
          <button type="button" id="inkPng">Download this page as a picture</button>
          <button type="button" id="inkFinger" aria-pressed="false">Draw with a finger</button>
          ${typeof OpenFiles !== 'undefined' ? `<button type="button" data-keep-menu="${e(ws.path)}">${e(OpenFiles.menuLabel(ws.path))}</button>` : ''}
          ${typeof Pair !== 'undefined' && ws.placement !== 'beside' ? '<button type="button" id="inkBeside">☷ A conversation beside</button>' : ''}
          ${ws.project ? '<button type="button" id="liveBrowse">Browse this folder</button>' : ''}
          <span class="ink-menu-hint">Pen writes · finger scrolls · 1 2 3 pick a pen · ${e(modKey('Z'))} undoes</span>
          <span class="ink-menu-hint" id="inkPenMode"></span>
        </div>
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
      tool: 'pen', slots, slot: slotNow, width: 2.6, penId: 'ballpoint', color: '', finger: pref('finger', '0') === '1', undo: [], redo: [], pages: [], pageW: 0,
      scroll: root.querySelector('.ink-scroll'), pagesEl: root.querySelector('.ink-pages'), canvas: root.querySelector('.ink-live:not(.ink-predict)'), predict: root.querySelector('.ink-predict'),
      status: $('docStatus'), cleanups: [], draw: null, pan: null, lastPen: 0, scale: 1,
      dispose() { disposeView(v); },
    };
    $('liveBack').onclick = () => liveFileGoBack(ws);
    applySlot(v);
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
    watchHoles(v);
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
      page: '<path d="M4 2h6l3 3v9H4z"/><path d="M10 2v3h3"/><path d="M6 8h5M6 10.5h5"/>',
      lasso: '<path d="M8 2.5c3.3 0 5.5 1.7 5.5 3.8S11.3 10 8 10 2.5 8.4 2.5 6.3 4.7 2.5 8 2.5z" stroke-dasharray="2.2 1.8"/><path d="M4.6 9.2c-.9 1.1-.6 2.6.7 3l-.6 2.3"/>',
    };
    return `<svg class="ink-icon" viewBox="0 0 16 16" aria-hidden="true">${paths[name]}</svg>`;
  }

  // ---- pens at hand ----
  function loadSlots() {
    let list = null;
    try { list = JSON.parse(pref('slots', '')); } catch {}
    if (!Array.isArray(list) || list.length !== 3) {
      list = DEFAULT_SLOTS.map(x => ({ ...x }));
      // The width chosen before there were pens: the ballpoint's nearest size.
      const old = Number(pref('width', ''));
      if (old > 0) { const sz = F.PENS.ballpoint.sizes; list[0].size = sz.reduce((b, w, k) => Math.abs(w - old) < Math.abs(sz[b] - old) ? k : b, 0); }
    }
    return list.map((x, i) => ({
      pen: F.PENS[x && x.pen] ? x.pen : DEFAULT_SLOTS[i].pen,
      size: Math.max(0, Math.min(4, Math.round(Number(x && x.size)))) || 0,
      color: typeof (x && x.color) === 'string' && /^(#[0-9a-f]{6})?$/i.test(x.color) ? x.color : '',
    }));
  }
  function saveSlots(v) { setPref('slots', JSON.stringify(v.slots)); setPref('slot', v.slot); }
  // The slot in hand becomes the pen: its width, its look, and the app's nib.
  function applySlot(v) {
    const sl = v.slots[v.slot], pen = F.PENS[sl.pen];
    v.penId = sl.pen; v.color = sl.color; v.width = pen.sizes[sl.size];
  }
  function colourChoices(penId) {
    if (penId === 'highlighter') return einkNow() ? [{ c: '', label: 'Grey' }] : HIGHLIGHTS;
    return einkNow() ? INKS : INKS.concat(COLOURS);
  }
  // A sample of a pen: an S across the box, pressure rising then falling,
  // drawn with the page's own shape (the same function the page fills).
  function sampleStroke(penId, w, width = 120, height = 56) {
    const pts = [], n = 28;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      pts.push(10 + t * (width - 20), height / 2 - Math.sin(t * Math.PI * 2) * height * 0.24, 0.25 + 0.55 * Math.sin(t * Math.PI));
    }
    return { pts, w, pen: penId === 'ballpoint' ? '' : penId, color: '' };
  }
  function sampleSvg(svg, penId, w, color) {
    const box = svg.viewBox.baseVal;
    const s = sampleStroke(penId, w, box.width, box.height);
    const kind = F.PENS[penId].fill;
    const fill = kind === 'highlight' ? (color || (einkNow() ? HIGHLIGHT_EINK : HIGHLIGHT)) : (color || 'currentColor');
    const op = kind === 'grain' ? 0.6 + 0.4 * F.medianPressure(s) : 1;
    svg.innerHTML = `<path d="${F.outline(s)}" fill="${fill}" fill-opacity="${op.toFixed(2)}"${color === '#ffffff' ? ' stroke="currentColor" stroke-width="0.6"' : ''}/>`;
  }

  function wireHeader(v) {
    const root = v.root;
    root.querySelectorAll('[data-ink-slot]').forEach(b => b.onclick = () => {
      const i = Number(b.dataset.inkSlot);
      if (v.tool === 'pen' && v.slot === i) return togglePop(v, 'inkPalette');
      pickSlot(v, i);
    });
    root.querySelector('[data-ink-tool=eraser]').onclick = () => {
      if (v.tool === 'eraser') return togglePop(v, 'inkEraseMenu');
      setTool(v, 'eraser');
    };
    $('inkPageBtn').onclick = () => togglePop(v, 'inkPageMenu');
    root.querySelector('[data-ink-tool=lasso]').onclick = () => { closePops(v); setTool(v, 'lasso'); };
    root.querySelectorAll('[data-ink-pen]').forEach(b => b.onclick = () => {
      const sl = v.slots[v.slot];
      if (sl.pen === b.dataset.inkPen) return;
      sl.pen = b.dataset.inkPen;
      if (!colourChoices(sl.pen).some(c => c.c === sl.color)) sl.color = '';
      choose(v);
    });
    root.querySelectorAll('[data-ink-size]').forEach(b => b.onclick = () => { v.slots[v.slot].size = Number(b.dataset.inkSize); choose(v); });
    $('inkUndo').onclick = () => undo(v);
    $('inkRedo').onclick = () => redo(v);
    root.querySelectorAll('[data-ink-paper]').forEach(b => b.onclick = () => setPaper(v, b.dataset.inkPaper));
    $('inkFinger').onclick = () => { v.finger = !v.finger; setPref('finger', v.finger ? '1' : '0'); paintTools(v); closePops(v); };
    $('inkAddPage').onclick = () => { closePops(v); addPage(v); };
    $('inkPng').onclick = () => { closePops(v); downloadPage(v); };
    $('inkClearPage').onclick = () => { closePops(v); clearPage(v); };
    if ($('inkBeside')) $('inkBeside').onclick = () => { closePops(v); Pair.withConversation(v.ws); };
    if ($('liveBrowse')) $('liveBrowse').onclick = () => liveFileBrowseFolder(v.ws);
    // A pop-up over the page closes at the first touch outside it, and that
    // touch draws nothing (as on a reMarkable: the pen lands, the menu goes).
    const outside = ev => {
      const open = v.root.querySelector('.ink-pop:not([hidden])');
      if (!open || v.disposed) return;
      if (open.contains(ev.target) || ev.target.closest?.('.ink-tools')) return;
      closePops(v);
      if (v.root.querySelector('.ink-stage')?.contains(ev.target)) { ev.preventDefault(); ev.stopPropagation(); }
    };
    window.addEventListener('pointerdown', outside, true);
    v.cleanups.push(() => window.removeEventListener('pointerdown', outside, true));
  }
  function pickSlot(v, i) {
    if (v.disposed) return;
    v.slot = i; saveSlots(v); applySlot(v);
    closePops(v);
    setTool(v, 'pen');
  }
  // A choice in the palette changes the slot in hand; the palette stays open
  // for the next choice (size after pen), and shows what the pen will do.
  function choose(v) {
    saveSlots(v); applySlot(v);
    if (v.tool !== 'pen') setTool(v, 'pen'); else paintTools(v);
  }
  function togglePop(v, id) {
    const el = $(id);
    const open = el && el.hidden;
    closePops(v);
    if (!open) return;
    el.hidden = false;
    if (id === 'inkPageMenu') { $('inkPageBtn').setAttribute('aria-expanded', 'true'); paintPenMode(); }
    if (id === 'inkPalette') paintPalette(v);
    // The app's pen layer must not take the pen while a pop-up is over the page.
    native(v, false);
  }
  function closePops(v) {
    let was = false;
    v.root.querySelectorAll('.ink-pop').forEach(p => { if (!p.hidden) was = true; p.hidden = true; });
    $('inkPageBtn')?.setAttribute('aria-expanded', 'false');
    if (was && !v.disposed) native(v, true);
    return was;
  }
  function paintPalette(v) {
    const pal = $('inkPalette');
    if (!pal || pal.hidden) return;
    const sl = v.slots[v.slot], pen = F.PENS[sl.pen];
    pal.querySelectorAll('[data-ink-pen]').forEach(b => {
      const id = b.dataset.inkPen;
      b.setAttribute('aria-pressed', String(id === sl.pen));
      sampleSvg(b.querySelector('svg'), id, F.PENS[id].sizes[id === sl.pen ? sl.size : 2] * 1.2, id === sl.pen ? sl.color : '');
    });
    pal.querySelectorAll('[data-ink-size]').forEach(b => {
      const k = Number(b.dataset.inkSize);
      b.setAttribute('aria-pressed', String(k === sl.size));
      b.querySelector('circle').setAttribute('r', String(Math.min(10, 1.5 + k * 2)));
      b.title = pen.label + ', size ' + (k + 1) + ' of 5';
    });
    const box = pal.querySelector('.ink-colours');
    box.innerHTML = colourChoices(sl.pen).map(o => {
      const shown = o.c || (sl.pen === 'highlighter' ? (einkNow() ? HIGHLIGHT_EINK : HIGHLIGHT) : 'var(--ink-pen)');
      return `<button type="button" class="ink-colour" data-ink-colour="${o.c}" aria-pressed="${o.c === sl.color}" title="${e(o.label)}" aria-label="${e(o.label)}"><span style="background:${shown}"></span></button>`;
    }).join('');
    box.querySelectorAll('[data-ink-colour]').forEach(b => b.onclick = () => { sl.color = b.dataset.inkColour; choose(v); });
    sampleSvg(pal.querySelector('.ink-preview'), sl.pen, pen.sizes[sl.size] * 1.6, sl.color);
  }
  function clearPage(v) {
    const i = visiblePage(v);
    const list = v.note.pages[i].strokes;
    if (!list.length) return;
    const gone = list.slice();
    const items = gone.map((stroke, index) => ({ stroke, index })).reverse(); // as the eraser records them: last first
    list.length = 0;
    repaint(v, i, unionBox(gone));
    const op = { type: 'erase', page: i, items };
    commit(v, op);
    offerUndo(v, op, items.length);
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
  function setTool(v, tool) {
    if (tool !== 'lasso') { clearSel(v); hidePasteBar(v); }
    v.tool = tool; v.root.dataset.tool = tool; paintTools(v);
    if (!v.root.querySelector('.ink-pop:not([hidden])')) native(v, true);
  }
  function paintTools(v) {
    if (v.disposed) return;
    v.root.querySelectorAll('[data-ink-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.inkTool === v.tool)));
    v.root.querySelectorAll('[data-ink-slot]').forEach(b => {
      const i = Number(b.dataset.inkSlot), sl = v.slots[i], pen = F.PENS[sl.pen], on = v.tool === 'pen' && i === v.slot;
      b.setAttribute('aria-pressed', String(on));
      b.title = `${pen.label}, size ${sl.size + 1} (${i + 1})` + (on ? ': tap again for pens, sizes and colours' : '');
      b.setAttribute('aria-label', b.title);
      if (!b.firstChild) b.innerHTML = '<svg class="ink-sample" viewBox="0 0 64 30" aria-hidden="true"></svg>';
      sampleSvg(b.firstChild, sl.pen, Math.min(9, pen.sizes[sl.size] * 0.75), sl.color);
    });
    paintPalette(v);
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
    if (changed && v.sel) showSel(v);
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
    v.sel = null;
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
  const selected = (v, i, s) => !!(v.sel && v.sel.page === i && v.sel.set.has(s));
  function paintStroke(v, i, s) {
    const pg = v.pages[i];
    if (!pg || !pg.backed || selected(v, i, s)) return;
    fillStroke(v, pg.ctx, s);
  }
  // One stroke, one fill, as its pen looks:
  //   ink        solid;
  //   grain      a pencil: the colour through a paper grain, at the
  //              darkness of how hard it was pressed;
  //   highlight  pale, multiplied into the page, so the writing under it
  //              stays black (on dark paper: a see-through band).
  // look: { ink, light, highlight } to draw for paper whatever the theme
  // (a picture of the page).
  function fillStroke(v, c, s, look = null) {
    const kind = F.penOf(s).fill;
    const ink = look ? look.ink : inkColor(v);
    if (kind === 'ink') { c.fillStyle = s.color || ink; c.fill(shapeOf(s), 'nonzero'); return; }
    c.save();
    if (kind === 'grain') {
      c.globalAlpha = Math.min(1, 0.62 + 0.5 * F.medianPressure(s));
      c.fillStyle = grain(c, s.color || ink);
    } else {
      c.fillStyle = s.color || (look ? look.highlight : highlightColor(v));
      if (look ? look.light : lightPaper(v)) c.globalCompositeOperation = 'multiply'; else c.globalAlpha = 0.4;
    }
    c.fill(shapeOf(s), 'nonzero');
    c.restore();
  }
  function highlightColor(v) { return einkNow() ? HIGHLIGHT_EINK : HIGHLIGHT; }
  // Is the paper light (multiply a highlighter into it) or dark? The
  // paper's colour as the browser paints it, read back from one pixel:
  // right for any way a theme writes a colour.
  function lightPaper(v) {
    if (v.light == null) {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;width:1px;height:1px;background:var(--ink-paper)';
      v.root.appendChild(probe);
      const bg = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const c = document.createElement('canvas'); c.width = c.height = 1;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, 1, 1); x.fillStyle = bg; x.fillRect(0, 0, 1, 1);
      const [r, g, bl] = x.getImageData(0, 0, 1, 1).data;
      v.light = 0.2126 * r + 0.7152 * g + 0.0722 * bl > 140;
    }
    return v.light;
  }
  // A pencil's grain: a fixed tile of specks, one per device pixel, the
  // same on every repaint (a seeded noise), so a line never shimmers.
  const grains = new WeakMap();
  function grain(c, color) {
    const k = Math.abs(c.getTransform().a) || 1;
    let byCtx = grains.get(c);
    if (!byCtx) grains.set(c, byCtx = new Map());
    const key = color + '|' + k.toFixed(3);
    let pat = byCtx.get(key);
    if (pat) return pat;
    const N = 64, tile = document.createElement('canvas');
    tile.width = tile.height = N;
    const t = tile.getContext('2d');
    t.fillStyle = color; t.fillRect(0, 0, N, N);
    const img = t.getImageData(0, 0, N, N);
    let seed = 0x9e3779b9;
    const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    for (let i = 3; i < img.data.length; i += 4) { const r = rnd(); img.data[i] = r < 0.1 ? 0 : Math.round(255 * (0.6 + 0.4 * r)); }
    t.putImageData(img, 0, 0);
    pat = c.createPattern(tile, 'repeat');
    try { pat.setTransform(new DOMMatrix([1 / k, 0, 0, 1 / k, 0, 0])); } catch {}
    byCtx.set(key, pat);
    return pat;
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
      if (selected(v, i, s)) continue;
      fillStroke(v, c, s);
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
    if (RAW) on(sc, 'pointermove', ev => { if (v.draw || v.pan || v.lasso || v.drag) ev.preventDefault(); });
    on(sc, 'pointerup', ev => pointerUp(v, ev));
    on(sc, 'pointercancel', ev => pointerUp(v, ev, true));
    // Only our own capture ending counts. On a touch screen the browser first
    // gives the pen to the element under it; taking it for the page makes
    // that element report a lost capture, which bubbles here: read as a
    // lift, it ended every line after its first point (a note from the
    // tablet held only one-point strokes of 7 ms).
    on(sc, 'lostpointercapture', ev => { if (ev.target === sc && [v.draw, v.lasso, v.drag].some(d => d && d.id === ev.pointerId)) pointerUp(v, ev); });
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
    if (ev.target.closest && ev.target.closest('.ink-sel-bar')) return; // the selection's buttons
    if (v.tool === 'lasso' && lassoDown(v, ev)) return;
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
    // The line keeps the pen it was started with, whatever is picked before it is finished.
    v.draw = { id: ev.pointerId, page: i, rect, stage, erase, pts: [], t0: Date.now(), start: now, erased: [], last: null, kind: ev.pointerType, p: -1,
      pen: v.penId, color: v.color, width: v.width,
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
  //
  // The middle of the last 15 lines' own medians, not a running average:
  // one unusual line (a hard-pressed brush stroke, a test that presses at
  // full force) must not thin the next ten. 0.5 and 1 exactly are what a
  // device without pressure, or injected input, reports: not a hand.
  let typicalP = Number(pref('pressure', '')) || 0;
  let pressHist = (() => { try { const a = JSON.parse(pref('pressures', '[]')); return Array.isArray(a) ? a.filter(x => x > 0 && x < 1).slice(-15) : []; } catch { return []; } })();
  if (!pressHist.length && typicalP) pressHist = [typicalP];
  function normP(p) { return Math.max(0.03, Math.min(1, 0.5 * p / (typicalP || 0.5))); }
  function learnP(raw) {
    const list = raw.filter(p => p > 0 && p < 0.999 && p !== 0.5).sort((a, b) => a - b);
    if (list.length < 3) return;
    pressHist.push(list[list.length >> 1]);
    if (pressHist.length > 15) pressHist.shift();
    const sorted = pressHist.slice().sort((a, b) => a - b);
    typicalP = Math.max(0.02, sorted[sorted.length >> 1]);
    setPref('pressures', JSON.stringify(pressHist.map(x => +x.toFixed(4))));
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
    const x = cx - d.stage.left, y = cy - d.stage.top;
    if (d.last) { const dx = x - (d.last[2] - d.stage.left), dy = y - (d.last[3] - d.stage.top); if (dx * dx + dy * dy > 1) d.ang = Math.atan2(dy, dx); }
    const w = liveWidth(v, d);
    if (!d.styled) { d.styled = true; liveStyle(v, d); }
    ctx.fillStyle = ctx.strokeStyle = liveColor(v, d);
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
    const w = liveWidth(v, d);
    let lx = d.last[2] - d.stage.left, ly = d.last[3] - d.stage.top;
    const box = { x0: lx, y0: ly, x1: lx, y1: ly };
    c.strokeStyle = liveColor(v, d); c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = w;
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
  // The live line as the pen will look: its width curve (and a flat nib's
  // direction), its colour; a pencil or a highlighter see-through on the
  // live layer as a whole, so overlapping steps do not darken.
  function liveWidth(v, d) {
    const pen = F.PENS[d.pen] || F.PENS.ballpoint;
    return Math.max(einkNow() ? 1.6 : 1, d.width * v.scale * pen.factor(d.kind === 'mouse' ? 0.5 : normP(d.p), d.ang || 0));
  }
  function liveColor(v, d = v) {
    const pen = F.PENS[d.pen || d.penId] || F.PENS.ballpoint;
    return d.color || (pen.fill === 'highlight' ? highlightColor(v) : inkColor(v));
  }
  function liveStyle(v, d) {
    const pen = F.PENS[d.pen] || F.PENS.ballpoint;
    const hl = pen.fill === 'highlight', light = lightPaper(v);
    for (const c of [v.canvas, v.predict]) {
      c.style.opacity = pen.fill === 'grain' ? '0.8' : hl && !light ? '0.4' : '';
      c.style.mixBlendMode = hl && light ? 'multiply' : '';
    }
  }
  function inkColor(v) {
    if (!v.inkColor) v.inkColor = getComputedStyle(v.root).getPropertyValue('--ink-pen').trim() || '#1d1f21';
    return v.inkColor;
  }
  function pointerMove(v, ev) {
    if (ev.pointerType === 'pen') v.lastPen = performance.now();
    if (v.pan && ev.pointerId === v.pan.id) return panMove(v, ev);
    if (v.lasso && ev.pointerId === v.lasso.id) return lassoMove(v, ev);
    if (v.drag && ev.pointerId === v.drag.id) return dragMove(v, ev);
    if (!v.draw || ev.pointerId !== v.draw.id) return;
    if (ev.cancelable) ev.preventDefault();
    addPoint(v, ev);
  }
  function pointerUp(v, ev, cancelled = false) {
    if (v.pan && ev.pointerId === v.pan.id) return panEnd(v, ev);
    if (v.lasso && ev.pointerId === v.lasso.id) return lassoUp(v, ev, cancelled);
    if (v.drag && ev.pointerId === v.drag.id) return dragUp(v, ev, cancelled);
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
  // pen: the line's own pen (v.draw), or the view's (a line the app drew).
  function penStroke(pen, s) {
    const id = pen.pen || pen.penId;
    s.color = pen.color || '';
    if (id && id !== 'ballpoint') s.pen = id;
    return s;
  }
  function finishStroke(v, d) {
    const dur = Math.round((d.end || performance.now()) - d.start);
    // One point, shorter than a person can tap: the digitiser's, not the hand's.
    if (d.pts.length === 3 && dur < TAP_MIN_MS) { logStroke(v, d, 'page', { dropped: 'tap ' + dur + ' ms' }); settleLive(v, true); return; }
    const raw = d.pts.filter((_, i) => i % 3 === 2);
    const stroke = penStroke(d, { pts: F.settle(normalise(d.pts, d.kind), { minStep: 0.6 / v.scale }), w: d.width, t0: d.t0, dur });
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
    else if (!mod && !ev.altKey && k === 'p') pickSlot(v, v.slot);
    else if (!mod && !ev.altKey && (k === '1' || k === '2' || k === '3')) pickSlot(v, Number(k) - 1);
    else if (k === 'escape' && closePops(v)) {}
    else if (!mod && !ev.altKey && k === 'e') setTool(v, 'eraser');
    else if (!mod && !ev.altKey && k === 'l') setTool(v, 'lasso');
    else if (!mod && v.sel && (k === 'delete' || k === 'backspace')) deleteSel(v);
    else if (mod && k === 'c' && v.sel) copySel(v);
    else if (mod && k === 'x' && v.sel) { copySel(v); deleteSel(v); }
    else if (mod && k === 'v' && readClip()) { const i = visiblePage(v), c = readClip(), r = v.pages[i].el.getBoundingClientRect(), s2 = v.scroll.getBoundingClientRect();
      const [cx, cy] = toPage(r, s2.left + s2.width / 2, s2.top + s2.height / 2); setTool(v, 'lasso'); paste(v, i, cx - c.w / 2, cy - c.h / 2); }
    else if (k === 'escape' && v.sel) clearSel(v);
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
    } else if (op.type === 'move') {
      // A move is the old lines out and new ones in (strokes are never
      // changed, design/98, so two devices still merge as sets).
      const list = v.note.pages[op.page].strokes;
      const out = back ? op.to : op.from.map(it => it.stroke);
      for (const st of out) { const i = list.indexOf(st); if (i >= 0) list.splice(i, 1); }
      if (back) for (const it of op.from) list.splice(Math.min(it.index, list.length), 0, it.stroke);
      else list.push(...op.to);
      repaint(v, op.page, unionBox([...op.to, ...op.from.map(it => it.stroke)]));
    } else if (op.type === 'paper') {
      v.note.paper = back ? op.from : op.to;
      renderAll(v);
    } else if (op.type === 'title') {
      v.note.title = back ? op.from : op.to;
      showTitle(v);
    }
  }
  function undo(v) { const op = v.undo.pop(); if (!op) return; clearSel(v); apply(v, op, true); v.redo.push(op); changed(v); }
  function redo(v) { const op = v.redo.pop(); if (!op) return; clearSel(v); apply(v, op, false); v.undo.push(op); changed(v); }
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
    // The paper and anything added, as the file shows them; the pen's lines
    // then as the page draws them (each pen's shape, grain and highlight),
    // so a picture shows what the person saw, not plain centre lines.
    const page = v.note.pages[i];
    const one = { ...v.note, pages: [{ ...page, strokes: [] }] };
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
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      const look = { ink: '#1d1f21', light: true, highlight: einkNow() ? HIGHLIGHT_EINK : HIGHLIGHT };
      for (const s of page.strokes) if (s.pts.length >= 3) fillStroke(v, ctx, s, look);
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

  // ---- the lasso (design/99) ----
  // Circle lines with the pen (or the mouse) to select them. A selection
  // floats in its own layer over the page, framed, with its buttons: Ask
  // (the circled lines as a picture, to the conversation beside the note or
  // a new one in its project), Delete, Done. Drag it with the pen or a
  // finger to move it. Selected lines are lines of at least half their
  // points inside the loop.
  const SEL_PAD = 8; // page units around a selection's lines
  function lassoDown(v, ev) {
    const touch = ev.pointerType === 'touch';
    if (ev.pointerType === 'mouse' && ev.button !== 0) return false;
    // In the selection: drag it (a finger too, unless it is a palm).
    if (v.sel && inSel(v, ev) && !(touch && Math.max(ev.width || 0, ev.height || 0) > PALM_SIZE)) {
      ev.preventDefault();
      const rect = v.pages[v.sel.page].el.getBoundingClientRect();
      v.drag = { id: ev.pointerId, rect, at: toPage(rect, ev.clientX, ev.clientY), dx: 0, dy: 0 };
      v.sel.bar.hidden = true;
      try { v.scroll.setPointerCapture(ev.pointerId); } catch {}
      return true;
    }
    if (touch) return false; // a finger outside it scrolls, as everywhere
    ev.preventDefault();
    if (ev.pointerType === 'pen') { v.lastPen = performance.now(); notePen(); }
    const i = pageAt(v, ev.clientY);
    const rect = v.pages[i].el.getBoundingClientRect(), stage = v.scroll.getBoundingClientRect();
    v.lasso = { id: ev.pointerId, page: i, rect, stage, pts: [], last: null };
    try { v.scroll.setPointerCapture(ev.pointerId); } catch {}
    lassoMove(v, ev);
    return true;
  }
  function lassoMove(v, ev) {
    const L = v.lasso, c = v.ctx;
    if (ev.cancelable) ev.preventDefault();
    const list = typeof ev.getCoalescedEvents === 'function' && ev.getCoalescedEvents().length ? ev.getCoalescedEvents() : [ev];
    for (const e2 of list) {
      L.pts.push(...toPage(L.rect, e2.clientX, e2.clientY));
      const x = e2.clientX - L.stage.left, y = e2.clientY - L.stage.top;
      if (L.last && c) {
        c.save(); c.setLineDash([6, 5]); c.lineWidth = einkNow() ? 2 : 1.5; c.strokeStyle = inkColor(v);
        c.beginPath(); c.moveTo(L.last[0], L.last[1]); c.lineTo(x, y); c.stroke(); c.restore();
        v.liveDirty = true;
      }
      L.last = [x, y];
    }
  }
  function lassoUp(v, ev, cancelled) {
    const L = v.lasso;
    v.lasso = null;
    settleLive(v, true);
    if (cancelled) return;
    lassoFinish(v, L.page, L.pts);
  }
  // A finished loop (page units), from the page's own lasso or the app's
  // fast one. A loop too small to hold anything is a tap: it lets go of a
  // selection, or offers to paste what was copied, there.
  function lassoFinish(v, page, poly) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < poly.length; k += 2) { x0 = Math.min(x0, poly[k]); x1 = Math.max(x1, poly[k]); y0 = Math.min(y0, poly[k + 1]); y1 = Math.max(y1, poly[k + 1]); }
    if (poly.length < 6 || Math.max(x1 - x0, y1 - y0) * v.scale < 8) {
      if (v.sel || v.pasteBar) { clearSel(v); hidePasteBar(v); }
      else if (poly.length >= 2 && readClip()) showPasteBar(v, page, poly[0], poly[1]);
      return;
    }
    hidePasteBar(v);
    const list = v.note.pages[page].strokes;
    const chosen = list.filter(st => {
      const p = st.pts, n = p.length / 3;
      let inside = 0;
      for (let k = 0; k < p.length; k += 3) if (inPoly(poly, p[k], p[k + 1])) inside++;
      return inside * 2 >= n && inside > 0;
    });
    if (!chosen.length) { clearSel(v); toastSafe('Nothing inside the loop: circle the lines to select.'); return; }
    selectStrokes(v, page, chosen);
  }

  // ---- copy and paste ----
  // What was copied is kept on this device (so it pastes into another note
  // too), as lines relative to their box's corner. Also offered to the
  // system clipboard as a picture where the browser allows it, to paste
  // into a message or another app.
  const CLIP = 'chattering.ink.clip';
  function readClip() {
    try { const c = JSON.parse(localStorage.getItem(CLIP) || 'null'); return c && Array.isArray(c.strokes) && c.strokes.length ? c : null; } catch { return null; }
  }
  function copySel(v) {
    const S = v.sel;
    if (!S) return;
    const ox = S.box.x0, oy = S.box.y0;
    const strokes = S.list.map(st => {
      const pts = st.pts.map((n, k) => k % 3 === 0 ? +(n - ox).toFixed(1) : k % 3 === 1 ? +(n - oy).toFixed(1) : +n.toFixed(2));
      const out = { pts, w: st.w, color: st.color || '' };
      if (st.pen) out.pen = st.pen;
      return out;
    });
    try { localStorage.setItem(CLIP, JSON.stringify({ strokes, w: S.box.x1 - ox, h: S.box.y1 - oy })); }
    catch { return toastSafe('Too much to copy at once.'); }
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        const img = selImage(v);
        fetch(img.preview).then(r => r.blob()).then(blob => navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])).catch(() => {});
      }
    } catch {}
    toastSafe(S.list.length === 1 ? 'Copied one line. In Select, tap where it should go.' : `Copied ${S.list.length} lines. In Select, tap where they should go.`);
  }
  // Paste with the copied box's corner at (x, y) on a page, kept on the
  // page; the pasted lines are the selection, to drag into place.
  function paste(v, page, x, y) {
    const c = readClip();
    if (!c) return toastSafe('Nothing copied yet: select lines, then Copy.');
    hidePasteBar(v);
    clearSel(v);
    x = Math.max(0, Math.min(F.PAGE_W - c.w, x)); y = Math.max(0, Math.min(F.PAGE_H - c.h, y));
    const now = Date.now();
    const to = c.strokes.map((st, k) => {
      const pts = st.pts.map((n, j) => j % 3 === 0 ? n + x : j % 3 === 1 ? n + y : n);
      const out = { pts, w: st.w, t0: now + k, dur: 0, color: st.color || '' };
      if (st.pen && F.PENS[st.pen]) out.pen = st.pen;
      return out;
    });
    const op = { type: 'move', page, from: [], to };
    apply(v, op, false);
    commit(v, op);
    if (page === v.note.pages.length - 1) { // the last page has writing: a fresh one waits below
      v.note.pages.push(F.blankPage());
      v.pagesEl.appendChild(pageEl(v, v.note.pages[v.note.pages.length - 1], v.note.pages.length - 1));
    }
    selectStrokes(v, page, to);
  }
  function showPasteBar(v, page, x, y) {
    hidePasteBar(v);
    const pg = v.pages[page];
    if (!pg) return;
    const k = v.pageW / F.PAGE_W;
    const bar = document.createElement('div');
    bar.className = 'ink-sel-bar ink-paste-bar';
    bar.innerHTML = '<button type="button" data-sel="paste">Paste here</button><button type="button" data-sel="cancel">Cancel</button>';
    bar.style.cssText = `left:${Math.max(4, Math.min(x * k - 10, v.pageW - 210))}px;top:${Math.max(4, y * k - 52)}px`;
    bar.querySelector('[data-sel=paste]').onclick = () => paste(v, page, x, y);
    bar.querySelector('[data-sel=cancel]').onclick = () => hidePasteBar(v);
    pg.el.appendChild(bar);
    v.pasteBar = bar;
    holesSoon(v);
  }
  function hidePasteBar(v) {
    if (!v.pasteBar) return;
    v.pasteBar.remove(); v.pasteBar = null;
    holesSoon(v);
  }
  function inPoly(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
      const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function toastSafe(text) { try { if (typeof toast === 'function') toast(text); } catch {} }
  function selectStrokes(v, page, strokes) {
    clearSel(v);
    const set = new Set(strokes);
    v.sel = { page, set, list: strokes, box: unionBox(strokes), el: null, bar: null };
    repaint(v, page, v.sel.box); // the page without them: they show in the selection's layer
    showSel(v);
  }
  // The selection's layer: its lines drawn as they look, a dashed frame, and
  // its buttons above (below when the selection is at the top of the page).
  function showSel(v) {
    const S = v.sel;
    if (!S) return;
    S.el?.remove(); S.bar?.remove();
    const pg = v.pages[S.page];
    if (!pg) return;
    const k = v.pageW / F.PAGE_W, dpr = dprOf();
    const x0 = S.box.x0 - SEL_PAD, y0 = S.box.y0 - SEL_PAD, w = S.box.x1 - S.box.x0 + 2 * SEL_PAD, h = S.box.y1 - S.box.y0 + 2 * SEL_PAD;
    const el = document.createElement('div');
    el.className = 'ink-sel';
    el.style.cssText = `left:${x0 * k}px;top:${y0 * k}px;width:${w * k}px;height:${h * k}px`;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k * dpr)); c.height = Math.max(1, Math.round(h * k * dpr));
    const ctx = c.getContext('2d');
    ctx.setTransform(k * dpr, 0, 0, k * dpr, -x0 * k * dpr, -y0 * k * dpr);
    for (const st of S.list) fillStroke(v, ctx, st);
    el.appendChild(c);
    const bar = document.createElement('div');
    bar.className = 'ink-sel-bar';
    bar.innerHTML = `<button type="button" data-sel="ask" title="Send these lines, as a picture, to a conversation">✦ Ask</button><button type="button" data-sel="copy">Copy</button><button type="button" data-sel="done">Done</button><button type="button" class="ink-sel-danger" data-sel="delete">Delete</button>`;
    const above = y0 * k > 56;
    bar.style.cssText = `left:${Math.max(4, Math.min(x0 * k, v.pageW - 350))}px;top:${above ? y0 * k - 50 : (y0 + h) * k + 8}px`;
    bar.querySelector('[data-sel=copy]').onclick = () => copySel(v);
    bar.querySelector('[data-sel=ask]').onclick = () => askSel(v);
    bar.querySelector('[data-sel=delete]').onclick = () => deleteSel(v);
    bar.querySelector('[data-sel=done]').onclick = () => clearSel(v);
    pg.el.append(el, bar);
    S.el = el; S.bar = bar;
    holesSoon(v);
  }
  function inSel(v, ev) {
    const S = v.sel;
    if (!S || !S.el) return false;
    const r = S.el.getBoundingClientRect();
    return ev.clientX >= r.left - 6 && ev.clientX <= r.right + 6 && ev.clientY >= r.top - 6 && ev.clientY <= r.bottom + 6;
  }
  function clearSel(v) {
    const S = v.sel;
    if (!S) return;
    v.sel = null;
    S.el?.remove(); S.bar?.remove();
    repaint(v, S.page, S.box);
    holesSoon(v);
  }
  function dragMove(v, ev) {
    const D = v.drag, S = v.sel;
    if (ev.cancelable) ev.preventDefault();
    if (!S) return;
    const [x, y] = toPage(D.rect, ev.clientX, ev.clientY);
    // The lines stay on their page.
    D.dx = Math.max(-S.box.x0, Math.min(F.PAGE_W - S.box.x1, x - D.at[0]));
    D.dy = Math.max(-S.box.y0, Math.min(F.PAGE_H - S.box.y1, y - D.at[1]));
    const k = v.pageW / F.PAGE_W;
    S.el.style.transform = `translate(${D.dx * k}px,${D.dy * k}px)`;
  }
  function dragUp(v, ev, cancelled) {
    const D = v.drag, S = v.sel;
    v.drag = null;
    if (!S) return;
    if (cancelled || Math.hypot(D.dx, D.dy) < 0.5) { S.el.style.transform = ''; S.bar.hidden = false; return; }
    const list = v.note.pages[S.page].strokes;
    const from = S.list.map(stroke => ({ stroke, index: list.indexOf(stroke) })).filter(it => it.index >= 0).sort((a, b) => a.index - b.index);
    const to = S.list.map(st => {
      const pts = st.pts.slice();
      for (let k = 0; k < pts.length; k += 3) { pts[k] += D.dx; pts[k + 1] += D.dy; }
      const out = { pts, w: st.w, t0: st.t0, dur: st.dur, color: st.color || '' };
      if (st.pen) out.pen = st.pen;
      return out;
    });
    const page = S.page;
    S.el.remove(); S.bar.remove(); v.sel = null;
    const op = { type: 'move', page, from, to };
    apply(v, op, false);
    commit(v, op);
    selectStrokes(v, page, to);
  }
  function deleteSel(v) {
    const S = v.sel;
    if (!S) return;
    const list = v.note.pages[S.page].strokes;
    const items = S.list.map(stroke => ({ stroke, index: list.indexOf(stroke) })).filter(it => it.index >= 0).sort((a, b) => b.index - a.index);
    S.el?.remove(); S.bar?.remove(); v.sel = null;
    holesSoon(v);
    for (const it of items) list.splice(it.index, 1);
    repaint(v, S.page, S.box);
    const op = { type: 'erase', page: S.page, items };
    commit(v, op);
    offerUndo(v, op, items.length);
  }
  // Removing many lines at once says so, with a way back right where the
  // eye is (the toolbar's undo is far on a big tablet).
  function offerUndo(v, op, n) {
    if (typeof toast !== 'function') return;
    try { toast(`Deleted ${n === 1 ? 'one line' : n + ' lines'}. Tap here to undo.`, () => { if (!v.disposed && v.undo[v.undo.length - 1] === op) undo(v); }, '', { repeat: true }); } catch {}
  }
  // The selected lines as a picture: on white, as they look, a margin around.
  function selImage(v) {
    const S = v.sel;
    const x0 = S.box.x0 - 16, y0 = S.box.y0 - 16, w = S.box.x1 - S.box.x0 + 32, h = S.box.y1 - S.box.y0 + 32;
    const scale = Math.min(2, 1400 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(scale, 0, 0, scale, -x0 * scale, -y0 * scale);
    const look = { ink: '#1d1f21', light: true, highlight: einkNow() ? HIGHLIGHT_EINK : HIGHLIGHT };
    for (const st of S.list) fillStroke(v, ctx, st, look);
    const url = c.toDataURL('image/png');
    return { mime: 'image/png', data: url.slice(url.indexOf(',') + 1), name: 'handwritten.png', preview: url };
  }
  // Where the note is, said the way a person and an agent find it: from its
  // project's folder when it has one.
  function noteLabel(v) {
    const p = v.ws.path, at = p.indexOf('/documents/');
    return at >= 0 ? p.slice(at + 1) : p.replace(/^.*\/notes\/chattering\//, '~/notes/chattering/');
  }
  // Ask: to the conversation beside the note, in its composer; else a new
  // conversation in the note's project. Nothing is sent: the person writes
  // (or says) the question and sends.
  async function askSel(v) {
    const S = v.sel;
    if (!S) return;
    const img = selImage(v);
    const text = `About this part of my handwritten note (${noteLabel(v)}, page ${S.page + 1}): `;
    const ws = v.ws;
    if (ws.placement === 'beside' && ws.besideKey && typeof renderAgentThumbs === 'function' && $('agentText')) {
      window._agentImages = window._agentImages || [];
      if (window._agentImages.length >= 8) return toastSafe('Up to 8 images per message.');
      window._agentImages.push(img);
      renderAgentThumbs();
      const ta = $('agentText');
      if (!ta.value.trim()) ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      clearSel(v);
      if (typeof Pair !== 'undefined') Pair.focusConversation();
      ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
      return;
    }
    if (typeof startDraftIn !== 'function') return toastSafe('Open a conversation beside the note (Page → A conversation beside) to ask there.');
    const at = ws.path.indexOf('/documents/handwritten/');
    clearSel(v);
    try { await save(v); } catch {}
    await startDraftIn(at >= 0 ? ws.path.slice(0, at) : '', { text, images: [img] });
    const ta = $('agentText');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  // ---- what covers the writing area (the app's holes) ----
  // The app's fast layer takes the pen anywhere in the writing area's
  // rectangle. Anything of the page over that rectangle (a menu dropping
  // from the side list or the toolbar, a dialog, a drawer, the lasso's
  // selection and its buttons) must get the pen instead, or a tap there
  // draws a line (seen on the AINOTE with the side list's menus).
  //
  // What covers it is found from what changes: an element added, shown or
  // moved (a MutationObserver, on this page and on the shell around it) is a
  // candidate when it lies over the area and is not part of it; it is a
  // cover when the browser says it is on top at a few points of that
  // overlap. Covers are checked again at every change and dropped when
  // gone. A grid of hit tests over the whole area was tried first: 230 to
  // 330 ms each time on the AINOTE, too slow to run on every change.
  // The app is told the covers (setHoles); an older app gives the page the
  // pen while anything covers the area.
  function holesSoon(v, ms = 60) {
    if (!v || v.disposed) return;
    // Throttled, not debounced: a stream of changes (a conversation beside
    // writing its answer) must not put the update off forever.
    const due = performance.now() + ms;
    if (v.holesTimer && v.holesDue <= due) return;
    clearTimeout(v.holesTimer);
    v.holesDue = due;
    v.holesTimer = setTimeout(() => { v.holesTimer = 0; updateHoles(v); }, ms);
  }
  function updateHoles(v) {
    if (v.disposed || !v.note) return;
    if (v.draw || v.drag || v.lasso) return holesSoon(v, 250); // never while the pen is busy
    const t0 = performance.now();
    const next = computeHoles(v);
    const ms = performance.now() - t0;
    const key = JSON.stringify(next);
    if (key === v.holesKey) return;
    v.holesKey = key; v.holes = next;
    logLine(v, { event: 'holes', n: next.length, ms: Math.round(ms * 10) / 10, rects: next });
    native(v, !v.root.querySelector('.ink-pop:not([hidden])'), { regionOnly: !!v.nativeOn === nativeWanted(v) });
  }
  function nativeWanted(v) {
    const n = nativeInk();
    if (!n) return false;
    const precise = typeof n.setHoles === 'function';
    return !v.root.querySelector('.ink-pop:not([hidden])') && (precise || (v.tool !== 'lasso' && !(v.holes && v.holes.length)));
  }
  // The shell around the frame (the encrypted link), when there is one: its
  // document and where the frame sits in it.
  function shellOf() {
    try {
      if (window.parent === window || window.parent !== window.top) return null;
      const off = frameOffset();
      return off ? { doc: window.top.document, frame: window.frameElement, off } : null;
    } catch { return null; }
  }
  // Is this element (or one of its) a candidate cover: outside the writing
  // area and not one of its ancestors? An ancestor that changed (a class on
  // the body showing a drawer) stands for its positioned children.
  function candidates(v, el, into) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return;
    if (v.scroll.contains(el)) return;
    if (el.contains(v.scroll) || (el.ownerDocument !== document && el.contains(window.frameElement))) {
      const kids = el.children;
      for (let i = 0; i < kids.length && i < 120; i++) {
        const c = kids[i];
        if (c.contains(v.scroll) || (c.ownerDocument !== document && c.contains(window.frameElement))) continue;
        const pos = getComputedStyle(c).position;
        if (pos === 'fixed' || pos === 'absolute' || pos === 'sticky') into.add(c);
      }
      return;
    }
    into.add(el);
  }
  // Where an element (with whatever hangs from it: a menu's list is often
  // an absolute child outside its box) overlaps the writing area, in this
  // page's css pixels; null when it does not.
  function coverBox(v, el, area, shell) {
    if (!el.isConnected) return null;
    const dx = el.ownerDocument === document ? 0 : -shell.off[0], dy = el.ownerDocument === document ? 0 : -shell.off[1];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = r => { if (r.width > 0 && r.height > 0) { x0 = Math.min(x0, r.left + dx); y0 = Math.min(y0, r.top + dy); x1 = Math.max(x1, r.right + dx); y1 = Math.max(y1, r.bottom + dy); } };
    add(el.getBoundingClientRect());
    const all = el.getElementsByTagName('*');
    for (let i = 0; i < all.length && i < 300; i++) add(all[i].getBoundingClientRect());
    const box = [Math.max(x0, area.left), Math.max(y0, area.top), Math.min(x1, area.right), Math.min(y1, area.bottom)];
    return box[2] > box[0] + 1 && box[3] > box[1] + 1 ? box : null;
  }
  // On top somewhere in that overlap: the browser's own answer at a 3×3 of points.
  function onTop(v, el, box, shell) {
    const local = el.ownerDocument === document;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const x = box[0] + (box[2] - box[0]) * (0.15 + 0.35 * i), y = box[1] + (box[3] - box[1]) * (0.15 + 0.35 * j);
      const hit = local ? document.elementFromPoint(x, y) : shell.doc.elementFromPoint(x + shell.off[0], y + shell.off[1]);
      if (hit && (hit === el || el.contains(hit)) && !(local && v.scroll.contains(hit))) return true;
    }
    return false;
  }
  function computeHoles(v) {
    const area = v.scroll.getBoundingClientRect(), shell = shellOf();
    v.covers ||= new Set();
    for (const el of v.coverCands || []) v.covers.add(el);
    v.coverCands = new Set();
    const out = [];
    for (const el of [...v.covers]) {
      if (el.ownerDocument !== document && !shell) { v.covers.delete(el); continue; }
      const box = coverBox(v, el, area, shell);
      if (!box || !onTop(v, el, box, shell)) { v.covers.delete(el); continue; }
      out.push(box.map((n, k) => Math.round(k < 2 ? n - 4 : n + 4)));
    }
    // The lasso's own: its frame (it takes no taps, so the browser does not
    // see it on top), its buttons, the paste bar.
    for (const el of [v.sel && v.sel.el, v.sel && v.sel.bar, v.pasteBar]) {
      if (!el || !el.isConnected || el.hidden) continue;
      const q = el.getBoundingClientRect(), pad = el === (v.sel && v.sel.el) ? 8 : 4;
      out.push([q.left - pad, q.top - pad, q.right + pad, q.bottom + pad].map(Math.round));
    }
    return out.slice(0, 48);
  }
  function holesText(v, ox, oy) {
    return (v.holes || []).map(q => [q[0] + ox, q[1] + oy, q[2] + ox, q[3] + oy].join(',')).join(';');
  }
  // What can change the cover: anything added, shown, hidden or moved in
  // the page or the shell around it. Changes far from the writing area (a
  // conversation beside, streaming) cost one rectangle each and no more.
  function watchHoles(v) {
    const area = () => v.scroll.getBoundingClientRect();
    const mo = new MutationObserver(recs => {
      let any = !!(v.covers && v.covers.size);
      const into = v.coverCands ||= new Set();
      const before = into.size;
      for (let i = 0; i < recs.length && i < 60; i++) {
        const r = recs[i];
        if (r.type === 'childList') { for (const n of r.addedNodes) candidates(v, n.nodeType === 1 ? n : null, into); }
        else candidates(v, r.target, into);
      }
      // Only those over the area count; the rest are forgotten now.
      if (into.size > before) {
        const a = area(), shell = shellOf();
        for (const el of [...into]) if (!coverBox(v, el, a, shell)) into.delete(el);
      }
      if (any || into.size) holesSoon(v, 80);
    });
    const opts = { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'open', 'style', 'aria-expanded'] };
    mo.observe(document.body, opts);
    try { if (window.top !== window && window.top.document.body) mo.observe(window.top.document.body, opts); } catch {}
    const resize = () => holesSoon(v, 120);
    window.addEventListener('resize', resize);
    v.cleanups.push(() => { mo.disconnect(); window.removeEventListener('resize', resize); clearTimeout(v.holesTimer); });
    holesSoon(v, 0);
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
      // The lasso is the page's: it draws its own dashed loop and needs every
      // tap (a selection's buttons, a drag), not a line from the app.
      // The app's fast layer draws the lasso's loop too, once it can leave
      // the covered parts (the selection, its buttons) to the page: an app
      // with setHoles (0.3.8). An older one: the page has the lasso, and
      // the pen whenever anything covers the writing area.
      const precise = typeof n.setHoles === 'function';
      const on = want && !v.disposed && !!v.note && (precise || (v.tool !== 'lasso' && !(v.holes && v.holes.length)));
      v.nativeOn = on;
      if (!on) { if (!regionOnly) { n.setEnabled(false); } return; }
      const r = v.scroll.getBoundingClientRect(), [ox, oy] = frameOffset();
      // The page's css pixel in device pixels, so the app maps the region and
      // the lines with the page's own ratio, not one it assumes.
      n.setPixelRatio?.(devicePixelRatio);
      n.setRegion(Math.round(r.left + ox), Math.round(r.top + oy), Math.round(r.right + ox), Math.round(r.bottom + oy));
      if (precise) n.setHoles(holesText(v, ox, oy));
      if (!regionOnly) { n.setErase(v.tool === 'eraser'); n.setWidth?.(v.tool === 'lasso' ? 1.4 : v.width * v.scale); nativePen(v, n); if (typicalP) n.setPressureTypical?.(typicalP); n.setEnabled(true); }
    } catch {}
  }
  // The pen in hand, for the app's live line (app 0.3.7+; an older app draws
  // every pen as a ballpoint while the pen moves, and the page shows the
  // real pen once it lifts). tone: how the e-ink nib fills it, as black
  // dots: 0 solid; else a density in sixteenths, + 256 for a pencil's
  // random grain instead of an even screen; -1: no live line (white ink,
  // which the overlay cannot show). argb: the colour where the app draws
  // the line as a view (phones).
  function nativePen(v, n) {
    if (typeof n.setPen !== 'function') return;
    if (v.tool === 'lasso') { try { n.setPen('lasso', 0x200, 0xff000000 | 0); } catch {} return; } // dashed (ebc_nib.c TONE_DASH)
    const pen = F.PENS[v.penId] || F.PENS.ballpoint;
    const c = v.color;
    const grey = c === '#5c5c5c' ? 10 : c === '#a0a0a0' ? 5 : 16;
    let tone = grey === 16 ? 0 : grey;
    if (c === '#ffffff') tone = -1;
    else if (pen.fill === 'grain') tone = 256 + Math.round(grey * 0.6);
    else if (pen.fill === 'highlight') tone = 4;
    const hex = (c || (pen.fill === 'highlight' ? highlightColor(v) : '#000000')).replace('#', '');
    const alpha = pen.fill === 'highlight' ? 0x66 : pen.fill === 'grain' ? 0xcc : 0xff;
    try { n.setPen(v.penId || 'ballpoint', tone, (alpha * 0x1000000 + parseInt(hex, 16)) | 0); } catch {}
  }
  // A line the app drew: "x,y[,pressure[,ms]] …" in the page's css pixels.
  // pen: the pen the app drew it with (0.3.8); "lasso" is a selection loop.
  function acceptPacked(packed, erase, pen) {
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
    if (pen === 'lasso') {
      const poly = [];
      for (const [cx, cy] of pts) poly.push(...toPage(rect, cx, cy));
      lassoFinish(v, i, poly);
      // The dashed loop on the panel goes now: the selection's frame replaces it.
      try { nativeInk()?.clearLive(); } catch {}
      return;
    }
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
        const stroke = penStroke(v, { pts: F.settle(normalise(flat.slice(), 'pen'), { minStep: 0.6 / v.scale }), w: v.width, t0: Date.now() - dur, dur });
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
