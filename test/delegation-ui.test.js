'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const D = require('../delegation-ui.js');
const task = (id, extra = {}) => ({ id, title: id, parentTaskId: null, parentKey: 'origin', key: 'child-' + id,
  parentEntryId: 'entry-a', status: 'running', review: 'unreviewed', createdAt: 1, ...extra });

test('recursive work uses only explicit ancestry and exact conversation/entry identity', () => {
  const index = D.indexTasks([
    task('a'), task('b', { parentTaskId: 'a', parentKey: 'child-a' }),
    task('c', { parentEntryId: 'entry-b' }), task('unrelated', { parentKey: 'other', cwd: '/same' }),
  ]);
  const scope = D.contextTasks(index, 'origin', 'entry-a');
  assert.deepEqual([...scope.selected], ['a', 'b']);
  assert.deepEqual([...scope.other], ['c']);
  assert.deepEqual(scope.selectedRoots, ['a']);
  assert.deepEqual(scope.roots, ['c']);
  assert.equal(D.contextTasks(index, 'child-a').self.id, 'a');
  assert.equal(D.contextTasks(index, 'other', 'entry-b').selected.size, 0);
  assert.deepEqual(D.parentTarget(index.byId.get('b')), { key: 'child-a', entryId: 'entry-a' });
});

test('cycles, missing parents, duplicate IDs, and invalid records remain bounded and discoverable', () => {
  const index = D.indexTasks([null, {}, task('a', { parentTaskId: 'b' }), task('b', { parentTaskId: 'a' }),
    task('orphan', { parentTaskId: 'missing' }), task('self', { parentTaskId: 'self' }),
    task('__proto__'), task('a', { title: 'new title', parentTaskId: 'b', updatedAt: 2 })]);
  assert.equal(index.tasks.length, 5);
  assert.equal(index.byId.get('a').title, 'new title');
  assert.equal(D.descendants(index, index.roots).size, 5);
  assert.equal(index.warnings.size, 3);
  assert.match(index.warnings.get('orphan'), /outside this snapshot/);
  assert.match(D.cancellationMessage(index, 'b'), /2 tasks/, 'cycle display repair must not undercount the recorded subtree');
  assert.deepEqual(D.indexTasks(null).roots, []);
});

test('a 2000-level task chain has no recursive stack limit or arbitrary truncation', () => {
  const tasks = Array.from({ length: 2000 }, (_, i) => task(String(i), {
    parentTaskId: i ? String(i - 1) : null, parentKey: i ? 'child-' + (i - 1) : 'origin',
  }));
  const index = D.indexTasks(tasks);
  assert.equal(D.descendants(index, index.roots).size, 2000);
  assert.equal(D.contextTasks(index, 'origin').all.size, 2000);
});

test('execution never accepts generated work or treats lost as success', () => {
  for (const status of ['planned', 'starting', 'running', 'succeeded', 'failed', 'cancelled', 'lost']) {
    assert.deepEqual(D.taskState({ status }), { execution: status, review: 'unreviewed' });
  }
  assert.deepEqual(D.taskState({ status: 'succeeded', review: 'accepted' }), { execution: 'succeeded', review: 'accepted' });
  assert.deepEqual(D.taskState({ status: 'done', review: 'read' }), { execution: 'unknown', review: 'unreviewed' });
});

test('process deduplication requires saved identity, never PID or cwd alone', () => {
  const index = D.indexTasks([task('a', { pid: 10, cwd: '/same', sessionPath: '/saved/a' })]);
  assert.equal(D.trackedProcess(index, { pid: 10, cwd: '/same' }), false);
  assert.equal(D.trackedProcess(index, { key: 'unrelated' }), false);
  assert.equal(D.trackedProcess(index, { key: 'child-a', pid: 99 }), true);
  assert.equal(D.trackedProcess(index, { sessionPath: '/saved/a' }), true);
  assert.equal(D.trackedProcess(index, { delegationId: 'a' }), true);
});

test('cancellation states the full subtree count and does not promise immediate termination', () => {
  const index = D.indexTasks([task('a'), task('b', { parentTaskId: 'a', status: 'succeeded' }), task('c', { parentTaskId: 'b' })]);
  assert.match(D.cancellationMessage(index, 'a'), /3 tasks/);
  assert.match(D.cancellationMessage(index, 'a'), /after the supervisor/);
  assert.match(D.cancellationMessage(index, 'a'), /Completed work stays saved/);
});

