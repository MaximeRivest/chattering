'use strict';
// More than one Claude subscription, in the page (claude-accounts.js): the
// list in settings → AI accounts (add, sign in, remove), and the small
// picker the draft and Claude Code's program bar use.
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok && !j.error) j.error = 'HTTP ' + r.status; return j; });
  const UI = window.ClaudeAccountsUI = {};

  // ---- settings ----
  let host = null, accounts = [], signing = null; // signing: { id, url }
  UI.mount = async el => {
    host = el;
    host.innerHTML = '<div class="hint">reading the Claude accounts…</div>';
    try { accounts = (await (await fetch('/api/claude-accounts')).json()).accounts || []; } catch { accounts = []; }
    paint();
  };
  function paint() {
    if (!host) return;
    const row = a => `<div class="ca-row" data-ca="${esc(a.id)}">
      <div class="ca-main"><b>${esc(a.name)}</b>${a.main ? ' <span class="hint">(Claude Code\'s own login, ~/.claude)</span>' : ''}
        <div class="hint">${a.signedIn ? (a.ok === false ? 'signed in, but Claude Code does not accept the login now: sign in again' : 'signed in' + (a.email ? ' as ' + esc(a.email) : '') + (a.plan ? ' · ' + esc(a.plan) : '')) : 'not signed in yet'}${a.main ? '' : ' · Pi models: “(Claude Code · ' + esc(a.name) + ')”'}</div></div>
      <div class="ca-actions">${a.main ? '' : `<button type="button" class="ghost" data-ca-login="${esc(a.id)}">${a.signedIn ? 'sign in again' : 'sign in'}</button><button type="button" class="ghost" data-ca-remove="${esc(a.id)}">remove</button>`}</div>
      ${signing && signing.id === a.id ? `<div class="ca-sign">
        <div>1. Open <a href="${esc(signing.url)}" target="_blank" rel="noopener">this sign-in page</a> and sign in with the Claude account to use as “${esc(a.name)}”. Check the account at the top of the page: a browser signed in to another one signs in as that.</div>
        <div>2. Paste the code the page shows: <input type="text" class="ca-code" autocomplete="off" spellcheck="false" placeholder="code#…"> <button type="button" class="primary ca-finish">finish</button> <button type="button" class="ghost ca-cancel">cancel</button></div>
        <div class="hint ca-state"></div></div>` : ''}
    </div>`;
    host.innerHTML = `<h3>Claude accounts</h3>
      <p class="hint">More than one Claude subscription, say a work one and a personal one. Each signs in the way Claude Code does, and keeps its own login, renewed by Claude Code. Conversations, CLAUDE.md, skills and hooks are shared; settings are copied from the main account each time. In Pi, each account has its own models; a Claude Code conversation answers as the account picked for it (on the new-conversation page, or under its program).</p>
      ${accounts.map(row).join('')}
      <div class="ca-add"><input type="text" id="caName" placeholder="name, e.g. work" autocomplete="off" spellcheck="false" maxlength="31"> <button type="button" class="ghost" id="caAdd">add an account</button></div>
      <div class="set-help">Other people of your household and guests always use the main account. Pi typed in a terminal on this computer shows every account's models to whoever uses it.</div>`;
    const add = $('caAdd');
    if (add) add.onclick = async () => {
      const name = $('caName').value.trim().toLowerCase();
      if (!name) return $('caName').focus();
      const out = await post('/api/claude-accounts/add', { name });
      if (out.error) return errToast(out.error);
      accounts = out.accounts; paint(); startSign(name);
    };
    host.querySelectorAll('[data-ca-login]').forEach(b => b.onclick = () => startSign(b.dataset.caLogin));
    host.querySelectorAll('[data-ca-remove]').forEach(b => b.onclick = async () => {
      if (!confirm('Remove the Claude account “' + b.dataset.caRemove + '”? Its login is forgotten here. Conversations stay; those that answered as it answer as the main account from now on.')) return;
      const out = await post('/api/claude-accounts/remove', { id: b.dataset.caRemove });
      if (out.error) return errToast(out.error);
      accounts = out.accounts; signing = null; paint(); toast('removed');
    });
    const box = host.querySelector('.ca-sign');
    if (box) {
      const input = box.querySelector('.ca-code'), state = box.querySelector('.ca-state');
      input.focus();
      box.querySelector('.ca-cancel').onclick = () => { signing = null; paint(); };
      const finish = async () => {
        const code = input.value.trim();
        if (!code) return input.focus();
        state.textContent = 'signing in…'; box.querySelector('.ca-finish').disabled = true;
        const out = await post('/api/claude-accounts/code', { id: signing.id, code });
        if (out.accounts) accounts = out.accounts;
        if (out.ok) { const id = signing.id; signing = null; paint(); const a = accounts.find(x => x.id === id); toast('✓ ' + id + (a && a.email ? ': ' + a.email : '') + ' is signed in'); return; }
        signing = null; paint(); errToast('not signed in: ' + (out.error || 'unknown') + '. Start again; the code works once.');
      };
      box.querySelector('.ca-finish').onclick = finish;
      input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') finish(); if (e.key === 'Escape') { signing = null; paint(); } };
    }
  }
  async function startSign(id) {
    signing = null; paint();
    const b = host && host.querySelector(`[data-ca-login="${CSS.escape(id)}"]`);
    if (b) { b.disabled = true; b.textContent = 'starting…'; }
    const out = await post('/api/claude-accounts/login', { id });
    if (out.error || !out.url) { paint(); return errToast(out.error || 'Claude Code did not give a sign-in link'); }
    signing = { id, url: out.url }; paint();
  }

  // ---- the picker (draft, Claude Code's program bar) ----
  // choices: [{ id, name }]; onPick(id). A small menu under the anchor.
  UI.pick = (anchor, { current, choices, onPick, note = '' }) => {
    document.querySelectorAll('.ca-pop').forEach(el => el.remove());
    const pop = document.createElement('div');
    pop.className = 'ca-pop'; pop.setAttribute('role', 'menu');
    pop.innerHTML = `${note ? `<div class="hint">${esc(note)}</div>` : ''}${choices.map(c => `<button type="button" role="menuitemradio" aria-checked="${c.id === current}" data-id="${esc(c.id)}" class="${c.id === current ? 'on' : ''}">${esc(c.name)}</button>`).join('')}`;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = (r.top - pop.offsetHeight - 6 > 8 ? r.top - pop.offsetHeight - 6 : r.bottom + 6) + 'px';
    const close = () => { pop.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); };
    const outside = e => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
    const key = e => { if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus(); } };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true);
    pop.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { close(); onPick(b.dataset.id); });
    const on = pop.querySelector('.on') || pop.querySelector('[data-id]'); if (on) on.focus();
  };

  // A Claude Code conversation's account, switched from its program bar.
  UI.switchConversation = async (key, account) => {
    const out = await post('/api/conversation/claude-account', { id: key, account });
    if (out.error) return errToast(out.error);
    toast('answers as ' + out.account.name + (out.when === 'already' ? '' : ': ' + out.when));
    return out.account;
  };
})();
