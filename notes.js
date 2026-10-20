'use strict';
// notes.js — a note, by pen or by keyboard (design/103).
//
// One button (✎ beside "new" in the side list, ✎ Note in its ▾ menu and in
// a project's files, N on the keyboard) makes a note. It is a page to write
// on (ink-editor.js, `.ink.svg`) or a typed note (the Markdown editor,
// `.md`), and the person never chooses up front: the first mark does.
//
//   - It opens as what this device suits: a page where a pen has been used
//     (and always on the e-ink tablet), a typed note elsewhere.
//   - An empty page that gets a key becomes a typed note, the key and every
//     one after it typed there (ink-editor.js toTyped hands over a textarea
//     that holds them, focused inside the key press, so nothing is lost and
//     a phone's keyboard stays open).
//   - An empty typed note that gets a pen (or "Write by hand instead")
//     becomes a page.
//   - Once something is in a note, it keeps its kind; a page takes typed
//     text where it was tapped (ink-editor.js), a typed note can show a
//     page as a picture (![](….ink.svg)).
//
// The server turns the empty file into the other kind (/api/notes/convert,
// ink-notes.js convert), refusing once anything is in it, so a note another
// device just wrote in is never replaced. The note keeps its stamp
// (2026-10-20-1405.ink.svg → 2026-10-20-1405.md), its place in the side
// list and its place in history (Back never leads to the file that went).
(function () {
  const STAMP = /^\d{4}-\d\d-\d\d-\d{4}(?:-\d+)?\.(?:md|ink\.svg)$/i;
  // A note: in a project's documents/notes/ (or documents/handwritten/, the
  // folder before design/103), or a stamped file in the notes folder's own.
  function isNotePath(p) {
    const s = String(p || '');
    if (!/\.(md|ink\.svg)$/i.test(s)) return false;
    if (/\/documents\/(notes|handwritten)\/[^/]+$/.test(s)) return true;
    return /\/(notes|handwritten)\/[^/]+$/.test(s) && STAMP.test(s.split('/').pop());
  }
  const penSeen = () => !!(window.InkNotes && InkNotes.penSeen());
  function defaultKind() { return penSeen() ? 'ink' : 'text'; }
  function paperPref() { try { return localStorage.getItem('chattering.ink.paper') || 'lines'; } catch { return 'lines'; } }
  const unreachable = 'Could not reach this computer. Check the connection and try again.';

  // ---- a new note ----
  // opts.kind: 'ink' | 'text' to say; otherwise what this device suits.
  // opts.beside: { host, key } to open it beside a conversation.
  async function create(project = '', opts = {}) {
    const kind = opts.kind === 'ink' || opts.kind === 'text' ? opts.kind : defaultKind();
    const now = new Date();
    const body = { project: project || '', kind, when: now.getTime(), tzOffset: now.getTimezoneOffset() };
    if (kind === 'ink') Object.assign(body, { title: window.InkNotes ? InkNotes.noteTitle(now) : '', paper: paperPref() });
    let out;
    try { out = await postJson('/api/notes/new', body); } catch { out = { error: unreachable }; }
    if (!out || out.error) {
      errToast(out && out.error === 'project not found' ? 'That project has no folder on this computer.' : (out && out.error) || 'Could not make the note');
      return null;
    }
    if (typeof OpenFiles !== 'undefined') OpenFiles.keep(out.path, project || '', 'pin');
    if (opts.beside && typeof openLiveFileBeside === 'function') await openLiveFileBeside(out.path, { project: project || null, beside: opts.beside });
    else await openLiveFile(out.path, { project: project || null, back: typeof currentHash !== 'undefined' ? currentHash : null });
    return out.path;
  }

  // ---- an empty note becomes the other kind ----
  async function convertFile(ws, to) {
    let out;
    const title = to === 'ink' && window.InkNotes ? InkNotes.noteTitle() : '';
    try { out = await postJson('/api/notes/convert', { path: ws.path, to, project: ws.project || '', paper: paperPref(), when: Date.now(), title }); }
    catch { out = { error: unreachable }; }
    if (!out || out.error) {
      const why = out && out.error;
      errToast(why === 'the note has writing in it' ? 'This note has something in it now (another device?), so it stays as it is.' : why || 'Could not change the note');
      return null;
    }
    return out;
  }
  // The new file where the old one was: the side list, the history entry,
  // the panel beside a conversation.
  async function reopen(ws, next) {
    const project = ws.project || null;
    if (typeof OpenFiles !== 'undefined') { OpenFiles.close(ws.path, { undo: false }); OpenFiles.keep(next, project || '', 'pin'); }
    if (ws.placement === 'beside' && ws.besideKey && ws.frame && ws.frame.parentElement && typeof openLiveFileBeside === 'function') {
      return openLiveFileBeside(next, { project, beside: { host: ws.frame.parentElement, key: ws.besideKey } });
    }
    try { replaceRoute(fileWsHash({ ...ws, path: next, line: null, mode: null, historySel: null, reviewRef: null })); } catch {}
    return openLiveFile(next, { project, back: ws.back || null, browserContext: ws.browserContext || null });
  }
  function settled(el) {
    return new Promise(ok => {
      if (!el._composing) return ok();
      el.addEventListener('compositionend', () => setTimeout(ok, 0), { once: true });
      setTimeout(ok, 3000);
    });
  }
  function editorFor(p) {
    if (typeof docState !== 'undefined' && docState && docState.path === p && docState.editor) return docState.editor;
    if (typeof fileWs !== 'undefined' && fileWs && fileWs.path === p && fileWs.editor) return fileWs.editor;
    return null;
  }
  // An empty page → a typed note. `bridge`: the focused textarea holding
  // what was typed meanwhile (ink-editor.js toTyped). Resolves false when
  // the note stays a page (the caller then keeps the text on the page).
  async function toText(ws, bridge) {
    bridge.addEventListener('compositionstart', () => { bridge._composing = true; });
    bridge.addEventListener('compositionend', () => { bridge._composing = false; });
    const out = await convertFile(ws, 'text');
    if (!out) return false;
    await reopen(ws, out.path);
    await settled(bridge);
    const editor = editorFor(out.path), view = editor && editor.view;
    const text = bridge.value, caret = Math.min(text.length, bridge.selectionEnd ?? text.length);
    if (view) {
      if (text) view.dispatch({ changes: { from: 0, insert: text }, selection: { anchor: caret }, userEvent: 'input.type', scrollIntoView: true });
      editor.focus();
    } else if (text) {
      // No editor to hand it to (the file opened read-only): written as it is.
      try { await postJson('/api/doc/save', { path: out.path, text, actor: 'human', input: 'keyboard', project: ws.project || '' }); } catch {}
      if (typeof liveFileReload === 'function' && fileWs && fileWs.path === out.path) { try { await liveFileReload(fileWs); } catch {} }
    }
    bridge.remove();
    return true;
  }
  // An empty typed note → a page.
  async function toInk(ws) {
    if (ws.notesConverting) return false;
    ws.notesConverting = true;
    const editor = editorFor(ws.path);
    if (typeof docState !== 'undefined' && docState && docState.path === ws.path) clearTimeout(docState.saveTimer);
    try { editor && editor.setReadonly(true); } catch {}
    const out = await convertFile(ws, 'ink');
    if (!out) { ws.notesConverting = false; try { editor && editor.setReadonly(false); } catch {} return false; }
    await reopen(ws, out.path);
    return true;
  }

  // ---- a typed note, while it is empty: the other way in ----
  function textOf(ws) { try { return ws.editor ? ws.editor.getContent() : ''; } catch { return ''; } }
  function mounted(ws) {
    if (!ws || ws.kind !== 'md' || !isNotePath(ws.path)) return;
    const view = ws.frame && ws.frame.querySelector('.doc-view');
    const head = view && view.querySelector('.live-file-head');
    if (!view || !head) return;
    let bar = view.querySelector('.note-kind-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'note-kind-bar';
      bar.setAttribute('role', 'note');
      bar.innerHTML = `<span>A typed note.</span><button type="button" class="note-kind-ink" title="Make this a page to write on with a pen or the mouse">✎ Write by hand instead</button><span class="note-kind-hint">${penSeen() ? 'or touch the page with your pen' : ''}</span>`;
      head.after(bar);
      bar.querySelector('button').onclick = () => toInk(ws);
      // A pen on the empty note: it becomes a page (that touch draws nothing yet).
      view.addEventListener('pointerdown', ev => {
        if (ev.pointerType !== 'pen' || textOf(ws).trim() || ws.notesConverting || ev.target.closest('.live-file-head, .note-kind-bar')) return;
        ev.preventDefault(); ev.stopPropagation();
        toInk(ws);
      }, true);
    }
    const paint = () => { if (bar.isConnected) bar.hidden = !!textOf(ws).trim(); };
    ws.onTextChange = paint;
    paint();
  }

  // The keys that make a note, for the help.
  const helpRow = ['N', 'new note in the project in view: by pen or by keyboard, whichever you use first'];

  window.Notes = { create, toText, toInk, mounted, isNotePath, defaultKind, helpRow };
})();
