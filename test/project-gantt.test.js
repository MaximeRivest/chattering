const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TimelineChart = require('../timeline-chart.js');
const html = fs.readFileSync(require('node:path').join(__dirname, '../app.html'), 'utf8');
const source = html.slice(html.indexOf('function mgPaintOpen('), html.indexOf('// The open hero reuses'));
const focusSource = html.slice(html.indexOf('const QUIET_GAP_MS'), html.indexOf('function disposeHomeTimeline('));

const DAY = 86400000;

// The project adapter prepares data and controls; movement and DOM windowing
// belong to TimelineChart. This fixture stands at that boundary: a fake chart
// records what the adapter hands it.
function render(query = '', { scale = null } = {}) {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { clientWidth: 1200, scrollTop: 0, scrollLeft: 0, focus() {} });
    return nodes.get(selector);
  };
  const host = { clientWidth: 1200, setAttribute() {}, removeAttribute() {}, querySelector: node, querySelectorAll: () => [], innerHTML: '' };
  const items = [{ key: 'a', title: 'Long useful conversation title about navigation', timelineTitle: 'Nav', a: Date.now() - 30 * DAY, b: Date.now() - 29 * DAY }];
  const chart = { updates: 0, setData(data, options) { this.data = data; this.options = options; this.updates++; } };
  let mounts = 0;
  const context = {
    host, items, sessions: items,
    mgUI: { key: null, expanded: true, query, scale, center: null, top: 0 },
    mgLive: { host, items, color: null, chart: null },
    LABEL_H: TimelineChart.HEADER_HEIGHT, PX_DAY_BASE: 160, MG_LANE_H: 44, DAY_MS: DAY,
    matchMedia: () => ({ matches: false }), Date, Map, Math, esc: x => String(x), isActive: () => false,
    mgTip: () => '', hideMarkPop() {}, mgCollapseOpen() {},
    TimelineChart: class {
      static packLanes = TimelineChart.packLanes;
      static findGaps = TimelineChart.findGaps;
      static activeSince = TimelineChart.activeSince;
      constructor(options) { mounts++; chart.construction = options; return chart; }
    },
  };
  vm.createContext(context);
  vm.runInContext(focusSource + source + '\nmgPaintOpen(host, items, {stroke:"black",fill:"black"});', context);
  return { host, context, chart, mounts: () => mounts };
}

test('expanded project timeline uses readable titles and first opens on its recent work', () => {
  const { host, chart, context } = render();
  assert.equal(chart.construction.fitMinimum, true);
  assert.equal(chart.options.fit, undefined);
  // The only conversation ended 29 days ago: the view frames it (its last
  // day, with a little room), and the month since then is quiet time.
  const item = context.items[0];
  assert.ok(chart.options.focus.from < item.b - 2 * 3600e3 && chart.options.focus.from >= item.a - DAY, 'framed on the conversation');
  assert.equal(chart.data.collapseGapsMs, 3 * DAY);
  assert.equal(chart.data.marks.length, 1);
  assert.match(chart.data.marks[0].label, /Long useful conversation title abou/);
  assert.doesNotMatch(host.innerHTML, /max-height:/);
  assert.match(host.innerHTML, /tabindex="0" aria-label="Project conversation timeline"/);
});

test('a reopened project timeline restores its scale instead of refitting', () => {
  const { chart } = render('', { scale: 320 });
  assert.equal(chart.construction.scale, 320);
  assert.equal(chart.options.fit, undefined);
});

test('title search filters marks without changing the history extent', () => {
  const missing = render('missing');
  assert.equal(missing.chart.data.marks.length, 0);
  assert.equal(missing.chart.data.start, missing.context.items[0].a);
  assert.equal(render('navigation').chart.data.marks[0].attributes['data-mg'], 'a');
});

test('search updates the retained chart without replacing its input or scroller', () => {
  const result = render();
  const { host, chart, context } = result;
  const before = host.innerHTML;
  const search = host.querySelector('.mg-search');
  search.value = 'missing';
  search.oninput();
  assert.equal(context.mgUI.query, 'missing');
  assert.equal(result.mounts(), 1);
  assert.equal(chart.updates, 2);
  // The options object is made inside the vm context: compare its keys,
  // not its prototype.
  assert.deepEqual(Object.keys(chart.options), []);
  assert.equal(chart.data.marks.length, 0);
  assert.equal(host.innerHTML, before);
  assert.equal(host.querySelector('.mg-search'), search);
});

test('lanes pack in time, so zoom cannot move a conversation vertically', () => {
  const items = [
    { start: 0, end: 10 }, { start: 5, end: 12 }, { start: 11, end: 20 }, { start: 21, end: 21 },
  ];
  assert.equal(TimelineChart.packLanes(items), 2);
  assert.deepEqual(items.map(item => item.lane), [0, 1, 0, 0]);
});

test('calendar ticks step by readable spacing and mark days as major', () => {
  const start = new Date(2026, 0, 1, 0, 0, 0).getTime();
  const days = TimelineChart.ticks(start, start + 3 * DAY, 160);
  assert.equal(days.length, 4);
  assert.ok(days.every(tick => tick.major));
  const hours = TimelineChart.ticks(start, start + DAY, 2400);
  assert.equal(hours.length, 25);
  assert.equal(hours.filter(tick => tick.major).length, 2);
  const weeks = TimelineChart.ticks(start, start + 28 * DAY, 12);
  assert.ok(weeks.every(tick => new Date(tick.time).getDay() === 1));
});

test('inline scripts compile', () => {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc=/.test(match[1])) new Function(match[2]);
  }
});
