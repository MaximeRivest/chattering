'use strict';
// What a conversation made (design/82): the live summary agrees with the
// saved review, and adds what is true now — disk, git, reviewed marks,
// whether the server runs the current code — without saving anything.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CheckpointStore } = require('../checkpoint-store');
const { ChangeReviews } = require('../change-reviews');
const L = require('../task-locations');
const { createMade, parseStatus, kindOf, isScratch } = require('../made');

function gitIn(cwd, args, when) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  if (when) env.GIT_COMMITTER_DATE = env.GIT_AUTHOR_DATE = `@${Math.floor(when / 1000)} +0000`;
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}

test('git status porcelain v2: branch, upstream, and each kind of path', () => {
  const raw = ['# branch.oid 1234', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/a b.js', '2 R. N... 100644 100644 100644 aaa bbb R100 new.js', 'old.js',
    '? fresh.md', '! out/plot.png', 'u UU N... 100644 100644 100644 100644 a b c both.txt', ''].join('\0');
  const s = parseStatus(raw);
  assert.deepEqual([s.branch, s.upstream, s.ahead, s.behind], ['main', 'origin/main', 2, 1]);
  assert.equal(s.paths.get('src/a b.js'), 'uncommitted', 'a path with a space');
  assert.equal(s.paths.get('new.js'), 'uncommitted');
  assert.equal(s.paths.has('old.js'), false, 'the original name of a rename is not a path of its own');
  assert.equal(s.paths.get('fresh.md'), 'new');
  assert.equal(s.paths.get('out/plot.png'), 'ignored');
  assert.equal(s.paths.get('both.txt'), 'conflict');
  assert.equal(parseStatus('# branch.oid (initial)\0# branch.head (detached)\0').branch, null);
});

test('kinds and scratch folders', () => {
  assert.deepEqual(['a.md', 'deck.html', 'x.PNG', 'r.pdf', 't.csv', 'app.js', 'n.ipynb'].map(kindOf), ['page', 'web', 'image', 'pdf', 'data', 'code', 'page']);
  assert.equal(isScratch(path.join(os.tmpdir(), 'x', 'y.py')), true);
  assert.equal(isScratch('/dev/null'), true);
  assert.equal(isScratch(path.join(os.homedir(), 'Projects', 'a.js')), false);
});

// One conversation that edits a committed file with saved steps, and a
// shell command that writes a picture and something in a temporary folder.
async function fixture(t, { withScratch = false } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'made-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'proj'); await fs.mkdir(root);
  gitIn(root, ['init', '-q', '-b', 'main']);
  await fs.writeFile(path.join(root, 'app.js'), 'one\ntwo\nthree\n');
  await fs.writeFile(path.join(root, '.gitignore'), 'out/\n');
  gitIn(root, ['add', '-A']); gitIn(root, ['commit', '-qm', 'start']);
  const cp = new CheckpointStore(path.join(dir, 'private'));
  const reviews = new ChangeReviews(cp);
  t.after(() => cp.close());
  const session = path.join(dir, 'conv.jsonl'); await fs.writeFile(session, '{}\n');
  const edit = { id: 'e1', name: 'edit', ts: new Date().toISOString(), success: true, input: { path: path.join(root, 'app.js'), edits: [{ oldText: 'two\n', newText: 'TWO\nand a half\n' }] } };
  const meta = { session, call: 'e1', run: 'run', tool: 'edit', targets: L.directTargets(edit.name, edit.input, root) };
  await cp.capture(root, { ...meta, phase: 'before' });
  await fs.writeFile(path.join(root, 'app.js'), 'one\nTWO\nand a half\nthree\n');
  await cp.capture(root, { ...meta, phase: 'after' });
  const scratchDir = path.join(dir, 'tmpish');
  const shell = { id: 'b1', name: 'bash', ts: new Date().toISOString(), success: true, input: { command: `mkdir -p out && echo png > out/plot.png && echo x > ${scratchDir}/probe.txt; echo y > /dev/null` } };
  await fs.mkdir(path.join(root, 'out')); await fs.writeFile(path.join(root, 'out', 'plot.png'), 'png');
  await fs.mkdir(scratchDir); await fs.writeFile(path.join(scratchDir, 'probe.txt'), 'x');
  const tools = [edit, shell];
  let inputs = 0;
  const agents = [{ key: 'conv', session, cwd: root, title: 'This conversation', depth: 0, parent: null }];
  const deps = {
    service: () => reviews,
    family: async () => ({ agents, warnings: [], project: 'proj' }),
    input: async agent => { inputs++; return { key: agent.key, session: agent.session, cwd: root, host: 'local', project: 'proj', tools, contextTools: [shell], sourceCalls: tools.map(x => x.id), calls: tools.map(x => x.id), otherEvents: [] }; },
    loaded: () => new Map(),
    branchScratch: () => false,
    isScratch: withScratch ? abs => abs.startsWith(scratchDir + path.sep) || abs.startsWith('/dev/') : () => false,
  };
  return { dir, root, cp, reviews, session, tools, deps, agents, count: () => inputs, scratchDir };
}