test('malicious labels escape HTML and detail payloads have bounded prompt, mode, and log text', () => {
  assert.equal(D.escape('<img src=x onerror="bad()">&\''), '&lt;img src=x onerror=&quot;bad()&quot;&gt;&amp;&#39;');
  const detail = D.detailText({ prompt: 'p'.repeat(30000), mode: 'm'.repeat(30000), logTail: 'l'.repeat(20000) + 'END' });
  assert.ok(detail.includes('p'.repeat(24000)) && !detail.includes('p'.repeat(24001)));
  assert.ok(detail.includes('m'.repeat(24000)) && !detail.includes('m'.repeat(24001)));
  assert.ok(detail.includes('END') && !detail.includes('l'.repeat(16001)));
  assert.match(detail, /Full log:/);
  assert.match(detail, /Standard error/);
});

// A small DOM fixture tests the actual controller with no packages, live
// APIs, model launches, browser profiles, or filesystem mutations.
class Node {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.doc = doc; this.children = []; this.dataset = {}; this.attrs = {}; this._text = ''; this.hidden = false; this.open = false; this.className = ''; }
  set textContent(value) { this._text = String(value); for (const child of this.children) child.parentNode = null; this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(_) { throw new Error('Delegation content must not use innerHTML'); }
  get isConnected() { return this === this.doc.body || !!this.parentNode?.isConnected; }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, before) {
    node.remove(); const i = before ? this.children.indexOf(before) : this.children.length;
    assert.ok(i >= 0); this.children.splice(i, 0, node); node.parentNode = this;
  }
  remove() { if (this.parentNode) { const siblings = this.parentNode.children; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; } }
  focus() { this.doc.activeElement = this; }
  click() { if (!this.disabled) return this.onclick?.(); }
  querySelectorAll(selector) {
    const name = selector.replace(/^\./, ''), out = [];
    const walk = n => { for (const c of n.children) { if (c.className.split(' ').includes(name)) out.push(c); walk(c); } };
    walk(this); return out;
  }
}
function fixture(t, tasks, overrides = {}) {
  const document = { createElement(tag) { return new Node(tag, this); } };
  document.body = document.createElement('body');
  const host = document.createElement('div'); document.body.append(host);
  const calls = [], opened = [], confirms = [];
  let records = tasks, isVisible = true, failure = false;
  const controller = D.createController({ document,
    visible: () => isVisible,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (failure) return { ok: false, json: async () => ({ error: 'offline' }) };
      if (url.includes('/detail?')) return { ok: true, json: async () => ({ prompt: '<script>bad()</script>', mode: { tools: ['read'] }, logTail: 'tail', sessionPath: '/saved/x' }) };
      if (url.endsWith('/control')) return { ok: true, json: async () => ({ ok: true }) };
      if (url.endsWith('/resume')) return { ok: true, json: async () => ({ ok: true, task: { id: 'a', attempt: 2 } }) };
      return { ok: true, json: async () => ({ tasks: records, revision: 'v1' }) };
    },
    openTarget: target => opened.push(target), confirm: message => { confirms.push(message); return true; },
    ...overrides,
  });
  t.after(() => controller.destroy());
  return { controller, document, host, calls, opened, confirms,
    setRecords: value => { records = value; }, hide: () => { isVisible = false; }, fail: () => { failure = true; } };
}
// A transcript root with one .dg-card host per `delegate` call, as renderConv emits them.
function cardHost(f, data) {
  const host = f.document.createElement('div'); host.className = 'dg-card';
  Object.assign(host.dataset, { dgKey: 'origin', dgEid: 'entry-a', dgTitle: '', dgOrdinal: '0', ...data });
  f.host.append(host); return host;
}
function find(node, predicate) { if (predicate(node)) return node; for (const child of node.children) { const found = find(child, predicate); if (found) return found; } }
function cls(node, name) { return find(node, n => n.className === name); }
function control(host, label) { return find(host, n => n.tagName === 'BUTTON' && n.textContent === label); }
function expand(node) { node.open = true; return node.ontoggle?.(); }
const settle = () => new Promise(resolve => setImmediate(resolve));

test('tree package membership matches raw entries and source sessions without inventing branch identity', () => {
  const index = D.indexTasks([task('a'), task('b', { parentKey: 'fork', parentEntryId: 'entry-a' })]);
  const view = D.contextTasks(index, 'origin', ['end-of-package'], {
    familyKeys: ['origin', 'fork'], entryRefs: [{ key: 'origin', id: 'entry-a' }],
  });
  assert.deepEqual([...view.selected], ['a']);
  assert.deepEqual([...view.other], ['b']);
});

