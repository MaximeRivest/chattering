'use strict';
// open-files.js — files kept open in the side list, under the conversations
// (design/77; notebooks that run on while you are elsewhere: design/68).
//
// A file joins the list when a person means it: they pin it (the pin by its
// name, the ⋯ menu, Alt+P, the Files browser, a file link's menu), run a
// cell in it, or edit it themselves. Opening a file to read it adds nothing.
// It stays until its ✕.
//
// Two layers:
// · The list itself belongs to the server (/api/open-files, logic in
//   open-files-store.js), so the laptop, the phone and the tablet show the
//   same files. This browser keeps a copy for an instant start, applies its
//   own changes at once and sends them; the server's list replaces the copy
//   (changes still in flight are applied again on top). A guest cannot write
//   the household's list: theirs lives in their own browser.
// · What this window does with a kept file is its own. Leaving a kept
//   notebook or code file parks its editor instead of destroying it: same
//   undo history, cursor and scroll when it comes back, a running cell goes
//   on and writes its output, run all carries on. Past a budget of idle
//   parked editors, the one left longest ago is released; its row stays and
//   opens it again. A notebook's last run is remembered per device.
//
// The limit of a run is this window: the kernel runs on the server and
// finishes the cell whatever happens here, but the runner that writes the
// result into the document lives in the page. Closing or reloading it while
// a cell runs loses that result (the page asks first).
//
// Loaded before app.html's main script; the helpers it calls (openLiveFile,
// disposeDocSession, fileWsDisposeParked, toast, esc, tinyAge…) are globals
// of that script and of filesmode.js, resolved at call time.

