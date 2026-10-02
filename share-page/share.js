/* The page a shared link opens (design/92). It runs on the preview address,
   never on Chattering's own, and can reach exactly one thing: the share in
   its address. The secret after '#' never leaves this browser except once,
   to the computer sharing the document, to open it.

   One document, live: the text everybody edits is a Yjs document held by the
   sharer's computer (collab.js), the same one their own editor and agents
   use. A viewer gets the same live text, read-only. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const m = /^\/s\/([a-z2-7]{16})\/$/.exec(location.pathname);
  const shareId = m ? m[1] : '';
  const base = '/s/' + shareId;
  const NAME_KEY = 'chattering.share.name';
  let info = null, session = null, editor = null, attempt = 0, retryTimer = 0, ended = false;

  function card(html) {
    $('doc').hidden = true;
    $('card').hidden = false;
    $('card').innerHTML = html;
  }
  function setState(text, tone = '') {
    const el = $('state');
    el.textContent = text;
    if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
  }
  function stop(title, text) {
    ended = true;
    clearTimeout(retryTimer);
    closeSession();
    if (editor) { try { editor.destroy && editor.destroy(); } catch {} editor = null; }
    $('head').hidden = true;
    card(`<h1>${esc(title)}</h1><p>${esc(text)}</p>`);
  }

  async function open() {
    const secret = location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : '';
    let r, body;
    try {
      r = await fetch(base + '/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(secret ? { secret } : {}), credentials: 'same-origin', cache: 'no-store' });
      body = await r.json().catch(() => ({}));
    } catch {
      return { offline: true };
    }
    if (!r.ok) return { error: body.error || 'This link does not open anything.', status: r.status };
    return { info: body };
  }

  async function start() {
    if (!shareId) return stop('Not a shared link', 'This address is not a shared document.');
    const got = await open();
    if (got.offline) {
      card(`<h1>The computer sharing this is not reachable</h1><p>Shared documents live on the sharer's own computer. When it is online again, this page opens by itself.</p>`);
      retryTimer = setTimeout(start, 8000);
      return;
    }
    if (got.error) return stop(got.status === 429 ? 'Please wait' : 'This link does not open', got.error);
    info = got.info;
    document.title = info.title + ' · shared by ' + info.owner.name;
    const name = localStorage.getItem(NAME_KEY);
    if (name) return begin(name);
    askName();
  }

  function askName() {
    const verb = info.role === 'edit' ? 'can edit' : 'can view';
    card(`<h1>${esc(info.owner.name)} shared “${esc(info.title)}” with you</h1>
      <p>You ${verb} it, live, with everyone who has the link.</p>
      <form id="nameForm"><label for="nameInput">Your name, shown to the others here</label>
      <input id="nameInput" maxlength="40" autocomplete="name" placeholder="Your name">
      <div class="sh-row"><button type="button" class="sh-btn" id="skipName">Stay anonymous</button><button class="sh-btn primary" type="submit">Open</button></div></form>`);
    $('nameInput').focus();
    $('nameForm').addEventListener('submit', e => {
      e.preventDefault();
      const n = $('nameInput').value.trim().slice(0, 40);
      if (n) localStorage.setItem(NAME_KEY, n);
      begin(n || 'Someone');
    });
    $('skipName').addEventListener('click', () => begin('Someone'));
  }

  function loadBundle() {
    if (window.mrmdDocument) return Promise.resolve(window.mrmdDocument);
    return new Promise((ok, bad) => {
      const s = document.createElement('script');
      s.src = '/_c/share/mrmd.js';
      s.onload = () => window.mrmdDocument ? ok(window.mrmdDocument) : bad(new Error('the editor did not load'));
      s.onerror = () => bad(new Error('the editor did not load'));
      document.head.appendChild(s);
    });
  }

  let myName = 'Someone';
  async function begin(name) {
    myName = name;
    card('<p class="sh-wait">Opening…</p>');
    $('head').hidden = false;
    $('title').textContent = info.title;
    $('sub').textContent = 'Shared by ' + info.owner.name + ' · you ' + (info.role === 'edit' ? 'can edit' : 'can view') + (info.expiresAt ? ' · until ' + new Date(info.expiresAt).toLocaleDateString() : '');
    let bundle;
    try { bundle = await loadBundle(); } catch (e) { return stop('Could not open the document', e.message); }
    connect(bundle);
  }

  function closeSession() {
    if (!session) return;
    const s = session; session = null;
    try { s.provider.destroy(); } catch {}
    try { s.ydoc.destroy(); } catch {}
  }

  // One connection to the shared text. When it drops, the whole session is
  // rebuilt on the next one rather than resumed: the sharer's computer may
  // have restarted with a fresh copy of the file, and merging an old copy
  // into it would repeat the text. While it is down, typing is paused.
  function connect(bundle) {
    if (ended) return;
    closeSession();
    const collab = bundle.collab;
    const ydoc = new collab.Y.Doc();
    const wsBase = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + base;
    const provider = new collab.WebsocketProvider(wsBase, 'collab', ydoc, { connect: false, disableBc: true, params: { name: myName }, maxBackoffTime: 8000 });
    const s = { ydoc, provider, ytext: ydoc.getText('content'), synced: false };
    session = s;
    provider.awareness.setLocalStateField('user', { name: myName, color: '#888888', colorLight: '#88888855' });
    provider.on('sync', ok => {
      if (!ok || s.synced || session !== s) return;
      s.synced = true; attempt = 0;
      mount(bundle, s);
      setState('Live', 'live');
    });
    provider.on('connection-close', ev => {
      if (session !== s) return;
      const code = ev && ev.code;
      provider.shouldConnect = false;
      if (editor) { try { editor.setReadonly(true); } catch {} }
      closeSession();
      if (code === 4403 || code === 1008) return recheck(bundle, code);
      attempt++;
      setState(attempt > 1 ? info.owner.name + '’s computer is not reachable · trying again' : 'Reconnecting…', attempt > 1 ? 'warn' : '');
      retryTimer = setTimeout(() => connect(bundle), Math.min(10000, 600 * attempt));
    });
    provider.awareness.on('change', () => { if (session === s) drawPeople(s); });
    provider.connect();
  }

  // The computer closed the connection on purpose: the link changed. Ask
  // again; a changed role (edit ↔ view) reopens, an ended link stops.
  async function recheck(bundle, code) {
    if (code === 1008) setState('Paused: too much at once', 'warn');
    const got = await open();
    if (got.offline) { setState(info.owner.name + '’s computer is not reachable · trying again', 'warn'); retryTimer = setTimeout(() => recheck(bundle, 0), 8000); return; }
    if (got.error) return stop('This link has ended', got.error);
    info = got.info;
    $('sub').textContent = 'Shared by ' + info.owner.name + ' · you ' + (info.role === 'edit' ? 'can edit' : 'can view');
    retryTimer = setTimeout(() => connect(bundle), code === 1008 ? 5000 : 200);
  }

  function mount(bundle, s) {
    const host = $('doc');
    const scroll = window.scrollY;
    if (editor) { try { editor.destroy && editor.destroy(); } catch {} editor = null; }
    host.innerHTML = '<div id="editor"></div>';
    $('card').hidden = true;
    host.hidden = false;
    editor = bundle.createDocumentEditor($('editor'), {
      doc: s.ytext.toString(),
      extensions: [bundle.collab.yCollab(s.ytext, s.provider.awareness)],
      filename: info.fileName,
      theme: theme(),
      placeholder: info.role === 'edit' ? 'Start writing…' : '',
      lineGutter: false,
      assetResolver: url => /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') ? url : base + '/asset?src=' + encodeURIComponent(url),
    });
    if (info.role !== 'edit') { try { editor.setReadonly(true); } catch {} }
    window.scrollTo(0, scroll);
    if (info.role === 'edit') { try { editor.focus(); } catch {} }
  }

  function drawPeople(s) {
    const mine = s.provider.awareness.clientID;
    const seen = new Set(), rows = [];
    for (const [id, st] of s.provider.awareness.getStates()) {
      if (id === mine || !st || !st.user) continue;
      const key = st.user.id || id;
      if (seen.has(key)) continue;
      seen.add(key); rows.push(st.user);
    }
    $('people').innerHTML = rows.slice(0, 8).map(u => `<span class="sh-bubble" style="--who:${/^#[0-9a-f]{6}$/i.test(u.color || '') ? u.color : '#888'}" title="${esc(u.name || 'someone')}">${esc((u.glyph || u.name || '?').slice(0, 1))}</span>`).join('') + (rows.length > 8 ? `<small>+${rows.length - 8}</small>` : '');
  }

  // The editor's look, from the design tokens (the same mapping Chattering's
  // own editor uses, without its e-ink and per-device parts).
  function theme() {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    return {
      name: 'chattering-share', isDark: dark,
      '--editor-background': 'var(--bg)', '--editor-foreground': 'var(--text)', '--editor-cursor': 'var(--accent)',
      '--editor-selection': 'color-mix(in srgb, var(--accent) 30%, var(--bg))', '--editor-selection-match': 'color-mix(in srgb, var(--accent) 18%, var(--bg))',
      '--editor-active-line': 'transparent', '--editor-gutter': 'var(--bg)', '--editor-line-number': 'var(--text-faint)',
      '--editor-font-family': 'var(--font)', '--editor-font-size': '16px', '--editor-line-height': '1.65',
      '--widget-font-mono': 'var(--font-mono)', '--widget-font-sans': 'var(--font)', '--widget-surface': 'var(--surface-1)', '--widget-surface-hover': 'var(--surface-2)',
      '--widget-border': 'var(--border)', '--widget-text': 'var(--text)', '--widget-text-muted': 'var(--text-dim)', '--widget-text-accent': 'var(--accent)',
      '--syntax-keyword': 'var(--accent)', '--syntax-string': 'var(--cyan)', '--syntax-number': 'var(--magenta)', '--syntax-comment': 'var(--text-faint)',
      '--syntax-function': 'var(--blue)', '--syntax-variable': 'var(--text)', '--syntax-type': 'var(--yellow)', '--syntax-heading': 'var(--text)',
      '--syntax-link': 'var(--cyan)', '--syntax-quote': 'var(--text-dim)', '--syntax-code': 'var(--text-dim)', '--syntax-code-background': 'var(--surface-2)',
      '--md-heading-weight': '700', '--md-heading-color': 'var(--text)', '--md-marker-color': 'var(--text-faint)', '--md-link-color': 'var(--cyan)',
      '--md-code-color': 'var(--text-dim)', '--md-blockquote-border': 'var(--border-strong)', '--md-blockquote-color': 'var(--text-dim)',
      '--md-list-marker-color': 'var(--text-faint)', '--md-hr-color': 'var(--border)', '--md-table-border': 'var(--border)',
      '--md-table-header-bg': 'var(--surface-1)', '--md-checkbox-color': 'var(--accent)',
      '--mrmd-bg': 'var(--bg)', '--mrmd-fg': 'var(--text)', '--mrmd-fg-muted': 'var(--text-dim)', '--mrmd-border': 'var(--border)',
      '--mrmd-accent': 'var(--accent)', '--mrmd-panel-bg': 'var(--surface-2)', '--mrmd-popup-bg': 'var(--surface-2)',
      '--mrmd-selection-overlay': 'color-mix(in srgb, var(--accent) 32%, transparent)',
    };
  }

  // Links inside the document leave this page in a new tab, without telling
  // the other site where they came from.
  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.closest('.sh-foot')) return;
    const href = a.getAttribute('href') || '';
    if (/^https?:\/\//i.test(href)) { e.preventDefault(); window.open(href, '_blank', 'noopener,noreferrer'); }
  }, true);
  window.addEventListener('hashchange', () => { if (!ended) location.reload(); });
  start();
})();
