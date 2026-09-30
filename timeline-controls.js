/* A small camera control surface. The chart owns motion and scale; this
 * adapter owns disclosure and keyboard discovery, never a second camera. */
(function (root) {
  'use strict';
  const PRESETS = Object.freeze({ hours: 6, days: 1, weeks: 0.15 });
  const ACTIONS = Object.freeze([
    { id: 'hours', label: 'Hours', key: 'H', hint: 'Shift+H' },
    { id: 'days', label: 'Days', key: 'D', hint: 'Shift+D / 0' },
    { id: 'weeks', label: 'Weeks', key: 'W', hint: 'Shift+W' },
    { id: 'out', label: 'Zoom out', key: '-', hint: '−' },
    { id: 'in', label: 'Zoom in', key: '+', hint: '+' },
    { id: 'now', label: 'Jump to now', key: 'n', hint: 'N / End' },
    { id: 'start', label: 'Oldest conversation', key: 'b', hint: 'B / Home' },
    { id: 'date', label: 'Go to date', key: 't', hint: 'T' },
    { id: 'help', label: 'Chart shortcuts', key: '?', hint: '?' },
  ]);
  const presetAt = scale => Object.keys(PRESETS).find(id => Math.abs(scale / PRESETS[id] - 1) < 1e-6) || null;
  function actionForKey(event) {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
        event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return null;
    const key = event.key;
    return ({ '=': 'in', '_': 'out', '0': 'days', Home: 'start', End: 'now' })[key] || ACTIONS.find(a => a.key === key)?.id || null;
  }
  const helpRows = () => [
    ...ACTIONS.filter(a => a.id !== 'help').map(a => [a.hint, a.label]),
    ['? / Esc', 'Open / close guide'],
    ['↑ ↓ · PgUp PgDn', 'Scroll projects'],
    ['Shift+PgUp/PgDn', 'Move through time'],
    ['Scroll · Shift+scroll', 'Move down / across'],
    ['Ctrl+scroll · pinch', 'Zoom at pointer / fingers'],
    ['One-finger drag', 'Move around chart'],
  ];

  function mount({ host, scroller, zoomTo, zoomBy, jumpNow, jumpStart, jumpDate, active = true, bottomInset = () => 0, canHandleKeys = () => true }) {
    const doc = host.ownerDocument, win = doc.defaultView;
    const abort = new AbortController(), signal = abort.signal;
    const on = (node, type, fn, options = {}) => node.addEventListener(type, fn, { ...options, signal });
    const read = key => { try { return win.localStorage.getItem('chattering.timeline.' + key) === '1'; } catch { return false; } };
    const save = (key, value) => { try { win.localStorage.setItem('chattering.timeline.' + key, value ? '1' : '0'); } catch {} };
    let pinned = read('controls'), guidePinned = read('guide'), opened = null, opener = null;
    const button = (id, text) => {
      const a = ACTIONS.find(a => a.id === id);
      return `<button type="button" data-action="${id}" title="${a.label} (${a.hint})" aria-label="${a.label}"${PRESETS[id] ? ' aria-pressed="false"' : ''}>${text || a.label}${!text ? `<kbd>${a.hint}</kbd>` : ''}</button>`;
    };
    host.classList.add('timeline-controls');
    host.innerHTML = `<div class="tc-inline"></div><button type="button" class="tc-scale" aria-expanded="false" aria-controls="timelineControlPanel" title="Time scale and navigation">Days ▾</button>${button('now', 'Now')}${button('help', '?')}`;
    const panel = doc.createElement('section');
    panel.id = 'timelineControlPanel';
    panel.className = 'timeline-control-panel';
    panel.setAttribute('popover', 'manual');
    panel.setAttribute('aria-label', 'Timeline controls');
    panel.innerHTML = `<div class="tc-heading"><strong></strong><button type="button" class="tc-close" aria-label="Close timeline controls">×</button></div>
      <div class="tc-settings"><div class="tc-camera"><div class="tc-presets" role="group" aria-label="Time scale">${['hours', 'days', 'weeks'].map(id => button(id)).join('')}</div><div class="tc-zoom" role="group" aria-label="Zoom">${button('out', '−')}${button('in', '+')}</div></div>
      <label class="tc-date">Go to date <kbd>T</kbd><input type="date" aria-label="Go to date"></label>
      ${button('start')}
      <label class="tc-pin"><input type="checkbox" data-pin="controls"> Keep controls visible</label></div>
      <div class="tc-guide"><p>Click the chart first. Shortcuts never run while typing.</p><table>${helpRows().map(([key, label]) => `<tr><td><kbd>${key}</kbd></td><td>${label}</td></tr>`).join('')}</table>
      <label class="tc-pin"><input type="checkbox" data-pin="guide"> Keep this guide open</label></div>`;
    doc.body.append(panel);
    const scaleButton = host.querySelector('.tc-scale'), helpButton = host.querySelector('[data-action="help"]');
    helpButton.setAttribute('aria-expanded', 'false');
    helpButton.setAttribute('aria-controls', panel.id);
    const camera = panel.querySelector('.tc-camera');
    const inline = host.querySelector('.tc-inline');
    const compact = win.matchMedia('(max-width: 700px)');
    function layout() {
      // Move the same buttons, rather than rendering a second set with its own state.
      (pinned && !compact.matches ? inline : panel.querySelector('.tc-settings')).prepend(camera);
      panel.querySelector('[data-pin="controls"]').checked = pinned;
      panel.querySelector('[data-pin="guide"]').checked = guidePinned;
      position();
    }
    function position() {
      if (!opened) return;
      const rect = host.getBoundingClientRect();
      const viewport = win.visualViewport;
      const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
      const width = viewport?.width || win.innerWidth;
      const height = Math.max(80, (viewport?.height || win.innerHeight) - bottomInset());
      panel.style.maxHeight = Math.max(80, height - 16) + 'px';
      panel.style.width = Math.min(350, width - 16) + 'px';
      panel.style.left = Math.max(left + 8, Math.min(rect.right - panel.offsetWidth, left + width - panel.offsetWidth - 8)) + 'px';
      panel.style.top = Math.max(top + 8, Math.min(rect.bottom + 6, top + height - panel.offsetHeight - 8)) + 'px';
    }
    function close(restore = false) {
      if (!opened) return false;
      opened = null;
      panel.hidePopover();
      scaleButton.setAttribute('aria-expanded', 'false');
      helpButton.setAttribute('aria-expanded', 'false');
      if (restore && opener?.isConnected && active) opener.focus({ preventScroll: true });
      return true;
    }
    function open(kind, focus = true) {
      if (!active) return;
      opener = kind === 'help' ? helpButton : scaleButton;
      opened = kind;
      const title = kind === 'help' ? 'Chart shortcuts' : 'Time & navigation';
      panel.querySelector('strong').textContent = title;
      panel.setAttribute('aria-label', title);
      panel.querySelector('.tc-settings').hidden = kind === 'help';
      panel.querySelector('.tc-guide').hidden = kind !== 'help';
      scaleButton.setAttribute('aria-expanded', String(kind === 'controls'));
      helpButton.setAttribute('aria-expanded', String(kind === 'help'));
      if (!panel.matches(':popover-open')) panel.showPopover();
      position();
      if (focus) (kind === 'help' ? panel.querySelector('.tc-close') : panel.querySelector('.tc-settings button, .tc-settings input')).focus({ preventScroll: true });
    }
    function dismiss(restore) {
      if (opened === 'help' && guidePinned) { guidePinned = false; save('guide', false); layout(); }
      close(restore);
    }
    function run(id) {
      if (PRESETS[id]) zoomTo(PRESETS[id]);
      else if (id === 'in' || id === 'out') zoomBy(id === 'in' ? 1.4 : 1 / 1.4);
      else if (id === 'now') jumpNow();
      else if (id === 'start') jumpStart();
      else if (id === 'date') { open('controls', false); panel.querySelector('[type="date"]').focus(); }
      else if (id === 'help') { if (opened === 'help') dismiss(true); else open('help'); }
    }
    on(host, 'click', e => {
      if (e.target.closest('.tc-scale')) { if (opened === 'controls') close(true); else open('controls'); }
      else { const id = e.target.closest('[data-action]')?.dataset.action; if (id) run(id); }
    });
    on(panel, 'click', e => {
      if (e.target.closest('.tc-close')) return dismiss(true);
      const id = e.target.closest('[data-action]')?.dataset.action;
      if (id) run(id);
    });
    on(panel, 'change', e => {
      if (e.target.type === 'date' && e.target.value) jumpDate(e.target.value);
      if (e.target.dataset.pin === 'controls') { pinned = e.target.checked; save('controls', pinned); layout(); }
      if (e.target.dataset.pin === 'guide') { guidePinned = e.target.checked; save('guide', guidePinned); }
    });
    on(doc, 'pointerdown', e => {
      if (opened && !(opened === 'help' && guidePinned) && !host.contains(e.target) && !panel.contains(e.target)) close();
    });
    on(doc, 'focusin', e => {
      if (opened && !(opened === 'help' && guidePinned) && !host.contains(e.target) && !panel.contains(e.target)) close();
    });
    on(doc, 'keydown', e => {
      if (opened && canHandleKeys() && e.key === 'Escape' && !e.isComposing) { e.preventDefault(); e.stopImmediatePropagation(); dismiss(true); }
    }, { capture: true });
    on(scroller, 'pointerdown', e => {
      if (!e.target.closest('button, a, input, select, textarea, [contenteditable]')) scroller.focus({ preventScroll: true });
    });
    on(compact, 'change', layout);
    on(win, 'resize', position);
    const resize = new ResizeObserver(position);
    resize.observe(host);
    if (win.visualViewport) { on(win.visualViewport, 'resize', position); on(win.visualViewport, 'scroll', position); }
    layout();
    if (active && guidePinned) open('help', false);
    return {
      updateScale(scale) {
        const id = presetAt(scale), label = id ? ACTIONS.find(a => a.id === id).label : 'Custom';
        if (scaleButton.textContent !== label + ' ▾') scaleButton.textContent = label + ' ▾';
        camera.querySelectorAll('[aria-pressed]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.action === id)));
      },
      setActive(value) {
        active = value;
        if (!active) close();
        else if (guidePinned && !opened) open('help', false);
      },
      handleKey(e) {
        if (!active || !canHandleKeys() || !(e.target === doc.body || scroller.contains(e.target) || host.contains(e.target) || panel.contains(e.target))) return false;
        const id = actionForKey(e);
        // Native controls retain Tab/Enter/Space; unbound arrow keys in the
        // popover must not navigate to another application screen.
        if (!id) return host.contains(e.target) || panel.contains(e.target);
        e.preventDefault(); run(id); return true;
      },
      destroy() { close(); abort.abort(); resize.disconnect(); panel.remove(); host.replaceChildren(); },
    };
  }
  const api = { PRESETS, ACTIONS, presetAt, actionForKey, helpRows, mount };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TimelineControls = api;
})(typeof window === 'object' ? window : globalThis);
