'use strict';
// design/101: what a step's history saves, and that saving never holds the
// agent past its budget.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CheckpointStore, git, references, FOLDER_FILES_MAX } = require('../checkpoint-store');
const { checkpointExtension } = require('../checkpoint-extension');

async function fixture(t, options) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'checkpoint-budget-')));
  const root = path.join(dir, 'work'); await fs.mkdir(root);
  await git(['init', '-q'], { cwd: root });
  await fs.writeFile(path.join(root, 'main.py'), 'print(1)\n');
  const store = new CheckpointStore(path.join(dir, 'private'), options);
  t.after(async () => { store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { store, root, dir };
}
const files = async (store, result) => (await store.snapshot(result.snapshot)).manifest;
const saved = async (store, result) => (await files(store, result)).filter(f => f.oid).map(f => f.path).sort();

test('references: what a page, a style sheet or a document names, never addresses elsewhere', () => {
  const html = `<link href="style.css" rel=stylesheet><img src=img/a.png srcset="img/b.png 1x, img/c.png 2x">
    <script type="module" src="./app.js?v=3"></script><a href="https://x.org/y.png">x</a><img src="data:image/png;base64,AAAA">
    <img src="/abs/root.png"><img src="pic%20one.png#frag"><script>fetch('data/run.json'); const n = "1.5"; const t = 'text/plain';</script>`;
  assert.deepEqual(references(html).sort(), ['./app.js', 'data/run.json', 'img/a.png', 'img/b.png', 'img/c.png', 'pic one.png', 'style.css']);
  assert.deepEqual(references('body { background: url(bg.png) } .x { background: url("../up.svg") }').sort(), ['../up.svg', 'bg.png']);
  assert.deepEqual(references('# Notes\n![chart](figures/chart.png "Chart") and [the data](data.csv)').sort(), ['data.csv', 'figures/chart.png']);
});

test('a page artifact saves the page and what it uses, not the folder around it', async t => {
  const { store, root } = await fixture(t);
  const out = path.join(root, 'out');
  await fs.mkdir(path.join(out, 'img'), { recursive: true });
  // Output folders are usually ignored: an artifact is saved anyway.
  await fs.writeFile(path.join(root, '.gitignore'), 'out/\n');
  await fs.writeFile(path.join(out, 'index.html'), '<link rel="stylesheet" href="style.css"><img src="img/a.png"><script>fetch("data.json")</script>');
  await fs.writeFile(path.join(out, 'style.css'), 'body { background: url(img/bg.png) }');
  for (const name of ['img/a.png', 'img/bg.png', 'big-unrelated.png']) await fs.writeFile(path.join(out, name), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
  await fs.writeFile(path.join(out, 'data.json'), '{"rows":[]}');
  await fs.writeFile(path.join(out, 'other-run.json'), '{"rows":[1]}');
  const declared = await store.declareArtifact(root, path.join(out, 'index.html'));
  assert.equal(declared.folder, false);
  const r = await store.capture(root, { phase: 'after' });
  assert.equal(r.error, '');
  assert.deepEqual(await saved(store, r), ['.gitignore', 'main.py', 'out/data.json', 'out/img/a.png', 'out/img/bg.png', 'out/index.html', 'out/style.css']);
  // A picture the page starts to use is saved from then on.
  await fs.writeFile(path.join(out, 'index.html'), '<img src="img/a.png"><img src="big-unrelated.png">');
  assert.ok((await saved(store, await store.capture(root, { phase: 'after' }))).includes('out/big-unrelated.png'));
});

test('a folder artifact is saved whole while small; past the limit only its page, and the person is told', async t => {
  const { store, root } = await fixture(t);
  const app = path.join(root, 'app'), runs = path.join(root, 'runs');
  await fs.mkdir(app); await fs.mkdir(path.join(runs, 'frames'), { recursive: true });
  await fs.writeFile(path.join(app, 'index.html'), '<img src="logo.png">');
  await fs.writeFile(path.join(app, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
  await fs.writeFile(path.join(app, 'helper.js'), 'export {}');
  await fs.writeFile(path.join(runs, 'index.html'), '<img src="frames/0.png">');
  await Promise.all(Array.from({ length: FOLDER_FILES_MAX + 1 }, (_, i) => fs.writeFile(path.join(runs, 'frames', i + '.png'), Buffer.from([i & 255]))));
  assert.equal((await store.declareArtifact(root, app)).whole, true);
  const big = await store.declareArtifact(root, runs);
  assert.equal(big.whole, false);
  assert.match(big.over, /more than 1,000 files/);
  assert.equal(big.entry, path.join(runs, 'index.html'));
  const r = await store.capture(root, { phase: 'after' });
  assert.equal(r.error, '');
  const list = await saved(store, r);
  assert.ok(['app/helper.js', 'app/index.html', 'app/logo.png'].every(f => list.includes(f)), 'the small folder whole');
  assert.deepEqual(list.filter(f => f.startsWith('runs/')), ['runs/frames/0.png', 'runs/index.html'], 'the large one as its page');
  assert.deepEqual(r.notes, [{ path: 'runs/', text: 'only index.html and the files it uses are saved (too large to save whole: more than 1,000 files)' }]);
});

test('artifacts share one allowance per step, the most recently shown first', async t => {
  const { store, root } = await fixture(t, { limits: { artifactBytes: 3000 } });
  for (const name of ['old', 'new']) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, 'index.html'), '<img src="pic.png">');
    await fs.writeFile(path.join(root, name, 'pic.png'), Buffer.alloc(2000, 1));
  }
  await store.declareArtifact(root, path.join(root, 'old'));
  store.db.prepare('UPDATE artifact_entries SET declared=declared-60000').run();
  await store.declareArtifact(root, path.join(root, 'new'));
  const r = await store.capture(root, { phase: 'after' });
  assert.equal(r.error, '');
  const list = await saved(store, r);
  assert.ok(list.includes('new/pic.png') && !list.includes('old/pic.png'), JSON.stringify(list));
  assert.match(r.notes[0].text, /used by ones shown more recently/);
});

test('limits are checked before anything is read or stored', async t => {
  const { store, root } = await fixture(t, { limits: { bytes: 1000 } });
  await fs.mkdir(path.join(root, 'results'));
  await fs.writeFile(path.join(root, 'results', 'a.json'), 'x'.repeat(600));
  await fs.writeFile(path.join(root, 'results', 'b.json'), 'y'.repeat(600));
  const r = await store.capture(root, { phase: 'after' });
  assert.match(r.error, /^This project has 2 KB of files to save, more than the 1 KB limit \(2 KB in results\/\)$/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM checkpoint_objects').get().n, 0, 'nothing was stored for a capture that could not finish');
});

test('logs are never saved, and a growing output file is left out without failing the step', async t => {
  const { store, root } = await fixture(t);
  await fs.writeFile(path.join(root, 'server.log'), 'line\n');
  const r = await store.capture(root, { phase: 'after' });
  assert.equal(r.error, '');
  assert.deepEqual((await files(store, r)).find(f => f.path === 'server.log'), { path: 'server.log', unavailable: 'Log file' });
  // A file written while it is read: its size moves under the reader.
  const out = path.join(root, 'out.txt');
  await fs.writeFile(out, 'start\n');
  const open = fs.open;
  t.mock.method(fs, 'open', async (file, ...rest) => {
    const handle = await open(file, ...rest);
    if (file === out) await fs.appendFile(out, 'more\n');
    return handle;
  });
  const growing = await store.capture(root, { phase: 'after' });
  assert.equal(growing.error, '');
  assert.deepEqual((await files(store, growing)).find(f => f.path === 'out.txt'), { path: 'out.txt', unavailable: 'Changing while it was being saved' });
  assert.ok((await saved(store, growing)).includes('main.py'), 'the rest of the step is saved');
});

test('a capture never holds its caller past its budget', async t => {
  const { store, root, dir } = await fixture(t);
  const key = await store.root(root);
  const meta = { session: 's', run: 'r', phase: 'before' };
  const timed = async (...args) => { const t0 = Date.now(); const r = await store.capture(...args); return { r, ms: Date.now() - t0 }; };
  // Behind another capture of the same folder that does not finish.
  store.queues.set(key, new Promise(() => {}));
  const queued = await timed(root, { ...meta, call: 'q' }, { budget: 150 });
  assert.ok(queued.ms < 1000, queued.ms + ' ms');
  assert.match(queued.r.error, /^Saving took longer than 0\.2 s, so it was skipped/);
  assert.equal(store.boundariesByCalls(['q'])[0].error, queued.r.error, 'the step is recorded as not saved');
  store.queues.delete(key);
  // While another process tidies the store.
  const other = new CheckpointStore(path.join(dir, 'private'));
  const tidying = await other.lease(key, 'exclusive');
  const blocked = await timed(root, { ...meta, call: 'l' }, { budget: 150 });
  assert.ok(blocked.ms < 1000, blocked.ms + ' ms');
  assert.match(blocked.r.error, /being tidied/);
  tidying.release(); other.close();
  // Stopped: no warning-worthy failure, just not saved.
  const stop = new AbortController(); stop.abort();
  const stopped = await timed(root, { ...meta, call: 's' }, { budget: 5000, signal: stop.signal });
  assert.equal(stopped.r.stopped, true);
  // The work done before a deadline is kept: the next capture finishes.
  const late = await store.capture(root, { ...meta, call: 'd' }, { budget: 1 });
  assert.match(late.error, /longer than/);
  assert.equal((await store.capture(root, { ...meta, call: 'ok' }, { budget: 5000 })).error, '');
});

test('nothing changed since the last save: the same snapshot, rebuilt if it was removed meanwhile', async t => {
  const { store, root } = await fixture(t);
  const a = await store.capture(root, { phase: 'after' });
  assert.equal((await store.capture(root, { phase: 'before' })).snapshot, a.snapshot);
  // Maintenance removed it: the same files make it again, never a dangling id.
  store.db.prepare('DELETE FROM checkpoint_snapshots WHERE id=?').run(a.snapshot);
  const b = await store.capture(root, { phase: 'before' });
  assert.equal(b.snapshot, a.snapshot);
  assert.ok(store.db.prepare('SELECT 1 FROM checkpoint_snapshots WHERE id=?').get(b.snapshot));
  await fs.writeFile(path.join(root, 'main.py'), 'print(2)\n');
  assert.notEqual((await store.capture(root, { phase: 'before' })).snapshot, a.snapshot);
});

test('the extension: only a step\u2019s start holds the agent; the rest follows in order, and stopping is immediate', async t => {
  const calls = [], notices = [];
  const store = {
    capture(cwd, meta, opts) {
      let resolve; const done = new Promise(r => { resolve = r; });
      calls.push({ meta, opts, resolve });
      return done;
    },
    close() {},
  };
  const handlers = new Map();
  checkpointExtension({ on: (name, fn) => handlers.set(name, fn), getAllTools: () => [] }, { store, allowLoose: true });
  const stop = new AbortController();
  const ctx = { cwd: '/work', signal: stop.signal, sessionManager: { getSessionFile: () => '/s.jsonl' }, ui: { notify: s => notices.push(s) } };
  const settledNow = async promise => { let done = false; promise.then(() => { done = true; }); await new Promise(r => setImmediate(r)); return done; };

  assert.equal(await settledNow(handlers.get('before_agent_start')({ prompt: 'go' }, ctx)), true, 'sending does not wait');
  assert.equal(calls[0].meta.phase, 'run-before');
  assert.equal(calls[0].opts.budget, 10000);

  const step = handlers.get('tool_call')({ toolName: 'bash', toolCallId: 'b1', input: { command: 'make' } }, ctx);
  assert.equal(await settledNow(step), false, 'the tool waits for its starting point');
  assert.equal(calls[1].meta.phase, 'before');
  assert.equal(calls[1].opts.budget, 2000);
  assert.equal(calls[1].opts.signal, stop.signal, 'stopping the run stops the wait');
  calls[1].resolve({ error: 'This project has 201 MB of files to save, more than the 200 MB limit', notes: [] });
  await step;

  assert.equal(await settledNow(handlers.get('tool_result')({ toolName: 'bash', toolCallId: 'b1', input: { command: 'make' } }, ctx)), true, 'a step\u2019s end does not wait');
  assert.equal(calls[2].meta.phase, 'after');
  // A second step is stopped before it returns: the end of the turn is one
  // copy that also closes the open step.
  const second = handlers.get('tool_call')({ toolName: 'bash', toolCallId: 'b2', input: { command: 'make' } }, ctx);
  calls.at(-1).resolve({ error: 'This project has 202 MB of files to save, more than the 200 MB limit', notes: [] });
  await second;
  assert.equal(await settledNow(handlers.get('agent_settled')({}, ctx)), true, 'stopping does not wait for history');
  const settle = calls.at(-1);
  assert.equal(settle.meta.phase, 'run-settled');
  assert.deepEqual(settle.meta.rows, [{ call: 'b2', tool: 'bash', phase: 'settled-incomplete', overlapping: false }]);
  assert.deepEqual(notices, ['File history did not save this step: This project has 201 MB of files to save, more than the 200 MB limit'], 'one warning per reason per turn');

  // Closing waits for the copies still being made.
  const shutdown = handlers.get('session_shutdown')({}, ctx);
  assert.equal(await settledNow(shutdown), false);
  for (const c of calls) c.resolve({ error: '', notes: [] });
  for (let i = 0; i < 100 && calls.at(-1).meta.phase !== 'shutdown'; i++) await new Promise(r => setImmediate(r));
  calls.at(-1).resolve({ error: '', notes: [] });
  await shutdown;
  assert.equal(calls.at(-1).meta.phase, 'shutdown');
});

test('folders recorded before design/101 become what was actually shown in them', async t => {
  const { store, root } = await fixture(t);
  const charts = path.join(root, 'charts'), site = path.join(root, 'site'), lost = path.join(root, 'lost');
  for (const d of [charts, site, lost]) await fs.mkdir(d);
  await fs.writeFile(path.join(root, '.gitignore'), 'charts/\n');
  await fs.writeFile(path.join(charts, 'find.png'), Buffer.from([0x89, 0x50]));
  await fs.writeFile(path.join(charts, 'unrelated.json'), '{}');
  await fs.writeFile(path.join(site, 'index.html'), '<p>x</p>');
  for (const d of [charts, site, lost]) store.db.prepare('INSERT INTO artifact_scopes VALUES (?,?)').run(root, d);
  const r = await store.convertLegacyScopes([{ path: path.join(charts, 'find.png'), at: Date.now() }, { path: site, at: Date.now() }, { path: '/elsewhere/x.html', at: 1 }]);
  assert.deepEqual(r, { folders: 3, kept: 2, dropped: 1 });
  assert.deepEqual(store.artifactEntries(root).map(e => [path.basename(e.path), e.folder]), [['find.png', false], ['site', true]]);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM artifact_scopes').get().n, 0);
  const saved = (await store.snapshot((await store.capture(root, { phase: 'after' })).snapshot)).manifest.map(f => f.path);
  assert.ok(saved.includes('charts/find.png') && !saved.includes('charts/unrelated.json'), JSON.stringify(saved));
});

test('captures asked for back to back are saved in that order, the first call for a folder included', async t => {
  const { store, root } = await fixture(t);
  const sub = path.join(root, 'sub'); await fs.mkdir(sub);
  const order = ['end', 'start', 'end2', 'start2'];
  await Promise.all(order.map((call, i) => store.capture(i % 2 ? sub : root, { session: 's', run: 'r', call, phase: 'x' })));
  assert.deepEqual(store.boundariesByCalls(order).map(b => b.call), order);
});
