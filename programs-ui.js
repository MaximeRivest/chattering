/* programs-ui.js — AI programs (design/74).

   Every FunctAI program this account has run, from the call log: the list
   (right panel → Programs, and #programs), and one program's page
   (#program={...}) with its calls as rows of inputs and outputs, a review
   queue, its versions side by side, and the rows with known answers that
   FunctAI's evaluate and .opt read. Ratings (right / wrong, and what the right
   answer was) go back to the log, where Python and TypeScript read them too.

   Loaded before the app's main script: nothing here runs at load time except
   definitions; app functions (setRoute, replaceRoute, open, …) are looked up
   when used. */
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

  // ---- small formatters ----
  const num = n => (n == null ? '—' : Number(n).toLocaleString());
  const secs = s => (s == null ? '—' : s < 1 ? Math.round(s * 1000) + ' ms' : s < 10 ? s.toFixed(1) + ' s' : Math.round(s) + ' s');
  const pct = x => (x == null ? '—' : Math.round(x * 100) + '%');
  const age = ts => {
    if (!ts) return '';
    const ms = Date.now() - Date.parse(ts);
    return fn('tinyAge') ? fn('tinyAge')(ms) : new Date(ts).toLocaleDateString();
  };
  const when = ts => (ts ? new Date(ts).toLocaleString() : '');
  const shortVersion = v => (v ? String(v).replace(/^sha256:/, '').slice(0, 7) : '—');
  const langShort = l => ({ python: 'py', typescript: 'ts', javascript: 'js', r: 'R', julia: 'jl' }[l] || l);
  const pretty = v => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v, null, 2));
  const valueType = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  const LOOSE = () => (typeof LOOSE_PROJECT !== 'undefined' ? LOOSE_PROJECT : '');

  // ---- routes: #programs, #program={"name","module","tab","run"} ----
  function hashFor(p) {
    const o = { name: p.name, module: p.module };
    if (p.tab && p.tab !== 'runs') o.tab = p.tab;
    if (p.run) o.run = p.run;
    return 'program=' + encodeURIComponent(JSON.stringify(o));
  }
  function parseHash(hash) {
    let v = String(hash).slice('program='.length);
    if (!v.startsWith('{')) { try { v = decodeURIComponent(v); } catch {} }
    try { const o = JSON.parse(v); if (o && typeof o.name === 'string') return { name: o.name, module: String(o.module ?? ''), tab: o.tab || 'runs', run: o.run || null }; } catch {}
    return null;
  }
  function describe(hash) {
    if (hash === 'programs') return { kind: 'programs', title: 'AI programs' };
    const p = parseHash(hash);
    return { kind: 'program', title: p ? 'program · ' + p.name : 'program' };
  }
  function dispatch(hash) {
    if (hash === 'programs') return showList();
    const p = parseHash(hash);
    if (!p) return showList();
    return showProgram(p.name, p.module, { tab: p.tab, run: p.run });
  }

  // ---- the list (shared by the right panel and #programs) ----
  const list = { data: null, at: 0, loading: null, query: '' };
  function loadList(force = false) {
    if (list.loading) return list.loading;
    if (!force && list.data && Date.now() - list.at < 4000) return Promise.resolve(list.data);
    list.loading = api('/api/programs').then(d => { list.data = d; list.at = Date.now(); return d; })
      .finally(() => { list.loading = null; });
    return list.loading;
  }
  const toReview = p => (p.ratings ? p.ratings.open : 0);
  function matches(p, project, query) {
    if (project && p.project !== project) return false;
    const q = String(query || '').trim().toLowerCase();
    return !q || `${p.name} ${p.module} ${p.project || ''} ${p.file || ''}`.toLowerCase().includes(q);
  }
  function panelRowHtml(p, showProject) {
    const where = [showProject && p.project && p.project !== LOOSE() ? p.project : '', p.recent ? p.recent + ' this week' : num(p.useCalls) + ' calls'].filter(Boolean).join(' · ');
    const flags = [p.errors ? `<span class="pg-flag err" title="${p.errors} failed calls">${p.errors}✗</span>` : '',
      toReview(p) ? `<span class="pg-flag ask" title="judged wrong, the right answer not given yet">${toReview(p)}?</span>` : ''].join('');
    return `<div class="ag-row pg-row" data-program="${h(JSON.stringify([p.name, p.module]))}" title="${h(p.module + ' · ' + p.name + (p.file ? '\n' + p.file : ''))}">` +
      `<button type="button" class="ag-main"><span class="ag-title"><span class="pg-glyph" aria-hidden="true">ƒ</span><span>${h(p.name)}</span>${flags}<span class="ag-age">${h(age(p.last))}</span></span>` +
      `<span class="ag-sub"><span class="ag-dir">${h(where)}${p.languages && p.languages.length ? ' · ' + h(p.languages.map(langShort).join('/')) : ''}</span></span></button></div>`;
  }
  function howToHtml(data) {
    return `<div class="pg-howto">
      <p>An AI program appears here the first time it runs with FunctAI's call log on. Every call is one line in <code>${h(data && data.folder || '~/.local/share/functai/calls')}</code>; Python and TypeScript write the same folder.</p>
      <pre><code># Python\nfunctai.configure(log_calls=True)\n\n// TypeScript\nconfigure({ logCalls: true });\n\n# or, for any process\nFUNCTAI_LOG_CALLS=1</code></pre></div>`;
  }
  let panelRerender = null;
  function panelHtml(project) {
    if (!list.data) {
      loadList().then(() => panelRerender && panelRerender()).catch(e => { list.error = e.message; panelRerender && panelRerender(); });
      return list.error ? `<div class="ag-empty">${h(list.error)}</div>` : '<div class="ag-empty">reading the call log…</div>';
    }
    if (Date.now() - list.at > 15000) loadList(true).then(() => panelRerender && panelRerender()).catch(() => {});
    const all = list.data.programs.filter(p => matches(p, project, list.query));
    const rows = all.map(p => panelRowHtml(p, !project)).join('');
    const empty = list.query ? 'No program matches.' : project && list.data.programs.length ? 'No AI program has run in this project yet.' : '';
    return `<div class="pg-lib"><div class="ag-files-head"><input type="search" class="pg-search" placeholder="Find a program" aria-label="Find a program" value="${h(list.query)}">` +
      `<button type="button" class="ghost pg-all" data-programs-all title="Every program, as a table">all →</button></div>` +
      (rows || (empty ? `<div class="ag-empty">${h(empty)}</div>` : howToHtml(list.data))) + '</div>';
  }
  function wireHost(host, rerender) {
    panelRerender = rerender;
    if (!host || host.dataset.pgWired) return;
    host.dataset.pgWired = '1';
    host.addEventListener('click', e => {
      const row = e.target.closest('[data-program]');
      if (row && host.contains(row) && row.closest('.pg-lib')) { e.stopPropagation(); const [name, module] = JSON.parse(row.dataset.program); showProgram(name, module); return; }
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

  // ---- #programs: every program as a table ----
  let pollTimer = null;
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
  window.addEventListener('chattering:route', () => { if (typeof viewKind === 'undefined' || (viewKind !== 'program' && viewKind !== 'programs')) stopPolling(); });

  async function showList() {
    call('markSettingsClosed');
    stopPolling();
    call('setRoute', 'programs', 'programs');
    view().innerHTML = '<div class="empty">reading the call log…</div>';
    try { await loadList(true); } catch (e) { view().innerHTML = `<div class="empty">${h(e.message)}</div>`; return; }
    renderList();
    const tick = async () => {
      if (typeof viewKind !== 'undefined' && viewKind !== 'programs') return;
      const before = list.data && list.data.seq;
      if (!document.hidden) { try { await loadList(true); if (list.data.seq !== before) renderList(); } catch {} }
      pollTimer = setTimeout(tick, 5000);
    };
    pollTimer = setTimeout(tick, 5000);
  }
  function recordingHtml(data) {
    const canEdit = typeof settingsState === 'undefined' || !settingsState || settingsState.canEditSettings !== false;
    return `<label class="pg-recording" title="Agents started here get FUNCTAI_LOG_CALLS pointing at this folder, and FUNCTAI_CALLER naming their conversation. New agent processes only; a running one keeps what it started with.">
      <input type="checkbox" data-pg-record ${data.recordAgents ? 'checked' : ''} ${canEdit ? '' : 'disabled'}> record the calls agents make from Chattering</label>`;
  }
  function renderList() {
    const data = list.data;
    const rows = data.programs.map(p => `<tr data-program="${h(JSON.stringify([p.name, p.module]))}" tabindex="0">
      <td><span class="pg-glyph">ƒ</span> <b>${h(p.name)}</b><div class="pg-dim">${h(p.module)}${p.languages.length ? ' · ' + h(p.languages.map(langShort).join('/')) : ''}</div></td>
      <td>${h(p.project && p.project !== LOOSE() ? p.project : '—')}</td>
      <td class="n">${num(p.useCalls)}</td><td class="n">${num(p.recent)}</td>
      <td class="n ${p.errors ? 'pg-bad' : ''}">${p.useCalls ? pct(p.errors / p.useCalls) : '—'}</td>
      <td class="n"><span class="pg-good">${p.ratings.right || 0}✓</span> <span class="pg-bad">${p.ratings.wrong || 0}✗</span>${p.ratings.disputed ? ` <span class="pg-warn">${p.ratings.disputed}⚖</span>` : ''}</td>
      <td class="n">${toReview(p) ? `<b class="pg-warn">${toReview(p)}</b>` : '—'}</td>
      <td class="n">${num(p.versions)}</td>
      <td class="n" title="${h(when(p.last))}">${h(age(p.last))}</td></tr>`).join('');
    view().innerHTML = `<div class="pg-view">
      <div class="usage-head pg-head"><div><h1>AI programs</h1><div class="pmeta">functions whose body is a model call, as FunctAI logged them · <code>${h(data.folder)}</code></div></div>${recordingHtml(data)}</div>
      ${data.programs.length ? `<div class="usage-table-wrap"><table class="usage-table pg-table pg-list-table">
        <thead><tr><th>program</th><th>project</th><th>calls</th><th>7 days</th><th>failed</th><th>rated</th><th>to answer</th><th>versions</th><th>last</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : howToHtml(data)}
    </div>`;
    const root = view();
    root.querySelectorAll('tr[data-program]').forEach(tr => {
      const go = () => { const [name, module] = JSON.parse(tr.dataset.program); showProgram(name, module); };
      tr.onclick = go;
      tr.onkeydown = e => { if (e.key === 'Enter') go(); };
    });
    wireRecording(root);
  }
  function wireRecording(root) {
    const box = root.querySelector('[data-pg-record]');
    if (!box) return;
    box.onchange = async () => {
      try { const r = await post('/api/programs/recording', { recordAgents: box.checked }, 'PUT'); list.data.recordAgents = r.recordAgents; toast(r.recordAgents ? 'New agent processes will log their FunctAI calls.' : 'Agents will log only where FunctAI was told to.'); }
      catch (e) { box.checked = !box.checked; errToast(e.message); }
    };
  }

  // ---- one program ----
  const page = {
    name: '', module: '', tab: 'runs', program: null, versions: [], you: '', seq: -1,
    filters: { q: '', rating: '', status: '', version: '', caller: '', purpose: '', from: '' },
    runs: [], total: 0, limit: 60, selected: null, detail: null, correcting: false,
    review: null, compare: null, rated: null, draw: null,
  };
  const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();
  const programQuery = () => ({ name: page.name, module: page.module });

  async function showProgram(name, module, { tab = 'runs', run = null } = {}) {
    call('markSettingsClosed');
    stopPolling();
    const same = page.name === name && page.module === module;
    if (!same) Object.assign(page, { name, module, program: null, versions: [], runs: [], total: 0, selected: null, detail: null, review: null, compare: null, rated: null, draw: null, seq: -1,
      filters: { q: '', rating: '', status: '', version: '', caller: '', purpose: '', from: '' }, correcting: false });
    page.tab = ['runs', 'review', 'versions', 'data'].includes(tab) ? tab : 'runs';
    call('setRoute', 'program', hashFor({ name, module, tab: page.tab, run }));
    view().innerHTML = '<div class="empty">reading the call log…</div>';
    try { await loadProgram(); } catch (e) { view().innerHTML = `<div class="pg-view"><p class="empty">${h(e.message)}</p><p><button type="button" class="ghost" data-programs-all>← all programs</button></p></div>`; view().querySelector('[data-programs-all]').onclick = showList; return; }
    if (run) page.selected = run;
    await loadTab();
    render();
    if (run) await select(run, { scroll: true });
    schedulePoll();
  }
  async function loadProgram() {
    const d = await api('/api/programs/program?' + qs(programQuery()));
    page.program = d.program; page.versions = d.versions; page.you = d.you; page.seq = d.seq;
  }
  async function loadRuns() {
    const d = await api('/api/programs/runs?' + qs({ ...programQuery(), ...page.filters, limit: page.limit }));
    page.runs = d.runs; page.total = d.total; page.seq = d.seq;
  }
  async function loadTab() {
    if (page.tab === 'runs') await loadRuns();
    else if (page.tab === 'review' && page.review) await fillQueue();
    else if (page.tab === 'data') page.rated = await api('/api/programs/rated?' + qs(programQuery()));
  }
  function schedulePoll() {
    stopPolling();
    const tick = async () => {
      if (typeof viewKind !== 'undefined' && viewKind !== 'program') return;
      if (!document.hidden && !page.correcting && page.tab !== 'review') {
        try {
          const d = await api('/api/programs/runs?' + qs({ ...programQuery(), limit: 1 }));
          if (d.seq !== page.seq) { await loadProgram(); await loadTab(); renderKeepingFocus(); }
        } catch {}
      }
      pollTimer = setTimeout(tick, 5000);
    };
    pollTimer = setTimeout(tick, 5000);
  }
  function setTab(tab) {
    page.tab = tab;
    call('replaceRoute', hashFor({ name: page.name, module: page.module, tab }));
    loadTab().then(render).catch(e => errToast(e.message));
  }
  function renderKeepingFocus() {
    const active = document.activeElement && document.activeElement.id;
    const at = document.activeElement && document.activeElement.selectionStart;
    render();
    const el = active && document.getElementById(active);
    if (el) { el.focus({ preventScroll: true }); try { if (at != null) el.setSelectionRange(at, at); } catch {} }
  }

  function sparkHtml(days) {
    const max = Math.max(1, ...days.map(d => d.n));
    const w = 4, gap = 1, height = 26;
    const bars = days.map((d, i) => {
      const bh = d.n ? Math.max(2, Math.round((d.n / max) * height)) : 0;
      const eh = d.errors ? Math.max(1, Math.round((d.errors / max) * height)) : 0;
      return `<rect x="${i * (w + gap)}" y="${height - bh}" width="${w}" height="${bh}" class="pg-bar"><title>${h(d.day)}: ${d.n} calls${d.errors ? ', ' + d.errors + ' failed' : ''}</title></rect>` +
        (eh ? `<rect x="${i * (w + gap)}" y="${height - eh}" width="${w}" height="${eh}" class="pg-bar-err"/>` : '');
    }).join('');
    return `<svg class="pg-spark" viewBox="0 0 ${days.length * (w + gap)} ${height}" width="${days.length * (w + gap)}" height="${height}" role="img" aria-label="calls per day, last 30 days">${bars}</svg>`;
  }
  function measuredHtml(p) {
    const s = p.sample;
    if (s && s.n) {
      return `<span class="v">${pct(s.score)}</span><span class="sub">right on ${s.n} random answered calls of this version · range ${pct(s.low)}–${pct(s.high)}</span>`;
    }
    const all = p.sampleAll;
    return `<span class="v pg-dim">not measured</span><span class="sub">${all && all.n ? `${pct(all.score)} over older versions (${all.n} calls). ` : ''}Only a random draw says how often it is right: <button type="button" class="linkish" data-pg-draw>rate 20 random calls</button></span>`;
  }
  function headHtml() {
    const p = page.program, st = p.stats;
    const place = [p.project && p.project !== LOOSE() ? p.project : '', p.module, p.file ? p.file.split(/[\\/]/).pop() + (p.line ? ':' + p.line : '') : ''].filter(Boolean).join(' · ');
    const other = Object.entries(st.other || {}).map(([k, n]) => `${num(n)} in ${k === 'evaluation' ? 'evaluations' : k === 'optimization' ? 'optimizations' : 'tests'}`).join(', ');
    const tab = (id, label, count) => `<button type="button" role="tab" data-pg-tab="${id}" aria-selected="${page.tab === id}" class="${page.tab === id ? 'on' : ''}">${label}${count ? ` <span class="pg-count">${count}</span>` : ''}</button>`;
    const ratings = p.ratings;
    return `<div class="pg-crumb"><button type="button" class="linkish" data-programs-all>AI programs</button>${p.project && p.project !== LOOSE() ? ' / ' + h(p.project) : ''}</div>
      <div class="usage-head pg-head"><div><h1><span class="pg-glyph">ƒ</span> ${h(p.name)}</h1>
        <div class="pmeta">${h(place)} · ${h((p.languages || []).join(', '))} · version <code title="${h(p.version || '')}">${h(shortVersion(p.version))}</code>${p.versions > 1 ? ` (${p.versions} versions)` : ''}</div></div></div>
      <div class="usage-cards pg-cards">
        <div class="usage-card"><span class="k">calls</span><span class="v">${num(st.use)}</span>${sparkHtml(st.days)}<span class="sub">${num(p.recent)} in 7 days${other ? ' · ' + h(other) + ' not counted' : ''}</span></div>
        <div class="usage-card"><span class="k">failed</span><span class="v ${st.errors ? 'pg-bad' : ''}">${st.use ? pct(st.errors / st.use) : '—'}</span><span class="sub">${num(st.errors)} calls with an error</span></div>
        <div class="usage-card"><span class="k">time</span><span class="v">${secs(st.p50)}</span><span class="sub">half answer faster · 95% under ${secs(st.p95)}</span></div>
        <div class="usage-card"><span class="k">tokens</span><span class="v">${num(st.tokensIn + st.tokensOut)}</span><span class="sub">${num(st.tokensIn)} in · ${num(st.tokensOut)} out · ${h(st.models.map(m => m.name).slice(0, 2).join(', ') || 'no model')}</span></div>
        <div class="usage-card"><span class="k">rated</span><span class="v"><span class="pg-good">${ratings.right}✓</span> <span class="pg-bad">${ratings.wrong}✗</span></span><span class="sub">${ratings.disputed ? ratings.disputed + ' disputed · ' : ''}${ratings.open ? ratings.open + ' wrong, answer unknown' : 'chosen by people: not a fair sample'}</span></div>
        <div class="usage-card pg-measured"><span class="k">right, measured</span>${measuredHtml(p)}</div>
      </div>
      <div class="pg-tabs" role="tablist">${tab('runs', 'Calls', num(st.use))}${tab('review', 'Review', ratings.open || '')}${tab('versions', 'Versions', p.versions > 1 ? p.versions : '')}${tab('data', 'Data', (ratings.right + ratings.wrong + ratings.disputed) || '')}</div>`;
  }
  function render() {
    if (!page.program) return;
    const body = page.tab === 'review' ? reviewHtml() : page.tab === 'versions' ? versionsHtml() : page.tab === 'data' ? dataHtml() : runsHtml();
    view().innerHTML = `<div class="pg-view">${headHtml()}<div class="pg-body">${body}</div></div>`;
    wire(view());
  }

  // ---- Calls ----
  const RATING_LABEL = { right: '✓ right', wrong: '✗ wrong', disputed: '⚖ people disagree' };
  function assessmentHtml(r) {
    if (r.error) return `<span class="pg-bad">✗ ${h(r.error.type)}</span>${r.error.code ? `<div class="pg-dim">${h(r.error.code)}</div>` : ''}`;
    if (!r.rating) return `<span class="pg-quick"><button type="button" data-quick="right" title="Right (the answer is correct for this input)">✓</button><button type="button" data-quick="wrong" title="Wrong: say what the right answer is">✗</button></span>`;
    const cls = r.rating === 'right' ? 'pg-good' : r.rating === 'wrong' ? 'pg-bad' : 'pg-warn';
    return `<span class="${cls}">${RATING_LABEL[r.rating]}</span>${r.ratingOpen ? '<div class="pg-warn">answer unknown</div>' : r.ratedBy > 1 ? `<div class="pg-dim">${r.ratedBy} people</div>` : ''}`;
  }
  function callerLabel(r) {
    const c = r.caller || {};
    if (c.conversation) { const s = (typeof sessions !== 'undefined' ? sessions : []).find(x => x.key === c.conversation); return 'agent · ' + ((s && (s.title || s.timelineTitle)) || 'a conversation'); }
    if (c.notebook) return 'notebook · ' + String(c.notebook).split(/[\\/]/).pop();
    return c.kind || (r.language ? r.language : '');
  }
  function runRowHtml(r) {
    const sel = page.selected === r.id;
    return `<tr class="${sel ? 'on' : ''}" data-run="${h(r.id)}" tabindex="0" aria-selected="${sel}">
      <td class="pg-when" title="${h(when(r.started))}">${h(age(r.started))}<div class="pg-dim">${h(callerLabel(r))}</div></td>
      <td class="pg-in">${r.content ? `<div class="pg-cell">${h(r.inputs)}</div>` : '<span class="pg-dim">values not recorded</span>'}</td>
      <td class="pg-out">${r.content ? (r.error ? `<div class="pg-cell pg-bad">${h(r.error.message || r.error.type)}</div>` : `<div class="pg-cell">${h(r.outputs)}</div>`) : '<span class="pg-dim">—</span>'}</td>
      <td class="pg-meta"><span title="${h(r.model || '')}">${secs(r.seconds)}</span>${r.confidence != null ? `<div class="pg-dim" title="the model's own probability for its answer">${pct(r.confidence)} sure</div>` : ''}${page.program.versions > 1 ? `<div class="pg-dim">v ${h(shortVersion(r.version))}</div>` : ''}</td>
      <td class="pg-assess">${assessmentHtml(r)}</td></tr>`;
  }
  function select_(name, value, options) {
    return `<select data-pg-filter="${name}" aria-label="${name}">${options.map(([v, l]) => `<option value="${h(v)}" ${page.filters[name] === v ? 'selected' : ''}>${h(l)}</option>`).join('')}</select>`;
  }
  function runsHtml() {
    const p = page.program;
    const f = page.filters;
    const versions = [['', 'every version'], ...page.versions.map(v => [v.version || '', 'version ' + shortVersion(v.version) + (v.current ? ' (current)' : '')])];
    const callers = [['', 'every caller'], ...p.stats.callers.map(c => [c.name, c.name + ' (' + c.n + ')'])];
    const sources = p.sources && p.sources.length ? [['', 'from anywhere'], ...p.sources.map(s => [s.ref, sourceLabel(s.ref) + ' (' + s.n + ')'])] : null;
    const filters = `<div class="pg-filters">
      <input type="search" id="pgQuery" placeholder="Search inputs and outputs" aria-label="Search inputs and outputs" value="${h(f.q)}">
      ${select_('rating', f.rating, [['', 'any rating'], ['unrated', 'not rated'], ['right', 'right'], ['wrong', 'wrong'], ['open', 'wrong, answer unknown'], ['disputed', 'people disagree']])}
      ${select_('status', f.status, [['', 'any result'], ['error', 'failed'], ['ok', 'answered']])}
      ${page.versions.length > 1 ? select_('version', f.version, versions) : ''}
      ${p.stats.callers.length > 1 ? select_('caller', f.caller, callers) : ''}
      ${sources ? select_('from', f.from, sources) : ''}
      ${select_('purpose', f.purpose, [['', 'use only'], ['all', 'use, evaluations, tests'], ['evaluation', 'evaluations'], ['optimization', 'optimizations']])}
      <span class="pg-shown">${num(page.runs.length)} of ${num(page.total)}</span></div>`;
    const answer = p.answer || 'result';
    const table = page.runs.length ? `<div class="usage-table-wrap pg-runs-wrap"><table class="pg-table pg-runs pg-calls" aria-label="Calls: inputs and outputs">
      <thead><tr><th>when</th><th class="pg-in-h">input</th><th class="pg-out-h">output <span class="pg-dim">(answer: ${h(answer)})</span></th><th>time</th><th>judged</th></tr></thead>
      <tbody>${page.runs.map(runRowHtml).join('')}</tbody></table></div>
      ${page.runs.length < page.total ? `<p><button type="button" class="ghost" data-pg-more>show ${Math.min(100, page.total - page.runs.length)} more</button></p>` : ''}`
      : `<p class="empty">${Object.values(f).some(Boolean) ? 'No call matches these filters.' : 'No calls yet.'}</p>`;
    return filters + `<div class="pg-split">${table}<div id="pgDetail">${detailHtml()}</div></div>`;
  }
  function sourceLabel(ref) {
    if (ref.startsWith('conversation:')) {
      const key = ref.slice(13), s = (typeof sessions !== 'undefined' ? sessions : []).find(x => x.key === key);
      return 'conversation · ' + ((s && (s.title || s.timelineTitle)) || key.split('/').pop().slice(0, 24));
    }
    if (ref.startsWith('notebook:')) return 'notebook · ' + ref.slice(9).split(/[\\/]/).pop();
    return ref;
  }

  // ---- one call, whole ----
  function fieldsHtml(values, { answer = null, sizes = null } = {}) {
    if (!values || typeof values !== 'object') return '<p class="pg-dim">—</p>';
    return '<dl class="pg-fields">' + Object.entries(values).map(([k, v]) =>
      `<div class="pg-field${k === answer ? ' pg-answer' : ''}"><dt>${h(k)}${k === answer ? ' <span class="pg-dim">· the answer</span>' : ''}${sizes && sizes[k] != null ? ` <span class="pg-dim">· ${num(sizes[k])} chars</span>` : ''}</dt><dd>${h(pretty(v))}</dd></div>`).join('') + '</dl>';
  }
  function partText(part) {
    if (!part || typeof part !== 'object') return '';
    if (part.type === 'text') return part.text || '';
    if (part.type === 'thinking') return '[thinking]\n' + (part.text || '');
    if (part.type === 'tool_call') return `[tool call ${part.name || ''}] ${JSON.stringify(part.input ?? part.arguments ?? {})}`;
    if (part.type === 'tool_result') return `[tool result] ` + (Array.isArray(part.content) ? part.content.map(partText).join(' ') : JSON.stringify(part.content ?? ''));
    if (part.type === 'data') return JSON.stringify(part.value ?? part.data ?? null);
    return `[${part.type || 'part'}]`;
  }
  const messageText = m => (m && Array.isArray(m.parts) ? m.parts.map(partText).join('\n') : m && typeof m.content === 'string' ? m.content : '');
  function exchangesHtml(record) {
    const ex = (record && record.exchanges) || [];
    if (!ex.length) return '';
    return `<div class="pg-exchanges"><h3>What the model saw <span class="pg-dim">${ex.length} request${ex.length > 1 ? 's' : ''}</span></h3>` + ex.map((e, i) => {
      const u = e.usage || {};
      const head = `#${i + 1} · ${h(e.model || '?')}${e.provider ? ' · ' + h(e.provider) : ''} · ${secs(e.seconds)} · ${num(u.input_tokens)} → ${num(u.output_tokens)} tokens${e.finish ? ' · ' + h(e.finish) : ''}${e.cached ? ' · from cache' : ''}${e.error ? ' · <span class="pg-bad">' + h(e.error.type) + '</span>' : ''}`;
      const req = e.request || null, res = e.response || null;
      const body = !req ? '<p class="pg-dim">messages not recorded</p>'
        : (req.system ? `<div class="pg-msg"><div class="pg-role">system</div><pre>${h(typeof req.system === 'string' ? req.system : JSON.stringify(req.system, null, 2))}</pre></div>` : '') +
          (req.messages || []).map(m => `<div class="pg-msg"><div class="pg-role">${h(m.role)}</div><pre>${h(messageText(m))}</pre></div>`).join('') +
          (req.tools && req.tools.length ? `<div class="pg-msg"><div class="pg-role">tools</div><pre>${h(req.tools.map(t => t.name || (t.function && t.function.name) || '?').join(', '))}</pre></div>` : '') +
          (res ? `<div class="pg-msg pg-reply"><div class="pg-role">reply</div><pre>${h(messageText(res.message))}</pre></div>` : '') +
          (e.error ? `<div class="pg-msg"><div class="pg-role">error</div><pre class="pg-bad">${h(e.error.message || e.error.type)}</pre></div>` : '');
      return `<details class="pg-ex" ${i === ex.length - 1 ? 'open' : ''}><summary>${head}</summary>${body}</details>`;
    }).join('') + '</div>';
  }
  function ratingsListHtml(d) {
    if (!d.ratings.length) return '';
    const counting = new Set(d.counting.map(r => r.id));
    return `<div class="pg-ratings"><h3>Judgements</h3><ul>` + d.ratings.slice().reverse().map(r => {
      const verdict = r.verdict === 'right' ? '<span class="pg-good">✓ right</span>' : r.verdict === 'wrong' ? '<span class="pg-bad">✗ wrong</span>' : '<span class="pg-dim">withdrawn</span>';
      const said = 'answer' in r ? ` — should be <code>${h(JSON.stringify(r.answer))}</code>` : '';
      const other = r.outputs ? ` · ${h(Object.entries(r.outputs).map(([k, v]) => k + ' = ' + JSON.stringify(v)).join(', '))}` : '';
      return `<li class="${counting.has(r.id) ? '' : 'pg-old'}">${verdict}${said}${other} <span class="pg-dim">· ${h(r.by)} · ${h(age(r.at))}${r.origin === 'edit' ? ' · from an edit' : ''}${r.sample ? ' · random draw' : ''}${counting.has(r.id) ? '' : ' · replaced'}</span>` +
        `${r.reasons ? `<div class="pg-dim">${h(r.reasons.join(', '))}</div>` : ''}${r.note ? `<div>${h(r.note)}</div>` : ''}</li>`;
    }).join('') + '</ul></div>';
  }
  const REASONS = ['wrong choice', 'made something up', 'missed something', 'wrong format', 'too vague', 'wrong language'];
  function editorFor(name, value, id) {
    const seen = name === page.program.answer ? (page.program.answers || []).map(a => a.value) : [];
    const type = valueType(value);
    const strings = seen.filter(v => typeof v === 'string');
    if (type === 'boolean') return `<select id="${id}" data-type="boolean"><option value="true" ${value === true ? 'selected' : ''}>true</option><option value="false" ${value === false ? 'selected' : ''}>false</option></select>`;
    if (type === 'number') return `<input id="${id}" type="number" step="any" data-type="number" value="${h(value)}">`;
    if (type === 'string' || type === 'undefined') {
      const list = strings.length ? `<datalist id="${id}List">${strings.map(s => `<option value="${h(s)}">`).join('')}</datalist>` : '';
      const long = typeof value === 'string' && (value.length > 80 || value.includes('\n'));
      return long ? `<textarea id="${id}" data-type="string" rows="5">${h(value)}</textarea>`
        : `<input id="${id}" data-type="string" ${strings.length ? `list="${id}List"` : ''} value="${h(value ?? '')}" autocomplete="off">${list}`;
    }
    return `<textarea id="${id}" data-type="json" rows="6" spellcheck="false">${h(JSON.stringify(value, null, 2))}</textarea><div class="pg-dim">JSON</div>`;
  }
  function readEditor(el) {
    const t = el.dataset.type;
    if (t === 'boolean') return el.value === 'true';
    if (t === 'number') { if (el.value.trim() === '') throw new Error('Give a number.'); return Number(el.value); }
    if (t === 'json') { try { return JSON.parse(el.value); } catch { throw new Error('That is not valid JSON.'); } }
    return el.value;
  }
  function correctionHtml(d) {
    const rec = d.record || {}, answer = d.run.answer || 'result';
    const outputs = rec.outputs && typeof rec.outputs === 'object' ? rec.outputs : {};
    const others = Object.keys(outputs).filter(k => k !== answer);
    const suggestions = (page.program.answers || []).filter(a => typeof a.value !== 'object' && JSON.stringify(a.value) !== JSON.stringify(outputs[answer])).slice(0, 8);
    return `<form class="pg-correct" id="pgCorrect">
      <div class="pg-correct-head"><b>What should <code>${h(answer)}</code> have been?</b> <span class="pg-dim">It becomes a row with a known answer.</span></div>
      ${suggestions.length ? `<div class="pg-chips" aria-label="answers this program gave elsewhere">${suggestions.map(a => `<button type="button" class="pg-chip" data-pick="${h(JSON.stringify(a.value))}">${h(pretty(a.value))}</button>`).join('')}</div>` : ''}
      <label class="pg-edit"><span>${h(answer)}</span>${editorFor(answer, outputs[answer], 'pgAnswer')}</label>
      ${others.length ? `<details class="pg-others"><summary>correct other outputs too (${others.map(h).join(', ')})</summary>${others.map((k, i) => `<label class="pg-edit"><span>${h(k)}</span>${editorFor(k, outputs[k], 'pgOther' + i)}</label>`).join('')}</details>` : ''}
      <div class="pg-chips pg-reasons" aria-label="why">${REASONS.map(r => `<button type="button" class="pg-chip" data-reason="${h(r)}" aria-pressed="false">${h(r)}</button>`).join('')}</div>
      <textarea id="pgNote" rows="2" placeholder="A note (optional): the rule the model missed"></textarea>
      <div class="pg-actions"><button type="submit" class="primary">save correction <span class="pg-key">⏎</span></button>
        <button type="button" class="ghost" data-pg-wrong-unknown title="Wrong, but you do not know the right answer: it stays open for someone who does">wrong, answer unknown</button>
        <button type="button" class="ghost" data-pg-cancel>cancel</button></div></form>`;
  }
  function detailHtml() {
    const d = page.detail;
    if (!d) return page.runs.length ? '<div class="pg-detail pg-detail-empty">Open a call to read it whole, see what the model saw, and judge it.</div>' : '';
    const r = d.run, rec = d.record;
    const c = r.caller || {};
    const mine = d.counting.find(x => x.by === page.you);
    const conv = c.conversation ? `<button type="button" class="linkish" data-open-conv="${h(c.conversation)}">open the conversation</button>` : '';
    const nb = c.notebook ? `<button type="button" class="linkish" data-open-file="${h(c.notebook)}">open the notebook</button>` : '';
    const place = [r.person, r.host, r.language, rec && rec.process && rec.process.functai ? 'functai ' + rec.process.functai : ''].filter(Boolean).join(' · ');
    const judge = r.error ? '' : !r.content ? '<p class="pg-dim">Values were not recorded for this call (the program logs sizes only), so it cannot be judged.</p>'
      : page.correcting ? correctionHtml(d)
      : `<div class="pg-judge"><span>Is <code>${h(r.answer)}</code> right for this input?</span>
          <button type="button" class="${mine && mine.verdict === 'right' ? 'primary' : ''}" data-rate="right">✓ right <span class="pg-key">1</span></button>
          <button type="button" class="${mine && mine.verdict === 'wrong' ? 'primary' : ''}" data-rate="wrong">✗ wrong <span class="pg-key">2</span></button>
          ${mine ? '<button type="button" class="ghost" data-rate="withdraw">withdraw mine</button>' : ''}</div>`;
    return `<article class="pg-detail" aria-label="The call, whole">
      <div class="pg-dhead"><b>${h(when(r.started))}</b> <span class="pg-dim">· ${h(r.model || 'no model')} · ${secs(r.seconds)} · ${num(r.tokensIn)} → ${num(r.tokensOut)} tokens · ${r.exchanges} request${r.exchanges === 1 ? '' : 's'}${r.cached ? ' (' + r.cached + ' from cache)' : ''} · version <code>${h(shortVersion(r.version))}</code></span>
        <div class="pg-dim">${h(callerLabel(r))}${conv || nb ? ' · ' : ''}${conv}${nb}${place ? ' · ' + h(place) : ''}</div></div>
      ${d.parent ? `<p class="pg-dim">Called inside <button type="button" class="linkish" data-open-run="${h(d.parent.id)}" data-open-program="${h(JSON.stringify([d.parent.name, d.parent.module]))}">${h(d.parent.name)}</button></p>` : ''}
      <div class="pg-pair">
        <section><h3 class="pg-in-h">input</h3>${rec && r.content ? fieldsHtml(rec.inputs, { sizes: rec.sizes && rec.sizes.inputs }) : `<p class="pg-dim">${r.content ? h(r.inputs) : 'not recorded'}</p>`}</section>
        <section><h3 class="pg-out-h">output</h3>${r.error ? `<p class="pg-bad"><b>${h(r.error.type)}</b>${r.error.code ? ' · ' + h(r.error.code) : ''}</p>${r.error.message ? `<pre class="pg-err">${h(r.error.message)}</pre>` : ''}` : ''}
          ${rec && r.content && rec.outputs ? fieldsHtml(rec.outputs, { answer: r.answer, sizes: rec.sizes && rec.sizes.outputs }) : r.content ? '' : '<p class="pg-dim">not recorded</p>'}
          ${rec && 'returned' in rec ? `<p class="pg-dim">the function returned</p>${fieldsHtml({ returned: rec.returned })}` : ''}
          ${rec && rec.probabilities ? `<p class="pg-dim">probabilities</p>${fieldsHtml(rec.probabilities)}` : ''}</section>
      </div>
      ${judge}
      ${ratingsListHtml(d)}
      ${d.children.length ? `<div class="pg-children"><h3>Calls it made</h3><ul>${d.children.map(k => `<li><button type="button" class="linkish" data-open-run="${h(k.id)}" data-open-program="${h(JSON.stringify([k.name, k.module]))}">${h(k.name)}</button> <span class="pg-dim">${secs(k.seconds)} · ${h(k.outputs || (k.error && k.error.type) || '')}</span></li>`).join('')}</ul></div>` : ''}
      ${exchangesHtml(rec)}
      ${rec ? '' : '<p class="pg-dim">The line of this call could not be read back from the log (the file moved or was removed).</p>'}
    </article>`;
  }
  async function select(id, { scroll = false } = {}) {
    page.selected = id;
    page.correcting = false;
    try { page.detail = await api('/api/programs/run?id=' + encodeURIComponent(id)); }
    catch (e) { errToast(e.message); return; }
    call('replaceRoute', hashFor({ name: page.name, module: page.module, tab: page.tab, run: id }));
    const host = document.getElementById('pgDetail');
    if (host && page.tab === 'runs') {
      host.innerHTML = detailHtml();
      view().querySelectorAll('tr[data-run]').forEach(tr => { const on = tr.dataset.run === id; tr.classList.toggle('on', on); tr.setAttribute('aria-selected', String(on)); });
      wire(host);
      if (scroll) host.scrollIntoView({ block: 'nearest' });
    } else render();
  }

  // Send one rating; update what shows it, in place.
  async function rate(callId, verdict, extra = {}) {
    const out = await post('/api/programs/rate', { call: callId, verdict, ...extra });
    const row = page.runs.find(r => r.id === callId);
    if (row) Object.assign(row, { rating: out.state ? out.state.state : null, ratingOpen: !!(out.state && out.state.open), ratedBy: out.state ? out.state.people : 0 });
    list.at = 0;
    return out;
  }
  async function afterRate(callId) {
    await loadProgram().catch(() => {});
    if (page.detail && page.detail.run.id === callId) page.detail = await api('/api/programs/run?id=' + encodeURIComponent(callId)).catch(() => page.detail);
    page.correcting = false;
    render();
  }
  function collectCorrection(form, d) {
    const extra = { answer: readEditor(form.querySelector('#pgAnswer')) };
    const answer = d.run.answer || 'result';
    const outputs = (d.record && d.record.outputs) || {};
    const others = Object.keys(outputs).filter(k => k !== answer);
    const changed = {};
    others.forEach((k, i) => {
      const el = form.querySelector('#pgOther' + i);
      if (!el || !form.querySelector('.pg-others[open]')) return;
      const v = readEditor(el);
      if (JSON.stringify(v) !== JSON.stringify(outputs[k])) changed[k] = v;
    });
    if (Object.keys(changed).length) extra.outputs = changed;
    const reasons = [...form.querySelectorAll('[data-reason][aria-pressed="true"]')].map(b => b.dataset.reason);
    if (reasons.length) extra.reasons = reasons;
    const note = form.querySelector('#pgNote').value.trim();
    if (note) extra.note = note;
    return extra;
  }

  // ---- Review: one call at a time ----
  const QUEUES = {
    unrated: ['not rated yet, newest first', { rating: 'unrated', status: 'ok', content: 'yes' }],
    unsure: ['least sure first', { rating: 'unrated', status: 'ok', content: 'yes', sort: 'unsure' }],
    open: ['wrong, answer unknown', { rating: 'open' }],
  };
  async function fillQueue() {
    const rv = page.review;
    if (rv.mode === 'draw') return;
    const d = await api('/api/programs/runs?' + qs({ ...programQuery(), ...QUEUES[rv.mode][1], limit: 50 }));
    rv.ids = d.runs.map(r => r.id).filter(id => !rv.done.has(id));
    rv.total = d.total;
    rv.at = 0;
    rv.detail = rv.ids.length ? await api('/api/programs/run?id=' + encodeURIComponent(rv.ids[0])) : null;
  }
  async function startReview(mode) {
    page.review = { mode, ids: [], at: 0, done: new Set(), detail: null, sample: null, total: 0, rated: 0 };
    page.correcting = false;
    if (mode === 'draw') {
      const d = await post('/api/programs/sample', { ...programQuery(), n: 20, version: page.program.version });
      Object.assign(page.review, { ids: d.ids, sample: d.sample, total: d.ids.length });
      page.review.detail = d.ids.length ? await api('/api/programs/run?id=' + encodeURIComponent(d.ids[0])) : null;
    } else await fillQueue();
    render();
  }
  async function reviewMove(step) {
    const rv = page.review;
    rv.at = Math.max(0, Math.min(rv.ids.length, rv.at + step));
    page.correcting = false;
    rv.detail = rv.at < rv.ids.length ? await api('/api/programs/run?id=' + encodeURIComponent(rv.ids[rv.at])) : null;
    render();
  }
  function reviewHtml() {
    const rv = page.review, p = page.program;
    const pick = `<div class="pg-queues" role="group" aria-label="What to review">
      <button type="button" data-pg-queue="draw" class="${rv && rv.mode === 'draw' ? 'on' : ''}" title="A random draw of 20 unrated calls of the current version. Only draws measure how often the program is right.">random 20 — measures it</button>
      ${Object.entries(QUEUES).map(([k, [label]]) => `<button type="button" data-pg-queue="${k}" class="${rv && rv.mode === k ? 'on' : ''}">${h(label)}</button>`).join('')}</div>`;
    if (!rv) return pick + `<div class="pg-note"><p>Judge calls one at a time: <b>1</b> right, <b>2</b> wrong (then say what the answer should have been), <b>j</b>/<b>k</b> next and back.</p>
      <p>A <b>random 20</b> is the only fair measure: calls people chose to rate are not a sample of all calls. ${p.sample && p.sample.n ? `This version so far: ${pct(p.sample.score)} right on ${p.sample.n} random calls (${pct(p.sample.low)}–${pct(p.sample.high)}).` : ''}</p></div>`;
    const d = rv.detail;
    const progress = rv.mode === 'draw' ? `${Math.min(rv.at + 1, rv.ids.length)} of ${rv.ids.length} in this draw · ${rv.rated} judged` : `${rv.at + 1} of ${rv.ids.length}${rv.total > rv.ids.length ? ' (of ' + num(rv.total) + ')' : ''} · ${rv.rated} judged`;
    if (!d) {
      const done = rv.mode === 'draw' && p.sample && p.sample.n ? `<p>Measured on random calls of this version: <b>${pct(p.sample.score)}</b> right (${p.sample.right} of ${p.sample.n}; the true share is likely between ${pct(p.sample.low)} and ${pct(p.sample.high)}).</p>` : '';
      return pick + `<div class="pg-note">${rv.ids.length ? '<p><b>Done.</b> Nothing left in this queue.</p>' : '<p>Nothing to review here.</p>'}${done}</div>`;
    }
    const r = d.run, rec = d.record || {};
    const mine = d.counting.find(x => x.by === page.you);
    return pick + `<div class="pg-review">
      <div class="pg-progress">${progress}${rv.mode === 'draw' ? ' · <span class="pg-dim">ratings carry this draw\'s id</span>' : ''}</div>
      <div class="pg-pair pg-big">
        <section><h3 class="pg-in-h">input</h3>${fieldsHtml(rec.inputs)}</section>
        <section><h3 class="pg-out-h">output</h3>${fieldsHtml(rec.outputs, { answer: r.answer })}</section>
      </div>
      ${page.correcting ? correctionHtml(d) : `<div class="pg-judge"><span>Is <code>${h(r.answer)}</code> right for this input?${mine ? ` <span class="pg-dim">(you said ${mine.verdict})</span>` : ''}</span>
        <button type="button" data-review="right">✓ right <span class="pg-key">1</span></button>
        <button type="button" data-review="wrong">✗ wrong <span class="pg-key">2</span></button>
        <button type="button" class="ghost" data-review="skip">skip <span class="pg-key">j</span></button>
        <button type="button" class="ghost" data-review="back" ${rv.at ? '' : 'disabled'}>back <span class="pg-key">k</span></button>
        <button type="button" class="ghost" data-open-run="${h(r.id)}">open whole</button></div>`}
      <details class="pg-seen"><summary>what the model saw</summary>${exchangesHtml(rec)}</details></div>`;
  }

  // ---- Versions ----
  function versionsHtml() {
    const vs = page.versions;
    const cmp = page.compare;
    const a = cmp ? cmp.a : (vs[1] && vs[1].version) || '', b = cmp ? cmp.b : (vs[0] && vs[0].version) || '';
    const rows = vs.map(v => `<tr><td><code title="${h(v.version || '')}">${h(shortVersion(v.version))}</code>${v.current ? ' <span class="pg-good">current</span>' : ''}${v.saved ? ' <span class="pg-dim" title="loaded from a saved folder">saved</span>' : ''}
        <div class="pg-dim">${h((v.languages || []).join(', '))}</div></td>
      <td>${h(age(v.first))} – ${h(age(v.last))}</td><td class="n">${num(v.useCalls)}${v.otherCalls ? `<div class="pg-dim">+${num(v.otherCalls)} eval</div>` : ''}</td>
      <td class="n ${v.errors ? 'pg-bad' : ''}">${v.useCalls ? pct(v.errors / v.useCalls) : '—'}</td><td class="n">${secs(v.p50)}</td><td class="n">${num(v.tokens)}</td>
      <td class="n"><span class="pg-good">${v.ratings.right}✓</span> <span class="pg-bad">${v.ratings.wrong}✗</span></td>
      <td class="n">${v.sample && v.sample.n ? `${pct(v.sample.score)} <div class="pg-dim">${pct(v.sample.low)}–${pct(v.sample.high)}, n=${v.sample.n}</div>` : '<span class="pg-dim">—</span>'}</td>
      <td class="n"><input type="radio" name="pgA" value="${h(v.version || '')}" ${v.version === a ? 'checked' : ''} aria-label="compare: before"></td>
      <td class="n"><input type="radio" name="pgB" value="${h(v.version || '')}" ${v.version === b ? 'checked' : ''} aria-label="compare: after"></td></tr>`).join('');
    const intro = `<p class="pg-note">A version is everything the program sends besides its inputs: instruction, layout, examples, tools. The model is not part of it. The same function written in Python and TypeScript has one version.</p>`;
    const compareBody = cmp ? (cmp.common ? `<div class="pg-compare"><p><b>${num(cmp.common)}</b> inputs were answered by both; <b>${num(cmp.differ)}</b> answered differently.${cmp.onlyA || cmp.onlyB ? ` <span class="pg-dim">${num(cmp.onlyA)} only before, ${num(cmp.onlyB)} only after.</span>` : ''}</p>
        <table class="pg-table pg-runs"><thead><tr><th class="pg-in-h">input</th><th>before <code>${h(shortVersion(cmp.a))}</code></th><th>after <code>${h(shortVersion(cmp.b))}</code></th><th></th></tr></thead><tbody>
        ${cmp.pairs.map(pr => `<tr class="${pr.same ? 'pg-same' : 'pg-changed'}"><td><div class="pg-cell">${h(pr.a.inputs)}</div></td>
          <td><div class="pg-cell">${h(pr.a.error ? pr.a.error.type : pr.a.outputs)}</div>${pr.a.rating ? `<div class="pg-dim">${RATING_LABEL[pr.a.rating]}</div>` : ''}</td>
          <td><div class="pg-cell">${h(pr.b.error ? pr.b.error.type : pr.b.outputs)}</div>${pr.b.rating ? `<div class="pg-dim">${RATING_LABEL[pr.b.rating]}</div>` : ''}</td>
          <td>${pr.same ? '<span class="pg-dim">same</span>' : '<b class="pg-warn">changed</b>'}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="pg-note">No input was answered by both versions. Run the same rows through each (FunctAI\'s <code>evaluate</code> does) to compare them here.</p>') : '';
    return intro + `<div class="usage-table-wrap"><table class="usage-table pg-table"><thead><tr><th>version</th><th>seen</th><th>calls</th><th>failed</th><th>time</th><th>tokens</th><th>rated</th><th>right, measured</th><th>before</th><th>after</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${vs.length > 1 ? '<p><button type="button" data-pg-compare>compare the same inputs</button></p>' : ''}${compareBody}`;
  }

  // ---- Data: rows with known answers ----
  const META = new Set(['call', 'version', 'rating', 'rated_by', 'origin', 'sample', 'disputed']);
  function dataCell(col, v) {
    if (col === 'version') return shortVersion(v);
    if (col === 'call') return String(v || '').slice(-8);
    if (col === 'sample') return v ? 'random draw' : '—';
    if (col === 'disputed') return v ? 'yes' : '';
    return typeof v === 'string' ? v : JSON.stringify(v ?? '');
  }
  function dataHtml() {
    const d = page.rated || { rows: [], left_out: {} };
    const left = d.left_out || {};
    const leftText = [left.other_signature ? `${left.other_signature} from an older signature (its inputs or outputs changed)` : '', left.no_content ? `${left.no_content} whose values were not recorded` : '',
      left.no_answer ? `${left.no_answer} judged wrong with no right answer given` : ''].filter(Boolean).join(', ');
    const cols = [...new Set(d.rows.flatMap(r => Object.keys(r)))];
    const q = qs(programQuery());
    const name = page.name.replace(/[^\w]/g, '_') || 'program';
    const pyName = JSON.stringify(page.name);
    return `<div class="pg-data"><p><b>${num(d.rows.length)}</b> rows with known answers${leftText ? ` <span class="pg-dim">(left out: ${h(leftText)})</span>` : ''}. Each rated call is one row: its inputs, the right answer, and who said so. FunctAI's <code>evaluate</code> and <code>.opt</code> read exactly these rows.</p>
      <p class="pg-actions"><a class="button" href="/api/programs/rated?${q}&format=csv" download>download CSV</a> <a class="button" href="/api/programs/rated?${q}&format=jsonl" download>download JSON lines</a></p>
      <div class="pg-snippets"><div><div class="pg-role">Python</div><pre>import functai\n\nrows = functai.rated(${h(pyName)})     # the same rows, from the log\nfunctai.evaluate(${h(name)}, rows)</pre></div>
      <div><div class="pg-role">TypeScript</div><pre>import { rated, evaluate } from "functai";\n\nconst { rows } = rated(${h(pyName)});\nawait evaluate(${h(name)}, rows);</pre></div></div>
      ${d.rows.length ? `<div class="usage-table-wrap"><table class="usage-table pg-table pg-data-table"><thead><tr>${cols.map(c => `<th>${h(c)}</th>`).join('')}</tr></thead>
        <tbody>${d.rows.slice(0, 200).map(r => `<tr>${cols.map(c => `<td class="${META.has(c) ? '' : 'pg-wrap'}"><div class="pg-cell" title="${h(typeof r[c] === 'string' ? r[c] : JSON.stringify(r[c] ?? ''))}">${h(dataCell(c, r[c]))}</div></td>`).join('')}</tr>`).join('')}</tbody></table></div>`
        : '<p class="empty">No rated calls yet. Judge some in <button type="button" class="linkish" data-pg-tab="review">Review</button>.</p>'}</div>`;
  }

  // ---- events ----
  function wire(root) {
    root.querySelectorAll('[data-programs-all]').forEach(b => { b.onclick = showList; });
    root.querySelectorAll('[data-pg-tab]').forEach(b => { b.onclick = () => setTab(b.dataset.pgTab); });
    root.querySelectorAll('[data-pg-draw]').forEach(b => { b.onclick = () => { page.tab = 'review'; call('replaceRoute', hashFor({ name: page.name, module: page.module, tab: 'review' })); startReview('draw').catch(e => errToast(e.message)); }; });
    const q = root.querySelector('#pgQuery');
    if (q) {
      let t = null;
      q.oninput = () => { clearTimeout(t); t = setTimeout(() => { page.filters.q = q.value; loadRuns().then(renderKeepingFocus).catch(e => errToast(e.message)); }, 250); };
    }
    root.querySelectorAll('[data-pg-filter]').forEach(s => { s.onchange = () => { page.filters[s.dataset.pgFilter] = s.value; loadRuns().then(render).catch(e => errToast(e.message)); }; });
    const more = root.querySelector('[data-pg-more]');
    if (more) more.onclick = () => { page.limit += 100; loadRuns().then(render).catch(e => errToast(e.message)); };
    root.querySelectorAll('tr[data-run]').forEach(tr => {
      tr.onclick = e => {
        const quick = e.target.closest('[data-quick]');
        if (quick) {
          e.stopPropagation();
          if (quick.dataset.quick === 'right') rate(tr.dataset.run, 'right').then(() => afterRate(tr.dataset.run)).catch(err => errToast(err.message));
          else select(tr.dataset.run, { scroll: true }).then(() => { page.correcting = true; refreshDetail(); });
          return;
        }
        select(tr.dataset.run, { scroll: true });
      };
      tr.onkeydown = e => { if (e.key === 'Enter') select(tr.dataset.run, { scroll: true }); };
    });
    root.querySelectorAll('[data-rate]').forEach(b => {
      b.onclick = async () => {
        const id = page.detail.run.id, v = b.dataset.rate;
        if (v === 'wrong') { page.correcting = true; return refreshDetail(); }
        try { await rate(id, v === 'withdraw' ? null : 'right'); await afterRate(id); } catch (e) { errToast(e.message); }
      };
    });
    root.querySelectorAll('[data-open-conv]').forEach(b => { b.onclick = () => call('open', b.dataset.openConv); });
    root.querySelectorAll('[data-open-file]').forEach(b => { b.onclick = () => call('openLiveFile', b.dataset.openFile, {}); });
    root.querySelectorAll('[data-open-run]').forEach(b => {
      b.onclick = () => {
        const target = b.dataset.openProgram ? JSON.parse(b.dataset.openProgram) : [page.name, page.module];
        if (target[0] === page.name && target[1] === page.module) { page.tab = 'runs'; loadRuns().then(() => { render(); return select(b.dataset.openRun, { scroll: true }); }); }
        else showProgram(target[0], target[1], { run: b.dataset.openRun });
      };
    });
    // The correction form (in Calls or Review).
    const form = root.querySelector('#pgCorrect');
    if (form) {
      const d = page.tab === 'review' ? page.review.detail : page.detail;
      form.querySelectorAll('[data-pick]').forEach(b => { b.onclick = () => { const el = form.querySelector('#pgAnswer'); el.value = typeof JSON.parse(b.dataset.pick) === 'string' ? JSON.parse(b.dataset.pick) : b.dataset.pick; el.focus(); }; });
      form.querySelectorAll('[data-reason]').forEach(b => { b.onclick = () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); });
      const submit = async (withAnswer) => {
        if (form.dataset.busy) return;
        let extra;
        try { extra = withAnswer ? collectCorrection(form, d) : (() => { const x = collectCorrection(form, d); delete x.answer; delete x.outputs; return x; })(); }
        catch (e) { return errToast(e.message); }
        form.dataset.busy = '1';
        try {
          await rate(d.run.id, 'wrong', { ...extra, ...(page.tab === 'review' && page.review.sample ? { sample: page.review.sample } : {}) });
          if (page.tab === 'review') return await reviewDone(d.run.id);
          await afterRate(d.run.id);
        } catch (e) { errToast(e.message); delete form.dataset.busy; }
      };
      form.onsubmit = e => { e.preventDefault(); submit(true); };
      form.querySelector('[data-pg-wrong-unknown]').onclick = () => submit(false);
      form.querySelector('[data-pg-cancel]').onclick = () => { page.correcting = false; page.tab === 'review' ? render() : refreshDetail(); };
      form.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); submit(true); } if (e.key === 'Escape') { e.stopPropagation(); page.correcting = false; page.tab === 'review' ? render() : refreshDetail(); } });
      setTimeout(() => { const el = form.querySelector('#pgAnswer'); if (el) { el.focus({ preventScroll: false }); if (el.select) el.select(); } }, 0);
    }
    // Review.
    root.querySelectorAll('[data-pg-queue]').forEach(b => { b.onclick = () => startReview(b.dataset.pgQueue).catch(e => errToast(e.message)); });
    root.querySelectorAll('[data-review]').forEach(b => { b.onclick = () => reviewAction(b.dataset.review); });
    // Versions.
    const cmpBtn = root.querySelector('[data-pg-compare]');
    if (cmpBtn) cmpBtn.onclick = async () => {
      const a = (root.querySelector('input[name=pgA]:checked') || {}).value, b = (root.querySelector('input[name=pgB]:checked') || {}).value;
      if (!a || !b || a === b) return errToast('Choose two different versions: one before, one after.');
      try { page.compare = await api('/api/programs/compare?' + qs({ ...programQuery(), a, b })); render(); } catch (e) { errToast(e.message); }
    };
  }
  function refreshDetail() {
    const host = document.getElementById('pgDetail');
    if (!host) return render();
    host.innerHTML = detailHtml();
    wire(host);
  }
  async function reviewDone(id) {
    const rv = page.review;
    rv.done.add(id);
    rv.rated++;
    await loadProgram().catch(() => {});
    await reviewMove(1);
  }
  // One step at a time: a key pressed while a rating is on its way is
  // dropped, never applied to the next call.
  let reviewBusy = false;
  async function reviewAction(what) {
    const rv = page.review;
    if (!rv || !rv.detail || reviewBusy) return;
    const id = rv.detail.run.id;
    if (what === 'wrong') { page.correcting = true; return render(); }
    reviewBusy = true;
    try {
      if (what === 'skip') await reviewMove(1);
      else if (what === 'back') await reviewMove(-1);
      else if (what === 'right') await rate(id, 'right', rv.sample ? { sample: rv.sample } : {}).then(() => reviewDone(id));
    } catch (e) { errToast(e.message); }
    finally { reviewBusy = false; }
  }
  // Keys: 1 right, 2 wrong, j/k next/back (Review), on the program page only.
  document.addEventListener('keydown', e => {
    if (typeof viewKind === 'undefined' || viewKind !== 'program' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (page.correcting) return;
    if (page.tab === 'review' && page.review && page.review.detail) {
      const map = { 1: 'right', 2: 'wrong', j: 'skip', k: 'back' };
      if (map[e.key]) { e.preventDefault(); reviewAction(map[e.key]); }
      return;
    }
    if (page.tab === 'runs' && page.detail && page.detail.run.content && !page.detail.run.error) {
      if (e.key === '1') { e.preventDefault(); const id = page.detail.run.id; rate(id, 'right').then(() => afterRate(id)).catch(err => errToast(err.message)); }
      if (e.key === '2') { e.preventDefault(); page.correcting = true; refreshDetail(); }
    }
    if (page.tab === 'runs' && (e.key === 'j' || e.key === 'k') && page.runs.length) {
      e.preventDefault();
      const i = page.runs.findIndex(r => r.id === page.selected);
      const next = page.runs[Math.max(0, Math.min(page.runs.length - 1, i + (e.key === 'j' ? 1 : -1)))];
      if (next) select(next.id, { scroll: true });
    }
  });

  window.Programs = { panelHtml, wireHost, showList, showProgram, dispatch, describe, hashFor, parseHash, loadList };
})();
