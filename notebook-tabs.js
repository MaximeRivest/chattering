'use strict';
// notebook-tabs.js — notebooks kept open while you work elsewhere
// (design/68). The side column lists them under the conversations.
//
// A notebook joins the list the first time a cell runs from this window.
// From then on, leaving it parks its editor instead of destroying it: the
// runner keeps going (run all's queue included), results are written into
// the document as they arrive, and the shared text carries them to disk and
// to everyone else. Coming back re-attaches the same editor: same undo
// history, same live panels, same input prompts.
//
// The limit is this window. The kernel lives on the server and finishes the
// cell whatever happens here, but the runner that writes the result lives
// in the page: closing or reloading it while a cell runs loses that result
// (the page asks first). The list itself survives a reload; its rows come
// back "cold" and open like any file.
//
// Loaded before app.html's main script; the document helpers it calls
// (disposeDocSession, openLiveFile, toast, esc, tinyAge…) are globals of
// that script, resolved at call time.

const NotebookTabs = (() => {
  const STORE = 'chattering.notebookTabs';
  const OPEN_STORE = 'chattering.notebookTabs.open';
  const KEY_PREFIX = 'notebook:';
  // Idle parked editors kept warm (instant return, undo history). A busy one
  // is never let go; past this many idle ones, the least recently left goes
  // cold: its editor is released, its row stays.
  const WARM_IDLE_MAX = 6;
  const entries = new Map(); // path → entry (see make)

  const make = (path, project) => ({
    path, project: project || null, listedAt: Date.now(),
    st: null,            // the live document (docState shape), when warm
    parkedAt: 0, scroll: 0,
    startedAt: 0,        // the running cell's start, 0 when none runs
    waiting: false,      // the running cell asks for input
    runAll: null,        // {done, total} while run all goes on
    last: null,          // {ok, at, ms, cancelled, dropped, error}: the last run's end
    unseen: false,       // it ended while the notebook was not on screen
  });

  function load() {
    let rows = [];
    try { rows = JSON.parse(localStorage.getItem(STORE) || '[]'); } catch {}
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || typeof r.path !== 'string' || !r.path.startsWith('/')) continue;
      const e = make(r.path, r.project);
      e.listedAt = Number(r.listedAt) || e.listedAt;
      e.last = r.last && typeof r.last === 'object' ? r.last : null;
      e.unseen = !!r.unseen;
      entries.set(e.path, e);
    }
  }
  function save() {
    const rows = [...entries.values()].map(e => ({ path: e.path, project: e.project, listedAt: e.listedAt, last: e.last, unseen: e.unseen }));
    try { localStorage.setItem(STORE, JSON.stringify(rows)); } catch {}
  }
  function changed() {
    save();
    if (typeof renderAgentsPopSoon === 'function') renderAgentsPopSoon();
  }

  const titleOf = path => String(path).split(/[\\/]/).pop().replace(/\.(md|markdown|qmd|rmd|mdx)$/i, '') || path;
  const onScreen = st => typeof docState !== 'undefined' && docState === st;
  const busy = e => !!(e.st && !e.st.closed && (e.startedAt || e.runAll));
  const live = e => !!(e.st && !e.st.closed);
  // The entry of a live document, only while it is the one listed.
  const entryOf = st => { const e = st && entries.get(st.path); return e && e.st === st ? e : null; };

  // Open the notebook of a row or a toast.
  function open(path) {
    const e = entries.get(path);
    if (typeof openLiveFile !== 'function') return;
    openLiveFile(path, { project: (e && e.project) || null });
  }

  // A cell started in this document: list it (again, if it was closed) and
  // say it runs.
  function runStarted(st) {
    let e = entries.get(st.path);
    if (!e) { e = make(st.path, st.project); entries.set(st.path, e); }
    if (e.st && e.st !== st && !e.st.closed && typeof disposeDocSession === 'function') disposeDocSession(e.st);
    e.st = st;
    if (st.project) e.project = st.project;
    e.startedAt = Date.now();
    e.waiting = false;
    if (e.runAll) e.runAll.done++;
    changed();
  }
  function runState(st, { waiting }) {
    const e = entryOf(st);
    if (!e || typeof waiting !== 'boolean' || e.waiting === waiting) return;
    e.waiting = waiting;
    changed();
    if (waiting && !onScreen(st) && typeof toast === 'function') toast('✋ ' + titleOf(st.path) + ' is waiting for your input · open it', () => open(st.path), '', { repeat: true });
  }
  function runEnded(st, { ok, result, wrote }) {
    const e = entryOf(st);
    if (!e) return;
    const ms = result.ms != null ? result.ms : Date.now() - e.startedAt;
    e.startedAt = 0;
    e.waiting = false;
    e.last = { ok: !!ok, at: Date.now(), ms, cancelled: !!result.cancelled, dropped: !result.error && !wrote, error: result.error ? String(result.error).slice(0, 120) : null };
    if (!onScreen(st)) {
      e.unseen = true;
      // Run all reports once, at its end; a single cell reports itself.
      if (!e.runAll && typeof toast === 'function') {
        const what = e.last.error ? '✗ ' + titleOf(st.path) + ' · ' + e.last.error
          : e.last.dropped ? '✗ ' + titleOf(st.path) + ' · the cell changed while it ran; output not written'
          : (ok ? '✓ ' : '✗ ') + titleOf(st.path) + ' · cell ' + (e.last.cancelled ? 'stopped' : ok ? 'finished' : 'failed') + ' · ' + tinyAgeOf(ms);
        toast(what, () => open(st.path), ok ? 'ok' : 'err');
      }
    }
    changed();
  }
  function runAllStarted(st, total) {
    let e = entries.get(st.path);
    if (!e) { e = make(st.path, st.project); entries.set(st.path, e); }
    e.st = st;
    e.runAll = { done: 0, total };
    changed();
  }
  function runAllEnded(st, r) {
    const e = entryOf(st);
    if (!e || !e.runAll) return;
    const { total } = e.runAll;
    e.runAll = null;
    if (!onScreen(st) && typeof toast === 'function' && !r.busy && !r.empty) {
      const name = titleOf(st.path);
      const text = r.ok ? '✓ ' + name + ' · ran all ' + r.total + ' cells'
        : r.stoppedBefore != null ? '■ ' + name + ' · run all stopped before cell ' + (r.stoppedBefore + 1) + ' of ' + r.total
        : '✗ ' + name + ' · run all stopped at cell ' + (r.failedAt + 1) + ' of ' + (r.total || total);
      toast(text, () => open(st.path), r.ok ? 'ok' : 'err');
    }
    changed();
  }

  // Leaving a listed notebook: keep it. Past the idle budget, the idle one
  // left longest ago lets its editor go.
  function park(st, { scroll = 0 } = {}) {
    const e = entryOf(st);
    if (!e) return false;
    e.parkedAt = Date.now();
    e.scroll = scroll;
    const idle = [...entries.values()].filter(x => live(x) && !busy(x) && !onScreen(x.st) && x !== e).sort((a, b) => a.parkedAt - b.parkedAt);
    while (idle.length >= WARM_IDLE_MAX) cool(idle.shift());
    changed();
    return true;
  }
  // The parked document of a path, handed back to be put on screen.
  function take(path) {
    const e = entries.get(path);
    if (!e || !live(e) || onScreen(e.st)) return null;
    return { st: e.st, scroll: e.scroll };
  }
  function shown(st) {
    const e = entries.get(st.path);
    if (!e) return;
    if (e.st && e.st !== st && !e.st.closed && typeof disposeDocSession === 'function') disposeDocSession(e.st);
    e.st = st;
    if (e.unseen) { e.unseen = false; changed(); }
  }
  function cool(e) {
    if (!live(e) || onScreen(e.st)) return;
    const st = e.st;
    e.st = null;
    if (typeof disposeDocSession === 'function') disposeDocSession(st);
  }
  // Should leaving this document park it rather than close it?
  function keeps(st) { return !!entryOf(st); }
  // The document let its editor go (closed on screen, or refused a park):
  // the row goes cold, and a run it had in flight is recorded as lost.
  function released(st) {
    const e = entryOf(st);
    if (!e) return;
    const wasBusy = !!(e.startedAt || e.runAll);
    e.st = null;
    e.startedAt = 0; e.waiting = false; e.runAll = null;
    if (wasBusy) e.last = { ok: false, at: Date.now(), ms: 0, cancelled: false, dropped: false, error: 'closed while running: output not written' };
    changed();
  }

  // ✕ on a row. A running notebook keeps computing on its kernel either
  // way; what closing costs is the result, which would have no editor to
  // land in. Only then is there a question.
  function close(path) {
    const e = entries.get(path);
    if (!e) return;
    if (busy(e) && !confirm(titleOf(path) + ' is running. If it closes, the kernel still finishes the cell, but its output is not written into the notebook. Close anyway?')) return;
    entries.delete(path);
    if (live(e) && !onScreen(e.st) && typeof disposeDocSession === 'function') disposeDocSession(e.st);
    changed();
  }
  // ■ on a row: stop run all's queue and interrupt the cell (the kernel
  // keeps its variables).
  function stop(path) {
    const e = entries.get(path);
    const st = e && live(e) ? e.st : null;
    if (!st || !st.runner) return;
    try { st.runner.cancelCell('queued'); } catch {}
    try { st.runner.cancel(); } catch {}
  }
  const anyBusy = () => [...entries.values()].some(busy);

  // ---- the rows ----
  const rowKey = path => KEY_PREFIX + path;
  const isRowKey = key => typeof key === 'string' && key.startsWith(KEY_PREFIX);
  const pathOfKey = key => isRowKey(key) ? key.slice(KEY_PREFIX.length) : null;
  function tinyAgeOf(ms) { return typeof tinyAge === 'function' ? tinyAge(ms) : Math.round(ms / 1000) + 's'; }

  // The section's markup for the side list: newest listed on top, rows
  // shaped like conversation rows (same state marks), so a glance reads
  // both lists the same way.
  function sectionHtml({ markHtml, typingHtml, isOpen, currentPath }) {
    if (!entries.size) return '';
    const now = Date.now();
    const rows = [...entries.values()].sort((a, b) => b.listedAt - a.listedAt).map(e => {
      const title = titleOf(e.path);
      const running = busy(e);
      const state = running ? (e.waiting ? 'asks' : 'working')
        : e.unseen && e.last && (!e.last.ok || e.last.dropped) ? 'stopped' : '';
      const unread = e.unseen && !running;
      let what;
      if (running) {
        const doing = e.waiting ? 'waiting for your input' : e.runAll ? 'running all · cell ' + Math.max(1, e.runAll.done) + ' of ' + e.runAll.total : 'running a cell';
        what = `<span class="ag-doing">${esc(doing)}</span>` + (e.startedAt ? ` · <span class="ag-elapsed" data-since="${e.startedAt}" title="Since this cell started">${esc(tinyAgeOf(now - e.startedAt))}</span>` : '');
      } else if (e.last) {
        const l = e.last;
        what = esc(l.error ? '✗ ' + l.error : l.dropped ? '✗ output not written (the cell changed)' : l.cancelled ? '■ stopped' : (l.ok ? '✓ ran' : '✗ failed') + ' · ' + tinyAgeOf(l.ms || 0));
      } else what = '';
      const cold = !live(e);
      const sub = [e.project ? `<span class="ag-nb-project">${esc(e.project)}</span>` : '', what, cold ? '<span class="ag-nb-cold" title="Not open in this window: opening it loads it again">not loaded</span>' : ''].filter(Boolean).join(' · ');
      const said = [unread ? 'finished' : '', state === 'working' ? 'running' : state === 'asks' ? 'waiting for your input' : state === 'stopped' ? 'failed' : ''].filter(Boolean).join(', ');
      const age = e.last ? tinyAgeOf(now - e.last.at) : '';
      const acts = (running ? `<button class="ag-kill" data-nb-stop="${esc(e.path)}" title="Stop: interrupt the kernel (its variables survive) and drop run all's queue">■</button>` : '') +
        `<button class="ag-close" data-nb-close="${esc(e.path)}" title="Close this notebook here. The file and its kernel stay as they are." aria-label="Close notebook">✕</button>`;
      return `<div class="ag-row ag-nb${state ? ' ' + state : ''}${unread ? ' unread' : ''}${e.path === currentPath ? ' current' : ''}" data-key="${esc(rowKey(e.path))}" role="listitem">` +
        `<span class="ag-main"><span class="ag-title" title="${esc(e.path)}"><span class="ag-nb-glyph" aria-hidden="true">▤</span><span>${esc(title)}</span>${said ? `<span class="sr-only">, ${esc(said)}</span>` : ''}${unread || state === 'asks' || state === 'stopped' ? markHtml : ''}${state === 'working' ? typingHtml : ''}<span class="ag-age">${esc(age)}</span></span>` +
        (sub ? `<span class="ag-sub"><span class="ag-dir">${sub}</span></span>` : '') + `</span>` +
        `<span class="ag-acts">${acts}</span></div>`;
    }).join('');
    const running = [...entries.values()].filter(busy).length;
    return `<details class="ag-notifications ag-notebooks"${isOpen ? ' open' : ''}><summary>Notebooks<span class="ag-notify-count">${!running ? entries.size : running === entries.size ? running + ' running' : running + ' running · ' + entries.size}</span></summary><div role="list" aria-label="Open notebooks">${rows}</div></details>`;
  }
  function sectionOpen() { return localStorage.getItem(OPEN_STORE) !== 'closed'; }
  function setSectionOpen(open) { try { localStorage.setItem(OPEN_STORE, open ? 'open' : 'closed'); } catch {} }

  // Clicks inside the section. True when the click was ours; `leaving`
  // runs before a row opens its notebook (the host closes its sheet).
  function handleClick(e, leaving = () => {}) {
    const stopBtn = e.target.closest('[data-nb-stop]');
    if (stopBtn) { e.stopPropagation(); stop(stopBtn.dataset.nbStop); return true; }
    const closeBtn = e.target.closest('[data-nb-close]');
    if (closeBtn) { e.stopPropagation(); close(closeBtn.dataset.nbClose); return true; }
    const row = e.target.closest('.ag-row.ag-nb[data-key]');
    if (!row) return false;
    e.stopPropagation();
    leaving();
    open(pathOfKey(row.dataset.key));
    return true;
  }

  load();
  // A result that has no page to land in is lost: say so before leaving.
  window.addEventListener('beforeunload', ev => {
    if (!anyBusy()) return;
    ev.preventDefault();
    ev.returnValue = '';
  });

  return {
    runStarted, runState, runEnded, runAllStarted, runAllEnded,
    park, take, shown, keeps, released, close, stop, open, anyBusy,
    rowKey, isRowKey, pathOfKey, sectionHtml, sectionOpen, setSectionOpen, handleClick,
    get size() { return entries.size; },
  };
})();
