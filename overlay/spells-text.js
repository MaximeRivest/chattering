// spells-text.js — the text side of the frog's spells (design/94), shared
// by the overlay page (showing an answer) and the computer helper (what a
// replacement becomes), and tested in node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpellsText = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_DIFF_TOKENS = 4000; // past this a diff costs too much to be worth it

  // Words and the space between them, space kept (line breaks included).
  const tokens = s => String(s).split(/(\s+)/).filter(t => t !== '');
  const isSpace = t => /^\s+$/.test(t);

  /**
   * A word-level diff: [{ op: 'same' | 'del' | 'ins', text }], runs merged.
   * Removed words come before what replaces them, as a change review shows
   * them. The space between two removed words stays inside the removed run,
   * so a long removal still wraps like text.
   */
  function diff(before, after) {
    const a = tokens(before), b = tokens(after);
    if (a.length * b.length > MAX_DIFF_TOKENS * MAX_DIFF_TOKENS / 4) return [{ op: 'del', text: before }, { op: 'ins', text: after }];
    const n = a.length, m = b.length;
    // Longest common subsequence, by rows, in typed arrays.
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    const push = (op, text) => { const last = out[out.length - 1]; if (last && last.op === op) last.text += text; else out.push({ op, text }); };
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { push('same', a[i]); i++; j++; }
      else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { push('del', a[i]); i++; }
      else { push('ins', b[j]); j++; }
    }
    // A removed run's own space at its edges goes with it (the text around
    // keeps its own). Then a removed or added run that would touch a word
    // gets one shown space ('gap', not part of either text).
    const runs = [];
    for (const p of out) {
      if (p.op === 'del') { const core = p.text.trim(); if (core) runs.push({ op: 'del', text: core }); }
      else runs.push(p);
    }
    const merged = [];
    for (const p of runs) {
      const last = merged[merged.length - 1];
      if (last && last.op === p.op) { last.text += p.text; continue; }
      if (last && (p.op === 'del' || last.op === 'del') && !/\s$/.test(last.text) && !/^\s/.test(p.text)) merged.push({ op: 'gap', text: ' ' });
      merged.push({ ...p });
    }
    return merged;
  }

  // Words as compared for "is this the same text": lower case, letters and
  // digits only, so "hey" and "Hey," are one word.
  const plainWords = s => String(s).toLowerCase().split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}]+/gu, '')).filter(Boolean);
  function lcs(a, b) {
    let prev = new Uint32Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      const cur = new Uint32Array(b.length + 1);
      for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      prev = cur;
    }
    return prev[b.length];
  }
  /** The share of the text's words the answer keeps, from 0 (none) to 1 (all). */
  function kept(before, after) {
    const a = plainWords(before), b = plainWords(after);
    if (!a.length) return 0;
    if (a.length * b.length > 4e6) return 0;
    return lcs(a, b) / a.length;
  }

  /**
   * How to show an answer that replaces text: 'changes' when the edit is a
   * correction (it keeps most of the words: read best with the changes
   * marked), 'text' when it is a rewrite (shortened, translated, rephrased:
   * marking every word would hide the result). The person can switch.
   */
  function view(before, after) {
    return kept(before, after) >= 0.6 ? 'changes' : 'text';
  }

  /** The answer keeps the selection's leading and trailing space and line breaks. */
  function keepEdges(input, output) {
    const s = String(input);
    if (!s.trim()) return s;
    return s.match(/^\s*/)[0] + String(output).trim() + s.match(/\s*$/)[0];
  }

  // An icon for a spell from what its program does (the page draws them).
  const ICONS = [
    [/fix|grammar|spell|proof|correct/, 'fix'], [/translat|english|french|spanish|langu/, 'translate'],
    [/explain|summar|what|define|meaning/, 'explain'], [/polite|friendl|tone|kind|formal/, 'polite'],
    [/short|concise|trim|tl/, 'shorter'], [/long|expand|elaborat/, 'longer'], [/list|bullet|format|markdown|table/, 'format'],
  ];
  function iconFor(spell) {
    const s = (String(spell.program || '') + ' ' + String(spell.label || '')).toLowerCase();
    for (const [re, icon] of ICONS) if (re.test(s)) return icon;
    return 'spark';
  }

  /**
   * A letter for each spell in the book: its hotkey's letter when it has one
   * and that letter is free, else the first free letter of its name, else
   * any free letter. Returns the letters in the spells' order.
   */
  function letters(spells) {
    const taken = new Set(), out = new Array(spells.length).fill(null);
    const free = c => c && /^[A-Z]$/.test(c) && !taken.has(c);
    spells.forEach((s, i) => {
      const k = String(s.keys || '').split('+').pop();
      if (k && k.length === 1 && free(k.toUpperCase())) { out[i] = k.toUpperCase(); taken.add(out[i]); }
    });
    spells.forEach((s, i) => {
      if (out[i]) return;
      const name = String(s.label || s.program || '').toUpperCase().replace(/[^A-Z]/g, '');
      const c = [...name].find(free) || [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find(free) || null;
      out[i] = c;
      if (c) taken.add(c);
    });
    return out;
  }

  const words = s => String(s).trim().split(/\s+/).filter(Boolean).length;

  return { diff, kept, view, keepEdges, iconFor, letters, words, tokens };
});
