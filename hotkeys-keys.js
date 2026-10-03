// Key combinations for hotkeys (design/93), shared by the page (recording
// a combination, showing it), the server (checking what is saved) and the
// computer helper (handing it to the desktop).
//
// One neutral spelling everywhere: modifiers in a fixed order, then the key,
// joined by "+" — "Super+Ctrl+G". Super is the Windows key on a PC and ⌘ on
// a Mac. Each desktop adapter (hotkeys-desktop.js) translates this into its
// own names; nothing else knows a desktop's spelling.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChatteringHotkeyKeys = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MODS = ['Super', 'Ctrl', 'Alt', 'Shift'];
  const MOD_ALIASES = {
    super: 'Super', win: 'Super', windows: 'Super', meta: 'Super', cmd: 'Super', command: 'Super', mod4: 'Super', logo: 'Super',
    ctrl: 'Ctrl', control: 'Ctrl', ctl: 'Ctrl',
    alt: 'Alt', option: 'Alt', opt: 'Alt', mod1: 'Alt',
    shift: 'Shift',
  };

  const NAMED = ['Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
    'Up', 'Down', 'Left', 'Right', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon',
    'Quote', 'Backquote', 'Comma', 'Period', 'Slash', 'Print', 'Pause'];
  const KEYS = [
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
    ...'0123456789'.split(''),
    ...Array.from({ length: 24 }, (_, i) => 'F' + (i + 1)),
    ...NAMED,
  ];
  const KEY_BY_LOWER = new Map(KEYS.map(k => [k.toLowerCase(), k]));
  const KEY_ALIASES = {
    return: 'Enter', esc: null, escape: null, del: 'Delete', ins: 'Insert', pgup: 'PageUp', pgdn: 'PageDown', prior: 'PageUp', next: 'PageDown',
    arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
    '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', ';': 'Semicolon',
    "'": 'Quote', apostrophe: 'Quote', '`': 'Backquote', grave: 'Backquote', ',': 'Comma', '.': 'Period', '/': 'Slash',
    printscreen: 'Print', prtsc: 'Print',
  };
  // What each key looks like on a keyboard, for people.
  const LABEL = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/', Up: '↑', Down: '↓', Left: '←', Right: '→' };

  function keyName(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const lower = s.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(KEY_ALIASES, lower)) return KEY_ALIASES[lower];
    return KEY_BY_LOWER.get(lower) || null;
  }

  /** "ctrl + super + g" → { mods: ['Super','Ctrl'], key: 'G' }, or throws with a sentence. */
  function parse(text) {
    const parts = String(text || '').split('+').map(p => p.trim());
    // "Ctrl++" names the plus key, which is Shift+Equal: not offered.
    if (!parts.length || parts.some(p => !p)) throw new Error('Write a combination like Super+Ctrl+G.');
    const mods = new Set();
    let key = null;
    for (const p of parts) {
      const m = MOD_ALIASES[p.toLowerCase()];
      if (m) { mods.add(m); continue; }
      if (key) throw new Error(`One key and some modifiers: ${key} and ${p} are both keys.`);
      key = keyName(p);
      if (!key) throw new Error(p.toLowerCase() === 'esc' || p.toLowerCase() === 'escape' ? 'Escape cannot be a hotkey: it closes things everywhere.' : `${p} is not a key a hotkey can use.`);
    }
    if (!key) throw new Error('Add a key after the modifiers (like Super+Ctrl+G).');
    const combo = { mods: MODS.filter(m => mods.has(m)), key };
    const problem = refusal(combo);
    if (problem) throw new Error(problem);
    return combo;
  }

  // A combination that would steal ordinary typing is refused: a letter or a
  // digit needs Ctrl, Alt or Super (Shift alone types a capital).
  function refusal(combo) {
    const strong = combo.mods.some(m => m !== 'Shift');
    if (strong) return null;
    if (/^F(1[3-9]|2[0-4])$/.test(combo.key) || combo.key === 'Pause') return null;
    return `${format(combo)} would take a key you type with. Add Super, Ctrl or Alt.`;
  }

  /** The neutral spelling: "Super+Ctrl+G". */
  function format(combo) {
    return [...MODS.filter(m => combo.mods.includes(m)), combo.key].join('+');
  }
  /** As people read it: "Super + Ctrl + G" (⌘ on a Mac). */
  function label(combo, { mac = false } = {}) {
    const c = typeof combo === 'string' ? parse(combo) : combo;
    const m = c.mods.map(x => (mac ? { Super: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }[x] : x));
    const k = LABEL[c.key] || c.key;
    return mac ? m.join('') + k : [...m, k].join(' + ');
  }
  /** Same combination? */
  function same(a, b) {
    try { return format(typeof a === 'string' ? parse(a) : a) === format(typeof b === 'string' ? parse(b) : b); } catch { return false; }
  }

  // A browser KeyboardEvent → the combination, or null while only modifiers
  // are held. The physical key (e.code) names it, so a French keyboard's A
  // and Q are where the person pressed them... and a combination recorded on
  // one layout means the same physical keys on the computer's desktop only
  // when both use the same layout, which is the common case.
  const CODE = {
    Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Minus: 'Minus', Equal: 'Equal', BracketLeft: 'BracketLeft', BracketRight: 'BracketRight', Backslash: 'Backslash', Semicolon: 'Semicolon',
    Quote: 'Quote', Backquote: 'Backquote', Comma: 'Comma', Period: 'Period', Slash: 'Slash', PrintScreen: 'Print', Pause: 'Pause',
  };
  function fromEvent(e) {
    const code = String(e.code || '');
    let key = null;
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
    else if (CODE[code]) key = CODE[code];
    if (!key) return null;
    const mods = [];
    if (e.metaKey) mods.push('Super');
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    return { mods, key };
  }

  return { MODS, KEYS, parse, format, label, same, refusal, fromEvent, keyName };
});
