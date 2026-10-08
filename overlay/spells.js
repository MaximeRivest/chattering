// spells.js — the frog's spells, the page (design/94).
//
// The page draws; it decides nothing about the person's text. The computer
// helper (hotkeys-device.js) holds the selection and the answers and talks
// to Chattering; the host (host-gtk.py) shows this page in a see-through
// layer over one screen and passes messages both ways:
//
//   in   show {mode, size, at | home, words, app, spells, model, theme, systemDark, corner, screen, asleep}
//        wake {words, app}   sleep   working {label}   answer {...}
//        problem {title, message}   done {html}   hide
//   (mode 'beside': the frog appears at `at` and leaves; 'spot': it lives at
//   `home`, asleep, and wakes when a selection could use it)
//   out  cast {id}   ask {request}   replace   copy   again   judge {call, verdict}
//        close   hidden   settings   ready   shown   moved {x, y, w, h}
//        set {mode | size}   snooze {minutes}   skip-app   (its right-click menu)
//        drag {on} (host only: the whole screen takes the pointer while dragging)
//        and, for the host only: rects [{x, y, w, h}] (where the pointer may
//        land; elsewhere it falls through to the app below) and
//        keyboard {on} (whether the page needs the keys).
//   in, from the host only: released (it took the keys back itself).
//
// The keys: while the page has them the desktop gives them to no one else,
// not an app, not a shortcut. A panel that went away still holding them
// locked the person out of their computer (an answer in review, the frog
// dragged: the panel closed, the keys stayed). So they are never asked for
// or given back one by one: they are held exactly while a panel shows,
// checked each time a panel opens or closes (syncKeys), and the host asks
// the page (holdsKeys) and takes them back itself if it gets no answer.
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
  // The screen's size: the page's own once the host has given it its size;
  // until then (a layer just shown measures 0 by 0) the size the helper sent.
  const vw = () => window.innerWidth || (S && S.screen && S.screen.w) || 1920;
  const vh = () => window.innerHeight || (S && S.screen && S.screen.h) || 1080;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // Where the pointer may land, from where things are laid out, not where
  // an animation has them this frame: measured mid-hop, the frog was a
  // fifth of its size, and the host let clicks through everywhere else.
  // The frog gets room for its hops and its hover lean.
  const PAD = { frog: 14, other: 2 };
  function box(el) {
    let x = 0, y = 0;
    for (let e = el; e && e !== document.body; e = e.offsetParent) { x += e.offsetLeft; y += e.offsetTop; }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  }
  let lastRects = '';
  function rectsChanged() {
    syncKeys(); // anything changed on the page: the keys still follow the panel
    const rs = [];
    for (const el of [frog, panel, pill]) {
      if (!el || !el.isConnected || el.classList.contains('leave')) continue;
      const b = box(el), p = el === frog ? PAD.frog : PAD.other;
      if (b.w && b.h) rs.push({ x: Math.floor(b.x) - p, y: Math.floor(b.y) - p, w: Math.ceil(b.w) + 2 * p, h: Math.ceil(b.h) + 2 * p });
    }
    const key = JSON.stringify(rs);
    if (key === lastRects) return;
    lastRects = key;
    send({ type: 'rects', rects: rs });
  }
  // A timer, not an animation frame: a page whose screen is asleep gets no
  // frames, and the pointer region must still follow.
  let rectT = 0;
  const rectsSoon = () => { clearTimeout(rectT); rectT = setTimeout(rectsChanged, 16); };
  // The real size arrives after the layer is shown: place everything again.
  window.addEventListener('resize', () => {
    if (frog && S) placeFrog();
    if (panel && frog) placePanel(panel);
    if (pill && frog) placePill(pill);
    rectsSoon();
  });
  // Anything added, moved or resized: measure again.
  new MutationObserver(rectsSoon).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  new ResizeObserver(rectsSoon).observe(root);

  // The frog stands with its feet at `at` (the end of the selection, or the
  // window's corner), beside it to the right, else to the left near the
  // screen's edge.
  function placeFrog() {
    for (const k of Object.keys(SIZES)) frog.classList.toggle('size-' + k, (S.size || 'medium') === k);
    const [w, h] = size();
    let x, y;
    if (spot()) { x = S.home.x; y = S.home.y; }
    else {
      x = S.corner ? S.at.x - w : S.at.x + 10; y = S.at.y - h + 8;
      if (x + w > vw() - 4) x = S.at.x - w - 10;
    }
    frog.style.left = clamp(x, 4, vw() - w - 4) + 'px';
    frog.style.top = clamp(y, 4, vh() - h - 4) + 'px';
  }
  // A panel opens under the frog's line, toward the screen's middle, else
  // above it; never off the screen.
  function placePanel(el) {
    const f = frog.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    const rightSide = f.left > vw() / 2;
    if (spot() || el.classList.contains('ctx')) {
      // Beside the frog where it lives: toward the middle of the screen.
      const low = f.top + f.height / 2 > vh() / 2;
      const x = rightSide ? f.left - w + f.width : f.left;
      const y = low ? f.top - h - 8 : f.bottom + 8;
      el.style.left = clamp(x, 8, vw() - w - 8) + 'px';
      el.style.top = clamp(y, 8, vh() - h - 8) + 'px';
      return;
    }
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
  const POSES = ['idle', 'blink', 'wave', 'cast', 'happy', 'puzzled', 'sleep', 'wake'];
  const SIZES = { small: [40, 66], medium: [60, 100], large: [80, 133] };
  const size = () => SIZES[(S && S.size) || 'medium'] || SIZES.medium;
  const spot = () => !!(S && S.mode === 'spot');
  let awake = false, sleepT = 0, dragging = null, ignoreClick = false;
  POSES.forEach(p => { const i = new Image(); i.src = 'frog/' + p + '.webp'; });
  // Asleep a while, it holds still: any animation, even a slow breath,
  // has the screen-sized layer draw every frame (a quarter of a laptop
  // core and a sixth of its GPU, measured), for as long as it sleeps.
  const SETTLE_MS = 20000;
  let settleT = 0;
  function unsettle() { clearTimeout(settleT); if (frog) frog.classList.remove('settled'); }
  const pose = p => { if (img) img.src = 'frog/' + p + '.webp'; if (p !== 'sleep') unsettle(); };
  // Only an awake frog blinks: a blink ends on the standing pose, and a
  // sleeping frog that blinked stood there with its z's, eyes open.
  const canBlink = () => (mode === 'idle' || mode === 'menu') && awake;
  function blinkLoop() {
    clearTimeout(blinkT);
    blinkT = setTimeout(() => { if (canBlink()) { pose('blink'); setTimeout(() => canBlink() && pose('idle'), 140); } blinkLoop(); }, 1800 + Math.random() * 3200);
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
    if (spot()) { sleepSoon(Math.max(ms, 8000)); return; }
    fadeT = setTimeout(() => { if (mode === 'idle') hopAway(); }, ms);
  }
  // In its spot the frog never leaves: it goes back to sleep.
  function rest() { if (spot()) { closePanel(); mode = 'idle'; goSleep(); } else hopAway(); }
  function sleepSoon(ms) { clearTimeout(sleepT); sleepT = setTimeout(() => { if (mode === 'idle') goSleep(); }, ms); } // waking cancels it
  function goSleep() {
    if (!frog) return;
    clearTimeout(sleepT); awake = false;
    frog.classList.remove('awake', 'busy', 'cheer', 'shake'); frog.classList.add('asleep');
    pose('sleep');
    clearTimeout(settleT);
    settleT = setTimeout(() => { if (frog && !awake && frog.classList.contains('asleep')) frog.classList.add('settled'); }, SETTLE_MS);
  }
  function wakeUp(m) {
    if (!frog) return;
    if (m) { S.words = m.words; S.app = m.app; }
    awake = true; clearTimeout(sleepT);
    frog.classList.remove('asleep'); void frog.offsetWidth; frog.classList.add('awake');
    pose('wake'); setTimeout(() => { if (awake && mode === 'idle') pose('idle'); }, 1400);
    sleepSoon(8000);
  }
  function hopAway() {
    if (mode === 'off') return;
    mode = 'off'; clearTimeout(fadeT); clearTimeout(blinkT); closePanel(); closePill();
    if (frog) {
      const f = frog; f.classList.add('leave');
      setTimeout(() => { f.remove(); if (frog === f) frog = null; rectsChanged(); send({ type: 'hidden' }); }, 320);
    } else send({ type: 'hidden' });
  }

  // The keys follow the panel: never asked for or given back on their own.
  let wantKeys = false;
  const panelUp = () => !!(panel && panel.isConnected);
  function syncKeys() { const on = panelUp(); if (on !== wantKeys) { wantKeys = on; send({ type: 'keyboard', on }); } }
  // The frog is going: nothing may open beside it any more.
  const here = () => !!(frog && mode !== 'off');

  function show(m) {
    closePanel(); closePill();
    S = m; applyTheme(m.theme, m.systemDark);
    if (!frog) {
      frog = document.createElement('div'); frog.className = 'frog'; frog.tabIndex = -1;
      frog.setAttribute('role', 'button'); frog.setAttribute('aria-label', 'Chattering: cast a spell on the selected text');
      frog.innerHTML = '<div class="fbody"><img alt=""></div><div class="zzz" aria-hidden="true"><i>z</i><i>z</i><i>z</i></div>';
      img = frog.querySelector('img');
      frog.addEventListener('mousedown', e => e.preventDefault());
      frog.addEventListener('click', onFrogClick);
      frog.addEventListener('pointerdown', dragStart);
      frog.addEventListener('contextmenu', e => { e.preventDefault(); openCtx(); });
      root.appendChild(frog);
    }
    placeFrog();
    unsettle();
    frog.classList.remove('leave', 'busy', 'cheer', 'shake', 'asleep', 'awake'); void frog.offsetWidth; frog.classList.add('enter');
    mode = 'idle'; awake = !spot();
    if (spot() && m.asleep !== false && !m.open) { goSleep(); }
    else { pose('wave'); setTimeout(() => { if (mode === 'idle') pose('idle'); }, 1100); }
    blinkLoop();
    if (m.open) { awake = true; openMenu(); } else if (!spot()) idleSoon(m.linger || 5000); else if (awake) sleepSoon(8000);
    rectsSoon();
    // Drawn: the helper times how long a frog takes to appear.
    requestAnimationFrame(() => requestAnimationFrame(() => send({ type: 'shown' })));
  }

  function onFrogClick() {
    if (ignoreClick) { ignoreClick = false; return; }
    if (mode === 'menu' || (panel && panel.classList.contains('ctx'))) { closePanel(); mode = 'idle'; idleSoon(3000); return; }
    if (mode !== 'idle') return;
    // Asleep with nothing to work on: it says what it needs.
    if (spot() && (!awake || !S.words)) { pose('puzzled'); frog.classList.remove('asleep'); note('Select some text, then click me', 2200, false); sleepSoon(2400); return; }
    openMenu();
  }

  // Dragging: past a few pixels a press is a drag, not a click. While it
  // lasts the whole screen takes the pointer (the host is told), so a fast
  // move cannot leave the frog behind.
  function dragStart(e) {
    if (e.button !== 0 || mode === 'busy') return;
    const f = frog.getBoundingClientRect();
    dragging = { sx: e.clientX, sy: e.clientY, dx: e.clientX - f.left, dy: e.clientY - f.top, moved: false, id: e.pointerId };
    frog.setPointerCapture(e.pointerId);
    frog.addEventListener('pointermove', dragMove);
    frog.addEventListener('pointerup', dragEnd);
    frog.addEventListener('pointercancel', dragEnd);
  }
  function dragMove(e) {
    if (!dragging) return;
    if (!dragging.moved) {
      if (Math.hypot(e.clientX - dragging.sx, e.clientY - dragging.sy) < 5) return;
      dragging.moved = true; frog.classList.add('dragging'); frog.classList.remove('enter');
      closePanel(); closePill(); clearTimeout(fadeT); clearTimeout(sleepT);
      send({ type: 'drag', on: true });
    }
    const [w, h] = size();
    frog.style.left = clamp(e.clientX - dragging.dx, 4, vw() - w - 4) + 'px';
    frog.style.top = clamp(e.clientY - dragging.dy, 4, vh() - h - 4) + 'px';
  }
  function dragEnd() {
    if (!dragging) return;
    const d = dragging; dragging = null;
    frog.removeEventListener('pointermove', dragMove);
    frog.removeEventListener('pointerup', dragEnd);
    frog.removeEventListener('pointercancel', dragEnd);
    if (!d.moved) return;
    ignoreClick = true; setTimeout(() => { ignoreClick = false; }, 300);
    frog.classList.remove('dragging');
    send({ type: 'drag', on: false });
    const [w, h] = size();
    const x = parseFloat(frog.style.left), y = parseFloat(frog.style.top);
    if (spot()) S.home = { x, y };
    send({ type: 'moved', x, y, w, h, screen: { w: vw(), h: vh() } });
    rectsSoon();
    if (spot()) { if (!awake) goSleep(); else sleepSoon(8000); } else idleSoon(8000);
  }

  // Right-click: where it lives, its size, a rest, an app to leave alone.
  function openCtx() {
    if (mode === 'busy') return;
    clearTimeout(fadeT); clearTimeout(sleepT); closePanel(); closePill();
    const items = [];
    if (spot()) items.push(['beside', 'Come beside the text instead']);
    else items.push(['spot', 'Live here, asleep until I can help']);
    if ((S.size || 'medium') !== 'small') items.push(['smaller', 'Smaller']);
    if ((S.size || 'medium') !== 'large') items.push(['larger', 'Larger']);
    items.push(['hr']);
    items.push(['snooze', 'Sleep for an hour']);
    if (S.app) items.push(['skip', 'Stay away from ' + S.app]);
    items.push(['hr']);
    items.push(['settings', 'Settings…', 'in Chattering']);
    const el = document.createElement('div'); el.className = 'panel ctx'; el.setAttribute('role', 'menu'); el.tabIndex = -1;
    el.innerHTML = items.map(([k, label, hint]) => k === 'hr' ? '<hr>' : `<button class="item" role="menuitem" data-k="${k}">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</button>`).join('');
    el.addEventListener('mousedown', e => e.preventDefault());
    el.querySelectorAll('[data-k]').forEach(b => b.onclick = () => ctxDo(b.dataset.k));
    el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePanel(); mode = 'idle'; idleSoon(3000); } });
    panel = el; mode = 'menu'; root.appendChild(el); placePanel(el); syncKeys();
    setTimeout(() => el.focus({ preventScroll: true }), 0); rectsSoon();
  }
  function ctxDo(k) {
    closePanel(); mode = 'idle';
    const order = ['small', 'medium', 'large'], i = order.indexOf(S.size || 'medium');
    if (k === 'spot') {
      // Here becomes its home.
      S.mode = 'spot'; S.home = { x: parseFloat(frog.style.left), y: parseFloat(frog.style.top) };
      const [w, h] = size();
      send({ type: 'moved', x: S.home.x, y: S.home.y, w, h, screen: { w: vw(), h: vh() } });
      send({ type: 'set', mode: 'spot' });
      note('I’ll sleep here, and wake when I can help', 2400, false);
      sleepSoon(2500);
    } else if (k === 'beside') { send({ type: 'set', mode: 'beside' }); hopAway(); }
    else if (k === 'smaller' || k === 'larger') {
      S.size = order[Math.max(0, Math.min(2, i + (k === 'larger' ? 1 : -1)))];
      // Its feet stay where they were.
      const bottom = parseFloat(frog.style.top) + frog.offsetHeight, left = parseFloat(frog.style.left);
      placeFrog();
      frog.style.left = clamp(left, 4, vw() - size()[0] - 4) + 'px';
      frog.style.top = clamp(bottom - size()[1], 4, vh() - size()[1] - 4) + 'px';
      if (spot()) { S.home = { x: parseFloat(frog.style.left), y: parseFloat(frog.style.top) }; send({ type: 'moved', x: S.home.x, y: S.home.y, w: size()[0], h: size()[1], screen: { w: vw(), h: vh() } }); }
      send({ type: 'set', size: S.size });
      rectsSoon(); idleSoon(5000);
    } else if (k === 'snooze') { send({ type: 'snooze', minutes: 60 }); note('Sleeping for an hour', 1800, false); if (spot()) sleepSoon(1900); else setTimeout(hopAway, 1900); }
    else if (k === 'skip') { send({ type: 'skip-app' }); note('I’ll stay away from ' + esc(S.app), 1800, false); if (spot()) sleepSoon(1900); else setTimeout(hopAway, 1900); }
    else if (k === 'settings') { send({ type: 'settings' }); rest(); }
  }

  // ---- the menu ----
  function head(right) {
    const where = S.words ? `${S.words} word${S.words === 1 ? '' : 's'}${S.app ? ' in ' + esc(S.app) : ''}` : esc(S.app || '');
    return `<div class="head"><span class="mark" aria-hidden="true"></span><span class="name">Chattering</span><span class="sep">·</span><span class="where">${where}</span>${right || ''}</div>`;
  }
  // A panel gone takes its mode (a menu, an answer in review) and the keys
  // with it: whatever closed it (Esc, a drag, a new show, the host).
  function closePanel() {
    if (panel) { panel.remove(); panel = null; rectsSoon(); }
    if (mode === 'menu' || mode === 'answer') mode = 'idle';
    syncKeys();
  }
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
    syncKeys();
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
    mode = 'busy';
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
    syncKeys();
    setTimeout(() => el.focus({ preventScroll: true }), 0);
    rectsSoon();
  }
  function act(what) {
    if (what === 'close') { closePanel(); mode = 'idle'; pose('idle'); idleSoon(1500); send({ type: 'close' }); if (spot()) sleepSoon(4000); return; }
    if (what === 'again') { send({ type: 'again' }); working(answerData && answerData.label || 'Again'); return; }
    if (what === 'copy') { send({ type: 'copy' }); closePanel(); mode = 'idle'; note('<span class="live">✓</span> Copied to the clipboard', 1800); return; }
    if (what === 'replace') { send({ type: 'replace' }); closePanel(); mode = 'busy'; return; }
  }
  // A short word beside the frog, then it hops away.
  function note(htmlText, ms, away = true) {
    closePill();
    const el = document.createElement('div'); el.className = 'pill'; el.setAttribute('role', 'status'); el.innerHTML = htmlText;
    pill = el; root.appendChild(el); placePill(el); rectsSoon();
    setTimeout(() => { if (pill === el) closePill(); if (away) rest(); }, ms);
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
    panel = el; root.appendChild(el); placePanel(el); syncKeys();
    setTimeout(() => el.focus({ preventScroll: true }), 0); rectsSoon();
  }

  // ---- keys (the host gives them only while a panel is open) ----
  document.addEventListener('keydown', e => {
    if (!panelUp()) { syncKeys(); return; } // keys with no panel: give them back
    if (e.target.id === 'ask') return;
    if (mode === 'answer') {
      if (e.key === 'Escape') { e.preventDefault(); act('close'); }
      else if (e.key === 'Enter') { e.preventDefault(); const go = panel.querySelector('.btn.go'); if (go) go.click(); }
      return;
    }
    if (mode !== 'menu') return;
    const rows = [...panel.querySelectorAll('.row')], cur = Math.max(0, rows.findIndex(b => b.classList.contains('on')));
    if (e.key === 'Escape') { e.preventDefault(); closePanel(); mode = 'idle'; idleSoon(2500); return; }
    if (panel.classList.contains('ctx')) return;
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
      else if (m.type === 'open') { if (here() && mode === 'idle') openMenu(); }
      else if (m.type === 'working') { if (here()) working(m.label); }
      else if (m.type === 'answer') { if (here()) answer(m); }
      else if (m.type === 'problem') { if (here()) problem(m); }
      else if (m.type === 'released') { wantKeys = false; closePanel(); if (here() && mode === 'idle') idleSoon(3000); }
      else if (m.type === 'done') { stopWorking(); if (here()) { pose('happy'); frog.classList.add('cheer'); sparkles(9); note(m.html || esc(m.text || 'Done'), m.ms || 2200); } }
      else if (m.type === 'hide') hopAway();
      else if (m.type === 'wake') { if (frog && mode === 'idle') wakeUp(m); }
      else if (m.type === 'sleep') { if (frog && mode === 'idle') goSleep(); }
      else if (m.type === 'theme') applyTheme(m.theme, m.systemDark);
    },
    get state() { return { mode, panel: panel && panel.className, words: S && S.words }; },
    // The host asks this while it gives the page the keys.
    get holdsKeys() { return wantKeys && panelUp(); },
  };
  send({ type: 'ready' });
})();
