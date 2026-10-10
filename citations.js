// citations.js — numbered citations in an answer become paper cards
// (design/97-citations.md).
//
// The format agents are asked to write (global AGENTS.md, scholars-search
// skill), and the older ones this also reads:
//
//   Semaglutide gave about 15% weight loss [38], tirzepatide 20% [40][41].
//
//   ## References
//   - [38] https://doi.org/10.1056/nejmoa2032183 — Wilding 2021, NEJM
//   - [40] https://doi.org/10.1056/nejmoa2206038
//
// A line that starts with [n] (or [^n], [n]:, in a list or not) and holds a
// DOI, an OpenAlex W-number or a PMCID defines n; several definitions may
// share a line ("[1] 10.x [2] 10.y"), one may hold several papers
// ("[15] 10.a, 10.b"). Once a message defines numbers, its [n], [n][m],
// [n, m] and [n–m] markers outside code become buttons; markers for numbers
// it does not define stay text, so "[0]" in prose is never touched.
//
// Two halves:
//   - scan(): pure, used by mdRender (app.html) while it builds the HTML,
//     and by the tests in node.
//   - the page part: one shared card opened from a button (hover with a
//     mouse, tap or Enter otherwise), the reference list filled with the
//     real records, and a warning on any number whose paper does not exist
//     or was retracted. Records come from GET /api/papers (papers.js).
(function (root) {
  'use strict';

  const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Every identifier form a reference may carry. Group 1: DOI; 2: OpenAlex
  // URL's W-number; 3: bare W-number; 4: PMCID.
  const ID_RE = /(?:https?:\/\/(?:dx\.)?doi\.org\/|\bdoi:\s*)?\b(10\.\d{4,9}\/[^\s<>"'`]+)|https?:\/\/(?:www\.)?openalex\.org\/(?:works\/)?(W\d+)|\b(W\d{6,})\b|\b(PMC\d{5,})\b/gi;
  // A DOI may hold brackets ("S0140-6736(20)30183-5"); a closing one with no
  // opening partner, and sentence punctuation, belong to the text around it.
  function trimId(id) {
    for (;;) {
      const last = id[id.length - 1];
      if (/[.,;:!?*_~'"]/.test(last)) { id = id.slice(0, -1); continue; }
      if ((last === ')' || last === ']') && id.split(last === ')' ? '(' : '[').length < id.split(last).length) { id = id.slice(0, -1); continue; }
      return id;
    }
  }
  function findIds(text) {
    const ids = [];
    let m;
    ID_RE.lastIndex = 0;
    while ((m = ID_RE.exec(text))) {
      const id = m[1] ? trimId(m[1]) : (m[2] || m[3] || m[4]);
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }
  const LIST_MARK = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?/;
  const DEF_HEAD = /^\[\^?\d{1,3}\]:?(?=\s|$)/;
  const DEF_SPLIT = /(?:^|\s)\[\^?(\d{1,3})\]:?(?=\s|$)/g;

  // One raw line → its definitions, or null when it is not a reference line.
  function parseDefLine(line) {
    const body = String(line).replace(LIST_MARK, '');
    if (!DEF_HEAD.test(body)) return null;
    const marks = [];
    let m;
    DEF_SPLIT.lastIndex = 0;
    while ((m = DEF_SPLIT.exec(body))) marks.push({ n: Number(m[1]), at: m.index, end: m.index + m[0].length });
    const defs = marks.map((k, i) => {
      const text = body.slice(k.end, i + 1 < marks.length ? marks[i + 1].at : body.length).trim();
      const ids = findIds(text);
      // What the agent wrote besides the identifiers: a short label, kept
      // for when the record cannot be had.
      let label = text;
      for (const id of ids) label = label.split(id).join('');
      label = label
        .replace(/\[([^\]]*)\]\(\s*(?:https?:\/\/\S*?)?\s*\)/g, '$1') // [Wilding 2021](https://doi.org/) → its words
        .replace(/https?:\/\/(?:dx\.)?doi\.org\/|https?:\/\/(?:www\.)?openalex\.org\/(?:works\/)?|https?:\/\/www\.ncbi\.nlm\.nih\.gov\/pmc\/articles\/\/?|\bdoi:/gi, '')
        .replace(/<\s*>|\(\s*\)/g, '')
        .replace(/\s+/g, ' ').replace(/^[\s\-–—:,;|·.]+|[\s\-–—:,;|·]+$/g, '').trim();
      return { n: k.n, ids, label };
    });
    return defs.some(d => d.ids.length) ? defs : null;
  }

  // Marker runs in already-escaped HTML text: [3], [3][4], [3, 4], [3–5].
  const BR = String.raw`\[\^?\d{1,3}(?:\s*[,–—-]\s*\^?\d{1,3})*\]`;
  // The word before a run and the punctuation after it are captured: with
  // the run they make one unbreakable piece, so a number never starts or
  // ends a line on its own (a browser breaks around a button otherwise).
  const RUN_RE = new RegExp(`([^\\s\\[]+)?( ?)(${BR}(?:\\s?${BR})*)([.,;:!?)]*)`, 'g');
  // Segments of HTML that must stay as they are: tags, and the whole of a
  // code span, link or button.
  const SKIP_RE = /(<code[\s>][\s\S]*?<\/code>|<a[\s>][\s\S]*?<\/a>|<button[\s>][\s\S]*?<\/button>|<[^>]+>)/;

  function numbersOf(bracket) {
    const out = [];
    for (const part of bracket.replace(/[[\]^]/g, '').split(',')) {
      const r = part.split(/\s*[–—-]\s*/).map(x => Number(x.trim()));
      if (r.length === 1) out.push(r[0]);
      else if (r.length === 2 && r[1] >= r[0] && r[1] - r[0] <= 20) for (let i = r[0]; i <= r[1]; i++) out.push(i);
      else return null;
    }
    return out;
  }
  const label = ns => {
    // "3", "3–5", "3, 7"
    const parts = [];
    for (let i = 0; i < ns.length; i++) {
      let j = i;
      while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
      parts.push(j - i >= 2 ? `${ns[i]}–${ns[j]}` : j > i ? `${ns[i]}, ${ns[j]}` : String(ns[i]));
      i = j;
    }
    return parts.join(', ');
  };

  // texts: the message's text parts outside code fences. Returns null when
  // the message defines no reference, else what mdRender needs.
  function scan(texts) {
    const defs = new Map();
    for (const t of texts) for (const line of String(t).split('\n')) {
      const d = parseDefLine(line);
      if (d) for (const x of d) if (!defs.has(x.n) || (!defs.get(x.n).ids.length && x.ids.length)) defs.set(x.n, x);
    }
    if (!defs.size) return null;
    const known = n => defs.has(n) && defs.get(n).ids.length > 0;

    function chip(ns) {
      const ids = [...new Set(ns.flatMap(n => defs.get(n).ids))];
      const map = ns.map(n => [n, defs.get(n).ids]);
      return `<button type="button" class="cite" data-cite="${escHtml(JSON.stringify(map))}" data-cite-ids="${escHtml(ids.join(' '))}" aria-haspopup="dialog" aria-label="Reference${ns.length > 1 ? 's' : ''} ${label(ns)}">${label(ns)}</button>`;
    }
    // Escaped HTML in, the same HTML out with marker runs made buttons.
    function chips(html) {
      return String(html).split(SKIP_RE).map((seg, i) => {
        if (i % 2 === 1) return seg;
        return seg.replace(RUN_RE, (whole, word = '', space, run, punct) => {
          const brackets = run.match(new RegExp(BR, 'g'));
          const ns = [];
          for (const b of brackets) {
            const got = numbersOf(b);
            if (!got || !got.every(known)) return whole;
            for (const n of got) if (!ns.includes(n)) ns.push(n);
          }
          const piece = word + (space ? '&nbsp;' : '') + chip(ns) + punct;
          return word || punct ? `<span class="cite-nb">${piece}</span>` : piece;
        });
      }).join('');
    }
    // The reference list: one <li> per definition, the raw label kept as
    // what shows until (or unless) the record arrives.
    function refItem(d, inline) {
      const idLinks = d.ids.map(id => `<a class="cite-ref-id" href="${escHtml(urlOf(id))}" target="_blank" rel="noopener">${escHtml(id)}</a>`).join(' ');
      return `<li class="cite-ref" data-cite-n="${d.n}" data-cite-ids="${escHtml(d.ids.join(' '))}">` +
        `<span class="cite-ref-n">${d.n}</span><div class="cite-ref-body">` +
        (d.label ? `<div class="cite-ref-label">${inline(d.label)}</div>` : '') +
        (idLinks ? `<div class="cite-ref-ids">${idLinks}</div>` : '') +
        `</div></li>`;
    }
    return { defs, chips, parseLine: parseDefLine, refItem };
  }

  function urlOf(id) {
    if (/^10\./.test(id)) return 'https://doi.org/' + id;
    if (/^W\d+$/i.test(id)) return 'https://openalex.org/' + id.toUpperCase();
    if (/^PMC\d+$/i.test(id)) return 'https://www.ncbi.nlm.nih.gov/pmc/articles/' + id.toUpperCase() + '/';
    return '#';
  }
  // The identifier a plain link points at, for a card on DOI links too.
  function idOfUrl(url) {
    const m = String(url).match(/^https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/\S+)$|^https?:\/\/(?:www\.)?openalex\.org\/(?:works\/)?(W\d+)$/i);
    if (!m) return '';
    try { return m[1] ? decodeURIComponent(m[1]) : m[2]; } catch { return m[1] || m[2]; }
  }

  const api = { scan, findIds, parseDefLine, urlOf, idOfUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Citations = api;
  if (typeof document === 'undefined') return;

  // ---------------------------------------------------------------- page --

  const store = new Map(); // id -> record (papers.js shape)
  let wanted = new Set();
  let wantTimer = null;
  let waiters = [];

  async function fetchBatch(ids) {
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      let papers = {};
      try {
        const res = await fetch('/api/papers?ids=' + encodeURIComponent(part.join(',')));
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
        papers = data.papers || {};
      } catch (e) {
        for (const id of part) papers[id] = { status: 'error', error: e.message, url: urlOf(id) };
      }
      for (const id of part) store.set(id, papers[id] || { status: 'error', error: 'no answer', url: urlOf(id) });
    }
  }
  // Ask for ids soon, in one request with whatever else asks this tick.
  // again: a failed lookup is asked again (a card opened by the person).
  function need(ids, again = false) {
    const missing = ids.filter(id => !store.has(id) || again && store.get(id).status === 'error');
    if (!missing.length) return Promise.resolve();
    for (const id of missing) wanted.add(id);
    return new Promise(resolve => {
      waiters.push(resolve);
      if (wantTimer) return;
      wantTimer = setTimeout(async () => {
        const batch = [...wanted], done = waiters;
        wanted = new Set(); waiters = []; wantTimer = null;
        await fetchBatch(batch);
        done.forEach(f => f());
        refreshAll();
      }, 30);
    });
  }

  // ---- what a record says ----
  const TYPE_LABEL = { review: 'Review', preprint: 'Preprint', 'book-chapter': 'Book chapter', book: 'Book', 'conference-paper': 'Conference paper', dissertation: 'Thesis', letter: 'Letter', editorial: 'Editorial', report: 'Report', dataset: 'Dataset' };
  // Problems a reader must see without opening anything.
  function problemOf(rec) {
    if (!rec) return null;
    if (rec.retracted) return 'retracted';
    if (rec.status === 'missing' && rec.doi) return 'no-doi';
    return null;
  }
  function authorsLine(rec) {
    const a = rec.authors || [];
    if (!a.length) return '';
    const n = rec.authorsCount || a.length;
    if (n <= 4 && a.length >= n) return a.join(', ');
    return `${a.slice(0, 3).join(', ')} et al. (${n} authors)`;
  }
  function shortCite(rec) {
    const a = (rec.authors || [])[0];
    const family = a ? a.split(/\s+/).pop() : '';
    return [family && (rec.authorsCount > 1 ? family + ' et al.' : family), rec.year].filter(Boolean).join(', ');
  }
  const fmtInt = n => Number(n).toLocaleString();
  function badges(rec) {
    const out = [];
    if (rec.retracted) out.push('<span class="cite-badge danger">Retracted</span>');
    if (rec.type && TYPE_LABEL[rec.type]) out.push(`<span class="cite-badge${rec.type === 'review' ? ' strong' : ''}">${TYPE_LABEL[rec.type]}</span>`);
    return out.join('');
  }
  function linksRow(rec, id) {
    const links = [];
    const doi = rec.doi || (/^10\./.test(id) ? id : null);
    if (doi) links.push(`<a href="https://doi.org/${escHtml(doi)}" target="_blank" rel="noopener">Publisher page</a>`);
    if (rec.pdfUrl) links.push(`<a href="${escHtml(rec.pdfUrl)}" target="_blank" rel="noopener">PDF</a>`);
    if (rec.smr && (rec.doi || rec.pmcid)) links.push(`<a href="https://sciencemadereadable.com/?paper=${encodeURIComponent(rec.doi || rec.pmcid)}" target="_blank" rel="noopener">Read it simplified</a>`);
    if (rec.openalex) links.push(`<a href="${escHtml(rec.openalex)}" target="_blank" rel="noopener">OpenAlex</a>`);
    return links.length ? `<div class="cite-links">${links.join('')}</div>` : '';
  }
  // Problems and partial records, in words.
  function noticeOf(rec, id) {
    if (!rec || rec.status === 'loading') return '<p class="cite-note">Looking this paper up…</p>';
    if (rec.status === 'error') return `<p class="cite-note warn">Could not check this reference just now (${escHtml(rec.error || 'no answer')}). <button type="button" class="cite-retry">Try again</button></p>`;
    if (rec.status === 'invalid') return `<p class="cite-note warn">“${escHtml(id)}” is not a DOI, OpenAlex id or PMCID.</p>`;
    if (rec.status === 'missing' && rec.doi) return '<p class="cite-note danger"><b>This DOI does not exist.</b> The reference is probably wrong: the official DOI registry has no record of it.</p>';
    if (rec.status === 'missing') return '<p class="cite-note warn">Not in the paper database. The reference may be wrong.</p>';
    if (rec.status === 'registered') return `<p class="cite-note">The DOI is real, but no details about it could be found${rec.incomplete ? ' right now' : ''}. Open it to see the paper.</p>`;
    return '';
  }

  // One paper, as the card shows it. full: abstract and every link.
  function paperHtml(n, id, rec, agentLabel, full) {
    const found = rec && rec.status === 'found';
    const title = found && rec.title ? rec.title : (agentLabel || id);
    const href = (rec && rec.url) || urlOf(id);
    const meta = found ? [rec.year, rec.venue, Number.isFinite(rec.citations) ? `cited ${fmtInt(rec.citations)} times` : '', rec.oa ? 'free to read' : '']
      .filter(Boolean).map(escHtml).join(' · ') : '';
    let abs = '';
    if (full && found && rec.abstract) {
      const short = rec.abstract.length > 420;
      abs = `<div class="cite-abstract${short ? ' clipped' : ''}">${escHtml(rec.abstract)}</div>` +
        (short ? '<button type="button" class="cite-more" aria-expanded="false">Show the whole summary</button>' : '');
    }
    return `<article class="cite-paper${problemOf(rec) ? ' problem' : ''}" data-id="${escHtml(id)}">` +
      `<div class="cite-head"><span class="cite-num">${n}</span>${found ? badges(rec) : ''}</div>` +
      `<a class="cite-title" href="${escHtml(href)}" target="_blank" rel="noopener">${escHtml(title)}</a>` +
      (found && authorsLine(rec) ? `<div class="cite-authors">${escHtml(authorsLine(rec))}</div>` : '') +
      (meta ? `<div class="cite-meta">${meta}</div>` : '') +
      noticeOf(rec, id) + abs +
      (full && rec && rec.status !== 'missing' ? linksRow(rec, id) : '') +
      (full && found && rec.source === 'crossref' ? '<p class="cite-src">Details from Crossref: this paper is not in the paper database.</p>' : '') +
      `</article>`;
  }

  // ---- the reference list ----
  function fillRef(li) {
    const ids = (li.dataset.citeIds || '').split(' ').filter(Boolean);
    if (!ids.length) return;
    const recs = ids.map(id => store.get(id));
    if (recs.some(r => !r)) return;
    const body = li.querySelector('.cite-ref-body');
    if (!body) return;
    if (!li._agentLabel) li._agentLabel = (li.querySelector('.cite-ref-label') || {}).textContent || '';
    const rows = ids.map((id, i) => {
      const rec = recs[i];
      const found = rec.status === 'found';
      const title = found && rec.title ? rec.title : (li._agentLabel || id);
      const sub = found ? [authorsLine(rec), [rec.year, rec.venue].filter(Boolean).join(' · ')].filter(Boolean).join(' — ') : '';
      return `<div class="cite-ref-paper${problemOf(rec) ? ' problem' : ''}">` +
        `<a class="cite-ref-title" href="${escHtml(rec.url || urlOf(id))}" target="_blank" rel="noopener">${escHtml(title)}</a>` +
        (found ? badges(rec) : '') +
        (sub ? `<div class="cite-ref-sub">${escHtml(sub)}</div>` : '') +
        (found ? '' : noticeOf(rec, id).replace('<button type="button" class="cite-retry">Try again</button>', '')) +
        `</div>`;
    });
    body.innerHTML = rows.join('');
    li.classList.toggle('problem', recs.some(problemOf));
    li.dataset.citeDone = '1';
  }
  // A number whose paper has a problem says so in the text itself.
  function markChip(btn) {
    const ids = (btn.dataset.citeIds || '').split(' ').filter(Boolean);
    const recs = ids.map(id => store.get(id)).filter(Boolean);
    const bad = recs.some(problemOf);
    btn.classList.toggle('problem', bad);
    if (bad) btn.title = recs.some(r => r.retracted) ? 'A cited paper was retracted' : 'A cited DOI does not exist';
    else btn.removeAttribute('title');
  }
  function refreshAll() {
    document.querySelectorAll('.cite-ref').forEach(fillRef);
    document.querySelectorAll('.cite').forEach(markChip);
    if (pop && !pop.hidden && openFor) renderPop(openFor);
  }

  // New reference lists anywhere in the app: ask for their papers once.
  let scanT = null;
  function scanNew() {
    scanT = null;
    const ids = [];
    document.querySelectorAll('.cite-ref:not([data-cite-asked])').forEach(li => {
      li.dataset.citeAsked = '1';
      ids.push(...(li.dataset.citeIds || '').split(' ').filter(Boolean));
    });
    if (ids.length) need([...new Set(ids)]);
    // Lists drawn again from cached records need no request.
    document.querySelectorAll('.cite-ref[data-cite-asked]:not([data-cite-done])').forEach(fillRef);
    document.querySelectorAll('.cite:not(.problem)').forEach(markChip);
  }
  new MutationObserver(() => {
    if (scanT || !document.querySelector('.cite-ref:not([data-cite-done])')) return;
    scanT = setTimeout(scanNew, 60);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ---- the card ----
  let pop = null, openFor = null, pinned = false, hoverT = null, leaveT = null;
  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'cite-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Cited paper');
    pop.hidden = true;
    pop.addEventListener('pointerenter', () => clearTimeout(leaveT));
    pop.addEventListener('pointerleave', e => { if (!pinned && e.pointerType === 'mouse') leaveT = setTimeout(close, 220); });
    pop.addEventListener('click', e => {
      const more = e.target.closest('.cite-more');
      if (more) {
        const abs = more.previousElementSibling;
        const open = abs.classList.toggle('clipped') === false;
        more.textContent = open ? 'Show less' : 'Show the whole summary';
        more.setAttribute('aria-expanded', String(open));
        return;
      }
      if (e.target.closest('.cite-close')) { const back = openFor; close(); back?.focus?.(); return; }
      if (e.target.closest('.cite-retry')) {
        const ids = (openFor?.dataset.citeIds || '').split(' ').filter(Boolean);
        ids.forEach(id => { if (store.get(id)?.status === 'error') store.delete(id); });
        renderPop(openFor);
        need(ids, true);
        return;
      }
      const go = e.target.closest('.cite-goto');
      if (go && openFor) {
        const li = openFor.closest('.md')?.querySelector(`.cite-ref[data-cite-n="${go.dataset.n}"]`);
        close();
        if (li) { li.scrollIntoView({ block: 'center' }); li.classList.add('flash'); setTimeout(() => li.classList.remove('flash'), 1600); }
      }
    });
    document.body.appendChild(pop);
    return pop;
  }
  function citeMap(el) {
    if (el.classList.contains('cite')) { try { return JSON.parse(el.dataset.cite); } catch { return []; } }
    return [[null, (el.dataset.citeIds || '').split(' ').filter(Boolean)]];
  }
  function renderPop(el) {
    const map = citeMap(el);
    const md = el.closest('.md');
    const many = map.reduce((k, [, ids]) => k + ids.length, 0) > 1;
    const parts = [];
    for (const [n, ids] of map) for (const id of ids) {
      const li = n != null && md ? md.querySelector(`.cite-ref[data-cite-n="${n}"]`) : null;
      parts.push(paperHtml(n ?? '↗', id, store.get(id), li?._agentLabel || '', !many));
    }
    const goto = map.length === 1 && map[0][0] != null && md?.querySelector(`.cite-ref[data-cite-n="${map[0][0]}"]`)
      ? `<button type="button" class="cite-goto" data-n="${map[0][0]}">Go to reference ${map[0][0]} in the list</button>` : '';
    pop.innerHTML = `<div class="cite-pop-in${many ? ' many' : ''}"><button type="button" class="cite-close" aria-label="Close">×</button>${parts.join('')}${goto}</div>`;
    place(el);
  }
  const SHEET_BELOW = 600;
  function place(el) {
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    pop.classList.toggle('sheet', vw < SHEET_BELOW);
    if (vw < SHEET_BELOW) return;
    const w = Math.min(440, vw - 16);
    pop.style.width = w + 'px';
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, vw - w - 8));
    pop.style.left = left + 'px';
    pop.style.maxHeight = '';
    const h = pop.offsetHeight;
    const below = vh - r.bottom - 8, above = r.top - 8;
    if (h <= below || below >= above) { pop.style.top = (r.bottom + 6) + 'px'; pop.style.maxHeight = (below - 6) + 'px'; }
    else { const mh = Math.min(h, above - 6); pop.style.top = (r.top - 6 - mh) + 'px'; pop.style.maxHeight = mh + 'px'; }
  }
  function open(el, pin) {
    ensurePop();
    clearTimeout(leaveT);
    if (openFor && openFor !== el) openFor.setAttribute('aria-expanded', 'false');
    openFor = el;
    pinned = !!pin;
    el.setAttribute('aria-expanded', 'true');
    pop.hidden = false;
    renderPop(el);
    need(citeMap(el).flatMap(([, ids]) => ids), true);
  }
  function close() {
    clearTimeout(hoverT); clearTimeout(leaveT);
    if (!pop || pop.hidden) return;
    pop.hidden = true;
    if (openFor) openFor.setAttribute('aria-expanded', 'false');
    openFor = null; pinned = false;
  }
  const target = e => e.target instanceof Element ? e.target.closest('.cite, a.paper-link') : null;

  // A mouse previews on hover; a click (or tap, or Enter) pins the card.
  document.addEventListener('pointerover', e => {
    if (e.pointerType !== 'mouse') return;
    const el = target(e);
    if (!el) return;
    clearTimeout(leaveT);
    if (openFor === el) return;
    clearTimeout(hoverT);
    hoverT = setTimeout(() => { if (!pinned || openFor !== el) open(el, false); }, 140);
  });
  document.addEventListener('pointerout', e => {
    if (e.pointerType !== 'mouse') return;
    const el = target(e);
    if (!el || (e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) return;
    clearTimeout(hoverT);
    if (openFor === el && !pinned) leaveT = setTimeout(close, 220);
  });
  document.addEventListener('click', e => {
    const el = e.target instanceof Element ? e.target.closest('.cite') : null;
    if (el) {
      e.preventDefault(); e.stopPropagation();
      if (openFor === el && pinned) close(); else open(el, true);
      return;
    }
    if (pop && !pop.hidden && !(e.target instanceof Node && pop.contains(e.target)) && !target(e)) close();
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !pop || pop.hidden) return;
    const back = openFor;
    close();
    if (back && back.classList.contains('cite')) back.focus();
    e.stopPropagation();
  }, true);
  // The card follows its number while the transcript scrolls; it closes
  // once the number has left the screen.
  let placeRaf = 0;
  const follow = () => {
    if (!pop || pop.hidden || !openFor || placeRaf) return;
    placeRaf = requestAnimationFrame(() => {
      placeRaf = 0;
      if (!openFor || !openFor.isConnected) return close();
      if (pop.classList.contains('sheet')) return;
      const r = openFor.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return close();
      place(openFor);
    });
  };
  window.addEventListener('scroll', follow, true);
  window.addEventListener('resize', follow);
})(typeof window !== 'undefined' ? window : globalThis);
