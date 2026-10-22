/* The folder picker: one search box for a folder, used where a project is
   set up (a folder to add, a parent for a new folder) and where a draft
   chooses the folder it runs in.

   Type part of a name ("thes", "sch thes") to search the whole home folder;
   type a path (~/…, /…) to walk it. With nothing typed, suggestions fit the
   purpose. The server ranks (/api/fs/folders, folder-index.js); this file
   draws the list and follows the WAI-ARIA combobox pattern:
   ↑↓ move, Enter chooses, Tab opens the highlighted folder, Esc closes the
   list (not the dialog around it).

   FolderPicker.attach(input, { purpose: 'add' | 'parent' | 'run', host,
     onPick(row), onOpenProject(name) }) → { refresh(), close(), destroy() } */
'use strict';
(function () {
  let seq = 0;
  const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Highlight matched letters of `text`, whose first character sits at
  // `offset` in the display string the positions refer to.
  function marked(text, hl, offset) {
    const set = new Set(hl.map(i => i - offset).filter(i => i >= 0 && i < text.length));
    let out = '', open = false;
    for (let i = 0; i < text.length; i++) {
      const on = set.has(i);
      if (on !== open) { out += on ? '<mark>' : '</mark>'; open = on; }
      out += escHtml(text[i]);
    }
    return out + (open ? '</mark>' : '');
  }
  function ago(ms) {
    if (!(ms > 0)) return '';
    const d = (Date.now() - ms) / 86400000;
    if (d < 1 / 24) return 'just now';
    if (d < 1) return Math.round(d * 24) + 'h ago';
    if (d < 30) return Math.round(d) + 'd ago';
    if (d < 365) return Math.round(d / 30) + 'mo ago';
    return Math.round(d / 365) + 'y ago';
  }
  // What a row means for this purpose: can it be chosen, and what to say.
  function verdict(row, purpose) {
    if (purpose === 'add') {
      if (row.status === 'project') return { action: 'open', note: 'Already a project · Enter opens it' };
      if (row.status === 'inside') return { disabled: true, note: 'Part of project ' + row.project };
      if (row.status === 'taken') return { disabled: true, note: 'Name used by project ' + row.project + (row.root ? ' (' + row.root + ')' : '') };
      if (row.status === 'general') return { disabled: true, note: 'Too general to be a project' };
      return { note: row.within ? 'Inside project ' + row.within : '' };
    }
    if (purpose === 'parent') {
      if (row.projectsInside) return { note: row.projectsInside + (row.projectsInside === 1 ? ' project here' : ' projects here') };
      if (row.status === 'project') return { note: 'Inside project ' + row.project + ' would nest it' };
      return { note: '' };
    }
    if (row.status === 'project' || row.status === 'inside') return { note: 'project ' + row.project };
    if (row.status === 'general') return { note: 'no project' };
    return { note: '' };
  }

  function attach(input, opts = {}) {
    const purpose = opts.purpose || 'add';
    const id = 'fp' + (++seq);
    const host = opts.host || (() => { const h = document.createElement('div'); input.insertAdjacentElement('afterend', h); return h; })();
    host.classList.add('fsel');
    host.innerHTML = `<div class="fsel-list" role="listbox" id="${id}-list" aria-label="Folders" hidden></div><div class="fsel-foot" aria-live="polite" hidden></div>`;
    const list = host.querySelector('.fsel-list'), foot = host.querySelector('.fsel-foot');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    let rows = [], active = -1, open = false, timer = 0, ctrl = null, lastQuery = null, retry = 0, picking = false;

    const setOpen = value => {
      open = value;
      list.hidden = !value; foot.hidden = !value;
      input.setAttribute('aria-expanded', String(value));
      if (!value) { input.removeAttribute('aria-activedescendant'); active = -1; }
    };
    const paintActive = () => {
      list.querySelectorAll('.fsel-opt').forEach((el, i) => el.setAttribute('aria-selected', String(i === active)));
      const el = list.querySelector(`#${id}-o${active}`);
      if (el) { input.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); }
      else input.removeAttribute('aria-activedescendant');
    };
    function render(out, query) {
      rows = out.results || [];
      let html = '', section = null;
      rows.forEach((row, i) => {
        if (row.section && row.section !== section) { section = row.section; html += `<div class="fsel-sec" role="presentation">${escHtml(section)}</div>`; }
        const v = verdict(row, purpose);
        row._v = v;
        const nameStart = row.display.length - row.name.length;
        const parentShown = row.self ? 'this folder' : row.parent;
        const meta = [row.git ? '<span class="fsel-tag">Git</span>' : '',
          row.conversations ? `<span class="fsel-meta">${row.conversations} conversation${row.conversations === 1 ? '' : 's'}${row.lastTs ? ' · ' + ago(row.lastTs) : ''}</span>` : ''].join('');
        html += `<div class="fsel-opt${v.disabled ? ' off' : ''}${v.action === 'open' ? ' known' : ''}" role="option" id="${id}-o${i}" data-i="${i}" aria-selected="false"${v.disabled ? ' aria-disabled="true"' : ''}>
          <div class="fsel-main"><span class="fsel-name">${marked(row.name, row.hl || [], nameStart)}</span><span class="fsel-parent" title="${escHtml(row.display)}"><bdi dir="ltr">${row.self ? escHtml(parentShown) : marked(parentShown, row.hl || [], 0)}</bdi></span></div>
          <div class="fsel-side">${meta}${v.note ? `<span class="fsel-note">${escHtml(v.note)}</span>` : ''}</div>
        </div>`;
      });
      if (!rows.length) {
        html = `<div class="fsel-empty">${escHtml(out.error || (query.trim() ? `No folders match “${query.trim()}”. Type a path starting with ~/ or / to look anywhere.` : 'Type to search your folders, or a path starting with ~/.'))}</div>`;
      }
      list.innerHTML = html;
      const status = out.indexing ? 'Still looking through your folders…' : rows.length ? `${rows.length === 1 ? '1 folder' : rows.length + ' folders'}` : '';
      foot.innerHTML = `<span>${escHtml(status)}</span><span class="fsel-keys">↑↓ move · Enter choose · Tab open folder · Esc close</span>`;
      // Typing picks the best match; suggestions wait for an arrow key.
      active = query.trim() ? rows.findIndex(r => !r._v.disabled) : -1;
      paintActive();
      setOpen(true);
      clearTimeout(retry);
      if (out.indexing) retry = setTimeout(() => { lastQuery = null; search(); }, 600);
    }
    async function search() {
      const query = input.value;
      if (query === lastQuery && open) return;
      lastQuery = query;
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      try {
        const res = await fetch(`/api/fs/folders?for=${purpose}&q=${encodeURIComponent(query)}`, { signal: ctrl.signal });
        const out = await res.json();
        if (input.value !== query || document.activeElement !== input) return;
        if (out.error && !out.results) throw new Error(out.error);
        render(out, query);
      } catch (e) {
        if (e.name === 'AbortError') return;
        list.innerHTML = `<div class="fsel-empty">Could not search folders: ${escHtml(e.message || 'network error')}</div>`;
        setOpen(true);
      }
    }
    const schedule = () => { clearTimeout(timer); timer = setTimeout(search, 70); };
    function choose(i) {
      const row = rows[i];
      if (!row || row._v.disabled) return;
      if (row._v.action === 'open') { setOpen(false); if (opts.onOpenProject) opts.onOpenProject(row.project); return; }
      picking = true;
      input.value = row.display;
      lastQuery = row.display;
      setOpen(false);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      picking = false;
      if (opts.onPick) opts.onPick(row);
    }
    // Into the highlighted folder: its path, then what is inside.
    function drill(i) {
      const row = rows[i];
      if (!row) return false;
      const next = row.display.replace(/\/?$/, '/');
      if (input.value === next) return false;
      input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    const onInput = () => { if (!picking) schedule(); };
    const onFocus = () => { lastQuery = null; schedule(); };
    // Registered in the capture phase, so it runs before the page's own
    // handlers on the same box; a key it uses goes no further (Esc closes
    // the list, not the dialog or panel around it).
    const stop = e => { e.preventDefault(); e.stopImmediatePropagation(); };
    const onKey = e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        stop(e);
        if (!open) { lastQuery = null; search(); return; }
        if (!rows.length) return;
        active = e.key === 'ArrowDown' ? (active + 1) % rows.length : (active <= 0 ? rows.length - 1 : active - 1);
        paintActive();
      } else if (e.key === 'Enter' && open && active >= 0) {
        stop(e);
        choose(active);
      } else if (e.key === 'Tab' && !e.shiftKey && open && active >= 0 && !rows[active]._v.disabled) {
        if (drill(active)) stop(e);
      } else if (e.key === 'Escape' && open) {
        stop(e);
        setOpen(false);
      }
    };
    const onBlur = () => setTimeout(() => { if (document.activeElement !== input) setOpen(false); }, 120);
    input.addEventListener('input', onInput);
    input.addEventListener('focus', onFocus);
    input.addEventListener('keydown', onKey, true);
    input.addEventListener('blur', onBlur);
    // Clicking a row keeps the focus in the box.
    list.addEventListener('mousedown', e => e.preventDefault());
    list.addEventListener('click', e => { const el = e.target.closest('.fsel-opt'); if (el) choose(Number(el.dataset.i)); });
    list.addEventListener('mousemove', e => {
      const el = e.target.closest('.fsel-opt');
      if (el && Number(el.dataset.i) !== active) { active = Number(el.dataset.i); paintActive(); }
    });
    return {
      refresh() { lastQuery = null; search(); },
      close() { setOpen(false); },
      destroy() {
        clearTimeout(timer); clearTimeout(retry); if (ctrl) ctrl.abort();
        input.removeEventListener('input', onInput); input.removeEventListener('focus', onFocus);
        input.removeEventListener('keydown', onKey, true); input.removeEventListener('blur', onBlur);
        host.innerHTML = '';
      },
    };
  }
  window.FolderPicker = { attach, marked, verdict };
})();
