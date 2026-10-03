'use strict';
// Delimited data (CSV, TSV) read as a table: in a conversation's change card
// (step-changes-ui.js) and in the file view (file-viewers.js). Read-only:
// the text stays the file, and editing stays the text editor's.
//
// One parser for both (RFC 4180: quoted fields, "" inside quotes, line
// breaks inside quotes, CRLF, a byte-order mark), the separator taken from
// the file's name or, for .csv, sniffed (comma, semicolon, tab or bar: a
// "CSV" from a European spreadsheet uses semicolons). The table draws a
// page of rows at a time, so a 100,000-row file opens as fast as a short one;
// sorting and filtering work on every row.
(function () {
  const TABLE_PATH = /\.(csv|tsv|tab|psv)$/i;
  const MAX_ROWS = 200000;      // parsed at most; the rest is counted as not shown
  const PAGE = 200;             // rows drawn at a time
  const PAGE_COMPACT = 100;     // in a conversation's card
  const NAMES = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'bar' };
  const e = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function isTablePath(p) { return TABLE_PATH.test(String(p || '')); }

  // Quote-aware count of each candidate separator on the first lines; the
  // one that splits the most lines into the same number of fields wins.
  function sniff(text) {
    const cands = [',', ';', '\t', '|'];
    const per = cands.map(() => []);
    let counts = cands.map(() => 0), quoted = false, lines = 0;
    for (let i = 0; i < text.length && lines < 30; i++) {
      const ch = text[i];
      if (ch === '"') { if (quoted && text[i + 1] === '"') i++; else quoted = !quoted; continue; }
      if (quoted) continue;
      if (ch === '\n') { counts.forEach((n, k) => per[k].push(n)); counts = cands.map(() => 0); lines++; continue; }
      const k = cands.indexOf(ch);
      if (k >= 0) counts[k]++;
    }
    if (counts.some(n => n)) counts.forEach((n, k) => per[k].push(n));
    let best = ',', bestScore = 0;
    cands.forEach((c, k) => {
      const tally = new Map();
      for (const n of per[k]) if (n) tally.set(n, (tally.get(n) || 0) + 1);
      let score = 0;
      for (const v of tally.values()) score = Math.max(score, v);
      if (score > bestScore) { best = c; bestScore = score; }
    });
    return best;
  }

  function delimiterFor(path, text) {
    if (/\.(tsv|tab)$/i.test(path)) return '\t';
    if (/\.psv$/i.test(path)) return '|';
    return sniff(text);
  }

  // RFC 4180, forgiving: a quote in the middle of an unquoted field is kept
  // as a character; an unclosed quote takes the rest of the text.
  function parseRows(text, d, max = MAX_ROWS) {
    const rows = [];
    let row = [], field = '', i = 0, quoted = false, unclosed = false, cut = false;
    const n = text.length;
    if (text.charCodeAt(0) === 0xfeff) i = 1;
    while (i < n) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        const next = text.indexOf('"', i);
        if (next < 0) { field += text.slice(i); i = n; unclosed = true; break; }
        field += text.slice(i, next); i = next; continue;
      }
      if (ch === '"' && field === '') { quoted = true; i++; continue; }
      if (ch === d) { row.push(field); field = ''; i++; continue; }
      if (ch !== '\n' && ch !== '\r') {
        // A run of plain characters at once, not one at a time.
        let j = i + 1;
        while (j < n) { const c = text[j]; if (c === d || c === '\n' || c === '\r') break; j++; }
        field += text.slice(i, j); i = j; continue;
      }
      // The end of a record. A blank line is not a row (as pandas and R read it).
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      if (rows.length >= max) { cut = /\S/.test(text.slice(i)); break; }
    }
    if (!cut && (field !== '' || row.length)) { row.push(field); rows.push(row); }
    return { rows, unclosed, cut };
  }

  // Numbers as written: 1,234.5 — or, in a semicolon file (a European
  // spreadsheet's), 1.234,5.
  const NUM = /^\s*[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?\s*%?\s*$/;
  const NUM_COMMA = /^\s*[-+]?(?:\d{1,3}(?:\.\d{3})+|\d+)?(?:,\d+)?(?:[eE][-+]?\d+)?\s*%?\s*$/;
  const numStyle = d => d === ';' ? { re: NUM_COMMA, of: s => Number(String(s).replace(/[.%\s]/g, '').replace(',', '.')) } : { re: NUM, of: s => Number(String(s).replace(/[,%\s]/g, '')) };

  // The parsed table: header (detected), columns (name, numeric), body rows.
  function parse(text, path = '') {
    text = String(text ?? '');
    const d = delimiterFor(path, text);
    const { rows, unclosed, cut } = parseRows(text, d);
    const num = numStyle(d), isNum = v => v !== '' && /\d/.test(v) && num.re.test(v);
    const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
    // A column is a number column when most of its filled cells are numbers.
    const sample = rows.slice(1, 2001);
    const numeric = Array.from({ length: width }, (_, k) => {
      let filled = 0, nums = 0;
      for (const r of sample) { const v = (r[k] ?? '').trim(); if (v) { filled++; if (isNum(v)) nums++; } }
      return filled > 0 && nums / filled >= 0.9;
    });
    // The first row is a header unless it looks like data: a number where
    // the column holds numbers. (Every table here has one row of names or
    // none; a file of only numbers has none.)
    const first = rows[0] || [];
    const header = rows.length > 1 && !first.some((v, k) => numeric[k] && isNum(v.trim()));
    const letters = k => { let s = ''; k++; while (k) { k--; s = String.fromCharCode(65 + (k % 26)) + s; k = Math.floor(k / 26); } return s; };
    // A column is as wide as most of its values (and its name, to a point),
    // so a code or a category stays on one line and prose wraps at a
    // reading width, rather than every column squeezed alike.
    const widths = Array.from({ length: width }, (_, k) => {
      const lens = sample.map(r => (r[k] ?? '').trim().length).filter(Boolean).sort((a, b) => a - b);
      const typical = lens.length ? lens[Math.min(lens.length - 1, Math.floor(lens.length * 0.9))] : 0;
      const name = header ? Math.min(18, (first[k] ?? '').trim().length) : 2;
      return Math.max(3, Math.min(34, Math.max(typical, name)));
    });
    const columns = Array.from({ length: width }, (_, k) => ({ name: header ? (first[k] ?? '').trim() : '', label: letters(k), numeric: numeric[k], width: widths[k] }));
    const body = header ? rows.slice(1) : rows;
    const ragged = body.reduce((n, r) => n + (r.length !== width ? 1 : 0), 0);
    return { delimiter: d, header, columns, rows: body, ragged, unclosed, cut, numOf: num.of };
  }

  // ---- the table on screen ----
  const collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }) : null;

  // The rows in view: filtered, then sorted (stable), as indexes into t.rows.
  function order(t, st) {
    let idx = t.rows.map((_, i) => i);
    const q = (st.filter || '').trim().toLowerCase();
    if (q) idx = idx.filter(i => t.rows[i].some(v => v.toLowerCase().includes(q)));
    if (st.sort != null && st.sort < t.columns.length) {
      const k = st.sort, dir = st.desc ? -1 : 1, num = t.columns[k].numeric;
      idx.sort((a, b) => {
        const x = (t.rows[a][k] ?? '').trim(), y = (t.rows[b][k] ?? '').trim();
        if (!x || !y) return x ? -1 : y ? 1 : a - b; // empty cells last, either way
        let c = num ? t.numOf(x) - t.numOf(y) : collator ? collator.compare(x, y) : x < y ? -1 : x > y ? 1 : 0;
        if (Number.isNaN(c)) c = 0;
        return c * dir || a - b;
      });
    }
    return idx;
  }

  // How many rows match (a filter), not how many are drawn yet: the button
  // at the end says that.
  function summary(t, total) {
    const n = x => x.toLocaleString();
    const rows = t.rows.length === 1 ? '1 row' : n(t.rows.length) + ' rows';
    const parts = [total !== t.rows.length ? `${n(total)} of ${rows}` : rows, `${n(t.columns.length)} ${t.columns.length === 1 ? 'column' : 'columns'}`];
    if (t.delimiter !== ',') parts.push(NAMES[t.delimiter] + '-separated');
    if (!t.header) parts.push('no header row');
    return parts.join(' · ');
  }
  function warnings(t) {
    const w = [];
    if (t.cut) w.push(`only the first ${MAX_ROWS.toLocaleString()} rows are read here: open the text for the rest`);
    if (t.unclosed) w.push('a quote is never closed: the last cell holds the rest of the file');
    if (t.ragged) w.push(`${t.ragged.toLocaleString()} ${t.ragged === 1 ? 'row has' : 'rows have'} a different number of cells`);
    return w;
  }

  function headHtml(t, st) {
    const ths = t.columns.map((c, k) => {
      const sorted = st.sort === k ? (st.desc ? 'descending' : 'ascending') : 'none';
      const arrow = sorted === 'ascending' ? '▲' : sorted === 'descending' ? '▼' : '';
      const name = c.name || (t.header ? '' : c.label);
      return `<th scope="col" aria-sort="${sorted}"${c.numeric ? ' class="tv-num"' : ''} style="--w:${c.width}ch"><button type="button" data-tv-sort="${k}" title="Sort by ${e(name || 'column ' + c.label)}${sorted === 'ascending' ? ' (descending next)' : sorted === 'descending' ? ' (back to the file’s order next)' : ''}"><span class="tv-hname">${name ? e(name) : '<i>(no name)</i>'}</span><span class="tv-arrow" aria-hidden="true">${arrow}</span></button></th>`;
    }).join('');
    return `<thead><tr><th scope="col" class="tv-rn" aria-label="Row"><span>#</span></th>${ths}</tr></thead>`;
  }
  function rowHtml(t, i, open, q) {
    const r = t.rows[i];
    let out = `<tr data-tv-row="${i}"${open ? ' class="tv-open"' : ''}><th scope="row" class="tv-rn">${(t.header ? i + 2 : i + 1).toLocaleString()}</th>`;
    for (let k = 0; k < t.columns.length; k++) {
      const v = r[k] ?? '';
      const cls = (t.columns[k].numeric ? 'tv-num' : '') + (v === '' ? ' tv-empty' : '');
      out += `<td${cls.trim() ? ` class="${cls.trim()}"` : ''}><div class="tv-cell">${mark(v, q)}</div></td>`;
    }
    // Cells past the header's: the row says so rather than hiding them.
    if (r.length > t.columns.length) out += `<td class="tv-extra"><div class="tv-cell">${e(r.slice(t.columns.length).join(t.delimiter))}</div></td>`;
    return out + '</tr>';
  }
  function mark(v, q) {
    if (!q) return e(v);
    const lo = v.toLowerCase();
    let out = '', at = 0;
    for (let i = lo.indexOf(q); i >= 0; i = lo.indexOf(q, i + q.length)) { out += e(v.slice(at, i)) + '<mark>' + e(v.slice(i, i + q.length)) + '</mark>'; at = i + q.length; }
    return out + e(v.slice(at));
  }

  /**
   * Draw `text` as a table in `host`. `state` (an object the caller keeps)
   * holds what the reader chose (sort, filter, open rows, how many rows,
   * full cells), so drawing again (a new version of the file, the card
   * drawn again) keeps it. compact: the conversation's card (a shorter
   * scroll box, fewer rows at a time). Returns { update(text), focusFilter(), dispose() }.
   */
  function mount(host, text, { path = '', state = {}, compact = false } = {}) {
    const st = state;
    st.open = st.open instanceof Set ? st.open : new Set();
    const page = compact ? PAGE_COMPACT : PAGE;
    let t = parse(text, path), idx = [], io = null, timer = 0, scrollKeep = null;
    host.classList.add('tv-host');
    host.innerHTML = `<div class="tv-bar"><span class="tv-sum" role="status"></span><span class="tv-warn"></span>
      <span class="tv-tools"><input type="search" class="tv-filter" placeholder="filter rows" aria-label="Filter rows: show only rows containing this text" spellcheck="false">
      <button type="button" class="tv-full" aria-pressed="${!!st.full}" title="Show every cell's whole text (or click a row to open just that one)">whole cells</button></span></div>
      <div class="tv-scroll" tabindex="0" role="region" aria-label="Table: arrows move between rows, Enter opens a row's whole text"><table class="tv"></table></div>`;
    const bar = host.querySelector('.tv-bar'), scroll = host.querySelector('.tv-scroll'), table = host.querySelector('.tv');
    const filter = host.querySelector('.tv-filter'), full = host.querySelector('.tv-full');
    filter.value = st.filter || '';
    if (compact) host.classList.add('tv-compact');

    function draw() {
      if (!t.columns.length) { bar.querySelector('.tv-sum').textContent = 'No data: the file is empty.'; table.innerHTML = ''; return; }
      idx = order(t, st);
      const shown = Math.min(idx.length, Math.max(page, st.shown || 0));
      const q = (st.filter || '').trim().toLowerCase();
      let body = '';
      for (let j = 0; j < shown; j++) body += rowHtml(t, idx[j], st.open.has(idx[j]), q);
      const more = idx.length - shown;
      const cols = t.columns.length + 1 + (t.ragged ? 1 : 0);
      const tail = more > 0 ? `<tr class="tv-more-row"><td colspan="${cols}"><button type="button" class="tv-more">show ${Math.min(more, page).toLocaleString()} more of ${more.toLocaleString()} rows</button></td></tr>` : '';
      const empty = !idx.length ? `<tr class="tv-none"><td colspan="${cols}">No row contains “${e(st.filter.trim())}”.</td></tr>` : '';
      table.innerHTML = headHtml(t, st) + `<tbody>${body}${tail}${empty}</tbody>`;
      table.classList.toggle('tv-whole', !!st.full);
      bar.querySelector('.tv-sum').textContent = summary(t, idx.length);
      const w = warnings(t);
      bar.querySelector('.tv-warn').textContent = w.length ? '· ' + w.join(' · ') : '';
      // The file view loads the next rows as the reader reaches the end.
      if (io) { io.disconnect(); const btn = table.querySelector('.tv-more'); if (btn) io.observe(btn); }
      paintActive();
    }
    function more() { st.shown = Math.max(page, st.shown || 0) + page; const top = scroll.scrollTop; draw(); scroll.scrollTop = top; }
    if (!compact && typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver(entries => { if (entries.some(x => x.isIntersecting)) more(); }, { root: scroll, rootMargin: '400px' });
    }

    // One row is "active" for the keyboard (a roving highlight, not a
    // tab stop per row): arrows move it, Enter opens it.
    function rows() { return table.querySelectorAll('tbody tr[data-tv-row]'); }
    function paintActive() {
      const list = rows();
      for (const r of table.querySelectorAll('tr.tv-active')) r.classList.remove('tv-active');
      if (st.active == null || !scroll.matches(':focus-visible, :focus')) return;
      const r = list[Math.min(st.active, list.length - 1)];
      if (r) { r.classList.add('tv-active'); r.scrollIntoView({ block: 'nearest' }); }
    }
    function toggleRow(tr) {
      const i = Number(tr.dataset.tvRow);
      if (st.open.has(i)) st.open.delete(i); else st.open.add(i);
      tr.classList.toggle('tv-open', st.open.has(i));
    }

    host.addEventListener('click', ev => {
      const sort = ev.target.closest('[data-tv-sort]');
      if (sort) {
        ev.stopPropagation();
        const k = Number(sort.dataset.tvSort);
        if (st.sort !== k) { st.sort = k; st.desc = false; } else if (!st.desc) st.desc = true; else { st.sort = null; st.desc = false; }
        draw();
        return;
      }
      if (ev.target.closest('.tv-more')) { ev.stopPropagation(); more(); return; }
      if (ev.target === full) { ev.stopPropagation(); st.full = !st.full; full.setAttribute('aria-pressed', String(st.full)); table.classList.toggle('tv-whole', st.full); return; }
      const tr = ev.target.closest('tr[data-tv-row]');
      // A click that ended a text selection selects; it does not open.
      if (tr && !(window.getSelection && String(window.getSelection()).length)) {
        ev.stopPropagation();
        st.active = [...rows()].indexOf(tr);
        toggleRow(tr);
      }
    });
    filter.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { st.filter = filter.value; st.shown = 0; st.active = null; draw(); scroll.scrollTop = 0; }, 120);
    });
    filter.addEventListener('keydown', ev => {
      if (ev.key === 'Escape' && filter.value) { ev.preventDefault(); ev.stopPropagation(); filter.value = ''; filter.dispatchEvent(new Event('input')); }
      else if (ev.key === 'ArrowDown' || ev.key === 'Enter') { ev.preventDefault(); st.active = 0; scroll.focus(); paintActive(); }
    });
    scroll.addEventListener('keydown', ev => {
      if (ev.altKey || ev.ctrlKey || ev.metaKey) return;
      const list = rows();
      if (!list.length) return;
      const at = st.active ?? -1;
      const go = n => { ev.preventDefault(); ev.stopPropagation(); st.active = Math.max(0, Math.min(list.length - 1, n)); paintActive(); };
      if (ev.key === 'ArrowDown' || ev.key === 'j') go(at + 1);
      else if (ev.key === 'ArrowUp' || ev.key === 'k') go(at - 1);
      else if (ev.key === 'Home') go(0);
      else if (ev.key === 'End') go(list.length - 1);
      else if ((ev.key === 'Enter' || ev.key === ' ') && at >= 0 && list[at]) { ev.preventDefault(); ev.stopPropagation(); toggleRow(list[at]); }
      // The rows past the drawn ones come as the keyboard reaches them.
      if ((st.active ?? 0) >= list.length - 1 && table.querySelector('.tv-more') && (ev.key === 'ArrowDown' || ev.key === 'End')) { more(); paintActive(); }
    });
    scroll.addEventListener('focus', paintActive);
    scroll.addEventListener('blur', () => { for (const r of table.querySelectorAll('tr.tv-active')) r.classList.remove('tv-active'); });

    draw();
    if (st.scroll) { scroll.scrollTop = st.scroll.top; scroll.scrollLeft = st.scroll.left; }
    const keep = () => { st.scroll = { top: scroll.scrollTop, left: scroll.scrollLeft }; };
    scroll.addEventListener('scroll', () => { cancelAnimationFrame(scrollKeep); scrollKeep = requestAnimationFrame(keep); }, { passive: true });

    return {
      // A new version of the text: the reader's choices and place stay.
      update(next) {
        const top = scroll.scrollTop, left = scroll.scrollLeft;
        t = parse(next, path);
        draw();
        scroll.scrollTop = top; scroll.scrollLeft = left;
      },
      focusFilter() { filter.focus(); filter.select(); },
      dispose() { clearTimeout(timer); cancelAnimationFrame(scrollKeep); if (io) io.disconnect(); },
    };
  }

  const api = { isTablePath, parse, parseRows, sniff, mount };
  if (typeof window !== 'undefined') window.TableView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
