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

test('settling a line drops jitter, follows the pen, and ends where it lifted', () => {
  // A slow, shaky horizontal line: 400 samples, half a unit of noise.
  const raw = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < 400; i++) raw.push(100 + i * 0.5, 300 + rnd() * 1.0, 0.5 + rnd() * 0.4);
  const out = F.settle(raw);
  assert.ok(out.length / 3 < 60, 'far fewer points: ' + out.length / 3);
  const ys = out.filter((_, i) => i % 3 === 1);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 1.0, 'the jitter is smoothed away');
  assert.deepEqual(out.slice(-3, -1), raw.slice(-3, -1), 'it ends exactly where the pen lifted');
  assert.deepEqual(out.slice(0, 2), raw.slice(0, 2), 'and starts where it went down');
  const ps = out.filter((_, i) => i % 3 === 2);
  assert.ok(Math.max(...ps) - Math.min(...ps) < 0.4, 'pressure is low-passed');
  // Samples piling up on one spot (a slow corner) do not make a blob of points.
  const still = [];
  for (let i = 0; i < 50; i++) still.push(10 + i * 0.01, 10, 0.5);
  assert.ok(F.settle(still).length / 3 <= 2);
});

test('a stroke is drawn as discs and bands, tapered at the ends, wider when pressed', () => {
  assert.match(F.outline({ pts: [10, 10, 0.5], w: 2 }), /^M11\.55 10M8\.45 10a1\.55 1\.55 0 1 1 3\.11 0a1\.55 1\.55 0 1 1 -3\.11 0Z$/, 'a tap is a dot wider than the line');
  const line = { pts: [0, 0, 0.5, 100, 0, 0.5], w: 4 };
  const d = F.discs(line);
  const r = i => d[i * 3 + 2];
  const n = d.length / 3;
  assert.ok(r(0) < r(Math.floor(n / 2)) * 0.5, 'the tips are thinner');
  assert.ok(Math.abs(r(Math.floor(n / 2)) - 2 * F.pressureFactor(0.5)) < 1e-9);
  assert.ok(F.pressureFactor(1) > F.pressureFactor(0.5) && F.pressureFactor(0.5) > F.pressureFactor(0.05));
  assert.ok(!/NaN/.test(F.outline({ pts: [0, 0, 0.2, 10, 0, 0.5, 20, 5, 0.9, 20, 5, 0.9], w: 2 })));
  // Every part winds the same way, so one non-zero fill is their union.
  const parts = [];
  F.trace({ moveTo(x, y) { parts.push([[x, y]]); }, lineTo(x, y) { parts.at(-1).push([x, y]); }, arc() { parts.at(-1).push('arc'); }, closePath() {} }, { pts: [0, 0, 0.5, 30, 40, 0.9, 80, 10, 0.1, 20, 90, 0.5], w: 6 });
  for (const q of parts.filter(p => p.length === 4 && !p.includes('arc'))) {
    let a = 0; for (let k = 0; k < 4; k++) a += q[k][0] * q[(k + 1) % 4][1] - q[(k + 1) % 4][0] * q[k][1];
    assert.ok(a > 0, 'band winds like the discs');
  }
});

test('note file names sort by time and never collide', () => {
  const d = new Date(2026, 9, 10, 14, 5);
  assert.equal(F.fileName(d), '2026-10-10-1405.ink.svg');
  assert.equal(F.fileName(d, 2), '2026-10-10-1405-2.ink.svg');
  assert.ok(F.isInkPath('/a/b/' + F.fileName(d)));
  assert.ok(!F.isInkPath('/a/b/c.svg'));
});

