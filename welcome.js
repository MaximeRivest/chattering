/* welcome.js — a new person's first minutes (design/73, design/75).
 *
 * The welcome is three steps: connect an AI (ai-connect.js), decide what may
 * run in the background (the first-run question, asked here once a model
 * exists to run it), and start. It takes home's place on an install's first
 * open, whether or not conversations already exist: someone arriving with
 * Pi or Claude Code history is welcomed too, and told it was found. Settings
 * remember when it was done (settings.welcome); Settings → AI accounts, or
 * ?welcome in the address, shows it again. A home that is simply empty is
 * always the welcome. A home with conversations but no AI, after the
 * welcome, gets one line above them: they can be read now, continued once
 * connected.
 */
(function () {
  'use strict';
  const W = window.Welcome = {};
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let host = null, banner = null, sig = '', changingAi = false, history = 0;
  // ?welcome in the address shows it for this visit without changing what is saved.
  let forced = /(?:^|[?&])welcome(?:[=&]|$)/.test(location.search.slice(1));

  // settingsState is the page's (a script-level let, not a window property).
  const settings = () => (typeof settingsState !== 'undefined' ? settingsState : null);
  const owner = () => !!(settings() && settings().canEditSettings);
  const bg = () => (settings() && settings().settings && settings().settings.backgroundAi) || {};
  const aiKnown = () => !!(window.AiConnect && AiConnect.summary);
  const aiReady = () => aiKnown() ? AiConnect.ready() : false;
  const welcomeState = () => (settings() && settings().settings && settings().settings.welcome) || null;
  const done = () => !!(welcomeState() && welcomeState().doneAt);

  // Should home be the welcome although it has conversations? The owner's
  // first open (until done), or asked for. Unknown settings: not yet. A
  // server without the setting (older than design/75) never had it pending.
  W.wanted = () => forced || (owner() && !!welcomeState() && !done());
  // The welcome was done: remembered for the install, and home is home again.
  W.finish = async function finish() {
    forced = false;
    if (owner() && !done()) {
      const out = await postJson('/api/settings/welcome', { done: true });
      if (out && !out.error) settingsState = out;
    }
    if (typeof render === 'function') render();
  };
  // Show it again (Settings → AI accounts).
  W.replay = async function replay() {
    forced = true;
    if (owner()) {
      const out = await postJson('/api/settings/welcome', { done: false });
      if (out && !out.error) settingsState = out;
    }
    sig = '';
    if (typeof goHome === 'function') goHome(); else if (typeof render === 'function') render();
  };

  // The welcome takes home's place. found: how many conversations home has
  // (a repaint without it keeps the last count).
  W.paint = function paint(list, opts = {}) {
    host = list;
    if (Number.isFinite(opts.found)) history = opts.found;
    if (owner() && !aiKnown() && window.AiConnect && !AiConnect.asked) AiConnect.refresh().catch(() => {});
    const d = aiKnown() ? AiConnect.summary.default || {} : {};
    const next = JSON.stringify([owner(), aiKnown(), aiReady(), d.provider, d.model, !!bg().decidedAt, changingAi, history]);
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
    const n = history, many = n === 1 ? 'conversation' : 'conversations';
    const three = n
      ? step(owner() ? 3 : 2, canStart ? 'now' : 'later', 'Your conversations', canStart
        ? `<p>Every one is here: searchable, and you can pick any of them up where it stopped.</p>
          <div class="wel-actions"><button type="button" class="primary" data-wel-home>See my ${esc(many)}</button><button type="button" data-wel-start>New conversation</button></div>`
        : `<p>Then: your ${esc(many)}, ready to pick up.</p>`)
      : step(owner() ? 3 : 2, canStart ? 'now' : 'later', 'Start a conversation', canStart
        ? `<p>Ask anything. The AI can read and write files in the folder you choose, and every conversation stays searchable here.</p>
          <div class="wel-actions"><button type="button" class="primary" data-wel-start>New conversation</button><button type="button" data-wel-project>Work in a folder…</button></div>
          <div class="wel-examples">${EXAMPLES.map(x => `<button type="button" data-wel-example="${esc(x)}">${esc(x)}</button>`).join('')}</div>`
        : '<p>Then: your first conversation.</p>');
    const lead = n
      ? `Chattering found <b>${n.toLocaleString()}</b> ${esc(many)} already on this computer, from Pi and Claude Code. Connect your AI and they are yours to continue, next to new ones.`
      : 'Conversations with AI that work on your files, all kept and searchable in one place.';
    // With conversations to go back to, the welcome can be left at any step.
    const skip = n ? `<p class="wel-skip"><button type="button" class="ghost" data-wel-skip>Skip the welcome</button></p>` : '';
    return `<div class="wel" role="region" aria-labelledby="welTitle"><h1 id="welTitle">Welcome to Chattering</h1>
      <p class="wel-lead">${lead}</p>${one}${two}${three}${skip}</div>`;
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
    const home = root.querySelector('[data-wel-home]'); if (home) home.onclick = () => W.finish();
    const skip = root.querySelector('[data-wel-skip]'); if (skip) skip.onclick = () => W.finish();
    const project = root.querySelector('[data-wel-project]'); if (project) project.onclick = () => { W.finish(); if (typeof openNewProjectForm === 'function') openNewProjectForm(); };
    root.querySelectorAll('[data-wel-example]').forEach(b => b.onclick = () => startWith(b.dataset.welExample));
  }
  // A new conversation, its box focused, with an example already written.
  function startWith(text) {
    W.finish();
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
