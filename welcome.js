/* welcome.js — a new person's first minutes (design/73).
 *
 * Home, before there is anything to show, is three steps: connect an AI
 * (ai-connect.js), decide what may run in the background (the first-run
 * question, asked here once a model exists to run it), and start a
 * conversation. A home that already has conversations but no AI gets one
 * line above them instead: they can be read now, continued once connected.
 */
(function () {
  'use strict';
  const W = window.Welcome = {};
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let host = null, banner = null, sig = '', changingAi = false;

  // settingsState is the page's (a script-level let, not a window property).
  const settings = () => (typeof settingsState !== 'undefined' ? settingsState : null);
  const owner = () => !!(settings() && settings().canEditSettings);
  const bg = () => (settings() && settings().settings && settings().settings.backgroundAi) || {};
  const aiKnown = () => !!(window.AiConnect && AiConnect.summary);
  const aiReady = () => aiKnown() ? AiConnect.ready() : false;

  // Home's list is empty: the welcome takes its place.
  W.paint = function paint(list) {
    host = list;
    if (owner() && !aiKnown() && window.AiConnect && !AiConnect.asked) AiConnect.refresh().catch(() => {});
    const d = aiKnown() ? AiConnect.summary.default || {} : {};
    const next = JSON.stringify([owner(), aiKnown(), aiReady(), d.provider, d.model, !!bg().decidedAt, changingAi]);
    if (next === sig && list.querySelector('.wel')) return;
    sig = next;
    list.innerHTML = html();
    wire(list);
  };
  W.repaint = function repaint() {
    if (host && host.isConnected && host.querySelector('.wel')) { sig = ''; W.paint(host); }
    const list = document.getElementById('list');
    if (list) W.banner(list);
  };
  W.showing = () => !!(host && host.isConnected && host.querySelector('.wel'));

  function html() {
    const ready = aiReady(), decided = !!bg().decidedAt;
    const s = aiKnown() ? AiConnect.summary : null;
    const d = (s && s.default) || {};
    const model = d.model ? ((s.available || []).find(m => m.provider === d.provider && m.id === d.model) || {}).name || d.model : '';
    const step = (n, state, title, body) => `<section class="wel-step ${state}"><span class="wel-n">${state === 'done' ? '✓' : n}</span><div><h2>${title}</h2>${body}</div></section>`;
    const one = !owner()
      ? step(1, ready ? 'done' : 'now', 'An AI to talk to', ready ? `<p class="wel-summary">Connected${model ? ': ' + esc(model) : ''}.</p>` : '<p>The owner of this computer connects an AI in Settings → AI accounts. Until then you can read and search.</p>')
      : ready && !changingAi
        ? step(1, 'done', 'Your AI', `<p class="wel-summary">${esc(model || 'Connected')}${d.provider ? ' · ' + esc(AiConnect.nameOf(d.provider)) : ''} <button type="button" class="ghost" data-wel-change>change</button></p>`)
        : step(1, 'now', 'Connect your AI', '<p>Chattering talks to the AI you choose. Use a plan you already have, a key, or a model on your own computer.</p><div data-wel-connect></div>');
    const two = !owner() ? '' : !ready ? step(2, 'later', 'Background helpers', '<p>Next: what may run on its own.</p>')
      : decided ? step(2, 'done', 'Background helpers', `<p class="wel-summary">${helpersSummary()} <button type="button" class="ghost" data-wel-settings>change</button></p>`)
      : step(2, 'now', 'Background helpers', `<p>Two helpers can keep things tidy for you. They send conversation text to ${esc(model || 'your AI')}, which counts against your plan or bill. Nothing runs until you choose.</p>
        <label class="wel-kind"><input type="checkbox" data-wel-kind="names" checked><span><b>Short names</b><small>A short title for each conversation, project and saved document. Small requests.</small></span></label>
        <label class="wel-kind"><input type="checkbox" data-wel-kind="memory"><span><b>Project memory</b><small>After a conversation changes and goes quiet for 10 minutes, the AI re-reads it to keep that project’s notes current. Much more text.</small></span></label>
        <div class="wel-actions"><button type="button" class="primary" data-wel-helpers>Save</button><button type="button" class="ghost" data-wel-helpers-off>Keep both off</button></div>`);
    const canStart = ready && (!owner() || decided);
    const three = step(owner() ? 3 : 2, canStart ? 'now' : 'later', 'Start a conversation', canStart
      ? `<p>Ask anything. The AI can read and write files in the folder you choose, and every conversation stays searchable here.</p>
        <div class="wel-actions"><button type="button" class="primary" data-wel-start>New conversation</button><button type="button" data-wel-project>Work in a folder…</button></div>
        <div class="wel-examples">${EXAMPLES.map(x => `<button type="button" data-wel-example="${esc(x)}">${esc(x)}</button>`).join('')}</div>`
      : '<p>Then: your first conversation.</p>');
    return `<div class="wel" role="region" aria-labelledby="welTitle"><h1 id="welTitle">Welcome to Chattering</h1>
      <p class="wel-lead">Conversations with AI that work on your files, all kept and searchable in one place.</p>${one}${two}${three}</div>`;
  }
  const EXAMPLES = ['Help me plan this week', 'Explain a file I will attach', 'Make a small website in a new folder'];
  function helpersSummary() {
    const b = bg(), on = [b.names && 'short names', b.memory && 'project memory'].filter(Boolean);
    return on.length ? 'On: ' + on.join(', ') + '.' : 'Both off.';
  }

  function wire(root) {
    const connect = root.querySelector('[data-wel-connect]');
    if (connect && window.AiConnect) AiConnect.mount(connect, { compact: true });
    const change = root.querySelector('[data-wel-change]');
    if (change) change.onclick = () => { changingAi = true; sig = ''; W.paint(host); };
    const settings = root.querySelector('[data-wel-settings]');
    if (settings) settings.onclick = () => typeof showSettingsPane === 'function' && showSettingsPane('model');
    const save = async all => {
      const pick = {};
      root.querySelectorAll('[data-wel-kind]').forEach(i => { pick[i.dataset.welKind] = !all && i.checked; });
      root.querySelectorAll('[data-wel-helpers], [data-wel-helpers-off], [data-wel-kind]').forEach(c => { c.disabled = true; });
      const out = await postJson('/api/settings/background-ai', pick);
      if (!out || out.error) { errToast((out && out.error) || 'could not save'); root.querySelectorAll('[data-wel-helpers], [data-wel-helpers-off], [data-wel-kind]').forEach(c => { c.disabled = false; }); return; }
      settingsState = out;
      sig = ''; W.paint(host);
      root.querySelector('[data-wel-start]')?.focus();
    };
    const helpers = root.querySelector('[data-wel-helpers]'); if (helpers) helpers.onclick = () => save(false);
    const off = root.querySelector('[data-wel-helpers-off]'); if (off) off.onclick = () => save(true);
    const start = root.querySelector('[data-wel-start]'); if (start) start.onclick = () => startWith('');
    const project = root.querySelector('[data-wel-project]'); if (project) project.onclick = () => typeof openNewProjectForm === 'function' && openNewProjectForm();
    root.querySelectorAll('[data-wel-example]').forEach(b => b.onclick = () => startWith(b.dataset.welExample));
  }
  // A new conversation, its box focused, with an example already written.
  function startWith(text) {
    if (typeof startNewConversation === 'function') startNewConversation();
    const put = (tries = 0) => {
      const ta = document.getElementById('agentText');
      if (!ta || (typeof isDraftOpen === 'function' && !isDraftOpen())) { if (tries < 40) setTimeout(() => put(tries + 1), 50); return; }
      if (text) { ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.setSelectionRange(text.length, text.length); }
      ta.focus();
    };
    put();
  }
  window.addEventListener('ai-connect-changed', () => { changingAi = false; W.repaint(); });

  // Conversations are here but no AI answers yet: say so once, above them.
  W.banner = function (list) {
    if (!list || !list.parentElement) return;
    const want = owner() && aiKnown() && !aiReady() && !list.querySelector('.wel');
    let el = list.previousElementSibling && list.previousElementSibling.classList.contains('wel-banner') ? list.previousElementSibling : null;
    if (!want) { if (el) el.remove(); banner = null; if (owner() && !aiKnown() && window.AiConnect && !AiConnect.asked) AiConnect.refresh().catch(() => {}); return; }
    if (!el) {
      el = document.createElement('div');
      el.className = 'wel-banner';
      el.innerHTML = '<div><b>Connect your AI</b><div>You can read and search these conversations now. To continue them or start new ones, connect a model.</div></div><button type="button" class="primary">Connect</button>';
      el.querySelector('button').onclick = () => typeof showSettingsPane === 'function' && showSettingsPane('ai');
      list.before(el);
    }
    banner = el;
  };
})();
