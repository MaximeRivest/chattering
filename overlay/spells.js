// spells.js — the frog's spells, the page (design/94).
//
// The page draws; it decides nothing about the person's text. The computer
// helper (hotkeys-device.js) holds the selection and the answers and talks
// to Chattering; the host (host-gtk.py) shows this page in a see-through
// layer over one screen and passes messages both ways:
//
//   in   show {at, words, app, spells, model, theme, systemDark, corner}
//        working {label}   answer {...}   problem {title, message}
//        done {text}       hide
//   out  cast {id}   ask {request}   replace   copy   again   judge {call, verdict}
//        close   hidden   settings   ready
//        and, for the host only: rects [{x, y, w, h}] (where the pointer may
//        land; elsewhere it falls through to the app below) and
//        keyboard {on} (whether the page needs the keys).
(function () {
  'use strict';
  const T = window.SpellsText;
  const root = document.getElementById('ch');
  const html = document.documentElement;

  // ---- the host ----
  function send(msg) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.chattering) window.webkit.messageHandlers.chattering.postMessage(JSON.stringify(msg));
      else if (window.chrome && window.chrome.webview) window.chrome.webview.postMessage(JSON.stringify(msg));
      else if (window.spellsHost) window.spellsHost(msg); // tests
    } catch {}
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    fix: svg('<path d="M4 7h9M4 12h6M4 17h5"/><path d="M13 16l2.5 2.5L21 13"/>'),
    translate: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.4 5.2 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.2-3.4-8.5s1-6.1 3.4-8.5z"/>'),
    explain: svg('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>'),
    polite: svg('<path d="M4 6.5h16v9H9l-4.5 3.5V6.5z"/><path d="M9.5 11.5c.7.7 1.5 1 2.5 1s1.8-.3 2.5-1"/>'),
    shorter: svg('<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8 8.5L20 17M8 15.5L20 7"/>'),
    longer: svg('<path d="M4 7h16M4 12h16M4 17h10"/><path d="M18 15v6M15 18h6"/>'),
    format: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
    spark: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z"/>'),
    ask: svg('<path d="M4 6.5h16v9H9l-4.5 3.5V6.5z"/><path d="M12 9v.01M12 12.5v.01"/>'),
  };
  // A model as people read it: its own name, without the provider in front.
  const shortModel = m => { const s = String(m || ''); const i = s.indexOf('/'); return i > 0 ? s.slice(i + 1) : s; };
  const OUT = { replace: 'replaces the text', paste: 'replaces the text', clipboard: 'copies the answer', notify: 'shows an answer' };

  // ---- state ----
  let S = null;        // the current show: { at, words, app, spells, model, corner }
  let frog = null, panel = null, pill = null, img = null;
  let mode = 'off';    // off | idle | menu | busy | answer
  let fadeT = 0, blinkT = 0, answerData = null, judged = null;

  // ---- theme ----
  function applyTheme(theme, systemDark) {
    const id = (theme && theme.id) || 'rockfrog';
    // The default theme follows the desktop's light or dark; the host says which.
    html.dataset.theme = id === 'rockfrog' ? (systemDark ? 'rockfrog-dark' : 'rockfrog-light') : id;
    document.getElementById('customTheme').textContent = (theme && theme.css) || '';
    const cs = getComputedStyle(html);
    html.dataset.themeMode = (cs.getPropertyValue('--theme-mode') || 'color').trim();
    const motion = (cs.getPropertyValue('--theme-motion') || '1').trim();
    root.classList.toggle('still', motion === '0' || matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // ---- where things go ----
  const vw = () => window.innerWidth, vh = () => window.innerHeight;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function rectsChanged() {
    const rs = [];
    for (const el of [frog, panel, pill]) {
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height) rs.push({ x: Math.floor(r.left) - 2, y: Math.floor(r.top) - 2, w: Math.ceil(r.width) + 4, h: Math.ceil(r.height) + 4 });
    }
    send({ type: 'rects', rects: rs });
  }
  let rectT = 0;
  const rectsSoon = () => { cancelAnimationFrame(rectT); rectT = requestAnimationFrame(rectsChanged); };
  new ResizeObserver(rectsSoon).observe(root);

  // The frog stands with its feet at `at` (the end of the selection, or the
  // window's corner), beside it to the right, else to the left near the
  // screen's edge.
  function placeFrog() {
    const small = !!S.small;
    frog.classList.toggle('small', small);
    const w = small ? 45 : 60, h = small ? 75 : 100;
    let x = S.corner ? S.at.x - w : S.at.x + 10, y = S.at.y - h + 8;
    if (x + w > vw() - 4) x = S.at.x - w - 10;
    frog.style.left = clamp(x, 4, vw() - w - 4) + 'px';
    frog.style.top = clamp(y, 4, vh() - h - 4) + 'px';
  }
  // A panel opens under the frog's line, toward the screen's middle, else
  // above it; never off the screen.
  function placePanel(el) {
    const f = frog.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    const rightSide = f.left > vw() / 2;
    let x = rightSide ? f.left - w + 24 : f.left - 12;
    let y = (S.at.y || f.bottom) + 14;
    if (y + h > vh() - 8) y = f.top - h - 6;
    if (y < 8) y = clamp(f.top, 8, vh() - h - 8), x = rightSide ? f.left - w - 8 : f.right + 8;
    el.style.left = clamp(x, 8, vw() - w - 8) + 'px';
    el.style.top = clamp(y, 8, vh() - h - 8) + 'px';
  }
  function placePill(el) {
    const f = frog.getBoundingClientRect();
    let x = f.left - el.offsetWidth - 8;
    if (x < 8) x = f.right + 8;
    el.style.left = clamp(x, 8, vw() - el.offsetWidth - 8) + 'px';
    el.style.top = clamp(f.top + f.height * 0.35, 8, vh() - 38) + 'px';
  }

  // ---- the frog ----
  const POSES = ['idle', 'blink', 'wave', 'cast', 'happy', 'puzzled'];
  POSES.forEach(p => { const i = new Image(); i.src = 'frog/' + p + '.webp'; });
  const pose = p => { if (img) img.src = 'frog/' + p + '.webp'; };
  function blinkLoop() {
    clearTimeout(blinkT);
    blinkT = setTimeout(() => { if (mode === 'idle' || mode === 'menu') { pose('blink'); setTimeout(() => (mode === 'idle' || mode === 'menu') && pose('idle'), 140); } blinkLoop(); }, 1800 + Math.random() * 3200);
  }
  function sparkles(n) {
    if (root.classList.contains('still') || !frog) return;
    const f = frog.getBoundingClientRect(), cx = f.left + f.width / 2, cy = f.top + f.height * 0.45;
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span'); s.className = 'spark'; s.textContent = '✦';
      s.style.left = cx + 'px'; s.style.top = cy + 'px';
      s.style.setProperty('--dx', (Math.random() * 60 - 30) + 'px'); s.style.setProperty('--dy', (-20 - Math.random() * 40) + 'px');
      s.style.animationDelay = (i * 60) + 'ms'; root.appendChild(s); setTimeout(() => s.remove(), 1400);
    }
  }
  function idleSoon(ms) {
    clearTimeout(fadeT);
    fadeT = setTimeout(() => { if (mode === 'idle') hopAway(); }, ms);
  }
  function hopAway() {
    if (mode === 'off') return;
    mode = 'off'; clearTimeout(fadeT); clearTimeout(blinkT); closePanel(); closePill();
    keyboard(false);
    if (frog) {
      const f = frog; f.classList.add('leave');
      setTimeout(() => { f.remove(); if (frog === f) frog = null; rectsChanged(); send({ type: 'hidden' }); }, 320);
    } else send({ type: 'hidden' });
  }

  let wantKeys = false;
  function keyboard(on) { if (on !== wantKeys) { wantKeys = on; send({ type: 'keyboard', on }); } }

  function show(m) {
    closePanel(); closePill();
    S = m; applyTheme(m.theme, m.systemDark);
    if (!frog) {
      frog = document.createElement('div'); frog.className = 'frog'; frog.tabIndex = -1;
      frog.setAttribute('role', 'button'); frog.setAttribute('aria-label', 'Chattering: cast a spell on the selected text');
      frog.innerHTML = '<div class="fbody"><img alt=""></div>';
      img = frog.querySelector('img');
      frog.addEventListener('mousedown', e => e.preventDefault());
      frog.addEventListener('click', () => { if (mode === 'menu') { closePanel(); keyboard(false); mode = 'idle'; idleSoon(3000); } else if (mode === 'idle') openMenu(); });
      root.appendChild(frog);
    }
    placeFrog();
    frog.classList.remove('leave', 'busy', 'cheer', 'shake'); void frog.offsetWidth; frog.classList.add('enter');
    mode = 'idle'; pose('wave'); setTimeout(() => { if (mode === 'idle') pose('idle'); }, 1100);
    blinkLoop();
    if (m.open) openMenu(); else idleSoon(m.linger || 5000);
    rectsSoon();
  }

  // ---- the menu ----
  function head(right) {
    const where = S.words ? `${S.words} word${S.words === 1 ? '' : 's'}${S.app ? ' in ' + esc(S.app) : ''}` : esc(S.app || '');
    return `<div class="head"><span class="mark" aria-hidden="true"></span><span class="name">Chattering</span><span class="sep">·</span><span class="where">${where}</span>${right || ''}</div>`;
  }
  function closePanel() { if (panel) { panel.remove(); panel = null; rectsSoon(); } }
  function closePill() { if (pill) { pill.remove(); pill = null; rectsSoon(); } }

  function openMenu() {
    clearTimeout(fadeT); closePanel(); closePill();
    mode = 'menu';
    const spells = S.spells || [];
    const el = document.createElement('div'); el.className = 'panel menu'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Spells'); el.style.width = '340px';
    el.innerHTML = head('<button class="link" data-settings title="Your spells, in Chattering: settings → hotkeys">edit spells</button>')
      + `<div class="ask"><input id="ask" placeholder="Ask, or say what to do with it…" autocomplete="off" spellcheck="true" aria-label="Ask about the selected text"><span class="model" title="Questions you type go to ${esc(S.model || 'the settings model')}">${esc(shortModel(S.model))}</span></div>`
      + (spells.length
        ? '<div class="label">Your spells</div><div class="list" role="listbox">' + spells.map((s, i) => `<button class="row${i === 0 ? ' on' : ''}" role="option" data-i="${i}"><span class="ic">${ICON[s.icon] || ICON.spark}</span><span class="txt"><span class="title">${esc(s.label)}</span><span class="meta">${esc(OUT[s.output] || '')}</span></span>${s.letter ? `<kbd>${esc(s.letter)}</kbd>` : ''}</button>`).join('') + '</div>'
        : '<div class="empty">No spells yet. Make some in Chattering, settings → hotkeys, or ask above.</div>')
      + '<div class="foot"><span class="grow">Press a spell’s letter, or <kbd>Tab</kbd> to ask</span><span><kbd>esc</kbd> closes</span></div>';
    el.addEventListener('mousedown', e => { if (e.target.id !== 'ask') e.preventDefault(); });
    const rows = [...el.querySelectorAll('.row')];
    rows.forEach(b => {
      b.onclick = () => cast(spells[+b.dataset.i]);
      b.onmouseenter = () => rows.forEach(x => x.classList.toggle('on', x === b));
    });
    el.querySelector('[data-settings]').onclick = () => send({ type: 'settings' });
    const ask = el.querySelector('#ask');
    ask.addEventListener('focus', () => el.classList.add('typing'));
    ask.addEventListener('blur', () => el.classList.remove('typing'));
    ask.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && ask.value.trim()) { e.preventDefault(); askFor(ask.value.trim()); }
      else if (e.key === 'Escape') { e.preventDefault(); if (ask.value) ask.value = ''; else ask.blur(); }
      else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); ask.blur(); el.focus(); }
    });
    el.tabIndex = -1;
    panel = el; root.appendChild(el); placePanel(el);
    keyboard(true);
    setTimeout(() => el.focus({ preventScroll: true }), 0);
    pose('idle');
    rectsSoon();
  }

  function cast(spell) {
    if (!spell) return;
    send({ type: 'cast', id: spell.id });
    working(spell.label);
  }
  function askFor(request) {
    send({ type: 'ask', request });
    working('“' + (request.length > 40 ? request.slice(0, 39) + '…' : request) + '”');
  }
  function working(label) {
    closePanel(); closePill(); clearTimeout(fadeT);
    mode = 'busy'; keyboard(false);
    pose('cast'); frog.classList.remove('enter', 'cheer', 'shake'); frog.classList.add('busy'); sparkles(7);
    const el = document.createElement('div'); el.className = 'pill'; el.setAttribute('role', 'status');
    el.innerHTML = `<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="live">${esc(label)}</span>${S.model ? `<span class="dim">${esc(shortModel(S.model))}</span>` : ''}`;
    pill = el; root.appendChild(el); placePill(el);
    clearInterval(working.t); working.t = setInterval(() => sparkles(3), 700);
    rectsSoon();
  }
  function stopWorking() { clearInterval(working.t); if (frog) frog.classList.remove('busy'); closePill(); }

  // ---- the answer ----
  function renderChanges(before, after) {
    return T.diff(before, after).map(p => (p.op === 'del' ? `<del>${esc(p.text)}</del>` : p.op === 'ins' ? `<ins>${esc(p.text)}</ins>` : esc(p.text))).join('');
  }
  function answer(a) {
    stopWorking(); closePanel();
    mode = 'answer'; answerData = a; judged = null;
    pose('happy'); frog.classList.add('cheer'); sparkles(5);
    setTimeout(() => { if (frog) frog.classList.remove('cheer'); if (mode === 'answer') pose('idle'); }, 1100);
    const replaces = a.kind === 'replace';
    let view = replaces ? T.view(a.before, a.text) : 'text';
    const el = document.createElement('div'); el.className = 'panel answer'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', a.label || 'Answer'); el.tabIndex = -1;
    const facts = [a.program, a.version, a.model, a.secs != null ? a.secs + ' s' : null].filter(Boolean).map(esc).join(' · ');
    const primary = replaces ? `<button class="btn go" data-act="replace">Replace <kbd>↵</kbd></button>`
      : a.kind === 'copy' ? `<button class="btn go" data-act="copy">Copy <kbd>↵</kbd></button>`
      : `<button class="btn go" data-act="close">Done <kbd>↵</kbd></button>`;
    el.innerHTML = head((replaces ? `<button class="link" data-view></button>` : '') + '<button class="link" data-act="close" title="Close (esc)" aria-label="Close">✕</button>')
      + '<div class="body" id="body"></div>'
      + (facts ? `<div class="runline">${facts}</div>` : '')
      + `<div class="acts"><span class="grow">${a.call ? 'Right? <button class="judge" data-j="right" title="Right: it joins the program’s answer key" aria-label="Right">✓</button><button class="judge" data-j="wrong" title="Wrong: say what it should have said on the program’s page" aria-label="Wrong">✗</button>' : ''}</span>`
      + `<button class="btn" data-act="again" title="Cast it again">Again</button>`
      + (a.kind !== 'copy' ? `<button class="btn" data-act="copy">Copy</button>` : '')
      + primary + '</div>';
    const body = el.querySelector('#body'), toggle = el.querySelector('[data-view]');
    const paint = () => {
      body.innerHTML = view === 'changes' ? renderChanges(a.before, a.text) : esc(a.text);
      if (toggle) toggle.textContent = view === 'changes' ? 'plain text' : 'show changes';
    };
    if (toggle) toggle.onclick = () => { view = view === 'changes' ? 'text' : 'changes'; paint(); placePanel(el); rectsSoon(); };
    paint();
    el.addEventListener('mousedown', e => e.preventDefault());
    el.querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act));
    el.querySelectorAll('[data-j]').forEach(b => b.onclick = () => {
      const v = judged === b.dataset.j ? null : b.dataset.j;
      judged = v;
      el.querySelectorAll('[data-j]').forEach(x => x.classList.toggle(x.dataset.j === 'right' ? 'yes' : 'no', x.dataset.j === v));
      send({ type: 'judge', call: a.call, verdict: v });
    });
    panel = el; root.appendChild(el); placePanel(el);
    keyboard(true);
    setTimeout(() => el.focus({ preventScroll: true }), 0);
    rectsSoon();
  }
  function act(what) {
    if (what === 'close') { closePanel(); keyboard(false); mode = 'idle'; pose('idle'); idleSoon(1500); send({ type: 'close' }); return; }
    if (what === 'again') { send({ type: 'again' }); working(answerData && answerData.label || 'Again'); return; }
    if (what === 'copy') { send({ type: 'copy' }); closePanel(); keyboard(false); mode = 'idle'; note('<span class="live">✓</span> Copied to the clipboard', 1800); return; }
    if (what === 'replace') { send({ type: 'replace' }); closePanel(); keyboard(false); mode = 'busy'; return; }
  }
  // A short word beside the frog, then it hops away.
  function note(htmlText, ms, away = true) {
    closePill();
    const el = document.createElement('div'); el.className = 'pill'; el.setAttribute('role', 'status'); el.innerHTML = htmlText;
    pill = el; root.appendChild(el); placePill(el); rectsSoon();
    setTimeout(() => { if (pill === el) closePill(); if (away) hopAway(); }, ms);
  }
  function problem(p) {
    stopWorking(); closePanel();
    mode = 'answer'; pose('puzzled'); frog.classList.add('shake'); setTimeout(() => frog && frog.classList.remove('shake'), 900);
    const el = document.createElement('div'); el.className = 'panel answer'; el.setAttribute('role', 'alertdialog'); el.tabIndex = -1;
    el.innerHTML = head('<button class="link" data-act="close" aria-label="Close">✕</button>')
      + `<div class="problem"><b>${esc(p.title || 'That did not work')}</b><br>${esc(p.message || '')}</div>`
      + `<div class="acts"><span class="grow"></span>${p.again !== false ? '<button class="btn" data-act="again">Try again</button>' : ''}<button class="btn go" data-act="close">Close <kbd>↵</kbd></button></div>`;
    el.addEventListener('mousedown', e => e.preventDefault());
    el.querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act));
    panel = el; root.appendChild(el); placePanel(el); keyboard(true);
    setTimeout(() => el.focus({ preventScroll: true }), 0); rectsSoon();
  }

  // ---- keys (the host gives them only while a panel is open) ----
  document.addEventListener('keydown', e => {
    if (!panel || e.target.id === 'ask') return;
    if (mode === 'answer') {
      if (e.key === 'Escape') { e.preventDefault(); act('close'); }
      else if (e.key === 'Enter') { e.preventDefault(); const go = panel.querySelector('.btn.go'); if (go) go.click(); }
      return;
    }
    if (mode !== 'menu') return;
    const rows = [...panel.querySelectorAll('.row')], cur = Math.max(0, rows.findIndex(b => b.classList.contains('on')));
    if (e.key === 'Escape') { e.preventDefault(); closePanel(); keyboard(false); mode = 'idle'; idleSoon(2500); return; }
    if (e.key === 'Tab') { e.preventDefault(); panel.querySelector('#ask').focus(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!rows.length) return;
      rows[cur].classList.remove('on');
      const next = rows[(cur + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]; next.classList.add('on'); next.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); if (rows.length) rows[cur].click(); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const i = (S.spells || []).findIndex(s => s.letter === e.key.toUpperCase());
      if (i >= 0) { e.preventDefault(); cast(S.spells[i]); }
    }
  });

  // ---- from the host ----
  window.Spells = {
    receive(m) {
      if (typeof m === 'string') m = JSON.parse(m);
      if (m.type === 'show') show(m);
      else if (m.type === 'open') { if (frog && mode === 'idle') openMenu(); }
      else if (m.type === 'working') { if (frog) working(m.label); }
      else if (m.type === 'answer') { if (frog) answer(m); }
      else if (m.type === 'problem') { if (frog) problem(m); }
      else if (m.type === 'done') { stopWorking(); if (frog) { pose('happy'); frog.classList.add('cheer'); sparkles(9); note(m.html || esc(m.text || 'Done'), m.ms || 2200); } }
      else if (m.type === 'hide') hopAway();
      else if (m.type === 'theme') applyTheme(m.theme, m.systemDark);
    },
    get state() { return { mode, panel: panel && panel.className, words: S && S.words }; },
  };
  send({ type: 'ready' });
})();
