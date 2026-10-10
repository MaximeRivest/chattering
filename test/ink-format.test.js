'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../ink-format.js');

const stroke = (x, y, t0, n = 6) => {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(x + i * 3.3, y + Math.sin(i) * 4.1, (i % 10) / 9);
  return { pts, w: 2.4, t0, dur: 400, color: '' };
};
const near = (a, b) => assert.ok(Math.abs(a - b) <= 0.051, `${a} ≈ ${b}`);

test('a note written and read back keeps every stroke to a tenth of a unit', () => {
  const note = F.empty({ title: 'Kitchen plan', paper: 'grid' });
  note.pages[0].strokes.push(stroke(100.04, 200.06, 1760101900000), stroke(500, 900.5, 1760101901000, 1));
  note.pages.push(F.blankPage());
  note.pages[1].strokes.push({ ...stroke(10, 20, 1760101902000), color: '#2255aa', w: 6 });
  const text = F.serialize(note);
  const back = F.parse(text);
  assert.equal(back.title, 'Kitchen plan');
  assert.equal(back.paper, 'grid');
  assert.equal(back.pages.length, 2);
  const [a, b] = [note.pages[0].strokes[0], back.pages[0].strokes[0]];
  assert.equal(b.pts.length, a.pts.length);
  for (let i = 0; i < a.pts.length; i += 3) { near(b.pts[i], a.pts[i]); near(b.pts[i + 1], a.pts[i + 1]); assert.ok(Math.abs(b.pts[i + 2] - a.pts[i + 2]) < 0.06); }
  assert.equal(b.t0, 1760101900000);
  assert.equal(b.dur, 400);
  assert.equal(back.pages[0].strokes[1].pts.length, 3, 'a dot is one point');
  assert.equal(back.pages[1].strokes[0].color, '#2255aa');
  assert.equal(back.pages[1].strokes[0].w, 6);
  // Written twice, the same text: saving an unchanged note changes nothing.
  assert.equal(F.serialize(back), text);
});

test('blank pages at the end are not written, but one page always is', () => {
  const note = F.empty();
  note.pages.push(F.blankPage(), F.blankPage());
  const back = F.parse(F.serialize(note));
  assert.equal(back.pages.length, 1);
  assert.match(F.serialize(note), /viewBox="0 0 1000 1414"/);
});

