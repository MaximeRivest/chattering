/* Shared links, the owner's side (design/92): the Share dialog of a
   document. A link lets anyone who has it read, or edit, the document live,
   from this computer; it can be copied again, changed, replaced or turned
   off at any time, and that takes effect at once for everyone using it. */
(function () {
  'use strict';
  const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAY = 86400e3;
  let overlay = null, current = null; // { path, title, shares, busy }

  async function call(url, body) {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || 'the computer refused');
    return out;
  }
  const when = at => {
    if (!at) return '';
    const d = new Date(at), days = Math.round((at - Date.now()) / DAY);
    return days <= 1 ? 'until ' + d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'until ' + d.toLocaleDateString();
  };
  const usage = s => {
    const bits = [];
    if (s.live) bits.push(s.live === 1 ? '1 person here now' : s.live + ' people here now');
    bits.push(s.opens ? (s.opens === 1 ? 'opened once' : 'opened ' + s.opens + ' times') : 'not opened yet');
    return bits.join(' · ');
  };
  const best = s => (s.links || [])[0] || null;

  function rowHtml(s) {
    const link = best(s);
    return `<div class="sh-ui-row" data-id="${escHtml(s.id)}">
      <div class="sh-ui-line">
        <select data-act="role" aria-label="What people with this link can do">
          <option value="view"${s.role === 'view' ? ' selected' : ''}>Can view</option>
          <option value="edit"${s.role === 'edit' ? ' selected' : ''}>Can edit</option>
        </select>
        <input class="sh-ui-url" readonly value="${escHtml(link ? link.url : '')}" aria-label="The link" data-act="select">
        <button class="primary" data-act="copy">Copy link</button>
      </div>
      <div class="sh-ui-meta"><span>${escHtml(link ? link.who : '')}${s.expiresAt ? ' · ' + escHtml(when(s.expiresAt)) : ''} · ${escHtml(usage(s))}</span>
        <span class="sh-ui-actions"><button data-act="replace" title="A new link; the old one stops working at once">New link</button><button data-act="revoke" class="danger" title="Nobody can open it any more; people on it now are disconnected">Turn off</button></span></div>
    </div>`;
  }

  function render() {
    if (!overlay || !current) return;
    const shares = current.shares || [];
    overlay.querySelector('.dialog').innerHTML = `
      <h3>Share “${escHtml(current.title)}”</h3>
      <p class="sh-ui-hint">Anyone with a link can open this document in their browser, with no account, while this computer is on. They see changes as they happen, from you, from agents and from each other.</p>
      ${shares.length ? `<div class="sh-ui-list">${shares.map(rowHtml).join('')}</div>` : ''}
      <div class="sh-ui-new">
        <span>${shares.length ? 'Another link' : 'Make a link'}:</span>
        <select id="shNewRole" aria-label="What people with the new link can do"><option value="view">can view</option><option value="edit">can edit</option></select>
        <select id="shNewEnd" aria-label="When the new link ends"><option value="">no end date</option><option value="1">ends in a day</option><option value="7">ends in a week</option><option value="30">ends in a month</option></select>
        <button id="shCreate" class="primary">Make link</button>
      </div>
      <p class="sh-ui-where">${whereHint(shares)}</p>
      <p class="sh-ui-error" id="shError" role="alert" hidden></p>
      <div class="btnrow"><button id="shClose">Done</button></div>`;
  }
  function whereHint(shares) {
    const link = shares.length ? best(shares[0]) : null;
    if (link && link.where === 'public') return 'Links open from anywhere.';
    if (link && link.where === 'tailnet') return 'For now, links open for people on your Tailscale network. Links that open from anywhere come with the rockfrog.site address.';
    return 'For now, links open on your home network only. Links that open from anywhere come with the rockfrog.site address.';
  }
  function fail(e) {
    const el = overlay && overlay.querySelector('#shError');
    if (!el) return;
    el.textContent = e.message || String(e);
    el.hidden = false;
  }
  async function refresh() {
    const out = await call('/api/shares?path=' + encodeURIComponent(current.path));
    current.shares = out.shares;
    render();
  }
  async function copy(text, button) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const input = button.closest('.sh-ui-row').querySelector('.sh-ui-url');
      input.select(); document.execCommand('copy');
    }
    const was = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { if (button.isConnected) button.textContent = was; }, 1400);
  }

  async function onClick(e) {
    const b = e.target.closest('button, input');
    if (!b || !overlay.contains(b)) { if (e.target === overlay) close(); return; }
    const row = b.closest('.sh-ui-row'), id = row && row.dataset.id;
    const share = id && current.shares.find(s => s.id === id);
    try {
      if (b.id === 'shClose') return close();
      if (b.id === 'shCreate') {
        const days = Number(overlay.querySelector('#shNewEnd').value || 0);
        const out = await call('/api/shares', { path: current.path, role: overlay.querySelector('#shNewRole').value, expiresAt: days ? Date.now() + days * DAY : null });
        await refresh();
        const fresh = overlay.querySelector(`.sh-ui-row[data-id="${out.share.id}"] [data-act="copy"]`);
        if (fresh && best(out.share)) copy(best(out.share).url, fresh);
        return;
      }
      const act = b.dataset.act;
      if (act === 'select') return b.select();
      if (!share) return;
      if (act === 'copy') return copy(best(share).url, b);
      if (act === 'replace') {
        if (!confirm('Make a new link? The current one stops working at once, for everyone who has it.')) return;
        await call('/api/shares/change', { id, newSecret: true });
        await refresh();
        const again = overlay.querySelector(`.sh-ui-row[data-id="${id}"] [data-act="copy"]`);
        const s2 = current.shares.find(s => s.id === id);
        if (again && s2) copy(best(s2).url, again);
        return;
      }
      if (act === 'revoke') {
        if (share.live && !confirm(usage(share) + '. Turn this link off? They are disconnected now.')) return;
        await call('/api/shares/revoke', { id });
        return refresh();
      }
    } catch (err) { fail(err); }
  }
  async function onChange(e) {
    const sel = e.target.closest('select[data-act="role"]');
    if (!sel) return;
    const id = sel.closest('.sh-ui-row').dataset.id;
    try { await call('/api/shares/change', { id, role: sel.value }); await refresh(); }
    catch (err) { fail(err); }
  }
  function onKey(e) { if (e.key === 'Escape' && overlay && !overlay.hidden) { e.stopPropagation(); close(); } }

  async function open(path, title) {
    if (!path) return;
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'overlay sh-ui';
      overlay.innerHTML = '<div class="dialog" role="dialog" aria-modal="true" aria-label="Share by link"></div>';
      overlay.addEventListener('click', onClick);
      overlay.addEventListener('change', onChange);
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
    }
    current = { path, title: title || path.split(/[\\/]/).pop(), shares: [] };
    overlay.hidden = false;
    overlay.querySelector('.dialog').innerHTML = '<p class="sh-ui-hint">Loading…</p>';
    try { await refresh(); } catch (e) { render(); fail(e); }
  }
  function close() { if (overlay) overlay.hidden = true; current = null; }

  // The document's Share button (live-file.js head) and its ⋯ entry.
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('#liveShare, #liveShareMenu');
    if (!b) return;
    const ws = typeof fileWs !== 'undefined' ? fileWs : null;
    if (!ws || !ws.path) return;
    const more = b.closest('details'); if (more) more.open = false;
    open(ws.path, ws.path.split(/[\\/]/).pop());
  });

  window.SharesUI = { open, close };
})();
