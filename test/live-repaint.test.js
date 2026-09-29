const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// The live repaint budget in app.html: stream updates merge their data at
// once and paint together, so a busy agent cannot keep a slow device (or an
// e-ink screen) repainting several times a second.
const html = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
const start = html.indexOf('// ---- live repaint budget ----');
const end = html.indexOf('// Elapsed tick for run cards', start);
const code = html.slice(start, end);

function setup({ eink = false, chartCostMs = 5, tab = 'conv' } = {}) {
  let now = 1_000_000, perf = 0;
  const timers = [];
  const calls = { sort: 0, filter: 0, badges: 0, pop: 0, ticker: [], ctx: 0 };
  const listeners = {};
  const ctx = vm.createContext({
    Date: { now: () => now },
    performance: { now: () => perf },
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; },
    clearTimeout() {},
    document: { hidden: false, addEventListener: (type, fn) => { listeners[type] = fn; } },
    isEink: () => eink,
    tab,
    sessions: { sort() { calls.sort++; } },
    current: { key: 'a' }, activeRel: 'a',
    agentsPopT: null,
    setTicker: (key, title, kind) => calls.ticker.push([key, kind]),
    refreshCtxMeter: () => { calls.ctx++; },
    applyFilter: () => { calls.filter++; perf += chartCostMs; },
    updateLiveBadges: () => { calls.badges++; },
    renderAgentsPop: () => { calls.pop++; },
    renderNowCost: 0,
  });
  new vm.Script(code + '\n;globalThis.api = { liveRepaintSoon, livePending };').runInContext(ctx);
  const advance = ms => {
    now += ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      if (!timers.length || timers[0].at > now) break;
      timers.shift().fn();
    }
  };
  return { api: ctx.api, calls, advance, ctx, listeners };
}

test('a burst of updates paints once at once, then at most once a second', () => {
  const { api, calls, advance } = setup();
  api.livePending.ticker = { key: 'a', title: 't', kind: 'response' };
  api.liveRepaintSoon({ list: true });
  advance(0);
  assert.equal(calls.filter, 1, 'the first update after a quiet moment paints right away');
  for (let i = 0; i < 39; i++) {
    api.livePending.ticker = { key: 'b' + i, title: 't', kind: 'tool' };
    api.liveRepaintSoon({ list: true });
    advance(25); // 40 updates a second
  }
  assert.equal(calls.filter, 1, 'no second paint within the second');
  advance(25);
  assert.equal(calls.filter, 2, 'one second of updates is one more paint');
  assert.equal(calls.sort, 2);
  assert.deepEqual(calls.ticker.at(-1), ['b38', 'tool'], 'the ticker shows the newest update');
  api.livePending.ticker = { key: 'late', title: 't', kind: 'message' };
  api.liveRepaintSoon({ list: true });
  advance(999);
  assert.equal(calls.filter, 2);
  advance(1);
  assert.equal(calls.filter, 3, 'an update after a paint is not lost');
  assert.deepEqual(calls.ticker.at(-1), ['late', 'message']);
});

test('e-ink paints live updates at most every five seconds', () => {
  const { api, calls, advance } = setup({ eink: true });
  api.liveRepaintSoon({ list: true });
  advance(0);
  for (let i = 0; i < 19; i++) { api.liveRepaintSoon({ list: true }); advance(250); }
  assert.equal(calls.filter, 1, 'almost five seconds of updates, no second paint yet');
  advance(250);
  assert.equal(calls.filter, 2);
});

test('an expensive repaint stretches the gap to keep it under a tenth of the time', () => {
  const { api, calls, advance } = setup({ chartCostMs: 400 }); // a slow device: 400 ms per chart
  api.liveRepaintSoon({ list: true });
  advance(0);
  api.liveRepaintSoon({ list: true });
  advance(3900);
  assert.equal(calls.filter, 1, 'not before 4 s');
  advance(100);
  assert.equal(calls.filter, 2);
});

test('run progress repaints only the header signals and the side list, not the chart', () => {
  const { api, calls, advance } = setup();
  api.liveRepaintSoon();
  advance(0);
  assert.equal(calls.filter, 0);
  assert.equal(calls.sort, 0);
  assert.equal(calls.badges, 1);
  assert.equal(calls.pop, 1);
});

test('a hidden page paints nothing and catches up when it shows again', () => {
  const { api, calls, advance, ctx, listeners } = setup();
  ctx.document.hidden = true;
  api.liveRepaintSoon({ list: true });
  advance(5000);
  assert.equal(calls.filter + calls.badges + calls.pop, 0);
  ctx.document.hidden = false;
  listeners.visibilitychange();
  advance(0);
  assert.equal(calls.filter, 1, 'the missed list change is painted');
});

test('the context meter refetches once per paint, not once per update', () => {
  const { api, calls, advance } = setup();
  for (let i = 0; i < 10; i++) { api.livePending.ctx = true; api.liveRepaintSoon({ list: true }); }
  advance(0);
  advance(1000);
  assert.equal(calls.ctx, 1);
});