test('the collapsed line carries state, time, size, and verdict as facts', () => {
  const now = 1_000_000;
  assert.equal(D.stateLine(task('a', { startedAt: now - 125_000 }), now), '● running · 2 min');
  assert.equal(D.stateLine(task('a', { status: 'succeeded', startedAt: 0, finishedAt: 90_000, steps: 76, files: 14 }), now), '✓ done · 2 min · 76 steps · 14 files · needs review');
  assert.equal(D.stateLine(task('a', { status: 'succeeded', review: 'accepted', steps: 1, files: 1 }), now), '✓ done · 1 step · 1 file · accepted');
  assert.equal(D.stateLine(task('a', { status: 'failed' }), now), '✗ failed');
  assert.equal(D.stateLine(task('a', { status: 'lost', workerAlive: true, createdAt: 0 }), now), '● still running');
  assert.equal(D.stateLine(task('a', { status: 'cancelled' }), now), '⏹ cancelled');
  assert.equal(D.stateLine(task('a', { status: 'running', cancelRequested: true, createdAt: 0 }), now), '◌ stopping');
  assert.equal(D.stateLine(task('a', { status: 'succeeded', paused: true }), now, { unread: true }), '✓ done · needs review · paused · unread');
  assert.equal(D.reviewWord(task('a', { status: 'failed', review: 'accepted' })), '', 'a verdict on failed work is not a success word');
  assert.equal(D.duration(3_600_000 * 2 + 60_000 * 5), '2 h 5 min');
});

test('a transcript call finds its record by result ID, then by launch entry and title, never by time', () => {
  const index = D.indexTasks([task('a', { title: 'first' }), task('b', { title: 'second' }), task('c', { parentEntryId: 'entry-z', title: 'first' })]);
  assert.equal(D.taskIdInResult('{"id": "0f0f0f0f-1111-2222-3333-444444444444", "status": "starting"}'), '0f0f0f0f-1111-2222-3333-444444444444');
  assert.equal(D.taskIdInResult('nothing here'), null);
  assert.equal(D.taskForCall(index, { key: 'origin', entryId: 'entry-a', taskId: 'b' }).id, 'b');
  assert.equal(D.taskForCall(index, { key: 'origin', entryId: 'entry-a', title: 'second' }).id, 'b');
  assert.equal(D.taskForCall(index, { key: 'origin', entryId: 'entry-a', title: 'first', ordinal: 5 }).id, 'a', 'ordinal never leaves the pool');
  assert.equal(D.taskForCall(index, { key: 'origin', entryId: 'entry-a', ordinal: 1 }).id, 'b');
  assert.equal(D.taskForCall(index, { key: 'other', entryId: 'entry-a', title: 'first' }), null);
});

test('tree nodes hang from the launching entry and from each other, and drop orphans instead of inventing parents', () => {
  const index = D.indexTasks([task('a', { createdAt: 10 }), task('b', { parentTaskId: 'a', parentKey: 'child-a', createdAt: 20 }),
    task('c', { parentTaskId: 'missing-elsewhere', parentKey: 'child-x', createdAt: 30 }), task('d', { parentKey: 'other', createdAt: 40 })]);
  const hosts = [{ id: 'n1', key: 'origin', active: true, entryIds: ['entry-a'] }, { id: 'n2', key: 'origin', active: false, entryRefs: [{ key: 'fork', id: 'entry-a' }] }];
  const nodes = D.treeNodes(index, ['origin'], hosts);
  assert.deepEqual(nodes.map(n => [n.id, n.parent, n.active]), [['dg:a', 'n1', false], ['dg:b', 'dg:a', false]], 'another session is never on this path');
  assert.equal(nodes[0].role, 'delegated');
  assert.equal(nodes[0].key, 'child-a');
  assert.equal(nodes[0].ts, new Date(10).toISOString());
  const forked = D.treeNodes(D.indexTasks([task('f', { parentKey: 'fork' })]), ['origin', 'fork'], hosts);
  assert.deepEqual(forked.map(n => [n.id, n.parent, n.active]), [['dg:f', 'n2', false]]);
});

test('the runner event bar summarizes what came back', () => {
  assert.equal(D.eventSummary('delegation-complete', 'Delegated work returned.\n- x: succeeded\n- y: failed\nInspect.'), '↩ 2 delegated results returned');
  assert.equal(D.eventSummary('delegation-complete', 'Delegated work returned.\n- x: succeeded'), '↩ 1 delegated result returned');
  assert.equal(D.eventSummary('delegation-review-pending', ''), '↩ delegated results wait for review');
  assert.equal(D.eventSummary('orchestrator-event', ''), '↩ orchestrator event');
});

