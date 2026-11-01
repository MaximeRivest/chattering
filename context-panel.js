/* The context finder (design/110): what to give the model for the next
   message, found in one box, chosen at a depth, its cost in view.

   It is a tab beside the conversation (Beside, kind 'context'), not a
   dialog over it. Opening it (the composer's Context button, or @ outside
   the text box) already lists what is probably wanted: what is related to
   the message being written, the project's recent conversations, its
   memory, the files worked on. Typing searches everything at once; chips
   narrow it. Each source is one row, at a depth with its size:
     Link     the agent reads it only if it needs it (a few lines)
     Summary  AI-written once per version of a conversation, read here first
     Excerpt  the messages or sections ticked in the preview
     Whole    all of it
   Keys, in the search box: ↑↓ move · Enter add or remove · Tab / Shift+Tab
   change the depth · Ctrl+Enter add and go back to writing · Esc clear,
   then close.

   The page gives it window.contextFinderApi(key) (app.html): the attached
   items, add / remove / replace, the draft's text, the model's window. */
(function () {
  'use strict';
  const DEPTH_LABEL = { link: 'Link', summary: 'Summary', excerpt: 'Excerpt', full: 'Whole' };
  const DEPTH_HELP = {
    link: 'A few lines: what it is and how to read it. The agent opens it only if it needs it.',
    summary: 'Written once by an AI model, kept, and shown here before it is used.',
    excerpt: 'Only the messages or sections you tick in the preview.',
    full: 'All of it, word for word.',
  };
  const TYPE_ICON = { chat: '💬', memory: '◆', doc: '✎', file: '▤' };
  const CHIPS = [
    { id: 'inProject', label: 'this project', needsProject: true },
    { id: 'recent', label: 'last 2 weeks' },
    { id: 'chat', label: 'conversations', type: true },
    { id: 'memory', label: 'memory', type: true },
    { id: 'doc', label: 'notes', type: true },
    { id: 'file', label: 'files', type: true },
  ];
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const marks = s => esc(String(s || '').replace(/\s+/g, ' ')).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>');
  const fmt = n => (n == null ? '?' : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(Math.round(n)));
  const md = (text, q) => (typeof mdRender === 'function' ? mdRender(text, q || '') : '<p>' + esc(text).replace(/\n/g, '<br>') + '</p>');
  function ago(ts) {
    const t = Date.parse(ts || '');
    if (!t) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 2) return 'yesterday';
    if (s < 86400 * 30) return Math.round(s / 86400) + ' days ago';
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }
  async function post(url, body, signal) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    return d;
  }

  // ---- an attached item and the row it belongs to ----
  function rowIdOf(item) {
    if (!item) return '';
    if (item.type === 'chat') return 'chat:' + item.key;
    if (item.type === 'doc') return 'doc:' + item.file;
    if (item.type === 'file') return 'file:' + item.path;
    if (item.type === 'note') return 'note';
    return 'mem:' + item.project + ':' + item.kind;
  }
  // The depth an attached item is at, in the finder's words.
  function depthOfItem(item) {
    if (!item) return null;
    if (item.depth === 'auto') return 'full';
    if (item.depth) return item.depth;
    if (item.type === 'chat') return item.i != null ? 'excerpt' : 'recent';
    return 'full';
  }

  let mounted = null;

  function mount(host, state) {
    dispose();
    const api = window.contextFinderApi ? window.contextFinderApi(state.key) : null;
    host.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'cf';
    root.innerHTML = `
      <div class="cf-head">
        <label class="cf-search"><span aria-hidden="true">⌕</span>
          <input type="search" role="combobox" aria-expanded="true" aria-controls="cfList" aria-autocomplete="list" autocomplete="off" spellcheck="false"
            placeholder="Search conversations, memory, notes, files…" aria-label="Search for context"></label>
        <div class="cf-chips" role="group" aria-label="Narrow the search"></div>
        <div class="cf-status" aria-live="polite"></div>
      </div>
      <div class="cf-list" id="cfList" role="listbox" aria-label="Sources"></div>
      <div class="cf-preview" aria-label="Preview">
        <div class="cf-pv-head"><div class="cf-pv-title"></div><button type="button" class="cf-raw" aria-pressed="false" title="The exact text the model will get">What the model gets</button></div>
        <div class="cf-pv-body" tabindex="-1"></div>
      </div>
      <div class="cf-foot">
        <div class="cf-budget"><span class="cf-btxt"></span><span class="cf-bar" aria-hidden="true"><i></i><b></b></span></div>
        <div class="cf-keys"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> add / remove</span><span><kbd>Tab</kbd> depth</span><span><kbd>Ctrl</kbd><kbd>Enter</kbd> add &amp; write</span><span><kbd>Esc</kbd> close</span></div>
      </div>`;
    host.append(root);
    const $ = s => root.querySelector(s);
    const input = $('.cf-search input');
    const st = {
      key: state.key, project: api ? api.project : '', q: state.q || '',
      chips: { inProject: !!(api && api.project), recent: false, types: new Set() },
      groups: [], rows: [], sel: 0, choice: {}, picks: {}, sources: {}, summaries: {},
      exact: {}, raw: false, seq: 0, ctl: null, timer: 0, draftTimer: 0, previewSeq: 0, budgetSeq: 0, meaning: null,
      status: '', ranking: 'relevance', repairing: null,
      // This finder's searches: a newer one replaces its older one waiting.
      channel: 'cf' + Math.random().toString(36).slice(2, 12),
    };
    if (state.focusId) st.focusId = state.focusId;
    input.value = st.q;

    // ---- chips ----
    function drawChips() {
      const box = $('.cf-chips');
      box.innerHTML = '';
      for (const c of CHIPS) {
        if (c.needsProject && !st.project) continue;
        const on = c.type ? st.chips.types.has(c.id) : !!st.chips[c.id];
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'cf-chip'; b.setAttribute('aria-pressed', String(on));
        b.textContent = c.id === 'inProject' ? st.project : c.label;
        if (c.id === 'inProject') b.title = 'Only ' + st.project + ' (its conversations and memory)';
        b.onclick = () => {
          if (c.type) { if (st.chips.types.has(c.id)) st.chips.types.delete(c.id); else st.chips.types.add(c.id); }
          else st.chips[c.id] = !st.chips[c.id];
          drawChips(); search();
        };
        box.append(b);
      }
    }

    // ---- searching ----
    function request(stage) {
      return {
        key: st.key, project: st.project, q: st.q, draft: st.q ? '' : (api ? api.draftText() : ''),
        inProject: st.chips.inProject, sinceDays: st.chips.recent ? 14 : 0, types: [...st.chips.types], stage, channel: st.channel,
      };
    }
    async function search() {
      const seq = ++st.seq;
      if (st.ctl) st.ctl.abort();
      const ctl = st.ctl = new AbortController();
      const t0 = performance.now();
      if (!st.groups.length) $('.cf-list').innerHTML = '<div class="cf-empty">Looking…</div>';
      setStatus(st.q ? 'Searching…' : 'Finding what is related…');
      let out;
      try { out = await post('/api/context/find', request(), ctl.signal); }
      catch (e) { if (e.name !== 'AbortError' && seq === st.seq) { setStatus(''); $('.cf-list').innerHTML = `<div class="cf-empty">${esc(e.message)}</div>`; } return; }
      if (seq !== st.seq || out.superseded) return;
      st.groups = out.groups || [];
      st.ranking = out.ranking; st.repairing = out.repairing;
      const ms = Math.round(performance.now() - t0);
      st.wordsMs = ms;
      flatten();
      if (st.focusId) { const at = st.rows.findIndex(r => r.id === st.focusId); if (at >= 0) st.sel = at; st.focusId = null; }
      draw();
      preview();
      statusLine(out, ms, out.semantic ? 'meaning…' : null);
      // The meaning stage, merged in when it answers.
      if (out.semantic && (st.q || (api && api.draftText().trim().length > 12))) {
        try {
          const t1 = performance.now();
          const sem = await post('/api/context/find', request('meaning'), ctl.signal);
          if (seq !== st.seq) return;
          merge(sem.groups || []);
          statusLine(out, ms, sem.error ? 'meaning search unreachable' : `meaning ${Math.round(performance.now() - t1)} ms`);
        } catch (e) { if (e.name !== 'AbortError' && seq === st.seq) statusLine(out, ms, 'meaning search unreachable'); }
      }
    }
    function statusLine(out, ms, meaning) {
      if (out.repairing) return setStatus(out.repairing.message || 'The search index is being repaired.');
      const n = st.rows.length;
      const parts = [];
      if (st.q) parts.push(`${n} source${n === 1 ? '' : 's'}`, `words ${ms} ms`);
      else parts.push(out.keywords && out.keywords.length >= 2 ? 'Ready before you typed: related to your message, then recent work' : 'Recent work' + (st.project ? ' in ' + st.project : ''));
      if (meaning) parts.push(meaning);
      if (out.ranking === 'recent') parts.push('very common words: newest first, add words to narrow');
      setStatus(parts.join(' · '));
    }
    function setStatus(t) { $('.cf-status').textContent = t; }
    function merge(groups) {
      const have = new Set(st.rows.map(r => r.id));
      for (const g of groups) {
        const rows = g.rows.filter(r => !have.has(r.id));
        if (!rows.length) continue;
        const into = st.groups.find(x => x.id === g.id);
        if (into) into.rows.push(...rows); else st.groups.unshift({ ...g, rows });
      }
      const selected = st.rows[st.sel];
      flatten();
      if (selected) st.sel = Math.max(0, st.rows.findIndex(r => r.id === selected.id));
      draw();
      if (!selected) preview();
    }
    function flatten() { st.rows = st.groups.flatMap(g => g.rows); st.sel = Math.min(st.sel, Math.max(0, st.rows.length - 1)); }

    // ---- depth of a row ----
    const attachedOf = row => (api ? api.items() : []).filter(it => rowIdOf(it) === row.id);
    function depthOf(row) {
      if (st.choice[row.id]) return st.choice[row.id];
      const att = attachedOf(row)[0];
      if (att) { const d = depthOfItem(att); if (d && d !== 'recent') return d; }
      return row.depth;
    }
    function depthsOf(row) {
      const ds = Object.keys(row.sizes || {}).filter(d => DEPTH_LABEL[d]);
      if ((row.type === 'chat' || row.type === 'memory' || row.type === 'doc') && !ds.includes('excerpt')) ds.splice(ds.indexOf('full'), 0, 'excerpt');
      return ['link', 'summary', 'excerpt', 'full'].filter(d => ds.includes(d));
    }
    function sizeOf(row, d) {
      const ex = st.exact[row.id + '|' + d + '|' + pickSig(row)];
      if (ex != null) return ex;
      if (d === 'excerpt') {
        const p = st.picks[row.id];
        if (p && p.size) {
          const src = st.sources[row.id];
          if (src && src.messages) return src.messages.filter(m => p.has(m.i)).reduce((n, m) => n + m.tokens, 0) + 60;
          if (src && src.sections) return src.sections.filter(x => p.has(x.heading)).reduce((n, x) => n + x.tokens, 0) + 60;
        }
        return row.sizes.excerpt != null ? row.sizes.excerpt : null;
      }
      if (d === 'summary') { const s = st.summaries[row.key]; if (s && s.data) return s.data.tokens + 80; }
      return row.sizes[d];
    }
    const pickSig = row => { const p = st.picks[row.id]; return p ? [...p].join(',') : ''; };
    function itemFor(row, d) {
      if (row.type === 'chat') {
        const item = { type: 'chat', key: row.key, title: row.item.title, depth: d };
        if (d === 'excerpt') item.pick = [...(st.picks[row.id] || defaultPicks(row))];
        if (d === 'summary') { const s = st.summaries[row.key]; if (s && s.data) item.v = s.data.v; }
        return item;
      }
      if (row.type === 'memory' || row.type === 'doc') {
        const item = { ...row.item, depth: d };
        if (d === 'excerpt') item.sections = [...(st.picks[row.id] || defaultPicks(row))];
        return item;
      }
      if (row.type === 'file') return d === 'link' ? { ...row.item, depth: 'link' } : { ...row.item };
      return row.item;
    }
    // An excerpt before anything was ticked: the matched messages (with
    // their question) or the matched sections.
    function defaultPicks(row) {
      if (row.type === 'chat') return new Set((row.hits || []).map(h => h.i));
      return new Set(row.sections || []);
    }
    function canAt(row, d) {
      if (d === 'excerpt') return (st.picks[row.id] && st.picks[row.id].size) || defaultPicks(row).size;
      return true;
    }
    function setDepth(row, d) {
      if (!canAt(row, d)) { setStatus('Tick messages or sections in the preview first: an excerpt is what you tick.'); return; }
      st.choice[row.id] = d;
      const att = attachedOf(row);
      if (att.length && api) api.replace(att, itemFor(row, d));
      // A summary is a model call: written once the choice stays a moment,
      // not for every depth Tab passes over.
      clearTimeout(st.sumTimer);
      if (d === 'summary') st.sumTimer = setTimeout(() => { if (depthOf(row) === 'summary') ensureSummary(row); }, 900);
      draw(); preview();
    }
    function cycleDepth(row, dir) {
      const ds = depthsOf(row).filter(d => canAt(row, d));
      if (!ds.length) return;
      const at = ds.indexOf(depthOf(row));
      setDepth(row, ds[(at + dir + ds.length) % ds.length]);
      const d = depthOf(row);
      setStatus(`${row.title}: ${DEPTH_LABEL[d]}, about ${fmt(sizeOf(row, d))} tokens. ${DEPTH_HELP[d]}`);
    }
    function toggle(row) {
      if (!api || !api.live()) { setStatus('This finder belongs to another conversation: open it again from yours.'); return; }
      const att = attachedOf(row);
      if (att.length) { api.remove(att); setStatus(row.title + ' removed.'); }
      else {
        const d = canAt(row, depthOf(row)) ? depthOf(row) : (depthsOf(row).find(x => x !== 'excerpt') || 'link');
        st.choice[row.id] = d;
        api.add(itemFor(row, d));
        if (d === 'summary') ensureSummary(row);
        setStatus(`${row.title} added: ${DEPTH_LABEL[d]}, about ${fmt(sizeOf(row, d))} tokens.`);
      }
      draw(); budget();
    }

    // ---- summaries ----
    async function ensureSummary(row, force = false) {
      const s = st.summaries[row.key];
      if (!force && s && (s.status === 'writing' || (s.status === 'ready' && s.data.current))) return;
      if (!force && !s) {
        // One written for this version already? The source says.
        const src = await source(row).catch(() => null);
        if (src && src.summary && src.summary.current) { st.summaries[row.key] = { status: 'ready', data: src.summary }; afterSummary(row); return; }
      }
      st.summaries[row.key] = { status: 'writing', data: s && s.data };
      if (st.rows[st.sel] && st.rows[st.sel].id === row.id) preview();
      try {
        const out = await post('/api/context/summary', { key: row.key, force });
        st.summaries[row.key] = { status: 'ready', data: out.summary };
      } catch (e) {
        st.summaries[row.key] = { status: 'failed', error: e.message, data: s && s.data };
      }
      afterSummary(row);
    }
    function afterSummary(row) {
      if (!mounted || mounted.root !== root) return;
      const s = st.summaries[row.key];
      // An attached summary carries the version it was written for.
      const att = attachedOf(row);
      if (s && s.status === 'ready' && att.length && depthOfItem(att[0]) === 'summary' && api) api.replace(att, itemFor(row, 'summary'));
      draw();
      if (st.rows[st.sel] && st.rows[st.sel].id === row.id) preview();
      budget();
    }

    // ---- the list ----
    function draw() {
      const list = $('.cf-list');
      if (!st.rows.length) {
        list.innerHTML = `<div class="cf-empty">${st.repairing ? esc(st.repairing.message) : st.q ? 'Nothing matches. Fewer or other words, or loosen the chips.' : 'Nothing yet. Type to search everything.'}</div>`;
        $('.cf-pv-title').textContent = ''; $('.cf-pv-body').innerHTML = '';
        input.removeAttribute('aria-activedescendant');
        return;
      }
      list.innerHTML = '';
      let n = 0;
      for (const g of st.groups) {
        const h = document.createElement('div');
        h.className = 'cf-group'; h.textContent = g.title;
        list.append(h);
        for (const row of g.rows) list.append(rowEl(row, n++));
      }
      const sel = list.querySelector('.cf-row.sel');
      if (sel) { input.setAttribute('aria-activedescendant', sel.id); sel.scrollIntoView({ block: 'nearest' }); }
    }
    function rowEl(row, i) {
      const el = document.createElement('div');
      const att = attachedOf(row);
      el.className = 'cf-row' + (i === st.sel ? ' sel' : '') + (att.length ? ' added' : '');
      el.id = 'cfRow' + i;
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', String(i === st.sel));
      const d = depthOf(row);
      const meta = [];
      if (row.type === 'chat') { if (row.project && row.project !== st.project) meta.push(row.project); meta.push(ago(row.when)); if (row.messages) meta.push(row.messages + ' messages'); }
      else if (row.type === 'file') meta.push(row.meta, row.when ? ago(row.when) : '');
      else meta.push(row.meta, 'updated ' + ago(row.when));
      const hitsNote = row.type === 'chat' && row.hits && row.hits.length > 1 ? ` <span class="cf-more">+${row.hits.length - 1} more matching</span>` : '';
      el.innerHTML = `<div class="cf-ic" aria-hidden="true">${TYPE_ICON[row.type] || '◧'}</div>
        <div class="cf-t"><span class="cf-title">${esc(row.title)}</span>${row.ai ? '<span class="cf-ai" title="Written by AI from your conversations; nobody has reviewed it">AI-written</span>' : ''}<em>${att.length ? '✓ added' : ''}</em></div>
        <div class="cf-m">${esc(meta.filter(Boolean).join(' · '))}</div>
        ${row.why ? `<div class="cf-why">↳ ${esc(row.why)}</div>` : ''}
        ${row.snippet ? `<div class="cf-snip">${marks(row.snippet)}${hitsNote}</div>` : ''}
        <div class="cf-depths" role="group" aria-label="How much of it"></div>`;
      const box = el.querySelector('.cf-depths');
      for (const dd of depthsOf(row)) {
        const n = sizeOf(row, dd);
        const big = n != null && n > recommended();
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cf-dp' + (big ? ' big' : '');
        b.setAttribute('aria-pressed', String(dd === d));
        b.disabled = !canAt(row, dd);
        const sumState = dd === 'summary' && st.summaries[row.key] ? st.summaries[row.key].status : null;
        b.innerHTML = `${DEPTH_LABEL[dd]} <b>${sumState === 'writing' ? '…' : dd === 'excerpt' && n == null ? 'tick' : fmt(n)}</b>`;
        b.title = DEPTH_HELP[dd] + (n != null ? ` About ${Math.round(n).toLocaleString()} tokens.` : '') + (big ? ' Over the recommended size: more text usually makes answers worse.' : '');
        b.tabIndex = -1;
        b.onclick = e => { e.stopPropagation(); st.sel = i; setDepth(row, dd); };
        box.append(b);
      }
      const add = document.createElement('button');
      add.type = 'button'; add.className = 'cf-add'; add.tabIndex = -1;
      add.textContent = att.length ? 'Remove' : 'Add';
      add.onclick = e => { e.stopPropagation(); st.sel = i; toggle(row); };
      box.append(add);
      el.onclick = () => { if (st.sel !== i) { st.sel = i; draw(); preview(); } input.focus({ preventScroll: true }); };
      el.ondblclick = () => toggle(row);
      return el;
    }

    // ---- the preview ----
    async function source(row) {
      if (st.sources[row.id]) return st.sources[row.id];
      if (row.type === 'file') return null;
      const r = await fetch('/api/context/source?id=' + encodeURIComponent(row.id));
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'unavailable');
      st.sources[row.id] = d;
      if (row.type === 'chat' && d.summary && !st.summaries[row.key]) st.summaries[row.key] = { status: 'ready', data: d.summary };
      return d;
    }
    async function exactOf(row, d) {
      const k = row.id + '|' + d + '|' + pickSig(row);
      if (st.exact[k] != null && st.exactText && st.exactText[k]) return { tokens: st.exact[k], text: st.exactText[k] };
      const out = await post('/api/conversation/context-preview', { id: st.key, context: [itemFor(row, d)] });
      // The item's own weight (what its chip says), not the bundle's opening.
      const tokens = out.items && out.items[0] ? out.items[0].tokens : out.tokens;
      st.exact[k] = tokens; (st.exactText ||= {})[k] = out.text;
      return { tokens, text: out.text };
    }
    async function preview() {
      const row = st.rows[st.sel];
      const body = $('.cf-pv-body');
      if (!row) { body.innerHTML = ''; $('.cf-pv-title').textContent = ''; return; }
      const seq = ++st.previewSeq;
      const d = depthOf(row);
      const title = () => {
        const n = sizeOf(row, d);
        $('.cf-pv-title').innerHTML = `<strong>${esc(row.title)}</strong><span>${DEPTH_LABEL[d]} · about ${fmt(n)} tokens${n != null && n > recommended() ? ' · <b class="cf-over">over the recommended ' + fmt(recommended()) + '</b>' : ''}</span>`;
      };
      title();
      // The exact weight of this depth, measured by the server as it will be
      // sent: the estimate on the row is replaced by it.
      if (!(d === 'excerpt' && !canAt(row, d)) && !(d === 'summary' && !(st.summaries[row.key] && st.summaries[row.key].data))) {
        exactOf(row, d).then(() => { if (seq === st.previewSeq) { title(); draw(); } }).catch(() => {});
      }
      if (st.raw || row.type === 'file' || d === 'link') {
        body.innerHTML = '<div class="cf-empty">Reading…</div>';
        try {
          const ex = await exactOf(row, d);
          if (seq !== st.previewSeq) return;
          body.innerHTML = `<pre class="cf-rawtext">${esc(ex.text.replace(/^# Chattering attached context[\s\S]*?\n\n(?=##)/, ''))}</pre>`;
          title(); draw();
        } catch (e) { if (seq === st.previewSeq) body.innerHTML = `<div class="cf-empty">${esc(e.message)}</div>`; }
        return;
      }
      if (!st.sources[row.id]) body.innerHTML = '<div class="cf-empty">Reading…</div>';
      let src;
      try { src = await source(row); } catch (e) { if (seq === st.previewSeq) body.innerHTML = `<div class="cf-empty">${esc(e.message)}</div>`; return; }
      if (seq !== st.previewSeq) return;
      if (row.type === 'chat') previewChat(row, src, d, body);
      else previewDoc(row, src, d, body);
      title();
    }
    function warnBig(row, d) {
      const n = sizeOf(row, d);
      return n != null && n > recommended()
        ? `<p class="cf-warn">About ${fmt(n)} tokens: over the recommended ${fmt(recommended())}. Past that, research finds answers get worse, not better. ${depthsOf(row).includes('summary') ? 'Summary' : 'Excerpt or Link'} is the better choice.</p>` : '';
    }
    function previewChat(row, src, d, body) {
      const picks = st.picks[row.id] || (d === 'excerpt' ? defaultPicks(row) : null);
      const hitSet = new Set((row.hits || []).map(h => h.i));
      let head = warnBig(row, d);
      if (d === 'summary') {
        const s = st.summaries[row.key];
        if (!s) head += `<div class="cf-sumbox"><p class="cf-m">Not written yet: one model call reads the ${src.messages.length} messages and writes it, kept for this version of the conversation. <button type="button" class="cf-write">Write it now</button></p></div>`;
        else if (s.status === 'writing') head += `<div class="cf-sumbox"><p class="cf-m">Writing a summary of ${src.messages.length} messages… usually 10 to 40 seconds. You can keep choosing meanwhile.</p></div>`;
        else if (s.status === 'failed') head += `<div class="cf-sumbox"><p class="cf-warn">${esc(s.error)}</p><button type="button" class="cf-again">Try again</button></div>`;
        if (s && s.data) {
          head += `<div class="cf-sumbox"><p class="cf-m"><span class="cf-ai">AI-written summary</span> of ${s.data.messages} messages${s.data.model ? ' by ' + esc(s.data.model) : ''}, ${ago(new Date(s.data.at).toISOString())}.`
            + (s.data.current ? '' : ' <b>The conversation went on since.</b>') + ` <button type="button" class="cf-again">Write it again</button></p><div class="cf-md">${md(s.data.text)}</div></div>`;
        }
        head += '<h4 class="cf-sub">The conversation</h4>';
      } else if (d === 'full') {
        head += `<p class="cf-m">All ${src.messages.length} messages${src.tokens > 120000 ? ' (too large: its beginning and its end go)' : ''}. Tick messages to send only those.</p>`;
      } else if (d === 'excerpt') {
        head += `<p class="cf-m">Only the ticked messages go: ${picks ? picks.size : 0} of ${src.messages.length}.</p>`;
      }
      const words = st.q ? st.q : '';
      body.innerHTML = head + '<div class="cf-msgs">' + src.messages.map(m => `<label class="cf-msg ${m.role}${hitSet.has(m.i) ? ' hit' : ''}" data-i="${m.i}">
          <input type="checkbox" ${picks && picks.has(m.i) ? 'checked' : ''} aria-label="Send message ${m.i}">
          <div><div class="cf-who">${m.role === 'user' ? 'You' : 'Assistant'} · #${m.i}${m.ts ? ' · ' + esc(ago(m.ts)) : ''}${hitSet.has(m.i) ? ' · matched' : ''} · ${fmt(m.tokens)} tokens</div>
          <div class="cf-mtext">${md(m.text, words)}${m.clipped ? '<p class="cf-m">(shortened here; the whole message goes)</p>' : ''}</div></div></label>`).join('') + '</div>';
      for (const b of body.querySelectorAll('.cf-again')) b.onclick = () => ensureSummary(row, true);
      for (const b of body.querySelectorAll('.cf-write')) b.onclick = () => ensureSummary(row);
      for (const c of body.querySelectorAll('.cf-msg input')) c.onchange = () => tick(row, Number(c.closest('.cf-msg').dataset.i), c.checked);
      const first = body.querySelector('.cf-msg.hit');
      if (first && d !== 'summary') first.scrollIntoView({ block: 'center' });
      else body.scrollTop = 0;
    }
    function previewDoc(row, src, d, body) {
      const picks = st.picks[row.id] || (d === 'excerpt' ? defaultPicks(row) : null);
      const hit = new Set(row.sections || []);
      body.innerHTML = warnBig(row, d) + `<p class="cf-m">${esc(src.path || '')} · ${src.sections.length} sections · updated ${ago(src.updatedAt)}${src.trust ? ' · ' + esc(src.trust) : ''}. Tick sections to send only those.</p>`
        + src.sections.map((x, k) => `<label class="cf-sec${hit.has(x.heading) ? ' hit' : ''}" data-k="${k}">
          <input type="checkbox" ${x.heading && picks && picks.has(x.heading) ? 'checked' : ''} ${x.heading ? '' : 'disabled'} aria-label="Send section ${esc(x.heading || 'introduction')}">
          <div><div class="cf-who">${esc(x.heading || 'Introduction')} · ${fmt(x.tokens)} tokens${hit.has(x.heading) ? ' · matched' : ''}</div>
          <div class="cf-mtext">${md(x.text, st.q)}${x.clipped ? '<p class="cf-m">(shortened here; the whole section goes)</p>' : ''}</div></div></label>`).join('');
      for (const c of body.querySelectorAll('.cf-sec input')) c.onchange = () => tick(row, src.sections[Number(c.closest('.cf-sec').dataset.k)].heading, c.checked);
      const first = body.querySelector('.cf-sec.hit');
      if (first) first.scrollIntoView({ block: 'start' }); else body.scrollTop = 0;
    }
    // Ticking makes an excerpt of what is ticked; nothing ticked, the row
    // goes back to its own depth.
    function tick(row, what, on) {
      const p = st.picks[row.id] || (st.picks[row.id] = depthOf(row) === 'excerpt' ? new Set(defaultPicks(row)) : new Set());
      if (on) p.add(what); else p.delete(what);
      if (p.size) { st.choice[row.id] = 'excerpt'; }
      else { delete st.picks[row.id]; delete st.choice[row.id]; }
      const att = attachedOf(row);
      if (att.length && api) api.replace(att, itemFor(row, depthOf(row)));
      draw();
      const t = $('.cf-pv-title span');
      if (t) t.textContent = `${DEPTH_LABEL[depthOf(row)]} · about ${fmt(sizeOf(row, depthOf(row)))} tokens`;
      budget();
    }

    // ---- the budget ----
    function recommended() { return api ? api.recommended() : 40000; }
    async function budget() {
      const seq = ++st.budgetSeq;
      const items = api ? api.items() : [];
      const txt = $('.cf-btxt'), bar = $('.cf-bar');
      if (!items.length) { txt.textContent = 'Nothing attached yet.'; bar.className = 'cf-bar'; bar.querySelector('i').style.width = '0'; return; }
      let total = null;
      try { total = (await post('/api/conversation/context-preview', { id: st.key, context: items })).tokens; } catch {}
      if (seq !== st.budgetSeq || !mounted) return;
      const rec = recommended(), win = api ? api.window() : 0;
      txt.textContent = `${items.length} attached · about ${fmt(total)} tokens` + (total > rec ? ` · over the recommended ${fmt(rec)}` : ` · recommended up to ${fmt(rec)}`) + (win ? ` · window ${fmt(win)}` : '');
      bar.className = 'cf-bar' + (win && total > win * 0.5 ? ' over' : total > rec ? ' warn' : '');
      bar.querySelector('i').style.width = Math.min(100, (total / (rec * 1.5)) * 100) + '%';
      bar.querySelector('b').style.left = (100 / 1.5) + '%';
    }

    // ---- keys ----
    input.addEventListener('input', () => {
      st.q = input.value.trim();
      clearTimeout(st.timer);
      st.timer = setTimeout(() => { st.sel = 0; search(); }, 140);
    });
    input.addEventListener('keydown', e => {
      const row = st.rows[st.sel];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!st.rows.length) return;
        st.sel = (st.sel + (e.key === 'ArrowDown' ? 1 : -1) + st.rows.length) % st.rows.length;
        draw(); clearTimeout(st.pvTimer); st.pvTimer = setTimeout(preview, 90);
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (row && !attachedOf(row).length) toggle(row);
        if (api) api.focusComposer();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (row) toggle(row);
      } else if (e.key === 'Tab' && row && !e.altKey) {
        e.preventDefault();
        cycleDepth(row, e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        if (input.value) { input.value = ''; st.q = ''; st.sel = 0; search(); }
        else close();
      }
    });
    $('.cf-raw').onclick = () => { st.raw = !st.raw; $('.cf-raw').setAttribute('aria-pressed', String(st.raw)); $('.cf-raw').textContent = st.raw ? 'What you read' : 'What the model gets'; preview(); };
    function close() {
      if (window.Beside) { const t = Beside.active(); if (t && t.spec && t.spec.kind === 'context') Beside.close(t); }
      if (api) api.focusComposer();
    }
    // The message being written changes what is related to it.
    const draftBox = document.getElementById('agentText');
    const onDraft = () => {
      if (st.q) return;
      clearTimeout(st.draftTimer);
      st.draftTimer = setTimeout(search, 700);
    };
    if (draftBox) draftBox.addEventListener('input', onDraft);
    // The attached list changed elsewhere (a chip removed in the composer).
    const onItems = () => { draw(); budget(); };
    window.addEventListener('chattering:context-changed', onItems);

    mounted = {
      root, state,
      dispose() {
        if (st.ctl) st.ctl.abort();
        clearTimeout(st.timer); clearTimeout(st.draftTimer); clearTimeout(st.pvTimer); clearTimeout(st.sumTimer);
        if (draftBox) draftBox.removeEventListener('input', onDraft);
        window.removeEventListener('chattering:context-changed', onItems);
      },
      focus(id, q) { if (q != null) { input.value = q; st.q = q.trim(); } if (id) st.focusId = id; search(); input.focus(); },
    };
    if (!api || !api.live()) setStatus('Open this from its conversation to add to it.');
    drawChips();
    search();
    budget();
    setTimeout(() => input.focus({ preventScroll: true }), 0);
  }

  function dispose() {
    if (mounted) { mounted.dispose(); mounted = null; }
  }

  window.ContextFinder = { mount, dispose, rowIdOf, depthOfItem, current: () => mounted, DEPTH_LABEL };
  // Older callers: the Context button and the @ key open the finder beside.
  window.openContextPanel = function (api, opts = {}) {
    const key = api && api.key;
    if (!key || !window.Beside) return;
    const spec = { kind: 'context', key, title: 'Context' };
    if (mounted && mounted.state.key === key && document.body.contains(mounted.root)) {
      mounted.focus(opts.focusId, opts.q);
      const t = Beside.tabs().find(x => x.spec.kind === 'context' && x.spec.key === key);
      if (t) Beside.activate(t);
      return;
    }
    Beside.open({ ...spec, q: opts.q || '', focusId: opts.focusId || null }, { newTab: true, origin: 'middle' });
  };
})();
