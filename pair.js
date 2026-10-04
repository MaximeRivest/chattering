/* The pair (design/83): a conversation and what it made, side by side.

   The conversation is always the one real view, in the main column. What
   sits beside it — a file in the real editor, a change, a deck, a PDF, a
   picture, a widget — is always in the artifact panel (artifacts.js), in
   the right column. "Both ways" is one layout tilted:

   - talking: the conversation wide, the thing beside it;
   - working: the thing wide, the conversation narrow on its right, as on a
     phone. The panel and the conversation swap grid columns; no element
     moves, so nothing reloads.

   Where the two cannot both fit (a narrow window, a phone) the panel lies
   over the conversation, and the tilt says which one is on screen; a pill
   brings the other back in one tap.

   A file beside a conversation is the file view itself (live-file.js),
   placed in the panel: one editor, moved, never a second one. Opening the
   same file full page moves it back (the editor keeps its undo history,
   cursor, shared text and running cells either way).

   This module owns the tilt, the conversation's width while working, the
   pill, and the ways in: a file or a change from a conversation, a file
   with its conversation. The panel's kinds 'document' and 'change' call
   back here to mount. */
(function () {
  'use strict';
  const TILT_KEY = 'chattering.pair.tilt';        // 'talk' | 'work', this device's choice on a wide screen
  const CONV_KEY = 'chattering.pair.convWidth';   // the conversation's width while working
  let wideTilt = (() => { try { return localStorage.getItem(TILT_KEY) === 'work' ? 'work' : 'talk'; } catch { return 'talk'; } })();
  let shownOverlay = true;                        // over the conversation: the panel on screen (else the pill)
  let pill = null, grip = null;

  const body = () => document.body;
  const pane = () => document.getElementById('artifactPane');
  // The stylesheet says when the panel lies over the conversation (the same
  // widths as artifacts.css): one source of truth for the breakpoints.
  const overlay = () => getComputedStyle(document.documentElement).getPropertyValue('--pair-overlay').trim() === '1'
    || (document.body && getComputedStyle(document.body).getPropertyValue('--pair-overlay').trim() === '1');
  const docked = () => typeof Artifacts !== 'undefined' && !!Artifacts.state() && !Artifacts.floating();
  const baseName = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

  // ---- the tilt ------------------------------------------------------------------

  /** 'work' when the panel is the wide side (or, overlaid, the one on screen). */
  function tilt() { return overlay() ? (shownOverlay ? 'work' : 'talk') : wideTilt; }

  // The top-bar layout: the panel starts under the bar.
  function measureTop() {
    if (body().classList.contains('side-layout')) return;
    const bar = document.querySelector('body > header');
    const h = bar && bar.getClientRects().length ? Math.round(bar.getBoundingClientRect().bottom) : 0;
    if (h > 0) body().style.setProperty('--pair-top', h + 'px');
  }

  function apply() {
    measureTop();
    const on = docked(), over = overlay();
    body().classList.toggle('pair-work', on && tilt() === 'work');
    // Wide: the panel and the conversation swap columns. Overlaid: which one shows.
    body().classList.toggle('pair-swap', on && !over && wideTilt === 'work');
    body().classList.toggle('pair-talk-hidden', on && over && !shownOverlay);
    paintPill(on && overlay() && !shownOverlay);
    paintTiltButton();
    paintPairButton();
    // Every editor and chart measures again; the ask box follows its line.
    window.dispatchEvent(new Event('resize'));
  }

  /** Set the tilt. On a wide screen it is this device's choice; overlaid it only says which side shows. */
  function setTilt(next) {
    next = next === 'work' ? 'work' : 'talk';
    if (overlay()) shownOverlay = next === 'work';
    else {
      wideTilt = next;
      try { localStorage.setItem(TILT_KEY, next); } catch {}
    }
    apply();
  }
  const toggle = () => setTilt(tilt() === 'work' ? 'talk' : 'work');

  function paintTiltButton() {
    const b = pane()?.querySelector('[data-art-act="tilt"]');
    if (!b) return;
    const work = tilt() === 'work';
    if (overlay()) {
      b.textContent = '☷ conversation';
      b.title = 'Back to the conversation; this stays one tap away (Alt+\\)';
      b.setAttribute('aria-pressed', 'false');
    } else {
      b.textContent = '⇄ swap';
      b.title = work ? 'Make the conversation the wide side again (Alt+\\)' : 'Make this the wide side; the conversation moves to its right, narrow (Alt+\\)';
      b.setAttribute('aria-pressed', String(work));
    }
    b.setAttribute('aria-label', b.title.replace(/ \(Alt.*$/, ''));
  }

  // The panel was opened (or its thing replaced): on a narrow screen it is
  // what the person asked to see.
  function opened() { shownOverlay = true; ensureGrip(); apply(); }
  function closed() { apply(); }

  // ---- the pill: the other side, one tap away ----------------------------------

  function paintPill(show) {
    if (!show) { if (pill) pill.hidden = true; return; }
    if (!pill) {
      pill = document.createElement('button');
      pill.type = 'button';
      pill.id = 'pairPill';
      pill.onclick = () => setTilt('work');
      document.body.appendChild(pill);
    }
    const st = Artifacts.state();
    const glyph = st && st.kind === 'document' ? '▤' : st && st.kind === 'change' ? '±' : '◧';
    pill.textContent = glyph + ' ' + ((st && st.title) || 'beside');
    pill.title = 'Show ' + ((st && st.title) || 'what is beside the conversation') + ' again';
    pill.hidden = false;
  }

  // ---- the conversation's width while working ---------------------------------

  function ensureGrip() {
    const p = pane();
    if (!p || grip) return;
    grip = document.createElement('div');
    grip.className = 'pair-grip';
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-orientation', 'vertical');
    grip.setAttribute('aria-label', 'Resize the conversation beside it');
    grip.tabIndex = 0;
    p.appendChild(grip);
    const setW = px => {
      const side = body().classList.contains('side-layout') ? (document.getElementById('side')?.getBoundingClientRect().width || 0) : 0;
      const w = Math.round(Math.max(360, Math.min(window.innerWidth - side - 480, px)));
      body().style.setProperty('--pair-conv', w + 'px');
      try { localStorage.setItem(CONV_KEY, String(w)); } catch {}
      window.dispatchEvent(new Event('resize'));
    };
    grip.addEventListener('pointerdown', e => {
      e.preventDefault(); grip.setPointerCapture(e.pointerId); p.classList.add('art-dragging');
      const move = ev => setW(window.innerWidth - ev.clientX);
      const up = () => { grip.removeEventListener('pointermove', move); p.classList.remove('art-dragging'); };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up, { once: true });
    });
    grip.addEventListener('keydown', e => {
      const w = window.innerWidth - p.getBoundingClientRect().right;
      if (e.key === 'ArrowLeft') { e.preventDefault(); setW(w + 40); } else if (e.key === 'ArrowRight') { e.preventDefault(); setW(w - 40); }
    });
    const saved = Number(localStorage.getItem(CONV_KEY));
    if (saved) body().style.setProperty('--pair-conv', saved + 'px');
  }

  // ---- ways in ----------------------------------------------------------------------

  /**
   * A file beside the conversation `key` (the one on screen). line: where to
   * put the cursor. fromList: opened from the right panel's lists (Made,
   * Files), which the panel's ← goes back to.
   */
  function openFile(path, { key, line = null, project = null, fromList = false } = {}) {
    if (!path || !key || typeof Artifacts === 'undefined') return false;
    Artifacts.openPanel({ kind: 'document', key, path: String(path), title: baseName(path), line, project, fromList });
    return true;
  }

  /** One tool call's change to a file, beside the conversation (the change view). */
  function openChange(ctx) {
    if (!ctx || !ctx.key || typeof Artifacts === 'undefined') return false;
    Artifacts.openPanel({ kind: 'change', key: ctx.key, path: ctx.path, title: baseName(ctx.path), ts: ctx.ts || '', anchor: ctx.anchor || '', call: ctx.call || '' });
    return true;
  }

  /** The conversation beside the file on screen is `key`. */
  function showsConversation(key) {
    return typeof fileWs !== 'undefined' && !!fileWs && fileWs.placement === 'beside' && (key == null || fileWs.besideKey === key)
      && typeof viewKind !== 'undefined' && viewKind === 'conversation' && typeof activeRel !== 'undefined' && activeRel === fileWs.besideKey;
  }

  /** The conversation that goes with a file: where it was opened from, its last ask, or the one that last worked on it. */
  async function conversationFor(ws) {
    if (!ws) return null;
    const fromBack = ws.back && typeof fbConversationHash === 'function' ? fbConversationHash(ws.back) : null;
    if (fromBack) return fromBack;
    if (ws.askLast && ws.askLast.key) return ws.askLast.key;
    try {
      const info = await (await fetch('/api/files/ask-target?' + new URLSearchParams({ path: ws.path, project: ws.project || '' }))).json();
      return (info.candidates && info.candidates[0] && info.candidates[0].key) || null;
    } catch { return null; }
  }

  /**
   * The file on screen, with its conversation: the file keeps its place and
   * stays the wide side ("working"); the conversation appears beside it.
   * The editor moves into the panel as it is.
   */
  async function withConversation(ws = typeof fileWs !== 'undefined' ? fileWs : null, key = null) {
    if (!ws || !ws.frame) return false;
    key = key || await conversationFor(ws);
    if (!key) { if (typeof toast === 'function') toast('No conversation has worked on this file yet. ' + modKey('K') + ' asks for a change.'); return false; }
    if (typeof fileWs === 'undefined' || fileWs !== ws) return false;
    if (ws.placement === 'beside' && ws.besideKey === key) { focusConversation(); return true; }
    // Already beside another conversation: the pairing changes, nothing moves.
    if (ws.placement === 'beside' && besideFile() === ws) return switchConversation(key);
    // The editor leaves the page but stays alive; the route change below does
    // not close it (setRouteKind keeps a file placed beside).
    ws.placement = 'beside';
    ws.besideKey = key;
    ws.frame.remove();
    Artifacts.remember(key, { kind: 'document', path: ws.path, project: ws.project || null });
    // The file keeps the wide side for this pairing; the device's saved
    // choice (the ⇄ button's) is not changed by it.
    if (!overlay()) wideTilt = 'work';
    await open(key, 'bottom');
    if (fileWs !== ws) return false;
    openFile(ws.path, { key, project: ws.project || null });
    return true;
  }

  /** The conversation beside the file: on a narrow screen, bring it to the front; wide, show its end. */
  function focusConversation() {
    if (overlay()) setTilt('talk');
    const view = document.getElementById('view');
    if (view) view.scrollTop = view.scrollHeight;
  }

  // ---- the panel's own kinds (artifacts.js calls these) ----------------------------

  /** Put the file beside: the workspace already there (moved, or kept), or a new one. */
  function mountDocument(host, st) {
    const ws = typeof fileWs !== 'undefined' ? fileWs : null;
    if (ws && ws.path === st.path && ws.frame && (ws.placement === 'beside' || !ws.frame.isConnected)) {
      ws.placement = 'beside';
      ws.besideKey = st.key;
      if (ws.frame.parentElement !== host) host.replaceChildren(ws.frame);
      liveFilePlaced(ws);
      if (st.line && ws.editor && ws.editor.gotoLine) { try { ws.editor.gotoLine(st.line); } catch {} }
      return;
    }
    openLiveFile(st.path, { beside: { host, key: st.key }, project: st.project || null, line: st.line || null });
  }

  /** The panel lets go of a document it showed: the file workspace closes (or parks, if kept). */
  function release(st) {
    if (!st || st.kind !== 'document' || typeof fileWs === 'undefined' || !fileWs) return;
    if (fileWs.placement === 'beside' && fileWs.path === st.path) closeFileWorkspace();
  }

  /** The file workspace beside closed on its own (another file opened): the panel follows. */
  function released(ws) {
    const st = typeof Artifacts !== 'undefined' ? Artifacts.state() : null;
    if (st && st.kind === 'document' && st.path === ws.path) Artifacts.hideFor(st);
  }

  // Keys: Alt+\ tilts, anywhere a panel is beside (not while typing in a
  // field other than the panel's editor, where Alt+\ types nothing anyway).
  document.addEventListener('keydown', e => {
    if (!(e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'Backslash') || !docked()) return;
    e.preventDefault();
    e.stopPropagation();
    toggle();
  }, true);
  window.addEventListener('resize', () => {
    measureTop();
    const on = docked();
    const over = overlay();
    if (body().classList.contains('pair-work') !== (on && tilt() === 'work') || body().classList.contains('pair-swap') !== (on && !over && wideTilt === 'work')
      || body().classList.contains('pair-talk-hidden') !== (on && over && !shownOverlay)) apply();
    else paintTiltButton();
  });
  // A new page (a conversation, a draft) beside the file: its name in the head.
  window.addEventListener('chattering:route', () => queueMicrotask(paintPairButton));

  // ---- which conversation: the file stays, the conversation beside it changes ----

  const isDraft = key => typeof key === 'string' && key.startsWith('draft:');
  const sessionOf = key => (typeof sessions !== 'undefined' && Array.isArray(sessions) ? sessions.find(s => s && s.key === key) : null) || null;
  const titleOf = key => isDraft(key) ? 'new conversation' : (() => { const s = sessionOf(key); return String((s && (s.title || s.timelineTitle)) || 'conversation').replace(/\s+/g, ' ').trim(); })();
  /** The file beside, editable, docked: the only case where the pairing can change. */
  function besideFile() {
    const st = typeof Artifacts !== 'undefined' ? Artifacts.state() : null;
    const ws = typeof fileWs !== 'undefined' ? fileWs : null;
    if (!st || Artifacts.floating() || !ws || ws.placement !== 'beside') return null;
    const file = st.kind === 'document' ? st.path : st.editing;
    return file && file === ws.path ? ws : null;
  }

  // The head says which conversation the file is with, and is the way to change it.
  function paintPairButton() {
    const b = pane()?.querySelector('[data-art-act="pair"]');
    if (!b) return;
    const ws = besideFile();
    b.hidden = !ws;
    if (!ws) return;
    const title = titleOf(ws.besideKey);
    b.innerHTML = '<span class="art-pair-glyph" aria-hidden="true">☷</span><span class="art-pair-name"></span><span aria-hidden="true">▾</span>';
    b.querySelector('.art-pair-name').textContent = title;
    b.title = 'This file is beside “' + title + '”. Choose another conversation, or start a new one about this file';
    b.setAttribute('aria-label', 'Conversation beside this file: ' + title + '. Change it');
  }

  /**
   * Put another conversation beside the file on screen. The file keeps its
   * place, its editor, its tilt; the conversation in the main column is
   * replaced, as if it had been opened from the list.
   */
  async function switchConversation(key) {
    const ws = besideFile();
    if (!ws || !key) return false;
    if (key === ws.besideKey && typeof activeRel !== 'undefined' && activeRel === key) { focusConversation(); return true; }
    ws.besideKey = key;
    ws.back = key;
    Artifacts.rekey(key);
    await open(key, 'bottom');
    if (fileWs !== ws) return false;
    liveFilePlaced(ws);
    // An ask box open over the file now goes to this conversation.
    if (typeof askBox !== 'undefined' && askBox && askBox.ws === ws && typeof askBubbleLoadTarget === 'function') askBubbleLoadTarget(askBox);
    paintPairButton();
    return true;
  }

  // Where a new conversation about the file runs: the paired conversation's
  // folder when the file is inside it (an area keeps its scope), else the
  // project holding the file, else the file's own folder.
  function folderFor(ws) {
    const inside = dir => !!dir && (ws.path === dir || ws.path.startsWith(String(dir).replace(/\/+$/, '') + '/'));
    const conv = sessionOf(ws.besideKey);
    if (conv && inside(conv.cwd)) return conv.cwd;
    const rows = typeof sidebarProjectRows === 'function' ? sidebarProjectRows() : [];
    const project = rows.filter(r => inside(r.cwd)).sort((a, b) => b.cwd.length - a.cwd.length)[0];
    if (project) return project.cwd;
    if (conv && conv.cwd) return conv.cwd;
    return ws.path.replace(/[\\/][^\\/]*$/, '') || '';
  }

  // A new conversation beside the file: the draft page takes the main column,
  // the file stays, and the file rides along as context. When the first
  // message goes, the new conversation keeps the file beside it (carryInto).
  let draftCarry = false;
  const intoDraft = () => draftCarry;
  function newConversation() {
    const ws = besideFile();
    if (!ws || typeof newDraft !== 'function' || typeof showDraft !== 'function') return false;
    const d = { ...newDraft(), folder: folderFor(ws), context: [{ type: 'file', path: ws.path }], beside: { path: ws.path, project: ws.project || null } };
    saveDraft(d);
    // showDraft sets the route before its first wait: the flag covers exactly that.
    draftCarry = true;
    try { showDraft(d.id); }
    finally { draftCarry = false; }
    if (fileWs !== ws || typeof activeRel === 'undefined' || !isDraft(activeRel)) return false;
    ws.besideKey = activeRel;
    Artifacts.rekey(activeRel);
    liveFilePlaced(ws);
    paintPairButton();
    return true;
  }
  /** A draft started beside a file was sent: the conversation it became keeps the file. */
  function carryInto(key, spec) {
    if (!key || !spec || !spec.path || typeof Artifacts === 'undefined') return;
    const ws = besideFile();
    if (ws && ws.path === spec.path) { ws.besideKey = key; ws.back = key; Artifacts.rekey(key); }
    else Artifacts.remember(key, { kind: 'document', path: spec.path, project: spec.project || null });
  }

  // The choice: conversations that worked on the file, those open in the
  // side list, the project's recent ones; a search reaches all of them.
  let pickerClose = null;
  async function pickConversation(anchor) {
    if (pickerClose) { pickerClose(true); return; }
    const ws = besideFile();
    if (!ws || !anchor) return;
    document.querySelectorAll('.mpick').forEach(el => el.remove());
    const pop = document.createElement('div');
    pop.className = 'mpick pair-picker';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Conversation beside ' + baseName(ws.path));
    pop.innerHTML = '<div class="mp-top"><input type="search" class="mp-filter" aria-label="Find a conversation" placeholder="Find a conversation" autocomplete="off" spellcheck="false"></div><div class="mp-list"></div>';
    document.body.appendChild(pop);
    anchor.setAttribute('aria-expanded', 'true');
    const input = pop.querySelector('input'), list = pop.querySelector('.mp-list');
    const close = (focus = false) => {
      pop.remove(); anchor.setAttribute('aria-expanded', 'false'); pickerClose = null;
      document.removeEventListener('click', outside, true); window.removeEventListener('chattering:route', onRoute); window.removeEventListener('resize', position);
      if (focus && anchor.isConnected) anchor.focus({ preventScroll: true });
    };
    const outside = e => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
    const onRoute = () => close();
    const position = () => {
      if (!pop.isConnected) return;
      if (window.matchMedia('(max-width: 700px)').matches) { for (const p of ['width', 'max-height', 'left', 'top']) pop.style.removeProperty(p); return; }
      const r = anchor.getBoundingClientRect();
      pop.style.width = Math.min(400, innerWidth - 16) + 'px';
      pop.style.maxHeight = Math.max(160, Math.min(520, innerHeight - r.bottom - 14)) + 'px';
      pop.style.left = Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8)) + 'px';
      pop.style.top = (r.bottom + 6) + 'px';
    };
    pickerClose = close;

    const usable = s => s && s.key && !s.mirror && !s.hiddenFanout && !isDraft(s.key);
    const recency = s => Date.parse(s.lastTs || s.firstTs || '') || 0;
    const byRecency = arr => arr.slice().sort((a, b) => recency(b) - recency(a));
    const all = () => (typeof sessions !== 'undefined' && Array.isArray(sessions) ? sessions : []).filter(usable);
    const paired = sessionOf(ws.besideKey);
    const project = paired && typeof projectOf === 'function' ? projectOf(paired) : (ws.project || '');
    let worked = null; // keys, newest first; null while loading
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const when = s => { const t = recency(s); return t && typeof ago === 'function' ? ago(Date.now() - t) + ' ago' : ''; };
    const row = s => {
      const on = s.key === ws.besideKey;
      const where = typeof projectOf === 'function' ? projectOf(s) : '';
      const meta = [where && where !== (typeof LOOSE_PROJECT !== 'undefined' ? LOOSE_PROJECT : '') ? where : '', when(s), on ? 'beside it now' : ''].filter(Boolean).join(' · ');
      return `<button type="button" class="mp-row${on ? ' on' : ''}" data-pair-key="${esc(s.key)}" aria-pressed="${on}"><b>${esc(titleOf(s.key))}</b>${meta ? `<small>${esc(meta)}</small>` : ''}</button>`;
    };
    const paint = () => {
      if (!pop.isConnected) return;
      const q = input.value.trim().toLocaleLowerCase();
      const shown = new Set();
      const section = (label, items, max) => {
        const rows = items.filter(s => !shown.has(s.key)).slice(0, max);
        rows.forEach(s => shown.add(s.key));
        return rows.length ? `<div class="pp-sec">${esc(label)}</div>` + rows.map(row).join('') : '';
      };
      let html = '';
      if (q) {
        const hits = byRecency(all().filter(s => `${titleOf(s.key)} ${typeof projectOf === 'function' ? projectOf(s) : ''}`.toLocaleLowerCase().includes(q)));
        html = section('Matching', hits, 40) || '<div class="mp-empty">No conversation matches.</div>';
      } else {
        const workedRows = (worked || []).map(sessionOf).filter(usable);
        const listed = typeof listedSessions === 'function' ? byRecency(listedSessions().filter(usable)) : [];
        html = section('Worked on this file', workedRows, 6)
          + (worked ? '' : '<div class="pp-sec pp-loading">Looking for conversations that worked on it…</div>')
          + section('Open', listed, 8)
          + (project ? section('Recent in ' + project, byRecency(all().filter(s => typeof projectOf === 'function' && projectOf(s) === project)), 6) : '');
        // The one beside it now is always in the list, marked.
        if (paired && usable(paired) && !shown.has(paired.key)) html = row(paired) + html;
      }
      list.innerHTML = html + `<button type="button" class="mp-row mp-create" data-pair-new title="A new conversation with this file attached as context; the file stays beside it"><b>+ New conversation about ${esc(baseName(ws.path))}</b></button>`;
      list.querySelectorAll('[data-pair-key]').forEach(b => b.onclick = () => { const key = b.dataset.pairKey; close(); switchConversation(key); });
      list.querySelector('[data-pair-new]').onclick = () => { close(); newConversation(); };
      position();
    };
    input.oninput = paint;
    pop.onkeydown = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
      const buttons = [...list.querySelectorAll('button')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); e.stopPropagation();
        const i = buttons.indexOf(document.activeElement);
        buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      } else if (e.key === 'Enter' && e.target === input) { e.preventDefault(); (buttons.find(b => !b.classList.contains('on') && b.dataset.pairKey) || buttons[0])?.click(); }
    };
    paint();
    input.focus();
    document.addEventListener('click', outside, true);
    window.addEventListener('chattering:route', onRoute);
    window.addEventListener('resize', position);
    // The file's own history: who wrote in it, newest first.
    try {
      const out = await (await fetch('/api/files/touched?' + new URLSearchParams({ path: ws.path }))).json();
      worked = [...new Set((out.sessions || []).map(sn => sn.convKey).filter(Boolean))];
    } catch { worked = []; }
    if (pickerClose === close) paint();
  }

  /** Android's back button: a panel over the conversation steps aside first. */
  function back() {
    if (!docked() || !overlay() || !shownOverlay) return false;
    setTilt('talk');
    return true;
  }

  window.Pair = {
    tilt, setTilt, toggle, apply, opened, closed, overlay,
    openFile, openChange, withConversation, focusConversation, showsConversation, conversationFor,
    mountDocument, release, released, back,
    pickConversation, switchConversation, newConversation, carryInto, intoDraft,
  };
})();