test('the summary lists the same files as the saved review, with what is true of them now', async t => {
  const f = await fixture(t, { withScratch: true });
  const made = createMade(f.deps);
  const s = await made.summary('conv');
  const task = await f.reviews.createTask({ ...(await f.deps.input(f.agents[0])), title: 'x' });
  const review = await f.reviews.createConversation({ key: 'conv', project: 'proj', title: 'Whole conversation', agents: [{ ...f.agents[0], review: task.id }], branches: [] });
  assert.deepEqual(s.files.map(x => x.path), review.files.map(x => x.path), 'one engine: the panel and the review agree');
  const app = s.files.find(x => x.path === 'app.js');
  assert.equal(app.status, 'modified');
  assert.deepEqual(app.lines, { add: 2, del: 1 });
  assert.equal(app.git, 'uncommitted');
  assert.equal(app.changedSince, false);
  assert.equal(app.reviewed, false);
  assert.equal(app.restart, false);
  assert.equal(s.repos.length, 1);
  assert.equal(s.repos[0].branch, 'main');
  assert.equal(s.repos[0].upstream, null, 'a branch with no upstream is only on this machine');
  assert.deepEqual(s.outputs.map(o => o.path), ['out/plot.png'], 'the picture is an output; scratch and /dev are not listed');
  assert.equal(s.outputs[0].shown, true);
  assert.equal(s.counts.scratchOutputs, 1);
  assert.deepEqual([s.counts.files, s.counts.toReview, s.counts.uncommitted], [1, 1, 1]);
  // Nothing was saved by the summary: only the review above.
  const rows = f.reviews.db.prepare('SELECT COUNT(*) AS n FROM change_reviews').get().n;
  await made.summary('conv');
  assert.equal(f.reviews.db.prepare('SELECT COUNT(*) AS n FROM change_reviews').get().n, rows);
});

test('reviewed follows the version a person marked; later edits and commits show', async t => {
  const f = await fixture(t);
  const made = createMade(f.deps);
  const task = await f.reviews.createTask({ ...(await f.deps.input(f.agents[0])), title: 'x' });
  f.reviews.mark(task.id, 'app.js', true);
  let s = await made.summary('conv');
  let app = s.files.find(x => x.path === 'app.js');
  assert.equal(app.reviewed, true, 'marked in a review of this conversation, same version');
  assert.equal(s.counts.toReview, 0);
  await fs.writeFile(path.join(f.root, 'app.js'), 'someone else\n');
  s = await made.summary('conv');
  app = s.files.find(x => x.path === 'app.js');
  assert.equal(app.changedSince, true, 'the disk no longer holds what the work produced');
  assert.equal(app.reviewed, true, 'what the work produced was reviewed; the later change is shown separately');
  await fs.writeFile(path.join(f.root, 'app.js'), 'one\nTWO\nand a half\nthree\n');
  gitIn(f.root, ['commit', '-qam', 'the change']);
  s = await made.summary('conv');
  app = s.files.find(x => x.path === 'app.js');
  assert.deepEqual([app.git, app.changedSince], ['committed', false]);
  f.reviews.mark(task.id, 'app.js', false);
  assert.equal((await made.summary('conv')).files[0].reviewed, false, 'unmarking counts');
});

test('a project kept in a temporary folder is the project, not scratch', async t => {
  const f = await fixture(t);
  const s = await createMade({ ...f.deps, isScratch: undefined }).summary('conv');
  assert.equal(s.files.find(x => x.path === 'app.js').scratch, undefined, 'its own files are its product');
  assert.deepEqual(s.outputs.map(o => o.path), ['out/plot.png']);
  assert.equal(s.counts.scratchOutputs, 1, 'the probe outside the project, in the same temporary folder, is scratch');
});

test('a finished agent is analysed once; a changed session is read again', async t => {
  const f = await fixture(t);
  const made = createMade(f.deps);
  const first = await made.summary('conv');
  await made.summary('conv');
  assert.equal(f.count(), 1, 'the second summary reuses the analysis');
  assert.equal((await made.summary('conv')).etag, first.etag, 'nothing changed, same answer');
  await fs.appendFile(f.session, '{"more":1}\n');
  await made.summary('conv');
  assert.equal(f.count(), 2);
  // Two requests at once share one computation.
  await fs.appendFile(f.session, '{"more":2}\n');
  await Promise.all([made.summary('conv'), made.summary('conv')]);
  assert.equal(f.count(), 3);
});

test('restart: the server compiled an older version than the one on disk', async t => {
  const f = await fixture(t);
  const abs = path.join(f.root, 'app.js');
  const loadedAt = (await fs.stat(abs)).mtimeMs - 60000;
  const made = createMade({ ...f.deps, loaded: () => new Map([[abs, loadedAt]]) });
  const s = await made.summary('conv');
  assert.equal(s.files[0].restart, true);
  assert.equal(s.counts.restart, 1);
  const now = (await fs.stat(abs)).mtimeMs;
  const current = createMade({ ...f.deps, loaded: () => new Map([[abs, now]]) });
  assert.equal((await current.summary('conv')).files[0].restart, false, 'loaded after the last change: live');
});

test('commits an agent made are listed with the branch state', async t => {
  const f = await fixture(t);
  const when = Date.now() + 3600000; // an hour after the fixture's own first commit
  const commitTool = { id: 'c1', name: 'bash', ts: new Date(when - 1000).toISOString(), endTs: new Date(when + 1000).toISOString(), success: true, input: { command: `cd ${f.root} && git add -A && git commit -qm "agent work"` } };
  gitIn(f.root, ['add', '-A']); gitIn(f.root, ['commit', '-qm', 'agent work'], when);
  f.tools.push(commitTool);
  const s = await createMade(f.deps).summary('conv');
  assert.equal(s.counts.commits, 1);
  assert.equal(s.repos[0].commits[0].subject, 'agent work');
  assert.equal(s.counts.unpushed, 1, 'a branch with commits and no upstream is not pushed anywhere');
  assert.equal(s.files.find(x => x.path === 'app.js').git, 'committed');
});
