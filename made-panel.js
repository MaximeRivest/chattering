'use strict';
// What this conversation made (design/82), in the right-hand column.
//
// The conversation on the left is the trace; this is the result: every file
// it and its sub-agents changed, whether each change is reviewed, committed,
// still the version the work produced, and live in the running app; the
// commits it made; the artifacts and outputs it produced. The server works
// it out (made.js) from the same evidence as the whole-conversation review,
// so a row always opens the same file in the review.
//
// Updating: once when the conversation opens, again whenever its transcript
// changes (at most every few seconds), every few seconds while it or one of
// its sub-agents works, and on coming back to the window. Nothing is
// fetched for a conversation no one is looking at.
(function () {
  const REFRESH_MIN_MS = 4000;      // never ask again sooner than this
  const WORKING_POLL_MS = 8000;     // while an agent works
  const QUIET_STALE_MS = 60000;     // a finished conversation, looked at again
  const SHOWN_PER_GROUP = 40;       // rows before "show all"
  const cache = new Map();          // key → { data, at, etag, error, loading }
  const expanded = new Set();       // groups showing all their rows (this page)
  let pollTimer = 0, tickTimer = 0;

  const h = s => (typeof esc === 'function' ? esc(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`));
  const n = x => Number(x || 0).toLocaleString();
  const plural = (count, one, many = one + 's') => `${n(count)} ${count === 1 ? one : many}`;
  const age = ms => (typeof tinyAge === 'function' ? tinyAge(Date.now() - ms) : new Date(ms).toLocaleTimeString());
  const currentKey = () => (typeof current !== 'undefined' && current && !current.draft && current.key) || '';
  const busyKeys = () => { try { return typeof agentBusyKeys === 'function' ? agentBusyKeys() : new Set(); } catch { return new Set(); } };
  const isWorking = (key, data) => {
    const busy = busyKeys();
    return busy.has(key) || !!data?.agents?.some(a => busy.has(a.key));
  };
  const sectionOpen = (id, fallback) => { try { const v = localStorage.getItem('chattering.made.' + id); return v == null ? fallback : v === '1'; } catch { return fallback; } };
  const rememberSection = (id, open) => { try { localStorage.setItem('chattering.made.' + id, open ? '1' : '0'); } catch {} };
  const panelShown = () => typeof rightFilesView !== 'undefined' && rightFilesView === 'made' && typeof rightFilesOpen !== 'undefined' && rightFilesOpen
    && !document.getElementById('rightFilePanel')?.hidden;

  // ---- data ------------------------------------------------------------------
  async function refresh(key, { force = false } = {}) {
    if (!key) return null;
    const entry = cache.get(key) || {};
    if (entry.loading) return entry.loading;
    if (!force && entry.at && Date.now() - entry.at < REFRESH_MIN_MS) return entry.data;
    const work = (async () => {
      try {
        const r = await fetch('/api/made?' + new URLSearchParams({ key }));
        const data = await r.json().catch(() => ({ error: 'The server answered in an unexpected way.' }));
        if (!r.ok || data.error) throw Error(data.error || 'Could not work out what this conversation made.');
        const changed = data.etag !== entry.data?.etag;
        cache.set(key, { data, at: Date.now(), etag: data.etag });
        if (changed || entry.error) repaint(key);
        else paintAge();
        return data;
      } catch (e) {
        cache.set(key, { ...entry, loading: null, at: Date.now(), error: e.message });
        repaint(key);
        return null;
      }
    })();
    cache.set(key, { ...entry, loading: work });
    return work;
  }
  function repaint(key) {
    if (key !== currentKey()) return;
    paintChip();
    if (panelShown()) render(document.getElementById('rightFileList'), { force: true });
  }
  // Keep asking while something works and someone looks; stop otherwise.
  function schedule() {
    clearTimeout(pollTimer);
    const key = currentKey();
    if (!key || document.hidden) return;
    const data = cache.get(key)?.data;
    if (!isWorking(key, data)) return;
    pollTimer = setTimeout(() => { refresh(key).finally(schedule); }, WORKING_POLL_MS);
  }

  // ---- words for states ------------------------------------------------------
  const GIT_WORDS = {
    uncommitted: ['not committed', 'warn', 'Changed on disk and not committed to git'],
    new: ['new, not committed', 'warn', 'Not yet tracked by git'],
    conflict: ['merge conflict', 'bad', 'git reports a merge conflict in this file'],
    ignored: ['ignored by git', 'muted', 'git ignores this file: it will never be committed'],
    committed: ['committed', 'ok', 'The file on disk matches the last commit'],
    outside: ['not in a git repository', 'muted', 'This file is outside any git repository'],
    unknown: ['git state unknown', 'muted', 'The git state of this file could not be read'],
  };
  const STATUS = { added: ['A', 'added'], modified: ['M', 'modified'], deleted: ['D', 'deleted'], unknown: ['?', 'history incomplete'] };
  const KIND_GLYPH = { page: '¶', web: '◧', image: '◩', video: '▷', audio: '♪', pdf: '▯', data: '▦', code: '‹›' };
  // A row says what needs a person, not what is fine: "committed" and an
  // unreadable git state stay in the tooltip; the group already says when
  // files are outside git; a file gone from disk says so instead of git.
  function fileTags(f, { outside = false } = {}) {
    const tags = [];
    const gone = f.exists === false && f.status !== 'deleted';
    if (f.restart) tags.push(['restart to use', 'warn', 'The running Chattering server loaded an older version of this file']);
    if (f.pageReload) tags.push(['reload to use', 'warn', 'This page loaded an older version of this file']);
    if (f.changedSince) tags.push([f.exists === false ? 'deleted since' : 'changed since', 'info', 'The file on disk is no longer the version this conversation produced: a person, another conversation or git changed it afterwards']);
    else if (gone) tags.push(['not on disk now', 'muted', 'The file is no longer where this conversation left it']);
    if (!gone && f.git && GIT_WORDS[f.git] && !['committed', 'unknown'].includes(f.git) && !(outside && f.git === 'outside')) tags.push(GIT_WORDS[f.git]);
    if (f.reviewed) tags.push(['✓ reviewed', 'ok', 'Marked reviewed in a review of this conversation, at the version it produced']);
    if (f.shared) tags.push(['also edited elsewhere', 'info', 'Another conversation edited this file while this one worked']);
    if (f.status === 'unknown' && f.committedVersion) tags.push(['see its commit', 'muted', 'No saved history of its edits (sub-agents before 2026-09-29 ran without it); the version it committed is complete — see Commits']);
    else if (f.status === 'unknown') tags.push(['history incomplete', 'muted', f.unavailable || 'No saved version from before and after its edits']);
    return tags;
  }
  const tagsHtml = tags => tags.map(([word, tone, tip]) => `<span class="made-tag t-${tone}" title="${h(tip)}">${h(word)}</span>`).join('<span class="made-sep" aria-hidden="true">·</span>');
  // A path as its folder and its name; a deep folder keeps its last two
  // levels (the whole path is in the row's tooltip).
  function splitPath(p) {
    const i = p.lastIndexOf('/');
    if (i < 0) return ['', p];
    const dir = p.slice(0, i + 1), parts = dir.split('/').filter(Boolean);
    return [parts.length > 3 ? '…/' + parts.slice(-2).join('/') + '/' : dir, p.slice(i + 1)];
  }
  const linesHtml = l => l ? `<span class="made-lines" aria-label="${l.add} lines added, ${l.del} removed">${l.add ? `<ins>+${n(l.add)}</ins>` : ''}${l.del ? `<del>−${n(l.del)}</del>` : ''}${!l.add && !l.del ? '<span class="made-dim">±0</span>' : ''}</span>` : '';

  // Files the page itself loaded that changed after it loaded: reloading the
  // page, not restarting the server, puts them to use.
  function markPageReloads(data) {
    if (!data.appRoot || !performance?.getEntriesByType) return;
    const loaded = new Set(performance.getEntriesByType('resource').map(e => { try { const u = new URL(e.name); return u.origin === location.origin ? u.pathname : ''; } catch { return ''; } }).filter(Boolean));
    loaded.add('/app.html');
    for (const f of data.files) {
      f.pageReload = false;
      if (!f.abs || !f.mtime || f.restart || !f.abs.startsWith(data.appRoot + '/')) continue;
      const url = '/' + f.abs.slice(data.appRoot.length + 1);
      if (loaded.has(url) && f.mtime > performance.timeOrigin) f.pageReload = true;
    }
  }

  // ---- the panel ---------------------------------------------------------------
  function render(host, { force = false } = {}) {
    if (!host) return;
    const key = currentKey();
    const entry = key ? cache.get(key) : null;
    const working = key ? isWorking(key, entry?.data) : false;
    const sig = [key, entry?.data?.etag || '', entry?.error || '', working, !!entry?.data].join('|');
    if (!force && host.dataset.madeSig === sig && host.querySelector('.made')) { paintAge(); return; }
    host.dataset.madeSig = sig;
    const scroll = host.querySelector('.made') ? host.scrollTop : 0;
    host.innerHTML = `<div class="made" data-made-key="${h(key)}">${bodyHtml(key, entry, working)}</div>`;
    host.scrollTop = scroll;
    wire(host);
    // Painting never polls: the conversation changing, a working agent
    // (schedule) and coming back to the window ask again. Only a view with
    // nothing, or with a long-settled answer, asks here.
    if (key && (!entry || (!entry.loading && Date.now() - (entry.at || 0) > QUIET_STALE_MS))) refresh(key);
    clearInterval(tickTimer);
    tickTimer = setInterval(() => { if (!panelShown()) { clearInterval(tickTimer); return; } paintAge(); }, 10000);
  }
  function paintAge() {
    const el = document.querySelector('#rightFileList .made-when');
    const at = cache.get(currentKey())?.at;
    if (el && at) el.textContent = 'checked ' + age(at) + ' ago';
  }
  function bodyHtml(key, entry, working) {
    if (!key) return '<div class="made-empty">Open a conversation to see what it made: the files it changed, the commits it made, and what it produced.</div>';
    if (!entry?.data) {
      if (entry?.error) return `<div class="made-empty">${h(entry.error)}<br><button type="button" class="made-link" data-made-refresh>Try again</button></div>`;
      return '<div class="made-empty" role="status">Gathering what this conversation made…</div>';
    }
    const d = entry.data;
    markPageReloads(d);
    const artifacts = declaredArtifacts(d);
    const nothing = !d.counts.files && !d.counts.commits && !d.outputs.length && !artifacts.length && !d.counts.reports;
    return statusHtml(d, entry, working, artifacts, nothing) +
      (nothing ? `<div class="made-empty">${working ? 'Nothing changed yet. This updates as it works.' : 'This conversation has not changed any files.'}</div>` : '') +
      changesHtml(d) + commitsHtml(d) + artifactsHtml(artifacts) + outputsHtml(d) + otherHtml(d) + helpersHtml(d) + notesHtml(d);
  }
  function statusHtml(d, entry, working, artifacts, nothing) {
    const c = d.counts;
    const reloads = d.files.filter(f => f.pageReload).length;
    const lines = [];
    if (c.toReview) lines.push(`<li class="t-warn"><span>${plural(c.toReview, 'file')} not reviewed</span></li>`);
    if (c.uncommitted) lines.push(`<li class="t-warn"><span>${plural(c.uncommitted, 'file')} not committed</span></li>`);
    const unpushed = d.repos.filter(r => r.commits.length && (r.ahead > 0 || !r.upstream));
    if (unpushed.length) lines.push(`<li class="t-warn"><span>${unpushedWords(unpushed)}</span></li>`);
    if (c.restart) lines.push(`<li class="t-warn" title="The running server loaded these files before they changed. Restarting it interrupts agents that are running now."><span>Restart Chattering to use ${plural(c.restart, 'change')}</span></li>`);
    if (reloads) lines.push(`<li class="t-warn"><span>Reload this page to use ${plural(reloads, 'change')}</span><button type="button" class="made-link" data-made-reload>Reload</button></li>`);
    if (c.changedSince) lines.push(`<li class="t-info" title="A person, another conversation or git changed these files after this conversation's last edit"><span>${plural(c.changedSince, 'file')} changed since</span></li>`);
    const failed = d.agents.filter(a => a.status === 'failed' || a.status === 'lost').length;
    if (failed) lines.push(`<li class="t-bad"><span>${plural(failed, 'sub-agent')} failed or lost</span></li>`);
    if (!lines.length && !nothing && !working) lines.push('<li class="t-ok"><span>Everything reviewed and committed</span></li>');
    const session = typeof sessions !== 'undefined' && Array.isArray(sessions) ? sessions.find(s => s.key === d.key) : null;
    const last = Date.parse(session?.lastTs || '');
    const state = working ? '<span class="made-live" aria-hidden="true"></span>working · updates as it works' : Number.isFinite(last) ? `finished ${h(age(last))} ago` : 'finished';
    const helpers = d.agents.length - 1;
    const totals = [c.files ? plural(c.files, 'file') : '', c.commits ? plural(c.commits, 'commit') : '', artifacts.length ? plural(artifacts.length, 'artifact') : '', c.outputs ? plural(c.outputs, 'output') : '', helpers ? plural(helpers, 'sub-agent') : ''].filter(Boolean).join(' · ');
    const measured = d.files.some(f => f.lines && !f.scratch && !f.report);
    return `<section class="made-status" aria-label="State">
      <div class="made-state"><span>${state}</span><span class="made-when">${entry.at ? 'checked ' + h(age(entry.at)) + ' ago' : ''}</span><button type="button" class="made-icon" data-made-refresh title="Check again now" aria-label="Check again now">↻</button></div>
      ${totals ? `<div class="made-totals"><b>${h(totals)}</b>${measured ? ` <span class="made-lines">${c.add ? `<ins>+${n(c.add)}</ins>` : ''}${c.del ? `<del>−${n(c.del)}</del>` : ''}</span>` : ''}</div>` : ''}
      ${lines.length ? `<ul class="made-needs">${lines.join('')}</ul>` : ''}
      ${c.files || c.commits ? '<button type="button" class="made-primary" data-made-review>Review all changes</button>' : ''}
    </section>`;
  }
  function unpushedWords(repos) {
    const nowhere = repos.filter(r => !r.upstream), behind = repos.filter(r => r.upstream && r.ahead > 0);
    const parts = [];
    if (behind.length) parts.push(behind.length === 1 ? `${plural(behind[0].ahead, 'commit')} not pushed on ${behind[0].branch || behind[0].name}` : `${behind.length} branches not pushed`);
    if (nowhere.length) parts.push(nowhere.length === 1 ? `branch ${nowhere[0].branch || nowhere[0].name} is only on this machine` : `${nowhere.length} branches only on this machine`);
    return h(parts.join(' · '));
  }
  function section(id, title, count, inner, { open = true, note = '' } = {}) {
    const isOpen = sectionOpen(id, open);
    return `<details class="made-sec" data-made-sec="${id}"${isOpen ? ' open' : ''}><summary><span class="made-sec-title">${h(title)}</span><span class="made-count">${n(count)}</span>${note ? `<span class="made-sec-note">${h(note)}</span>` : ''}</summary>${inner}</details>`;
  }
  function more(group, total) {
    return total > SHOWN_PER_GROUP && !expanded.has(group) ? `<button type="button" class="made-more" data-made-more="${h(group)}">Show all ${n(total)}</button>` : '';
  }
  const limit = (group, list) => expanded.has(group) ? list : list.slice(0, SHOWN_PER_GROUP);

  // Changes, by repository, then by the working folder (one per branch).
  function changesHtml(d) {
    const real = d.files.filter(f => !f.scratch && !f.report);
    const scratch = d.files.filter(f => f.scratch);
    if (!real.length && !scratch.length) return '';
    const repoOf = new Map(d.repos.map(r => [r.root, r]));
    const groups = new Map();
    for (const f of real) {
      const r = f.repo ? repoOf.get(f.repo) : null;
      const gid = r ? r.gitDir || r.root : f.git === 'outside' ? '~outside' : '~unknown';
      if (!groups.has(gid)) groups.set(gid, { repo: r, trees: new Map() });
      const tree = r ? r.root : gid;
      if (!groups.get(gid).trees.has(tree)) groups.get(gid).trees.set(tree, { repo: r, files: [] });
      groups.get(gid).trees.get(tree).files.push(f);
    }
    let out = '';
    // Repositories first (the conversation's own first); files outside any
    // repository after them, folded when there are many.
    const ordered = [...groups.entries()].sort(([a], [b]) => (a.startsWith('~') ? 1 : 0) - (b.startsWith('~') ? 1 : 0));
    for (const [gid, g] of ordered) {
      const trees = [...g.trees.values()];
      if (!g.repo) {
        const files = trees.flatMap(t => t.files), id = gid === '~outside' ? 'outside' : 'unknown';
        const label = gid === '~outside' ? `${plural(files.length, 'file')} outside a git repository` : `${plural(files.length, 'file')} whose location is unknown`;
        out += `<details class="made-sub" data-made-sec="${id}"${sectionOpen(id, files.length <= 6) ? ' open' : ''}><summary>${h(label)}</summary><div role="list">${limit(id, files).map(f => fileRow(d, f, { outside: true })).join('')}</div>${more(id, files.length)}</details>`;
        continue;
      }
      const name = g.repo.repo || g.repo.name;
      out += `<div class="made-group"><div class="made-group-head"><b>${h(name)}</b>${trees.length === 1 ? branchHtml(g.repo) : `<span class="made-dim"> · ${trees.length} working folders</span>`}</div>`;
      if (trees.length === 1) {
        const t = trees[0], group = 'files:' + t.repo.root;
        out += `<div role="list">${limit(group, t.files).map(f => fileRow(d, f, { root: t.repo.root })).join('')}</div>${more(group, t.files.length)}`;
      } else {
        // Several working folders (a worktree per branch, usually one per
        // sub-agent): each is one line to open, its agent named once.
        const total = trees.reduce((sum, t) => sum + t.files.length, 0);
        for (const t of trees) {
          const agents = [...new Set(t.files.flatMap(f => f.agents || []))];
          const agent = agents.length === 1 ? agents[0] : null;
          const who = agent === null ? `${agents.length} agents` : agent === 0 ? 'main conversation' : d.agents[agent]?.title || 'sub-agent';
          const id = 'tree:' + t.repo.root, group = 'files:' + t.repo.root;
          const waiting = t.files.filter(f => ['uncommitted', 'new', 'conflict'].includes(f.git)).length;
          out += `<details class="made-tree" data-made-sec="${h(id)}"${sectionOpen(id, total <= 20) ? ' open' : ''}><summary title="${h(t.repo.root)}"><span class="made-l1"><span class="made-name">${h(t.repo.branch || t.repo.name)}</span><span class="made-count">${n(t.files.length)}</span></span>
            <span class="made-l2"><span class="made-agent" title="${h(who)}">${h(who)}</span>${waiting ? `<span class="made-sep">·</span><span class="made-tag t-warn">${n(waiting)} not committed</span>` : ''}${branchState(t.repo) ? '<span class="made-sep">·</span>' + branchState(t.repo) : ''}</span></summary>
            <div role="list">${limit(group, t.files).map(f => fileRow(d, f, { root: t.repo.root, agent })).join('')}</div>${more(group, t.files.length)}</details>`;
        }
      }
      out += '</div>';
    }
    if (scratch.length) out += `<details class="made-sub" data-made-sec="scratch"${sectionOpen('scratch', false) ? ' open' : ''}><summary>${plural(scratch.length, 'scratch file')} in temporary folders</summary><div role="list">${limit('scratch', scratch).map(f => fileRow(d, f)).join('')}</div>${more('scratch', scratch.length)}</details>`;
    return section('changes', 'Changes', real.length, out, { note: d.agents.length > 1 ? `with ${plural(d.agents.length - 1, 'sub-agent')}` : '' });
  }
  // A branch against its upstream, in words.
  function branchState(r) {
    if (!r) return '';
    return r.error ? `<span class="made-tag t-muted" title="${h(r.error)}">git unreadable</span>`
      : !r.branch ? '<span class="made-tag t-muted">detached</span>'
      : !r.upstream ? (r.commits.length ? '<span class="made-tag t-warn" title="No upstream branch: these commits exist only on this machine">only on this machine</span>' : '')
      : r.ahead ? `<span class="made-tag t-warn" title="${h(r.upstream)}">${plural(r.ahead, 'commit')} not pushed</span>`
      : r.behind ? `<span class="made-tag t-muted">${n(r.behind)} behind ${h(r.upstream)}</span>` : `<span class="made-tag t-ok" title="${h(r.upstream)}">pushed</span>`;
  }
  function branchHtml(r) {
    if (!r) return '';
    const state = branchState(r);
    return `${r.branch ? `<span class="made-branch"> · ${h(r.branch)}</span>` : ''}${state ? ' ' + state : ''}`;
  }
  // A file: its name, its folder within its working folder, who changed it
  // (when not already said by the group), and what needs a person.
  function fileRow(d, f, context = {}) {
    const shown = context.root && f.abs && f.abs.startsWith(context.root + '/') ? f.abs.slice(context.root.length + 1) : f.path;
    const [dir, base] = splitPath(shown);
    const [letter, word] = STATUS[f.status] || STATUS.unknown;
    const own = context.agent !== undefined && context.agent !== null && f.agents?.length === 1 && f.agents[0] === context.agent;
    const agents = d.agents.length > 1 && f.agents?.length && !own ? f.agents.map(i => i === 0 ? 'main' : d.agents[i]?.title || 'sub-agent') : [];
    const tip = `${f.path}\n${word}${agents.length ? '\nby ' + agents.join(', ') : ''}\nOpen its comparison in the review`;
    const tags = fileTags(f, context);
    return `<div class="made-row" role="listitem"><button type="button" class="made-main" data-made-file="${h(f.path)}" title="${h(tip)}">
      <span class="made-l1"><span class="made-st st-${h(f.status)}" aria-label="${h(word)}">${letter}</span><span class="made-name">${h(base)}</span>${linesHtml(f.lines)}</span>
      <span class="made-l2">${dir ? `<span class="made-dir">${h(dir)}</span>` : ''}${agents.length ? `<span class="made-agent">${h(agents.length > 1 ? agents[0] + ' +' + (agents.length - 1) : agents[0])}</span>` : ''}${tags.length ? `<span class="made-tags">${tagsHtml(tags)}</span>` : ''}</span></button>
      ${f.abs && f.exists !== false ? `<span class="made-acts"><button type="button" class="made-icon" data-made-open="${h(f.abs)}" title="Open the file as it is now" aria-label="Open ${h(base)}">↗</button></span>` : ''}</div>`;
  }
  // Commits the agents made, by repository and branch, newest first.
  function commitsHtml(d) {
    const byRepo = new Map();
    for (const r of d.repos) {
      if (!r.commits.length) continue;
      const gid = r.gitDir || r.root;
      if (!byRepo.has(gid)) byRepo.set(gid, { name: r.repo || r.name, branches: [] });
      byRepo.get(gid).branches.push(r);
    }
    if (!byRepo.size) return '';
    let out = '', total = 0;
    for (const [gid, g] of byRepo) {
      out += `<div class="made-group"><div class="made-group-head"><b>${h(g.name)}</b>${g.branches.length > 1 ? `<span class="made-dim"> · ${n(g.branches.length)} branches</span>` : ''}</div>`;
      const seen = new Set();
      for (const r of g.branches) {
        const commits = r.commits.filter(c => !seen.has(c.hash)).sort((a, b) => (b.at || 0) - (a.at || 0));
        commits.forEach(c => seen.add(c.hash));
        total += commits.length;
        const group = 'commits:' + r.root;
        const state = branchState(r);
        out += `<div class="made-tree-head">${h(r.branch || r.name)}${state ? ' ' + state : ''}${r.foreign ? `<span class="made-dim" title="Commits in the same range that none of these agents made"> · ${plural(r.foreign, 'commit')} by others</span>` : ''}</div>`;
        out += commits.length ? `<div role="list">${limit(group, commits).map(c => `<div class="made-row" role="listitem"><button type="button" class="made-main" data-made-commits title="${h(c.hash + '\n' + c.subject)}\nOpen the commits in the review"><span class="made-l1"><code class="made-hash">${h(c.hash.slice(0, 7))}</code><span class="made-name made-subject">${h(c.subject)}</span>${c.at ? `<span class="made-age">${h(age(c.at))}</span>` : ''}</span></button></div>`).join('')}</div>${more(group, commits.length)}`
          : '<div class="made-dim made-pad">the same commits as the branch above</div>';
      }
      out += '</div>';
    }
    return section('commits', 'Commits', total, out);
  }
  // Artifacts the agents declared (design/67), from the conversation list.
  function declaredArtifacts(d) {
    if (!window.Artifacts?.library) return [];
    const keys = new Set(d.agents.map(a => a.key));
    try { return Artifacts.library.items().filter(it => keys.has(it.key)); } catch { return []; }
  }
  function artifactsHtml(list) {
    if (!list.length) return '';
    const rows = list.map(it => {
      const glyph = it.widget ? '◇' : KIND_GLYPH[{ web: 'web', slides: 'web', pdf: 'pdf', markdown: 'page', image: 'image', video: 'video' }[it.kind] || 'web'];
      return `<div class="made-row" role="listitem"><button type="button" class="made-main" data-made-art="${h(it.key + '\n' + (it.path || it.call || ''))}" title="${h((it.title || 'Artifact') + (it.path ? '\n' + it.path : '') + '\nOpen it where it was made')}">
        <span class="made-l1"><span class="made-glyph" aria-hidden="true">${glyph}</span><span class="made-name">${h(it.title || 'Artifact')}</span>${it.ts ? `<span class="made-age">${h(age(Date.parse(it.ts)))}</span>` : ''}</span>
        ${it.path ? `<span class="made-l2"><span class="made-dir">${h(it.path.replace(/^.*\/(?=[^/]+\/[^/]+$)/, '…/'))}</span></span>` : ''}</button></div>`;
    }).join('');
    return section('artifacts', 'Artifacts', list.length, `<div role="list">${rows}</div>`);
  }
  // Pictures, PDFs, pages and data its commands wrote; the rest folded.
  function outputsHtml(d) {
    const shown = d.outputs.filter(o => o.shown), rest = d.outputs.filter(o => !o.shown);
    if (!shown.length && !rest.length) return '';
    const row = o => {
      const [dir, base] = splitPath(o.path);
      // A picture shows itself; if it cannot be read, its glyph stays.
      const thumb = o.kind === 'image' ? `<img class="made-thumb" alt="" loading="lazy" src="/api/file/media?${h(new URLSearchParams({ id: d.key, path: o.abs }).toString())}" onerror="this.remove()">` : '';
      return `<div class="made-row" role="listitem"><button type="button" class="made-main" data-made-open="${h(o.abs)}" title="${h(o.path + (o.inferred ? '\nWritten by a command it ran (read from the command, not verified)' : ''))}">
        <span class="made-l1"><span class="made-glyph${thumb ? ' made-has-thumb' : ''}" aria-hidden="true">${KIND_GLYPH[o.kind] || '‹›'}${thumb}</span><span class="made-name">${h(base)}</span>${o.mtime ? `<span class="made-age">${h(age(o.mtime))}</span>` : ''}</span>
        ${dir ? `<span class="made-l2"><span class="made-dir">${h(dir)}</span></span>` : ''}</button></div>`;
    };
    const scratchNote = (d.counts.outputsUnlisted ? `<div class="made-dim made-pad">and ${plural(d.counts.outputsUnlisted, 'more file')} its commands wrote</div>` : '') +
      (d.counts.scratchOutputs ? `<div class="made-dim made-pad">${plural(d.counts.scratchOutputs, 'file')} in temporary folders not listed</div>` : '');
    // Nothing to look at: only the files its commands wrote, folded.
    if (!shown.length) return section('written', 'Files its commands wrote', rest.length, `<div role="list">${limit('outputs-rest', rest).map(row).join('')}</div>${more('outputs-rest', rest.length)}${scratchNote}`, { open: false });
    let inner = `<div role="list" class="made-outputs">${limit('outputs', shown).map(row).join('')}</div>${more('outputs', shown.length)}`;
    if (rest.length) inner += `<details class="made-sub" data-made-sec="outputs-rest"${sectionOpen('outputs-rest', false) ? ' open' : ''}><summary>${plural(rest.length, 'other file')} its commands wrote</summary><div role="list">${limit('outputs-rest', rest).map(row).join('')}</div>${more('outputs-rest', rest.length)}</details>`;
    return section('outputs', 'Outputs', shown.length, inner + scratchNote);
  }
  function otherHtml(d) {
    if (!d.other.count) return '';
    const rows = d.other.files.map(f => {
      const [dir, base] = splitPath(f.path), [letter, word] = STATUS[f.status] || STATUS.unknown;
      return `<div class="made-row" role="listitem"><button type="button" class="made-main" ${f.abs ? `data-made-open="${h(f.abs)}"` : 'disabled'} title="${h(f.path + '\n' + word)}"><span class="made-l1"><span class="made-st st-${h(f.status)}" aria-label="${h(word)}">${letter}</span><span class="made-name">${h(base)}</span>${linesHtml(f.lines)}</span>${dir ? `<span class="made-l2"><span class="made-dir">${h(dir)}</span></span>` : ''}</button></div>`;
    }).join('');
    return section('other', 'Also changed while it worked', d.other.count,
      `<p class="made-note">Changes in the same folders during its steps that none of its steps targeted: another conversation, a person, a build. Not proof that this conversation made them.</p><div role="list">${rows}</div>${d.other.count > d.other.files.length ? `<div class="made-dim made-pad">and ${n(d.other.count - d.other.files.length)} more, listed in the review</div>` : ''}`,
      { open: false });
  }
  function helpersHtml(d) {
    const helpers = d.agents.slice(1);
    if (!helpers.length) return '';
    const busy = busyKeys();
    const counts = {};
    for (const a of helpers) { const s = busy.has(a.key) ? 'running' : a.status || 'unknown'; counts[s] = (counts[s] || 0) + 1; }
    const words = { running: 'running', succeeded: 'done', failed: 'failed', lost: 'lost', cancelled: 'cancelled', unknown: 'state unknown' };
    const note = Object.entries(counts).map(([s, c]) => `${n(c)} ${words[s] || s}`).join(' · ');
    const rows = limit('helpers', helpers).map(a => {
      const state = busy.has(a.key) ? 'running' : words[a.status] || a.status || '';
      const tone = state === 'failed' || state === 'lost' ? 'bad' : state === 'running' ? 'info' : 'muted';
      const report = a.reports?.[0];
      return `<div class="made-row" role="listitem"><button type="button" class="made-main" data-made-conv="${h(a.key)}" title="${h(a.title)}
Open this sub-agent's conversation">
        <span class="made-l1"><span class="made-name" style="padding-left:${Math.min(4, Math.max(0, a.depth - 1)) * 10}px">${h(a.title)}</span></span>
        <span class="made-l2"><span class="made-tag t-${tone}">${h(state)}</span>${a.files ? `<span class="made-sep">·</span><span class="made-dir">${plural(a.files, 'file')}</span>` : ''}</span></button>
        ${report ? `<span class="made-acts made-acts-shown"><button type="button" class="made-link" data-made-open="${h(report.abs)}" title="${h(report.path)}">report</button></span>` : ''}</div>`;
    }).join('');
    return section('helpers', 'Sub-agents', helpers.length, `<div role="list">${rows}</div>${more('helpers', helpers.length)}`, { open: helpers.length <= 8, note });
  }
  function notesHtml(d) {
    if (!d.warnings.length) return '';
    return section('notes', 'Notes', d.warnings.length, `<ul class="made-warnings">${d.warnings.map(w => `<li>${h(w)}</li>`).join('')}</ul>`, { open: false });
  }

  // ---- actions -------------------------------------------------------------------
  function wire(host) {
    if (host.dataset.madeWired) return;
    host.dataset.madeWired = '1';
    host.addEventListener('toggle', e => {
      const sec = e.target.closest?.('[data-made-sec]');
      if (sec && e.target === sec) rememberSection(sec.dataset.madeSec, sec.open);
    }, true);
    host.addEventListener('click', e => {
      const t = e.target.closest('[data-made-file],[data-made-open],[data-made-review],[data-made-commits],[data-made-art],[data-made-refresh],[data-made-more],[data-made-conv],[data-made-reload]');
      if (!t || !host.querySelector('.made')?.contains(t)) return;
      e.stopPropagation();
      const key = host.querySelector('.made').dataset.madeKey;
      if (t.dataset.madeFile !== undefined) openReview(key, { path: t.dataset.madeFile });
      else if (t.dataset.madeOpen !== undefined) openFile(key, t.dataset.madeOpen);
      else if (t.dataset.madeReview !== undefined) openReview(key);
      else if (t.dataset.madeCommits !== undefined) openReview(key, { scope: 'branch' });
      else if (t.dataset.madeArt !== undefined) openArtifact(t.dataset.madeArt);
      else if (t.dataset.madeRefresh !== undefined) { const el = host.querySelector('.made-when'); if (el) el.textContent = 'checking…'; refresh(key, { force: true }); }
      else if (t.dataset.madeMore !== undefined) { expanded.add(t.dataset.madeMore); render(host, { force: true }); }
      else if (t.dataset.madeConv !== undefined && typeof open === 'function') open(t.dataset.madeConv);
      else if (t.dataset.madeReload !== undefined) location.reload();
    });
  }
  // The whole-conversation review (design/79), at one file or one scope.
  // Building it can take a moment the first time; the row says so.
  async function openReview(key, { path = '', scope = 'task' } = {}) {
    if (typeof crRequest !== 'function' || typeof showChangeReview !== 'function') return;
    const origin = typeof currentHash !== 'undefined' ? currentHash : '';
    const pending = setTimeout(() => typeof toast === 'function' && toast('Gathering every change this conversation and its sub-agents made…'), 600);
    let review;
    try { review = await crRequest('/api/reviews/conversation', { key }); }
    catch (e) { clearTimeout(pending); return typeof errToast === 'function' && errToast(e.message); }
    clearTimeout(pending);
    if (typeof currentHash !== 'undefined' && currentHash !== origin) return typeof toast === 'function' && toast('The review is ready', () => showChangeReview(review.id, '', scope));
    await showChangeReview(review.id, '', scope);
    if (!path) return;
    for (let i = 0; i < 60; i++) {
      const card = [...document.querySelectorAll('.cr-file')].find(c => c.crFile?.path === path);
      if (card) { card.open = true; card.scrollIntoView({ block: 'start' }); card.querySelector('summary')?.focus({ preventScroll: true }); return; }
      await new Promise(r => setTimeout(r, 100));
    }
  }
  function openFile(key, abs) {
    if (typeof openPathInApp === 'function') return openPathInApp({ key, path: abs });
    if (typeof openLiveFile === 'function') return openLiveFile(abs, {});
  }
  function openArtifact(id) {
    const [key, where] = id.split('\n');
    const it = window.Artifacts?.library?.items().find(x => x.key === key && (x.path || x.call || '') === where);
    if (it) Artifacts.library.openItem(it);
  }

  // ---- the header chip ---------------------------------------------------------
  // In the conversation's header: what it made, in a few words, and the way
  // to this panel. Replaces "± changes", which opened the review directly.
  function chipText(d) {
    if (!d) return '± changes';
    const c = d.counts;
    const made = c.files ? `± ${plural(c.files, 'file')}` : c.commits ? plural(c.commits, 'commit') : c.outputs ? plural(c.outputs, 'output') : '';
    if (!made) return '';
    const state = c.restart ? 'restart to use' : c.toReview ? `${n(c.toReview)} to review` : c.uncommitted ? `${n(c.uncommitted)} not committed` : '';
    return state ? `${made} · ${state}` : made;
  }
  function paintChip() {
    const b = document.getElementById('convChanges');
    if (!b || b.dataset.key !== currentKey()) return;
    const d = cache.get(b.dataset.key)?.data;
    const text = chipText(d);
    b.hidden = d ? !text && !isWorking(b.dataset.key, d) : false;
    b.textContent = text || '± changes';
    b.classList.toggle('made-chip-warn', !!(d && (d.counts.restart || d.counts.toReview)));
    b.setAttribute('aria-pressed', String(panelShown()));
  }
  function headerChip(d, host) {
    const b = document.createElement('button');
    b.id = 'convChanges'; b.type = 'button'; b.className = 'made-chip'; b.dataset.key = d.key;
    b.title = 'What this conversation made: every file it and its sub-agents changed, and what state each is in';
    b.onclick = () => toggle();
    host.append(b);
    paintChip();
  }
  function toggle() {
    if (panelShown()) { if (typeof closeRightFiles === 'function') closeRightFiles(); }
    else openPanel();
    paintChip();
  }
  function openPanel() {
    if (typeof setRightView === 'function') setRightView('made');
    paintChip();
  }

  // ---- following the page --------------------------------------------------------
  // After every transcript render of a conversation (app.html).
  function onConversation(d) {
    if (!d || d.draft || !d.key) return;
    // While it works, the poll keeps up; each streamed repaint does not ask.
    const entry = cache.get(d.key);
    const working = isWorking(d.key, entry?.data);
    if (!working || !entry?.at || Date.now() - entry.at > WORKING_POLL_MS) refresh(d.key).then(schedule);
    else schedule();
    if (panelShown()) render(document.getElementById('rightFileList'));
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && currentKey()) refresh(currentKey()).then(schedule); else clearTimeout(pollTimer); });

  window.Made = { render, refresh, onConversation, headerChip, open: openPanel, toggle, chipText, fileTags, _cache: cache };
})();
