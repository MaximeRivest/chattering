/* ai-connect.js — "Connect your AI" (design/73).
 *
 * The page's side of connecting this machine to a model: the usual choices
 * (a Claude or ChatGPT plan, GitHub Copilot, an API key for any provider
 * Pi knows, a model server such as Ollama or LM Studio), a sign-in dialog
 * that shows each step a provider's sign-in asks for, and a first "hello"
 * from the model so a person sees it work. Used by the welcome (welcome.js)
 * and by settings → AI accounts. Server: /api/ai (ai-accounts.js).
 */
(function () {
  'use strict';
  const A = window.AiConnect = { summary: null, loading: null, hosts: new Set() };
  const $$ = (root, sel) => root.querySelector(sel);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // The plans people already pay for come first, then keys, then their own server.
  const PLANS = [
    { provider: 'anthropic', title: 'Claude', sub: 'Sign in with your Claude Pro or Max plan', glyph: '✳' },
    { provider: 'openai-codex', title: 'ChatGPT', sub: 'Sign in with your ChatGPT Plus or Pro plan', glyph: '◎' },
    { provider: 'github-copilot', title: 'GitHub Copilot', sub: 'Sign in with your Copilot subscription', glyph: '⌬' },
  ];
  const POPULAR_KEYS = ['anthropic', 'openai', 'google', 'openrouter', 'xai', 'mistral', 'groq', 'deepseek'];
  // Where each provider hands out keys: the one thing a newcomer must find.
  const KEY_PAGES = {
    anthropic: 'https://console.anthropic.com/settings/keys', openai: 'https://platform.openai.com/api-keys',
    google: 'https://aistudio.google.com/apikey', openrouter: 'https://openrouter.ai/keys', xai: 'https://console.x.ai',
    mistral: 'https://console.mistral.ai/api-keys', groq: 'https://console.groq.com/keys', deepseek: 'https://platform.deepseek.com/api_keys',
    together: 'https://api.together.ai/settings/api-keys', fireworks: 'https://fireworks.ai/account/api-keys', cerebras: 'https://cloud.cerebras.ai',
    huggingface: 'https://huggingface.co/settings/tokens',
  };
  const PLAN_NAMES = { anthropic: 'Claude', 'openai-codex': 'ChatGPT', 'github-copilot': 'GitHub Copilot' };
  // Is this browser on the computer that runs Chattering? A plan's sign-in
  // returns to localhost; from another device that page cannot load, and
  // the person pastes its address instead.
  const sameComputer = () => /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);

  const providerOf = id => (A.summary && A.summary.providers || []).find(p => p.id === id) || null;
  const nameOf = id => PLAN_NAMES[id] || (providerOf(id) || {}).name || id;
  const modelLabel = (provider, model) => {
    const m = (A.summary && A.summary.available || []).find(x => x.provider === provider && x.id === model);
    return (m && m.name && m.name !== m.id ? m.name : model) || '';
  };

  async function api(route, body) {
    const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    let r;
    try { r = await fetch(route, opts); } catch { throw new Error('Chattering did not answer (network).'); }
    const out = await r.json().catch(() => ({}));
    if (!r.ok || out.error) throw new Error(out.error || 'Chattering answered ' + r.status);
    return out;
  }

  A.refresh = function refresh() {
    A.asked = true;
    A.loading = api('/api/ai').then(s => { A.summary = s; A.error = null; A.paintAll(); if (window.Welcome) Welcome.repaint(); return s; })
      .catch(e => { A.error = e.message; A.paintAll(); throw e; }).finally(() => { A.loading = null; });
    return A.loading;
  };
  A.ready = () => !!(A.summary && A.summary.ready);
  A.paintAll = () => { for (const h of [...A.hosts]) { if (!h.el.isConnected) A.hosts.delete(h); else paint(h); } };

  // ---- the chooser -----------------------------------------------------------
  // mount(el, { compact }) draws the choices into el and keeps them current.
  A.mount = function mount(el, opts = {}) {
    const host = { el, opts };
    A.hosts.add(host);
    if (A.summary) paint(host); else { el.innerHTML = '<p class="aic-wait">Looking at what is connected…</p>'; (A.loading || A.refresh()).catch(() => {}); }
    return host;
  };

  function connectedHtml(s) {
    const d = s.default || {};
    const rows = [];
    for (const p of s.providers || []) {
      if (!p.configured || (s.servers || []).some(x => x.name === p.id)) continue;
      const how = p.using === 'oauth' ? (p.oauth && p.oauth.subscription ? 'your plan' : 'signed in') : 'API key';
      const envKey = /env|environment/i.test(p.source || '');
      rows.push(`<li><span class="aic-dot" aria-hidden="true"></span><b>${esc(nameOf(p.id))}</b><span class="aic-how">${esc(how)}${envKey ? ' · from this computer’s environment' : ''}</span>
        ${envKey ? '' : `<button type="button" class="ghost" data-aic-logout="${esc(p.id)}">Sign out</button>`}</li>`);
    }
    for (const x of s.servers || []) {
      rows.push(`<li><span class="aic-dot" aria-hidden="true"></span><b>${esc(x.name)}</b><span class="aic-how">${esc(x.baseUrl)} · ${x.models.length} model${x.models.length === 1 ? '' : 's'}</span>
        <button type="button" class="ghost" data-aic-remove="${esc(x.name)}">Remove</button></li>`);
    }
    if (!rows.length) return '';
    const groups = new Map();
    for (const m of s.available || []) { if (!groups.has(m.provider)) groups.set(m.provider, []); groups.get(m.provider).push(m); }
    const options = [...groups].map(([p, ms]) => `<optgroup label="${esc(nameOf(p))}">${ms.map(m => `<option value="${esc(p + '\u0000' + m.id)}"${p === d.provider && m.id === d.model ? ' selected' : ''}>${esc(m.name || m.id)}</option>`).join('')}</optgroup>`).join('');
    const inList = (s.available || []).some(m => m.provider === d.provider && m.id === d.model);
    return `<div class="aic-connected">
      <ul class="aic-list">${rows.join('')}</ul>
      ${s.available && s.available.length ? `<label class="aic-model"><span>Chattering uses</span>
        <select data-aic-default>${inList ? '' : '<option value="" selected>choose a model…</option>'}${options}</select>
        <button type="button" data-aic-hello>Say hello</button></label>
        <p class="aic-hello" data-aic-hello-out hidden></p>` : '<p class="aic-note">Connected, but no model is available yet. Pi lists the models once the provider answers; try again in a moment.</p>'}
    </div>`;
  }

  function paint(host) {
    const { el, opts } = host;
    const s = A.summary;
    if (!s) { el.innerHTML = `<p class="aic-error">${esc(A.error || 'Could not read what is connected.')}</p>`; return; }
    const detected = (s.detected || []).map(d => `<button type="button" class="aic-found" data-aic-found="${esc(d.baseUrl)}">
        <b>${esc(d.label)} is running on this computer</b><span>${d.models.length} model${d.models.length === 1 ? '' : 's'}: ${esc(d.models.slice(0, 3).join(', '))}${d.models.length > 3 ? '…' : ''} · use it</span></button>`).join('');
    const connected = connectedHtml(s);
    const choices = `<div class="aic-grid">
      ${PLANS.filter(p => providerOf(p.provider)).map(p => `<button type="button" class="aic-card" data-aic-plan="${p.provider}">
        <span class="aic-glyph" aria-hidden="true">${p.glyph}</span><b>${esc(p.title)}</b><span>${esc(p.sub)}</span></button>`).join('')}
      <button type="button" class="aic-card" data-aic-key><span class="aic-glyph" aria-hidden="true">⚿</span><b>An API key</b><span>Anthropic, OpenAI, Google Gemini, OpenRouter and ${Math.max(0, (s.providers || []).filter(p => p.apiKey).length - 4)} more</span></button>
      <button type="button" class="aic-card" data-aic-server><span class="aic-glyph" aria-hidden="true">▣</span><b>A model on your computer</b><span>Ollama, LM Studio, or any OpenAI-compatible server</span></button>
    </div>`;
    el.innerHTML = `${detected ? `<div class="aic-detected">${detected}</div>` : ''}
      ${connected}
      ${connected && opts.compact ? `<details class="aic-more"><summary>Connect another</summary>${choices}</details>` : choices}
      <p class="aic-privacy">Keys and sign-ins stay on this computer and go only to the provider you choose.</p>`;
    wire(el);
  }

  function wire(el) {
    el.querySelectorAll('[data-aic-plan]').forEach(b => b.onclick = () => signIn(b.dataset.aicPlan, 'oauth'));
    const key = $$(el, '[data-aic-key]'); if (key) key.onclick = () => keyPicker();
    const server = $$(el, '[data-aic-server]'); if (server) server.onclick = () => serverDialog('');
    el.querySelectorAll('[data-aic-found]').forEach(b => b.onclick = () => serverDialog(b.dataset.aicFound, true));
    el.querySelectorAll('[data-aic-logout]').forEach(b => b.onclick = async () => {
      if (!confirm('Sign out of ' + nameOf(b.dataset.aicLogout) + ' on this computer?')) return;
      b.disabled = true;
      try { await api('/api/ai/logout', { provider: b.dataset.aicLogout }); await afterChange(); } catch (e) { errToast(e.message); b.disabled = false; }
    });
    el.querySelectorAll('[data-aic-remove]').forEach(b => b.onclick = async () => {
      if (!confirm('Stop using ' + b.dataset.aicRemove + '?')) return;
      try { await api('/api/ai/server/remove', { name: b.dataset.aicRemove }); await afterChange(); } catch (e) { errToast(e.message); }
    });
    const sel = $$(el, '[data-aic-default]');
    if (sel) sel.onchange = async () => {
      if (!sel.value) return;
      const [provider, model] = sel.value.split('\u0000');
      try { await api('/api/ai/default', { provider, model }); toast('Chattering now uses ' + modelLabel(provider, model)); await afterChange(); } catch (e) { errToast(e.message); }
    };
    const hello = $$(el, '[data-aic-hello]');
    if (hello) hello.onclick = async () => {
      const out = $$(el, '[data-aic-hello-out]');
      hello.disabled = true; out.hidden = false; out.className = 'aic-hello'; out.textContent = 'Asking the model…';
      try { const r = await api('/api/ai/test', {}); out.innerHTML = `“${esc(r.text || '(an empty reply)')}” <small>${esc(modelLabel(r.provider, r.model))} · ${(r.ms / 1000).toFixed(1)} s</small>`; }
      catch (e) { out.className = 'aic-hello aic-error'; out.textContent = e.message; }
      hello.disabled = false;
    };
  }

  // Everything that shows a model learns of a change: settings, the pickers, the welcome.
  async function afterChange() {
    await A.refresh().catch(() => {});
    if (typeof loadSettings === 'function') loadSettings().catch?.(() => {});
    if (typeof loadModels === 'function') { try { await loadModels(true); } catch {} }
    window.dispatchEvent(new Event('ai-connect-changed'));
  }
  A.afterChange = afterChange;

  // ---- a dialog of this module ---------------------------------------------
  function dialog(title, cls = '') {
    const d = document.createElement('dialog');
    d.className = 'aic-dialog ' + cls;
    d.innerHTML = `<div class="aic-head"><h2>${esc(title)}</h2><button type="button" class="ghost aic-close" aria-label="Close">✕</button></div><div class="aic-body"></div>`;
    document.body.appendChild(d);
    d.addEventListener('keydown', e => e.stopPropagation()); // no app shortcut behind it
    d.addEventListener('close', () => { if (d.onGone) d.onGone(); d.remove(); });
    $$(d, '.aic-close').onclick = () => d.close();
    d.showModal();
    return { d, body: $$(d, '.aic-body') };
  }

  // ---- an API key: which provider ------------------------------------------
  function keyPicker() {
    const s = A.summary || { providers: [] };
    const all = s.providers.filter(p => p.apiKey && p.apiKey.canLogin);
    const popular = POPULAR_KEYS.map(id => all.find(p => p.id === id)).filter(Boolean);
    const others = all.filter(p => !POPULAR_KEYS.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name));
    const { d, body } = dialog('Use an API key');
    const sayMore = p => !p.apiKey.name.toLowerCase().startsWith(p.name.toLowerCase());
    const row = p => `<button type="button" class="aic-row" data-aic-pick="${esc(p.id)}"><b>${esc(p.name)}</b>${sayMore(p) ? `<span>${esc(p.apiKey.name)}</span>` : ''}${p.configured ? '<em>connected</em>' : ''}</button>`;
    body.innerHTML = `<p>Pay the provider directly, per use. Choose who gave you the key:</p>
      <input type="search" class="aic-search" placeholder="Search ${all.length} providers" aria-label="Search providers">
      <div class="aic-rows" data-aic-rows>${popular.map(row).join('')}<details class="aic-others"><summary>${others.length} more providers</summary>${others.map(row).join('')}</details></div>`;
    const search = $$(body, '.aic-search');
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      $$(body, '[data-aic-rows]').innerHTML = q ? (all.filter(p => (p.name + ' ' + p.id + ' ' + p.apiKey.name).toLowerCase().includes(q)).map(row).join('') || '<p class="aic-note">No provider by that name.</p>')
        : `${popular.map(row).join('')}<details class="aic-others"><summary>${others.length} more providers</summary>${others.map(row).join('')}</details>`;
      wireRows();
    };
    const wireRows = () => body.querySelectorAll('[data-aic-pick]').forEach(b => b.onclick = () => { d.close(); signIn(b.dataset.aicPick, 'api_key'); });
    wireRows();
    search.focus();
  }

  // ---- a sign-in: each step Pi's sign-in asks for, until done ---------------
  function signIn(provider, method) {
    const p = providerOf(provider);
    const title = method === 'oauth' ? 'Sign in to ' + nameOf(provider) : (p ? p.name : provider) + ' API key';
    const { d, body } = dialog(title, 'aic-signin');
    let id = null, last = '', running = true, stopped = false, opened = new Set();
    body.innerHTML = '<p class="aic-wait">Starting…</p>';
    // Closing the dialog mid-way ends the sign-in on the server too.
    d.onGone = () => { stopped = true; if (id && running) api('/api/ai/login/cancel', { id }).catch(() => {}); };
    const show = state => {
      running = state.status === 'running';
      const sig = JSON.stringify([state.status, state.prompt && state.prompt.id, state.events.length, state.error]);
      if (sig === last) return;
      // What the person typed survives a redraw for the same question.
      const typed = last && state.prompt ? body.querySelector('form[data-aic-answer] input')?.value : '';
      const sameQuestion = last && JSON.parse(last)[1] === (state.prompt && state.prompt.id);
      last = sig;
      body.innerHTML = stepsHtml(state, provider, method);
      if (typed && sameQuestion) { const input = body.querySelector('form[data-aic-answer] input'); if (input) input.value = typed; }
      wireSteps(state);
    };
    const wireSteps = state => {
      body.querySelectorAll('[data-aic-open]').forEach(a => a.addEventListener('click', () => opened.add(a.href)));
      const form = $$(body, 'form[data-aic-answer]');
      if (form) {
        const input = $$(form, 'input');
        form.onsubmit = async e => {
          e.preventDefault();
          const value = input ? input.value.trim() : '';
          if (input && input.required && !value) return input.focus();
          form.querySelectorAll('button, input').forEach(c => { c.disabled = true; });
          try { show(await api('/api/ai/login/answer', { id, prompt: state.prompt.id, value })); } catch (err) { errToast(err.message); form.querySelectorAll('button, input').forEach(c => { c.disabled = false; }); }
        };
        if (input && (state.prompt.type !== 'manual_code' || !sameComputer())) setTimeout(() => input.focus(), 0);
      }
      body.querySelectorAll('[data-aic-choose]').forEach(b => b.onclick = async () => {
        body.querySelectorAll('[data-aic-choose]').forEach(c => { c.disabled = true; });
        try { show(await api('/api/ai/login/answer', { id, prompt: state.prompt.id, value: b.dataset.aicChoose })); } catch (err) { errToast(err.message); }
      });
      const copy = $$(body, '[data-aic-copy]');
      if (copy) copy.onclick = () => { navigator.clipboard?.writeText(copy.dataset.aicCopy).then(() => toast('code copied')); };
      const again = $$(body, '[data-aic-again]');
      if (again) again.onclick = () => { d.close(); signIn(provider, method); };
      const done = $$(body, '[data-aic-done]');
      if (done) done.onclick = () => d.close();
      if (state.status === 'done') helloAfterConnect(body);
      // Focus the step's own action (the close button is first in the dialog).
      if (!body.contains(document.activeElement)) setTimeout(() => (body.querySelector('.aic-go, [data-aic-choose].primary, form[data-aic-answer] input, [data-aic-done].primary, [data-aic-again]') || {}).focus?.(), 0);
    };
    api('/api/ai/login', { provider, method }).then(async state => {
      id = state.id;
      show(state);
      while (!stopped && state.status === 'running') {
        await new Promise(r => setTimeout(r, 700));
        if (stopped) return;
        try { state = await api('/api/ai/login?id=' + encodeURIComponent(id)); } catch (e) { state = { status: 'error', error: e.message, events: [], prompt: null }; }
        show(state);
      }
      if (state.status === 'done') await afterChange();
    }, e => { body.innerHTML = `<p class="aic-error">${esc(e.message)}</p><footer><button type="button" data-aic-close2>Close</button></footer>`; $$(body, '[data-aic-close2]').onclick = () => d.close(); });
  }

  function stepsHtml(state, provider, method) {
    if (state.status === 'done') {
      const def = state.default || {};
      return `<div class="aic-success"><span class="aic-check" aria-hidden="true">✓</span><div><b>${esc(nameOf(provider))} is connected.</b>
        ${def.model ? `<p>New conversations use <b>${esc(modelLabel(def.provider, def.model) || def.model)}</b>. You can change it any time.</p>` : ''}</div></div>
        <p class="aic-hello" data-aic-hello-out>Saying hello to the model…</p>
        <footer><button type="button" class="primary" data-aic-done>Continue</button></footer>`;
    }
    if (state.status === 'error' || state.status === 'cancelled') {
      return `<p class="aic-error">${esc(state.error || (state.status === 'cancelled' ? 'The sign-in was cancelled.' : 'The sign-in did not work.'))}</p>
        <footer><button type="button" class="ghost" data-aic-done>Close</button><button type="button" class="primary" data-aic-again>Try again</button></footer>`;
    }
    const parts = [];
    const url = [...state.events].reverse().find(e => e.type === 'auth_url');
    const device = [...state.events].reverse().find(e => e.type === 'device_code');
    const progress = [...state.events].reverse().find(e => e.type === 'progress');
    for (const e of state.events.filter(e => e.type === 'info')) parts.push(`<p class="aic-note">${esc(e.message)} ${(e.links || []).map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label || l.url)}</a>`).join(' ')}</p>`);
    if (device) {
      parts.push(`<ol class="aic-steps"><li>Open <a data-aic-open href="${esc(device.verificationUri)}" target="_blank" rel="noopener">${esc(device.verificationUri.replace(/^https?:\/\//, ''))}</a> on any device.</li>
        <li>Enter this code: <span class="aic-code">${esc(device.userCode)}</span> <button type="button" class="ghost" data-aic-copy="${esc(device.userCode)}">copy</button></li>
        <li>Come back here: this window moves on by itself.</li></ol><p class="aic-wait">Waiting for you to enter the code…</p>`);
    } else if (url) {
      parts.push(`<p>${sameComputer() ? 'Sign in on the provider’s page and allow access. This window moves on by itself.' : 'Sign in on the provider’s page and allow access.'}</p>
        <p><a class="aic-go" data-aic-open href="${esc(url.url)}" target="_blank" rel="noopener">Open the ${esc(nameOf(provider))} sign-in page ↗</a></p>`);
    }
    const q = state.prompt;
    if (q && q.type === 'manual_code') {
      const remote = !sameComputer();
      const form = `<form data-aic-answer class="aic-answer"><label>${remote
        ? 'After you allow access, the page shows an error: that is expected here, because Chattering runs on another computer. Copy the whole address from the browser’s address bar and paste it here:'
        : 'Or, if the page shows a code or an error page, copy it (or the whole address from the address bar) and paste it here:'}
        <input type="text" required autocomplete="off" spellcheck="false" placeholder="${esc(q.placeholder || 'http://localhost…')}"></label><button type="submit">Continue</button></form>`;
      parts.push(remote ? form : `<details class="aic-fallback"><summary>The page did not come back here?</summary>${form}</details>`);
      if (!remote) parts.push('<p class="aic-wait">Waiting for the sign-in…</p>');
    } else if (q && q.type === 'select') {
      const remote = !sameComputer();
      parts.push(`<p>${esc(q.message)}</p><div class="aic-choices">${(q.options || []).map(o => {
        const device = /device|code|headless/i.test(o.id + ' ' + o.label);
        const label = device ? 'With a code on any device' : /browser/i.test(o.id + ' ' + o.label) ? 'In this browser' : o.label;
        const best = device === remote;
        return `<button type="button" class="${best ? 'primary' : ''}" data-aic-choose="${esc(o.id)}">${esc(label)}</button>`;
      }).join('')}</div>${remote ? '<p class="aic-note">Chattering runs on another computer, so “with a code” is the simpler way here.</p>' : ''}`);
    } else if (q && (q.type === 'secret' || q.type === 'text')) {
      const page = method === 'api_key' ? KEY_PAGES[provider] : null;
      const optional = q.type === 'text' && /blank|empty|optional|leave/i.test(q.message);
      parts.push(`<form data-aic-answer class="aic-answer"><label>${esc(q.message)}
        <input type="${q.type === 'secret' ? 'password' : 'text'}" ${optional ? '' : 'required'} autocomplete="off" spellcheck="false" placeholder="${esc(q.placeholder || '')}"></label>
        <button type="submit" class="primary">${q.type === 'secret' ? 'Save key' : 'Continue'}</button></form>
        ${page ? `<p class="aic-note">No key yet? Make one at <a href="${esc(page)}" target="_blank" rel="noopener">${esc(page.replace(/^https:\/\//, '').replace(/\/.*$/, ''))}</a>.</p>` : ''}`);
    } else if (!url && !device) {
      parts.push(`<p class="aic-wait">${esc(progress ? progress.message : 'Working…')}</p>`);
    } else if (progress) parts.push(`<p class="aic-wait">${esc(progress.message)}</p>`);
    return parts.join('');
  }

  // The moment it works: the model's own first words.
  async function helloAfterConnect(body) {
    const out = $$(body, '[data-aic-hello-out]');
    if (!out || out.dataset.asked) return;
    out.dataset.asked = '1';
    try { const r = await api('/api/ai/test', {}); out.innerHTML = `“${esc(r.text || '(an empty reply)')}” <small>${esc(modelLabel(r.provider, r.model))} · ${(r.ms / 1000).toFixed(1)} s</small>`; }
    catch (e) { out.className = 'aic-hello aic-error'; out.textContent = 'Connected, but the first message failed: ' + e.message; }
  }

  // ---- a model server --------------------------------------------------------
  function serverDialog(baseUrl, found = false) {
    const { d, body } = dialog('A model on your computer');
    body.innerHTML = `<p>Chattering can use a model you run yourself, with <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a>, <a href="https://lmstudio.ai" target="_blank" rel="noopener">LM Studio</a>, llama.cpp, vLLM or any server that speaks the OpenAI API.</p>
      <form class="aic-answer aic-server"><label>The server’s address<input type="text" name="baseUrl" required spellcheck="false" autocomplete="off" value="${esc(baseUrl)}" placeholder="http://127.0.0.1:11434"></label>
      <label>Key <small>(only if the server asks for one)</small><input type="password" name="apiKey" autocomplete="off" spellcheck="false"></label>
      <button type="submit" class="primary">Connect</button></form><div data-aic-server-out></div>`;
    const form = $$(body, 'form'), out = $$(body, '[data-aic-server-out]');
    form.onsubmit = async e => {
      e.preventDefault();
      form.querySelectorAll('button, input').forEach(c => { c.disabled = true; });
      out.innerHTML = '<p class="aic-wait">Asking the server for its models…</p>';
      try {
        const r = await api('/api/ai/server', { baseUrl: form.baseUrl.value, apiKey: form.apiKey.value });
        await afterChange();
        body.innerHTML = `<div class="aic-success"><span class="aic-check" aria-hidden="true">✓</span><div><b>Connected to ${esc(r.name)}</b>
          <p>${r.models.length} model${r.models.length === 1 ? '' : 's'} found${r.default && r.default.model ? `; new conversations use <b>${esc(r.default.model)}</b>` : ''}.</p></div></div>
          <p class="aic-hello" data-aic-hello-out>Saying hello to the model…</p><footer><button type="button" class="primary" data-aic-done>Continue</button></footer>`;
        $$(body, '[data-aic-done]').onclick = () => d.close();
        helloAfterConnect(body);
      } catch (err) {
        out.innerHTML = `<p class="aic-error">${esc(err.message)}</p>`;
        form.querySelectorAll('button, input').forEach(c => { c.disabled = false; });
      }
    };
    if (found) form.requestSubmit(); else form.baseUrl.focus();
  }

  A.nameOf = nameOf;
  A.signIn = signIn;
  A.keyPicker = keyPicker;
  A.serverDialog = serverDialog;
})();