test('cards render from text nodes, open the child, keep DOM identity, open state, and focus across snapshots', async t => {
  const evil = '<img src=x onerror="bad()">';
  const f = fixture(t, [task('a', { title: evil, model: 'openai/gpt-6', startedAt: 1, steps: 3 }), task('b', { title: 'by title', status: 'succeeded', summary: 'Ready for review.' })]);
  const hostA = cardHost(f, { dgId: 'a' }), hostB = cardHost(f, { dgTitle: 'by title', dgOrdinal: '0' });
  f.controller.attachCards(f.host);
  assert.match(cls(hostA, 'dg-state').textContent, /loading/);
  await f.controller.refresh();
  const box = find(hostA, n => n.className === 'dg');
  assert.ok(hostA.textContent.includes(evil));
  assert.equal(find(f.host, n => n.tagName === 'IMG'), undefined);
  assert.equal(cls(hostA, 'dg-model').textContent, 'gpt-6');
  assert.match(cls(hostA, 'dg-state').textContent, /^● running · .*3 steps$/);
  assert.equal(cls(hostA, 'dg-state').dataset.tone, 'live');
  assert.match(cls(hostB, 'dg-state').textContent, /^✓ done · needs review$/);
  assert.equal(cls(hostB, 'dg-v').textContent, 'Ready for review.');
  assert.equal(cls(hostB, 'dg-open').disabled, false);
  cls(hostB, 'dg-open').click();
  assert.deepEqual(f.opened, [{ key: 'child-b' }]);
  assert.equal(control(hostA, 'cancel…').hidden, false, 'live work can be cancelled');
  assert.equal(control(hostB, 'cancel…').hidden, true, 'finished work has no cancel');
  assert.equal(f.calls.filter(c => c.url.includes('/detail?')).length, 0, 'prompts and logs load only on disclosure');
  expand(box);
  const brief = find(hostA, n => n.className === 'dg-fold');
  expand(brief); await settle();
  assert.equal(f.calls.filter(c => c.url.includes('/detail?')).length, 1);
  assert.ok(cls(hostA, 'dg-md').textContent.includes('<script>bad()</script>'));
  const cancel = control(hostA, 'cancel…'); cancel.focus();
  f.setRecords([task('a', { title: evil, model: 'openai/gpt-6', status: 'succeeded', steps: 9 }), task('b', { title: 'by title', status: 'succeeded' })]);
  await f.controller.refresh();
  assert.equal(find(hostA, n => n.className === 'dg'), box, 'the card is patched, never rebuilt');
  assert.equal(box.open, true);
  assert.equal(f.document.activeElement, cancel);
  assert.match(cls(hostA, 'dg-state').textContent, /✓ done · 9 steps · needs review/);
  assert.equal(f.calls.filter(c => c.url.includes('/detail?')).length, 1, 'snapshot updates never read logs');
});

test('a card without a record says so and stays inert', async t => {
  const f = fixture(t, [task('a')]);
  const host = cardHost(f, { dgEid: 'entry-none', dgTitle: 'vanished' });
  f.controller.attachCards(f.host); await f.controller.refresh();
  assert.equal(cls(host, 'dg-open').textContent, 'vanished');
  assert.equal(cls(host, 'dg-open').disabled, true);
  assert.match(cls(host, 'dg-state').textContent, /no record/);
});

test('a delegated conversation shows one origin line that opens the exact launch entry and locks while a worker owns it', async t => {
  const f = fixture(t, [task('a', { status: 'running', workerAlive: true, role: 'spec writer' })], { titleForKey: key => key === 'origin' ? 'Parent title' : '' });
  f.controller.mount(f.host, { kind: 'conversation', key: 'child-a' });
  await f.controller.refresh();
  const origin = cls(f.host, 'dg-origin');
  assert.equal(origin.hidden, false);
  assert.equal(cls(origin, 'dg-open').textContent, 'Parent title');
  assert.match(cls(origin, 'dg-state').textContent, /spec writer · ● running/);
  assert.match(cls(origin, 'dg-lock').textContent, /a worker owns this conversation/);
  assert.equal(control(origin, 'cancel…').hidden, false);
  cls(origin, 'dg-open').click();
  assert.deepEqual(f.opened, [{ key: 'origin', entryId: 'entry-a' }]);
  f.setRecords([task('a', { status: 'succeeded', review: 'accepted', role: 'spec writer' })]);
  await f.controller.refresh();
  assert.match(cls(origin, 'dg-state').textContent, /✓ done · accepted by the parent/);
  assert.equal(cls(origin, 'dg-lock').hidden, true);
  f.controller.mount(f.host, { kind: 'conversation', key: 'origin' });
  assert.equal(origin.hidden, true, 'a conversation that was not delegated shows nothing');
  assert.throws(() => f.controller.mount(f.host, { kind: 'tree', key: 'origin' }), /tree gets nodes/);
});

