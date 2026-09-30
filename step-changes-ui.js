// Files a conversation's steps changed, read where they changed (design/88).
//
// Under each box of steps: one row per file (new, changed, deleted), its
// folder and lines added and removed. A row opens the change right there,
// in the conversation: a diff for a changed file, the file itself to read
// for a new one (a Markdown file as a page), a picture as a picture.
// Inside the box, each step's own files carry the same card for that one
// step. Nothing opens by itself.
//
// The list comes from /api/conversation/changes (step-changes.js): the
// steps' saved snapshots when there are some, else what the conversation
// recorded. Rows the transcript already knows (edit and write tools) are
// drawn at once, before the answer, so the page does not jump.
(function () {
  'use strict';
  const KIND = {
    added: ['A', 'new file'], modified: ['M', 'changed'], deleted: ['D', 'deleted'], written: ['W', 'written (whether it existed before is not on record)'],
  };
  const CONTEXT = 3;          // unchanged lines kept around a change
  const FIRST_ROWS = 400;     // rows of a diff drawn before "show more"
  const READ_FIRST = 60;      // lines of a new file shown before "show all"
  const READ_MAX = 5000;      // lines drawn at most; the rest opens the file
  const LINE_MAX = 2000;      // characters of one line drawn

  const data = new Map();     // key → { groups: Map(sig → group), steps: Map(call → files) }
  const cards = new Map();    // key → Map(cardId → state)
  const contents = new Map(); // key \0 cardId → content (a few dozen kept)
  const inflight = new Map(); // key → Promise
  const retries = new Map();

  const e = s => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]));
  const sigOf = calls => calls.join(',');
  // A newline apart: HTML attributes keep it (a NUL would become U+FFFD).
  const cardId = (calls, path) => sigOf(calls) + '\n' + path;
  const store = key => { let d = data.get(key); if (!d) { d = { groups: new Map(), steps: new Map() }; data.set(key, d); } return d; };
  const openOf = key => { let m = cards.get(key); if (!m) { m = new Map(); cards.set(key, m); } return m; };
  function remember(key, id, value) {
    contents.set(key + '\0' + id, value);
    while (contents.size > 40) contents.delete(contents.keys().next().value);
  }
  const baseName = p => String(p).split(/[\\/]/).pop();

  // ---- rows ----
  function countHtml(f) {
    if (f.pending) return '';
    if (f.image) return '<span class="sc-n"><span class="sc-meta">picture</span></span>';
    if (f.binary) return '<span class="sc-n"><span class="sc-meta">binary</span></span>';
    if (f.add == null && f.del == null) return '';
    if (f.kind === 'added' || f.kind === 'written') return `<span class="sc-n"><span class="sc-add">+${f.add ?? 0}</span></span>`;
    if (f.kind === 'deleted') return `<span class="sc-n"><span class="sc-del">−${f.del ?? 0}</span></span>`;
    return `<span class="sc-n"><span class="sc-add">+${f.add ?? 0}</span><span class="sc-del">−${f.del ?? 0}</span></span>`;
  }
  function tagsHtml(f) {
    const t = [];
    if (f.how === 'command') t.push('<span class="sc-tag" title="Read from the command, not observed: this is the file as it is now">from the command</span>');
    if (f.how === 'observed') t.push('<span class="sc-tag sc-quiet" title="The step did not name this file; comparing the folder before and after it shows the change">found</span>');
    if (f.shared) t.push('<span class="sc-tag sc-warn" title="Another conversation changed this file at the same time">also edited elsewhere</span>');
    if (f.steps > 1) t.push(`<span class="sc-tag sc-quiet" title="Changed by ${f.steps} steps; this is the change of all of them together">${f.steps} steps</span>`);
    return t.join('');
  }
  function rowTitle(f) {
    const how = { named: 'Seen before and after the step', observed: 'Found by comparing the folder before and after the step', recorded: 'As the edit tool recorded it', command: 'Read from the command; not observed' }[f.how] || '';
    return `${f.path}\n${(KIND[f.kind] || KIND.modified)[1]}${how ? ' · ' + how : ''}\nClick: read the change here · Shift-click: full page`;
  }
  function rowHtml(key, calls, f, open) {
    const [letter] = KIND[f.kind] || ['·'];
    const id = cardId(calls, f.path);
    return `<li class="sc-item" data-sc-path="${e(f.path)}">` +
      `<button type="button" class="sc-row${f.pending ? ' sc-wait' : ''}" data-file-diff="${e(f.path)}" data-file-call="${e(calls[calls.length - 1] || '')}" data-sc-calls="${e(sigOf(calls))}" aria-expanded="${open ? 'true' : 'false'}" title="${e(rowTitle(f))}">` +
      `<span class="sc-caret" aria-hidden="true"></span><span class="sc-kind" data-kind="${e(f.kind || '')}" aria-label="${e((KIND[f.kind] || ['', ''])[1])}">${f.pending ? '·' : letter}</span>` +
      `<span class="sc-name">${e(f.name || baseName(f.path))}</span><span class="sc-dir">${e(f.dir || '')}</span>${tagsHtml(f)}${countHtml(f)}</button>` +
      (open ? cardShellHtml(key, id) : '') + '</li>';
  }
  function foldHtml(key, calls, files, label, title, cls) {
    if (!files.length) return '';
    const open = files.some(f => openOf(key).has(cardId(calls, f.path)));
    return `<li class="sc-item sc-fold ${cls}"><details${open ? ' open' : ''}><summary title="${e(title)}"><span class="sc-caret" aria-hidden="true"></span>${e(label)}</summary>` +
      `<ul class="sc-list">${files.map(f => rowHtml(key, calls, f, openOf(key).has(cardId(calls, f.path)))).join('')}</ul></details></li>`;
  }
  function listHtml(key, calls, g) {
    const main = g.files.filter(f => !f.scratch), scratch = g.files.filter(f => f.scratch);
    const open = f => openOf(key).has(cardId(calls, f.path));
    return main.map(f => rowHtml(key, calls, f, open(f))).join('') +
      foldHtml(key, calls, scratch, `${scratch.length} temporary ${scratch.length === 1 ? 'file' : 'files'}`, 'Files in a temporary folder outside the project: the agent\u2019s scratch work', 'sc-scratch') +
      foldHtml(key, calls, g.during || [], `${g.during.length} ${g.during.length === 1 ? 'file' : 'files'} also changed while this ran`,
        'Other work ran in the same folder at the same time; these changes may not be these steps\u2019', 'sc-during');
  }

  /** The list under one box of steps. known: paths its edit and write tools name. */
  function stripHtml(key, calls, known = []) {
    const g = store(key).groups.get(sigOf(calls));
    const shown = g || { files: known.map(p => ({ path: p, name: baseName(p), dir: '', pending: true })), during: [] };
    const empty = !shown.files.length && !(shown.during || []).length;
    return `<section class="sc-strip" data-sc-key="${e(key)}" data-sc-calls="${e(sigOf(calls))}" aria-label="Files these steps changed"${empty ? ' hidden' : ''}><ul class="sc-list">${empty ? '' : listHtml(key, calls, shown)}</ul></section>`;
  }

  /** A step's own files, on its line inside the box (shell and other tools). */
  function chipsHtml(key, call) {
    const files = store(key).steps.get(call) || [];
    return `<span class="sc-chips" data-sc-key="${e(key)}" data-sc-call="${e(call)}">${files.map(f => chipHtml(call, f)).join('')}</span>`;
  }
  function chipHtml(call, f) {
    const [letter] = KIND[f.kind] || ['·'];
    return `<button type="button" class="sc-chip" data-file-diff="${e(f.path)}" data-file-call="${e(call)}" data-sc-calls="${e(call)}" title="${e(rowTitle(f))}"><span class="sc-kind" data-kind="${e(f.kind)}">${letter}</span>${e(f.name)}${countHtml(f)}</button>`;
  }
  /** Lines added and removed, beside an edit step's file name. */
  function countSlot(key, call, path) {
    const f = (store(key).steps.get(call) || []).find(x => x.path === path);
    return `<span class="sc-count" data-sc-key="${e(key)}" data-sc-count="${e(call)}" data-sc-path="${e(path)}">${f ? countHtml(f) : ''}</span>`;
  }

  // ---- asking the server ----
  function groupsOn(root, key) {
    const out = new Map();
    for (const s of root.querySelectorAll('.sc-strip')) if (s.dataset.scKey === key) out.set(s.dataset.scCalls, s.dataset.scCalls.split(',').filter(Boolean));
    return out;
  }
  // The page may be redrawn while an answer is on its way (a conversation
  // renders in stages): what arrives is drawn into whatever is on screen
  // then, and boxes that appeared meanwhile are asked about next.
  const surface = root => (root && root.isConnected ? root : document.getElementById('view') || document);
  async function hydrate(root, key) {
    if (!root || !key) return;
    const d = store(key), asked = new Set();
    for (let round = 0; round < 3; round++) {
      const on = groupsOn(surface(root), key);
      const need = [...on].filter(([sig]) => { const g = d.groups.get(sig); return !asked.has(sig) && (!g || g.pending); }).map(([, calls]) => calls);
      need.forEach(calls => asked.add(sigOf(calls)));
      if (!need.length) break;
      if (inflight.has(key)) { try { await inflight.get(key); } catch {} continue; }
      const work = (async () => {
        const res = await fetch('/api/conversation/changes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: key, groups: need }) });
        const out = await res.json();
        if (!res.ok || out.error) throw Error(out.error || 'The changes could not be read');
        need.forEach((calls, i) => {
          const g = out.groups[i]; if (!g) return;
          const sig = sigOf(calls), before = d.groups.get(sig);
          d.groups.set(sig, g);
          // A box still growing: what was read of its files may be stale.
          if (before?.pending) for (const k of [...contents.keys()]) if (k.startsWith(key + '\0' + sig + '\n')) contents.delete(k);
        });
        for (const [call, files] of Object.entries(out.steps || {})) d.steps.set(call, files);
      })();
      inflight.set(key, work);
      try { await work; } catch (err) { console.warn('changes of the steps:', err.message); break; } finally { inflight.delete(key); }
    }
    paint(surface(root), key);
    // A box whose steps are still running is asked again shortly.
    if ([...groupsOn(surface(root), key).keys()].some(sig => d.groups.get(sig)?.pending)) {
      clearTimeout(retries.get(key));
      retries.set(key, setTimeout(() => { retries.delete(key); hydrate(surface(root), key); }, 4000));
    }
  }

  function paint(root, key) {
    const d = store(key);
    for (const s of root.querySelectorAll('.sc-strip')) {
      if (s.dataset.scKey !== key) continue;
      const g = d.groups.get(s.dataset.scCalls);
      if (!g) continue;
      const calls = s.dataset.scCalls.split(',');
      const html = listHtml(key, calls, g);
      const list = s.querySelector(':scope > .sc-list');
      // Unchanged rows are left alone: an open card keeps its scroll and marks.
      if (list._html !== html) {
        const had = new Map([...list.querySelectorAll(':scope .sc-card')].map(c => [c.dataset.scCard, c]));
        list.innerHTML = html; list._html = html;
        for (const shell of list.querySelectorAll('.sc-card')) {
          const old = had.get(shell.dataset.scCard);
          if (old && old.dataset.ready) shell.replaceWith(old); else fillCard(shell, key);
        }
      }
      s.hidden = !g.files.length && !(g.during || []).length;
    }
    for (const c of root.querySelectorAll('.sc-chips')) {
      if (c.dataset.scKey !== key) continue;
      const files = d.steps.get(c.dataset.scCall) || [];
      const html = files.map(f => chipHtml(c.dataset.scCall, f)).join('');
      if (c._html !== html) { c.innerHTML = html; c._html = html; }
    }
    for (const c of root.querySelectorAll('.sc-count')) {
      if (c.dataset.scKey !== key) continue;
      const f = (d.steps.get(c.dataset.scCount) || []).find(x => x.path === c.dataset.scPath);
      const html = f ? countHtml(f) : '';
      if (c.innerHTML !== html) c.innerHTML = html;
    }
    // "Review whole turn" only where the turn changed files.
    for (const b of root.querySelectorAll('.tg-review-turn[data-sc-turn]')) {
      let calls; try { calls = new Set(JSON.parse(b.dataset.stepReview).calls); } catch { continue; }
      let files = 0;
      for (const [sig, g] of d.groups) if (calls.has(sig.split(',')[0])) files += g.files.length;
      b.hidden = !files;
      const label = b.querySelector('.sc-turn-files');
      if (label) label.textContent = files ? `\u00a0· ${files} ${files === 1 ? 'file' : 'files'}` : '';
    }
    // Step cards open before a re-render come back after their step.
    for (const [id, st] of openOf(key)) {
      if (!st.step || root.querySelector(`.sc-card[data-sc-card="${CSS.escape(id)}"]`)) continue;
      const btn = [...root.querySelectorAll('[data-sc-calls]')].find(b => !b.closest('.sc-strip') && b.dataset.scCalls === st.calls.join(',') && b.dataset.fileDiff === st.path);
      if (btn) placeStepCard(btn, key, id);
    }
    marks.prune();
  }

  // ---- opening and closing ----
  /** A row, chip or edit step's file name was pressed. true: handled here. */
  function claims(button) { return !!(button && button.dataset && button.dataset.scCalls); }
  function toggle(button) {
    const key = button.closest('[data-sc-key]')?.dataset.scKey || button.closest('[data-msg-key]')?.dataset.msgKey;
    if (!key) return false;
    const calls = button.dataset.scCalls.split(',').filter(Boolean), path = button.dataset.fileDiff, id = cardId(calls, path);
    const open = openOf(key);
    const inStrip = !!button.closest('.sc-strip');
    if (open.has(id)) {
      open.delete(id);
      const card = inStrip ? button.parentElement.querySelector(':scope > .sc-card') : document.querySelector(`.sc-card[data-sc-card="${CSS.escape(id)}"]`);
      if (card) card.remove();
      button.setAttribute('aria-expanded', 'false');
      marks.prune();
      return true;
    }
    open.set(id, { calls, path, step: !inStrip, mode: null });
    if (inStrip) {
      button.insertAdjacentHTML('afterend', cardShellHtml(key, id));
      fillCard(button.nextElementSibling, key);
    } else placeStepCard(button, key, id);
    button.setAttribute('aria-expanded', 'true');
    return true;
  }
  function placeStepCard(button, key, id) {
    const step = button.closest('.msg') || button;
    let at = step;
    while (at.nextElementSibling && at.nextElementSibling.matches('.sc-card.sc-step-card')) at = at.nextElementSibling;
    at.insertAdjacentHTML('afterend', cardShellHtml(key, id, true));
    fillCard(at.nextElementSibling, key);
    button.setAttribute('aria-expanded', 'true');
  }
  function cardShellHtml(key, id, step = false) {
    return `<div class="sc-card${step ? ' sc-step-card' : ''}" data-sc-card="${e(id)}" data-sc-key="${e(key)}" role="region" aria-label="Change to ${e(baseName(id.split('\n')[1]))}"><div class="sc-card-head"><span class="sc-what">Reading the change…</span></div></div>`;
  }

  async function fillCard(card, key) {
    const id = card.dataset.scCard, st = openOf(key).get(id);
    if (!st) return;
    let c = contents.get(key + '\0' + id);
    if (!c) {
      try {
        const q = new URLSearchParams({ id: key, calls: st.calls.join(','), path: st.path });
        const res = await fetch('/api/conversation/change?' + q);
        c = await res.json();
        if (!res.ok || c.error) throw Error(c.error || 'The change could not be read');
      } catch (err) {
        if (!card.isConnected) return;
        card.innerHTML = `<div class="sc-card-head"><span class="sc-what">${e(err.message)}</span><span class="sc-acts"><button type="button" data-sc-act="open">open the file</button></span></div>`;
        wireCard(card, key, st, null);
        return;
      }
      remember(key, id, c);
    }
    if (!card.isConnected) return;
    try { renderCard(card, key, st, c); }
    catch (err) {
      // Never a card stuck on "Reading…": say so, and keep the file one press away.
      console.error(err);
      card.innerHTML = `<div class="sc-card-head"><span class="sc-what">This change could not be drawn here (${e(err.message)}).</span><span class="sc-acts"><button type="button" data-sc-act="open">open the file</button></span></div>`;
      wireCard(card, key, st, c);
    }
  }

  // ---- the card ----
  function lang(path) { return typeof fileHighlightLang === 'function' ? fileHighlightLang(path) : 'txt'; }
  const isMd = p => /\.(md|markdown|mdx)$/i.test(p);
  function whatHtml(c, st) {
    const n = t => { const k = t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0; return `${k.toLocaleString()} ${k === 1 ? 'line' : 'lines'}`; };
    const main = c.kind === 'added' ? 'New file' + (c.next?.text != null ? ' · ' + n(c.next.text) : '')
      : c.kind === 'deleted' ? 'Deleted' + (c.old?.text != null ? ' · it had ' + n(c.old.text) : '')
      : c.kind === 'written' ? 'Written' + (c.next?.text != null ? ' · ' + n(c.next.text) : '')
      : 'Changed' + (c.add != null ? ` · +${c.add} −${c.del}` : '');
    const how = {
      observed: 'found by comparing the folder before and after',
      command: 'read from the command · the file as it is now',
      recorded: c.rebuilt ? 'rebuilt from the recorded edits and today\u2019s file' : c.hunks ? 'the edits as recorded, without the rest of the file' : 'as the tool recorded it',
    }[c.how];
    const since = c.current === 'changed' ? '<span class="sc-tag sc-warn">changed since</span>' : c.current === 'deleted' ? '<span class="sc-tag sc-warn">deleted since</span>' : c.current === 'recreated' ? '<span class="sc-tag sc-warn">back on disk since</span>' : '';
    const shared = c.shared ? '<span class="sc-tag sc-warn">another conversation edited it at the same time</span>' : '';
    const steps = c.steps > 1 ? ` over ${c.steps} steps` : '';
    return `<span class="sc-what"><b>${e(main)}</b>${e(steps)}${how ? ` <span class="sc-how">· ${e(how)}</span>` : ''}</span>${since}${shared}`;
  }
  function modesOf(c) {
    const m = [];
    const hasOld = c.old?.text != null, hasNext = c.next?.text != null;
    if (c.hunks) m.push(['changes', 'the edits']);
    else if (hasOld && hasNext) m.push(['changes', 'changes']);
    if (hasNext && isMd(c.path) && c.next.text.length <= 300000) m.push(['page', 'page']);
    if (hasNext && !hasOld && !c.hunks) m.push(['source', isMd(c.path) ? 'source' : 'file']);
    if (!hasNext && hasOld) m.push(['was', 'what it was']);
    if (c.now != null && hasNext) m.push(['now', 'since then']);
    return m;
  }
  function defaultMode(c) {
    const m = modesOf(c).map(x => x[0]);
    if (c.kind === 'deleted') return 'none';
    if (m.includes('changes')) return 'changes';
    if (m.includes('page')) return 'page';
    if (m.includes('source')) return 'source';
    return 'none';
  }
  function renderCard(card, key, st, c) {
    const modes = modesOf(c);
    const mode = st.mode && (st.mode === 'none' || modes.some(x => x[0] === st.mode)) ? st.mode : defaultMode(c);
    st.mode = mode;
    const toggles = modes.length > 1 || (modes.length === 1 && mode === 'none')
      ? modes.map(([m, label]) => `<button type="button" data-sc-mode="${m}" aria-pressed="${m === mode}">${e(label)}</button>`).join('') : '';
    card.innerHTML = `<div class="sc-card-head">${whatHtml(c, st)}<span class="sc-acts">${toggles}` +
      `<button type="button" data-sc-act="open" title="Open the file as it is now, beside the conversation (Shift: full page)">open</button>` +
      `<button type="button" data-sc-act="review" title="Review these steps: comment on lines, mark files reviewed, send notes back">review</button></span></div>` +
      `<div class="sc-body">${bodyHtml(key, st, c, mode)}</div>`;
    card.dataset.ready = '1';
    wireCard(card, key, st, c);
    marks.apply(card);
  }
  function wireCard(card, key, st, c) {
    card.onclick = ev => {
      const b = ev.target.closest('button');
      if (!b || !card.contains(b)) return;
      ev.stopPropagation();
      if (b.dataset.scMode) { st.mode = b.dataset.scMode === st.mode && c.kind === 'deleted' ? 'none' : b.dataset.scMode; renderCard(card, key, st, c); return; }
      if (b.dataset.scGap) return openGap(card, b);
      if (b.dataset.scMore) { st.more = (st.more || 1) + 1; renderCard(card, key, st, c); return; }
      if (b.dataset.scAll) { st.all = true; renderCard(card, key, st, c); return; }
      const act = b.dataset.scAct;
      if (act === 'open' && typeof openPathInApp === 'function') openPathInApp({ key, path: st.path, button: b, page: ev.shiftKey });
      if (act === 'review') review(key, st);
    };
  }
  async function review(key, st) {
    if (typeof openStepReview !== 'function') return;
    await openStepReview({ key, calls: st.calls });
    for (let i = 0; i < 60; i++) {
      const card = [...document.querySelectorAll('.cr-file')].find(x => x.crFile && (x.crFile.livePath === st.path || st.path.endsWith('/' + x.crFile.path)));
      if (card) { card.open = true; card.scrollIntoView({ block: 'start' }); return; }
      await new Promise(r => setTimeout(r, 100));
    }
  }

  function bodyHtml(key, st, c, mode) {
    const q = side => '/api/conversation/change-blob?' + new URLSearchParams({ id: key, calls: st.calls.join(','), path: st.path, side });
    const nowPic = '/api/conversation/file-content?' + new URLSearchParams({ id: key, path: st.path });
    if (c.image && (c.binary || c.next?.binary || c.next?.unavailable || c.old?.binary)) {
      const pic = (src, label) => `<figure class="sc-pic"><img src="${e(src)}" alt="${e(label + ' ' + c.name)}" loading="lazy" decoding="async"><figcaption>${e(label)}</figcaption></figure>`;
      const next = c.next?.blob ? pic(q('next'), c.old?.blob ? 'after' : 'the picture') : c.current !== 'deleted' && !c.next?.absent ? pic(nowPic, 'as it is now') : '';
      const old = c.old?.blob ? pic(q('old'), 'before') : '';
      return `<div class="sc-pics">${old}${next || '<p class="sc-note">The picture is not on disk any more, and no copy was saved.</p>'}</div>`;
    }
    if (mode === 'none') return c.kind === 'deleted' ? '' : `<p class="sc-note">${e(noteOf(c))}</p>`;
    if (mode === 'page') return pageHtml(st, c.next.text);
    if (mode === 'source') return readHtml(st, c.next.text, c.path);
    if (mode === 'was') return readHtml(st, c.old.text, c.path);
    if (mode === 'now') return diffHtml(st, c.next.text, c.now, c.path, 'The file then (−) and now (+)');
    if (c.hunks) return c.hunks.map((h, i) => `<div class="sc-hunk-label">edit ${i + 1} of ${c.hunks.length}</div>` + diffHtml(st, h.old, h.next, c.path, '', true, i)).join('');
    return diffHtml(st, c.old.text, c.next.text, c.path);
  }
  function noteOf(c) {
    if (c.binary || c.next?.binary) return 'A binary file: nothing to read here. Open it to see it.';
    if (c.next?.tooLarge || c.old?.tooLarge) return 'Too large to show here. Open the file to read it.';
    const why = c.next?.unavailable || c.old?.unavailable;
    return why ? `No copy of this version: ${why}.` : 'Nothing to show.';
  }

  // Unified diff: one column at reading width, a few lines around each
  // change, the rest folded; changed words marked inside changed lines.
  function diffModel(a, b) {
    const oldLines = String(a).split('\n'), newLines = String(b).split('\n');
    const script = LineDiff.diffLines(a, b);
    const rows = [];
    let i = 0, j = 0;
    for (let k = 0; k < script.length; k++) {
      const op = script[k];
      if (op === 0) { rows.push({ t: 0, o: i + 1, n: j + 1, s: newLines[j] }); i++; j++; }
      else if (op === 1) { rows.push({ t: 1, o: i + 1, s: oldLines[i] }); i++; }
      else { rows.push({ t: 2, n: j + 1, s: newLines[j] }); j++; }
    }
    // Both ending with a newline: the empty last line is not a line.
    if (rows.length && rows[rows.length - 1].t === 0 && rows[rows.length - 1].s === '') rows.pop();
    return { rows, oldLines, newLines };
  }
  function segmentsOf(rows) {
    const keep = new Uint8Array(rows.length);
    rows.forEach((r, k) => { if (r.t) for (let x = Math.max(0, k - CONTEXT); x <= Math.min(rows.length - 1, k + CONTEXT); x++) keep[x] = 1; });
    const segs = [];
    for (let k = 0; k < rows.length;) {
      const on = keep[k]; let end = k;
      while (end < rows.length && keep[end] === on) end++;
      segs.push({ show: !!on, from: k, to: end });
      k = end;
    }
    return segs;
  }
  function highlighter(lines, path, from, to) {
    // Highlighting starts afresh at the slice: cheap, and exact except
    // inside a comment or string that began above it.
    if (typeof highlightFileLines !== 'function' || from > to) return () => null;
    const slice = lines.slice(from - 1, to).map(l => l.length > LINE_MAX ? l.slice(0, LINE_MAX) : l);
    const hl = highlightFileLines(slice.join('\n'), lang(path), { eager: true });
    return n => (n >= from && n <= to ? hl[n - from] : null);
  }
  function highlighterOf(lines, path, spans) {
    // Neighbouring stretches (a fold opened between two changes) join up.
    const merged = [];
    for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else merged.push([a, b]);
    }
    const parts = merged.map(([a, b]) => highlighter(lines, path, a, b));
    return n => { for (const h of parts) { const v = h(n); if (v != null) return v; } return null; };
  }
  function lineHtml(t, n, html, text, words, sign) {
    const long = text.length > LINE_MAX;
    const body = long ? e(text.slice(0, LINE_MAX)) + '<span class="sc-cut">… ' + (text.length - LINE_MAX).toLocaleString() + ' more characters</span>' : (html ?? e(text));
    return `<div class="sc-l" data-t="${t}"${words ? ` data-w="${words}"` : ''}><span class="sc-ln">${n ?? ''}</span><span class="sc-sg">${sign}</span><code class="sc-c">${body || ' '}</code></div>`;
  }
  // Pairs of a removed and an added line: the character ranges that differ.
  function wordRanges(a, b) {
    if (a.length > 1000 || b.length > 1000) return null;
    const tok = s => s.match(/[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/g) || [];
    const ta = tok(a), tb = tok(b);
    if (ta.length + tb.length > 1200) return null;
    const script = LineDiff.diffLineArrays ? LineDiff.diffLineArrays(ta, tb) : LineDiff.diffLines(ta.join('\n'), tb.join('\n'));
    const ra = [], rb = []; let i = 0, j = 0, pa = 0, pb = 0, same = 0;
    const push = (list, s, len) => { const last = list[list.length - 1]; if (last && last[1] === s) last[1] = s + len; else list.push([s, s + len]); };
    for (let k = 0; k < script.length; k++) {
      const op = script[k];
      if (op === 0) { pa += ta[i].length; pb += tb[j].length; same += ta[i].length; i++; j++; }
      else if (op === 1) { push(ra, pa, ta[i].length); pa += ta[i].length; i++; }
      else { push(rb, pb, tb[j].length); pb += tb[j].length; j++; }
    }
    // Mostly rewritten: marking words would only add noise.
    if (same < 0.35 * Math.max(a.length, b.length) || (!ra.length && !rb.length)) return null;
    return [ra, rb];
  }
  function diffHtml(st, a, b, path, caption = '', lineless = false, part = 0) {
    const m = diffModel(a, b);
    if (!m.rows.some(r => r.t)) return '<p class="sc-note">No difference in the text.</p>';
    const segs = segmentsOf(m.rows);
    const gaps = st.gaps || (st.gaps = new Set());
    // Only the stretches drawn are highlighted (a change's surroundings and
    // folds opened on request), each on its own: cheap however long the file.
    const spansO = [], spansN = [];
    segs.forEach((s, si) => {
      if (!s.show && !gaps.has(part + ':' + si)) return;
      let loO = Infinity, hiO = 0, loN = Infinity, hiN = 0;
      for (let k = s.from; k < s.to; k++) {
        const r = m.rows[k];
        if (r.o) { loO = Math.min(loO, r.o); hiO = Math.max(hiO, r.o); }
        if (r.n) { loN = Math.min(loN, r.n); hiN = Math.max(hiN, r.n); }
      }
      if (hiO) spansO.push([loO, hiO]); if (hiN) spansN.push([loN, hiN]);
    });
    const hlOld = highlighterOf(m.oldLines, path, spansO);
    const hlNew = highlighterOf(m.newLines, path, spansN);
    const budget = FIRST_ROWS * (st.more || 1);
    let drawn = 0, out = '', hidden = 0;
    for (let si = 0; si < segs.length; si++) {
      const s = segs[si], gapId = part + ':' + si;
      if (!s.show && !gaps.has(gapId)) {
        const n = s.to - s.from;
        const where = si === 0 ? 'above' : si === segs.length - 1 ? 'below' : 'unchanged';
        out += `<button type="button" class="sc-gap" data-sc-gap="${gapId}">⋯ ${n.toLocaleString()} ${where === 'unchanged' ? (n === 1 ? 'unchanged line' : 'unchanged lines') : (n === 1 ? 'line ' : 'lines ') + where}</button>`;
        continue;
      }
      for (let k = s.from; k < s.to; k++) {
        if (drawn >= budget) { hidden += s.to - k; continue; }
        const r = m.rows[k];
        let words = '';
        if (r.t === 1 || r.t === 2) {
          // The run this line belongs to, paired with the run beside it.
          const pair = pairOf(m.rows, k);
          if (pair != null) {
            const w = wordRanges(r.t === 1 ? r.s : m.rows[pair].s, r.t === 1 ? m.rows[pair].s : r.s);
            if (w) words = (r.t === 1 ? w[0] : w[1]).map(x => x.join(':')).join(',');
          }
        }
        const html = r.t === 1 ? hlOld(r.o) : hlNew(r.n);
        out += lineHtml(r.t, lineless ? '' : r.t === 1 ? r.o : r.n, html, r.s, words, r.t === 1 ? '−' : r.t === 2 ? '+' : '');
        drawn++;
      }
    }
    if (hidden) out += `<button type="button" class="sc-gap sc-more" data-sc-more="1">show ${hidden.toLocaleString()} more lines of this change</button>`;
    const widest = String(Math.max(m.oldLines.length, m.newLines.length)).length;
    return `${caption ? `<div class="sc-hunk-label">${e(caption)}</div>` : ''}<div class="sc-code${lineless ? ' sc-lineless' : ''}" style="--sc-ln:${Math.max(2, widest)}ch">${out}</div>`;
  }
  // A removed line's partner is the added line at the same place in the
  // added run that follows its removed run (and the other way round).
  function pairOf(rows, k) {
    const t = rows[k].t;
    let start = k; while (start > 0 && rows[start - 1].t === t) start--;
    let end = k; while (end < rows.length - 1 && rows[end + 1].t === t) end++;
    const at = k - start;
    if (t === 1) {
      const o = end + 1; let oe = o; while (oe < rows.length && rows[oe].t === 2) oe++;
      const len = oe - o;
      return len && Math.abs(len - (end - start + 1)) <= 2 && at < len ? o + at : null;
    }
    const o = start - 1; let os = o; while (os >= 0 && rows[os].t === 1) os--;
    const len = o - os;
    return len && Math.abs(len - (end - start + 1)) <= 2 && at < len ? os + 1 + at : null;
  }
  function openGap(card, button) {
    const key = card.dataset.scKey, st = openOf(key).get(card.dataset.scCard), c = contents.get(key + '\0' + card.dataset.scCard);
    if (!st || !c) return;
    (st.gaps || (st.gaps = new Set())).add(button.dataset.scGap);
    renderCard(card, key, st, c);
  }

  function readHtml(st, text, path) {
    const lines = String(text).split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const upto = st.all ? Math.min(lines.length, READ_MAX) : Math.min(lines.length, lines.length <= READ_FIRST + 20 ? READ_FIRST + 20 : READ_FIRST);
    const hl = highlighter(lines, path, 1, upto);
    let out = '';
    for (let n = 1; n <= upto; n++) out += lineHtml(0, n, hl(n), lines[n - 1], '', '');
    const more = lines.length - upto;
    const tail = !more ? '' : st.all
      ? `<p class="sc-note">${more.toLocaleString()} more lines: open the file to read them.</p>`
      : `<button type="button" class="sc-gap sc-more" data-sc-all="1">show all ${lines.length.toLocaleString()} lines</button>`;
    return `<div class="sc-code sc-read" style="--sc-ln:${Math.max(2, String(upto).length)}ch">${out}</div>${tail}`;
  }
  function pageHtml(st, text) {
    const html = typeof mdRender === 'function' ? mdRender(text, '') : `<pre>${e(text)}</pre>`;
    const long = text.length > 2500 || text.split('\n').length > 40;
    return `<div class="sc-page md${long && !st.all ? ' sc-capped' : ''}">${html}</div>` +
      (long && !st.all ? '<button type="button" class="sc-gap sc-more" data-sc-all="1">read the whole page</button>' : '');
  }

  // Changed words, drawn over the highlighted code without touching it
  // (CSS Custom Highlight API). Without it, lines are still marked.
  const marks = (() => {
    const ok = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';
    const add = ok ? new Highlight() : null, del = ok ? new Highlight() : null;
    if (ok) { CSS.highlights.set('sc-add-word', add); CSS.highlights.set('sc-del-word', del); }
    function apply(card) {
      if (!ok) return;
      for (const line of card.querySelectorAll('.sc-l[data-w]')) {
        const code = line.querySelector('.sc-c'), target = line.dataset.t === '2' ? add : del;
        const ranges = line.dataset.w.split(',').map(x => x.split(':').map(Number));
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        let pos = 0, node, ri = 0;
        const nodes = [];
        while ((node = walker.nextNode())) { nodes.push([node, pos]); pos += node.data.length; }
        const locate = at => { for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k][1] <= at) return [nodes[k][0], Math.min(at - nodes[k][1], nodes[k][0].data.length)]; return null; };
        for (; ri < ranges.length; ri++) {
          const [s, t] = ranges[ri];
          const a = locate(s), b = locate(t);
          if (!a || !b) continue;
          const r = new Range(); r.setStart(a[0], a[1]); r.setEnd(b[0], b[1]);
          target.add(r);
        }
      }
    }
    function prune() {
      if (!ok) return;
      for (const h of [add, del]) for (const r of [...h]) if (!r.startContainer.isConnected) h.delete(r);
    }
    return { apply, prune };
  })();

  /** Every conversation with lists on the page (a merged answer brings its own). */
  function hydrateAll(root) {
    if (!root) return;
    const keys = new Set([...root.querySelectorAll('.sc-strip[data-sc-key], .sc-chips[data-sc-key]')].map(el => el.dataset.scKey));
    for (const key of keys) hydrate(root, key);
  }

  window.StepChanges = { stripHtml, chipsHtml, countSlot, hydrate, hydrateAll, claims, toggle, paint, _data: data };
})();