test('pens: each has its own shape, kept in the file, and an unknown pen survives', () => {
  const straight = (dx, dy, p = 0.5) => Array.from({ length: 30 }, (_, i) => [100 + dx * i, 100 + dy * i, p]).flat();
  const mid = (stroke) => { const d = F.discs(stroke); const n = d.length / 3; return d[Math.floor(n / 2) * 3 + 2]; };
  // Calligraphy: a flat nib at 45°, wide across it, a hairline along it.
  const across = mid({ pts: straight(3, -3), w: 10, pen: 'calligraphy' }), along = mid({ pts: straight(3, 3), w: 10, pen: 'calligraphy' });
  assert.ok(across > along * 4, `across ${across} along ${along}`);
  // The highlighter's chisel: tall across a line of text, narrow up it.
  assert.ok(mid({ pts: straight(4, 0), w: 20, pen: 'highlighter' }) > mid({ pts: straight(0, 4), w: 20, pen: 'highlighter' }) * 2);
  // The brush answers pressure far more than the fineliner.
  const ratio = pen => mid({ pts: straight(4, 0, 0.9), w: 8, pen }) / mid({ pts: straight(4, 0, 0.15), w: 8, pen });
  assert.ok(ratio('brush') > 4 && ratio('fineliner') < 1.3, `brush ${ratio('brush')} fineliner ${ratio('fineliner')}`);
  // A ballpoint written before there were pens draws as it did (no pen field).
  assert.equal(F.penOf({}).label, 'Ballpoint');
  // Every pen has five sizes, growing.
  for (const id of F.PEN_ORDER) assert.ok(F.PENS[id].sizes.length === 5 && F.PENS[id].sizes.every((w, k, a) => !k || w > a[k - 1]), id);
  // In the file: data-pen, and what other viewers need; read back the same.
  const note = F.empty();
  note.pages[0].strokes.push({ pts: straight(3, 0), w: 19, t0: 1, dur: 1, color: '', pen: 'highlighter' },
    { pts: straight(3, 1), w: 3, t0: 2, dur: 1, color: '#5c5c5c', pen: 'pencil' },
    { pts: straight(3, 2), w: 3, t0: 3, dur: 1, color: '', pen: 'quill-of-the-future' });
  const text = F.serialize(note), back = F.parse(text);
  assert.match(text, /data-pen="highlighter" stroke="#f4c430" stroke-opacity="0.4"/, 'a pale band in an image viewer');
  assert.deepEqual(back.pages[0].strokes.map(s => [s.pen, s.color]), [['highlighter', ''], ['pencil', '#5c5c5c'], ['quill-of-the-future', '']]);
  assert.equal(F.serialize(back), text, 'byte for byte');
});

test('a thick line has a disc wherever a bend would open a gap between its bands', () => {
  // A wide marker around a gentle curve: the bend between steps is small,
  // but at this radius it would leave a visible wedge without a disc.
  const pts = [];
  for (let i = 0; i <= 120; i++) { const a = i / 120 * Math.PI; pts.push(500 + 200 * Math.cos(a), 500 - 200 * Math.sin(a), 0.5); }
  let discs = 0;
  F.trace({ moveTo() {}, lineTo() {}, closePath() {}, arc() { discs++; } }, { pts, w: 24, pen: 'marker' });
  const steps = F.discs({ pts, w: 24, pen: 'marker' }).length / 3;
  assert.ok(discs > steps * 0.9, `${discs} discs for ${steps} steps`);
  let thin = 0;
  F.trace({ moveTo() {}, lineTo() {}, closePath() {}, arc() { thin++; } }, { pts, w: 2, pen: 'ballpoint' });
  assert.ok(thin < discs / 3, 'a thin line still skips the discs it does not need: ' + thin);
});

// ---- typed text on a page (design/103) ----
const mono = s => s.length * 10; // a measure: 10 units a character

test('typed text wraps at spaces, inside a word only when it must, and comes back exact', () => {
  const lines = F.wrapText('one two three\n\nfourfivesixseven  end', 80, mono);
  assert.deepEqual(lines, [
    { s: 'one two ', soft: false }, { s: 'three', soft: true },
    { s: '', soft: false },
    { s: 'fourfive', soft: false }, { s: 'sixseven  ', soft: true }, { s: 'end', soft: true },
  ]);
  assert.equal(F.textOfLines(lines), 'one two three\n\nfourfivesixseven  end');
});