test('controls confirm subtree cancellation, report requests, and never write review', async t => {
  const f = fixture(t, [task('a'), task('b', { parentTaskId: 'a', parentKey: 'child-a' })]);
  const host = cardHost(f, { dgId: 'a' });
  f.controller.attachCards(f.host); await f.controller.refresh();
  assert.equal(control(host, 'pause new work').hidden, false, 'a task with recorded descendants can pause them');
  await control(host, 'pause new work').click();
  assert.match(cls(host, 'dg-notice').textContent, /Running work continues/);
  f.setRecords([task('a', { paused: true }), task('b', { parentTaskId: 'a', parentKey: 'child-a' })]);
  await f.controller.refresh();
  assert.match(cls(host, 'dg-state').textContent, /paused/);
  await control(host, 'resume new work').click();
  await control(host, 'cancel…').click();
  assert.match(f.confirms[0], /2 tasks/);
  assert.match(cls(host, 'dg-notice').textContent, /Cancellation requested/);
  const mutations = f.calls.filter(c => c.options?.method === 'POST').map(c => JSON.parse(c.options.body));
  assert.deepEqual(mutations, [{ id: 'a', action: 'pause' }, { id: 'a', action: 'resume' }, { id: 'a', action: 'cancel' }]);
});

test('declining cancellation sends no mutation and controls show request failures', async t => {
  const f = fixture(t, [task('a')], { confirm: () => false });
  const host = cardHost(f, { dgId: 'a' });
  f.controller.attachCards(f.host); await f.controller.refresh();
  await control(host, 'cancel…').click();
  assert.equal(f.calls.filter(c => c.options?.method === 'POST').length, 0);
  f.fail();
  f.controller = { ...f.controller };
  const g = fixture(t, [task('a')]);
  const h2 = cardHost(g, { dgId: 'a' });
  g.controller.attachCards(g.host); await g.controller.refresh();
  g.fail(); await control(h2, 'cancel…').click();
  assert.match(cls(h2, 'dg-notice').textContent, /offline/);
});

test('hidden surfaces do not fetch and failures retain prior tasks', async t => {
  const f = fixture(t, [task('a')]);
  const host = cardHost(f, { dgId: 'a' });
  f.controller.attachCards(f.host); await f.controller.refresh();
  f.fail(); await f.controller.refresh();
  assert.equal(cls(host, 'dg-open').textContent, 'a', 'the last good snapshot stays');
  assert.match(f.controller.state().error, /offline|not available/);
  f.hide(); const count = f.calls.length;
  f.controller.visibilityChanged(); await f.controller.invalidate();
  assert.equal(f.calls.length, count);
});

test('an unread finished reply shows on its line without accepting it', async t => {
  const f = fixture(t, [task('a', { status: 'succeeded' }), task('b')], { unread: () => true });
  const done = cardHost(f, { dgId: 'a' }), live = cardHost(f, { dgId: 'b' });
  f.controller.attachCards(f.host); await f.controller.refresh();
  assert.match(cls(done, 'dg-state').textContent, /needs review · unread$/);
  assert.doesNotMatch(cls(live, 'dg-state').textContent, /unread/, 'live work is not a reply');
});

test('snapshot refreshes never navigate, fetch logs, or change scroller positions', async t => {
  const f = fixture(t, [task('a')]);
  f.host.scrollTop = 42; f.host.scrollLeft = 9;
  f.document.body.scrollTop = 210; f.document.body.scrollLeft = 0;
  cardHost(f, { dgId: 'a' });
  f.controller.attachCards(f.host); await f.controller.refresh();
  f.setRecords([task('a', { status: 'failed' }), task('b')]); await f.controller.invalidate();
  assert.deepEqual([f.host.scrollTop, f.host.scrollLeft, f.document.body.scrollTop], [42, 9, 210]);
  assert.deepEqual(f.opened, []);
  assert.ok(f.calls.every(call => call.url === '/api/delegations'));
});

test('fallback polling runs at 30 seconds only while an appropriate surface is visible', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, [task('a')]);
  f.controller.mount(f.host, { kind: 'conversation', key: 'child-a' }); await f.controller.refresh();
  const initial = f.calls.length;
  t.mock.timers.tick(29999); await settle();
  assert.equal(f.calls.length, initial);
  t.mock.timers.tick(1); await settle();
  assert.equal(f.calls.length, initial + 1);
  f.hide(); f.controller.visibilityChanged();
  t.mock.timers.tick(120000); await settle();
  assert.equal(f.calls.length, initial + 1);
});

