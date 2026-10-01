/* A conversation continued in its agent's own program (design/91;
   harness/live-terminal.js). The conversation above is Chattering's own view
   of the agent's session file. This is the part below it: the real
   program's input box, suggestions, questions, panels and "working…", from
   its terminal, for Claude Code, Pi or Codex alike (the names come from the
   server; nothing here knows an agent).

   Typing. On a keyboard every key goes to the program's own editor: the box
   shows that editor, letters not yet confirmed are faded. The focused field
   is a real text box holding the program's text and caret, so screen
   readers read what is there; it is never edited here, only by the
   program. On a touch screen: an ordinary text box (autocorrect, swipe,
   voice), brought into the program's editor on each pause; Send sends it.
   Input methods (composition) are let finish before the text is sent.

   When the program has ended (idle, or never started here), the box is an
   ordinary one: Send starts it again from the conversation's file and the
   message goes in; focusing it starts it already.

   E-ink (Chattering's binary theme): one update a second, no moving parts,
   and that follows the theme while the page is open.

   One connection per conversation, kept while the page lives: the
   conversation view re-renders often; the strip re-attaches to the same
   connection and keeps its draft. */
'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const touch = () => matchMedia('(pointer: coarse)').matches;
  const calm = () => document.documentElement.dataset.themeMode === 'binary';
  const deviceName = () => /Android|iPhone|iPad/.test(navigator.userAgent) ? (calm() ? 'e-ink tablet' : 'phone') : calm() ? 'e-ink' : 'laptop';
  const clientId = (() => { let id = sessionStorage.getItem('lt.client'); if (!id) { id = [...crypto.getRandomValues(new Uint32Array(4))].join('-'); sessionStorage.setItem('lt.client', id); } return id; })();
  const sessions = new Map(); // key → S
  const LT = window.LiveTerminal = { enabled: true, sessions, conf: null };

  // ---- one conversation's live session ----
  function session(key) {
    let S = sessions.get(key);
    if (S) return S;
    S = { key, ws: null, open: false, seq: +(sessionStorage.getItem('lt.seq.' + key) || 0), state: { mode: 'unknown' }, pending: new Map(), replies: new Map(),
      draft: '', draftDirty: false, known: '', sentText: null, sentAt: 0, submitting: false, focused: false, draftTimer: null, retry: 0, ended: false, running: false,
      starting: false, unknownSince: 0, said: '', stats: { latency: [], frames: 0, bytes: 0, errors: [] } };
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
    ws.onopen = () => { S.open = true; S.retry = 0; S.ended = false; S.running = true; ws.send(JSON.stringify({ t: 'hello', clientId, name: deviceName(), calm: calm(), lastSeq: S.seq })); paint(S); };
    ws.onclose = () => {
      S.open = false;
      if (S.pending.size) { note(S, S.pending.size + ' key(s) not confirmed — check the box'); S.pending.clear(); }
      for (const r of S.replies.values()) r({ t: 'error', error: 'connection lost' }); S.replies.clear();
      if (S.ended) return paint(S);
      // Reconnect while the program runs; re-send nothing.
      statusOf(S.key).then(st => {
        if (st.running) setTimeout(() => connect(S), Math.min(5000, 300 * ++S.retry)); else { S.ended = true; S.running = false; paint(S); }
      }).catch(() => setTimeout(() => connect(S), Math.min(5000, 300 * ++S.retry)));
      paint(S);
    };
    ws.onmessage = ev => onMessage(S, JSON.parse(ev.data), ev.data.length);
  }
  const statusOf = key => fetch('/api/live-terminal/status?id=' + encodeURIComponent(key)).then(r => r.json());
  function onMessage(S, m, size) {
    if (m.t === 'ended') { S.ended = true; S.running = false; paint(S); return; }
    if (m.t === 'patch') {
      S.stats.frames++; S.stats.bytes += size;
      Object.assign(S.state, m.set);
      if (S.state.exited) { S.ended = true; S.running = false; }
      // Text typed in the plain box before the program ran goes into its own
      // box once it is ready (a keyboard then types there directly).
      if (!touch() && S.draft && !S.submitting && !S.carrying && S.state.composer && !S.state.choice && !S.state.status) {
        S.carrying = true;
        const text = S.draft, focused = document.activeElement === $('ltDraft');
        ask(S, { t: 'draft', text }).then(r => {
          S.carrying = false;
          if (r.t !== 'done' || S.draft !== text) return;
          S.draft = ''; S.draftDirty = false; const d = $('ltDraft'); if (d && mounted === S) d.value = '';
          if (focused && mounted === S) $('ltKeys').focus({ preventScroll: true });
          paint(S);
        });
      }
      for (const a of m.acks || []) { const n = +String(a.id).split(':')[1]; const p = S.pending.get(n); if (p) { S.stats.latency.push(performance.now() - p.t0); S.pending.delete(n); } }
      paint(S);
      return;
    }
    const r = S.replies.get(m.seq); if (r) { S.replies.delete(m.seq); r(m); }
    if (m.t === 'refused') { note(S, m.error + ' — wait a moment'); S.pending.delete(m.seq); }
    if (m.t === 'error') { S.stats.errors.push(m.error); note(S, m.error); }
  }
  function note(S, text) { S.note = text; S.noteAt = Date.now(); paint(S); setTimeout(() => paint(S), 4200); }

  // ---- which conversations: the server says (the same on every device) ----
  LT.useFor = d => !!(d && !d.draft && d.liveTerminal && d.liveTerminal.use);
  LT.offerFor = d => !!(d && !d.draft && d.liveTerminal && d.liveTerminal.offer);
  LT.useHere = async (key, btn) => {
    if (btn) { btn.disabled = true; btn.textContent = 'starting…'; }
    const out = await postJson('/api/live-terminal/start', { id: key }).catch(e => ({ error: e.message }));
    if (!out || out.error) { if (btn) btn.disabled = false; return errToast((out && out.error) || 'could not start it'); }
    const S = session(key); S.ended = false; S.running = true;
    if (typeof open === 'function') open(key, 'bottom');
  };
  LT.leave = async key => {
    // Back to Chattering's own box: the program ends first (one writer per
    // conversation); text left in its box is kept for next time.
    const out = await postJson('/api/live-terminal/stop', { id: key, back: true }).catch(e => ({ error: e.message }));
    if (out && out.error) return errToast(out.error);
    const S = sessions.get(key); if (S) { S.ended = true; try { S.ws && S.ws.close(); } catch {} sessions.delete(key); }
    if (typeof open === 'function') open(key, 'bottom');
  };
  // Events from the server: a program started, ended, works or waits,
  // here or on another device; a new conversation found its file.
  LT.onEvent = ev => {
    if (ev.from && newWaiters.has(ev.from)) newWaiters.get(ev.from)(ev.key);
    if (ev.from && sessions.has(ev.from) && !sessions.has(ev.key)) { const S = sessions.get(ev.from); sessions.delete(ev.from); S.key = ev.key; sessions.set(ev.key, S); }
    const S = sessions.get(ev.key);
    const ended = ev.state && ev.state.mode === 'ended';
    if (S) {
      if (ended) { S.ended = true; S.running = false; } else if (!S.open && !S.starting) { S.ended = false; S.running = true; connect(S); }
      paint(S);
    }
    // Started on another device while this one shows Chattering's box.
    if (!ended && typeof activeRel !== 'undefined' && activeRel === ev.key && typeof current !== 'undefined' && current && !document.querySelector('[data-live-terminal="1"]') && current.liveTerminal && !current.liveTerminal.running) {
      if (typeof open === 'function') open(ev.key, 'preserve');
    }
  };

  // ---- the dock in the page ----
  const KEYS = [['Escape', 'Esc', 'Escape'], ['Tab', 'Tab', 'Tab'], ['Tab', '⇧Tab', 'Shift Tab', 1], ['ArrowLeft', '←', 'Left arrow'], ['ArrowUp', '↑', 'Up arrow'], ['ArrowDown', '↓', 'Down arrow'], ['ArrowRight', '→', 'Right arrow'], ['Enter', 'Enter', 'Enter']];
  LT.dockHtml = d => {
    const lt = d.liveTerminal || { name: 'the agent', harness: d.source, canLeave: false };
    const name = esc(lt.name);
    return `<div class="composer-dock lt-dock" id="composerDock" data-conversation-key="${esc(d.key)}" data-live-terminal="1" data-harness="${esc(lt.harness || '')}" data-name="${name}">
    <div class="lt-sr" id="ltSay" aria-live="polite" role="status"></div>
    <div class="lt-note" id="ltNote" hidden role="status"></div>
    <div class="lt-body" id="ltBody">
      <div class="lt-status" id="ltStatus" hidden><span class="lt-spin" aria-hidden="true">◌</span><span id="ltStatusText"></span><button type="button" id="ltStop" title="Stop ${name}'s reply (Esc)">Stop</button></div>
      <div class="lt-now" id="ltNow" hidden aria-label="In the terminal now"></div>
      <div class="lt-choice" id="ltChoice" hidden role="group"></div>
      <div class="lt-panel" id="ltPanel" hidden role="region" aria-label="${name}'s panel"></div>
      <div class="lt-keybar" id="ltKeybar" hidden role="toolbar" aria-label="Keys for ${name}">${KEYS.map(([k, l, label, sh]) => `<button type="button" data-key="${k}"${sh ? ' data-shift="1"' : ''} aria-label="${label}">${l}</button>`).join('')}</div>
      <div class="agent-compose lt-compose" id="ltCompose">
        <div class="lt-menu" id="ltMenu" hidden role="listbox" aria-label="${name}'s suggestions"></div>
        <div class="lt-field" id="ltField" aria-hidden="true"><span id="ltBefore"></span><span class="lt-caret" id="ltCaret"></span><span id="ltAfter"></span><span class="lt-ph" id="ltPh"></span></div>
        <textarea id="ltKeys" class="lt-keys" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="ltMenu" aria-label="Message to ${name}, typed into its own box" autocomplete="off" autocapitalize="off" spellcheck="false" rows="1"></textarea>
        <div class="lt-touchrow"><textarea id="ltDraft" class="lt-draft" rows="1" aria-label="Message to ${name}" placeholder="Message ${name}"></textarea><button type="button" class="primary lt-send" id="ltSend">Send</button></div>
        <div class="lt-footer" id="ltFooter"></div>
        <div class="lt-meta"><span class="lt-who" id="ltWho">${name}'s own program</span>${lt.canLeave ? `<button type="button" class="ghost lt-leave" id="ltLeave" title="End ${name}'s program and use Chattering's own box again">Use Chattering's box</button>` : ''}</div>
      </div>
    </div>
  </div>`;
  };

  let mounted = null; // the S whose dock is on the page
  LT.mount = function () {
    const dock = document.querySelector('[data-live-terminal="1"]');
    if (!dock) { mounted = null; return false; }
    const key = dock.dataset.conversationKey, S = session(key);
    S.name = dock.dataset.name || 'the agent';
    mounted = S;
    const live = typeof current !== 'undefined' && current && current.key === key ? current.liveTerminal : null;
    if (live) { S.running = live.running || S.open; if (!live.running && !S.open) S.ended = true; if (live.notice) S.state.notice = live.notice; }
    dock.classList.toggle('lt-touch', touch()); dock.classList.toggle('lt-eink', calm());
    wire(S);
    // The page was redrawn while typing here: the focus comes back where it was.
    const usesDraft = touch() || !S.open || S.ended;
    if (usesDraft && S.draftFocused) {
      const d = $('ltDraft'); d.focus({ preventScroll: true });
      if (S.draftSel) try { d.setSelectionRange(S.draftSel[0], S.draftSel[1]); } catch {}
    }
    if (S.open) { paint(S); if (S.focused && !usesDraft) $('ltKeys').focus({ preventScroll: true }); return true; }
    if (S.running) connect(S);
    paint(S);
    return true;
  };

  // The program, started for this conversation (from its file).
  async function ensureStarted(S) {
    if (S.open || S.starting) return;
    S.starting = true; paint(S);
    const out = await postJson('/api/live-terminal/start', { id: S.key }).catch(e => ({ error: e.message }));
    S.starting = false;
    if (!out || out.error) { note(S, (out && out.error) || 'it did not start'); return; }
    S.ended = false; S.running = true; connect(S); paint(S);
  }

  function wire(S) {
    $('ltStop').onclick = () => send(S, { t: 'stop' });
    if ($('ltLeave')) $('ltLeave').onclick = () => LT.leave(S.key);
    $('ltKeybar').querySelectorAll('button').forEach(b => b.onclick = e => { e.preventDefault(); send(S, { t: 'key', key: b.dataset.key, shift: !!b.dataset.shift }); });
    // A keyboard: every key to the program's editor.
    const keys = $('ltKeys');
    $('ltField').onmousedown = e => { e.preventDefault(); keys.focus({ preventScroll: true }); };
    keys.onfocus = () => { S.focused = true; $('ltCompose').classList.add('focused'); };
    // The page redraws the conversation (the agent wrote to its file): this
    // field is replaced, and the browser reports a blur while it is still on
    // the page. Decided a moment later: replaced, the new field already took
    // the focus back (mount, in the same redraw); left, it is not on the page
    // any more or another element has the focus. Typing never lands on the
    // page's shortcuts because a message arrived.
    keys.onblur = () => {
      const c = $('ltCompose'); if (c) c.classList.remove('focused');
      setTimeout(() => { if (keys.isConnected && document.activeElement !== keys) S.focused = false; }, 0);
    };
    // While an input method composes, the field is the person's: nothing
    // (no update from the program, no mirror) touches it until it ends.
    let composing = false;
    const typeText = text => { const t0 = performance.now(); const n = send(S, { t: 'text', text }); if (n != null) S.pending.set(n, { t0, text }); paint(S); };
    keys.addEventListener('compositionstart', () => { composing = true; S.composing = true; });
    // An input method finished a word: that text goes to the program; the
    // field then shows the program's text again.
    keys.addEventListener('compositionend', e => { composing = false; S.composing = false; if (e.data) typeText(e.data); mirror(S, true); });
    keys.addEventListener('keydown', e => {
      e.stopPropagation(); // the page's shortcuts stay quiet while typing here
      if (composing || e.isComposing || e.key === 'Process' || e.key === 'Unidentified') return;
      if ((e.ctrlKey || e.metaKey) && ['v', 'c', 'x', 'a'].includes(e.key.toLowerCase()) && !e.altKey) { if (e.key.toLowerCase() !== 'v') e.preventDefault(); return; }
      if (e.key === 'Tab' && !S.state.menu && !S.state.choice && S.state.mode === 'compose' && !(S.state.composer && S.state.composer.text)) return; // leave the box with Tab when it is empty
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeText(e.key); return; }
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
      e.preventDefault();
      const t0 = performance.now(); const n = send(S, { t: 'key', key: e.key, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey });
      if (n != null) S.pending.set(n, { t0, text: '' });
    });
    // Anything that edited the field anyway (a dictation, an autofill): its
    // text goes as typed text; the field shows the program's again.
    keys.addEventListener('input', e => { if (composing) return; if (e.inputType === 'insertText' && e.data) typeText(e.data); else if (e.inputType === 'deleteContentBackward') send(S, { t: 'key', key: 'Backspace' }); mirror(S, true); });
    keys.addEventListener('paste', e => { e.preventDefault(); e.stopPropagation(); const text = e.clipboardData.getData('text/plain'); if (text) send(S, { t: 'paste', text }); });
    // A touch keyboard, or a program that has ended: an ordinary box.
    const draft = $('ltDraft');
    draft.value = S.draft;
    draft.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(S); }
    });
    draft.addEventListener('focus', () => { S.draftFocused = true; if (S.ended || !S.running) ensureStarted(S); });
    // Kept through a redraw of the page like the keyboard field (a phone's
    // keyboard stays open, the caret where it was).
    draft.addEventListener('blur', () => {
      S.draftSel = [draft.selectionStart, draft.selectionEnd];
      setTimeout(() => { if (draft.isConnected && document.activeElement !== draft) S.draftFocused = false; }, 0);
    });
    draft.addEventListener('select', () => { S.draftSel = [draft.selectionStart, draft.selectionEnd]; });
    draft.addEventListener('input', () => {
      S.draft = draft.value; S.draftDirty = true; S.draftAt = performance.now();
      clearTimeout(S.draftTimer);
      if (!S.open) return paint(S);
      const last = draft.value.slice(-1);
      S.draftTimer = setTimeout(() => syncDraft(S), last === '/' || last === '@' ? 60 : 350);
      setTimeout(() => paint(S), 1600);
      paint(S);
    });
    draft.addEventListener('compositionend', () => draft.dispatchEvent(new Event('input')));
    $('ltSend').onclick = () => submit(S);
    // E-ink follows the theme while the page is open.
    if (!LT.themeWatch) {
      LT.themeWatch = new MutationObserver(() => {
        for (const x of sessions.values()) if (x.open) x.ws.send(JSON.stringify({ t: 'view', calm: calm() }));
        const dock = document.querySelector('[data-live-terminal="1"]'); if (dock) dock.classList.toggle('lt-eink', calm());
        if (mounted) paint(mounted);
      });
      LT.themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-mode'] });
    }
  }

  async function syncDraft(S) {
    clearTimeout(S.draftTimer); S.draftTimer = null;
    if (S.submitting || !S.open) return;
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
    let r;
    if (!S.open) {
      // Ended: the server starts it again and sends the message.
      paint(S);
      const out = await postJson('/api/live-terminal/send', { id: S.key, text }).catch(e => ({ error: e.message }));
      r = out && !out.error ? { t: 'done' } : { t: 'error', error: (out && out.error) || 'not sent' };
      if (out && out.question) r = { t: 'error', error: S.name + ' asks something first: answer it, then send again' };
      S.ended = false; S.running = true; connect(S);
    } else r = await ask(S, { t: 'submit', text });
    S.submitting = false;
    if (r.t === 'done') { S.known = ''; if (S.draft) syncDraft(S); }
    else if (textOverride == null) { S.draft = text + (S.draft ? '\n' + S.draft : ''); S.draftDirty = true; const d = $('ltDraft'); if (d && mounted === S) d.value = S.draft; note(S, (r.error || 'not sent') + ' — your message is back in the box'); }
    paint(S);
    return r;
  }

  // The focused field holds the program's text and caret (screen readers
  // read it); `force` after the browser itself changed it.
  function mirror(S, force = false) {
    const keys = $('ltKeys'), c = S.state.composer;
    if (!keys || touch() || S.composing) return;
    const text = c ? c.text : '';
    if (force || keys.value !== text) {
      keys.value = text;
      const at = c && c.caret != null ? c.caret : text.length;
      if (document.activeElement === keys) try { keys.setSelectionRange(at, at); } catch {}
    }
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
  const plainText = lines => lines.map(runs => runs.map(r => r.t).join('').replace(/\s+$/, '')).join('\n');

  // What a screen reader hears: the program's state when it changes, never
  // a spinner's tick.
  function say(S, text) { if (S.said === text) return; S.said = text; const el = $('ltSay'); if (el) { el.textContent = ''; setTimeout(() => { if (S.said === text) el.textContent = text; }, 50); } }

  // ---- painting (at most once a frame) ----
  const queued = new Set();
  function paint(S) { if (queued.has(S)) return; queued.add(S); requestAnimationFrame(() => { queued.delete(S); if (mounted === S && document.querySelector('[data-live-terminal="1"]')) render(S); }); }
  function render(S) {
    const st = S.state, name = S.name;
    const live = S.open && !S.ended;
    const dock = document.querySelector('[data-live-terminal="1"]');
    dock.classList.toggle('lt-ended', !live);
    // Notes: ours for a few seconds, the server's while they hold.
    const n = $('ltNote');
    let noteText = S.note && Date.now() - S.noteAt < 4000 ? S.note : '';
    if (!noteText && S.starting) noteText = 'starting ' + name + '…';
    else if (!noteText && S.running && !S.open && !S.ended) noteText = 'Reconnecting… nothing is re-sent';
    else if (!noteText && live && st.typist && st.typist.clientId !== clientId) noteText = st.typist.name + ' is typing';
    if (!noteText && st.notice) noteText = st.notice;
    n.hidden = !noteText; n.textContent = noteText; n.classList.toggle('lt-warn', !!st.notice && noteText === st.notice);
    // Ended or not started: an ordinary box; the program starts on focus or Send.
    if (!live) {
      for (const id of ['ltStatus', 'ltNow', 'ltChoice', 'ltPanel', 'ltKeybar', 'ltMenu']) $(id).hidden = true;
      $('ltCompose').classList.remove('off');
      const draft = $('ltDraft');
      draft.placeholder = S.ended ? `Message ${name} — it starts again from this conversation` : `Message ${name}`;
      $('ltSend').disabled = S.submitting;
      $('ltFooter').textContent = '';
      say(S, S.ended ? name + ' is not running. Your next message starts it again.' : '');
      return;
    }
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
        ch.setAttribute('aria-label', q.split('\n').find(l => l.trim()) || 'A question');
        ch.innerHTML = `<div class="lt-q">${esc(q)}</div><div class="lt-opts">${st.choice.options.map(o => `<button type="button" data-i="${o.index}" aria-current="${o.index === st.choice.selected}">${o.number ? o.number + '. ' : ''}<b>${esc(o.label)}</b>${o.detail ? `<span class="lt-detail">${esc(o.detail)}</span>` : ''}</button>`).join('')}</div>${st.choice.hint ? `<div class="lt-hint">${esc(st.choice.hint.text)} · or tap</div>` : ''}`;
        ch.querySelectorAll('button').forEach(b => b.onclick = async () => { ch.querySelectorAll('button').forEach(x => x.disabled = true); const r = await ask(S, { t: 'choose', index: +b.dataset.i }); if (r.t !== 'done') { ch.querySelectorAll('button').forEach(x => x.disabled = false); ch.dataset.k = ''; note(S, r.error || 'not answered'); } });
      }
    }
    // a panel of its own (/usage, /config…), or anything not understood
    const panel = $('ltPanel'), blocks = st.live || [];
    panel.hidden = !blocks.length;
    if (blocks.length) panel.innerHTML = blocks.map(l => `<pre>${l.lines.map(cells).join('\n')}</pre>`).join('');
    if (st.mode !== 'unknown') S.unknownSince = 0; else if (!S.unknownSince) { S.unknownSince = performance.now(); setTimeout(() => paint(S), 1600); }
    const stuck = st.mode === 'unknown' && performance.now() - S.unknownSince > 1500;
    $('ltKeybar').hidden = !(st.mode === 'panel' || stuck || (touch() && (st.menu || st.choice)));
    // the screen reader's line
    if (st.choice) say(S, name + ' asks: ' + st.choice.question.replace(/[─━═╌┄┈-]{4,}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600) + ' Options: ' + st.choice.options.map(o => o.label).join(', ') + '.' + (st.choice.options.find(o => o.selected) ? ' Selected: ' + st.choice.options.find(o => o.selected).label + '.' : ''));
    else if (st.mode === 'panel') say(S, name + ' shows a panel. ' + plainText(blocks[0] ? blocks[0].lines : []).slice(0, 300) + ' Escape closes it.');
    else if (st.status) say(S, name + ' is working.');
    else if (st.mode === 'compose') say(S, name + ' is ready.');
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
      draft.placeholder = c ? (c.placeholder || 'Message ' + name) : st.choice ? 'Answer above' : '';
      // A program still drawing its box (just started) takes the message
      // when it is ready (the server waits); a question or a panel first.
      $('ltSend').disabled = !!st.choice || st.mode === 'panel';
    } else {
      const typed = [...S.pending.values()].map(p => p.text).join('');
      if (c) {
        const at = c.caret == null ? c.text.length : c.caret;
        $('ltBefore').textContent = c.text.slice(0, at);
        $('ltCaret').innerHTML = typed ? `<span class="lt-pending">${esc(typed)}</span>` : '';
        $('ltAfter').textContent = c.text.slice(at);
        $('ltPh').textContent = !c.text && !typed ? (c.placeholder || '') : '';
      } else { $('ltBefore').textContent = ''; $('ltAfter').textContent = ''; $('ltCaret').innerHTML = ''; $('ltPh').textContent = st.choice ? 'Answer above (or ↑ ↓ Enter here)' : st.mode === 'panel' ? 'Esc closes the panel' : ''; }
      mirror(S);
    }
    const menu = $('ltMenu'), keys = $('ltKeys');
    menu.hidden = !st.menu || (touch() && S.draftDirty);
    keys.setAttribute('aria-expanded', String(!menu.hidden));
    if (st.menu && !menu.hidden) {
      menu.innerHTML = st.menu.items.map((it, i) => `<div role="option" id="ltOpt${i}" data-i="${i}" aria-selected="${it.selected}"><b>${esc(it.label)}</b><span>${esc(it.detail)}</span></div>`).join('');
      const sel = st.menu.items.findIndex(it => it.selected);
      if (sel >= 0) keys.setAttribute('aria-activedescendant', 'ltOpt' + sel); else keys.removeAttribute('aria-activedescendant');
      menu.querySelectorAll('[data-i]').forEach(d => d.onpointerdown = async e => {
        e.preventDefault(); clearTimeout(S.draftTimer);
        const r = await ask(S, { t: 'menu', index: +d.dataset.i });
        if (touch() && r.t === 'done' && typeof r.text === 'string') { S.draft = r.text; S.known = r.text; S.draftDirty = false; const dr = $('ltDraft'); if (dr) dr.value = r.text; paint(S); }
      });
      menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    } else keys.removeAttribute('aria-activedescendant');
    $('ltFooter').innerHTML = (st.footer || []).map(f => `<span>${esc(f.text)}</span>`).join('');
  }

  // ---- a new conversation, from the draft screen ----
  // The program starts in the folder (Claude Code and Pi with an id chosen
  // by the server; Codex picks its own); its live part shows in place of
  // the draft's box (it may ask whether to trust the folder); the first
  // message goes once its box is ready; the conversation opens once the
  // program has written it.
  const newWaiters = new Map();
  LT.startNew = async function (harness, folder, prompt, onProgress = () => {}) {
    const out = await postJson('/api/live-terminal/new', { harness, folder });
    if (!out || out.error || !out.key) throw new Error((out && out.error) || 'it did not start');
    const temp = out.key;
    const named = new Promise(resolve => newWaiters.set(temp, resolve));
    const S = session(temp); S.running = true;
    const dock = $('composerDock');
    const name = (LT.conf && LT.conf.names && LT.conf.names[harness]) || harness;
    if (dock) { dock.outerHTML = LT.dockHtml({ key: temp, source: harness, liveTerminal: { name, harness, canLeave: false } }); LT.mount(); }
    connect(S);
    onProgress('waiting for ' + name + '…');
    const until = (test, ms) => new Promise((resolve, reject) => { const t0 = Date.now(); const tick = () => { if (test()) return resolve(); if (S.ended) return reject(new Error(name + ' ended')); if (Date.now() - t0 > ms) return reject(new Error(name + ' did not get ready')); setTimeout(tick, 100); }; tick(); });
    // The first message goes once its box is ready; a question the program
    // asks first (trust this folder?) is answered here, then it goes.
    let r = null;
    for (let i = 0; i < 20; i++) {
      await until(() => S.open && S.state.composer && !S.state.choice && !S.state.status, 10 * 60 * 1000);
      onProgress('sending…');
      r = await submit(S, prompt);
      if (r.t === 'done') break;
      if (!/asks something first|not ready/.test(r.error || '')) break;
      onProgress('answer ' + name + '\'s question above; your message goes next');
      S.draft = ''; const dr = $('ltDraft'); if (dr) dr.value = '';
      await new Promise(res => setTimeout(res, 500));
    }
    if (!r || r.t !== 'done') throw new Error((r && r.error) || 'not sent');
    onProgress('opening the conversation…');
    // Its file: the server says so by an event, or when asked.
    const poll = (async () => { for (let i = 0; i < 600; i++) { const st = await statusOf(temp).catch(() => ({})); if (st.resolvedKey && st.indexed) return st.resolvedKey; await new Promise(res => setTimeout(res, 300)); } return null; })();
    const key = await Promise.race([named, poll]);
    newWaiters.delete(temp);
    if (!key) throw new Error(name + ' has not written the conversation yet');
    if (sessions.get(temp) === S) { sessions.delete(temp); S.key = key; sessions.set(key, S); }
    return key;
  };

  LT.init = async () => {
    try {
      const st = await (await fetch('/api/live-terminal/status')).json();
      LT.conf = st;
      LT.enabled = st.available !== false && !st.refusal;
    } catch { LT.enabled = false; }
    return LT.enabled;
  };
  // Which agents may start in their own program from the draft screen.
  LT.newChoice = harness => LT.enabled && LT.conf && LT.conf.agents ? (LT.conf.agents[harness] || 'off') : 'off';
  // ---- settings → agents ----
  const CHOICES = [['off', 'never'], ['choose', 'when I choose'], ['always', 'always']];
  const IDLE = [5, 15, 30, 60, 120, 240, 480];
  LT.settingsHtml = canEdit => {
    const c = LT.conf || {};
    if (c.available === false) return `<h2>agents' own programs</h2><p class="hint">${esc(c.why || 'Not available on this computer.')}</p>`;
    const names = c.names || {}, agents = c.agents || {};
    const dis = canEdit ? '' : ' disabled';
    return `<h2>agents' own programs</h2>
    <p class="hint">A Claude Code, Pi or Codex conversation can continue in that agent's own program, running on this computer and shown here. You type into its own box, use its own <code>/</code> commands and answer its own questions, from any of your devices. The conversation itself is always Chattering's view of its file.</p>
    ${Object.keys(names).map(id => `<div class="set-field"><label for="ltSet_${esc(id)}">${esc(names[id])}</label>
      <select id="ltSet_${esc(id)}" data-agent="${esc(id)}"${dis}>${CHOICES.filter(([v]) => !(id === 'claude' && v === 'choose')).map(([v, l]) => `<option value="${v}"${agents[id] === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>`).join('')}
    <details class="set-field"><summary>start them with options</summary>
      ${Object.keys(names).map(id => `<label for="ltArgs_${esc(id)}">${esc(names[id])}</label><input id="ltArgs_${esc(id)}" data-args="${esc(id)}" type="text" spellcheck="false" autocomplete="off" value="${esc(((c.args || {})[id] || []).map(a => /[\s"']/.test(a) ? JSON.stringify(a) : a).join(' '))}" placeholder="${id === 'claude' ? '--permission-mode default' : id === 'codex' ? '-c approval_policy="on-request"' : ''}"${dis}>`).join('')}
      <div class="set-help">Words added to the program's command each time it starts here, for that run only: nothing is written into the agent's own settings. Quote a word that holds spaces.</div></details>
    <div class="set-help">"When I choose": Chattering's own box, with "Continue in its own program" in the + menu. "Always": its program, with Chattering's box a click away. Claude Code has no box of Chattering's own: set to "never", its conversations open in a terminal window on this computer instead.</div>
    <div class="set-field"><label for="ltSetIdle">end a program left idle for</label>
      <select id="ltSetIdle"${dis}>${[...new Set([...IDLE, c.idleMinutes || 30])].sort((a, b) => a - b).map(m => `<option value="${m}"${c.idleMinutes === m ? ' selected' : ''}>${m < 60 ? m + ' minutes' : m / 60 + (m === 60 ? ' hour' : ' hours')}</option>`).join('')}</select>
      <div class="set-help">Idle: nothing typed, not working, its box empty and no question open (a question or half-written message waits four times longer). An ended program starts again with your next message, from the conversation's file; text left in its box is put back. A restart of Chattering does not end programs.</div></div>
    <label class="set-check"><input id="ltSetRecord" type="checkbox"${c.record !== false ? ' checked' : ''}${dis}> keep a recording of each session</label>
    <div class="set-help">Everything the program showed and every key it received, kept like the conversation's own file (compressed, readable only by this computer's account, in Chattering's data folder). It is how a glitch is replayed and fixed. It holds whatever passed through the program, including anything typed into it.</div>
    <h3>what to know</h3>
    <ul class="set-help">
      <li>Replies appear in the conversation as each message is written to its file. Word by word only where the program prints it so (Pi does; Claude Code and Codex print a reply when it is done).</li>
      <li>An update of an agent can change what its program shows. Chattering reads it with general rules and a small profile per agent, checked against recorded sessions; anything it does not understand is shown as drawn, with keys to answer it.</li>
      <li>It runs as this computer's account, with its own sign-in to each agent: for you and your household, not for guests or people walled in a shared project.</li>
      <li>Using a personal plan from other devices, or for other people, may not be what an agent's terms allow: check them.</li>
    </ul>`;
  };
  LT.bindSettings = root => {
    const save = async patch => {
      const out = await postJson('/api/live-terminal/settings', patch).catch(e => ({ error: e.message }));
      if (!out || out.error) return errToast((out && out.error) || 'not saved');
      LT.conf = { ...LT.conf, ...out };
      toast('saved');
    };
    root.querySelectorAll('select[data-agent]').forEach(sel => sel.onchange = () => save({ agents: { [sel.dataset.agent]: sel.value } }));
    const idle = root.querySelector('#ltSetIdle'); if (idle) idle.onchange = () => save({ idleMinutes: Number(idle.value) });
    const rec = root.querySelector('#ltSetRecord'); if (rec) rec.onchange = () => save({ record: rec.checked });
    // Words, as a shell would split them (quotes keep spaces), never run by one.
    const words = text => [...String(text).matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map(m => m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2] != null ? m[2] : m[3]);
    root.querySelectorAll('input[data-args]').forEach(inp => inp.onchange = () => save({ args: { [inp.dataset.args]: words(inp.value) } }));
  };

  // Re-render on pointer changes (a tablet's keyboard attached).
  matchMedia('(pointer: coarse)').addEventListener?.('change', () => mounted && LT.mount());
})();
