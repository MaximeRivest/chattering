'use strict';
// ink-format.js — the file a handwritten note is (design/98).
//
// A note is one SVG file, `<name>.ink.svg`: any browser, file manager,
// GitHub page or image tool shows it as what it is, and the strokes stay
// exact for Chattering to edit again. One file format, read and written by
// the page (ink-editor.js) and by the server (ink-notes.js) with this same
// code, so what one writes the other reads.
//
//   <svg … viewBox="0 0 1000 H" data-ink-format="1" data-paper="lines">
//     <title>…</title>
//     <g data-ink-page="1" transform="translate(0 0)">
//       <rect …/>                                  paper (written, never read)
//       <g data-ink-layer="pen" …>
//         <path d="M120.5 300.2l.4.1…" stroke-width="2.4" data-p="4567…" data-t="1760101900000 830"/>
//       </g>
//       <g data-ink-layer="extra">…</g>          anything else, kept verbatim
//       <desc data-ink-text="1">…</desc>          the page as text, once read
//     </g>
//   </svg>
//
// Units: a page is 1000 wide and 1414 tall (A4's ratio), whatever the
// screen; coordinates are page-local, at a tenth of a unit (about 0.02 mm on
// A4). A stroke's centre line is its path: absolute first point, then
// relative steps, which keeps the file small. Its pressure is one digit per
// point (0–9) in data-p; data-t is when it began (ms since 1970) and how long
// it took. A path without data-p is still a stroke (uniform pressure).
//
// What Chattering did not write is never lost: a page's other elements go to
// its extra layer and come back out unchanged, and so do unknown elements at
// the top level. That is where later layers live (an AI's sketch, a pasted
// picture, typed text placed on the page) without a format change.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InkFormat = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const FORMAT = 1;
  const PAGE_W = 1000;
  const PAGE_H = 1414;
  const PAGE_GAP = 24;
  const PAPERS = ['blank', 'lines', 'grid', 'dots'];
  const DEFAULT_PAPER = 'lines';
  const INK_PATH = /\.ink\.svg$/i;

  // ---- a small XML reader: enough for SVG, and for any SVG a person or a
  // tool put in a note (comments, CDATA, processing instructions, entities).
  function parseXml(text) {
    const rootNode = { tag: '#root', attrs: {}, children: [] };
    const stack = [rootNode];
    const s = String(text || '');
    let i = 0;
    const top = () => stack[stack.length - 1];
    while (i < s.length) {
      const lt = s.indexOf('<', i);
      if (lt < 0) { pushText(top(), s.slice(i)); break; }
      if (lt > i) pushText(top(), s.slice(i, lt));
      if (s.startsWith('<!--', lt)) {
        const end = s.indexOf('-->', lt + 4);
        const stop = end < 0 ? s.length : end + 3;
        top().children.push({ raw: s.slice(lt, stop) });
        i = stop; continue;
      }
      if (s.startsWith('<![CDATA[', lt)) {
        const end = s.indexOf(']]>', lt + 9);
        const stop = end < 0 ? s.length : end + 3;
        top().children.push({ raw: s.slice(lt, stop) });
        i = stop; continue;
      }
      if (s[lt + 1] === '?' || s[lt + 1] === '!') {
        const end = s.indexOf('>', lt);
        i = end < 0 ? s.length : end + 1; // declarations are rewritten on save
        continue;
      }
      if (s[lt + 1] === '/') {
        const end = s.indexOf('>', lt);
        const name = s.slice(lt + 2, end < 0 ? s.length : end).trim();
        // Close up to the matching open tag; a stray close tag is ignored.
        for (let k = stack.length - 1; k > 0; k--) if (stack[k].tag === name) { stack.length = k; break; }
        i = end < 0 ? s.length : end + 1; continue;
      }
      // An open tag: name, then attributes (quoted values may hold '>').
      let j = lt + 1;
      while (j < s.length && !/[\s/>]/.test(s[j])) j++;
      const node = { tag: s.slice(lt + 1, j), attrs: {}, children: [] };
      let selfClose = false;
      while (j < s.length) {
        while (j < s.length && /\s/.test(s[j])) j++;
        if (s[j] === '>') { j++; break; }
        if (s[j] === '/' && s[j + 1] === '>') { selfClose = true; j += 2; break; }
        let k = j;
        while (k < s.length && !/[\s=/>]/.test(s[k])) k++;
        const name = s.slice(j, k);
        j = k;
        while (j < s.length && /\s/.test(s[j])) j++;
        let value = '';
        if (s[j] === '=') {
          j++;
          while (j < s.length && /\s/.test(s[j])) j++;
          const q = s[j];
          if (q === '"' || q === "'") {
            const end = s.indexOf(q, j + 1);
            value = s.slice(j + 1, end < 0 ? s.length : end);
            j = end < 0 ? s.length : end + 1;
          } else {
            let e = j;
            while (e < s.length && !/[\s>]/.test(s[e])) e++;
            value = s.slice(j, e); j = e;
          }
        }
        if (name) node.attrs[name] = unescapeXml(value);
        else j++;
      }
      top().children.push(node);
      if (!selfClose) stack.push(node);
      i = j;
    }
    return rootNode;
  }
  function pushText(node, raw) { if (raw) node.children.push({ text: unescapeXml(raw) }); }
  function unescapeXml(v) {
    return String(v).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, c) => {
      const l = c.toLowerCase();
      if (l === 'amp') return '&'; if (l === 'lt') return '<'; if (l === 'gt') return '>';
      if (l === 'quot') return '"'; if (l === 'apos') return "'";
      const n = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    });
  }
  function escapeXml(v) { return String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
  function writeXml(node) {
    if (node.raw != null) return node.raw;
    if (node.text != null) return escapeXml(node.text);
    const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
    if (!node.children.length) return `<${node.tag}${attrs}/>`;
    return `<${node.tag}${attrs}>${node.children.map(writeXml).join('')}</${node.tag}>`;
  }
  const elements = node => node.children.filter(c => c.tag);
  const textOf = node => node.children.map(c => c.text != null ? c.text : c.tag ? textOf(c) : '').join('');

  // ---- strokes ----
  // { pts: [x, y, p, x, y, p, …] page units and pressure 0–1, w: width,
  //   t0: start ms, dur: ms, color: '' for the ink colour, else a CSS colour }
  const round1 = n => Math.round(n * 10);
  const tenth = n => { const s = (n / 10).toString(); return s.replace(/^(-?)0\./, '$1.'); };
  // Numbers joined the way SVG lets them: a minus sign separates, and so
  // does a leading dot after a number that already has one (".5.3" is .5, .3).
  function joinNums(nums) {
    let out = '', prev = '';
    for (const s of nums) {
      if (!out) out = s;
      else if (s[0] === '-' || (s[0] === '.' && prev.includes('.'))) out += s;
      else out += ' ' + s;
      prev = s;
    }
    return out;
  }
  function pathData(pts) {
    if (pts.length < 3) return '';
    let px = round1(pts[0]), py = round1(pts[1]);
    let d = 'M' + tenth(px) + ' ' + tenth(py);
    const steps = [];
    for (let i = 3; i < pts.length; i += 3) {
      const x = round1(pts[i]), y = round1(pts[i + 1]);
      steps.push(tenth(x - px), tenth(y - py));
      px = x; py = y;
    }
    if (steps.length) d += 'l' + joinNums(steps);
    return d;
  }
  const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
  // Reads M/m, L/l, H/h, V/v and Z: what a pen line is. A path with curves
  // is not one of ours; it stays in the extra layer as it is.
  function pathPoints(d) {
    const out = [];
    const re = /([MmLlHhVvZz])([^MmLlHhVvZzCcSsQqTtAa]*)/g;
    let x = 0, y = 0, m, seen = 0;
    const src = String(d || '');
    if (/[CcSsQqTtAa]/.test(src)) return null;
    while ((m = re.exec(src))) {
      const cmd = m[1], nums = (m[2].match(NUM) || []).map(Number);
      seen += m[0].length;
      if (cmd === 'Z' || cmd === 'z') continue;
      if (cmd === 'H' || cmd === 'h') { for (const n of nums) { x = cmd === 'H' ? n : x + n; out.push(x, y); } continue; }
      if (cmd === 'V' || cmd === 'v') { for (const n of nums) { y = cmd === 'V' ? n : y + n; out.push(x, y); } continue; }
      const rel = cmd === 'm' || cmd === 'l';
      for (let k = 0; k + 1 < nums.length; k += 2) {
        x = rel ? x + nums[k] : nums[k];
        y = rel ? y + nums[k + 1] : nums[k + 1];
        out.push(x, y);
      }
    }
    if (seen < src.replace(/\s+$/, '').length * 0.5) return null;
    return out;
  }

  function strokeFromPath(node) {
    const xy = pathPoints(node.attrs.d);
    if (!xy || xy.length < 2) return null;
    const press = String(node.attrs['data-p'] || '');
    const pts = [];
    for (let i = 0, k = 0; i + 1 < xy.length; i += 2, k++) {
      const digit = press.charCodeAt(k) - 48;
      pts.push(xy[i], xy[i + 1], digit >= 0 && digit <= 9 ? digit / 9 : 0.5);
    }
    const [t0, dur] = String(node.attrs['data-t'] || '').split(/\s+/).map(Number);
    const color = node.attrs.stroke && node.attrs.stroke !== 'currentColor' ? node.attrs.stroke : '';
    const w = Number(node.attrs['stroke-width']);
    return { pts, w: Number.isFinite(w) && w > 0 ? w : 2.4, t0: Number.isFinite(t0) ? t0 : 0, dur: Number.isFinite(dur) ? dur : 0, color };
  }
  function pathNode(stroke) {
    const attrs = { d: pathData(stroke.pts), 'stroke-width': String(Math.round((stroke.w || 2.4) * 10) / 10) };
    if (stroke.color) attrs.stroke = stroke.color;
    let press = '';
    for (let i = 2; i < stroke.pts.length; i += 3) press += String(Math.max(0, Math.min(9, Math.round(stroke.pts[i] * 9))));
    if (!/^5*$/.test(press)) attrs['data-p'] = press;
    if (stroke.t0) attrs['data-t'] = Math.round(stroke.t0) + ' ' + Math.max(0, Math.round(stroke.dur || 0));
    return { tag: 'path', attrs, children: [] };
  }

  // ---- the note ----
  function empty(opts = {}) {
    return { format: FORMAT, title: opts.title || '', paper: PAPERS.includes(opts.paper) ? opts.paper : DEFAULT_PAPER,
      created: opts.created || new Date().toISOString(), pages: [blankPage()], rest: [] };
  }
  function blankPage() { return { strokes: [], extra: [], text: '' }; }
  function isBlankPage(page) { return !page.strokes.length && !page.extra.length && !page.text; }

  function parse(text) {
    const tree = parseXml(text);
    const svg = elements(tree).find(n => n.tag === 'svg');
    if (!svg) throw new Error('not an SVG file');
    const note = empty({ paper: svg.attrs['data-paper'], created: svg.attrs['data-created'] || '' });
    note.pages = [];
    note.format = Number(svg.attrs['data-ink-format']) || 0;
    for (const child of svg.children) {
      if (!child.tag) { if (child.raw != null) note.rest.push(child); continue; }
      if (child.tag === 'title') { note.title = textOf(child).trim(); continue; }
      if (child.tag === 'desc' && !child.attrs['data-ink-text']) continue; // ours, rewritten
      if (child.tag === 'defs' && child.attrs['data-ink-paper'] != null) continue;
      if (child.tag === 'g' && child.attrs['data-ink-page'] != null) { note.pages.push(readPage(child)); continue; }
      note.rest.push(child);
    }
    if (!note.pages.length) note.pages.push(blankPage());
    return note;
  }
  function readPage(g) {
    const page = blankPage();
    for (const child of g.children) {
      if (!child.tag) { if (child.raw != null) page.extra.push(child); continue; }
      if (child.attrs['data-ink-paper'] != null) continue;
      if (child.tag === 'desc' && child.attrs['data-ink-text'] != null) { page.text = textOf(child); continue; }
      if (child.tag === 'g' && child.attrs['data-ink-layer'] === 'pen') {
        for (const p of child.children) {
          const stroke = p.tag === 'path' ? strokeFromPath(p) : null;
          if (stroke) page.strokes.push(stroke);
          else if (p.tag || p.raw != null) page.extra.push(p);
        }
        continue;
      }
      if (child.tag === 'g' && child.attrs['data-ink-layer'] === 'extra') { page.extra.push(...child.children.filter(c => c.tag || c.raw != null)); continue; }
      page.extra.push(child);
    }
    return page;
  }

  // The paper as it shows outside Chattering (inside, the page draws its own).
  function paperDefs(paper) {
    if (paper === 'lines') return '<pattern id="ink-paper" width="1000" height="44" patternUnits="userSpaceOnUse" y="10"><path d="M0 43.5H1000" stroke="#d6dbe3" stroke-width="1"/></pattern>';
    if (paper === 'grid') return '<pattern id="ink-paper" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0V40M0 40H40" stroke="#e1e5eb" stroke-width="1" fill="none"/></pattern>';
    if (paper === 'dots') return '<pattern id="ink-paper" width="40" height="40" patternUnits="userSpaceOnUse"><circle cx="20" cy="20" r="1.6" fill="#c3c9d2"/></pattern>';
    return '';
  }
  function serialize(note) {
    const pages = note.pages.slice();
    while (pages.length > 1 && isBlankPage(pages[pages.length - 1])) pages.pop();
    const height = pages.length * PAGE_H + (pages.length - 1) * PAGE_GAP;
    const paper = PAPERS.includes(note.paper) ? note.paper : DEFAULT_PAPER;
    const defs = paperDefs(paper);
    const out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 ${PAGE_W} ${height}" width="${PAGE_W}" height="${height}" color="#1d1f21" data-ink-format="${FORMAT}" data-paper="${paper}"${note.created ? ` data-created="${escapeXml(note.created)}"` : ''}>`);
    out.push(`<title>${escapeXml(note.title || 'Handwritten note')}</title>`);
    out.push('<desc>A handwritten note from Chattering. Each page is a group (data-ink-page); each pen stroke is a path: its centre line, data-p one pressure digit (0-9) per point, data-t its start (ms since 1970) and length (ms). Page size 1000 x 1414.</desc>');
    if (defs) out.push(`<defs data-ink-paper="1">${defs}</defs>`);
    pages.forEach((page, i) => {
      out.push(`<g data-ink-page="${i + 1}" transform="translate(0 ${i * (PAGE_H + PAGE_GAP)})">`);
      out.push(`<rect data-ink-paper="1" width="${PAGE_W}" height="${PAGE_H}" fill="#ffffff" stroke="#d0d4da" stroke-width="1"/>`);
      if (defs) out.push(`<rect data-ink-paper="1" width="${PAGE_W}" height="${PAGE_H}" fill="url(#ink-paper)"/>`);
      if (page.strokes.length) {
        out.push('<g data-ink-layer="pen" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">');
        for (const stroke of page.strokes) if (stroke.pts.length >= 3) out.push(writeXml(pathNode(stroke)));
        out.push('</g>');
      }
      if (page.extra.length) out.push(`<g data-ink-layer="extra">${page.extra.map(writeXml).join('')}</g>`);
      if (page.text) out.push(`<desc data-ink-text="1">${escapeXml(page.text)}</desc>`);
      out.push('</g>');
    });
    for (const node of note.rest) out.push(writeXml(node));
    out.push('</svg>');
    return out.join('\n') + '\n';
  }

  // ---- two copies of one note, merged (another device saved meanwhile) ----
  // A stroke is known by where and when it was drawn, so the same stroke
  // read back from the file (rounded to a tenth) is recognised. Strokes are
  // only ever added or erased, never moved, which makes this a set merge:
  // keep what this side has, add what the other side added since the common
  // version, drop what the other side erased since it. Nothing is doubled.
  function strokeKey(stroke, page) {
    const p = stroke.pts;
    return page + '|' + Math.round(stroke.t0 || 0) + '|' + round1(p[0] || 0) + ',' + round1(p[1] || 0) + '|' + (p.length / 3) + '|' + round1(p[p.length - 3] || 0) + ',' + round1(p[p.length - 2] || 0);
  }
  function keysOf(note) {
    const keys = new Set();
    note.pages.forEach((page, i) => { for (const s of page.strokes) keys.add(strokeKey(s, i)); });
    return keys;
  }
  function merge(base, mine, theirs) {
    const baseKeys = base ? keysOf(base) : new Set();
    const theirKeys = keysOf(theirs);
    const out = { ...mine, pages: [], rest: mine.rest };
    const n = Math.max(mine.pages.length, theirs.pages.length);
    for (let i = 0; i < n; i++) {
      const m = mine.pages[i] || blankPage();
      const t = theirs.pages[i] || blankPage();
      const page = { strokes: [], extra: m.extra.length ? m.extra : t.extra, text: m.text || t.text };
      const have = new Set();
      for (const s of m.strokes) {
        const k = strokeKey(s, i);
        if (baseKeys.has(k) && !theirKeys.has(k)) continue; // erased over there
        if (!have.has(k)) { have.add(k); page.strokes.push(s); }
      }
      for (const s of t.strokes) {
        const k = strokeKey(s, i);
        if (have.has(k) || baseKeys.has(k)) continue; // ours, or erased here
        have.add(k); page.strokes.push(s);
      }
      page.strokes.sort((a, b) => (a.t0 || 0) - (b.t0 || 0));
      out.pages.push(page);
    }
    if (base && mine.paper === base.paper) out.paper = theirs.paper;
    if (base && mine.title === base.title) out.title = theirs.title;
    return out;
  }

  // ---- drawing helpers shared by the page and future image rendering ----
  // Douglas-Peucker on the centre line, keeping each kept point's pressure:
  // fewer points, same line (tolerance in page units).
  function simplify(pts, tolerance = 0.35) {
    const n = pts.length / 3;
    if (n <= 2) return pts.slice();
    const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    const t2 = tolerance * tolerance;
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = pts[a * 3], ay = pts[a * 3 + 1], bx = pts[b * 3], by = pts[b * 3 + 1];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let worst = -1, at = -1;
      for (let i = a + 1; i < b; i++) {
        const px = pts[i * 3], py = pts[i * 3 + 1];
        let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const ex = ax + t * dx - px, ey = ay + t * dy - py;
        // Pressure changes count too: a line that thickens keeps its points.
        const dp = Math.abs(pts[i * 3 + 2] - (pts[a * 3 + 2] + t * (pts[b * 3 + 2] - pts[a * 3 + 2]))) * 4;
        const e = ex * ex + ey * ey + dp * dp;
        if (e > worst) { worst = e; at = i; }
      }
      if (worst > t2 && at > 0) { keep[at] = 1; stack.push([a, at], [at, b]); }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
    return out;
  }

  // The outline of a stroke whose width follows its pressure, as SVG path
  // data to fill: a smooth band along the centre line with round ends.
  // A sparse line (simplified, or written elsewhere with few points) gets
  // points in between along a Catmull-Rom curve through its own points, so
  // its outline bends smoothly instead of kinking at every corner.
  function densify(p, step = 4) {
    const n = p.length / 3;
    if (n < 3) return p;
    const out = [p[0], p[1], p[2]];
    for (let i = 0; i < n - 1; i++) {
      const x1 = p[i * 3], y1 = p[i * 3 + 1], x2 = p[i * 3 + 3], y2 = p[i * 3 + 4];
      const k = Math.min(24, Math.floor(Math.hypot(x2 - x1, y2 - y1) / step));
      if (k >= 1) {
        const a = Math.max(0, i - 1) * 3, d = Math.min(n - 1, i + 2) * 3;
        const x0 = p[a], y0 = p[a + 1], x3 = p[d], y3 = p[d + 1];
        for (let j = 1; j <= k; j++) {
          const t = j / (k + 1), t2 = t * t, t3 = t2 * t;
          const cr = (q0, q1, q2, q3) => 0.5 * (2 * q1 + (q2 - q0) * t + (2 * q0 - 5 * q1 + 4 * q2 - q3) * t2 + (3 * q1 - q0 - 3 * q2 + q3) * t3);
          out.push(cr(x0, x1, x2, x3), cr(y0, y1, y2, y3), p[i * 3 + 2] + (p[i * 3 + 5] - p[i * 3 + 2]) * t);
        }
      }
      out.push(x2, y2, p[i * 3 + 5]);
    }
    return out;
  }
  function outline(stroke, opts = {}) {
    const p = densify(stroke.pts), n = p.length / 3;
    const base = (stroke.w || 2.4) * (opts.scale || 1);
    const width = q => opts.uniform ? base : base * (0.55 + 0.9 * q);
    const f = v => Math.round(v * 100) / 100;
    if (n === 0) return '';
    if (n === 1 || (n === 2 && Math.hypot(p[3] - p[0], p[4] - p[1]) < 0.5)) {
      const r = width(p[2]) / 2, x = p[0], y = p[1];
      return `M${f(x - r)} ${f(y)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
    }
    const left = [], right = [];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let dx = p[b * 3] - p[a * 3], dy = p[b * 3 + 1] - p[a * 3 + 1];
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const r = width(p[i * 3 + 2]) / 2;
      left.push(p[i * 3] - dy * r, p[i * 3 + 1] + dx * r);
      right.push(p[i * 3] + dy * r, p[i * 3 + 1] - dx * r);
    }
    const side = (pts, start) => {
      // Quadratic curves through the midpoints: smooth, and exactly on the ends.
      let d = start ? `M${f(pts[0])} ${f(pts[1])}` : `L${f(pts[0])} ${f(pts[1])}`;
      for (let i = 2; i + 2 < pts.length; i += 2) {
        const mx = (pts[i] + pts[i + 2]) / 2, my = (pts[i + 1] + pts[i + 3]) / 2;
        d += `Q${f(pts[i])} ${f(pts[i + 1])} ${f(mx)} ${f(my)}`;
      }
      d += `L${f(pts[pts.length - 2])} ${f(pts[pts.length - 1])}`;
      return d;
    };
    const rev = [];
    for (let i = right.length - 2; i >= 0; i -= 2) rev.push(right[i], right[i + 1]);
    const rEnd = width(p[(n - 1) * 3 + 2]) / 2, rStart = width(p[2]) / 2;
    return side(left, true) + `A${f(rEnd)} ${f(rEnd)} 0 0 0 ${f(rev[0])} ${f(rev[1])}` + side(rev, false).replace(/^L[^QLA]*/, '') +
      `A${f(rStart)} ${f(rStart)} 0 0 0 ${f(left[0])} ${f(left[1])}Z`;
  }

  // Strokes near a point (page units): what an eraser at (x, y) touches.
  function hits(stroke, x, y, radius) {
    const p = stroke.pts, r = radius + (stroke.w || 2.4) / 2, r2 = r * r;
    if (p.length === 3) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= r2;
    for (let i = 3; i < p.length; i += 3) {
      const ax = p[i - 3], ay = p[i - 2], bx = p[i], by = p[i + 1];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      let t = len2 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - x, ey = ay + t * dy - y;
      if (ex * ex + ey * ey <= r2) return true;
    }
    return false;
  }
  function bounds(stroke) {
    const p = stroke.pts;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
    return { x0, y0, x1, y1 };
  }

  // The file name of a note made at `date`, on this computer's clock.
  function fileName(date = new Date(), n = 1) {
    const z = v => String(v).padStart(2, '0');
    return `${date.getFullYear()}-${z(date.getMonth() + 1)}-${z(date.getDate())}-${z(date.getHours())}${z(date.getMinutes())}${n > 1 ? '-' + n : ''}.ink.svg`;
  }
  function isInkPath(p) { return INK_PATH.test(String(p || '')); }

  return { FORMAT, PAGE_W, PAGE_H, PAGE_GAP, PAPERS, DEFAULT_PAPER, empty, blankPage, isBlankPage, parse, serialize, merge, strokeKey,
    simplify, densify, outline, hits, bounds, pathData, pathPoints, fileName, isInkPath, parseXml, writeXml };
});