test('concurrent invalidations share a request and reconcile one more snapshot afterward', async t => {
  let release;
  let calls = 0;
  const f = fixture(t, [], { fetch: async () => {
    calls++;
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ tasks: [task('a')] }) };
  } });
  const host = cardHost(f, { dgId: 'a' });
  f.controller.attachCards(f.host);
  const first = f.controller.refresh();
  const second = f.controller.invalidate();
  f.controller.invalidate();
  assert.equal(calls, 1);
  release(); await first; await second; await settle();
  assert.equal(calls, 2);
  assert.equal(cls(host, 'dg-open').textContent, 'a');
});

test('dispatching an entry route again restores the exact launch target without fork or branch calls', () => {
  const html = fs.readFileSync(require.resolve('../app.html'), 'utf8');
  const start = html.indexOf('function dispatchHash(h, { restore = false } = {}) {');
  const code = html.slice(start, html.indexOf('\nconst $ = id => document.getElementById', start));
  const opened = [];
  const reading = new Map();
  const context = vm.createContext({ open: (...args) => opened.push(args), viewKind: 'home',
    readerState: key => { if (!reading.has(key)) reading.set(key, { leaf: 'previously-read' }); return reading.get(key); },
    errToast: message => { throw new Error(message); } });
  new vm.Script(code).runInContext(context);
  const target = { key: 'saved/path & 100%.jsonl', entryId: 'raw-entry-<42>' };
  const hash = 'read=' + encodeURIComponent(JSON.stringify(target));
  context.dispatchHash(decodeURIComponent(hash));
  context.dispatchHash('child-conversation');
  context.dispatchHash(decodeURIComponent(hash));
  assert.deepEqual(opened, [[target.key, 'entry:' + target.entryId], ['child-conversation'], [target.key, 'entry:' + target.entryId]]);
  // Opening a conversation keeps the head its reader left (design/66): the
  // route never resets where reading and the next message continue.
  assert.equal(reading.size, 0);
});

test('resumed web activity and surviving workers keep cancellation live and say so', async t => {
  const records = [task('a', { status: 'succeeded', review: 'accepted' }),
    task('b', { parentTaskId: 'a', parentKey: 'child-a', status: 'succeeded', sessionActive: true }),
    task('c', { status: 'lost', workerAlive: true })];
  const f = fixture(t, records, { unread: () => true });
  const a = cardHost(f, { dgId: 'a' }), c = cardHost(f, { dgId: 'c' });
  f.controller.attachCards(f.host); await f.controller.refresh();
  assert.equal(control(a, 'cancel…').hidden, false, 'collapsed resumed descendant stays cancellable');
  assert.equal(control(c, 'cancel…').hidden, false, 'lost live worker stays cancellable');
  assert.match(cls(c, 'dg-state').textContent, /● still running/);
  assert.match(cls(c, 'dg-warn').textContent, /worker process is still alive/);
  assert.match(cls(a, 'dg-state').textContent, /accepted · unread/, 'the parent accepted; the person has not read it');
  const origin = f.controller.mount(f.host, { kind: 'conversation', key: 'child-b' });
  assert.match(cls(origin, 'dg-state').textContent, /● continuing/);
  assert.match(cls(origin, 'dg-lock').textContent, /still working/);
  f.setRecords(records.map(r => ({ ...r, sessionActive: false, workerAlive: false })));
  await f.controller.refresh();
  assert.equal(control(a, 'cancel…').hidden, true);
  assert.equal(control(c, 'cancel…').hidden, true);
  assert.equal(cls(origin, 'dg-lock').hidden, true);
});

test('real agent busy-key function includes terminal tasks with web or worker activity', () => {
  const html = fs.readFileSync(require.resolve('../app.html'), 'utf8');
  const start = html.indexOf('function agentBusyKeys() {');
  const code = html.slice(start, html.indexOf('\nfunction finishedUnreadSessions()', start));
  const index = D.indexTasks([task('web', { status: 'succeeded', sessionActive: true }),
    task('worker', { status: 'lost', workerAlive: true }), task('done', { status: 'succeeded' })]);
  const context = vm.createContext({ runningKeys: [], activeRuns: new Map(), agentsProcs: [],
    delegationUI: { index: () => index }, DelegationUI: D });
  new vm.Script(code).runInContext(context);
  assert.deepEqual([...context.agentBusyKeys()], ['child-web', 'child-worker']);
  assert.equal(D.trackedProcess(index, { key: 'child-web' }), true, 'deduplicated row remains counted through its task');
});