const OpenFiles = (() => {
  const SERVER_COPY = 'chattering.openFiles.server'; // the server's list, last seen
  const OWN_LIST = 'chattering.openFiles.own';        // a guest's list, kept here only
  const RUNS = 'chattering.openFiles.runs';           // this device's last run per notebook
  const FOLD = 'chattering.openFiles.fold';
  const TAUGHT = 'chattering.openFiles.taught';
  // Before design/77 the list was this browser's alone, and only notebooks.
  const LEGACY = 'chattering.notebookTabs';
  const LEGACY_FOLD = 'chattering.notebookTabs.open';
  const KEY_PREFIX = 'openfile:';
  // Idle parked editors kept warm. A busy one is never let go; past this
  // many idle ones, the one left longest ago is released (its row stays).
  const WARM_IDLE_MAX = 6;

  // ---- the list ----
  let kept = [];                 // [{path, project, at}], newest first
  let own = false;               // this person keeps their own list (a guest)
  const pending = new Map();     // path → {op: 'keep'|'close'|'restore', file}: not yet accepted
  let pushTimer = null, pushing = false;

  const read = (key, fallback) => { try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v == null ? fallback : v; } catch { return fallback; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const clean = files => (Array.isArray(files) ? files : [])
    .filter(f => f && isFullPath(f.path) && Number(f.at) > 0)
    .map(f => ({ path: f.path, project: typeof f.project === 'string' ? f.project : '', at: Number(f.at) }));
  const sortNewest = list => list.sort((a, b) => b.at - a.at || a.path.localeCompare(b.path));
  const isKept = path => kept.some(f => f.path === path);
  const keptEntry = path => kept.find(f => f.path === path) || null;

  // The server's list, with this browser's unaccepted changes on top. Its
  // revision orders the lists that arrive (answers, events, fetches): an
  // older one than already seen is dropped.
  const copy = read(SERVER_COPY, {});
  let serverList = clean(copy.files), serverRev = Number(copy.rev) || 0;
  function recompute() {
    const list = new Map((own ? clean(read(OWN_LIST, [])) : serverList).map(f => [f.path, f]));
    if (!own) for (const [path, p] of pending) {
      if (p.op === 'close') list.delete(path);
      else if (!list.has(path)) list.set(path, p.file);
      else if (p.op === 'keep' && !list.get(path).project && p.file.project) list.set(path, { ...list.get(path), project: p.file.project });
    }
    kept = sortNewest([...list.values()]);
  }
  recompute();

  function fromServer(d) {
    if (!d || !Array.isArray(d.files)) return;
    const rev = Number(d.rev) || 0;
    if (rev && rev < serverRev) return;
    serverRev = rev || serverRev;
    serverList = clean(d.files);
    write(SERVER_COPY, { rev: serverRev, files: serverList });
    if (own) return;
    recompute();
    changed();
  }
  async function refresh() {
    let r;
    try { r = await fetch('/api/open-files'); } catch { return; }
    // Refused (not signed out): this person is a guest here.
    if (r.status === 403) { becomeOwn(); return; }
    if (!r.ok) return;
    own = false;
    let d;
    try { d = await r.json(); } catch { return; }
    fromServer(d);
    carryOverLegacy();
    if (pending.size) push();
  }
  // A guest (or a person the household walls off) keeps their own list in
  // this browser. What they had queued lands there instead.
  function becomeOwn() {
    if (own) return;
    own = true;
    const list = new Map(clean(read(OWN_LIST, [])).map(f => [f.path, f]));
    for (const [path, p] of pending) { if (p.op === 'close') list.delete(path); else if (!list.has(path)) list.set(path, p.file); }
    pending.clear();
    write(OWN_LIST, sortNewest([...list.values()]));
    carryOverLegacy();
    recompute();
    changed();
  }

  // One change to the list. Applied here at once; sent to the server in a
  // small batch where only each file's last change counts.
  function change(op, file) {
    if (own) {
      const list = clean(read(OWN_LIST, []));
      const have = list.find(f => f.path === file.path);
      if (op === 'close') list.splice(list.indexOf(have), have ? 1 : 0);
      else if (have) { if (!have.project && file.project) have.project = file.project; }
      else list.push(op === 'keep' ? { ...file, at: Math.max(Date.now(), ...list.map(f => f.at + 1)) } : file);
      write(OWN_LIST, sortNewest(list));
    } else {
      // Only what differs from the server's list is sent: letting a file go
      // and keeping it again before the batch leaves sends nothing, so it
      // cannot land after another device's later change and undo it.
      const there = serverList.find(f => f.path === file.path);
      const same = op === 'close' ? !there : !!there && (op !== 'keep' || !file.project || !!there.project);
      if (same) pending.delete(file.path);
      else pending.set(file.path, { op, file });
      clearTimeout(pushTimer);
      if (pending.size) pushTimer = setTimeout(push, 150);
    }
    recompute();
    changed();
  }
  async function push() {
    clearTimeout(pushTimer);
    pushTimer = null;
    if (pushing || !pending.size || own) return;
    pushing = true;
    const batch = new Map(pending);
    const body = { keep: [], close: [], restore: [] };
    for (const { op, file } of batch.values()) body[op].push(op === 'close' ? file.path : file);
    try {
      const r = await fetch('/api/open-files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      // The route refused this person: a guest keeps their own list.
      if (r.status === 403) { pushing = false; becomeOwn(); return; }
      const d = await r.json().catch(() => ({}));
      // A malformed request will not get better by sending it again.
      if (r.status === 400 || r.status === 413) {
        for (const [path, p] of batch) if (pending.get(path) === p) pending.delete(path);
        if (typeof errToast === 'function') errToast('Open files: the server refused the change (' + (d.error || r.status) + ')');
        recompute(); changed();
        return;
      }
      if (!r.ok) throw new Error('open-files ' + r.status);
      for (const [path, p] of batch) if (pending.get(path) === p) pending.delete(path);
      // A file this person may not see is not kept: say which.
      if (Array.isArray(d.refused) && d.refused.length && typeof errToast === 'function') errToast('Not kept open (not yours to see here): ' + d.refused.map(nameOf).join(', '));
      fromServer(d);
    } catch {
      // Offline, or the server restarting: the list here already shows the
      // change; it is sent again shortly.
      pushTimer = setTimeout(push, 10000);
    } finally {
      pushing = false;
      if (pending.size && !pushTimer) pushTimer = setTimeout(push, 150);
    }
  }
  // The old per-browser notebook list joins the shared one once, in its own
  // order; its last runs become this device's.
  function carryOverLegacy() {
    const rows = read(LEGACY, null);
    if (!Array.isArray(rows)) return;
    const runs = read(RUNS, {});
    for (const r of rows) {
      if (!r || !isFullPath(r.path)) continue;
      if (!isKept(r.path)) change('restore', { path: r.path, project: r.project || '', at: Number(r.listedAt) || Date.now() });
      if (r.last && !runs[r.path]) runs[r.path] = { last: r.last, unseen: !!r.unseen };
    }
    write(RUNS, runs);
    try {
      localStorage.removeItem(LEGACY);
      if (localStorage.getItem(LEGACY_FOLD) === 'closed') localStorage.setItem(FOLD, 'closed');
      localStorage.removeItem(LEGACY_FOLD);
    } catch {}
  }

  // ---- what this window holds ----
  const windows = new Map(); // path → this window's state of a file (see make)
  const runs = read(RUNS, {});
  const make = path => ({
    path,
    st: null,          // a notebook's live document (docState shape), parked or on screen
    ws: null,          // a code file's parked workspace (filesmode.js)
    host: null,        // its editor's element while parked
    parkedAt: 0, scroll: 0,
    startedAt: 0,      // the running cell's start, 0 when none runs
    waiting: false,    // the running cell asks for input
    runAll: null,      // {done, total} while run all goes on
    project: '',
  });
  const windowOf = path => { let e = windows.get(path); if (!e) windows.set(path, e = make(path)); return e; };
  const saveRuns = () => {
    for (const path of Object.keys(runs)) if (!isKept(path) && !windows.has(path)) delete runs[path];
    write(RUNS, runs);
  };
  const runOf = path => runs[path] || null;

  const nameOf = path => String(path).split(/[\\/]/).pop() || path;
  const parentOf = path => String(path).split(/[\\/]/).slice(-2, -1)[0] || '';
  const liveSt = e => !!(e && e.st && !e.st.closed);
  const liveWs = e => !!(e && e.ws && e.ws.editor);
  const warm = e => liveSt(e) || liveWs(e);
  const busy = e => !!(e && liveSt(e) && (e.startedAt || e.runAll));
  const onScreen = e => !!e && ((e.st && typeof docState !== 'undefined' && docState === e.st) || (e.ws && typeof fileWs !== 'undefined' && fileWs === e.ws));
  const stOnScreen = st => typeof docState !== 'undefined' && docState === st;
  // The window state of a live document, only while it is the one held.
  const entryOf = st => { const e = st && windows.get(st.path); return e && e.st === st ? e : null; };

  function open(path) {
    if (typeof openLiveFile !== 'function') return;
    const f = keptEntry(path), e = windows.get(path);
    openLiveFile(path, { project: (f && f.project) || (e && e.project) || null });
  }

  // ---- keeping and letting go ----
  // Keep a file. `why` ('pin', 'run', 'edit') decides whether to explain:
  // the first time a file is kept without a pin, this device is told why
  // it appeared, once.
  function keep(path, project = '', why = 'pin') {
    if (!isFullPath(path)) return false;
    if (isKept(path)) {
      const f = keptEntry(path);
      if (f && !f.project && project) change('keep', { path, project, at: f.at });
      return false;
    }
    change('keep', { path, project: project || '', at: Date.now() });
    if (why !== 'pin' && localStorage.getItem(TAUGHT) !== '1' && typeof toast === 'function') {
      try { localStorage.setItem(TAUGHT, '1'); } catch {}
      toast(nameOf(path) + ' stays under Open files in the side list: you ' + (why === 'run' ? 'ran a cell in it' : 'edited it') + '. Its ✕ lets it go.', null, '', { repeat: true });
    }
    return true;
  }
  // A person changed the text of an open file (the editor's userEdit).
  function edited(path, project) { if (!isKept(path)) keep(path, project, 'edit'); }

  // Let a file go (its ✕, the pin, Alt+P). A running notebook keeps
  // computing on its kernel either way; what closing costs is the result,
  // which would have no editor to land in: only then is there a question.
  function close(path, { undo = true } = {}) {
    const f = keptEntry(path), e = windows.get(path);
    if (busy(e) && !confirm(nameOf(path) + ' is running. If it closes, the kernel still finishes the cell, but its output is not written into the notebook. Close anyway?')) return false;
    if (f) change('close', f);
    if (e && !onScreen(e)) release(e);
    if (f && undo && typeof toast === 'function') toast('Closed ' + nameOf(path) + ' · Undo', () => change('restore', f), '', { repeat: true });
    return true;
  }
  function toggle(path, project = '') {
    if (isKept(path)) return close(path, { undo: false }) && false;
    keep(path, project, 'pin');
    return true;
  }

  // ---- notebook runs (app.html createDocRunner, runAllDocCells) ----
  // A cell started in this document: the file is kept, and its row says it runs.
  function runStarted(st) {
    const e = windowOf(st.path);
    if (e.st && e.st !== st && !e.st.closed && typeof disposeDocSession === 'function') disposeDocSession(e.st);
    e.st = st;
    if (st.project) e.project = st.project;
    e.startedAt = Date.now();
    e.waiting = false;
    if (e.runAll) e.runAll.done++;
    keep(st.path, st.project || '', 'run');
    changed();
  }
  function runState(st, { waiting }) {
    const e = entryOf(st);
    if (!e || typeof waiting !== 'boolean' || e.waiting === waiting) return;
    e.waiting = waiting;
    changed();
    if (waiting && !stOnScreen(st) && typeof toast === 'function') toast('✋ ' + nameOf(st.path) + ' is waiting for your input · open it', () => open(st.path), '', { repeat: true });
  }
  function runEnded(st, { ok, result, wrote }) {
    const e = entryOf(st);
    if (!e) return;
    const ms = result.ms != null ? result.ms : Date.now() - e.startedAt;
    e.startedAt = 0;
    e.waiting = false;
    const last = { ok: !!ok, at: Date.now(), ms, cancelled: !!result.cancelled, dropped: !result.error && !wrote, error: result.error ? String(result.error).slice(0, 120) : null };
    const away = !stOnScreen(st);
    runs[st.path] = { last, unseen: away };
    saveRuns();
    // Run all reports once, at its end; a single cell reports itself.
    if (away && !e.runAll && typeof toast === 'function') {
      const what = last.error ? '✗ ' + nameOf(st.path) + ' · ' + last.error
        : last.dropped ? '✗ ' + nameOf(st.path) + ' · the cell changed while it ran; output not written'
        : (ok ? '✓ ' : '✗ ') + nameOf(st.path) + ' · cell ' + (last.cancelled ? 'stopped' : ok ? 'finished' : 'failed') + ' · ' + tinyAgeOf(ms);
      toast(what, () => open(st.path), ok ? 'ok' : 'err');
    }
    settle(e);
    changed();
  }
  function runAllStarted(st, total) {
    const e = windowOf(st.path);
    if (e.st && e.st !== st && !e.st.closed && typeof disposeDocSession === 'function') disposeDocSession(e.st);
    e.st = st;
    e.runAll = { done: 0, total };
    keep(st.path, st.project || '', 'run');
    changed();
  }
  function runAllEnded(st, r) {
    const e = entryOf(st);
    if (!e || !e.runAll) return;
    const { total } = e.runAll;
    e.runAll = null;
    if (!stOnScreen(st) && typeof toast === 'function' && !r.busy && !r.empty) {
      const name = nameOf(st.path);
      const text = r.ok ? '✓ ' + name + ' · ran all ' + r.total + ' cells'
        : r.stoppedBefore != null ? '■ ' + name + ' · run all stopped before cell ' + (r.stoppedBefore + 1) + ' of ' + r.total
        : '✗ ' + name + ' · run all stopped at cell ' + (r.failedAt + 1) + ' of ' + (r.total || total);
      toast(text, () => open(st.path), r.ok ? 'ok' : 'err');
    }
    settle(e);
    changed();
  }
  // A run ended in a notebook closed from the list meanwhile (here, or on
  // another device): its result is written, then its editor goes.
  function settle(e) {
    if (!busy(e) && !isKept(e.path) && !onScreen(e)) release(e);
  }
  // ■ on a row: stop run all's queue and interrupt the cell (the kernel
  // keeps its variables).
  function stop(path) {
    const e = windows.get(path);
    const st = liveSt(e) ? e.st : null;
    if (!st || !st.runner) return;
    try { st.runner.cancelCell('queued'); } catch {}
    try { st.runner.cancel(); } catch {}
  }
  const anyBusy = () => [...windows.values()].some(busy);

  // ---- parking notebooks (app.html parkDocument / resumeDocumentEditor) ----
  // Should leaving this document park it rather than close it?
  function keeps(st) { return !!st && (isKept(st.path) || busy(entryOf(st))); }
  function park(st, { scroll = 0 } = {}) {
    if (!keeps(st)) return false;
    const e = windowOf(st.path);
    e.st = st;
    if (st.project) e.project = st.project;
    e.parkedAt = Date.now();
    e.scroll = scroll;
    budget(e);
    changed();
    return true;
  }
  // The parked document of a path, handed back to be put on screen.
  function take(path) {
    const e = windows.get(path);
    if (!liveSt(e) || onScreen(e)) return null;
    return { st: e.st, scroll: e.scroll };
  }
  // A document is on screen (mounted fresh or resumed). A kept file's
  // document is the one this window holds from now on; its last run is seen.
  function shown(st) {
    if (!isKept(st.path) && !windows.has(st.path)) return;
    const e = windowOf(st.path);
    if (e.st && e.st !== st && !e.st.closed && typeof disposeDocSession === 'function') disposeDocSession(e.st);
    e.st = st;
    if (st.project) e.project = st.project;
    seen(st.path);
  }
  // The document let its editor go (closed on screen, or released): a run
  // it had in flight is recorded as lost.
  function released(st) {
    const e = entryOf(st);
    if (!e) return;
    const wasBusy = !!(e.startedAt || e.runAll);
    e.st = null;
    e.startedAt = 0; e.waiting = false; e.runAll = null;
    if (wasBusy) { runs[st.path] = { last: { ok: false, at: Date.now(), ms: 0, cancelled: false, dropped: false, error: 'closed while running: output not written' }, unseen: false }; saveRuns(); }
    forgetIfEmpty(e);
    changed();
  }

  // ---- parking code and text files (filesmode.js) ----
  // Should leaving this workspace park its editor? Only a plain editing
  // visit: not a review of an old version, not while an agent it asked is
  // editing the file (that visit's settle and review are bound to it).
  function keepsCode(ws) {
    return !!(ws && ws.kind === 'code' && ws.mode === 'write' && ws.editor && !ws.run && !ws.reviewRef && isKept(ws.path));
  }
  function parkCode(ws, { host, scroll = 0 }) {
    if (!keepsCode(ws) || !host) return false;
    const e = windowOf(ws.path);
    if (e.ws && e.ws !== ws && typeof fileWsDisposeParked === 'function') fileWsDisposeParked(e.ws);
    e.ws = ws; e.host = host; e.scroll = scroll;
    e.project = ws.project || e.project;
    e.parkedAt = Date.now();
    budget(e);
    changed();
    return true;
  }
  // The parked workspace of a path, handed back to be put on screen. It
  // stays held: on screen, it is the file's workspace here.
  function takeCode(path) {
    const e = windows.get(path);
    if (!liveWs(e) || onScreen(e)) return null;
    const out = { ws: e.ws, host: e.host, scroll: e.scroll };
    e.host = null;
    return out;
  }
  // A workspace was destroyed by its own path (closed while not kept).
  function codeReleased(ws) {
    const e = windows.get(ws && ws.path);
    if (!e || e.ws !== ws) return;
    e.ws = null; e.host = null;
    forgetIfEmpty(e);
  }

  // Past the idle budget, the idle editor left longest ago lets go.
  function budget(except) {
    const idle = [...windows.values()].filter(x => x !== except && warm(x) && !busy(x) && !onScreen(x)).sort((a, b) => a.parkedAt - b.parkedAt);
    while (idle.length >= WARM_IDLE_MAX) release(idle.shift());
  }
  // Release what this window holds of a file (never the one on screen).
  function release(e) {
    if (!e || onScreen(e)) return;
    if (liveSt(e) && typeof disposeDocSession === 'function') { const st = e.st; e.st = null; disposeDocSession(st); }
    if (liveWs(e) && typeof fileWsDisposeParked === 'function') { const ws = e.ws; e.ws = null; e.host = null; fileWsDisposeParked(ws); }
    forgetIfEmpty(e);
  }
  function forgetIfEmpty(e) {
    if (!warm(e) && !busy(e) && windows.get(e.path) === e && !isKept(e.path)) windows.delete(e.path);
  }
  function seen(path) {
    const r = runs[path];
    if (r && r.unseen) { r.unseen = false; saveRuns(); changed(); }
  }

  // ---- telling the page ----
  function changed() {
    // A file let go elsewhere: what this window parked of it goes too.
    for (const e of [...windows.values()]) if (!isKept(e.path) && !busy(e) && !onScreen(e)) release(e);
    paintKeepControls();
    if (typeof renderAgentsPopSoon === 'function') renderAgentsPopSoon();
  }

  // ---- the pin (the file's header, the Files browser) ----
  const PIN = '<svg class="of-pin" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M10.1 1.6l4.3 4.3-1.6.4-2.6 2.6.3 3.4-1.4 1.4-2.9-2.9L2.9 14.1l-1-1 3.3-3.3-2.9-2.9 1.4-1.4 3.4.3 2.6-2.6z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  const keepTitle = on => on
    ? 'Kept open: listed under Open files in the side list, on every device. Click to let it go · Alt+P'
    : 'Keep open: list this file under Open files in the side list, on every device · Alt+P';
  // The pin by a file's name. `id` for the one in the open file's header.
  function keepButtonHtml(path, project = '', { id = '', cls = 'lf-keep' } = {}) {
    const on = isKept(path);
    return `<button type="button"${id ? ` id="${id}"` : ''} class="${cls}" data-keep-path="${esc(path)}" data-keep-project="${esc(project || '')}" aria-pressed="${on}" aria-label="${on ? 'Kept open' : 'Keep open'}" title="${esc(keepTitle(on))}">${PIN}</button>`;
  }
  function paintKeepControls() {
    if (typeof document === 'undefined') return;
    for (const b of document.querySelectorAll('[data-keep-path]')) {
      const on = isKept(b.dataset.keepPath);
      if (b.getAttribute('aria-pressed') === String(on)) continue;
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', on ? 'Kept open' : 'Keep open');
      b.title = keepTitle(on);
    }
    for (const b of document.querySelectorAll('[data-keep-menu]')) b.textContent = menuLabel(b.dataset.keepMenu);
  }
  const menuLabel = path => (isKept(path) ? 'Let go from Open files' : 'Keep open in the side list') + ' (Alt+P)';
  // The file on screen: Alt+P, the ⋯ menu entry.
  function toggleCurrent() {
    if (typeof fileWs === 'undefined' || !fileWs || !fileWs.path) return false;
    const on = toggle(fileWs.path, fileWs.project || '');
    if (typeof toast === 'function') toast(on ? 'Kept open: ' + nameOf(fileWs.path) + ' is under Open files in the side list' : 'Let go: ' + nameOf(fileWs.path) + ' is no longer kept open', null, '', { repeat: true });
    return true;
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('click', e => {
      const b = e.target.closest && e.target.closest('[data-keep-path]');
      if (b) { e.preventDefault(); e.stopPropagation(); toggle(b.dataset.keepPath, b.dataset.keepProject || ''); return; }
      const m = e.target.closest && e.target.closest('[data-keep-menu]');
      if (m) { e.preventDefault(); m.closest('details')?.removeAttribute('open'); toggleCurrent(); }
    }, true);
    // Alt+P on an open file, in its text or anywhere on the page.
    document.addEventListener('keydown', e => {
      if (e.code !== 'KeyP' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
      if (typeof viewKind === 'undefined' || viewKind !== 'file' || typeof fileWs === 'undefined' || !fileWs) return;
      if (e.target.closest && e.target.closest('dialog, .modal, [role="dialog"]')) return;
      e.preventDefault();
      toggleCurrent();
    });
  }

  // ---- the rows ----
  const rowKey = path => KEY_PREFIX + path;
  const isRowKey = key => typeof key === 'string' && key.startsWith(KEY_PREFIX);
  const pathOfKey = key => isRowKey(key) ? key.slice(KEY_PREFIX.length) : null;
  function tinyAgeOf(ms) { return typeof tinyAge === 'function' ? tinyAge(ms) : Math.round(ms / 1000) + 's'; }
  const KIND_GLYPH = { md: ['▤', 'Document or notebook'], code: ['‹›', 'Code or text'], image: ['◩', 'Image'], video: ['▷', 'Video'], pdf: ['▯', 'PDF'] };
  const kindOf = path => typeof fileWsKind === 'function' ? fileWsKind(path) : /\.(md|markdown|qmd|rmd|mdx)$/i.test(path) ? 'md' : 'code';

  // The rows in the order they show: the kept files, newest first, and a
  // file still running here after it was let go (its result is on its way).
  function rows() {
    const out = [...kept];
    for (const e of windows.values()) if (busy(e) && !isKept(e.path)) out.push({ path: e.path, project: e.project, at: 0 });
    return out;
  }

  // The section's markup: rows shaped like conversation rows (same state
  // marks), so a glance reads both lists the same way.
  function sectionHtml({ markHtml, typingHtml, isOpen, currentPath }) {
    const list = rows();
    if (!list.length) return '';
    const now = Date.now();
    const names = new Map();
    for (const f of list) names.set(nameOf(f.path), (names.get(nameOf(f.path)) || 0) + 1);
    const html = list.map(f => {
      const e = windows.get(f.path), run = runOf(f.path), last = run && run.last;
      const running = busy(e);
      const unseen = !!(run && run.unseen) && !running;
      const state = running ? (e.waiting ? 'asks' : 'working') : unseen && last && (!last.ok || last.dropped) ? 'stopped' : '';
      const name = nameOf(f.path);
      const [glyph, kindLabel] = KIND_GLYPH[kindOf(f.path)] || KIND_GLYPH.code;
      // Two kept files of one name: the folder tells them apart.
      const twin = names.get(name) > 1 && parentOf(f.path) ? `<span class="of-twin">${esc(parentOf(f.path))}/</span>` : '';
      let what = '';
      if (running) {
        const doing = e.waiting ? 'waiting for your input' : e.runAll ? 'running all · cell ' + Math.max(1, e.runAll.done) + ' of ' + e.runAll.total : 'running a cell';
        what = `<span class="ag-doing">${esc(doing)}</span>` + (e.startedAt ? ` · <span class="ag-elapsed" data-since="${e.startedAt}" title="Since this cell started">${esc(tinyAgeOf(now - e.startedAt))}</span>` : '');
      } else if (last) {
        what = esc(last.error ? '✗ ' + last.error : last.dropped ? '✗ output not written (the cell changed)' : last.cancelled ? '■ stopped' : (last.ok ? '✓ ran' : '✗ failed') + ' · ' + tinyAgeOf(last.ms || 0));
      }
      const project = f.project && typeof ProjectScope !== 'undefined' ? ProjectScope.label(f.project) : f.project;
      const sub = [project ? `<span class="of-project">${esc(project)}</span>` : '', what].filter(Boolean).join(' · ');
      const said = [kindLabel.toLowerCase(), unseen ? 'finished' : '', state === 'working' ? 'running' : state === 'asks' ? 'waiting for your input' : state === 'stopped' ? 'failed' : ''].filter(Boolean).join(', ');
      const age = last ? tinyAgeOf(now - last.at) : '';
      const presence = typeof presenceFileSlotHtml === 'function' ? presenceFileSlotHtml(f.path) : '';
      const acts = (running ? `<button class="ag-kill" data-of-stop="${esc(f.path)}" title="Stop: interrupt the kernel (its variables survive) and drop run all's queue">■</button>` : '') +
        `<button class="ag-close" data-of-close="${esc(f.path)}" title="Close: take it off this list. The file and its kernel stay as they are." aria-label="Close ${esc(name)}">✕</button>`;
      return `<div class="ag-row ag-of${state ? ' ' + state : ''}${unseen ? ' unread' : ''}${f.path === currentPath ? ' current' : ''}" data-key="${esc(rowKey(f.path))}" role="listitem" title="${esc(f.path)}">` +
        `<span class="ag-main"><span class="ag-title"><span class="of-glyph" aria-hidden="true" title="${esc(kindLabel)}">${glyph}</span><span class="of-name">${esc(name)}</span>${twin}<span class="sr-only">, ${esc(said)}</span>${presence}${unseen || state === 'asks' || state === 'stopped' ? markHtml : ''}${state === 'working' ? typingHtml : ''}<span class="ag-age">${esc(age)}</span></span>` +
        (sub ? `<span class="ag-sub"><span class="ag-dir">${sub}</span></span>` : '') + `</span>` +
        `<span class="ag-acts">${acts}</span></div>`;
    }).join('');
    const running = list.filter(f => busy(windows.get(f.path))).length;
    const count = !running ? String(list.length) : running === list.length ? running + ' running' : running + ' running · ' + list.length;
    return `<details class="ag-notifications ag-open-files"${isOpen ? ' open' : ''}><summary>Open files<span class="ag-notify-count">${count}</span></summary><div role="list" aria-label="Open files">${html}</div></details>`;
  }
  function sectionOpen() { return (localStorage.getItem(FOLD) ?? localStorage.getItem(LEGACY_FOLD)) !== 'closed'; }
  function setSectionOpen(isOpen) { try { localStorage.setItem(FOLD, isOpen ? 'open' : 'closed'); } catch {} }

  // Clicks inside the section. True when the click was ours; `leaving`
  // runs before a row opens its file (the host closes its sheet).
  function handleClick(e, leaving = () => {}) {
    const stopBtn = e.target.closest('[data-of-stop]');
    if (stopBtn) { e.stopPropagation(); stop(stopBtn.dataset.ofStop); return true; }
    const closeBtn = e.target.closest('[data-of-close]');
    if (closeBtn) { e.stopPropagation(); close(closeBtn.dataset.ofClose); return true; }
    const row = e.target.closest('.ag-row.ag-of[data-key]');
    if (!row) return false;
    e.stopPropagation();
    leaving();
    open(pathOfKey(row.dataset.key));
    return true;
  }

  // A result that has no page to land in is lost: say so before leaving.
  if (typeof window !== 'undefined') window.addEventListener('beforeunload', ev => {
    if (!anyBusy()) return;
    ev.preventDefault();
    ev.returnValue = '';
  });

  return {
    // the list
    isKept, keep, close, toggle, edited, refresh, fromServer, open,
    // notebook runs and parking
    runStarted, runState, runEnded, runAllStarted, runAllEnded, stop, anyBusy,
    keeps, park, take, shown, released,
    // code and text files
    keepsCode, parkCode, takeCode, codeReleased,
    // the page
    keepButtonHtml, menuLabel, paintKeepControls, toggleCurrent, seen,
    rowKey, isRowKey, pathOfKey, sectionHtml, sectionOpen, setSectionOpen, handleClick,
    get size() { return rows().length; },
    get own() { return own; },
  };
})();