test('a typed block is an SVG text any viewer shows, and reads back as the same block', () => {
  const note = F.empty({ paper: 'lines' });
  const text = 'Groceries: eggs & <milk>\n  indented "quote"';
  note.pages[0].texts.push({ id: 'tabc', x: 60, y: 93, w: 200, size: 22, lh: 44, text, lines: F.wrapText(text, 200, mono), t0: 1760101900000 });
  note.pages[0].strokes.push(stroke(100, 300, 1760101901000));
  const svg = F.serialize(note);
  assert.match(svg, /<g data-ink-layer="text" fill="currentColor" font-family="[^"]+" xml:space="preserve"/);
  assert.match(svg, /<text data-ink-typed="tabc" x="60" y="93" font-size="22" data-w="200" data-lh="44" data-t="1760101900000"><tspan x="60" y="93">Groceries: eggs &amp; /);
  assert.match(svg, /data-soft="1"/, 'a wrapped line says it only wraps');
  const back = F.parse(svg);
  const b = back.pages[0].texts[0];
  assert.equal(b.text, text);
  assert.deepEqual([b.id, b.x, b.y, b.w, b.size, b.lh, b.t0], ['tabc', 60, 93, 200, 22, 44, 1760101900000]);
  assert.equal(back.pages[0].strokes.length, 1);
  assert.equal(F.serialize(back), svg, 'unchanged, byte for byte');
  assert.equal(F.isBlankPage(back.pages[0]), false);
  // Text alone makes a page written: a page with only typed text is not blank.
  const only = F.empty(); only.pages[0].texts.push(b);
  assert.equal(F.isBlankNote(only), false);
  assert.equal(F.isBlankNote(F.empty()), true);
});

test('typed text merges as a set: an edit on one side, a new block on the other, both kept', () => {
  const block = (id, text, x = 60) => ({ id, x, y: 93, w: 400, size: 22, lh: 44, text, lines: [{ s: text, soft: false }], t0: 1 });
  const base = F.empty(); base.pages[0].texts.push(block('a', 'first'), block('b', 'second'));
  const mine = F.parse(F.serialize(base)), theirs = F.parse(F.serialize(base));
  mine.pages[0].texts[0] = block('a', 'first, changed here');             // edited here
  theirs.pages[0].texts.splice(1, 1);                                    // removed there
  theirs.pages[0].texts.push(block('c', 'third, from the tablet', 200)); // added there
  const out = F.merge(base, mine, theirs);
  assert.deepEqual(out.pages[0].texts.map(b => b.text), ['first, changed here', 'third, from the tablet']);
  // The same block changed on both sides: both versions stay, nothing typed is lost.
  const t2 = F.parse(F.serialize(base)); t2.pages[0].texts[0] = block('a', 'first, changed there');
  assert.deepEqual(F.merge(base, mine, t2).pages[0].texts.map(b => b.text).sort(), ['first, changed here', 'first, changed there', 'second']);
});

test('typed lines sit on the paper\'s ruling', () => {
  assert.equal(F.baselineAt('lines', 0), 93);       // the first rule, 98
  assert.equal(F.baselineAt('lines', 98), 93);
  assert.equal(F.baselineAt('lines', 99), 137);
  assert.equal(F.baselineAt('grid', 50), 75);
  assert.ok(F.baselineAt('lines', 5000) < F.PAGE_H, 'never below the page');
});

test('a file with a text layer from elsewhere keeps what is not a typed block', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1414" data-ink-format="1"><g data-ink-page="1"><g data-ink-layer="text"><text data-ink-typed="x1" x="60" y="93">plain</text><rect width="5" height="5"/></g></g></svg>`;
  const note = F.parse(svg);
  assert.equal(note.pages[0].texts[0].text, 'plain');
  assert.equal(note.pages[0].extra[0].tag, 'rect', 'kept, in the extra layer');
});