test('app scripts parse and integration uses separate task hosts and read-only navigation', () => {
  const html = fs.readFileSync(require.resolve('../app.html'), 'utf8');
  for (const [i, match] of [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].entries()) {
    if (match[1].trim()) new vm.Script(match[1], { filename: `app.html script ${i}` });
  }
  assert.ok(html.includes('<script src="/delegation-ui.js"></script>'));
  assert.ok(html.includes("['delegation-update', () => delegationUI.invalidate()]"), 'the live stream refreshes delegation state');
  assert.ok(html.includes("d.type === 'delegation-update'"));
  assert.ok(html.includes("$('agentsUnread').innerHTML ="));
  // The agents panel is an attention list. Delegated conversations are
  // normal rows there (parent named on the second line). Task cards live in
  // the parent transcript, the origin line in the child, nodes in the tree.
  assert.ok(html.includes('<div id="agentsUnread"></div>') && html.includes('<div id="agentsLegacy"></div>'));
  assert.ok(!html.includes('agentDelegations'));
  assert.ok(!html.includes("mountDelegationView('agents')"));
  assert.ok(!html.includes("mountDelegationView('tree')"));
  assert.ok(html.includes("delegationUI.attachCards($('conversationTranscript'))"));
  assert.ok(html.includes("DelegationUI.treeNodes(delegationUI.index(), familyKeys, hostNodes)"));
  const reader = fs.readFileSync(require.resolve('../conversation-reader.js'), 'utf8');
  new vm.Script(reader, { filename: 'conversation-reader.js' });
  assert.ok(reader.includes('class="dg-card" data-dg-key='));
  assert.ok(html.includes('<script src="/conversation-reader.js"></script>'));
  assert.ok(html.includes("[projectLink(s), esc(origin(key)), what].filter(Boolean)"), 'a delegated row names its parent on the second line');
  assert.ok(html.includes("d.messages.findIndex(m => m.eid === entryId)"));
  assert.ok(html.includes("if (h.startsWith('read='))"));
});

test('inbox attention: a worker counts only when no parent callback can reach a person', () => {
  const done = extra => task('x', { status: 'succeeded', delivery: 'web', ...extra });
  assert.equal(D.attentionState(done()), 'reported');
  assert.equal(D.attentionState(done({ notificationState: 'pending' })), 'reported');
  assert.equal(D.attentionState(done({ notificationState: 'delivered' })), 'reported');
  assert.equal(D.attentionState(done({ notificationState: 'blocked' })), 'unreported');
  assert.equal(D.attentionState(done({ notificationState: 'error' })), 'unreported');
  assert.equal(D.attentionState(done({ parentKey: null })), 'unreported');
  assert.equal(D.attentionState(done({ delivery: 'nextTurn' })), 'unreported');
  assert.equal(D.attentionState(done({ status: 'failed', delivery: 'none' })), 'unreported');
  assert.equal(D.attentionState(done({ status: 'running' })), 'silent');
  assert.equal(D.attentionState(done({ workerAlive: true })), 'silent');
  assert.equal(D.attentionState(done({ status: 'cancelled' })), 'silent');
  assert.equal(D.attentionState(done({ cancelRequested: true })), 'silent');
  assert.equal(D.attentionState(done({ notificationState: 'cancelled' })), 'silent');
  assert.equal(D.attentionState(null), 'silent');
});

test('orchestration progress counts the recorded subtree, not verdicts', () => {
  const index = D.indexTasks([
    task('a', { status: 'succeeded' }), task('b', { status: 'running' }),
    task('c', { parentTaskId: 'a', parentKey: 'child-a', status: 'failed' }),
    task('d', { parentTaskId: 'c', parentKey: 'child-c', status: 'succeeded', review: 'accepted' }),
    task('e', { parentTaskId: 'b', parentKey: 'child-b', status: 'lost' }),
    task('other', { parentKey: 'elsewhere', status: 'succeeded' }),
  ]);
  const p = D.progress(index, ['a', 'b']);
  assert.deepEqual(p, { total: 5, done: 4, live: 1, failed: 2, unreviewed: 1, quiet: 0 });
  assert.equal(D.progressLabel(p), '4/5 done · 2 failed · 1 to review');
  assert.equal(D.progressLabel(D.progress(index, [])), '');
  assert.equal(D.rootOf(index, 'd'), 'a');
  assert.equal(D.rootOf(index, 'other'), 'other');
});

