// The timeline's time axis with quiet time collapsed (design/75): gaps are
// found from the marks, drawn to scale while narrow and as a fixed break once
// wider, the mapping is invertible and continuous in the scale, and fitting a
// span accounts for its breaks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const TimelineChart = require('../timeline-chart.js');

const DAY = 86400000;
const { findGaps, Axis, scaleForSpan, quietLabel, BREAK_PX } = TimelineChart;
const t0 = Date.UTC(2026, 2, 1);

test('gaps are the quiet stretches between activity and before the end', () => {
  const marks = [
    { start: t0, end: t0 + DAY },
    { start: t0 + 0.5 * DAY, end: t0 + 2 * DAY },     // overlaps the first
    { start: t0 + 3 * DAY, end: t0 + 3.2 * DAY },     // one quiet day: not a gap
    { start: t0 + 40 * DAY, end: t0 + 41 * DAY },     // a long quiet stretch before it
  ];
  const gaps = findGaps(marks, t0 + 120 * DAY, 3 * DAY);
  assert.deepEqual(gaps, [
    { start: t0 + 3.2 * DAY, end: t0 + 40 * DAY },
    { start: t0 + 41 * DAY, end: t0 + 120 * DAY },
  ]);
  assert.deepEqual(findGaps(marks, t0 + 120 * DAY, 0), [], 'off without a threshold');
  assert.deepEqual(findGaps([], t0, 3 * DAY), []);
});

test('a gap is drawn to scale while narrow and as a fixed break once wider', () => {
  const gaps = [{ start: t0 + DAY, end: t0 + 91 * DAY }];
  const axis = new Axis(t0, 10, gaps);
  axis.setScale(0.1); // 90 days at 0.1 px/day: 9 px, narrower than a break
  assert.ok(Math.abs(axis.x(t0 + 91 * DAY) - (10 + 9.1)) < 1e-9);
  assert.deepEqual(axis.breaksIn(t0, t0 + 200 * DAY), []);
  axis.setScale(160); // days: the 90 quiet days take one break
  assert.ok(Math.abs(axis.x(t0 + 91 * DAY) - (10 + 160 + BREAK_PX)) < 1e-9);
  assert.ok(Math.abs(axis.x(t0 + 92 * DAY) - (10 + 320 + BREAK_PX)) < 1e-9);
  const [brk] = axis.breaksIn(t0, t0 + 200 * DAY);
  assert.equal(brk.width, BREAK_PX);
  assert.equal(brk.x, 170);
});

test('the mapping inverts, across breaks and before the start', () => {
  const axis = new Axis(t0, 8, [{ start: t0 + DAY, end: t0 + 30 * DAY }, { start: t0 + 31 * DAY, end: t0 + 200 * DAY }]);
  for (const scale of [0.05, 2, 160, 2400]) {
    axis.setScale(scale);
    for (const day of [-3, 0, 0.5, 1, 7, 30, 30.5, 31, 100, 200, 210]) {
      const t = t0 + day * DAY;
      assert.ok(Math.abs(axis.t(axis.x(t)) - t) < 1, `day ${day} at scale ${scale}`);
    }
  }
});

test('positions change continuously with the scale: zooming never jumps', () => {
  const gap = { start: t0 + DAY, end: t0 + 11 * DAY }; // 10 days: collapses at 4.8 px/day
  const axis = new Axis(t0, 0, [gap]);
  const at = scale => { axis.setScale(scale); return axis.x(t0 + 12 * DAY); };
  const threshold = BREAK_PX / 10;
  assert.ok(Math.abs(at(threshold * 0.999999) - at(threshold * 1.000001)) < 0.01);
});

test('fitting a span counts its breaks as breaks, not as the time they stand for', () => {
  const gaps = [{ start: t0 + DAY, end: t0 + 101 * DAY }];
  // From t0 to one day after the gap: two active days plus a break.
  const scale = scaleForSpan(gaps, t0, t0 + 102 * DAY, 800);
  const axis = new Axis(t0, 0, gaps);
  axis.setScale(scale);
  assert.ok(Math.abs(axis.x(t0 + 102 * DAY) - 800) < 0.5);
  assert.ok(Math.abs(scale - (800 - BREAK_PX) / 2) < 0.5, 'the two active days share what the break leaves');
  // Without gaps, the linear answer.
  assert.equal(scaleForSpan([], t0, t0 + 4 * DAY, 800), 200);
});

test('recent activity is counted without the quiet weeks', () => {
  const { activeSince } = TimelineChart;
  const gaps = [{ start: t0 + 2 * DAY, end: t0 + 50 * DAY }];
  assert.equal(activeSince(gaps, t0 + 51 * DAY, 0.5 * DAY), t0 + 50.5 * DAY, 'inside the latest stretch');
  assert.equal(activeSince(gaps, t0 + 51 * DAY, 3 * DAY), t0, 'one day after the gap, two before it');
  assert.equal(activeSince([], t0 + 10 * DAY, 3 * DAY), t0 + 7 * DAY);
});

test('a break says how long nothing happened', () => {
  assert.equal(quietLabel(4 * DAY), '4 days');
  assert.equal(quietLabel(21 * DAY), '3 weeks');
  assert.equal(quietLabel(125 * DAY), '4 months');
  assert.equal(quietLabel(800 * DAY), '2 years');
});
