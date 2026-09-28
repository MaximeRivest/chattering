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
    // Following starts once the panel is on screen.
    setTimeout(syncLive, 0);
    const all = list.data.programs.filter(p => matches(p, project, list.query));
    // A program whose first call is running is not in the log yet.
    const known = new Set(list.data.programs.map(p => JSON.stringify([p.name, p.module])));
    const first = project ? [] : [...new Map([...live.calls.values()].filter(c => running(c) && !known.has(JSON.stringify([c.name, c.module])))
      .filter(c => matches({ name: c.name, module: c.module }, '', list.query)).map(c => [JSON.stringify([c.name, c.module]), c])).values()];
    const rows = first.map(c => `<div class="ag-row pg-row" data-program="${h(JSON.stringify([c.name, c.module]))}">
      <button type="button" class="ag-main"><span class="ag-title"><span class="pg-glyph" aria-hidden="true">ƒ</span><span class="pg-row-name">${h(c.name)}</span></span>
      <span class="pg-row-sub"><span class="pg-live-mark"><span class="pg-live-dot" aria-hidden="true"></span> its first call is running</span></span></button></div>`).join('')
      + all.map(p => `<div class="ag-row pg-row" data-program="${h(JSON.stringify([p.name, p.module]))}">
      <button type="button" class="ag-main"><span class="ag-title"><span class="pg-glyph" aria-hidden="true">ƒ</span><span class="pg-row-name">${h(p.name)}</span><span class="ag-age">${h(ago(p.last))}</span></span>
      <span class="pg-row-sig">${signatureHtml(p)}</span><span class="pg-row-sub">${statusWords(p)}${liveMarkHtml(p.name, p.module)}</span></button></div>`).join('');
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

  const onPage = kind => typeof viewKind !== 'undefined' && viewKind === kind;

  async function showList() {
    call('markSettingsClosed');
    call('setRoute', 'programs', 'programs');
    view().innerHTML = '<div class="empty">reading the call log…</div>';
    try { await loadList(true); } catch (e) { view().innerHTML = `<div class="empty">${h(e.message)}</div>`; return; }
    if (onPage('programs')) renderList();
  }
  function renderList() {
    const data = list.data;
    const groups = new Map();
    for (const p of data.programs.filter(p => matches(p, '', list.query))) {
      const g = p.own ? 'Chattering itself' : projectName(p.project) || 'no project';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p);
    }
    if (groups.has('Chattering itself')) { const own = groups.get('Chattering itself'); groups.delete('Chattering itself'); groups.set('Chattering itself', own); }
    const cards = [...groups].map(([g, ps]) => `<section class="pg-group"><h2>${h(g)}</h2>${ps.map(p => `
      <button type="button" class="pg-card" data-program="${h(JSON.stringify([p.name, p.module]))}">
        <span class="pg-card-name"><span class="pg-glyph" aria-hidden="true">ƒ</span> ${h(p.name)}</span>
        <span class="pg-card-sig">${signatureHtml(p)}</span>
        ${p.instruction ? `<span class="pg-card-what">${h(firstParagraph(p.instruction))}</span>` : ''}
        <span class="pg-card-status">${statusWords(p)}<span data-live-mark>${liveMarkHtml(p.name, p.module)}</span></span>
      </button>`).join('')}</section>`).join('');
    const canEdit = typeof settingsState === 'undefined' || !settingsState || settingsState.canEditSettings !== false;
    view().innerHTML = `<div class="pg-view pg-list">
      <div class="pg-title"><h1>AI programs</h1>
        <p class="pg-lede">Functions whose body is a model call. See what each one really answers, and say when it is wrong.</p></div>
      <div data-live-list>${liveListHtml()}</div>
      ${data.programs.length > 6 ? `<input type="search" id="pgListSearch" class="pg-list-search" placeholder="Find a program" value="${h(list.query)}">` : ''}
      ${data.programs.length ? cards || '<p class="pg-dim">No program matches.</p>' : howToHtml(data.folder)}
      <details class="pg-fine"><summary>Where this comes from</summary>
        <p>FunctAI, in Python or TypeScript, writes every call to <code>${h(data.folder)}</code>. Your judgements go to the same folder, so FunctAI reads them too.</p>
        <label class="pg-switch"><input type="checkbox" data-pg-record ${data.recordAgents ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
          Also record the programs that agents run from Chattering <span class="pg-dim">(new agent runs only)</span></label></details>
    </div>`;
    const root = view();
    root.querySelectorAll('.pg-card[data-program]').forEach(b => { b.onclick = () => { const [name, module] = JSON.parse(b.dataset.program); showProgram(name, module); }; });
    wireLiveList(root);
    tickerSync();
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

  async function showProgram(name, module, { tab = 'examples', run = null, live: liveId = null } = {}) {
    call('markSettingsClosed');
    if (page.name !== name || page.module !== module) Object.assign(page, { name, module, program: null, versions: [], runs: [], counts: null, answers: [], total: 0,
      open: null, detail: null, correcting: false, check: null, compare: null, key: null, filter: fresh(), limit: 50, seq: -1, showSame: false });
    page.firstRun = false;
    page.tab = ['examples', 'compare', 'key', 'about'].includes(tab) ? tab : 'examples';
    if (liveId) { live.open = liveId; page.tab = 'examples'; }
    call('setRoute', 'program', hashFor({ name, module, tab: page.tab, run }));
    view().innerHTML = '<div class="empty">reading the call log…</div>';
    try { await loadProgram(); }
    catch (e) {
      if (!samePage(name, module)) return;
      // Its first call is running: it is in the log once it ends.
      if (liveOf(name, module).length) { page.firstRun = true; return renderFirstRun(); }
      view().innerHTML = `<div class="pg-view"><p class="empty">${h(e.message)}</p><p><button type="button" class="ghost" data-programs-all>← all AI programs</button></p></div>`; view().querySelector('[data-programs-all]').onclick = showList; return;
    }
    await loadTab();
    if (!samePage(name, module)) return;
    if (run) await openRun(run, { render: false });
    render();
    if (run) scrollToOpen();
    else if (liveId) scrollToLive(liveId);
  }
  const samePage = (name, module) => onPage('program') && page.name === name && page.module === module;
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
    return `<div class="pg-status"><p class="pg-status-line">${week}${fails}<span data-live-note>${liveNoteHtml()}</span></p>${measured}</div>`;
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
      <div data-live-section>${liveSectionHtml()}</div>
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

  // ---- Live: Chattering's own programs, watched while they run ----
  // A tab on these pages (or with the Programs panel open) follows the calls
  // running now on its event stream: first a snapshot, then every change in
  // order, and a word whenever the call log moves (any writer: a call, a
  // judgement). Nothing is asked every few seconds. What is shown while a
  // call runs is provisional: a reply that cannot be read is asked again,
  // and the typed, checked answer is the finished example's.
  const live = { calls: new Map(), mode: 'off', conn: null, asking: false, again: false, seq: null, clock: 0, skew: 0,
    open: null, thinkingOpen: new Set(), reload: null, moved: null, ticker: null, panelTimer: null };
  const running = c => c.state === 'running';
  const liveOf = (name, module) => [...live.calls.values()].filter(c => c.name === name && c.module === module);
  const panelShown = () => { const el = document.querySelector('.pg-lib'); return !!(el && el.offsetParent); };
  const liveWanted = () => !document.hidden && (onPage('programs') || onPage('program') || panelShown());
  const connNow = () => (typeof peopleState !== 'undefined' && peopleState && peopleState.conn) || null;
  async function syncLive() {
    if (live.asking) { live.again = true; return; }
    const want = liveWanted(), conn = connNow();
    live.asking = true;
    try {
      if (want && conn && (live.mode === 'off' || live.conn !== conn)) {
        live.mode = 'joining'; live.conn = conn;
        await post('/api/programs/live', { conn, follow: true });
        if (live.conn === conn && live.mode === 'joining') live.mode = 'on';
      } else if (!want && live.mode !== 'off') {
        const was = live.conn;
        Object.assign(live, { mode: 'off', conn: null });
        live.calls.clear();
        if (was) await post('/api/programs/live', { conn: was, follow: false }).catch(() => {});
      }
    } catch { live.mode = 'off'; live.conn = null; }
    finally { live.asking = false; }
    if (live.again) { live.again = false; syncLive(); }
  }
  window.addEventListener('chattering:route', () => syncLive());
  document.addEventListener('visibilitychange', () => syncLive());
  // The panel can close without telling anyone; a follower that nobody
  // looks at stops within a few seconds.
  setInterval(() => { if (live.mode !== 'off' || liveWanted()) syncLive(); }, 8000);
  // A new event stream (a reconnect, a restarted server): follow again on it.
  function connected() { live.mode = 'off'; live.conn = null; live.calls.clear(); repaintLive(); syncLive(); }

  function onLive(ev) {
    if (live.mode === 'off') return;
    if (typeof ev.now === 'number') live.skew = Date.now() - ev.now;
    let shape = false;
    const touched = new Map(); // call id → repaint its row (true) or add the new text (false)
    const mark = (id, repaint = false) => touched.set(id, touched.get(id) || repaint);
    for (const op of ev.ops || []) {
      if (op.op === 'snapshot') {
        live.calls = new Map((op.calls || []).map(c => [c.id, c]));
        for (const c of live.calls.values()) if (!running(c)) c.endedAt = ++live.clock;
        live.mode = 'on'; shape = true;
        if (op.seq != null) logMoved(op.seq);
        continue;
      }
      if (op.op === 'log') { logMoved(op.seq, op.programs); continue; }
      if (op.op === 'start') { if (!live.calls.has(op.id)) { live.calls.set(op.id, op.call); shape = true; } continue; }
      const c = live.calls.get(op.id);
      if (!c) continue;
      if (op.op === 'gone') { live.calls.delete(op.id); shape = true; continue; }
      if (!(op.v > c.v)) continue; // already in the snapshot
      c.v = op.v;
      if (op.op === 'text') {
        let f = c.fields.find(x => x.name === op.field);
        if (!f) { f = { name: op.field, answer: op.answer, text: '', cut: false }; c.fields.push(f); }
        f.text += op.text;
        if (op.cut) f.cut = true;
        mark(c.id, !!op.cut);
      } else if (op.op === 'thinking') {
        c.thinking += op.text;
        if (op.cut) c.thinkingCut = true;
        mark(c.id, !!op.cut);
      } else if (op.op === 'reset') {
        c.fields = []; c.thinking = ''; c.thinkingCut = false; c.attempt = op.attempt;
        if (op.reason) c.retry = { reason: op.reason, wait: op.wait };
        mark(c.id, true);
      } else if (op.op === 'end') {
        Object.assign(c, { state: op.state, ended: op.ended, seconds: op.seconds, error: op.error, endedAt: ++live.clock });
        shape = true;
      }
    }
    if (shape) repaintLive();
    // After any repaint: the patch adds only what a row does not show yet.
    for (const [id, repaint] of touched) { const c = live.calls.get(id); if (c) patchLive(c, repaint); }
  }

  // The log moved: read again what is on screen, unless the person is in
  // the middle of something (a correction, a check, typing), then a moment
  // later. Calls that had ended before the reading began are in the
  // examples now: they leave "Running now".
  function logMoved(seq, programs) {
    live.seq = seq;
    live.moved = mergeMoved(live.moved, Array.isArray(programs) ? new Set(programs.map(p => JSON.stringify(p))) : 'all');
    clearTimeout(live.reload);
    live.reload = setTimeout(reloadForLog, 120);
  }
  // Which programs moved since the last reading: a set of keys, or 'all'.
  const mergeMoved = (a, b) => (a === 'all' || b === 'all' ? 'all' : !a ? b : !b ? a : new Set([...a, ...b]));
  async function reloadForLog() {
    const seq = live.seq, upTo = live.clock, moved = live.moved;
    live.moved = null;
    const later = () => { live.moved = mergeMoved(moved, live.moved); live.reload = setTimeout(reloadForLog, 1500); };
    const typing = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    try {
      if (onPage('program')) {
        if (page.firstRun) {
          try { await loadProgram(); } catch { return settle(upTo); }
          page.firstRun = false;
          await loadTab();
          settle(upTo);
          return render();
        }
        if (!page.program) return;
        // A page on another program stays as it is.
        const here = !moved || moved === 'all' || moved.has(JSON.stringify([page.name, page.module]));
        if (page.seq !== seq && !here) page.seq = seq;
        if (page.seq !== seq) {
          if (page.correcting || page.check || busy || typing) return later();
          await loadProgram(); await loadTab();
          if (!onPage('program')) return;
          settle(upTo);
          render();
          if (page.open) scrollToOpen();
          return;
        }
      } else if (onPage('programs')) {
        if (!list.data || list.data.seq !== seq) {
          if (typing) return later();
          await loadList(true);
          if (onPage('programs')) renderList();
        }
      }
      if (panelShown() && (!list.data || list.data.seq !== seq)) { await loadList(true); schedulePanel(); }
    } catch {}
    settle(upTo);
  }
  // Ended calls counted up to `upTo` are in the examples now.
  function settle(upTo) {
    let moved = false, landed = null;
    for (const c of live.calls.values()) {
      if (running(c) || c.settled || !(c.endedAt <= upTo)) continue;
      c.settled = true; moved = true;
      if (live.open === c.id) { live.open = null; landed = c; }
    }
    if (!moved) return;
    // The person was watching it: open the finished example, ready to judge.
    if (landed && onPage('program') && page.tab === 'examples' && !page.check && page.runs.some(r => r.id === landed.id)) {
      page.open = null;
      openRun(landed.id, { render: false }).then(() => { renderTable(); scrollToOpen(); });
      return;
    }
    repaintLive();
  }
  // What "Running now" shows on a program's page: its calls, until they are in the examples.
  const shownLive = () => liveOf(page.name, page.module).filter(c => !c.settled).reverse();

  // ---- words for a call in progress ----
  const serverNow = () => Date.now() - live.skew;
  const since = c => Math.max(0, (serverNow() - Date.parse(c.started)) / 1000);
  const elapsed = s => (s < 60 ? Math.floor(s) + ' s' : Math.floor(s / 60) + ' min ' + String(Math.floor(s % 60)).padStart(2, '0') + ' s');
  const tail = (text, n) => (text.length > n ? '…' + text.slice(-n).replace(/^\S{0,20}\s/, '') : text);
  const writing = c => c.fields.length ? c.fields[c.fields.length - 1] : null;
  function liveState(c) {
    if (c.state === 'done') return { cls: 'good', words: '✓ done', sub: `in ${secs(c.seconds)}` };
    if (c.state === 'failed') return { cls: 'bad', words: '! failed', sub: c.error ? c.error.type : '' };
    if (c.state === 'cancelled') return { cls: 'dim', words: 'stopped', sub: '' };
    const doing = c.fields.length ? 'writing' : c.thinking ? 'thinking' : c.attempt > 1 ? 'asking again' : 'waiting for the model';
    return { cls: 'run', words: doing, sub: c.attempt > 1 ? `attempt ${c.attempt}` : '', since: true };
  }
  function stateHtml(c) {
    const st = liveState(c);
    return `<span class="pg-live-state ${st.cls}">${h(st.words)}${st.since ? ` · <span data-live-since="${h(c.id)}">${elapsed(since(c))}</span>` : ''}</span>${st.sub ? `<span class="pg-v-sub">${h(st.sub)}</span>` : ''}`;
  }
  function liveInputs(c) {
    if (!c.content) {
      const total = Object.values(c.sizes || {}).reduce((a, b) => a + b, 0);
      return `<span class="pg-dim">too large to keep: only its size is recorded (${plural(total, 'character')})</span>`;
    }
    const entries = Object.entries(c.inputs || {});
    const line = v => v.line ?? v.text;
    const text = entries.length === 1 ? line(entries[0][1]) : entries.map(([k, v]) => `${k}: ${line(v).slice(0, 280)}`).join('\n');
    return h(text.slice(0, 600));
  }
  function tailHtml(c, n = 160) {
    const f = writing(c);
    const caret = running(c) ? '<span class="pg-caret" aria-hidden="true"></span>' : '';
    if (f) return `<span class="pg-live-text">${(c.outputs || []).length > 1 ? `<span class="pg-dim">${h(f.name)}:</span> ` : ''}${h(tail(f.text, n))}${caret}</span>`;
    if (c.thinking) return `<span class="pg-live-text pg-live-thought">${h(tail(c.thinking, n))}${caret}</span>`;
    if (c.state === 'failed' && c.error) return `<span class="pg-bad">${h(c.error.message || c.error.type)}</span>`;
    return running(c) ? `<span class="pg-live-text pg-dim">…${caret}</span>` : '';
  }
  // Who asked, in words: the conversation, project or file it is for.
  function liveWho(c, { links = true } = {}) {
    const k = c.caller || {};
    const link = (attr, value, text) => links ? `<button type="button" class="linkish" ${attr}="${h(value)}">${h(text)}</button>` : `<b>${h(text)}</b>`;
    const about = k.conversation ? 'for ' + link('data-open-conv', k.conversation, sessionTitle(k.conversation))
      : k.project ? 'for the project ' + h(projectName(k.project) || k.project)
      : k.file ? 'on ' + link('data-open-file', k.file, base(k.file))
      : k.repository ? 'in ' + h(base(k.repository)) : '';
    const who = k.automatic ? 'in the background' : k.user ? 'asked by ' + h(k.user) : '';
    return [about, who].filter(Boolean).join(', ');
  }

  // ---- a program's page: "Running now", above the examples ----
  function liveSectionHtml() {
    if (page.check || page.tab !== 'examples') return '';
    const calls = shownLive();
    if (!calls.length) return '';
    const now = calls.filter(running).length;
    return `<section class="pg-live" aria-label="Running now">
      <h3 class="pg-live-title">${now ? '<span class="pg-live-dot" aria-hidden="true"></span> Running now' : 'Just finished'}${calls.length > 1 ? ` <span class="pg-count">${num(calls.length)}</span>` : ''}</h3>
      <div class="pg-table pg-live-table" role="table" aria-label="Calls running now">${calls.map(liveRowHtml).join('')}</div></section>`;
  }
  function liveRowHtml(c) {
    const open = live.open === c.id;
    return `<div class="pg-tr pg-live-tr is-${h(c.state)} ${open ? 'open' : ''}" role="row" data-live="${h(c.id)}" tabindex="0" aria-expanded="${open}" aria-busy="${running(c)}">
      <div class="pg-row-line"><span role="cell" class="pg-td pg-td-in">${liveInputs(c)}</span>
        <span role="cell" class="pg-td pg-td-out pg-live-out" data-live-tail>${tailHtml(c)}</span>
        <span role="cell" class="pg-td pg-td-v" data-live-state>${stateHtml(c)}</span></div>
      ${open ? liveOpenHtml(c) : ''}</div>`;
  }
  function liveOpenHtml(c) {
    const names = [...new Set([...(c.outputs || []), ...c.fields.map(f => f.name)])];
    const many = names.length > 1;
    const outs = names.map(n => {
      const f = c.fields.find(x => x.name === n);
      const answer = n === c.answer && many;
      return `<div class="pg-field${answer ? ' pg-answer' : ''}">${many ? `<div class="pg-field-name">${h(n)}</div>` : ''}<div class="pg-field-value${f ? '' : ' pg-dim'}" data-live-field="${h(n)}" data-len="${f ? f.text.length : 0}"${f ? '' : ' data-empty="1"'}>${f ? h(f.text) : running(c) ? '…' : '—'}</div>${f && f.cut ? '<div class="pg-dim pg-live-cut">… the rest is in the finished example</div>' : ''}</div>`;
    }).join('');
    const ins = c.content ? Object.entries(c.inputs || {}).map(([k, v]) => `<div class="pg-field">${Object.keys(c.inputs).length > 1 ? `<div class="pg-field-name">${h(k)}</div>` : ''}<div class="pg-field-value">${h(v.text)}${v.cut ? '<span class="pg-dim"> …</span>' : ''}</div></div>`).join('') || '<p class="pg-dim">—</p>'
      : `<p class="pg-dim">Too large to keep: only sizes are recorded. ${Object.entries(c.sizes || {}).map(([k, n]) => `${h(k)}: ${plural(n, 'character')}`).join(', ')}.</p>`;
    const st = liveState(c);
    const retry = c.retry && c.attempt > 1 ? `<p class="pg-warn pg-live-retry">Asked again (attempt ${num(c.attempt)}): ${h(c.retry.reason)}</p>` : '';
    const who = liveWho(c);
    const thinking = c.thinking || running(c) && c.fields.length === 0 ? `<details class="pg-fold" data-live-thinking-fold ${live.thinkingOpen.has(c.id) ? 'open' : ''} ${c.thinking ? '' : 'hidden'}><summary>What the model is thinking</summary><pre class="pg-live-thinking" data-live-thinking data-len="${c.thinking.length}">${h(c.thinking)}</pre>${c.thinkingCut ? '<p class="pg-dim">… (the rest is not shown)</p>' : ''}</details>` : '';
    const end = c.state === 'failed' && c.error ? `<p class="pg-bad pg-errline"><b>${h(c.error.type)}</b>${c.error.code ? ' · ' + h(c.error.code) : ''}${c.error.message ? ': ' + h(c.error.message) : ''}</p>`
      : c.state === 'cancelled' ? '<p class="pg-dim">It was stopped before it finished.</p>'
      : c.state === 'done' ? '<p class="pg-dim">Done. It moves into the examples below, where you can judge it.</p>'
      : '<p class="pg-dim">Still being written. This text is provisional: a reply that cannot be read is asked again, and the checked answer arrives when it is done.</p>';
    return `<div class="pg-open pg-live-open" aria-label="This call, as it runs">
      <div class="pg-live-head"><button type="button" class="linkish" data-live-close>close</button><span class="pg-live-state ${st.cls}">${h(st.words)}${st.since ? ` · <span data-live-since="${h(c.id)}">${elapsed(since(c))}</span>` : ''}</span>${who ? `<span class="pg-dim">${who}</span>` : ''}</div>
      <div class="pg-pair"><section><h3 class="pg-in-h">input</h3>${ins}</section><section><h3 class="pg-out-h">output${running(c) ? ' <span class="pg-dim">so far</span>' : ''}</h3>${outs}</section></div>
      ${retry}${thinking}${end}</div>`;
  }
  // New text for one call: add what each place does not show yet, without
  // painting the rest again (a selection or a scroll inside stays where it
  // is). Each place knows how much it shows (data-len), so this can follow
  // any repaint.
  function patchLive(c, repaint = false) {
    const rows = view().querySelectorAll(`[data-live="${CSS.escape(c.id)}"], [data-live-go="${CSS.escape(c.id)}"]`);
    if (!rows.length) return;
    if (repaint) return repaintRow(c);
    const grow = (el, text) => {
      const have = Number(el.dataset.len || 0);
      if (text.length <= have) return;
      if (el.dataset.empty) { el.textContent = ''; delete el.dataset.empty; el.classList.remove('pg-dim'); }
      const more = text.slice(have), last = el.lastChild;
      if (last && last.nodeType === 3) last.appendData(more); else el.append(more);
      el.dataset.len = String(text.length);
    };
    for (const row of rows) {
      if (row.matches('[data-live]') && live.open === c.id) {
        for (const f of c.fields) {
          const el = row.querySelector(`[data-live-field="${CSS.escape(f.name)}"]`);
          if (!el) return repaintRow(c);
          grow(el, f.text);
        }
        if (c.thinking) {
          const el = row.querySelector('[data-live-thinking]');
          if (!el) return repaintRow(c);
          grow(el, c.thinking);
          const fold = row.querySelector('[data-live-thinking-fold]');
          if (fold) fold.hidden = false;
        }
      }
      row.querySelectorAll('[data-live-tail]').forEach(el => { el.innerHTML = tailHtml(c, row.matches('[data-live-go]') ? 220 : 160); });
      row.querySelectorAll('[data-live-state]').forEach(el => { el.innerHTML = stateHtml(c); });
    }
  }
  function repaintRow(c) {
    const row = view().querySelector(`[data-live="${CSS.escape(c.id)}"]`);
    if (row) { const wrap = document.createElement('div'); wrap.innerHTML = liveRowHtml(c); const fresh = wrap.firstElementChild; row.replaceWith(fresh); wireLive(fresh.parentElement || view()); }
    const item = view().querySelector(`[data-live-go="${CSS.escape(c.id)}"]`);
    if (item) { const wrap = document.createElement('div'); wrap.innerHTML = liveItemHtml(c); item.replaceWith(wrap.firstElementChild); wireLiveList(view()); }
  }
  // Calls began, ended or went: paint the live parts again (the rest of the
  // page stays), and only those whose content changed: a call of another
  // program starting leaves an open one, and a selection in it, alone.
  // Their shape, not their text: the text is patched in place as it comes.
  const shapeOf = calls => JSON.stringify([page.tab, !!page.check, live.open, calls.map(c => [c.id, c.state, c.attempt, c.fields.map(f => f.name + (f.cut ? '…' : '')), !!c.thinking])]);
  const paintSlot = (slot, shape, html, wireIt) => {
    if (!slot || slot.dataset.shape === shape) return;
    slot.innerHTML = html(); slot.dataset.shape = shape;
    wireIt(slot);
  };
  function repaintLive() {
    if (onPage('program')) {
      if (page.firstRun) renderFirstRun();
      else {
        paintSlot(view().querySelector('[data-live-section]'), shapeOf(shownLive()), liveSectionHtml, wireLive);
        paintSlot(view().querySelector('[data-live-note]'), shapeOf(liveOf(page.name, page.module).filter(running)), liveNoteHtml, wire);
      }
    } else if (onPage('programs')) {
      paintSlot(view().querySelector('[data-live-list]'), shapeOf([...live.calls.values()].filter(running)), liveListHtml, wireLiveList);
      view().querySelectorAll('.pg-card[data-program]').forEach(card => {
        const [n, m] = JSON.parse(card.dataset.program);
        const el = card.querySelector('[data-live-mark]');
        if (el) el.innerHTML = liveMarkHtml(n, m);
      });
    }
    schedulePanel();
    tickerSync();
  }
  // On another tab than Examples: a word that calls are running, one click away.
  function liveNoteHtml() {
    const n = liveOf(page.name, page.module).filter(running).length;
    if (!n || (page.tab === 'examples' && !page.check)) return '';
    return ` · <button type="button" class="linkish pg-live-note" data-pg-tab="examples"><span class="pg-live-dot" aria-hidden="true"></span> ${n === 1 ? 'running now' : num(n) + ' running now'}</button>`;
  }
  function wireLive(root) {
    root.querySelectorAll('[data-live]').forEach(tr => {
      const toggle = () => { live.open = live.open === tr.dataset.live ? null : tr.dataset.live; const c = live.calls.get(tr.dataset.live); if (c) repaintRow(c); };
      const line = tr.querySelector('.pg-row-line');
      if (line) line.onclick = e => { if (!e.target.closest('button, a')) toggle(); };
      tr.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === tr) { e.preventDefault(); toggle(); } };
      const close = tr.querySelector('[data-live-close]');
      if (close) close.onclick = e => { e.preventDefault(); toggle(); tr.focus({ preventScroll: true }); };
      const fold = tr.querySelector('[data-live-thinking-fold]');
      if (fold) fold.ontoggle = () => { if (fold.open) live.thinkingOpen.add(tr.dataset.live); else live.thinkingOpen.delete(tr.dataset.live); };
      tr.querySelectorAll('[data-open-conv]').forEach(b => { b.onclick = e => { e.preventDefault(); call('open', b.dataset.openConv); }; });
      tr.querySelectorAll('[data-open-file]').forEach(b => { b.onclick = e => { e.preventDefault(); call('openLiveFile', b.dataset.openFile, {}); }; });
    });
  }
  function scrollToLive(id) {
    const el = view().querySelector(`[data-live="${CSS.escape(id)}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
  // A program whose first call is still running: not in the log yet.
  function renderFirstRun() {
    const calls = liveOf(page.name, page.module).reverse();
    if (!calls.length) { page.firstRun = false; return showProgram(page.name, page.module); }
    view().innerHTML = `<div class="pg-view"><nav class="pg-crumb"><button type="button" class="linkish" data-programs-all>AI programs</button></nav>
      <div class="pg-title"><h1><span class="pg-glyph" aria-hidden="true">ƒ</span> ${h(page.name)}</h1>
        <p class="pg-lede">${calls.some(running) ? 'Its first call is running now. Its page fills in when the call is done.' : 'Its first call just ended.'}</p></div>
      <div class="pg-body"><section class="pg-live pg-first-run" aria-label="Running now"><div class="pg-table pg-live-table" role="table">${calls.map(liveRowHtml).join('')}</div></section></div></div>`;
    wire(view());
    tickerSync();
  }

  // ---- every program: the calls running now, across all of them ----
  const LIST_LIVE = 12; // background work can run many at once: the newest, then a count
  function liveListHtml() {
    const calls = [...live.calls.values()].filter(running).reverse();
    if (!calls.length) return '';
    const more = calls.length - LIST_LIVE;
    return `<section class="pg-group pg-live-group" aria-label="Running now"><h2><span class="pg-live-dot" aria-hidden="true"></span> Running now <span class="pg-count">${num(calls.length)}</span></h2>
      <div class="pg-live-items">${calls.slice(0, LIST_LIVE).map(liveItemHtml).join('')}</div>
      ${more > 0 ? `<p class="pg-dim pg-live-more">and ${plural(more, 'more call')} running</p>` : ''}</section>`;
  }
  function liveItemHtml(c) {
    const who = liveWho(c, { links: false });
    return `<button type="button" class="pg-live-item" data-live-go="${h(c.id)}" data-program="${h(JSON.stringify([c.name, c.module]))}">
      <span class="pg-live-item-head"><span class="pg-glyph" aria-hidden="true">ƒ</span> <b>${h(c.name)}</b>${who ? ` <span class="pg-dim">${who}</span>` : ''}<span class="pg-live-item-state" data-live-state>${stateHtml(c)}</span></span>
      <span class="pg-live-item-text pg-live-out" data-live-tail>${tailHtml(c, 220)}</span></button>`;
  }
  function wireLiveList(root) {
    root.querySelectorAll('[data-live-go]').forEach(b => { b.onclick = () => { const [name, module] = JSON.parse(b.dataset.program); showProgram(name, module, { live: b.dataset.liveGo }); }; });
  }
  function liveMarkHtml(name, module) {
    const n = liveOf(name, module).filter(running).length;
    return n ? ` · <span class="pg-live-mark"><span class="pg-live-dot" aria-hidden="true"></span> ${n === 1 ? 'running now' : num(n) + ' running now'}</span>` : '';
  }
  // The right panel shows which programs are running; it is painted again
  // only when that changes, and never under a person's typing.
  function schedulePanel() {
    if (!panelRerender || !panelShown()) return;
    clearTimeout(live.panelTimer);
    live.panelTimer = setTimeout(() => {
      const box = document.querySelector('.pg-lib .pg-search');
      if (box && document.activeElement === box) return;
      if (panelShown() && panelRerender) panelRerender();
    }, 200);
  }
  // Elapsed times tick while something runs and is on screen.
  function tickerSync() {
    const any = [...live.calls.values()].some(running);
    if (any && !live.ticker) {
      live.ticker = setInterval(() => {
        const els = document.querySelectorAll('[data-live-since]');
        if (!els.length && ![...live.calls.values()].some(running)) { clearInterval(live.ticker); live.ticker = null; return; }
        els.forEach(el => { const c = live.calls.get(el.dataset.liveSince); if (c && running(c)) el.textContent = elapsed(since(c)); });
      }, 1000);
    } else if (!any && live.ticker) { clearInterval(live.ticker); live.ticker = null; }
  }

  // ---- events ----
  function wire(root) {
    const on = (sel, f) => root.querySelectorAll(sel).forEach(el => { el.onclick = e => { e.preventDefault(); f(el, e); }; });
    wireLive(root);
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

  window.Programs = { panelHtml, wireHost, showList, showProgram, dispatch, describe, hashFor, parseHash, loadList, live: onLive, connected,
    liveInfo: () => ({ mode: live.mode, seq: live.seq, calls: [...live.calls.values()].map(c => ({ id: c.id, name: c.name, state: c.state, settled: !!c.settled })) }) };
})();
