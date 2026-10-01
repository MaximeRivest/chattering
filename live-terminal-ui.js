/* Claude Code live, in the conversation (experimental; live-terminal.js).
   The conversation above is Chattering's own view of Claude Code's session
   file. This is the part below it: the real Claude Code's input box,
   suggestions, questions, panels and "working…", from its terminal.

   Typing: on a keyboard, every key goes to Claude Code's own editor (the
   box shows that editor; letters not yet confirmed are faded). On a touch
   screen, an ordinary text box (autocorrect, swipe, voice), brought into
   Claude Code's editor on each pause; Send sends it.
   E-ink (Chattering's binary theme): one update a second, no moving parts.

   One connection per conversation, kept while the page lives: the
   conversation view re-renders often (each message Claude Code writes);
   the strip re-attaches to the same connection and keeps its draft. */
'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const touch = () => matchMedia('(pointer: coarse)').matches;
  const calm = () => document.documentElement.dataset.themeMode === 'binary';
  const deviceName = () => /Android|iPhone|iPad/.test(navigator.userAgent) ? (calm() ? 'e-ink tablet' : 'phone') : calm() ? 'e-ink' : 'laptop';
  const clientId = (() => { let id = sessionStorage.getItem('lt.client'); if (!id) { id = [...crypto.getRandomValues(new Uint32Array(4))].join('-'); sessionStorage.setItem('lt.client', id); } return id; })();
  const sessions = new Map(); // key → S
  const LT = window.LiveTerminal = { enabled: false, sessions };

  // ---- one conversation's live session ----
  function session(key) {
    let S = sessions.get(key);
    if (S) return S;
    S = { key, ws: null, open: false, seq: +(sessionStorage.getItem('lt.seq.' + key) || 0), state: { mode: 'unknown' }, pending: new Map(), replies: new Map(),
      draft: '', draftDirty: false, known: '', sentText: null, sentAt: 0, submitting: false, focused: false, draftTimer: null, retry: 0, ended: false, unknownSince: 0, stats: { latency: [], frames: 0, bytes: 0, errors: [] } };
    sessions.set(key, S);
    return S;
  }
  function send(S, m) {
    if (!S.open) { S.stats.errors.push('not connected'); return null; }
    m.seq = ++S.seq; sessionStorage.setItem('lt.seq.' + S.key, String(S.seq));
    S.ws.send(JSON.stringify(m)); return m.seq;
  }
  const ask = (S, m) => new Promise(resolve => { const s = send(S, m); if (s == null) return resolve({ t: 'error', error: 'not connected' }); S.replies.set(s, resolve); });
  function connect(S) {
    // One connection per conversation: one being opened counts too.
    if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;
    const ws = S.ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/live-terminal/ws?id=' + encodeURIComponent(S.key));
    ws.onopen = () => { S.open = true; S.retry = 0; ws.send(JSON.stringify({ t: 'hello', clientId, name: deviceName(), calm: calm(), lastSeq: S.seq })); paint(S); };
    ws.onclose = () => {
      S.open = false;
      if (S.pending.size) { note(S, S.pending.size + ' key(s) not confirmed — check the box'); S.pending.clear(); }
      for (const r of S.replies.values()) r({ t: 'error', error: 'connection lost' }); S.replies.clear();
      if (S.ended) return paint(S);
      // Reconnect while the program runs; re-send nothing.
      fetch('/api/live-terminal/status?id=' + encodeURIComponent(S.key)).then(r => r.json()).then(st => {
        if (st.running) setTimeout(() => connect(S), Math.min(5000, 300 * ++S.retry)); else { S.ended = true; paint(S); }
      }).catch(() => setTimeout(() => connect(S), Math.min(5000, 300 * ++S.retry)));
      paint(S);
    };
    ws.onmessage = ev => onMessage(S, JSON.parse(ev.data), ev.data.length);
  }
  function onMessage(S, m, size) {
    if (m.t === 'ended') { S.ended = true; paint(S); return; }
    if (m.t === 'patch') {
      S.stats.frames++; S.stats.bytes += size;
      Object.assign(S.state, m.set);
      for (const a of m.acks || []) { const n = +String(a.id).split(':')[1]; const p = S.pending.get(n); if (p) { S.stats.latency.push(performance.now() - p.t0); S.pending.delete(n); } }
      paint(S);
      return;
    }
    const r = S.replies.get(m.seq); if (r) { S.replies.delete(m.seq); r(m); }
    if (m.t === 'refused') { note(S, m.error + ' — wait a moment'); S.pending.delete(m.seq); }
    if (m.t === 'error') { S.stats.errors.push(m.error); note(S, m.error); }
  }
  function note(S, text) { S.note = text; S.noteAt = Date.now(); paint(S); setTimeout(() => paint(S), 4200); }

  // ---- which conversations ----
  // Claude Code: always (its only way to continue here). Pi and Codex have
  // Chattering's own box; their own terminal program is a choice per
  // conversation, remembered in this browser.
  const NAMES = { claude: 'Claude Code', pi: 'Pi', codex: 'Codex' };
  const chosen = key => { try { return localStorage.getItem('lt.on.' + key) === '1'; } catch { return false; } };
  LT.useFor = d => !!(d && !d.draft && (d.source === 'claude' || ((d.source === 'pi' || d.source === 'codex') && chosen(d.key))));
  LT.offerFor = d => !!(LT.enabled && d && !d.draft && (d.source === 'pi' || d.source === 'codex') && !chosen(d.key));
  LT.useHere = key => { try { localStorage.setItem('lt.on.' + key, '1'); } catch {} if (typeof open === 'function') open(key, 'bottom'); };
  LT.leave = async key => {
    // Back to Chattering's own box: the terminal program ends first (one
    // writer per conversation), then the box returns.
    await postJson('/api/live-terminal/stop', { id: key }).catch(() => {});
    const S = sessions.get(key); if (S) { S.ended = true; try { S.ws && S.ws.close(); } catch {} sessions.delete(key); }
    try { localStorage.removeItem('lt.on.' + key); } catch {}
    if (typeof open === 'function') open(key, 'bottom');
  };

  // ---- the dock in the page ----
  LT.dockHtml = d => `<div class="composer-dock lt-dock" id="composerDock" data-conversation-key="${esc(d.key)}" data-live-terminal="1" data-harness="${esc(d.source || 'claude')}">
    <div class="lt-start" id="ltStart" hidden><span id="ltStartText">Continue this conversation here, in ${esc(NAMES[d.source] || 'Claude Code')}'s own program.</span> <button type="button" class="primary" id="ltStartBtn">Continue here</button>${d.source && d.source !== 'claude' ? '<button type="button" class="ghost" id="ltLeave">Use Chattering\'s box</button>' : ''}</div>
    <div class="lt-body" id="ltBody" hidden>
      <div class="lt-note" id="ltNote" hidden></div>
      <div class="lt-status" id="ltStatus" hidden><span class="lt-spin" aria-hidden="true">◌</span><span id="ltStatusText"></span><button type="button" id="ltStop" title="Stop Claude Code (Esc)">Stop</button></div>
      <div class="lt-now" id="ltNow" hidden aria-label="In the terminal now"></div>
      <div class="lt-choice" id="ltChoice" hidden></div>
      <div class="lt-panel" id="ltPanel" hidden></div>
      <div class="lt-keybar" id="ltKeybar" hidden aria-label="Keys">${[['Escape', 'Esc'], ['Tab', 'Tab'], ['Tab', '⇧Tab', 1], ['ArrowLeft', '←'], ['ArrowUp', '↑'], ['ArrowDown', '↓'], ['ArrowRight', '→'], ['Enter', 'Enter']].map(([k, l, sh]) => `<button type="button" data-key="${k}"${sh ? ' data-shift="1"' : ''}>${l}</button>`).join('')}</div>
      <div class="agent-compose lt-compose" id="ltCompose">
        <div class="lt-menu" id="ltMenu" hidden role="listbox" aria-label="Claude Code suggestions"></div>
        <div class="lt-field" id="ltField" tabindex="-1"><span id="ltBefore"></span><span class="lt-caret" id="ltCaret"></span><span id="ltAfter"></span><span class="lt-ph" id="ltPh"></span></div>
        <textarea id="ltKeys" class="lt-keys" aria-label="Message to Claude Code" autocomplete="off" autocapitalize="off" spellcheck="false" rows="1"></textarea>
        <div class="lt-touchrow"><textarea id="ltDraft" class="lt-draft" rows="1" aria-label="Message to Claude Code" placeholder="Message Claude Code"></textarea><button type="button" class="primary lt-send" id="ltSend">Send</button></div>
        <div class="lt-footer" id="ltFooter"></div>
        ${d.source && d.source !== 'claude' ? `<button type="button" class="ghost lt-leave" id="ltLeave2" title="End ${esc(NAMES[d.source])}'s terminal program and use Chattering's own box again">Use Chattering's box</button>` : ''}
      </div>
    </div>
  </div>`;

  let mounted = null; // the S whose dock is on the page
  LT.mount = function () {
    const dock = document.querySelector('[data-live-terminal="1"]');
    if (!dock) { mounted = null; return false; }
    const key = dock.dataset.conversationKey, S = session(key);
    mounted = S;
    dock.classList.toggle('lt-touch', touch()); dock.classList.toggle('lt-eink', calm());
    wire(S);
    if (S.open) { paint(S); if (S.focused && !touch()) $('ltKeys').focus({ preventScroll: true }); return true; }
    fetch('/api/live-terminal/status?id=' + encodeURIComponent(key)).then(r => r.json()).then(st => {
      if (mounted !== S) return;
      S.status = st;
      if (st.running) { S.ended = false; connect(S); }
      paint(S);
    }).catch(() => {});
    paint(S);
    return true;
  };

  function wire(S) {
    $('ltStartBtn').onclick = async () => {
      $('ltStartBtn').disabled = true; $('ltStartBtn').textContent = 'starting…';
      const out = await postJson('/api/live-terminal/start', { id: S.key });
      if (!out || out.error) { $('ltStartBtn').disabled = false; $('ltStartBtn').textContent = 'Continue here'; return errToast((out && out.error) || 'could not start Claude Code'); }
      S.ended = false; S.status = out; connect(S); paint(S);
    };
    $('ltStop').onclick = () => send(S, { t: 'key', key: 'Escape' });
    for (const id of ['ltLeave', 'ltLeave2']) if ($(id)) $(id).onclick = () => LT.leave(S.key);
    $('ltKeybar').querySelectorAll('button').forEach(b => b.onpointerdown = e => { e.preventDefault(); send(S, { t: 'key', key: b.dataset.key, shift: !!b.dataset.shift }); });
    // keyboard: every key to Claude Code's editor
    const keys = $('ltKeys');
    $('ltField').onmousedown = e => { e.preventDefault(); keys.focus({ preventScroll: true }); };
    keys.onfocus = () => { S.focused = true; $('ltCompose').classList.add('focused'); };
    keys.onblur = () => { if (keys.isConnected) S.focused = false; $('ltCompose').classList.remove('focused'); };
    let composing = false;
    const typeText = text => { const t0 = performance.now(); const n = send(S, { t: 'text', text }); if (n != null) S.pending.set(n, { t0, text }); paint(S); };
    keys.addEventListener('compositionstart', () => { composing = true; });
    keys.addEventListener('compositionend', e => { composing = false; if (e.data) typeText(e.data); keys.value = ''; });
    keys.addEventListener('keydown', e => {
      e.stopPropagation(); // the page's shortcuts stay quiet while typing here
      if (composing || e.isComposing || e.key === 'Process' || e.key === 'Unidentified') return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'c') && !e.altKey) return;
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeText(e.key); return; }
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
      e.preventDefault();
      const t0 = performance.now(); const n = send(S, { t: 'key', key: e.key, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey });
      if (n != null) S.pending.set(n, { t0, text: '' });
    });
    keys.addEventListener('input', e => { if (composing) return; if (e.inputType === 'insertText' && e.data) typeText(e.data); else if (e.inputType === 'deleteContentBackward') send(S, { t: 'key', key: 'Backspace' }); keys.value = ''; });
    keys.addEventListener('paste', e => { e.preventDefault(); e.stopPropagation(); const text = e.clipboardData.getData('text/plain'); if (text) send(S, { t: 'paste', text }); });
    // touch: an ordinary box, kept in step with Claude Code's on pauses
    const draft = $('ltDraft');
    draft.value = S.draft;
    draft.addEventListener('keydown', e => e.stopPropagation());
    draft.addEventListener('input', () => {
      S.draft = draft.value; S.draftDirty = true; S.draftAt = performance.now();
      clearTimeout(S.draftTimer);
      const last = draft.value.slice(-1);
      S.draftTimer = setTimeout(() => syncDraft(S), last === '/' || last === '@' ? 60 : 350);
      setTimeout(() => paint(S), 1600);
      paint(S);
    });
    draft.addEventListener('compositionend', () => draft.dispatchEvent(new Event('input')));
    $('ltSend').onclick = () => submit(S);
  }

  async function syncDraft(S) {
    clearTimeout(S.draftTimer); S.draftTimer = null;
    if (S.submitting) return;
    const text = S.draft;
    const r = await ask(S, { t: 'draft', text });
    if (r.t === 'done' && typeof r.text === 'string') S.known = r.text;
    if (S.draft === text) S.draftDirty = false;
    paint(S);
  }
  async function submit(S, textOverride) {
    const text = textOverride != null ? textOverride : S.draft;
    if (!text.trim()) return { t: 'error', error: 'empty' };
    clearTimeout(S.draftTimer);
    // The box empties at once; the message comes back if sending fails.
    if (textOverride == null) { S.draft = ''; S.draftDirty = false; const d = $('ltDraft'); if (d && mounted === S) d.value = ''; }
    S.sentText = text; S.sentAt = performance.now(); S.submitting = true;
    const r = await ask(S, { t: 'submit', text });
    S.submitting = false;
    if (r.t === 'done') { S.known = ''; if (S.draft) syncDraft(S); }
    else if (textOverride == null) { S.draft = text + (S.draft ? '\n' + S.draft : ''); S.draftDirty = true; note(S, (r.error || 'not sent') + ' — your message is back in the box'); }
    paint(S);
    return r;
  }

  // ---- terminal cells, in the theme's own terminal colours ----
  const color = c => {
    if (!c || calm()) return '';
    if (c[0] === 'p') { const n = +c.slice(1); if (n < 16) return `var(--ansi-${n})`; if (n < 232) { const k = n - 16, v = x => [0, 95, 135, 175, 215, 255][x]; return `rgb(${v(Math.floor(k / 36))},${v(Math.floor(k / 6) % 6)},${v(k % 6)})`; } const g = 8 + (n - 232) * 10; return `rgb(${g},${g},${g})`; }
    if (c[0] === 'r') return '#' + (+c.slice(1)).toString(16).padStart(6, '0');
    return '';
  };
  const cells = runs => runs.map(r => {
    const [f, fg, bg] = r.s.split('|'); let st = '';
    if (color(fg)) st += 'color:' + color(fg) + ';'; if (color(bg)) st += 'background:' + color(bg) + ';';
    if (f.includes('d') && !calm()) st += 'opacity:.6;'; if (f.includes('b')) st += 'font-weight:700;'; if (f.includes('i')) st += 'font-style:italic;';
    if (f.includes('v')) st += calm() ? 'text-decoration:underline;' : 'filter:invert(1);';
    return st ? `<span style="${st}">${esc(r.t)}</span>` : esc(r.t);
  }).join('').replace(/\s+$/, '');

  // ---- painting (at most once a frame) ----
  const queued = new Set();
  function paint(S) { if (queued.has(S)) return; queued.add(S); requestAnimationFrame(() => { queued.delete(S); if (mounted === S && document.querySelector('[data-live-terminal="1"]')) render(S); }); }
  function render(S) {
    const st = S.state, running = S.open || (S.status && S.status.running && !S.ended);
    const avail = !S.status || S.status.available !== false;
    $('ltStart').hidden = running;
    const who = NAMES[document.querySelector('[data-live-terminal="1"]').dataset.harness] || 'Claude Code';
    if (!running) $('ltStartText').textContent = !avail ? S.status.why : S.ended ? who + ' has ended for this conversation. Continue it here again?' : 'Continue this conversation here, in ' + who + '\'s own program.';
    $('ltStartBtn').hidden = !avail;
    $('ltBody').hidden = !running;
    if (!running) return;
    const n = $('ltNote'); n.hidden = !(S.note && Date.now() - S.noteAt < 4000); n.textContent = S.note || '';
    if (!S.open) { n.hidden = false; n.textContent = 'Reconnecting… nothing is re-sent'; }
    else if (st.typist && st.typist.clientId !== clientId) { n.hidden = false; n.textContent = st.typist.name + ' is typing'; }
    // working
    $('ltStatus').hidden = !st.status;
    if (st.status) $('ltStatusText').textContent = calm() ? 'Working…' : st.status.text;
    const now = $('ltNow'); now.hidden = !st.now || calm();
    if (st.now && !calm()) now.innerHTML = `<div class="lt-cap">in the terminal now</div><pre>${st.now.map(cells).join('\n')}</pre>`;
    // a question
    const ch = $('ltChoice'); ch.hidden = !st.choice;
    if (st.choice) {
      const k = JSON.stringify([st.choice.question, st.choice.options.map(o => o.label), st.choice.selected]);
      if (ch.dataset.k !== k) {
        ch.dataset.k = k;
        const q = st.choice.question.split('\n').map(l => l.trim()).map(l => /^[╌─━═┄┈-]{8,}$/.test(l) ? '────' : l).join('\n').replace(/\n{3,}/g, '\n\n');
        ch.innerHTML = `<div class="lt-q">${esc(q)}</div><div class="lt-opts">${st.choice.options.map(o => `<button type="button" data-i="${o.index}" aria-current="${o.index === st.choice.selected}">${o.number ? o.number + '. ' : ''}${esc(o.label)}</button>`).join('')}</div>${st.choice.hint ? `<div class="lt-hint">${esc(st.choice.hint.text)} · or tap</div>` : ''}`;
        ch.querySelectorAll('button').forEach(b => b.onclick = async () => { ch.querySelectorAll('button').forEach(x => x.disabled = true); const r = await ask(S, { t: 'choose', index: +b.dataset.i }); if (r.t !== 'done') { ch.querySelectorAll('button').forEach(x => x.disabled = false); ch.dataset.k = ''; } });
      }
    }
    // a panel of its own (/usage, /config…), or anything not understood
    const panel = $('ltPanel'), live = st.live || [];
    panel.hidden = !live.length;
    if (live.length) panel.innerHTML = live.map(l => `<pre>${l.lines.map(cells).join('\n')}</pre>`).join('');
    if (st.mode !== 'unknown') S.unknownSince = 0; else if (!S.unknownSince) { S.unknownSince = performance.now(); setTimeout(() => paint(S), 1600); }
    const stuck = st.mode === 'unknown' && performance.now() - S.unknownSince > 1500;
    $('ltKeybar').hidden = !(st.mode === 'panel' || stuck || (touch() && st.menu));
    // the box
    const c = st.composer, compose = $('ltCompose');
    compose.classList.toggle('off', !c);
    if (touch()) {
      const draft = $('ltDraft');
      if (c && c.text !== S.known && !/\[Pasted text/.test(c.text)) {
        const stale = c.text === S.sentText && performance.now() - S.sentAt < 8000;
        if (!stale && !S.draftDirty && (document.activeElement !== draft || performance.now() - (S.draftAt || 0) > 1500)) { draft.value = c.text; S.draft = c.text; }
        if (!stale) S.known = c.text;
      }
      draft.placeholder = c ? (c.placeholder || 'Message Claude Code') : st.choice ? 'Answer above' : '';
      $('ltSend').disabled = !c;
    } else {
      const typed = [...S.pending.values()].map(p => p.text).join('');
      if (c) {
        const at = c.caret == null ? c.text.length : c.caret;
        $('ltBefore').textContent = c.text.slice(0, at);
        $('ltCaret').innerHTML = typed ? `<span class="lt-pending">${esc(typed)}</span>` : '';
        $('ltAfter').textContent = c.text.slice(at);
        $('ltPh').textContent = !c.text && !typed ? (c.placeholder || '') : '';
      } else { $('ltBefore').textContent = ''; $('ltAfter').textContent = ''; $('ltCaret').innerHTML = ''; $('ltPh').textContent = st.choice ? 'Answer above' : st.mode === 'panel' ? 'Esc closes the panel' : ''; }
    }
    const menu = $('ltMenu'); menu.hidden = !st.menu || (touch() && S.draftDirty);
    if (st.menu && !menu.hidden) {
      menu.innerHTML = st.menu.items.map((it, i) => `<div role="option" data-i="${i}" aria-selected="${it.selected}"><b>${esc(it.label)}</b><span>${esc(it.detail)}</span></div>`).join('');
      menu.querySelectorAll('[data-i]').forEach(d => d.onpointerdown = async e => {
        e.preventDefault(); clearTimeout(S.draftTimer);
        const r = await ask(S, { t: 'menu', index: +d.dataset.i });
        if (touch() && r.t === 'done' && typeof r.text === 'string') { S.draft = r.text; S.known = r.text; S.draftDirty = false; const dr = $('ltDraft'); if (dr) dr.value = r.text; paint(S); }
      });
      menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }
    $('ltFooter').innerHTML = (st.footer || []).map(f => `<span>${esc(f.text)}</span>`).join('');
  }

  // ---- a new conversation, from the draft screen ----
  // Claude Code starts in the folder with a session id chosen by the
  // server; its live part shows in place of the draft's box (it may ask
  // whether to trust the folder); the first message goes once its box is
  // ready; the conversation opens once Claude Code has written it.
  LT.startNew = async function (folder, prompt, onProgress = () => {}) {
    const out = await postJson('/api/live-terminal/new', { folder });
    if (!out || out.error || !out.key) throw new Error((out && out.error) || 'Claude Code did not start');
    const S = session(out.key);
    S.status = { running: true, available: true };
    const dock = $('composerDock');
    if (dock) { dock.outerHTML = LT.dockHtml({ key: out.key }); LT.mount(); }
    connect(S);
    onProgress('waiting for Claude Code…');
    const until = (test, ms) => new Promise((resolve, reject) => { const t0 = Date.now(); const tick = () => { if (test()) return resolve(); if (Date.now() - t0 > ms) return reject(new Error('Claude Code did not get ready')); setTimeout(tick, 100); }; tick(); });
    await until(() => S.open && S.state.composer && !S.state.choice, 10 * 60 * 1000); // the person may be answering its question
    onProgress('sending…');
    const r = await submit(S, prompt);
    if (r.t !== 'done') throw new Error(r.error || 'not sent');
    onProgress('opening the conversation…');
    for (let i = 0; i < 300; i++) {
      const st = await fetch('/api/live-terminal/status?id=' + encodeURIComponent(out.key)).then(x => x.json()).catch(() => ({}));
      if (st.indexed) return out.key;
      await new Promise(res => setTimeout(res, 200));
    }
    return out.key;
  };

  LT.init = async () => {
    try { const st = await (await fetch('/api/live-terminal/status')).json(); LT.enabled = !!st.enabled && st.available !== false; } catch {}
    return LT.enabled;
  };
  // Re-render on theme changes (e-ink) and pointer changes.
  matchMedia('(pointer: coarse)').addEventListener?.('change', () => mounted && LT.mount());
})();
