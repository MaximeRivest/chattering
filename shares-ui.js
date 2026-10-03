/* Shared links, the owner's side (design/92): the Share dialog of a
   document, or of a conversation (read only, live or a snapshot). A link lets anyone who has it read, or edit, the document live,
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

  const isConv = () => current && current.kind === 'conversation';
  function rowHtml(s) {
    const link = best(s);
    const choice = s.kind === 'conversation'
      ? `<select data-act="mode" aria-label="What people with this link see">
          <option value="live"${s.mode === 'live' ? ' selected' : ''}>Live</option>
          <option value="snapshot"${s.mode === 'snapshot' ? ' selected' : ''}>Snapshot</option>
        </select>`
      : `<select data-act="role" aria-label="What people with this link can do">
          <option value="view"${s.role === 'view' ? ' selected' : ''}>Can view</option>
          <option value="edit"${s.role === 'edit' ? ' selected' : ''}>Can edit</option>
        </select>`;
    const snap = s.kind === 'conversation' && s.mode === 'snapshot'
      ? ` · a copy from ${escHtml(new Date(s.snapshotAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))} <button data-act="resnap" class="linklike" title="Replace the copy with the conversation as it is now">update the copy</button>` : '';
    return `<div class="sh-ui-row" data-id="${escHtml(s.id)}">
      <div class="sh-ui-line">
        ${choice}
        <input class="sh-ui-url" readonly value="${escHtml(link ? link.url : '')}" aria-label="The link" data-act="select">
        <button class="primary" data-act="copy">Copy link</button>
      </div>
      <div class="sh-ui-meta"><span>${escHtml(link ? link.who : '')}${s.expiresAt ? ' · ' + escHtml(when(s.expiresAt)) : ''} · ${escHtml(usage(s))}${snap}</span>
        <span class="sh-ui-actions"><button data-act="replace" title="A new link; the old one stops working at once">New link</button><button data-act="revoke" class="danger" title="Nobody can open it any more; people on it now are disconnected">Turn off</button></span></div>
    </div>`;
  }

  function render() {
    if (!overlay || !current) return;
    const shares = current.shares || [];
    overlay.querySelector('.dialog').innerHTML = `
      <h3>Share “${escHtml(current.title)}”</h3>
      ${isConv()
        ? `<p class="sh-ui-hint">Anyone with a link can read this conversation in their browser, as you see it in Chattering, with no account, while this computer is on. They cannot write in it or change anything. <b>Live</b>: new messages appear as they are written. <b>Snapshot</b>: a copy of it as it is now.</p>${secretsHtml()}`
        : `<p class="sh-ui-hint">Anyone with a link can open this document in their browser, with no account, while this computer is on. They see changes as they happen, from you, from agents and from each other.</p>`}
      ${shares.length ? `<div class="sh-ui-list">${shares.map(rowHtml).join('')}</div>` : ''}
      <div class="sh-ui-new">
        <span>${shares.length ? 'Another link' : 'Make a link'}:</span>
        ${isConv()
          ? '<select id="shNewMode" aria-label="What people with the new link see"><option value="live">live</option><option value="snapshot">snapshot</option></select>'
          : '<select id="shNewRole" aria-label="What people with the new link can do"><option value="view">can view</option><option value="edit">can edit</option></select>'}
        <select id="shNewEnd" aria-label="When the new link ends"><option value="">no end date</option><option value="1">ends in a day</option><option value="7">ends in a week</option><option value="30">ends in a month</option></select>
        <button id="shCreate" class="primary">Make link</button>
      </div>
      <div class="sh-ui-where" id="shWhere">${whereHtml(shares)}</div>
      <p class="sh-ui-error" id="shError" role="alert" hidden></p>
      <div class="btnrow"><button id="shClose">Done</button></div>`;
  }
  // What a conversation would carry out, before a link exists: Chattering
  // hides what looks like a secret; the owner reads the rest.
  function secretsHtml() {
    const sc = current && current.scan;
    if (!sc) return '<p class="sh-ui-small">Checking it for keys and passwords…</p>';
    if (!sc.count) return '<p class="sh-ui-small">No keys or passwords found in it. Commands, file paths and tool output are shown as they are: read it before you share it.</p>';
    const kinds = Object.entries(sc.kinds).map(([k, n]) => n + ' ' + k + (n > 1 ? 's' : '')).join(', ');
    const where = sc.examples.map(e => e.where).filter((w, i, a) => a.indexOf(w) === i).slice(0, 5).join(', ');
    return `<p class="sh-ui-warn">Found ${escHtml(kinds)}: in ${escHtml(where)}${sc.count > sc.examples.length ? '…' : ''}. They are <b>hidden</b> from people with the link. Other things that are secret to you but do not look like a key are not: read it before you share it.</p>`;
  }

  // Where links open: this computer's public address (design/92), or, until
  // it has one, the networks it is on. The owner turns the address on here.
  const PHASE = { connecting: 'Connecting to the relay…', claiming: 'Reserving the name…', certifying: 'Getting a certificate (about a minute)…' };
  function whereHtml(shares) {
    const pub = current && current.pub;
    const link = shares.length ? best(shares[0]) : null;
    if (pub && pub.url) {
      return `<p>Links open from anywhere, at <b>${escHtml(pub.url.replace(/^https:\/\//, ''))}</b>, while this computer is on. The address is yours; the relay passes the connection along without being able to read it.${pub.owner ? ' <button class="linklike" data-act="pub-off">Turn the public address off</button>' : ''}</p>`
        + (pub.ctWarning ? `<p class="sh-ui-error">A certificate this computer did not ask for exists for this address (issued ${escHtml(pub.ctWarning.notBefore || '')} by ${escHtml(pub.ctWarning.issuer || 'someone')}). Someone may be able to pose as it: tell Rockfrog.</p>` : '');
    }
    const net = isPub() ? 'For now, it opens only on this computer (at .pub.localhost).' : link && link.where === 'tailnet' ? 'For now, links open for people on your Tailscale network.' : 'For now, links open on your home network only.';
    if (!pub || !pub.owner) return `<p>${net} This computer’s owner can give it a public address, so ${isPub() ? 'publications' : 'links'} open from anywhere.</p>`;
    const busy = pub.on && PHASE[pub.phase];
    const why = pub.on && ['error', 'refused'].includes(pub.phase) && pub.error ? `<p class="sh-ui-error">${escHtml(pub.error)}</p>` : '';
    return `<p>${net} To open ${isPub() ? 'it' : 'them'} from anywhere, give this computer a public address:</p>
      <div class="sh-ui-pub"><span>https://</span><input id="shPubName" value="${escHtml(pub.name || '')}" placeholder="yourname" maxlength="30" autocomplete="off" spellcheck="false" aria-label="The name of this computer's public address"><span>.${escHtml(pub.domain || 'rockfrog.site')}</span>
      <button id="shPubOn" class="primary"${busy ? ' disabled' : ''}>${busy ? escHtml(busy) : 'Turn on'}</button></div>${why}
      <p class="sh-ui-small">Visitors connect to this computer through Rockfrog’s relay, encrypted all the way: the certificate lives here, so the relay cannot read or change what they see. Links work while this computer is on.</p>`;
  }
  async function loadPub() {
    try { current.pub = await call('/api/public-links'); } catch { current.pub = null; }
  }
  let pubTimer = 0;
  function pollPub() {
    clearTimeout(pubTimer);
    if (!current || !current.pub || !current.pub.on || !PHASE[current.pub.phase]) return;
    pubTimer = setTimeout(async () => {
      if (!current) return;
      await loadPub();
      // Links change when the address becomes ready.
      if (current.pub && current.pub.phase === 'ready') await refresh(); else renderWhere();
      pollPub();
    }, 1500);
  }
  function renderWhere() { const el = overlay && overlay.querySelector('#shWhere'); if (el && current) el.innerHTML = isPub() ? pubWhereHtml() : whereHtml(current.shares || []); }
  function fail(e) {
    const el = overlay && overlay.querySelector('#shError');
    if (!el) return;
    el.textContent = e.message || String(e);
    el.hidden = false;
  }
  async function refresh() {
    if (isPub()) return refreshPub();
    const out = await call('/api/shares?' + (isConv() ? 'key=' + encodeURIComponent(current.key) : 'path=' + encodeURIComponent(current.path)));
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


  // ---- publishing (design/92): a frozen copy at its own address ----------
  // An artifact (a web page, a picture…) or an AI program. What goes out is
  // shown before anything is published: the files, what is left out and why,
  // what looks like a secret. A program says who pays.
  const isPub = () => current && current.kind === 'publication';
  const kb = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const usd = n => '$' + (n >= 1 ? n.toFixed(2) : n >= 0.01 ? n.toFixed(3) : n.toFixed(4));
  function pubRowHtml(s) {
    const link = best(s);
    const vers = s.versions || [];
    const cert = s.certificate ? (s.certificate.ready ? '' : s.certificate.error ? ' · its certificate failed: ' + escHtml(s.certificate.error) : ' · its certificate is on its way') : '';
    const pay = s.type === 'program' ? `<div class="sh-ui-meta"><span>${s.pay && s.pay.owner ? `Visitors pay with their own key, or you do: up to ${usd(s.pay.owner.monthlyUsd)} a month, ${s.pay.owner.perVisitorPerHour} answers an hour each · this month ${usd((s.spent || {}).usd || 0)}, ${(s.spent || {}).calls || 0} answers${s.ownerPays && !s.ownerPays.available ? ' · <b>not available: ' + escHtml(s.ownerPays.why) + '</b>' : ''}` : 'Visitors pay with their own key'}</span></div>` : '';
    return `<div class="sh-ui-row" data-id="${escHtml(s.id)}">
      <div class="sh-ui-line">
        <select data-act="access" aria-label="Who can open it">
          <option value="link"${s.access === 'link' ? ' selected' : ''}>Anyone with the link</option>
          <option value="public"${s.access === 'public' ? ' selected' : ''}>Anyone (public)</option>
        </select>
        <input class="sh-ui-url" readonly value="${escHtml(link ? link.url : '')}" aria-label="Its address" data-act="select">
        <button class="primary" data-act="copy">Copy link</button>
      </div>
      <div class="sh-ui-meta"><span>${escHtml(link ? link.who : '')}${cert} · version <code title="${escHtml(s.root)}: the fingerprint of exactly what is published">${escHtml(s.root.slice(0, 12))}</code>${vers.length > 1 ? ` <select data-act="version" aria-label="Make an earlier version current">${vers.map(v => `<option value="${escHtml(v.root)}"${v.root === s.root ? ' selected' : ''}>${escHtml(v.root.slice(0, 8))} · ${escHtml(new Date(v.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</option>`).join('')}</select>` : ''} · ${escHtml(usage(s))}</span>
        <span class="sh-ui-actions"><button data-act="republish" title="${s.type === 'program' ? 'Its live version now, frozen and signed' : 'The version on screen now, frozen and signed'}">Publish ${s.type === 'program' ? 'the live version' : 'the version shown'}</button>${s.access === 'link' ? '<button data-act="replace" title="A new link; the old one stops working at once">New link</button>' : ''}<button data-act="revoke" class="danger" title="Its address stops answering at once">Turn off</button></span></div>
      ${pay}
    </div>`;
  }
  function pubFormHtml() {
    const pv = current.preview;
    if (!pv) return '<p class="sh-ui-small">Reading what would go out…</p>';
    const pub = current.pub;
    const domain = pub && pub.url ? '.' + pub.name + '.' + (pub.domain || 'rockfrog.site') : '.pub.localhost';
    const scheme = pub && pub.url ? 'https://' : 'http://';
    const files = `<details class="sh-ui-files"><summary>${pv.count} file${pv.count === 1 ? '' : 's'}, ${kb(pv.total)}${current.type === 'site' ? (pv.fromVersion ? ' · the version on screen' : ' · as on disk now') : ' · its live version'}</summary><ul>${pv.files.map(f => `<li><code>${escHtml(f.path)}</code> ${kb(f.size)}</li>`).join('')}${pv.count > pv.files.length ? '<li>…</li>' : ''}</ul></details>`;
    const left = pv.excluded.length ? `<p class="sh-ui-small">Left out: ${pv.excluded.slice(0, 8).map(e => `<code>${escHtml(e.path)}</code> (${escHtml(e.why)})`).join(', ')}${pv.excluded.length > 8 ? '…' : ''}.</p>` : '';
    const warn = pv.warnings.length ? `<p class="sh-ui-warn">${pv.warnings.map(w => `<code>${escHtml(w.path)}</code> seems to hold ${escHtml(w.kinds.map(k => (/^[aeiou]/i.test(k) ? 'an ' : 'a ') + k).join(' and '))}`).join('; ')}. It would be public: remove it from the files first, unless it is meant to be seen.</p>` : '';
    const prog = current.type === 'program' ? payFormHtml() : '';
    return `<div class="sh-ui-pubform">
      <div class="sh-ui-pub"><span>${scheme}</span><input id="pubSlug" value="${escHtml(current.slug || pv.slug)}" maxlength="30" autocomplete="off" spellcheck="false" aria-label="The name in its address"><span>${escHtml(domain)}</span></div>
      <div class="sh-ui-line sh-ui-access"><label><input type="radio" name="pubAccess" value="link"${current.access !== 'public' ? ' checked' : ''}> Anyone with the link</label><label><input type="radio" name="pubAccess" value="public"${current.access === 'public' ? ' checked' : ''}> Anyone (public)</label></div>
      ${files}${left}${warn}${prog}
      <div class="sh-ui-line"><button id="pubGo" class="primary">Publish</button><span class="sh-ui-small">${current.type === 'program' ? 'Its instruction becomes public with it: a visitor\u2019s browser runs it.' : 'Its pages run on their own address, apart from Chattering and from everything else shared from here.'}</span></div>
    </div>`;
  }
  function payFormHtml() {
    const ks = current.keys;
    if (!ks) return '<p class="sh-ui-small">Visitors pay with their own key.</p>';
    if (!ks.owner) return '<p class="sh-ui-small">Visitors pay with their own key. (Paying for them yourself is for this computer\u2019s owner.)</p>';
    const o = current.ownerPay || { on: false, provider: 'openai', model: '', monthlyUsd: 5, perVisitorPerHour: 10 };
    const prov = ks.providers.find(p => p.id === o.provider) || ks.providers[0];
    const model = o.model || prov.model;
    const price = current.price;
    return `<fieldset class="sh-ui-pay"><legend>Who pays for the answers</legend>
      <p class="sh-ui-small">Visitors can always use their own key, in their own browser.</p>
      <label><input type="checkbox" id="payOn"${o.on ? ' checked' : ''}> You can also pay for them, with a key kept for public programs only</label>
      <div id="payOwner"${o.on ? '' : ' hidden'}>
        <div class="sh-ui-line"><select id="payProvider" aria-label="AI company">${ks.providers.map(p => `<option value="${escHtml(p.id)}"${p.id === prov.id ? ' selected' : ''}>${escHtml(p.label)}${p.hasKey ? ' ✓' : ''}</option>`).join('')}</select>
          <input id="payModel" value="${escHtml(model)}" aria-label="Model" spellcheck="false"></div>
        <p class="sh-ui-small">${price ? price.known ? `It costs $${price.perMillion.input} in, $${price.perMillion.output} out per million tokens.` : '<b>Its price is not known here: choose a model with a known price</b> (a budget needs one).' : ''}</p>
        ${prov.hasKey ? `<p class="sh-ui-small">Your key for public programs at ${escHtml(prov.label)} is set. <button type="button" class="linklike" data-act="keyclear">remove it</button></p>`
          : `<div class="sh-ui-line"><input id="payKey" type="password" placeholder="an API key for ${escHtml(prov.label)}, for public programs only" autocomplete="off"><button type="button" data-act="keysave">Save key</button></div>
             <p class="sh-ui-small">Make a key just for this, with a spending limit set at ${prov.keyUrl ? `<a href="${escHtml(prov.keyUrl)}" target="_blank" rel="noopener noreferrer">${escHtml(prov.label)}</a>` : escHtml(prov.label)}: the strongest limit there is. It stays on this computer, apart from your own sign-ins.</p>`}
        <div class="sh-ui-line"><label>Up to $<input id="payBudget" type="number" min="0.01" step="0.01" value="${escHtml(o.monthlyUsd)}"> a month</label><label><input id="payRate" type="number" min="1" step="1" value="${escHtml(o.perVisitorPerHour)}"> answers an hour for each visitor</label></div>
      </div>
      <label><input type="checkbox" id="payShare"${current.shareCalls === false ? '' : ' checked'}> Visitors may send me their calls, when they choose to (to judge and improve it)</label>
    </fieldset>`;
  }
  function renderPub() {
    const shares = current.shares || [];
    overlay.querySelector('.dialog').innerHTML = `
      <h3>Publish “${escHtml(current.title)}”</h3>
      <p class="sh-ui-hint">${current.type === 'program'
        ? 'Its own page and API, at its own address, for anyone you give it to. What goes out is a copy of its live version, frozen and signed by this computer: anyone can check that what they got is what you published.'
        : 'A copy of it, frozen, at its own address: changing the files later changes nothing until you publish again. Signed by this computer, so anyone can check that what they got is what you published.'}</p>
      ${shares.length ? `<div class="sh-ui-list">${shares.map(pubRowHtml).join('')}</div>${current.adding ? '' : '<p><button type="button" data-act="another" class="linklike">Publish it at another address</button></p>'}` : ''}
      ${!shares.length || current.adding ? pubFormHtml() : ''}
      <div class="sh-ui-where" id="shWhere">${pubWhereHtml()}</div>
      <p class="sh-ui-error" id="shError" role="alert" hidden></p>
      <div class="btnrow"><button id="shClose">Done</button></div>`;
  }
  function pubWhereHtml() {
    const pub = current && current.pub;
    if (pub && pub.url) return `<p class="sh-ui-small">Its address is under ${escHtml(pub.url.replace(/^https:\/\//, ''))}, this computer's public address. It answers while this computer is on.</p>`;
    return whereHtml([]);
  }
  async function refreshPub() {
    const q = current.type === 'program' ? 'program=' + encodeURIComponent(current.source.program) : 'published=' + encodeURIComponent(current.source.path);
    current.shares = (await call('/api/shares?' + q)).shares;
    renderPub();
  }
  async function loadPreview() {
    current.preview = await call('/api/publications/preview', { type: current.type, ...current.source });
    if (!current.slug) current.slug = current.preview.slug;
  }
  async function loadPrice() {
    const o = current.ownerPay;
    if (!o || !o.on) { current.price = null; return; }
    const prov = current.keys.providers.find(p => p.id === o.provider) || current.keys.providers[0];
    current.price = await call('/api/publications/price?' + new URLSearchParams({ provider: prov.id, model: o.model || prov.model })).catch(() => null);
  }
  function readPayForm() {
    if (!overlay.querySelector('#payOn')) return;
    const prov = overlay.querySelector('#payProvider').value;
    current.ownerPay = { on: overlay.querySelector('#payOn').checked, provider: prov, model: overlay.querySelector('#payModel').value.trim(), monthlyUsd: Number(overlay.querySelector('#payBudget').value) || 0, perVisitorPerHour: Number(overlay.querySelector('#payRate').value) || 10 };
    current.shareCalls = overlay.querySelector('#payShare').checked;
  }
  async function openPublication(spec) {
    ensureOverlay();
    current = { kind: 'publication', type: spec.type, title: spec.title || 'this', shares: [], access: 'link',
      source: spec.type === 'program' ? { program: spec.program } : { path: spec.path, key: spec.key || null, version: spec.version || null } };
    const mine = current;
    overlay.hidden = false;
    overlay.querySelector('.dialog').innerHTML = '<p class="sh-ui-hint">Reading what would go out…</p>';
    try {
      await loadPub();
      if (mine.type === 'program') {
        try { mine.keys = { owner: true, ...(await call('/api/publications/keys')) }; } catch { mine.keys = { owner: false, providers: [] }; }
      }
      await Promise.all([refreshPub(), loadPreview()]);
      if (current === mine) renderPub();
    } catch (e) { if (current === mine) { renderPub(); fail(e); } }
  }
  async function onPubClick(b, row, id, share) {
    const act = b.dataset.act;
    if (b.id === 'pubGo') {
      readPayForm();
      const pay = current.type === 'program' ? { owner: current.ownerPay && current.ownerPay.on ? current.ownerPay : null, shareCalls: current.shareCalls !== false } : undefined;
      b.disabled = true;
      try {
        const out = await call('/api/shares', { kind: 'publication', type: current.type, ...current.source, slug: overlay.querySelector('#pubSlug').value.trim().toLowerCase(),
          access: (overlay.querySelector('input[name=pubAccess]:checked') || {}).value || 'link', title: current.title, pay });
        current.adding = false; current.slug = null;
        await refreshPub();
        const fresh = overlay.querySelector(`.sh-ui-row[data-id="${out.share.id}"] [data-act="copy"]`);
        if (fresh && best(out.share)) copy(best(out.share).url, fresh);
      } finally { if (b.isConnected) b.disabled = false; }
      return true;
    }
    if (act === 'another') { current.adding = true; current.slug = null; await loadPreview(); renderPub(); return true; }
    if (act === 'keysave' || act === 'keyclear') {
      readPayForm();
      const key = act === 'keysave' ? overlay.querySelector('#payKey').value.trim() : '';
      if (act === 'keysave' && !key) throw new Error('Paste the key first.');
      if (act === 'keyclear' && !confirm('Remove the key for public programs? Programs paid with it stop answering for visitors until a key is set again.')) return true;
      current.keys = { owner: true, ...(await call('/api/publications/keys', { provider: current.ownerPay.provider, key })) };
      await loadPrice(); renderPub();
      return true;
    }
    if (!share) return false;
    if (act === 'republish') {
      await call('/api/shares/change', { id, republish: true, ...(current.type === 'site' && current.source.version ? { version: current.source.version } : {}) });
      await refreshPub();
      return true;
    }
    if (act === 'revoke') {
      if (!confirm('Turn it off? Its address stops answering at once, for everyone.')) return true;
      await call('/api/shares/revoke', { id });
      await refreshPub();
      return true;
    }
    if (act === 'replace') {
      if (!confirm('Make a new link? The current one stops working at once, for everyone who has it.')) return true;
      await call('/api/shares/change', { id, newSecret: true });
      await refreshPub();
      return true;
    }
    return false;
  }
  async function onPubChange(e) {
    const sel = e.target;
    const row = sel.closest('.sh-ui-row');
    if (row && sel.dataset.act === 'access') { await call('/api/shares/change', { id: row.dataset.id, access: sel.value }); return refreshPub(); }
    if (row && sel.dataset.act === 'version') { await call('/api/shares/change', { id: row.dataset.id, root: sel.value }); return refreshPub(); }
    if (['payOn', 'payProvider', 'payModel'].includes(sel.id)) {
      readPayForm();
      if (sel.id === 'payProvider') current.ownerPay.model = '';
      const slug = overlay.querySelector('#pubSlug') && overlay.querySelector('#pubSlug').value;
      if (slug) current.slug = slug;
      current.access = (overlay.querySelector('input[name=pubAccess]:checked') || {}).value || current.access;
      await loadPrice(); renderPub();
    }
  }

  async function onClick(e) {
    const b = e.target.closest('button, input');
    if (!b || !overlay.contains(b)) { if (e.target === overlay) close(); return; }
    const row = b.closest('.sh-ui-row'), id = row && row.dataset.id;
    const share = id && current.shares.find(s => s.id === id);
    if (isPub() && b.id !== 'shClose' && b.dataset.act !== 'copy' && b.dataset.act !== 'select' && b.id !== 'shPubOn' && b.dataset.act !== 'pub-off') {
      try { if (await onPubClick(b, row, id, share)) return; } catch (err) { return fail(err); }
    }
    try {
      if (b.id === 'shClose') return close();
      if (b.id === 'shPubOn') {
        const name = overlay.querySelector('#shPubName').value.trim().toLowerCase();
        current.pub = await call('/api/public-links', { on: true, name });
        renderWhere(); pollPub();
        return;
      }
      if (b.dataset.act === 'pub-off') {
        if (!confirm('Turn the public address off? Links stop opening from outside your networks until it is on again.')) return;
        current.pub = await call('/api/public-links', { on: false });
        return refresh();
      }
      if (b.id === 'shCreate') {
        const days = Number(overlay.querySelector('#shNewEnd').value || 0);
        const out = await call('/api/shares', isConv()
          ? { kind: 'conversation', key: current.key, title: current.title, mode: overlay.querySelector('#shNewMode').value, expiresAt: days ? Date.now() + days * DAY : null }
          : { path: current.path, role: overlay.querySelector('#shNewRole').value, expiresAt: days ? Date.now() + days * DAY : null });
        await refresh();
        const fresh = overlay.querySelector(`.sh-ui-row[data-id="${out.share.id}"] [data-act="copy"]`);
        if (fresh && best(out.share)) copy(best(out.share).url, fresh);
        return;
      }
      const act = b.dataset.act;
      if (act === 'select') return b.select();
      if (!share) return;
      if (act === 'copy') return copy(best(share).url, b);
      if (act === 'resnap') {
        await call('/api/shares/change', { id, refreshSnapshot: true });
        return refresh();
      }
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
    if (isPub()) { try { await onPubChange(e); } catch (err) { fail(err); } return; }
    const sel = e.target.closest('select[data-act="role"], select[data-act="mode"]');
    if (!sel) return;
    const id = sel.closest('.sh-ui-row').dataset.id;
    try { await call('/api/shares/change', { id, [sel.dataset.act]: sel.value }); await refresh(); }
    catch (err) { fail(err); }
  }
  function onKey(e) {
    if (!overlay || overlay.hidden) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && e.target && e.target.id === 'shPubName') { e.preventDefault(); overlay.querySelector('#shPubOn')?.click(); }
  }

  function ensureOverlay() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'overlay sh-ui';
      overlay.innerHTML = '<div class="dialog" role="dialog" aria-modal="true" aria-label="Share by link"></div>';
      overlay.addEventListener('click', onClick);
      overlay.addEventListener('change', onChange);
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
    }
  }
  async function open(path, title) {
    if (!path) return;
    ensureOverlay();
    current = { kind: 'file', path, title: title || path.split(/[\\/]/).pop(), shares: [] };
    overlay.hidden = false;
    overlay.querySelector('.dialog').innerHTML = '<p class="sh-ui-hint">Loading…</p>';
    try { await loadPub(); await refresh(); pollPub(); } catch (e) { render(); fail(e); }
  }
  // A conversation: read only, live or a snapshot (share-page/viewer.js).
  async function openConversation(key, title) {
    if (!key) return;
    ensureOverlay();
    const mine = { kind: 'conversation', key, title: title || 'this conversation', shares: [], scan: null };
    current = mine;
    overlay.hidden = false;
    overlay.querySelector('.dialog').innerHTML = '<p class="sh-ui-hint">Loading…</p>';
    call('/api/shares/scan?key=' + encodeURIComponent(key)).then(sc => { if (current === mine) { mine.scan = sc; render(); } }).catch(() => {});
    try { await loadPub(); await refresh(); pollPub(); } catch (e) { render(); fail(e); }
  }
  function close() { clearTimeout(pubTimer); if (overlay) overlay.hidden = true; current = null; }

  // The document's Share button (live-file.js head) and its ⋯ entry.
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('#liveShare, #liveShareMenu');
    if (!b) return;
    const ws = typeof fileWs !== 'undefined' ? fileWs : null;
    if (!ws || !ws.path) return;
    const more = b.closest('details'); if (more) more.open = false;
    open(ws.path, ws.path.split(/[\\/]/).pop());
  });

  window.SharesUI = { open, openConversation, openPublication, close };
})();
