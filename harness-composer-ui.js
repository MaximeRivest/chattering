/* A native HTML editor over the harness's own completion provider. The
   provider owns matching AND applying the edit (quotes, cursor, extensions).
   No terminal input, ANSI rendering, or duplicate completion grammar here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.HarnessComposer = api; root.installHarnessComposer = api.install; }
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  // Browser-independent race control, also tested without a browser.
  function createClient({ request, read, write, display, unsupported = () => {}, clientId }) {
    let sequence = 0, active = null, snapshot = null, disposed = false;
    function current(expected) { const s = read(); return s.text === expected.text && s.cursor === expected.cursor && s.end === expected.end; }
    function close() {
      sequence++; active?.abort(); active = null; snapshot = null; display(null);
    }
    async function query(force = false) {
      close(); if (disposed) return;
      const expected = read(); if (expected.end !== expected.cursor) return;
      // An empty box has nothing to complete. Asking anyway would start the
      // harness (Pi loads the conversation and its extensions, and may note
      // its reasoning level in the file) just because a conversation was
      // opened. Ctrl+Space (force) still asks on purpose.
      if (!force && !expected.text.trim()) return;
      const seq = sequence, ctl = active = new AbortController();
      try {
        const result = await request({ action: 'complete', text: expected.text, cursor: expected.cursor, force, clientId }, ctl.signal);
        if (disposed || seq !== sequence || !current(expected)) return;
        if (result.supported === false) { close(); unsupported(); return; }
        if (result.items?.length && result.snapshot) {
          snapshot = { ...expected, token: result.snapshot, items: result.items };
          display({ items: result.items });
        }
      } catch (e) {
        if (!disposed && seq === sequence && current(expected) && e.name !== 'AbortError') display({ items: [], error: e.message });
      } finally { if (active === ctl) active = null; }
    }
    async function pick(index) {
      const saved = snapshot;
      if (!saved?.items[index] || !current(saved) || disposed) return close();
      close(); const seq = sequence, ctl = active = new AbortController();
      try {
        const edit = await request({ action: 'apply', text: saved.text, cursor: saved.cursor, snapshot: saved.token, itemIndex: index, clientId }, ctl.signal);
        if (disposed || seq !== sequence || !current(saved)) return;
        if (typeof edit.text !== 'string' || !Number.isInteger(edit.cursor) || edit.cursor < 0 || edit.cursor > edit.text.length) throw new Error('Invalid completion edit');
        write(edit);
      } catch (e) {
        if (!disposed && seq === sequence && current(saved) && e.name !== 'AbortError') display({ items: [], error: e.message });
      } finally { if (active === ctl) active = null; }
    }
    return { query, pick, close, dispose: () => { disposed = true; close(); } };
  }
  let uninstall = () => {};
  function install(ta, key) {
    uninstall();
    const life = new AbortController();
    const pop = document.createElement('div');
    // randomUUID exists only on secure pages; Chattering is also served over
    // plain HTTP on a local network, where getRandomValues still works.
    const clientId = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
    pop.id = 'harnessCompletion-' + clientId; pop.className = 'file-completion'; pop.hidden = true;
    pop.setAttribute('role', 'listbox'); pop.setAttribute('aria-label', 'Harness suggestions');
    document.body.append(pop);
    const oldAria = Object.fromEntries(['aria-autocomplete', 'aria-controls', 'aria-expanded'].map(k => [k, ta.getAttribute(k)]));
    ta.setAttribute('aria-autocomplete', 'list'); ta.setAttribute('aria-controls', pop.id);
    ta._harnessComposer = true;
    let items = [], selected = 0, timer = null, gone = false, message = '';
    const read = () => ({ text: ta.value, cursor: ta.selectionStart, end: ta.selectionEnd });
    const listen = (event, fn, capture = false) => ta.addEventListener(event, fn, { signal: life.signal, capture });
    const otherPalette = () => window._snipOpen || window._slashDetached || window._atDetached;
    function position() {
      if (pop.hidden) return;
      const r = ta.getBoundingClientRect();
      pop.style.maxWidth = Math.max(120, innerWidth - 16) + 'px';
      pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
      pop.style.top = Math.max(8, r.top >= pop.offsetHeight + 8 ? r.top - pop.offsetHeight - 4 : Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8)) + 'px';
    }
    function paint() {
      pop.replaceChildren();
      if (message) { const row = document.createElement('div'); row.className = 'file-completion-status'; row.textContent = message; pop.append(row); }
      items.forEach((item, i) => {
        const row = document.createElement('div'); row.id = pop.id + '-' + i; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(i === selected));
        const label = document.createElement('b'); label.textContent = item.label;
        const description = document.createElement('small'); description.textContent = item.description || '';
        row.append(label, description);
        row.onpointerdown = e => { e.preventDefault(); void client.pick(i); };
        pop.append(row);
      });
      pop.hidden = !items.length && !message;
      ta.setAttribute('aria-expanded', String(!pop.hidden));
      if (items.length) ta.setAttribute('aria-activedescendant', pop.id + '-' + selected);
      else ta.removeAttribute('aria-activedescendant');
      position();
      if (items.length) pop.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }
    const client = createClient({ clientId, read,
      request: async (body, signal) => {
        const r = await fetch('/api/node/compose', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: key, ...body }) });
        const out = await r.json();
        if (!r.ok || out.error) throw new Error(out.error || 'Completion unavailable');
        return out;
      },
      write: edit => {
        ta.focus(); ta.setRangeText(edit.text, 0, ta.value.length, 'end'); ta.setSelectionRange(edit.cursor, edit.cursor);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      },
      display: state => { items = state?.items || []; selected = 0; message = state?.error ? state.error + ' · Esc to dismiss' : ''; paint(); },
      unsupported: () => { cleanup(); window.installFileCompletion?.(ta, key); },
    });
    function cleanup() {
      if (gone) return; gone = true;
      clearTimeout(timer); life.abort(); client.dispose(); pop.remove(); delete ta._harnessComposer;
      ta.removeAttribute('aria-activedescendant');
      for (const [k, v] of Object.entries(oldAria)) { if (v == null) ta.removeAttribute(k); else ta.setAttribute(k, v); }
    }
    uninstall = cleanup;
    function update(force = false) {
      clearTimeout(timer); client.close();
      if (gone || !ta.isConnected || otherPalette()) return;
      timer = setTimeout(() => { if (!gone && !otherPalette()) void client.query(force); }, force ? 0 : 120);
    }
    listen('input', e => { if (!e.isComposing) update(); });
    listen('compositionstart', () => { clearTimeout(timer); client.close(); });
    listen('compositionend', () => update());
    listen('click', () => update());
    // Transcript refreshes replace the textarea and restore its draft/focus.
    // Re-query that restored draft instead of leaving a vanished popup.
    listen('focus', () => update());
    listen('blur', () => { clearTimeout(timer); client.close(); });
    listen('scroll', position);
    listen('keydown', e => {
      if (e.isComposing || otherPalette()) return;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === ' ') { e.preventDefault(); e.stopImmediatePropagation(); update(true); return; }
      if (pop.hidden || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || window._snipStops) return;
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
        if (!items.length && e.key !== 'Escape') return; // failed lookup must not trap send
        e.preventDefault(); e.stopImmediatePropagation(); clearTimeout(timer);
        if (e.key === 'Escape') client.close();
        else if (e.key === 'Enter' || e.key === 'Tab') void client.pick(selected);
        else { selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; paint(); }
      } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { clearTimeout(timer); client.close(); }
    }, true);
    window.addEventListener('resize', position, { signal: life.signal });
    return cleanup;
  }
  return { createClient, install };
});
