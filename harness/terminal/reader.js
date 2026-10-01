'use strict';
// Terminal state → interaction document. Pure: same snapshot, same document.
//
// Every element keeps the buffer rows it came from (`rows`), so the page can
// always fall back to the faithful cells, and every action is defined as
// terminal input whose effect is checked against the next snapshot.
//
// Generic structures (no CLI knowledge):
//   rules     full-width box-drawing lines that frame regions
//   composer  the framed region holding the cursor, after a prompt glyph;
//             dim text there is a placeholder, not input
//   menu      rows under the composer shaped "  label   description";
//             the selected row is the one styled unlike its siblings
//   choice    a block of options where one row carries a marker glyph and
//             the others the same indent: a dialog the keyboard answers
//   status    a "working" line (spinner glyph, "esc to interrupt")
//   live      anything on screen not understood: kept, shown as cells
// A profile (profiles.js) adds the program's own marks and patterns.

const { PROFILES, screenRules } = require('./profiles');
const CLAUDE = PROFILES.claude, GENERIC = PROFILES.generic;

// A frame line: box-drawing across most of the width. It may carry a label
// inside ("── ⠦ Working ───", Pi), which is kept as the line's label.
const RULE_CH = /[─━═—-]/g;
const isRule = (l, cols) => {
  const t = l.text;
  if (t.length < cols * 0.6 || !/^[─━═—-]/.test(t)) return false;
  return (t.match(RULE_CH) || []).length >= t.length * 0.7;
};
const ruleLabel = l => l.text.replace(RULE_CH, ' ').replace(/\s+/g, ' ').trim();
const flags = run => run.s.split('|')[0];
const fgOf = runs => { const r = runs.find(x => x.t.trim()); return r ? r.s.split('|')[1] : ''; };

// Programs pad with no-break spaces (Claude Code: "❯\u00a0"): read them as spaces.
const nb = t => t.replace(/\u00a0/g, ' ');

