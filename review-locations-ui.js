'use strict';
function crArtifacts(s) {
  const host = $('crArtifactList'); if (!host) return;
  for (const f of s.artifacts || []) {
    const card = document.createElement('article'); card.className = 'cr-reference';
    const where = f.location?.host === 'local' ? 'This machine' : f.location?.host || 'Unresolved host';
    card.innerHTML = `<b>${esc(f.path)}</b><p>${esc(where)} · ${esc(f.liveDirectory ? 'Directory exists' : f.livePath ? f.resolution || 'Current local file available' : f.unavailable || 'Location unavailable')}</p><div></div>`;
    const actions = card.querySelector('div');
    if ((s.otherFiles || []).some(other => other.path === f.path)) {
      const interval = document.createElement('button'); interval.textContent = 'Review workspace interval';
      interval.onclick = async () => { await showChangeReview(s.id, '', 'other'); const target = changeReview?.cards.get(f.path); if (target) { target.open = true; target.scrollIntoView({ block: 'start' }); } }; actions.append(interval);
    }
    if (f.canRead) {
      const recorded = document.createElement('button'); recorded.textContent = 'Recorded versions';
      recorded.onclick = () => crRecordedArtifact(s, f); actions.append(recorded);
    }
    if (f.livePath) {
      const view = document.createElement('button'); view.textContent = f.location.host === 'local' ? 'Open current file' : 'Open local copy';
      view.onclick = () => crPreviewArtifact(s, f); actions.append(view);
    }
    if (f.liveDirectory && f.liveDirectory.startsWith(s.root + '/')) {
      const folder = document.createElement('button'); folder.textContent = 'Open folder';
      folder.onclick = () => showFilesBrowser(s.project, { root: s.root, dir: f.liveDirectory.slice(s.root.length + 1) }); actions.append(folder);
    }
    const copy = document.createElement('button'); copy.textContent = 'Copy location';
    copy.onclick = () => copyText(f.location.host === 'local' ? f.location.path || f.location.raw : `${f.location.host}:${f.location.path || f.location.raw}`).catch(e => errToast(e.message)); actions.append(copy);
    host.append(card);
  }
}
async function crRecordedArtifact(s, file) {
  try {
    const data = await crRequest('/api/reviews/file?' + new URLSearchParams({ id: s.id, path: file.path }));
    const dialog = document.createElement('dialog'); dialog.className = 'cr-dialog';
    dialog.innerHTML = `<header><h2>${esc(file.path)}</h2><button>Close</button></header><p>Recorded interval for a possible output. This is not exclusive authorship evidence.</p><select aria-label="Recorded version"><option value="diff">Compare</option><option value="old">Before</option><option value="next">After</option></select><div class="cr-diff"></div>`;
    const render = () => {
      const mode = dialog.querySelector('select').value, host = dialog.querySelector('.cr-diff');
      if (mode !== 'diff') { const pre = document.createElement('pre'); pre.textContent = data[mode].unavailable || (data[mode].absent ? '(Absent)' : data[mode].text); host.replaceChildren(pre); return; }
      host.innerHTML = crDiff(data.old, data.next);
      host.querySelectorAll('button.cr-line').forEach(button => { const line = document.createElement('span'); line.className = 'cr-artifact-line'; line.textContent = button.textContent; button.replaceWith(line); });
      host.querySelectorAll('[data-cr-expand]').forEach(button => { const hint = document.createElement('small'); hint.textContent = 'Unchanged context omitted; select Before or After to read it all.'; button.replaceWith(hint); });
    };
    if (data.old.unavailable) dialog.querySelector('select').value = 'next';
    dialog.querySelector('select').onchange = render; render();
    dialog.querySelector('header button').onclick = () => dialog.close(); dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal();
  } catch (e) { errToast(e.message); }
}
async function crPreviewArtifact(s, file) {
  const dialog = document.createElement('dialog'); dialog.className = 'cr-dialog';
  dialog.innerHTML = `<header><h2>${esc(file.path)}</h2><button>Close</button></header><p>Current local contents. This does not establish historical or remote-content equivalence.</p><div class="cr-artifact-body"></div>`;
  dialog.querySelector('button').onclick = () => dialog.close();
  dialog.onclose = () => { dialog.querySelector('audio,video')?.pause(); dialog.remove(); };
  document.body.append(dialog); dialog.showModal();
  const url = '/api/reviews/asset?' + new URLSearchParams({ id: s.id, path: file.path });
  const host = dialog.querySelector('.cr-artifact-body');
  if (/^(image|audio|video)\//.test(file.mediaType || '')) {
    const media = document.createElement(file.mediaType.startsWith('image/') ? 'img' : file.mediaType.startsWith('audio/') ? 'audio' : 'video');
    media.src = url; media.controls = true; media.alt = file.path; media.onerror = () => { host.textContent = 'The verified local copy is no longer available.'; }; host.append(media);
  } else {
    try {
      const response = await fetch(url); if (!response.ok) throw Error('The local file could not be read');
      if (response.headers.get('content-type')?.startsWith('text/')) {
        const text = await response.text(), pre = document.createElement('pre'); pre.textContent = text.slice(0, 200000) + (text.length > 200000 ? '\n[Preview truncated; download for the full file]' : ''); host.append(pre);
      } else host.textContent = 'Binary file; download it to use an appropriate viewer.';
    } catch (e) { host.textContent = e.message; }
  }
  const download = document.createElement('a'); download.href = url; download.download = file.livePath.split(/[\\/]/).pop(); download.textContent = 'Download current file'; host.append(download);
}
async function crRepairReview(s, proposal = null) {
  if (!confirm(s.kind === 'conversation' ? 'Build this review again with every change made since? This review and its comments are kept unchanged.' : 'Create a corrected task review? The original review and its comments will be kept unchanged.')) return;
  const origin = currentHash;
  try {
    const repaired = await crRequest('/api/reviews/repair', { id: s.id, proposal });
    if (currentHash === origin) return showChangeReview(repaired.id);
    toast('Rebuilt task review ready', () => showChangeReview(repaired.id));
  } catch (e) { errToast(e.message); }
}
function crCaptureFolder(s) {
  const candidates = [...new Set([...s.files, ...(s.artifacts || [])].filter(f => f.location?.host === 'local' && f.location.path?.startsWith(s.root + '/')).map(f => f.location.path.slice(0, f.location.path.lastIndexOf('/'))).filter(p => p !== s.root))];
  const dialog = document.createElement('dialog'); dialog.className = 'cr-dialog';
  dialog.innerHTML = `<header><h2>Experiment capture</h2><button data-close>Close</button></header><p>Include future text changes in an explicit folder, even when Git ignores it. Git rules stay unchanged. Obvious secret paths, symlinks and binary contents are excluded. Stored versions are retained.</p><select aria-label="Experiment folder">${candidates.map(p => `<option value="${fgAttr(p)}">${esc(p.slice(s.root.length + 1))}</option>`).join('')}</select><button data-approve ${candidates.length ? '' : 'disabled'}>Include selected folder</button><div data-scopes></div><p role="status"></p>`;
  dialog.querySelector('[data-close]').onclick = () => dialog.close(); dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal();
  const paint = scopes => {
    const host = dialog.querySelector('[data-scopes]'); host.replaceChildren();
    for (const scope of scopes) {
      const row = document.createElement('p'); row.textContent = scope + ' ';
      const remove = document.createElement('button'); remove.textContent = 'Stop folder capture'; remove.onclick = async () => {
        try { const result = await crRequest('/api/reviews/capture-scope', { id: s.id, path: scope, remove: true }); s.captureScopes = result.scopes; paint(result.scopes); } catch (e) { dialog.querySelector('[role="status"]').textContent = e.message; }
      }; row.append(remove); host.append(row);
    }
  };
  paint(s.captureScopes || []);
  dialog.querySelector('[data-approve]').onclick = async e => {
    e.currentTarget.disabled = true;
    try {
      const result = await crRequest('/api/reviews/capture-scope', { id: s.id, path: dialog.querySelector('select').value });
      s.captureScopes = result.scopes; paint(result.scopes);
      dialog.querySelector('[role="status"]').textContent = 'Scope saved for updated capture workers. Existing history was not rewritten.';
    } catch (e) { dialog.querySelector('[role="status"]').textContent = e.message; }
    finally { if (dialog.isConnected) dialog.querySelector('[data-approve]').disabled = false; }
  };
}
async function crRepairSuggestions(s) {
  try {
    const preview = await crRequest('/api/reviews/suggest-preview', { id: s.id });
    if (changeReview !== s || viewKind !== 'change-review') return;
    const dialog = document.createElement('dialog'); dialog.className = 'cr-dialog';
    dialog.innerHTML = `<header><h2>Suggest locations</h2><button data-close>Close</button></header><p>${esc(preview.notice)} Model: ${esc(preview.model)}</p><pre></pre><button data-run>Ask model using this payload</button><div data-results></div><p role="status"></p>`;
    dialog.querySelector('pre').textContent = preview.input;
    dialog.querySelector('[data-close]').onclick = () => dialog.close(); dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal();
    dialog.querySelector('[data-run]').onclick = async e => {
      e.currentTarget.disabled = true; dialog.querySelector('[role="status"]').textContent = 'Requesting suggestions…';
      try {
        const result = await crRequest('/api/reviews/suggest', { token: preview.token });
        if (!dialog.isConnected) return;
        dialog.querySelector('[role="status"]').textContent = result.status === 'complete' ? `${result.proposals.length} proposals. Nothing has been applied.` : result.error || result.status;
        for (const [index, p] of (result.proposals || []).entries()) {
          const card = document.createElement('article'); card.className = 'cr-reference';
          const text = document.createElement('p'); text.textContent = `${p.localPath || p.host + ':' + (p.path || '?')}\n${p.reason}\n${p.verification || 'Unverified remote suggestion; no remote connection was made.'}`; card.append(text);
          if (p.verifiedLocal) {
            const accept = document.createElement('button'); accept.textContent = 'Use as local candidate in a new review';
            accept.onclick = async () => { await crRepairReview(s, { token: preview.token, index }); dialog.close(); }; card.append(accept);
          }
          dialog.querySelector('[data-results]').append(card);
        }
      } catch (e) { dialog.querySelector('[role="status"]').textContent = e.message; }
    };
  } catch (e) { errToast(e.message); }
}
