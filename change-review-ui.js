'use strict';
let changeReview = null;
let changeReviewSeq = 0;
function crDraft(s, slot, value) {
  const key = 'chattering.review-draft:' + s.id + ':' + s.step + ':' + (s.scope || 'task') + ':' + slot;
  try {
    const legacy = 'chattering.review-draft:' + s.id + ':' + s.step + ':' + slot;
    const legacyView = s.schema !== 2 && (s.scope || 'task') === 'task';
    if (value === undefined) return JSON.parse(sessionStorage.getItem(key) || (legacyView ? sessionStorage.getItem(legacy) : null) || 'null');
    if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value));
    if (legacyView) sessionStorage.removeItem(legacy);
  } catch {}
  return null;
}
async function crRequest(url, body) {
  const r = await fetch(url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json(); if (!r.ok || data.error) throw Error(data.error || 'Review request failed'); return data;
}
async function openStepReview(choice) {
  const origin = currentHash;
  try {
    const review = await crRequest('/api/reviews', choice);
    if (currentHash !== origin) return toast('Review ready', () => showChangeReview(review.id));
    return showChangeReview(review.id);
  } catch (e) { errToast(e.message); }
}
function crIcon(name) {
  const paths = {
    read: '<path d="M4 2h6l3 3v9H4z M10 2v4h3"/>',
    edit: '<path d="m3 10 7-7 3 3-7 7-4 1z M9 4l3 3"/>',
    comment: '<path d="M2 3h12v8H7l-4 3v-3H2z"/>',
  };
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true">${paths[name]}</svg>`;
}
async function showChangeReview(id, step = '', scope = 'task') {
  scope = scope === 'other' ? 'other' : 'task';
  const seq = ++changeReviewSeq;
  markSettingsClosed();
  if (progressStream) { progressStream.close(); progressStream = null; }
  setRoute('change-review', 'review=' + encodeURIComponent(id) + '&step=' + encodeURIComponent(step) + '&scope=' + (scope === 'other' ? 'other' : 'task'));
  $('view').innerHTML = '<div class="empty">Opening review…</div>';
  try {
    const r = await crRequest('/api/reviews?' + new URLSearchParams({ id, step, scope }));
    if (seq !== changeReviewSeq || viewKind !== 'change-review') return;
    const s = changeReview = { ...r, step, scope, seq, loaded: new Map(), cards: new Map() };
    if (step && !r.steps.some(t => t.call === step)) throw Error('Step not found');
    const files = s.shownFiles = r.shownFiles || (step ? r.stepFiles || [] : r.files);
    $('view').innerHTML = `<section class="cr-view">
      <header class="cr-head">
        <button id="crBack" class="cr-quiet">← Conversation</button>
        <h1>${esc(r.project)} <span>${esc(r.title)}</span></h1>
        <select id="crScope" aria-label="Review scope" ${r.schema === 2 ? '' : 'disabled'}><option value="task">${r.schema === 2 ? 'This task' : 'Workspace (legacy)'}</option><option value="other">Other / unassigned${step ? '' : r.schema === 2 && !r.workspaceCoverage ? ' (partial)' : ` (${r.otherFiles?.length || 0})`}</option></select>
        <select id="crStep" aria-label="Changes to review"><option value="">All changes</option>${r.steps.map((t, i) => `<option value="${fgAttr(t.call)}" ${r.schema === 2 || t.before && t.after && !t.gap ? '' : 'disabled'}>${i + 1}. ${esc(t.tool)}${t.failed ? ' · failed' : ''}${t.gap ? ' · capture gap' : ''}</option>`).join('')}</select>
        <details class="cr-menu" id="crFilePicker"><summary>${files.length} ${files.length === 1 ? 'file' : 'files'}</summary><nav class="cr-menu-panel" id="crFileList" aria-label="Changed files"></nav></details>
        <details class="cr-menu" id="crOptions"><summary>View${r.exclusions.length ? ` · ${r.exclusions.length} excluded` : ''}${r.warnings?.length ? ' · resolution notes' : ''}</summary><div class="cr-menu-panel">
          <label>Layout <select id="crLayout"><option value="split">Side by side</option><option value="unified">Unified</option></select></label>
          <button id="crExpand">Expand all files</button><button id="crCollapse">Collapse all files</button>
          <button id="crRepair">Rebuild task review…</button>
          ${r.schema === 2 ? '<button id="crRepairModel">Suggest unresolved locations…</button><button id="crCaptureScope">Include an experiment folder…</button>' : ''}
          <details class="cr-about"><summary>About this review</summary><p>${r.touched} files touched · ${r.files.length} with net changes. These are fixed recorded versions, not live files. Changes during this interval may include other people or agents.${r.steps.some(t => t.overlapping) ? ' Some tools overlapped.' : ''}${r.capture ? ' Task files: ' + esc(r.capture.taskFiles) + '. Workspace boundaries: ' + esc(r.capture.boundaries) + '.' : ''}</p>${r.exclusions.length ? `<p>Not captured:</p><pre>${esc(r.exclusions.join('\n'))}</pre>` : ''}${r.warnings?.length ? `<p>Resolution notes:</p><pre>${esc(r.warnings.join('\n'))}</pre>` : ''}</details>
        </div></details>
        <button id="crFinish" class="primary">Review</button>
      </header>
      <nav id="crRelated" class="cr-related"></nav>
      ${r.schema !== 2 ? '<p class="cr-warning">Legacy workspace review: concurrent tasks may be mixed. Rebuild it from View to separate task evidence.</p>' : scope === 'other' ? '<p class="cr-warning">Other or unassigned workspace changes. Do not attribute these to this task merely because they happened during its steps.</p>' : !r.coverage && r.files.length ? '<p class="cr-warning">Some task files have incomplete history. Available versions and live files can still be opened.</p>' : ''}
      <main id="crFiles"></main>
      <details class="cr-general" id="crArtifacts" ${r.artifacts?.length ? '' : 'hidden'}><summary>Artifacts and references (${r.artifacts?.length || 0})</summary><div id="crArtifactList"></div></details>
      <details class="cr-general" id="crGeneralPanel"><summary id="crGeneralSummary">General comments</summary><div id="crComments"></div><form id="crGeneral"><textarea id="crGeneralText" placeholder="Comment on the whole review…" aria-label="General review comment" required maxlength="12000"></textarea><button>Save comment</button></form></details>
      <details class="cr-general" id="crOutside" hidden><summary id="crOutsideSummary"></summary><div id="crOutsideComments"></div></details>
      <p id="crDelivery" class="cr-delivery" role="status"></p>
      <dialog id="crReviewPanel" class="cr-dialog">
        <header><h2>Send review</h2><button type="button" data-cancel class="cr-quiet">Close</button></header>
        <div id="crReviewSettings"><p id="crReviewSummary"></p><label>Conversation <select id="crTarget">${(r.targets || []).map(t => `<option value="${fgAttr(t.key)}">${esc(t.title)}</option>`).join('')}</select></label><textarea id="crNote" placeholder="Optional instructions for the agent…" aria-label="Review instructions" maxlength="20000"></textarea><button id="crPrepare" class="primary">Preview message</button></div>
        <div id="crReviewPreview" hidden><p id="crPreviewTarget"></p><pre></pre><button data-send class="primary">Send review to agent</button><button data-back>Edit message</button><p role="status"></p></div>
      </dialog>
    </section>`;
    $('crBack').onclick = () => open(r.key, 'restore');
    const related = $('crRelated');
    const addLink = (text, id) => { const b = document.createElement('button'); b.textContent = text; b.onclick = () => showChangeReview(id); related.append(b); };
    if (r.parentReview) {
      addLink('Original review', r.parentReview);
      const combine = document.createElement('button'); combine.textContent = 'Original + follow-up';
      combine.onclick = async () => { try { const joined = await crRequest('/api/reviews/combine', { original: r.parentReview, followup: r.id }); showChangeReview(joined.id); } catch (e) { errToast(e.message); } }; related.append(combine);
    }
    if (r.repairOf) addLink('Original review / comments', r.repairOf);
    for (const repaired of r.repairs || []) addLink('Rebuilt task review', repaired.id);
    if (r.original) addLink('Original review', r.original);
    if (r.followup) addLink('Follow-up only', r.followup);
    for (const f of r.followups || []) addLink('Follow-up · ' + f.title, f.id);
    $('crScope').value = scope; $('crScope').onchange = () => showChangeReview(id, step, $('crScope').value);
    $('crStep').value = step; $('crStep').onchange = () => showChangeReview(id, $('crStep').value, scope);
    $('crRepair').onclick = () => crRepairReview(s);
    if ($('crRepairModel')) $('crRepairModel').onclick = () => crRepairSuggestions(s);
    if ($('crCaptureScope')) $('crCaptureScope').onclick = () => crCaptureFolder(s);
    crArtifacts(s);
    $('crLayout').onchange = () => { $('crFiles').classList.toggle('unified', $('crLayout').value === 'unified'); $('crOptions').open = false; };
    $('crTarget').value = r.targets?.some(t => t.key === r.key) ? r.key : r.targets?.[0]?.key || '';
    $('crFileList').innerHTML = files.map((f, i) => `<button data-cr-jump="${i}">${esc(f.path)}</button>`).join('');
    $('crFileList').querySelectorAll('[data-cr-jump]').forEach(b => b.onclick = () => {
      const card = s.cards.get(files[Number(b.dataset.crJump)].path);
      card.open = true; $('crFilePicker').open = false; card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    for (const file of files) crFileCard(s, file);
    if (!files.length) $('crFiles').innerHTML = `<div class="empty">${r.schema === 2 && scope === 'task' ? 'No directly targeted file changes in this selection. Check artifacts or other / unassigned changes.' : r.schema === 2 && scope === 'other' && !r.workspaceCoverage && !step ? 'Workspace interval incomplete. Inspect available individual steps.' : 'No net file changes in this selection.'}</div>`;
    $('crExpand').onclick = async () => {
      $('crOptions').open = false;
      for (const card of s.cards.values()) { if (changeReview !== s || viewKind !== 'change-review') break; card.open = true; await card.loadDiff(); }
    };
    $('crCollapse').onclick = () => { $('crOptions').open = false; for (const card of s.cards.values()) card.open = false; };
    $('crGeneralText').value = crDraft(s, 'general') || '';
    $('crGeneralText').oninput = () => crDraft(s, 'general', $('crGeneralText').value);
    $('crGeneralPanel').open = !!$('crGeneralText').value || s.comments.some(c => !c.path && !c.resolved);
    $('crNote').value = crDraft(s, 'note') || '';
    $('crNote').oninput = () => crDraft(s, 'note', $('crNote').value);
    $('crGeneral').onsubmit = async e => {
      e.preventDefault(); const input = $('crGeneralText'), button = e.currentTarget.querySelector('button'); button.disabled = true;
      try { const comment = await crRequest('/api/reviews/comment', { id, text: input.value }); s.comments.push(comment); input.value = ''; crDraft(s, 'general', null); crComments(s); } catch (e) { errToast(e.message); } finally { button.disabled = false; }
    };
    const dialog = $('crReviewPanel');
    $('crFinish').onclick = () => { crPreviewBack(); dialog.showModal(); };
    dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
    dialog.querySelector('[data-back]').onclick = crPreviewBack;
    $('crPrepare').onclick = () => crPreview(s);
    crComments(s);
    const prior = r.deliveries.filter(d => d.status !== 'ready');
    $('crDelivery').textContent = prior.map(d => `Previous delivery: ${d.status === 'sending' || d.status === 'uncertain' ? 'uncertain — check the conversation before resending' : d.status}`).join(' · ');
    const first = s.cards.values().next().value;
    if (first) { first.open = true; await first.loadDiff(); }
  } catch (e) {
    if (seq === changeReviewSeq && viewKind === 'change-review') {
      $('view').innerHTML = `<div class="empty">${esc(e.message)}<p><button id="crRetryCombined">Open all changes</button></p></div>`;
      $('crRetryCombined').onclick = () => showChangeReview(id);
    }
  }
}
function crFileCard(s, file) {
  const card = document.createElement('details'); card.className = 'cr-file'; card.crFile = file; card.crExpanded = [];
  card.innerHTML = `<summary><span class="cr-file-name">${esc(file.path)}</span><span class="cr-file-status">${file.unavailable ? 'Unavailable' : !file.old ? 'Added' : !file.next ? 'Deleted' : ''}</span><span class="cr-drift"></span><span class="cr-file-actions">
    <button data-cr-read class="cr-icon" title="Read recorded file" aria-label="Read recorded file">${crIcon('read')}</button>
    <button data-cr-live class="cr-icon" title="Edit live file" aria-label="Edit live file">${crIcon('edit')}</button>
    ${!s.step ? `<label class="cr-reviewed"><input type="checkbox" data-cr-reviewed ${s.reviewed.includes(file.path) ? 'checked' : ''}> Reviewed</label>` : ''}
    <button data-cr-comment class="cr-icon" title="Comment on file" aria-label="Comment on file">${crIcon('comment')}<span class="cr-comment-count"></span></button>
  </span></summary><div class="cr-file-discussion"><div class="cr-file-comments"></div><div class="cr-comment-form" hidden></div><div class="cr-other-comments"></div></div><div class="cr-diff">Loading comparison…</div>`;
  card.querySelector('.cr-file-actions').onclick = e => e.stopPropagation();
  s.cards.set(file.path, card);
  const host = card.querySelector('.cr-diff');
  let loading;
  card.loadDiff = () => loading ||= (async () => {
    if (s.schema !== 2 && file.unavailable && !s.coverage && !s.step) { host.textContent = file.unavailable; return; }
    try {
      const data = await crRequest('/api/reviews/file?' + new URLSearchParams({ id: s.id, path: file.path, step: s.step, scope: s.scope || 'task' }));
      if (!card.isConnected) return;
      s.loaded.set(file.path, data);
      const drift = card.querySelector('.cr-drift'); drift.textContent = data.changedSince ? 'Newer edits on disk' : ''; drift.title = data.changedSince ? 'This review still shows its original recorded versions' : '';
      const detail = card.querySelector('.cr-file-status');
      const labels = [file.shared ? 'Shared target' : '', data.provenance || ''];
      if (labels.some(Boolean)) { detail.textContent = file.shared ? 'Shared' : /Reconstructed|Recorded successful|Saved observation/.test(data.provenance || '') ? 'Recovered' : detail.textContent; detail.title = labels.filter(Boolean).join(' · '); }
      crRenderDiff(s, card);
    } catch (e) { host.textContent = e.message; loading = null; }
  })();
  card.ontoggle = () => { if (card.open) card.loadDiff(); };
  card.querySelector('[data-cr-read]').disabled = s.schema === 2 && !file.workspace ? !file.canRead : !s.coverage && !s.step;
  if (s.schema === 2) {
    const live = card.querySelector('[data-cr-live]'); live.disabled = !file.livePath;
    if (file.livePath) live.title = 'Edit ' + file.livePath + (file.resolution ? ' · ' + file.resolution : '');
  }
  card.querySelector('[data-cr-live]').onclick = e => {
    e.preventDefault();
    const root = s.step ? s.steps.find(t => t.call === s.step)?.root : s.root;
    const full = s.schema === 2 ? file.livePath : isFullPath(file.path) ? file.path : root ? root + '/' + file.path : null;
    if (!full) return errToast('The live file location is unavailable.');
    return openLiveFile(full, { project: s.project, root, back: currentHash,
      reviewRef: s.schema === 2 || s.coverage || s.step ? { id: s.id, step: s.step, path: file.path, scope: s.scope || 'task' } : null,
      reviewData: s.loaded.get(file.path) || null });
  };
  card.querySelector('[data-cr-read]').onclick = async e => {
    e.preventDefault(); await card.loadDiff(); const d = s.loaded.get(file.path); if (!d || !card.isConnected) return;
    const dialog = document.createElement('dialog'); dialog.className = 'cr-dialog';
    dialog.innerHTML = `<h2>${esc(file.path)} · recorded version</h2><select aria-label="Version"><option value="next">After</option><option value="old">Before</option></select><button>Close</button><p data-version-label></p><pre></pre>`;
    const paint = () => { const side = d[dialog.querySelector('select').value]; dialog.querySelector('[data-version-label]').textContent = [side.label, side.at ? new Date(side.at).toLocaleString() : ''].filter(Boolean).join(' · '); dialog.querySelector('pre').textContent = side.unavailable || (side.absent ? '(File absent)' : side.text); };
    dialog.querySelector('select').onchange = paint; dialog.querySelector('button').onclick = () => dialog.close(); dialog.onclose = () => dialog.remove(); document.body.append(dialog); paint(); dialog.showModal();
  };
  card.querySelector('[data-cr-comment]').onclick = e => { e.preventDefault(); card.open = true; crCommentForm(s, file.path, card); };
  const mark = card.querySelector('[data-cr-reviewed]');
  if (mark) mark.onchange = async () => {
    const checked = mark.checked; mark.disabled = true;
    try { await crRequest('/api/reviews/mark', { id: s.id, path: file.path, checked }); s.reviewed = s.reviewed.filter(p => p !== file.path); if (checked) s.reviewed.push(file.path); }
    catch (e) { mark.checked = !checked; errToast(e.message); } finally { mark.disabled = false; }
  };
  $('crFiles').append(card);
  const draft = crDraft(s, 'file:' + file.path);
  if (draft) { card.open = true; crCommentForm(s, file.path, card, draft.side, draft.line, draft); }
}
// Pair replacement runs so corresponding before/after lines stay alongside
// each other. Line numbers remain real snapshot coordinates, never diff offsets.
function crDiffRows(old, next) {
  const a = old.absent ? [] : old.text.split('\n'), b = next.absent ? [] : next.text.split('\n');
  const script = LineDiff.diffLineArrays(a, b), rows = [];
  let i = 0, j = 0, k = 0;
  while (k < script.length) {
    if (script[k] === LineDiff.SAME) { rows.push({ same: true, old: { line: i + 1, text: a[i++] }, next: { line: j + 1, text: b[j++] } }); k++; continue; }
    const removed = [], added = [];
    while (k < script.length && script[k] !== LineDiff.SAME) {
      if (script[k++] === LineDiff.OLD) removed.push({ line: i + 1, text: a[i++] }); else added.push({ line: j + 1, text: b[j++] });
    }
    for (let n = 0; n < Math.max(removed.length, added.length); n++) rows.push({ same: false, old: removed[n], next: added[n] });
  }
  return rows;
}
function crCanAnchor(comment, data) {
  if (!comment.line || !['old', 'next'].includes(comment.side)) return false;
  const side = data[comment.side];
  if (!side || side.unavailable || side.absent) return false;
  if (comment.blob ? comment.blob !== side.oid : comment.base !== data.base || comment.head !== data.head) return false;
  const lines = side.text.split('\n'), end = comment.end || comment.line;
  return Number.isInteger(comment.line) && Number.isInteger(end) && comment.line >= 1 && end >= comment.line && end <= lines.length && lines.slice(comment.line - 1, end).join('\n') === comment.quote;
}
// comments: false draws plain line numbers (the history view reads; only a
// review comments).
function crDiff(old, next, { anchors = new Set(), expanded = [], comments = true } = {}) {
  if (old.unavailable || next.unavailable) return `<p class="cr-diff-notice">${esc(old.unavailable || next.unavailable)}</p>`;
  if (old.text.length + next.text.length > 500000 || old.text.split('\n').length + next.text.split('\n').length > 20000) return '<p class="cr-diff-notice">Large comparison: use Read recorded file to inspect either version. Comments remain with the file below its header.</p>';
  const rows = crDiffRows(old, next), keep = new Set();
  const reveal = n => { for (let i = Math.max(0, n - 3); i <= Math.min(rows.length - 1, n + 3); i++) keep.add(i); };
  rows.forEach((r, i) => { if (!r.same || ['old', 'next'].some(side => r[side] && anchors.has(side + ':' + r[side].line))) reveal(i); });
  if (!keep.size) { reveal(0); reveal(rows.length - 1); }
  for (const [from, to] of expanded) for (let i = Math.max(0, from); i <= Math.min(rows.length - 1, to); i++) keep.add(i);
  const cell = (side, value, same, afterLine) => {
    if (!value) return `<div class="cr-diff-cell cr-empty" data-cr-cell="${side}"></div>`;
    if (!comments) return `<div class="cr-diff-cell${same ? '' : side === 'old' ? ' cr-deleted' : ' cr-added'}" data-cr-cell="${side}" data-cr-number="${value.line}"><pre><span class="cr-line">${value.line}</span>${same && side === 'old' ? `<span class="cr-line cr-unified-next">${afterLine}</span>` : ''}<code>${esc(value.text)}</code></pre></div>`;
    return `<div class="cr-diff-cell${same ? '' : side === 'old' ? ' cr-deleted' : ' cr-added'}" data-cr-cell="${side}" data-cr-number="${value.line}"><pre><button class="cr-line" data-cr-line="${value.line}" data-cr-side="${side}" title="Comment on ${side === 'old' ? 'before' : 'after'} line ${value.line}" aria-label="Comment on ${side === 'old' ? 'before' : 'after'} line ${value.line}">${value.line}</button>${same && side === 'old' ? `<button class="cr-line cr-unified-next" data-cr-line="${afterLine}" data-cr-side="next" title="Comment on after line ${afterLine}" aria-label="Comment on after line ${afterLine}">${afterLine}</button>` : ''}<code>${esc(value.text)}</code></pre><div class="cr-inline-slot" data-cr-anchor="${side}:${value.line}"></div></div>`;
  };
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (!keep.has(i)) { const from = i; while (i + 1 < rows.length && !keep.has(i + 1)) i++; out.push(`<button class="cr-gap" data-cr-expand="${from}:${i}">Show ${i - from + 1} unchanged lines</button>`); continue; }
    const row = rows[i]; out.push(`<div class="cr-diff-row${row.same ? ' same' : ' changed'}">${cell('old', row.old, row.same, row.next?.line)}${cell('next', row.next, row.same)}</div>`);
  }
  return out.join('');
}
function crRenderDiff(s, card) {
  const data = s.loaded.get(card.crFile.path); if (!data) return;
  const anchors = new Set();
  const pin = (side, from, to) => { for (let n = from; n <= Math.min(to || from, from + 100); n++) anchors.add(side + ':' + n); };
  for (const c of s.comments) if (c.path === card.crFile.path && crCanAnchor(c, data)) pin(c.side, c.line, c.end);
  if (card.crEditor?.line) pin(card.crEditor.side, card.crEditor.line, card.crEditor.end);
  const form = card.querySelector('.cr-comment-form'), focus = form.contains(document.activeElement) ? document.activeElement : null;
  // Preserve the actual form node (and its draft/selection) while revealing code.
  if (form.closest('.cr-diff')) card.querySelector('.cr-file-discussion').append(form);
  const host = card.querySelector('.cr-diff'); host.innerHTML = crDiff(data.old, data.next, { anchors, expanded: card.crExpanded });
  host.querySelectorAll('[data-cr-line]').forEach(b => b.onclick = () => crCommentForm(s, card.crFile.path, card, b.dataset.crSide, Number(b.dataset.crLine)));
  host.querySelectorAll('[data-cr-expand]').forEach(b => b.onclick = () => { card.crExpanded.push(b.dataset.crExpand.split(':').map(Number)); crRenderDiff(s, card); });
  crPlaceForm(card); crComments(s);
  if (focus?.isConnected) focus.focus({ preventScroll: true });
}
function crPlaceForm(card) {
  const form = card.querySelector('.cr-comment-form'), state = card.crEditor;
  const slot = state?.line && card.querySelector(`[data-cr-anchor="${state.side}:${state.end || state.line}"]`);
  (slot || card.querySelector('.cr-file-discussion')).append(form);
  const notice = form.querySelector('[data-cr-form-location]');
  if (notice) notice.textContent = state?.line && !slot ? 'This line is outside the displayed diff. Your comment stays attached to its recorded version.' : '';
}
function crCommentForm(s, path, card, side = 'next', line = null, restored = null) {
  const host = card.querySelector('.cr-comment-form');
  if ([...host.querySelectorAll('textarea')].some(t => t.value) && !confirm('Discard this unsaved comment?')) return;
  card.crEditor = { side, line, end: Number(restored?.end) || line };
  host.hidden = false;
  host.innerHTML = `<form><header><span>${line ? `${side === 'old' ? 'Before' : 'After'} line ${line}` : 'File comment'}</span>${line ? `<label>through <input name="end" aria-label="Last commented line" type="number" min="${line}" max="${line + 100}" value="${line}"></label>` : ''}</header><p data-cr-form-location class="cr-diff-notice"></p><textarea name="text" aria-label="Review comment" placeholder="Leave a comment…" required maxlength="12000"></textarea><details class="cr-suggestion"><summary>Suggest a replacement</summary><textarea name="suggestion" aria-label="Suggested replacement" placeholder="Replacement text (not applied automatically)" maxlength="20000"></textarea></details><footer><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Save comment</button></footer></form>`;
  const fields = host.querySelector('form').elements;
  if (restored) { fields.text.value = restored.text || ''; fields.suggestion.value = restored.suggestion || ''; if (fields.end) fields.end.value = restored.end || line; host.querySelector('.cr-suggestion').open = !!restored.suggestion; }
  const saveDraft = () => crDraft(s, 'file:' + path, { side, line, end: fields.end?.value, text: fields.text.value, suggestion: fields.suggestion.value });
  host.querySelector('form').oninput = saveDraft;
  if (fields.end) fields.end.onchange = () => {
    saveDraft();
    const end = Number(fields.end.value), data = s.loaded.get(path), length = data?.[side]?.text?.split('\n').length;
    if (Number.isInteger(end) && end >= line && end <= line + 100 && length && end <= length) { card.crEditor.end = end; crRenderDiff(s, card); }
  };
  host.querySelector('[data-cancel]').onclick = () => { crDraft(s, 'file:' + path, null); card.crEditor = null; host.replaceChildren(); host.hidden = true; crPlaceForm(card); };
  host.querySelector('form').onsubmit = async e => {
    e.preventDefault(); const form = e.currentTarget, submit = form.querySelector('[type="submit"]'); submit.disabled = true;
    try {
      const comment = await crRequest('/api/reviews/comment', { id: s.id, path, step: s.step, scope: s.scope || 'task', side, line, end: line ? Number(form.elements.end.value) : null, text: form.elements.text.value, suggestion: form.elements.suggestion.value });
      s.comments.push(comment); crDraft(s, 'file:' + path, null); card.crEditor = null; host.replaceChildren(); host.hidden = true; crPlaceForm(card);
      if (s.loaded.has(path)) crRenderDiff(s, card); else crComments(s);
    } catch (e) { errToast(e.message); } finally { submit.disabled = false; }
  };
  crPlaceForm(card);
  if (!restored) fields.text.focus();
}
function crCommentHTML(c, { inline = false, otherVersion = false } = {}) {
  const where = c.line ? `${c.side === 'old' ? 'Before' : 'After'} ${c.line}${c.end && c.end !== c.line ? '–' + c.end : ''}` : c.path ? 'File comment' : 'General comment';
  const body = `<header><span>${esc(where)}</span>${otherVersion ? `<button data-cr-context="${fgAttr(c.id)}">Open context</button>` : ''}<button data-cr-resolve="${fgAttr(c.id)}">${c.resolved ? 'Reopen' : 'Resolve'}</button></header><p>${esc(c.text)}</p>${!inline && c.quote !== undefined ? `<pre class="cr-quote">${esc(c.quote)}</pre>` : ''}${c.suggestion ? `<details class="cr-suggestion"><summary>Suggested replacement</summary><pre>${esc(c.suggestion)}</pre></details>` : ''}`;
  return c.resolved ? `<details class="cr-comment cr-resolved" data-cr-comment-id="${fgAttr(c.id)}"><summary>Resolved · ${esc(where)}</summary>${body}</details>` : `<article class="cr-comment" data-cr-comment-id="${fgAttr(c.id)}">${body}</article>`;
}
function crComments(s) {
  if (changeReview !== s || !$('crComments')) return;
  const general = s.comments.filter(c => !c.path);
  $('crComments').innerHTML = general.map(c => crCommentHTML(c)).join('');
  $('crGeneralSummary').textContent = 'General comments' + (general.length ? ` (${general.length})` : '');
  for (const [path, card] of s.cards) {
    card.querySelectorAll('.cr-thread').forEach(el => el.remove());
    const comments = s.comments.filter(c => c.path === path), data = s.loaded.get(path);
    card.querySelector('.cr-comment-count').textContent = comments.length || '';
    card.querySelector('[data-cr-comment]').title = comments.length ? `${comments.length} comments · add a file comment` : 'Comment on file';
    const fileHost = card.querySelector('.cr-file-comments'), otherHost = card.querySelector('.cr-other-comments');
    fileHost.replaceChildren(); otherHost.replaceChildren();
    const other = [];
    for (const c of comments) {
      const anchored = data && crCanAnchor(c, data);
      const slot = anchored && card.querySelector(`[data-cr-anchor="${c.side}:${c.end || c.line}"]`);
      const sameFileVersion = !c.line && (((c.scope || 'task') === (s.scope || 'task') && (c.step || '') === s.step) || data && c.base === data.base && c.head === data.head);
      if (slot || sameFileVersion) {
        const thread = document.createElement('div'); thread.className = 'cr-thread'; thread.innerHTML = crCommentHTML(c, { inline: !!slot });
        const target = slot || fileHost, editor = target.querySelector(':scope > .cr-comment-form');
        target.insertBefore(thread, editor || null);
      } else other.push(c);
    }
    if (other.length) otherHost.innerHTML = `<details><summary>${other.length} ${data ? 'comments outside this displayed context' : 'line comments · expand file to view'}</summary>${other.map(c => crCommentHTML(c, { otherVersion: !data || !crCanAnchor(c, data) })).join('')}</details>`;
  }
  const outside = s.comments.filter(c => c.path && !s.cards.has(c.path));
  $('crOutside').hidden = !outside.length;
  $('crOutsideSummary').textContent = `${outside.length} comments on files outside this view`;
  $('crOutsideComments').innerHTML = outside.map(c => `<div><b>${esc(c.path)}</b>${crCommentHTML(c, { otherVersion: true })}</div>`).join('');
  const unresolved = s.comments.filter(c => !c.resolved).length;
  $('crFinish').textContent = unresolved ? `Review (${unresolved})` : 'Review';
  $('crReviewSummary').textContent = `${unresolved} unresolved ${unresolved === 1 ? 'comment' : 'comments'} will be included. Nothing is sent until you preview and confirm.`;
  $('view').querySelectorAll('[data-cr-resolve]').forEach(b => b.onclick = async () => {
    const c = s.comments.find(c => c.id === b.dataset.crResolve), hadFocus = document.activeElement === b; b.disabled = true;
    try {
      const updated = await crRequest('/api/reviews/resolve', { id: s.id, comment: c.id, resolved: !c.resolved }); Object.assign(c, updated); crComments(s);
      if (hadFocus) {
        const comment = $('view').querySelector(`[data-cr-comment-id="${CSS.escape(c.id)}"]`);
        comment?.querySelector(c.resolved ? ':scope > summary' : '[data-cr-resolve]')?.focus({ preventScroll: true });
      }
    }
    catch (e) { b.disabled = false; errToast(e.message); }
  });
  $('view').querySelectorAll('[data-cr-context]').forEach(b => b.onclick = async () => {
    const c = s.comments.find(c => c.id === b.dataset.crContext);
    await showChangeReview(s.id, c.step || '', c.scope || 'task');
    const card = changeReview?.cards.get(c.path);
    if (card) {
      card.open = true; await card.loadDiff();
      const comment = card.querySelector(`[data-cr-comment-id="${CSS.escape(c.id)}"]`);
      for (let node = comment; node && node !== card; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
      comment?.scrollIntoView({ block: 'center' });
    }
  });
}
function crPreviewBack() {
  $('crReviewSettings').hidden = false; $('crReviewPreview').hidden = true;
}
async function crPreview(s) {
  const button = $('crPrepare'), dialog = $('crReviewPanel'), wasOpen = dialog.open; button.disabled = true;
  try {
    const preview = await crRequest('/api/reviews/prepare', { id: s.id, target: $('crTarget').value, note: $('crNote').value });
    if (changeReview !== s || viewKind !== 'change-review' || wasOpen && !dialog.open) return;
    $('crReviewSettings').hidden = true; $('crReviewPreview').hidden = false;
    $('crPreviewTarget').textContent = 'To: ' + ($('crTarget').selectedOptions[0]?.textContent || preview.target) + '. This conversation retains its existing context.';
    const host = $('crReviewPreview'); host.querySelector('pre').textContent = preview.message; host.querySelector('[role="status"]').textContent = '';
    if (!dialog.open) dialog.showModal();
    const send = host.querySelector('[data-send]'); send.disabled = false;
    send.onclick = async () => {
      send.disabled = true;
      try {
        const result = await crRequest('/api/reviews/send', { token: preview.token });
        dialog.close(); if ($('crDelivery')) $('crDelivery').textContent = result.queued ? 'Review queued for the agent.' : 'Review sent to the agent.';
        toast('Review sent', () => open(result.key));
      } catch (e) { host.querySelector('[role="status"]').textContent = e.message; if ($('crDelivery')) $('crDelivery').textContent = e.message; }
    };
  } catch (e) { errToast(e.message); } finally { if (button.isConnected) button.disabled = false; }
}