test('a stopped worker offers continue and continue-as; done, cancelled, taken-over or contract stops do not', async t => {
  let picked = null;
  const f = fixture(t, [task('a', { status: 'failed', failure: { kind: 'usage-limit', message: '429', resumable: true }, model: 'openai/gpt-6' })],
    { pickModel: (_anchor, current, onPick) => { picked = current; onPick('anthropic/claude-x'); } });
  const host = cardHost(f, { dgId: 'a' });
  // Back-to-back refreshes coalesce; settle before reading the painted state.
  const settle = async () => { await f.controller.refresh(); await new Promise(r => setTimeout(r, 10)); await f.controller.refresh(); };
  f.controller.attachCards(f.host); await settle();
  assert.match(cls(host, 'dg-state').textContent, /stopped: usage limit/);
  assert.equal(control(host, 'continue').hidden, false);
  assert.equal(control(host, 'continue as…').hidden, false);
  await control(host, 'continue').click();
  assert.match(cls(host, 'dg-notice').textContent, /Attempt 2 started on the same session/);
  await control(host, 'continue as…').click();
  assert.equal(picked, 'openai/gpt-6');
  const posts = f.calls.filter(c => c.url.endsWith('/resume')).map(c => JSON.parse(c.options.body));
  assert.deepEqual(posts, [{ id: 'a', model: 'openai/gpt-6' }, { id: 'a', model: 'anthropic/claude-x' }]);
  for (const record of [task('a', { status: 'succeeded' }), task('a', { status: 'cancelled' }), task('a', { status: 'running' }),
    task('a', { status: 'failed', takenOver: { at: 1 } }), task('a', { status: 'failed', failure: { kind: 'contract', message: 'x', resumable: false } }),
    task('a', { status: 'lost', workerAlive: true })]) {
    f.setRecords([record]); await settle();
    assert.equal(control(host, 'continue').hidden, true, record.status + ' ' + JSON.stringify(record.failure || record.takenOver || ''));
  }
  f.setRecords([task('a', { status: 'lost', attempt: 2, failure: { kind: 'interrupted', message: 'gone', resumable: true } })]); await settle();
  assert.equal(control(host, 'continue').hidden, false);
  assert.match(cls(host, 'dg-state').textContent, /lost · .*attempt 2/);
  f.setRecords([task('a', { status: 'failed', takenOver: { at: 1 } })]); await settle();
  assert.match(cls(host, 'dg-state').textContent, /continued by you/);
  assert.match(cls(host, 'dg-warn').textContent, /continued this conversation yourself/);
});

test('quiet work: a running worker past the threshold says so on its line, its warning, and the counts', () => {
  const now = 10 * 3600000;
  const quiet = task('q', { status: 'running', startedAt: now - 5 * 3600000, quiet: { since: now - 4 * 3600000, level: 2, told: 'parent' } });
  const moving = task('m', { status: 'running', startedAt: now - 60000 });
  // A finished worker keeps no stale quiet flag, whatever the record says.
  const done = task('d', { status: 'succeeded', quiet: { since: now - 3600000, level: 0 } });
  assert.equal(D.isQuiet(quiet), true); assert.equal(D.isQuiet(moving), false); assert.equal(D.isQuiet(done), false);
  assert.match(D.stateLine(quiet, now), /running · 5 h · quiet 4 h/);
  assert.equal(D.stateOf(quiet).tone, 'warn'); assert.equal(D.stateOf(moving).tone, 'live');
  assert.match(D.warningOf(null, quiet, now), /No new output for 4 h\. It may be slow or stuck; nothing was stopped\. The conversation that started it was told\./);
  assert.match(D.warningOf(null, { ...quiet, quiet: { ...quiet.quiet, told: 'person' } }, now), /this is for you/);
  const index = D.indexTasks([quiet, moving, done]);
  const p = D.progress(index, ['q', 'm', 'd']);
  assert.equal(p.quiet, 1);
  assert.equal(D.progressLabel(p), '1/3 done · 1 quiet · 1 to review');
  assert.equal(D.summaryState(index, ['q', 'm']), '2 running · 1 quiet');
});

test('a quiet reminder reads as its own event, not as returned results', () => {
  assert.equal(D.eventSummary('delegation-attention', 'Delegated work has gone quiet.\n* A (task a): no new output for 20 min.'), '◌ delegated work went quiet');
  assert.equal(D.eventSummary('delegation-attention', 'x\n* A\n* B'), '◌ 2 delegated workers went quiet');
  // Running siblings listed with a result do not count as results.
  assert.equal(D.eventSummary('delegation-complete', 'Delegated work returned.\n- A: succeeded\nStill running:\n* B (task b), 1 h so far.'), '↩ 1 delegated result returned');
});