test('the file is an ordinary SVG an image viewer shows', () => {
  const note = F.empty();
  note.pages[0].strokes.push(stroke(1, 2, 3));
  const text = F.serialize(note);
  assert.match(text, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(text, /stroke="currentColor"/);
  assert.match(text, /<rect data-ink-paper="1" width="1000" height="1414" fill="#ffffff"/);
});

test('what Chattering did not write comes back out unchanged', () => {
  const foreign = `<?xml version="1.0"?>
<!-- made by hand -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1414" data-ink-format="1" data-paper="dots">
  <title>From elsewhere &amp; back</title>
  <metadata><x:thing xmlns:x="urn:x">kept</x:thing></metadata>
  <g data-ink-page="1">
    <g data-ink-layer="pen"><path d="M10 10 L20 20 L30 10" stroke-width="3"/><path d="M0 0 C 10 10 20 20 30 30"/></g>
    <g data-ink-layer="extra"><image href="sketch.png" x="10" y="10" width="200" height="100" data-by="ai"/><text x="5" y="9">a &lt; b</text></g>
    <circle cx="1" cy="1" r="2"/>
    <desc data-ink-text="1">milk, eggs</desc>
  </g>
</svg>`;
  const note = F.parse(foreign);
  assert.equal(note.title, 'From elsewhere & back');
  assert.equal(note.paper, 'dots');
  const page = note.pages[0];
  assert.equal(page.strokes.length, 1, 'a straight-line path is a stroke');
  assert.deepEqual(page.strokes[0].pts.filter((_, i) => i % 3 !== 2), [10, 10, 20, 20, 30, 10]);
  assert.equal(page.text, 'milk, eggs');
  const out = F.serialize(note);
  assert.match(out, /<path d="M0 0 C 10 10 20 20 30 30"\/>/, 'a curve is kept as it was');
  assert.match(out, /<image href="sketch.png" x="10" y="10" width="200" height="100" data-by="ai"\/>/);
  assert.match(out, /<text x="5" y="9">a &lt; b<\/text>/);
  assert.match(out, /<circle cx="1" cy="1" r="2"\/>/);
  assert.match(out, /<metadata><x:thing xmlns:x="urn:x">kept<\/x:thing><\/metadata>/);
  assert.match(out, /<desc data-ink-text="1">milk, eggs<\/desc>/);
  // And read again, nothing doubles.
  const again = F.parse(out);
  assert.equal(again.pages[0].extra.length, page.extra.length);
  assert.equal(F.serialize(again), out);
});

test('two devices that both wrote are merged without losing or doubling a stroke', () => {
  const base = F.empty();
  const s1 = stroke(10, 10, 1000), s2 = stroke(50, 50, 2000), s3 = stroke(90, 90, 3000), s4 = stroke(10, 300, 4000);
  base.pages[0].strokes.push(s1, s2);
  const baseRead = F.parse(F.serialize(base));
  // Here: erased s1, added s3. There (read back from disk): erased s2, added s4.
  const mine = F.parse(F.serialize(base)); mine.pages[0].strokes = [mine.pages[0].strokes[1], s3];
  const theirs = F.parse(F.serialize(base)); theirs.pages[0].strokes = [theirs.pages[0].strokes[0], s4];
  theirs.pages.push({ strokes: [stroke(1, 1, 5000)], extra: [], text: '' });
  const merged = F.merge(baseRead, mine, F.parse(F.serialize(theirs)));
  const starts = merged.pages[0].strokes.map(s => s.t0);
  assert.deepEqual(starts, [3000, 4000]);
  assert.equal(merged.pages.length, 2);
  assert.equal(merged.pages[1].strokes.length, 1);
  // Merging a copy with itself changes nothing.
  const same = F.merge(baseRead, baseRead, baseRead);
  assert.equal(F.serialize(same), F.serialize(baseRead));
});

test('simplify keeps the shape and drops redundant points', () => {
  const pts = [];
  for (let i = 0; i <= 100; i++) pts.push(i, 0, 0.5);
  const out = F.simplify(pts);
  assert.deepEqual(out, [0, 0, 0.5, 100, 0, 0.5]);
  const corner = [0, 0, 0.5, 5, 0, 0.5, 10, 0, 0.5, 10, 5, 0.5, 10, 10, 0.5];
  assert.deepEqual(F.simplify(corner).filter((_, i) => i % 3 !== 2), [0, 0, 10, 0, 10, 10]);
});

test('the eraser finds the strokes it touches', () => {
  const s = { pts: [0, 0, 0.5, 100, 0, 0.5], w: 2 };
  assert.equal(F.hits(s, 50, 5, 5), true);
  assert.equal(F.hits(s, 50, 20, 5), false);
  assert.equal(F.hits({ pts: [10, 10, 0.5], w: 2 }, 12, 12, 2), true);
});

test('outlines are closed paths, dots are circles', () => {
  assert.equal(F.outline({ pts: [10, 10, 0.5], w: 2 }), 'M9 10a1 1 0 1 0 2 0a1 1 0 1 0 -2 0Z');
  const d = F.outline({ pts: [0, 0, 0.2, 10, 0, 0.5, 20, 5, 0.9], w: 2 });
  assert.match(d, /^M[\d.-]+ [\d.-]+.*A.*A.*Z$/);
  assert.ok(!/NaN/.test(d));
});

test('note file names sort by time and never collide', () => {
  const d = new Date(2026, 9, 10, 14, 5);
  assert.equal(F.fileName(d), '2026-10-10-1405.ink.svg');
  assert.equal(F.fileName(d, 2), '2026-10-10-1405-2.ink.svg');
  assert.ok(F.isInkPath('/a/b/' + F.fileName(d)));
  assert.ok(!F.isInkPath('/a/b/c.svg'));
});