function readDocument(snap, profileOrRules = CLAUDE) {
  const profile = screenRules(profileOrRules);
  const { cols, rows, base, cursor } = snap;
  const lines = snap.lines.map(l => ({ ...l, text: nb(l.text), runs: l.runs.map(r => ({ s: r.s, t: nb(r.t) })) }));
  const top = base, bottom = Math.min(lines.length, base + rows); // the visible screen
  const used = new Set();
  // Reprinted rows: at each restart, the longest run of earlier rows that
  // the restart prints again (old tail = new head) is the same content, not
  // new; it is left out. Blank rows alone never count as a match.
  const superseded = new Set();
  for (const at of snap.restarts || []) {
    let best = 0;
    for (let k = Math.min(at, lines.length - at, 600); k > 0; k--) {
      let ok = true, ink = 0;
      for (let i = 0; i < k && ok; i++) { const a = lines[at - k + i].text, b = lines[at + i].text; if (a !== b) ok = false; else if (a.trim()) ink++; }
      if (ok && ink) { best = k; break; }
    }
    for (let y = at - best; y < at; y++) superseded.add(y);
  }
  const doc = { profile: profile.name, revision: snap.revision, mode: 'unknown', transcript: [], composer: null, menu: null, choice: null, status: null, footer: [], live: [], panel: false };

  // ---- rules framing the cursor: the composer ----
  const rules = [];
  for (let y = top; y < bottom; y++) if (isRule(lines[y], cols)) rules.push(y);
  // The input box is a small framed region: the one holding the cursor, or
  // (a program that parks its cursor where it writes, as Pi does while it
  // answers) the bottom-most one, if it is in the lower half of the screen.
  const frames = [];
  for (let i = 0; i + 1 < rules.length; i++) if (rules[i + 1] - rules[i] >= 2 && rules[i + 1] - rules[i] <= 11) frames.push([rules[i], rules[i + 1]]);
  const holding = frames.find(([a, b]) => cursor.y > a && cursor.y < b);
  const lowest = frames.length && frames[frames.length - 1][0] >= top + rows / 2 ? frames[frames.length - 1] : null;
  let [above, below] = holding || lowest || [rules.filter(y => y < cursor.y).pop(), rules.find(y => y > cursor.y)];
  let cursorInBox = !!holding || (above != null && below != null && cursor.y > above && cursor.y < below);
  // No frame lines (Codex): the cursor's line starts with a prompt mark;
  // the box is that line and the indented lines that continue it, between
  // blank lines. `above`/`below` then stand for the lines around it.
  if ((above == null || below == null || below - above > 14) && cursor.y >= top && cursor.y < bottom) {
    let start = cursor.y;
    while (start > top && !profile.prompts.some(p => lines[start].text.startsWith(p + ' ') || lines[start].text === p) && /^ {2}\S/.test(lines[start].text)) start--;
    const t = lines[start].text;
    if (profile.prompts.some(p => t.startsWith(p + ' ') || t === p)) {
      let end = cursor.y;
      while (end + 1 < bottom && /^ {2}\S/.test(lines[end + 1].text)) end++;
      above = start - 1; below = end + 1;
      cursorInBox = true; // found from the cursor's own line: its column is the caret
    }
  }
  if (above != null && below != null && below > above + 1) {
    const body = [];
    for (let y = above + 1; y < below; y++) body.push(y);
    const first = lines[body[0]] && lines[body[0]].text;
    let glyph = first != null && profile.prompts.find(p => first.startsWith(p + ' ') || first === p);
    // No glyph: a small framed region holding the cursor is still an input
    // box; its text starts at its left padding.
    let offset = glyph ? glyph.length + 1 : 0;
    if (!glyph && profile.glyphless && body.length && body.length <= 12) {
      const pads = body.map(y => lines[y].text).filter(t => t.trim()).map(t => t.length - t.trimStart().length);
      offset = pads.length ? Math.min(...pads) : cursorInBox ? cursor.x : 1;
      if (offset <= 6) glyph = '';
    }
    if (glyph !== false && glyph != null && (glyph || profile.glyphless)) {
      let text = '', placeholder = '', caret = null, softWraps = 0;
      body.forEach((y, i) => {
        const l = lines[y];
        let col = 0, typed = '', all = '', anyTyped = false;
        for (const run of l.runs) {
          const isDim = flags(run).includes('d');
          for (const ch of run.t) {
            if (col >= offset) { all += ch; if (!isDim) typed += ch; if (!isDim && ch.trim()) anyTyped = true; }
            col++;
          }
        }
        // Dim text with nothing typed is the placeholder (spaces between its words are not dim).
        const dim = anyTyped ? '' : all;
        typed = anyTyped ? all.replace(/\s+$/, '') : '';
        // A line break here is either one the person typed or the program
        // wrapping a long line (the terminal does not record which). Read it
        // as a wrap when the next word would not have fitted on the line.
        let joint = '\n';
        if (i) {
          const prev = text.slice(text.lastIndexOf('\n') + 1), word = typed.trimStart().split(/\s/)[0] || '';
          if (prev.length + 1 + word.length > cols - offset - 4) { joint = ' '; softWraps++; }
        }
        if (y === cursor.y && cursorInBox) caret = text.length + (i ? 1 : 0) + Math.max(0, cursor.x - offset);
        text += (i ? joint : '') + typed;
        if (!typed && dim.trim()) placeholder = dim.trim();
      });
      // Trailing spaces are invisible; the cursor standing past the last
      // letter of its line shows them.
      if (caret != null && caret > text.length) text += ' '.repeat(caret - text.length);
      if (!text.trim()) text = '';
      if (caret != null) caret = Math.min(caret, text.length);
      doc.composer = { prompt: glyph, text, placeholder, caret, softWraps, rows: [above, ...body, below] };
      for (const y of doc.composer.rows) used.add(y);
      // A label in the frame (Pi: "⠦ Working") is the program's status.
      for (const y of [above, below]) {
        const label = lines[y] ? ruleLabel(lines[y]) : '';
        if (label && profile.frameWorkingRe.test(label)) doc.status = { working: true, text: label, rows: [y] };
      }

      // ---- what hangs under the composer: a menu, or a footer ----
      const items = [];
      for (let y = below + 1; y < bottom; y++) {
        const l = lines[y];
        // "  label   description", optionally after a selection marker (Pi: →).
        const m = /^(?: {0,6}([→❯›>▶]) +| {2,6})(\S.*?)\s{2,}(\S.*)$/.exec(l.text);
        if (m && (m[1] || !/^ {4,}/.test(l.text) || (items.length && items[0].marked !== undefined)) && !/^ {8,}/.test(l.text)) items.push({ label: m[2], detail: m[3], fg: fgOf(l.runs), marked: !!m[1], col: l.text.indexOf(m[3], l.text.indexOf(m[2]) + m[2].length), rows: [y] });
        else if (items.length && /^ {8,}\S/.test(l.text)) { const it = items[items.length - 1]; it.detail += ' ' + l.text.trim(); it.rows.push(y); }
        else if (!l.text.trim() && items.length) break;
        else if (!items.length) { if (l.text.trim()) doc.footer.push({ text: l.text.trim(), rows: [y] }); used.add(y); }
        else break;
      }
      // A menu's descriptions start in one column; a status footer's right-
      // aligned fields do not.
      const starts = new Map(); for (const it of items) starts.set(it.col, (starts.get(it.col) || 0) + 1);
      const aligned = items.length >= 2 && Math.max(...starts.values()) >= Math.max(2, items.length * 0.6);
      if (!aligned) { for (const it of items) { doc.footer.push({ text: it.label + '  ' + it.detail, rows: it.rows }); for (const y of it.rows) used.add(y); } items.length = 0; }
      if (items.length >= 2) {
        // The selected row is styled unlike the others (here: another colour).
        const count = new Map(); for (const it of items) count.set(it.fg, (count.get(it.fg) || 0) + 1);
        const marked = items.findIndex(it => it.marked);
        const odd = marked >= 0 ? marked : items.findIndex(it => count.get(it.fg) === 1);
        doc.menu = { items: items.map((it, i) => ({ label: it.label, detail: it.detail, selected: i === odd, rows: it.rows })), selected: odd };
        for (const it of items) for (const y of it.rows) used.add(y);
      } else if (items.length === 1) { doc.footer.push({ text: items[0].label + '  ' + items[0].detail, rows: items[0].rows }); used.add(items[0].rows[0]); }
    }
  }

  // ---- a choice dialog: one marked option, siblings at its indent ----
  const marker = new RegExp('^(\\s*)(' + profile.markers.map(m => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\s+(\\S.*)$');
  for (let y = top; y < bottom && !doc.choice; y++) {
    if (used.has(y)) continue;
    const m = marker.exec(lines[y].text);
    if (!m) continue;
    const indent = m[1].length, lead = ' '.repeat(indent + m[2].length + 1);
    const opts = [];
    let s = y; while (s - 1 >= top && lines[s - 1].text.startsWith(lead) && !used.has(s - 1) && /\S/.test(lines[s - 1].text.slice(lead.length, lead.length + 1))) s--;
    for (let r = s; r < bottom; r++) {
      const t = lines[r].text;
      if (r === y) opts.push({ label: m[3], selected: true, rows: [r] });
      else if (t.startsWith(lead) && /\S/.test(t[lead.length] || '')) opts.push({ label: t.slice(lead.length), selected: false, rows: [r] });
      else if (opts.length && t.startsWith(lead + '  ') && t.trim()) { const o = opts[opts.length - 1]; o.label += ' ' + t.trim(); o.rows.push(r); }
      else break;
    }
    if (opts.length < 2) continue;
    const first = opts[0].rows[0], last = opts[opts.length - 1].rows.slice(-1)[0];
    // The question: the text just above the options, up to a rule or the top.
    const q = [];
    for (let r = first - 1; r >= top && first - r <= 14; r--) { if (isRule(lines[r], cols) || used.has(r)) break; q.unshift(r); }
    while (q.length && !lines[q[0]].text.trim()) q.shift();
    let hint = null;
    for (let r = last + 1; r < Math.min(bottom, last + 4); r++) if (/enter|esc|confirm|cancel/i.test(lines[r].text)) { hint = { text: lines[r].text.trim(), rows: [r] }; break; }
    // Only a confident dialog is actionable: it says how to answer (a hint
    // line) or numbers its options. A marked line followed by an indented
    // one is also what an echoed two-line message looks like.
    const numbered = opts.filter(o => /^\d+\.\s/.test(o.label)).length >= 2;
    if (!hint && !numbered) continue;
    for (const o of opts) o.label = o.label.replace(/\s+/g, ' ').trim();
    doc.choice = {
      question: q.map(r => lines[r].text).join('\n').replace(/\n{3,}/g, '\n\n').trim(),
      options: opts.map((o, i) => ({ ...o, index: i, number: (/^(\d+)\.\s/.exec(o.label) || [])[1] || null, label: o.label.replace(/^\d+\.\s+/, '') })),
      selected: opts.findIndex(o => o.selected), hint, rows: [...q, ...opts.flatMap(o => o.rows), ...(hint ? hint.rows : [])],
    };
    for (const r of doc.choice.rows) used.add(r);
  }

  // ---- working status ----
  for (let y = top; y < bottom; y++) {
    if (used.has(y)) continue;
    const t = lines[y].text;
    if (doc.status) break;
    if (profile.workingRe.some(re => re.test(t))) { doc.status = { working: true, text: t.trim(), rows: [y] }; used.add(y); break; }
  }

  // ---- transcript: everything above the live area, scrollback included ----
  let liveTop = Math.min(...[doc.composer && doc.composer.rows[0], doc.choice && doc.choice.rows[0], doc.status && doc.status.rows[0]].filter(v => v != null), bottom);
  // No input box, dialog or status on screen: the program is showing a
  // panel of its own (Claude Code's /usage, /help, /config…). It is the
  // live part, drawn as the program drew it, from its first rule (or the
  // top of the screen) down; the keys answer it.
  if (liveTop === bottom && !doc.composer && !doc.choice && !doc.status) {
    let r = top; while (r < bottom && !isRule(lines[r], cols)) r++;
    const from = r < bottom ? r : top;
    // An almost empty screen (a program clearing it before it redraws) is
    // not a panel: three lines of text at least.
    let ink = 0; for (let y = from; y < bottom; y++) if (lines[y].text.trim() && !isRule(lines[y], cols)) ink++;
    if (ink >= 3) { liveTop = from; doc.panel = true; }
  }
  doc.liveTop = liveTop; // where the live part starts (rows above it are history)
  let block = null;
  const start = (kind, y, text) => { block = { kind, text, rows: [y], stable: y < base }; doc.transcript.push(block); };
  for (let y = 0; y < liveTop; y++) {
    if (used.has(y) || superseded.has(y)) continue;
    const l = lines[y], t = l.text;
    // A running step's dot blinks (Claude Code: "● Bash(…)" / "  Bash(…)"):
    // the same step with its dot off, when it starts a block after a blank
    // line and reads as a tool call.
    const dotOff = profile.bullets.length && /^ {2}[A-Z][\w-]*\(/.test(t) && y > 0 && !lines[y - 1].text.trim();
    if (profile.bullets.some(g => t.startsWith(g + ' ')) || dotOff) {
      const body = t.slice(2);
      start(/^[A-Z][\w-]*\(.*\)?\s*$/.test(body) || /^[A-Z][\w-]*\(/.test(body) ? 'tool' : 'assistant', y, body);
    } else if (profile.result && t.trimStart().startsWith(profile.result)) {
      if (block) { block.result = (block.result ? block.result + '\n' : '') + t.trimStart().slice(2).trim(); block.rows.push(y); }
      else start('other', y, t.trim());
    } else if (/^[❯>] \S/.test(t) && (!block || block.kind !== 'user')) {
      start('user', y, t.slice(2));
    } else if (block && (/^ {2}\S/.test(t) || /^ {2,}/.test(t) || (!t && block.kind !== 'notice'))) {
      if (block.result != null && t.trim()) block.result += '\n' + t.trim(); // a wrapped result line
      else block.text += '\n' + t.replace(/^ {2}/, '');
      block.rows.push(y); if (y >= base) block.stable = false;
    } else if (t.trim()) {
      if (!block || block.kind !== 'notice') start('notice', y, t); else { block.text += '\n' + t; block.rows.push(y); }
    }
  }
  // Lines the program wrapped (the next word would not have fitted) are one
  // line of the message; short lines keep their break. Same rule as the composer.
  const unwrap = text => text.split('\n').reduce((acc, line, i, all) => {
    if (!i) return line;
    const prev = acc.slice(acc.lastIndexOf('\n') + 1), word = line.trimStart().split(/\s/)[0] || '';
    return acc + (line.trim() && prev.length + 1 + word.length > cols - 6 ? ' ' + line.trimStart() : '\n' + line);
  }, '');
  for (const b of doc.transcript) { b.text = b.text.replace(/\n+$/, ''); if (b.kind === 'user' || b.kind === 'assistant') b.text = unwrap(b.text); for (const y of b.rows) used.add(y); }

  // ---- anything left on screen: kept as a live block of cells ----
  let live = null;
  // A panel is one block, blank lines and all (it is one thing on screen).
  const lastInk = (() => { for (let y = bottom - 1; y >= top; y--) if (!used.has(y) && lines[y].text.trim()) return y; return top - 1; })();
  for (let y = top; y < bottom; y++) {
    const blankInsidePanel = doc.panel && live && !lines[y].text.trim() && y < lastInk;
    if (used.has(y) || (!lines[y].text.trim() && !blankInsidePanel)) { live = null; continue; }
    if (!live) { live = { rows: [], lines: [] }; doc.live.push(live); }
    live.rows.push(y); live.lines.push(lines[y].runs);
  }

  doc.mode = doc.choice ? 'choice' : doc.status ? 'working' : doc.composer ? 'compose' : doc.panel ? 'panel' : 'unknown';
  return doc;
}

module.exports = { readDocument, CLAUDE, GENERIC };
