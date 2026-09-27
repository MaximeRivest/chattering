/* programs-ui.js — AI programs (design/74).

   The job: show me what my AI program actually does, and let me tell it when
   it is wrong, in seconds. So a program's page is its examples — what went in,
   what came out — with the program's promise above them (its instruction and
   its arrow signature) and one plain sentence of how it is doing. Judging is
   one key; a wrong answer asks one question ("what should it have said?").
   How often it is right comes from one place only: checking random answers.
   Everything else (models, times, tokens, versions' hashes, files) waits in
   About.

   Loaded before the app's main script: only definitions run at load; app
   functions (setRoute, replaceRoute, open, …) are looked up when used. */
(function () {
  'use strict';
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fn = name => (typeof window[name] === 'function' ? window[name] : null);
  const call = (name, ...args) => { const f = fn(name); return f ? f(...args) : undefined; };
  const view = () => document.getElementById('view');
  async function api(url, opts) {
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText || 'request failed');
    return data;
  }
  const post = (url, body, method = 'POST') => api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const errToast = m => (fn('errToast') ? fn('errToast')(m) : console.error(m));
  const toast = m => (fn('toast') ? fn('toast')(m) : null);
  const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null && v !== false)).toString();

  // ---- words ----
  const num = n => (n == null ? '—' : Number(n).toLocaleString());
  const pct = x => (x == null ? '—' : Math.round(x * 100) + '%');
  const secs = s => (s == null ? '—' : s < 1 ? Math.round(s * 1000) + ' ms' : s < 10 ? s.toFixed(1) + ' s' : Math.round(s) + ' s');
  const plural = (n, one, many = one + 's') => `${num(n)} ${n === 1 ? one : many}`;
  const ago = ts => {
    if (!ts) return '';
    const ms = Date.now() - Date.parse(ts);
    const m = Math.round(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const hr = Math.round(m / 60);
    if (hr < 24) return hr + ' h ago';
    const d = Math.round(hr / 24);
    return d < 30 ? d + (d === 1 ? ' day ago' : ' days ago') : new Date(ts).toLocaleDateString();
  };
  const show = v => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v, null, 2));
  const inline = v => (typeof v === 'string' ? v : JSON.stringify(v));
  const LANG = { python: 'Python', typescript: 'TypeScript', javascript: 'JavaScript', r: 'R', julia: 'Julia' };
  const LOOSE = () => (typeof LOOSE_PROJECT !== 'undefined' ? LOOSE_PROJECT : '');
  const projectName = p => (p && p !== LOOSE() ? p : '');
  const sessionTitle = key => { const s = (typeof sessions !== 'undefined' ? sessions : []).find(x => x.key === key); return (s && (s.title || s.timelineTitle)) || 'a conversation'; };
  const base = p => String(p || '').split(/[\\/]/).pop();

  // The arrow signature, as the program promises it: inputs → its answers.
  function signatureHtml(p, { big = false } = {}) {
    const ins = (p.inputs || []).map(h).join(', ') || '…';
    const out = p.choices && p.choices.length && (p.outputs || []).length <= 1
      ? p.choices.map(c => `<span class="pg-choice">${h(c)}</span>`).join('<span class="pg-sep"> · </span>')
      : (p.outputs || []).map(o => (o === p.answer && (p.outputs || []).length > 1 ? `<b>${h(o)}</b>` : h(o))).join(', ') || '…';
    return `<span class="pg-sig${big ? ' big' : ''}"><span class="pg-sig-in">${ins}</span><span class="pg-arrow" aria-label="gives">→</span><span class="pg-sig-out">${out}</span></span>`;
  }
  const firstParagraph = text => String(text || '').split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();

  // ---- routes: #programs, #program={"name","module","tab","run"} ----
  function hashFor(p) {
    const o = { name: p.name, module: p.module };
    if (p.tab && p.tab !== 'examples') o.tab = p.tab;
    if (p.run) o.run = p.run;
    return 'program=' + encodeURIComponent(JSON.stringify(o));
  }
  function parseHash(hash) {
    let v = String(hash).slice('program='.length);
    if (!v.startsWith('{')) { try { v = decodeURIComponent(v); } catch {} }
    try { const o = JSON.parse(v); if (o && typeof o.name === 'string') return { name: o.name, module: String(o.module ?? ''), tab: o.tab || 'examples', run: o.run || null }; } catch {}
    return null;
  }
  function describe(hash) {
    if (hash === 'programs') return { kind: 'programs', title: 'AI programs' };
    const p = parseHash(hash);
    return { kind: 'program', title: p ? p.name : 'AI program' };
  }
  function dispatch(hash) {
    if (hash === 'programs') return showList();
    const p = parseHash(hash);
    return p ? showProgram(p.name, p.module, { tab: p.tab, run: p.run }) : showList();
  }

  // ---- every program ----
  const list = { data: null, at: 0, loading: null, query: '', error: null };
  function loadList(force = false) {
    if (list.loading) return list.loading;
    if (!force && list.data && Date.now() - list.at < 4000) return Promise.resolve(list.data);
    list.loading = api('/api/programs').then(d => { list.data = d; list.at = Date.now(); list.error = null; return d; })
      .catch(e => { list.error = e.message; throw e; }).finally(() => { list.loading = null; });
    return list.loading;
  }
  function matches(p, project, query) {
    if (project && p.project !== project) return false;
    const q = String(query || '').trim().toLowerCase();
    return !q || `${p.name} ${p.module} ${p.project || ''} ${(p.inputs || []).join(' ')} ${(p.choices || []).join(' ')} ${p.instruction || ''}`.toLowerCase().includes(q);
  }
  const needs = p => (p.ratings && p.ratings.open) || 0;
  function statusWords(p) {
    const bits = [p.recent ? `${num(p.recent)} this week` : `last used ${ago(p.last)}`];
    if (p.errors) bits.push(`<span class="pg-bad">${plural(p.errors, 'failure')}</span>`);
    if (needs(p)) bits.push(`<span class="pg-warn">${num(needs(p))} waiting for the right answer</span>`);
    return bits.join(' · ');
  }
  function howToHtml(folder) {
    return `<div class="pg-howto"><p>An AI program shows up here the first time it runs with FunctAI's call log on:</p>
      <pre><code>functai.configure(log_calls=True)     # Python\nconfigure({ logCalls: true })         // TypeScript</code></pre>
      <p class="pg-dim">Every call becomes a line in <code>${h(folder || '~/.local/share/functai/calls')}</code>.</p></div>`;
  }
  // The right panel.
  let panelRerender = null;
  function panelHtml(project) {
    if (!list.data) {
      if (!list.error) loadList().then(() => panelRerender && panelRerender()).catch(() => panelRerender && panelRerender());
      return list.error ? `<div class="ag-empty">${h(list.error)}</div>` : '<div class="ag-empty">reading the call log…</div>';
    }
    if (Date.now() - list.at > 15000) loadList(true).then(() => panelRerender && panelRerender()).catch(() => {});
    const all = list.data.programs.filter(p => matches(p, project, list.query));
    const rows = all.map(p => `<div class="ag-row pg-row" data-program="${h(JSON.stringify([p.name, p.module]))}">
      <button type="button" class="ag-main"><span class="ag-title"><span class="pg-glyph" aria-hidden="true">ƒ</span><span class="pg-row-name">${h(p.name)}</span><span class="ag-age">${h(ago(p.last))}</span></span>
      <span class="pg-row-sig">${signatureHtml(p)}</span><span class="pg-row-sub">${statusWords(p)}</span></button></div>`).join('');
    const empty = list.query ? 'No program matches.' : project && list.data.programs.length ? 'No AI program has run in this project yet.' : '';
    return `<div class="pg-lib"><div class="ag-files-head"><input type="search" class="pg-search" placeholder="Find a program" aria-label="Find a program" value="${h(list.query)}">` +
      `<button type="button" class="ghost" data-programs-all>all</button></div>` + (rows || (empty ? `<div class="ag-empty">${h(empty)}</div>` : howToHtml(list.data.folder))) + '</div>';
  }
  function wireHost(host, rerender) {
    panelRerender = rerender;
    if (!host || host.dataset.pgWired) return;
    host.dataset.pgWired = '1';
    host.addEventListener('click', e => {
      if (!e.target.closest('.pg-lib')) return;
      const row = e.target.closest('[data-program]');
      if (row) { e.stopPropagation(); const [name, module] = JSON.parse(row.dataset.program); showProgram(name, module); return; }
      if (e.target.closest('[data-programs-all]')) { e.stopPropagation(); showList(); }
    }, true);
    host.addEventListener('input', e => {
      if (!e.target.classList.contains('pg-search')) return;
      list.query = e.target.value;
      const at = e.target.selectionStart;
      rerender();
      const box = host.querySelector('.pg-search');
      if (box) { box.focus({ preventScroll: true }); try { box.setSelectionRange(at, at); } catch {} }
    });
  }

  let pollTimer = null;
  const stopPolling = () => { clearTimeout(pollTimer); pollTimer = null; };
  const onPage = kind => typeof viewKind !== 'undefined' && viewKind === kind;
  window.addEventListener('chattering:route', () => { if (!onPage('program') && !onPage('programs')) stopPolling(); });

  async function showList() {
    call('markSettingsClosed');
    stopPolling();
    call('setRoute', 'programs', 'programs');
    view().innerHTML = '<div class="empty">reading the call log…</div>';
    try { await loadList(true); } catch (e) { view().innerHTML = `<div class="empty">${h(e.message)}</div>`; return; }
    renderList();
    const tick = async () => {
      if (!onPage('programs')) return;
      const before = list.data && list.data.seq;
      if (!document.hidden) { try { await loadList(true); if (list.data.seq !== before) renderList(); } catch {} }
      pollTimer = setTimeout(tick, 5000);
    };
    pollTimer = setTimeout(tick, 5000);
  }
  function renderList() {
    const data = list.data;
    const groups = new Map();
    for (const p of data.programs.filter(p => matches(p, '', list.query))) {
      const g = projectName(p.project) || 'no project';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p);
    }
    const cards = [...groups].map(([g, ps]) => `<section class="pg-group"><h2>${h(g)}</h2>${ps.map(p => `
      <button type="button" class="pg-card" data-program="${h(JSON.stringify([p.name, p.module]))}">
        <span class="pg-card-name"><span class="pg-glyph" aria-hidden="true">ƒ</span> ${h(p.name)}</span>
        <span class="pg-card-sig">${signatureHtml(p)}</span>
        ${p.instruction ? `<span class="pg-card-what">${h(firstParagraph(p.instruction))}</span>` : ''}
        <span class="pg-card-status">${statusWords(p)}</span>
      </button>`).join('')}</section>`).join('');
    const canEdit = typeof settingsState === 'undefined' || !settingsState || settingsState.canEditSettings !== false;
    view().innerHTML = `<div class="pg-view pg-list">
      <div class="pg-title"><h1>AI programs</h1>
        <p class="pg-lede">Functions whose body is a model call. See what each one really answers, and say when it is wrong.</p></div>
      ${data.programs.length > 6 ? `<input type="search" id="pgListSearch" class="pg-list-search" placeholder="Find a program" value="${h(list.query)}">` : ''}
      ${data.programs.length ? cards || '<p class="pg-dim">No program matches.</p>' : howToHtml(data.folder)}
      <details class="pg-fine"><summary>Where this comes from</summary>
        <p>FunctAI, in Python or TypeScript, writes every call to <code>${h(data.folder)}</code>. Your judgements go to the same folder, so FunctAI reads them too.</p>
        <label class="pg-switch"><input type="checkbox" data-pg-record ${data.recordAgents ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
          Also record the programs that agents run from Chattering <span class="pg-dim">(new agent runs only)</span></label></details>
    </div>`;
    const root = view();
    root.querySelectorAll('[data-program]').forEach(b => { b.onclick = () => { const [name, module] = JSON.parse(b.dataset.program); showProgram(name, module); }; });
    const search = root.querySelector('#pgListSearch');
    if (search) search.oninput = () => { list.query = search.value; const at = search.selectionStart; renderList(); const s = view().querySelector('#pgListSearch'); s.focus(); s.setSelectionRange(at, at); };
    const box = root.querySelector('[data-pg-record]');
    if (box) box.onchange = async () => {
      try { const r = await post('/api/programs/recording', { recordAgents: box.checked }, 'PUT'); list.data.recordAgents = r.recordAgents; toast(r.recordAgents ? 'New agent runs will record their AI programs.' : 'Agents record only where FunctAI was told to.'); }
      catch (e) { box.checked = !box.checked; errToast(e.message); }
    };
  }

  // ---- one program ----
  const fresh = () => ({ judged: '', answer: '', q: '', version: '', tests: false });
  const page = { name: '', module: '', tab: 'examples', program: null, versions: [], you: '', seq: -1,
    filter: fresh(), runs: [], counts: null, answers: [], total: 0, limit: 50,
    open: null, detail: null, correcting: false, check: null, compare: null, key: null, showSame: false };
  const pq = () => ({ name: page.name, module: page.module });
  const vName = v => { const x = page.versions.find(y => y.version === v); return x ? 'v' + x.n : 'v?'; };

  async function showProgram(name, module, { tab = 'examples', run = null } = {}) {
    call('markSettingsClosed');
    stopPolling();
    if (page.name !== name || page.module !== module) Object.assign(page, { name, module, program: null, versions: [], runs: [], counts: null, answers: [], total: 0,
      open: null, detail: null, correcting: false, check: null, compare: null, key: null, filter: fresh(), limit: 50, seq: -1, showSame: false });
    page.tab = ['examples', 'compare', 'key', 'about'].includes(tab) ? tab : 'examples';
    call('setRoute', 'program', hashFor({ name, module, tab: page.tab, run }));
    view().innerHTML = '<div class="empty">reading the call log…</div>';
    try { await loadProgram(); }
    catch (e) { view().innerHTML = `<div class="pg-view"><p class="empty">${h(e.message)}</p><p><button type="button" class="ghost" data-programs-all>← all AI programs</button></p></div>`; view().querySelector('[data-programs-all]').onclick = showList; return; }
    await loadTab();
    if (run) await openRun(run, { render: false });
    render();
    if (run) scrollToOpen();
    schedulePoll();
  }
  async function loadProgram() {
    const d = await api('/api/programs/program?' + qs(pq()));
    page.program = d.program; page.versions = d.versions; page.you = d.you; page.seq = d.seq;
  }
  async function loadRuns() {
    const f = page.filter;
    const d = await api('/api/programs/runs?' + qs({ ...pq(), judged: f.judged, answer: f.answer, q: f.q, version: f.version, purpose: f.tests ? 'all' : '', limit: page.limit }));
    page.runs = d.runs; page.total = d.total; page.counts = d.counts; page.answers = d.answers; page.seq = d.seq;
  }
  async function loadTab() {
    if (page.tab === 'examples') await loadRuns();
    else if (page.tab === 'key') page.key = await api('/api/programs/rated?' + qs(pq()));
    else if (page.tab === 'compare' && !page.compare && page.versions.length > 1) await loadCompare(page.versions[1].version, page.versions[0].version);
  }
  async function loadCompare(a, b) { page.compare = await api('/api/programs/compare?' + qs({ ...pq(), a, b })); }
  function schedulePoll() {
    stopPolling();
    const tick = async () => {
      if (!onPage('program')) return;
      const busy = page.correcting || page.check || (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName));
      if (!document.hidden && !busy) {
        try {
          const d = await api('/api/programs/runs?' + qs({ ...pq(), limit: 1 }));
          if (d.seq !== page.seq) { await loadProgram(); await loadTab(); render(); }
        } catch {}
      }
      pollTimer = setTimeout(tick, 5000);
    };
    pollTimer = setTimeout(tick, 5000);
  }
  function setTab(tab) {
    page.tab = tab; page.check = null;
    call('replaceRoute', hashFor({ name: page.name, module: page.module, tab }));
    loadTab().then(render).catch(e => errToast(e.message));
  }

  // The one sentence of how it is doing, and the one number that matters.
  function statusHtml() {
    const p = page.program, s = p.sample;
    const week = p.recent ? `${plural(p.recent, 'answer')} this week` : `last used ${ago(p.last)}`;
    const fails = p.stats.errors ? ` · <span class="pg-bad">${plural(p.stats.errors, 'failure')}</span>` : '';
    const measured = s && s.n
      ? `<div class="pg-score"><span class="pg-score-n">${pct(s.score)}</span><span class="pg-score-words">right, on ${plural(s.n, 'random answer')} you checked<br><span class="pg-dim">the true rate is likely between ${pct(s.low)} and ${pct(s.high)}</span></span>
         <button type="button" class="ghost" data-pg-check>check ${s.n < 50 ? '20 more' : 'again'}</button></div>`
      : `<div class="pg-score pg-score-none"><span class="pg-score-words">How often is it right? Nobody knows yet.</span><button type="button" class="primary" data-pg-check>Check 20 random answers</button></div>`;
    return `<div class="pg-status"><p class="pg-status-line">${week}${fails}</p>${measured}</div>`;
  }
  function headHtml() {
    const p = page.program;
    const first = firstParagraph(p.instruction), more = p.instruction && p.instruction.trim() !== first;
    const tab = (id, label, count) => `<button type="button" role="tab" data-pg-tab="${id}" aria-selected="${page.tab === id}" class="${page.tab === id ? 'on' : ''}">${label}${count ? ` <span class="pg-count">${count}</span>` : ''}</button>`;
    const known = p.ratings.right + p.ratings.wrong - p.ratings.open + p.ratings.disputed;
    return `<nav class="pg-crumb"><button type="button" class="linkish" data-programs-all>AI programs</button>${projectName(p.project) ? ' / ' + h(p.project) : ''}</nav>
      <div class="pg-title"><h1><span class="pg-glyph" aria-hidden="true">ƒ</span> ${h(p.name)}</h1>
        ${first ? `<p class="pg-lede">${h(first)}${more ? ` <button type="button" class="linkish" data-pg-tab="about">the whole instruction</button>` : ''}</p>` : ''}</div>
      <div class="pg-sigbox">${signatureHtml(p, { big: true })}</div>
      ${statusHtml()}
      <div class="pg-tabs" role="tablist">${tab('examples', 'Examples', '')}${page.versions.length > 1 ? tab('compare', 'Compare versions', '') : ''}${tab('key', 'Answer key', known > 0 ? num(known) : '')}${tab('about', 'About', '')}</div>`;
  }
  function render() {
    if (!page.program) return;
    const body = page.check ? checkHtml() : page.tab === 'compare' ? compareHtml() : page.tab === 'key' ? keyHtml() : page.tab === 'about' ? aboutHtml() : examplesHtml();
    view().innerHTML = `<div class="pg-view">${headHtml()}<div class="pg-body">${body}</div></div>`;
    wire(view());
  }

  // ---- Examples: the page's heart ----
  function examplesHtml() {
    const c = page.counts || {}, f = page.filter, p = page.program;
    const pill = (id, glyph, label, n, cls) => (n || f.judged === id) ? `<button type="button" class="pg-pill ${cls} ${f.judged === id ? 'on' : ''}" data-judged="${id}" aria-pressed="${f.judged === id}"><span class="pg-pill-n">${num(n)}</span> ${glyph} ${label}</button>` : '';
    const pills = pill('unjudged', '?', 'not judged', c.unjudged, 'ask') + pill('right', '✓', 'right', c.right, 'good') + pill('wrong', '✗', 'wrong', c.wrong, 'bad') +
      pill('disputed', '⚖', 'people disagree', c.disputed, 'warn') + pill('failed', '!', 'failed', c.failed, 'bad');
    const totalAnswers = page.answers.reduce((s, a) => s + a.n, 0);
    const spread = page.answers.length > 1 && page.answers.length <= 12 && page.answers.every(a => typeof a.value !== 'object' || a.value === null)
      ? `<div class="pg-spread" aria-label="What it answers"><span class="pg-dim">it answers</span>${page.answers.map(a => {
          const on = f.answer === JSON.stringify(a.value);
          return `<button type="button" class="pg-bar-btn ${on ? 'on' : ''}" data-answer="${h(JSON.stringify(a.value))}" aria-pressed="${on}" title="${num(a.n)} of ${num(totalAnswers)}">
            <span class="pg-bar-fill" style="width:${Math.max(4, Math.round((a.n / totalAnswers) * 100))}%"></span><span class="pg-bar-label">${h(inline(a.value))}</span><span class="pg-bar-n">${num(a.n)}</span></button>`;
        }).join('')}</div>` : '';
    const versions = page.versions.length > 1 ? `<select data-pg-version aria-label="version"><option value="">every version</option>${page.versions.map(v => `<option value="${h(v.version || '')}" ${f.version === v.version ? 'selected' : ''}>v${v.n}${v.current ? ' (current)' : ''}</option>`).join('')}</select>` : '';
    const tests = Object.values(p.stats.other || {}).reduce((s, n) => s + n, 0);
    const filtering = f.judged || f.answer || f.q || f.version;
    const rows = page.runs.map((r, i) => rowHtml(r, i)).join('');
    return `<div class="pg-examples">
      <div class="pg-controls"><div class="pg-pills" role="group" aria-label="Show">${pills}</div>
        <div class="pg-tools"><input type="search" id="pgQuery" placeholder="Search the examples" aria-label="Search the examples" value="${h(f.q)}">${versions}
          ${tests ? `<label class="pg-switch" title="Calls made by FunctAI's evaluate, optimizers and tests: they answer known questions, so they are not counted as use"><input type="checkbox" data-pg-tests ${f.tests ? 'checked' : ''}> ${plural(tests, 'test run')}</label>` : ''}</div></div>
      ${spread}
      ${rows ? `<div class="pg-table" role="table" aria-label="Examples: input and output">
        <div class="pg-thead" role="row"><span role="columnheader" class="pg-in-h">input</span><span role="columnheader" class="pg-out-h">output</span><span role="columnheader">judged</span></div>
        ${rows}</div>
        ${page.runs.length < page.total ? `<button type="button" class="ghost pg-more" data-pg-more>show more (${num(page.total - page.runs.length)} left)</button>` : ''}
        <p class="pg-keys pg-dim"><kbd>j</kbd> <kbd>k</kbd> move · <kbd>1</kbd> right · <kbd>2</kbd> wrong · <kbd>esc</kbd> close</p>`
        : `<p class="pg-empty">${filtering ? 'No example matches. <button type="button" class="linkish" data-pg-clear>Show all</button>' : 'No calls yet.'}</p>`}
    </div>`;
  }
  function verdictHtml(r) {
    if (r.error) return `<span class="pg-v bad">! failed</span>`;
    if (r.rating === 'right') return '<span class="pg-v good">✓ right</span>';
    if (r.rating === 'wrong') return r.ratingOpen ? '<span class="pg-v bad">✗ wrong</span><span class="pg-v-sub">answer unknown</span>'
      : `<span class="pg-v bad">✗ wrong</span>${r.fix !== undefined ? `<span class="pg-v-sub">should be <b class="pg-fix">${h(inline(r.fix))}</b></span>` : ''}`;
    if (r.rating === 'disputed') return '<span class="pg-v warn">⚖ disputed</span>';
    return `<span class="pg-judge-mini"><button type="button" data-quick="right" title="Right (1)" aria-label="right">✓</button><button type="button" data-quick="wrong" title="Wrong (2)" aria-label="wrong">✗</button></span>`;
  }
  function rowHtml(r, i) {
    const open = page.open === r.id;
    const out = r.error ? `<span class="pg-bad">${h(r.error.message || r.error.type)}</span>` : r.content ? (r.rating === 'wrong' ? `<s>${h(r.outputs)}</s>` : h(r.outputs)) : '<span class="pg-dim">not recorded</span>';
    return `<div class="pg-tr ${open ? 'open' : ''} ${r.rating ? 'rated-' + r.rating : ''}" role="row" data-run="${h(r.id)}" tabindex="0" aria-expanded="${open}">
      <div class="pg-row-line"><span role="cell" class="pg-td pg-td-in">${r.content ? h(r.inputs) : '<span class="pg-dim">not recorded</span>'}</span>
        <span role="cell" class="pg-td pg-td-out">${out}</span><span role="cell" class="pg-td pg-td-v">${verdictHtml(r)}</span></div>
      ${open ? openHtml() : ''}</div>`;
  }

  // One example, opened in place.
  function fields(values, answer) {
    if (!values || typeof values !== 'object') return '<p class="pg-dim">—</p>';
    const entries = Object.entries(values);
    return entries.map(([k, v]) => `<div class="pg-field${k === answer && entries.length > 1 ? ' pg-answer' : ''}">${entries.length > 1 ? `<div class="pg-field-name">${h(k)}</div>` : ''}<div class="pg-field-value">${h(show(v))}</div></div>`).join('');
  }
  function whereFrom(r) {
    const c = r.caller || {};
    if (c.conversation) return `an agent in <button type="button" class="linkish" data-open-conv="${h(c.conversation)}">${h(sessionTitle(c.conversation))}</button>`;
    if (c.notebook) return `the notebook <button type="button" class="linkish" data-open-file="${h(c.notebook)}">${h(base(c.notebook))}</button>`;
    if (c.kind) return 'a ' + h(c.kind);
    return LANG[r.language] ? h(LANG[r.language]) + ' code' : 'code';
  }
  function openHtml() {
    const d = page.detail;
    if (!d) return '<div class="pg-open"><p class="pg-dim">opening…</p></div>';
    const r = d.run, rec = d.record || {}, p = page.program;
    const mine = d.counting.find(x => x.by === page.you);
    const answerText = rec.outputs && r.answer in (rec.outputs || {}) ? inline(rec.outputs[r.answer]) : '';
    const judge = r.error ? `<p class="pg-bad pg-errline"><b>${h(r.error.type)}</b>${r.error.code ? ' · ' + h(r.error.code) : ''}${r.error.message ? ': ' + h(r.error.message) : ''}</p>`
      : !r.content ? '<p class="pg-dim">Its values were not recorded (this program logs sizes only), so it cannot be judged.</p>'
      : page.correcting ? correctionHtml(d)
      : `<div class="pg-ask"><span>Is <b>${h(answerText)}</b> right${Object.keys(rec.inputs || {}).length ? ' for this' : ''}?</span>
          <button type="button" class="pg-yes ${mine && mine.verdict === 'right' ? 'on' : ''}" data-rate="right">✓ Right <kbd>1</kbd></button>
          <button type="button" class="pg-no ${mine && mine.verdict === 'wrong' ? 'on' : ''}" data-rate="wrong">✗ Wrong <kbd>2</kbd></button>
          ${mine ? '<button type="button" class="linkish pg-undo" data-rate="withdraw">undo</button>' : ''}</div>`;
    const others = d.ratings.length ? `<ul class="pg-said">${d.counting.map(x => `<li>${x.verdict === 'right' ? '<span class="pg-good">✓</span>' : '<span class="pg-bad">✗</span>'} ${h(x.by === page.you ? 'You' : x.by)} said ${x.verdict === 'right' ? 'right' : 'wrong'}${'answer' in x ? `; it should be <b>${h(inline(x.answer))}</b>` : ''}${x.note ? ` — “${h(x.note)}”` : ''} <span class="pg-dim">${h(ago(x.at))}${x.origin === 'edit' ? ' · by editing it' : ''}</span></li>`).join('')}</ul>` : '';
    const u = r.tokensIn + r.tokensOut;
    const details = `<details class="pg-fold"><summary>Details</summary><p>Called ${h(ago(r.started))} from ${whereFrom(r)}${r.person ? ' by ' + h(r.person) : ''}. ${h(r.model || 'No model')} answered in ${secs(r.seconds)}${u ? `, using ${num(u)} tokens` : ''}${r.exchanges > 1 ? ` over ${num(r.exchanges)} requests` : ''}. ${page.versions.length > 1 ? `Version ${vName(r.version)}.` : ''}</p>
      ${d.parent ? `<p>It ran inside <button type="button" class="linkish" data-open-run="${h(d.parent.id)}" data-open-program="${h(JSON.stringify([d.parent.name, d.parent.module]))}">${h(d.parent.name)}</button>.</p>` : ''}
      ${d.children.length ? `<p>It called ${d.children.map(k => `<button type="button" class="linkish" data-open-run="${h(k.id)}" data-open-program="${h(JSON.stringify([k.name, k.module]))}">${h(k.name)}</button>`).join(', ')}.</p>` : ''}</details>`;
    return `<div class="pg-open" aria-label="This example, whole">
      <div class="pg-pair"><section><h3 class="pg-in-h">input</h3>${fields(rec.inputs)}</section>
        <section><h3 class="pg-out-h">output</h3>${r.error ? '<p class="pg-bad">no answer</p>' : fields(rec.outputs, r.answer)}</section></div>
      ${judge}${others}
      ${seenHtml(rec)}${details}</div>`;
  }
  function partText(part) {
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text') return part.text || '';
    if (part.type === 'thinking') return '(thinking)\n' + (part.text || '');
    if (part.type === 'tool_call') return `(asks the tool ${part.name || ''}) ${JSON.stringify(part.input ?? part.arguments ?? {})}`;
    if (part.type === 'tool_result') return '(the tool answers) ' + (Array.isArray(part.content) ? part.content.map(partText).join(' ') : JSON.stringify(part.content ?? ''));
    return `(${part.type || 'part'})`;
  }
  const messageText = m => (m && Array.isArray(m.parts) ? m.parts.map(partText).join('\n') : '');
  function seenHtml(rec) {
    const ex = (rec && rec.exchanges) || [];
    if (!ex.length || !ex.some(e => e.request)) return '';
    const bubbles = [];
    const first = ex.find(e => e.request).request;
    if (first.system) bubbles.push(['system', typeof first.system === 'string' ? first.system : JSON.stringify(first.system, null, 2)]);
    ex.forEach((e, i) => {
      const msgs = (e.request && e.request.messages) || [];
      // Each request repeats the conversation so far: show only what is new.
      const prev = i ? ((ex[i - 1].request && ex[i - 1].request.messages) || []).length + 1 : 0;
      for (const m of msgs.slice(prev)) bubbles.push([m.role, messageText(m)]);
      if (e.response) bubbles.push(['model', messageText(e.response.message)]);
      if (e.error) bubbles.push(['error', e.error.message || e.error.type]);
    });
    return `<details class="pg-fold"><summary>What the model saw${ex.length > 1 ? ` (${ex.length} requests)` : ''}</summary><div class="pg-chat">${bubbles.map(([role, text]) =>
      `<div class="pg-bubble ${h(role)}"><div class="pg-role">${h(role === 'user' ? 'sent' : role === 'model' ? 'model replied' : role)}</div><pre>${h(text)}</pre></div>`).join('')}</div></details>`;
  }

  // "What should it have said?" — the answers it can give, as buttons.
  function editorFor(value, id, choices) {
    if (choices && choices.length) return '';
    if (typeof value === 'boolean') return `<select id="${id}" data-type="boolean"><option value="true" ${value ? 'selected' : ''}>true</option><option value="false" ${!value ? 'selected' : ''}>false</option></select>`;
    if (typeof value === 'number') return `<input id="${id}" type="number" step="any" data-type="number" value="${h(value)}">`;
    if (value === undefined || typeof value === 'string') {
      const long = typeof value === 'string' && (value.length > 60 || value.includes('\n'));
      return long ? `<textarea id="${id}" data-type="string" rows="4">${h(value)}</textarea>` : `<input id="${id}" data-type="string" value="${h(value ?? '')}" autocomplete="off" placeholder="the right answer">`;
    }
    return `<textarea id="${id}" data-type="json" rows="5" spellcheck="false">${h(JSON.stringify(value, null, 2))}</textarea>`;
  }
  function readEditor(el) {
    const t = el.dataset.type;
    if (t === 'boolean') return el.value === 'true';
    if (t === 'number') { if (el.value.trim() === '') throw new Error('Give a number.'); return Number(el.value); }
    if (t === 'json') { try { return JSON.parse(el.value); } catch { throw new Error('That is not valid JSON.'); } }
    if (!el.value.trim()) throw new Error('Type the right answer, or choose “I don’t know”.');
    return el.value;
  }
  function correctionHtml(d) {
    const rec = d.record || {}, answer = d.run.answer || 'result', p = page.program;
    const current = (rec.outputs || {})[answer];
    const choices = (p.choices && p.choices.length ? p.choices : null)
      || (typeof current === 'string' && (p.answers || []).length > 1 && (p.answers || []).length <= 12 && p.answers.every(a => typeof a.value === 'string') && p.answers.every(a => a.value.length <= 40) ? p.answers.map(a => a.value) : null);
    const options = choices ? choices.filter(c => c !== current) : null;
    return `<form class="pg-correct" id="pgCorrect">
      <div class="pg-correct-q">What should it have said?</div>
      ${options ? `<div class="pg-choices">${options.map((c, i) => `<button type="submit" class="pg-choice-btn" data-pick="${h(JSON.stringify(c))}">${i < 9 ? `<kbd>${i + 1}</kbd> ` : ''}${h(inline(c))}</button>`).join('')}</div>`
        : `<div class="pg-edit">${editorFor(current, 'pgAnswer', null)}</div>`}
      <input id="pgNote" class="pg-note-in" placeholder="Why? (optional — the rule it missed)" autocomplete="off">
      <div class="pg-correct-foot">${options ? '' : '<button type="submit" class="primary">Save <kbd>⏎</kbd></button>'}
        <button type="button" class="ghost" data-pg-unknown>I don’t know the right answer</button>
        <button type="button" class="linkish" data-pg-cancel>cancel <kbd>esc</kbd></button></div></form>`;
  }

  async function openRun(id, { render: paint = true } = {}) {
    if (page.open === id && paint) { page.open = null; page.detail = null; page.correcting = false; call('replaceRoute', hashFor({ ...pq(), tab: page.tab })); return renderTable(); }
    page.open = id; page.correcting = false; page.detail = null;
    if (paint) renderTable();
    try { page.detail = await api('/api/programs/run?id=' + encodeURIComponent(id)); }
    catch (e) { errToast(e.message); page.open = null; return paint && renderTable(); }
    if (page.open !== id) return;
    call('replaceRoute', hashFor({ ...pq(), tab: page.tab, run: id }));
    if (paint) { renderTable(); scrollToOpen(); }
  }
  function renderTable() {
    if (page.tab !== 'examples' || page.check) return render();
    const body = view().querySelector('.pg-body');
    if (!body) return render();
    body.innerHTML = examplesHtml();
    wire(body);
  }
  function scrollToOpen() {
    const el = view().querySelector('.pg-tr.open');
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 60 || r.bottom > innerHeight) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  // Send a judgement; update the row in place.
  async function rate(callId, verdict, extra = {}) {
    const out = await post('/api/programs/rate', { call: callId, verdict, ...extra });
    const row = page.runs.find(r => r.id === callId);
    if (row) Object.assign(row, { rating: out.state ? out.state.state : null, ratingOpen: !!(out.state && out.state.open), ratedBy: out.state ? out.state.people : 0 });
    list.at = 0;
    return out;
  }
  let busy = false;
  async function judgeOpen(verdict, extra = {}, { next = true } = {}) {
    if (busy || !page.detail) return;
    busy = true;
    const id = page.detail.run.id;
    try {
      await rate(id, verdict, extra);
      page.correcting = false;
      const [prog] = await Promise.all([api('/api/programs/program?' + qs(pq())), loadRunsQuiet()]);
      page.program = prog.program; page.versions = prog.versions;
      // Judged: move on to the next example nobody has judged, like a reviewer would.
      const i = page.runs.findIndex(r => r.id === id);
      const after = next && verdict ? page.runs.slice(i + 1).find(r => !r.rating && !r.error && r.content) : null;
      if (after) { page.open = null; await openRun(after.id, { render: false }); }
      else page.detail = await api('/api/programs/run?id=' + encodeURIComponent(id)).catch(() => page.detail);
      render();
      scrollToOpen();
    } catch (e) { errToast(e.message); }
    finally { busy = false; }
  }
  async function loadRunsQuiet() {
    // Keep the rows the person is looking at, even when the filter would now hide one.
    const keep = new Map(page.runs.map(r => [r.id, r]));
    await loadRuns();
    if (page.open && !page.runs.some(r => r.id === page.open) && keep.has(page.open)) {
      const at = [...keep.keys()].indexOf(page.open);
      page.runs.splice(Math.min(at, page.runs.length), 0, { ...keep.get(page.open), ...(page.detail ? { rating: page.detail.run.rating } : {}) });
    }
  }

  // ---- Check 20 random answers: the only measure of how often it is right ----
  async function startCheck() {
    const d = await post('/api/programs/sample', { ...pq(), n: 20, version: page.program.version });
    if (!d.ids.length) { toast('Every answer of this version is already judged.'); return; }
    page.check = { ids: d.ids, sample: d.sample, at: 0, results: [], detail: null, correcting: false };
    await loadCheckItem();
    render();
  }
  async function loadCheckItem() {
    const c = page.check;
    c.detail = c.at < c.ids.length ? await api('/api/programs/run?id=' + encodeURIComponent(c.ids[c.at])) : null;
  }
  function checkHtml() {
    const c = page.check, p = page.program;
    const dots = c.ids.map((_, i) => `<span class="pg-dot ${c.results[i] || (i === c.at ? 'now' : '')}"></span>`).join('');
    if (!c.detail) {
      const right = c.results.filter(x => x === 'right').length, judged = c.results.filter(Boolean).length;
      const s = p.sample;
      return `<div class="pg-check pg-check-done"><div class="pg-dots">${dots}</div>
        <p class="pg-big-n">${right} of ${judged}</p><p class="pg-lede">were right.</p>
        ${s && s.n ? `<p>With every random check so far (${plural(s.n, 'answer')}), it is right about <b>${pct(s.score)}</b> of the time — most likely between ${pct(s.low)} and ${pct(s.high)}.${s.n < 60 ? ' Checking more narrows that range.' : ''}</p>` : ''}
        <p class="pg-actions"><button type="button" class="primary" data-pg-check>Check 20 more</button><button type="button" class="ghost" data-pg-check-end>Back to the examples</button></p></div>`;
    }
    const r = c.detail.run, rec = c.detail.record || {};
    const answerText = rec.outputs && r.answer in rec.outputs ? inline(rec.outputs[r.answer]) : '';
    return `<div class="pg-check"><div class="pg-check-head"><span>Checking random answers <span class="pg-dim">· ${c.at + 1} of ${c.ids.length}</span></span><button type="button" class="linkish" data-pg-check-end>stop</button></div>
      <div class="pg-dots">${dots}</div>
      <div class="pg-pair pg-big"><section><h3 class="pg-in-h">input</h3>${fields(rec.inputs)}</section><section><h3 class="pg-out-h">output</h3>${fields(rec.outputs, r.answer)}</section></div>
      ${c.correcting ? correctionHtml(c.detail) : `<div class="pg-ask pg-ask-big"><span>Is <b>${h(answerText)}</b> right?</span>
        <button type="button" class="pg-yes" data-check="right">✓ Right <kbd>1</kbd></button><button type="button" class="pg-no" data-check="wrong">✗ Wrong <kbd>2</kbd></button>
        <button type="button" class="linkish" data-check="skip">skip <kbd>s</kbd></button></div>`}
      ${seenHtml(rec)}</div>`;
  }
  async function checkStep(result, extra = {}) {
    const c = page.check;
    if (!c || !c.detail || busy) return;
    busy = true;
    try {
      if (result !== 'skip') await rate(c.detail.run.id, result, { ...extra, sample: c.sample });
      c.results[c.at] = result === 'skip' ? 'skipped' : result;
      c.at++; c.correcting = false;
      await loadCheckItem();
      if (!c.detail) await loadProgram();
      render();
    } catch (e) { errToast(e.message); }
    finally { busy = false; }
  }

  // ---- Compare versions: did the change help? ----
  function compareHtml() {
    const cmp = page.compare, vs = page.versions;
    if (!cmp) return '<p class="pg-dim">…</p>';
    const pick = (name, sel) => `<select data-pg-cmp="${name}" aria-label="${name === 'a' ? 'before' : 'after'}">${vs.map(v => `<option value="${h(v.version || '')}" ${v.version === sel ? 'selected' : ''}>v${v.n}${v.current ? ' (current)' : ''}</option>`).join('')}</select>`;
    const a = vName(cmp.a), b = vName(cmp.b);
    const changed = cmp.pairs.filter(x => !x.same);
    const winA = changed.filter(x => x.a.rating === 'right' && x.b.rating !== 'right').length;
    const winB = changed.filter(x => x.b.rating === 'right' && x.a.rating !== 'right').length;
    const open = changed.length - winA - winB;
    const verdict = !cmp.common ? `No question was answered by both. Run the same examples through each version (FunctAI's <code>evaluate</code> does) to compare them here.`
      : !changed.length ? `Both gave the same answer to all ${plural(cmp.common, 'question')} they share.`
      : `<b>${num(changed.length)}</b> of the ${plural(cmp.common, 'question')} both answered got a different answer.${open ? ' Click the right one.' : ''}`;
    // Once every change is judged, say what the change did.
    const conclusion = open || !changed.length ? '' : winB > winA ? `${h(b)} is better on what changed.` : winA > winB ? `${h(a)} was better on what changed.` : 'Neither is better on what changed.';
    const board = changed.length ? `<div class="pg-board" aria-label="Who was right, where the answers differ">
        <div><span class="pg-board-n pg-good">${num(winA)}</span> ${h(a)} was right</div><div><span class="pg-board-n pg-good">${num(winB)}</span> ${h(b)} was right</div>
        <div class="pg-dim"><span class="pg-board-n">${num(open)}</span> to judge</div>${conclusion ? `<div class="pg-board-end">${conclusion}</div>` : ''}</div>` : '';
    const shown = page.showSame ? cmp.pairs : changed;
    const out = (x, side, pr) => {
      const state = x.rating === 'right' ? ' is-right' : x.rating === 'wrong' ? ' is-wrong' : '';
      const text = x.error ? x.error.type : x.outputs;
      if (pr.same) return `<div class="pg-cmp-out${state}"><span class="pg-dim">${h(side === 'a' ? a : b)}</span> ${h(text)}</div>`;
      return `<button type="button" class="pg-cmp-out${state}" data-cmp-right="${side}" data-a="${h(pr.a.id)}" data-b="${h(pr.b.id)}" title="This one is right"><span class="pg-dim">${h(side === 'a' ? a : b)}</span> ${h(text)}${x.rating === 'right' ? ' <span class="pg-good">✓</span>' : x.rating === 'wrong' ? ' <span class="pg-bad">✗</span>' : ''}</button>`;
    };
    const cards = shown.map(pr => `<article class="pg-cmp ${pr.same ? 'same' : ''}"><div class="pg-cmp-in">${h(pr.a.inputs)}</div>
      <div class="pg-cmp-outs">${out(pr.a, 'a', pr)}${out(pr.b, 'b', pr)}</div>
      ${pr.same ? '' : `<button type="button" class="linkish pg-neither" data-cmp-neither data-a="${h(pr.a.id)}" data-b="${h(pr.b.id)}">neither is right</button>`}</article>`).join('');
    return `<div class="pg-compare"><div class="pg-cmp-pick">${pick('a', cmp.a)} <span class="pg-arrow">→</span> ${pick('b', cmp.b)}</div>
      <p class="pg-lede">${verdict}</p>${board}${cards}
      ${cmp.common - changed.length > 0 ? `<button type="button" class="linkish" data-pg-same>${page.showSame ? 'hide' : 'show'} the ${num(cmp.common - changed.length)} unchanged</button>` : ''}</div>`;
  }

  // ---- Answer key: the examples whose right answer is known ----
  function keyHtml() {
    const k = page.key || { rows: [], left_out: {} }, p = page.program;
    const left = k.left_out || {};
    const cols = (p.inputs && p.inputs.length ? p.inputs : []).filter(c => k.rows.some(r => c in r));
    const answer = p.answer || 'result';
    const q = qs(pq());
    const open = p.ratings.open;
    return `<div class="pg-key"><p class="pg-lede">${k.rows.length ? `<b>${plural(k.rows.length, 'example')}</b> with a known right answer — what you test the next version against.` : 'No example has a known right answer yet. Judge a few in Examples: every one you mark becomes one here.'}</p>
      ${open ? `<p class="pg-warn">${plural(open, 'answer')} ${open === 1 ? 'was' : 'were'} judged wrong without saying what is right. <button type="button" class="linkish" data-pg-show-open>Give ${open === 1 ? 'it' : 'them'}</button></p>` : ''}
      ${k.rows.length ? `<div class="pg-keytable" role="table">${k.rows.slice(0, 300).map(r => `<div class="pg-key-row" role="row">
          <span role="cell" class="pg-key-in">${h(cols.map(c => inline(r[c])).join(' · '))}</span>
          <span role="cell" class="pg-key-ans">${h(inline(r[answer]))}</span>
          <span role="cell" class="pg-dim">${r.rating === 'right' ? 'as it answered' : 'corrected'} · ${h(r.rated_by === page.you ? 'you' : r.rated_by)}${r.disputed ? ' · <span class="pg-warn">disputed</span>' : ''}</span></div>`).join('')}</div>
        <div class="pg-use"><div><h3>Test the next version with it</h3>
          <pre>rows = functai.rated(${h(JSON.stringify(p.name))})     # Python
functai.evaluate(${h(p.name)}, rows)</pre>
          <pre>const { rows } = rated(${h(JSON.stringify(p.name))});   // TypeScript
await evaluate(${h(p.name)}, rows);</pre></div>
          <div><h3>Or take it elsewhere</h3><p><a class="button" href="/api/programs/rated?${q}&format=csv" download>Download CSV</a> <a class="button" href="/api/programs/rated?${q}&format=jsonl" download>JSON lines</a></p>
          ${left.other_signature || left.no_content ? `<p class="pg-dim">Not included: ${[left.other_signature ? `${left.other_signature} from before its inputs or outputs changed` : '', left.no_content ? `${left.no_content} whose values were not recorded` : ''].filter(Boolean).join(', ')}.</p>` : ''}</div></div>` : ''}</div>`;
  }

  // ---- About: everything that is not the examples ----
  function aboutHtml() {
    const p = page.program, st = p.stats;
    const files = (p.files || []).map(f => `<li>${h(f.file)}${f.line ? ':' + f.line : ''} <span class="pg-dim">${h(LANG[f.language] || f.language || '')}</span></li>`).join('');
    const from = (p.sources || []).map(s => {
      if (s.ref.startsWith('conversation:')) { const k = s.ref.slice(13); return `<li><button type="button" class="linkish" data-open-conv="${h(k)}">${h(sessionTitle(k))}</button> <span class="pg-dim">an agent · ${plural(s.n, 'call')}</span></li>`; }
      if (s.ref.startsWith('notebook:')) { const f = s.ref.slice(9); return `<li><button type="button" class="linkish" data-open-file="${h(f)}">${h(base(f))}</button> <span class="pg-dim">a notebook · ${plural(s.n, 'call')}</span></li>`; }
      return '';
    }).join('');
    const kinds = st.callers.filter(c => c.name !== 'unknown').map(c => `${h(c.name)} (${num(c.n)})`).join(', ');
    const perCall = st.use ? Math.round((st.tokensIn + st.tokensOut) / st.use) : 0;
    const versions = page.versions.map(v => `<li><b>v${v.n}</b>${v.current ? ' (current)' : ''} <span class="pg-dim">first seen ${h(ago(v.first))} · ${plural(v.useCalls, 'answer')}${v.otherCalls ? ` + ${num(v.otherCalls)} in tests` : ''}${v.sample && v.sample.n ? ` · right ${pct(v.sample.score)} of ${num(v.sample.n)} checked` : ''} · <code title="${h(v.version || '')}">${h(String(v.version || '').replace(/^sha256:/, '').slice(0, 10))}</code></span></li>`).join('');
    return `<div class="pg-about">
      ${p.instruction ? `<section><h3>What it is told</h3><pre class="pg-instruction">${h(p.instruction)}</pre>${p.choices ? `<p class="pg-dim">It must answer one of: ${p.choices.map(h).join(', ')}.</p>` : ''}</section>` : ''}
      <section><h3>How it runs</h3><p>${h(st.models.map(m => m.name).join(', ') || 'No model yet')}. Half its answers come within ${secs(st.p50)}, nearly all within ${secs(st.p95)}. About ${num(perCall)} tokens an answer. ${st.errors ? `<span class="pg-bad">${plural(st.errors, 'call')} failed.</span>` : 'No failures.'}</p></section>
      <section><h3>Versions</h3><p class="pg-dim">A version is what the program sends besides its inputs: instruction, layout, examples, tools. The model is not part of it; the same function in Python and TypeScript is one version.</p><ul>${versions}</ul></section>
      ${from || kinds ? `<section><h3>Who calls it</h3>${from ? `<ul>${from}</ul>` : ''}${kinds ? `<p class="pg-dim">By kind: ${kinds}.</p>` : ''}</section>` : ''}
      ${files ? `<section><h3>Where the code is</h3><ul>${files}</ul></section>` : ''}
    </div>`;
  }

  // ---- events ----
  function wire(root) {
    const on = (sel, f) => root.querySelectorAll(sel).forEach(el => { el.onclick = e => { e.preventDefault(); f(el, e); }; });
    on('[data-programs-all]', () => showList());
    on('[data-pg-tab]', el => setTab(el.dataset.pgTab));
    on('[data-pg-check]', () => { page.tab = 'examples'; startCheck().catch(e => errToast(e.message)); });
    on('[data-pg-check-end]', () => { page.check = null; loadRuns().then(render); });
    on('[data-judged]', el => { page.filter.judged = page.filter.judged === el.dataset.judged ? '' : el.dataset.judged; page.open = null; loadRuns().then(renderTable); });
    on('[data-answer]', el => { page.filter.answer = page.filter.answer === el.dataset.answer ? '' : el.dataset.answer; page.open = null; loadRuns().then(renderTable); });
    on('[data-pg-clear]', () => { page.filter = fresh(); loadRuns().then(render); });
    on('[data-pg-more]', () => { page.limit += 100; loadRuns().then(renderTable); });
    on('[data-pg-show-open]', () => { page.tab = 'examples'; page.filter = { ...fresh(), judged: 'wrong' }; call('replaceRoute', hashFor(pq())); loadRuns().then(render); });
    on('[data-pg-same]', () => { page.showSame = !page.showSame; render(); });
    on('[data-open-conv]', el => call('open', el.dataset.openConv));
    on('[data-open-file]', el => call('openLiveFile', el.dataset.openFile, {}));
    on('[data-open-run]', el => {
      const [name, module] = el.dataset.openProgram ? JSON.parse(el.dataset.openProgram) : [page.name, page.module];
      if (name === page.name && module === page.module) openRun(el.dataset.openRun);
      else showProgram(name, module, { run: el.dataset.openRun });
    });
    on('[data-rate]', el => {
      const v = el.dataset.rate;
      if (v === 'wrong') { page.correcting = true; return renderTable(); }
      judgeOpen(v === 'withdraw' ? null : 'right', {}, { next: v !== 'withdraw' });
    });
    on('[data-check]', el => { if (el.dataset.check === 'wrong') { page.check.correcting = true; return render(); } checkStep(el.dataset.check); });
    // One click judges both: the chosen answer is right, and it is what the
    // other should have said.
    on('[data-cmp-right]', async el => {
      const right = el.dataset.cmpRight === 'a' ? el.dataset.a : el.dataset.b, wrong = el.dataset.cmpRight === 'a' ? el.dataset.b : el.dataset.a;
      const pr = page.compare.pairs.find(x => x.a.id === el.dataset.a);
      const answerOf = el.dataset.cmpRight === 'a' ? pr.a.answerValue : pr.b.answerValue;
      try {
        await rate(right, 'right');
        await rate(wrong, 'wrong', answerOf !== undefined ? { answer: answerOf } : {});
        await loadCompare(page.compare.a, page.compare.b); await loadProgram(); render();
      } catch (e) { errToast(e.message); }
    });
    on('[data-cmp-neither]', async el => {
      try { await rate(el.dataset.a, 'wrong'); await rate(el.dataset.b, 'wrong'); await loadCompare(page.compare.a, page.compare.b); await loadProgram(); render(); }
      catch (e) { errToast(e.message); }
    });
    root.querySelectorAll('[data-pg-cmp]').forEach(s => { s.onchange = () => {
      const a = root.querySelector('[data-pg-cmp=a]').value, b = root.querySelector('[data-pg-cmp=b]').value;
      loadCompare(a, b).then(render).catch(e => errToast(e.message));
    }; });
    const vsel = root.querySelector('[data-pg-version]');
    if (vsel) vsel.onchange = () => { page.filter.version = vsel.value; loadRuns().then(renderTable); };
    const tests = root.querySelector('[data-pg-tests]');
    if (tests) tests.onchange = () => { page.filter.tests = tests.checked; loadRuns().then(renderTable); };
    const q = root.querySelector('#pgQuery');
    if (q) { let t = null; q.oninput = () => { clearTimeout(t); t = setTimeout(() => { page.filter.q = q.value; loadRuns().then(() => { const at = q.selectionStart; renderTable(); const box = view().querySelector('#pgQuery'); if (box) { box.focus(); box.setSelectionRange(at, at); } }); }, 220); }; }
    root.querySelectorAll('.pg-tr').forEach(tr => {
      tr.querySelector('.pg-row-line').onclick = e => {
        const quick = e.target.closest('[data-quick]');
        if (quick) {
          e.stopPropagation();
          if (quick.dataset.quick === 'right') rate(tr.dataset.run, 'right').then(() => loadRunsQuiet()).then(renderTable).catch(err => errToast(err.message));
          else openRun(tr.dataset.run, { render: false }).then(() => { page.correcting = true; renderTable(); scrollToOpen(); });
          return;
        }
        if (e.target.closest('button, a')) return;
        openRun(tr.dataset.run);
      };
    });
    const form = root.querySelector('#pgCorrect');
    if (form) wireCorrection(form);
  }
  function wireCorrection(form) {
    const inCheck = !!page.check;
    const d = inCheck ? page.check.detail : page.detail;
    const send = extra => {
      if (form.dataset.busy) return;
      form.dataset.busy = '1';
      const note = form.querySelector('#pgNote').value.trim();
      const all = { ...extra, ...(note ? { note } : {}) };
      (inCheck ? checkStep('wrong', all) : judgeOpen('wrong', all)).finally(() => { delete form.dataset.busy; });
    };
    form.onsubmit = e => {
      e.preventDefault();
      const pick = e.submitter && e.submitter.dataset.pick;
      if (pick !== undefined) return send({ answer: JSON.parse(pick) });
      const el = form.querySelector('#pgAnswer');
      if (!el) return;
      try { send({ answer: readEditor(el) }); } catch (err) { errToast(err.message); }
    };
    form.querySelector('[data-pg-unknown]').onclick = () => send({});
    const cancel = () => { if (inCheck) { page.check.correcting = false; render(); } else { page.correcting = false; renderTable(); } };
    form.querySelector('[data-pg-cancel]').onclick = cancel;
    form.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        const b = form.querySelectorAll('[data-pick]')[n - 1];
        if (b) { e.preventDefault(); send({ answer: JSON.parse(b.dataset.pick) }); }
      }
    });
    setTimeout(() => {
      const target = form.querySelector('#pgAnswer') || form.querySelector('[data-pick]');
      if (target) { target.focus({ preventScroll: true }); if (target.select) target.select(); }
    }, 0);
  }
  // Keys on a program's page: j/k move, 1 right, 2 wrong, esc close.
  document.addEventListener('keydown', e => {
    if (!onPage('program') || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && t.closest && (t.closest('#pgCorrect') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)) return;
    if (page.check) {
      const c = page.check;
      if (c.correcting) return;
      if (e.key === '1') { e.preventDefault(); checkStep('right'); }
      else if (e.key === '2') { e.preventDefault(); c.correcting = true; render(); }
      else if (e.key === 's') { e.preventDefault(); checkStep('skip'); }
      return;
    }
    if (page.tab !== 'examples' || page.correcting) return;
    if (e.key === 'j' || e.key === 'k') {
      e.preventDefault();
      if (!page.runs.length) return;
      const i = page.runs.findIndex(r => r.id === page.open);
      const next = page.runs[i < 0 ? 0 : Math.max(0, Math.min(page.runs.length - 1, i + (e.key === 'j' ? 1 : -1)))];
      if (next && next.id !== page.open) openRun(next.id);
      return;
    }
    if (!page.detail || !page.detail.run.content || page.detail.run.error) return;
    if (e.key === '1') { e.preventDefault(); judgeOpen('right'); }
    else if (e.key === '2') { e.preventDefault(); page.correcting = true; renderTable(); }
    else if (e.key === 'Escape' && page.open) { e.preventDefault(); openRun(page.open); }
  });

  window.Programs = { panelHtml, wireHost, showList, showProgram, dispatch, describe, hashFor, parseHash, loadList };
})();
