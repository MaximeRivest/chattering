'use strict';
// A whole conversation and its sub-agents as one review (design/79):
// commits found from the agents' own git commands, and every agent's task
// review joined into one list of files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CheckpointStore } = require('../checkpoint-store');
const { ChangeReviews } = require('../change-reviews');
const L = require('../task-locations');
const { branchWork, committingDirs, stripHeredocs } = require('../branch-work');
const { fixtureCleanup } = require('./helpers/fixture-cleanup');
const { shellPath } = require('./helpers/shell-path');

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const at = minutes => T0 + minutes * 60000;
function gitIn(cwd, args, when) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  if (when) env.GIT_COMMITTER_DATE = env.GIT_AUTHOR_DATE = `@${Math.floor(when / 1000)} +0000`;
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}
async function commit(cwd, file, text, when) {
  await fs.writeFile(path.join(cwd, file), text);
  gitIn(cwd, ['add', '-A']); gitIn(cwd, ['commit', '-q', '-m', `${file}: ${text}`], when);
  return gitIn(cwd, ['rev-parse', 'HEAD']);
}
// A shell step that ran `git commit` in `dir` around `when`.
const committed = (dir, when) => ({ name: 'bash', input: { command: `cd ${shellPath(dir)} && git add -A && git commit -q -F - <<'EOF'\ncd /elsewhere && git commit\nEOF` }, ts: new Date(when - 500).toISOString(), endTs: new Date(when + 500).toISOString() });

test('committing folders follow cd and -C, never a heredoc body', () => {
  const cwd = path.resolve('/w'); // a rooted local path uses the current drive on Windows
  assert.deepEqual([...committingDirs('cd /a && git add -A && git commit -m x', cwd)], [path.resolve('/a')]);
  assert.deepEqual([...committingDirs('git -C ../b commit -m x; git status', path.join(cwd, 'c'))], [path.join(cwd, 'b')]);
  assert.deepEqual([...committingDirs('git log --oneline', cwd)], [], 'reading history commits nothing');
  assert.deepEqual([...committingDirs("git commit -F - <<'EOF'\ncd /x && git merge y\nEOF", cwd)], [cwd]);
  assert.equal(stripHeredocs("a <<EOF\nsecret\nEOF\nb"), 'a <<EOF\nb');
  assert.deepEqual([...committingDirs('cd $DIR && git commit', cwd)], [cwd], 'an unknown folder is not guessed');
});

async function repos(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'conv-review-')));
  const cleanup = fixtureCleanup(t, () => fs.rm(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'proj'); await fs.mkdir(main);
  gitIn(main, ['init', '-q', '-b', 'main']);
  const c0 = await commit(main, 'a.txt', 'zero', at(0));
  const w1 = path.join(dir, 'w1'); gitIn(main, ['worktree', 'add', '-q', '-b', 'one', w1, c0]);
  const c1 = await commit(w1, 'a.txt', 'one', at(10));
  const c2 = await commit(w1, 'b.txt', 'someone else', at(20));
  const c3 = await commit(w1, 'a.txt', 'three', at(30));
  const w2 = path.join(dir, 'w2'); gitIn(main, ['worktree', 'add', '-q', '-b', 'two', w2, c3]);
  const c4 = await commit(w2, 'c.txt', 'four', at(40));
  const w3 = path.join(dir, 'w3'); gitIn(main, ['worktree', 'add', '-q', '-b', 'three', w3, c3]);
  const c5 = await commit(w3, 'a.txt', 'five', at(50));
  const sources = [
    { agent: 1, cwd: w1, tools: [committed(w1, at(10)), committed(w1, at(30))] },
    { agent: 2, cwd: w2, tools: [committed(w2, at(40))] },
    { agent: 3, cwd: '/nowhere', tools: [{ name: 'bash', input: { command: `git -C ${shellPath(w3)} commit -qm five` }, ts: new Date(at(50) - 500).toISOString(), endTs: new Date(at(50) + 500).toISOString() }] },
  ];
  return { dir, main, w1, w2, w3, c: [c0, c1, c2, c3, c4, c5], sources, cleanup };
}

test('branch work: ranges from the agents\u2019 own commits, others\u2019 commits named', async t => {
  const { w1, c, sources } = await repos(t);
  const sections = await branchWork(sources, { scratch: () => false });
  const one = sections.find(s => s.branch === 'one');
  assert.equal(one.base, c[0]); assert.equal(one.head, c[3]);
  assert.deepEqual(one.commits.map(x => x.hash), [c[3], c[1]]);
  assert.deepEqual(one.foreign.map(x => x.hash), [c[2]], 'a commit made outside the agents\u2019 commands is counted, not hidden');
  assert.deepEqual(one.files.map(f => f.path), ['proj@one: a.txt', 'proj@one: b.txt']);
  assert.deepEqual(one.agents, [1]);
  // Two branches start where "one" ends: each stays its own section.
  assert.equal(sections.find(s => s.branch === 'two').base, c[3]);
  assert.equal(sections.find(s => s.branch === 'three').base, c[3]);
  assert.equal(sections.length, 3);
  assert.equal(one.files[0].livePath, path.join(w1, 'a.txt'));
});

test('branch work: a repair branch that continues another joins it', async t => {
  const { c, sources } = await repos(t);
  const sections = await branchWork(sources.slice(0, 2), { scratch: () => false });
  assert.equal(sections.length, 1);
  assert.deepEqual([sections[0].base, sections[0].head], [c[0], c[4]]);
  assert.deepEqual(sections[0].branches, ['one', 'two']);
  assert.equal(sections[0].label, 'proj@two');
  assert.deepEqual(sections[0].agents.sort(), [1, 2]);
  const scratch = await branchWork(sources, { warn: () => {} });
  assert.equal(scratch.length, 0, 'repositories in a temporary folder are scratch by default');
});

test('conversation review: one file edited by two agents, and their commits', async t => {
  const { dir, main, w1, sources, cleanup } = await repos(t);
  const cp = new CheckpointStore(path.join(dir, 'private'));
  const reviews = new ChangeReviews(cp);
  cleanup.add(() => cp.close());
  // Two agents edit the same file in turn, each with its own saved steps.
  const file = path.join(main, 'notes.md');
  await fs.writeFile(file, 'first');
  const step = async (session, id, from, to, when) => {
    const tool = { id, name: 'edit', ts: new Date(when).toISOString(), success: true, input: { path: file, edits: [{ oldText: from, newText: to }] } };
    const meta = { session, call: id, run: 'run-' + id, tool: 'edit', targets: L.directTargets(tool.name, tool.input, main) };
    await cp.capture(main, { ...meta, phase: 'before' });
    await fs.writeFile(file, to);
    await cp.capture(main, { ...meta, phase: 'after' });
    return reviews.createTask({ key: session, session, project: 'proj', cwd: main, calls: [id], tools: [tool], title: session });
  };
  const parent = await step('parent.jsonl', 'same-id', 'first', 'second', Date.now());
  const child = await step('child.jsonl', 'same-id', 'second', 'third', Date.now() + 1000);
  const branches = await branchWork(sources, { scratch: () => false });
  const r = await reviews.createConversation({ key: 'parent.jsonl', project: 'proj', title: 'Whole conversation',
    agents: [{ key: 'parent.jsonl', title: 'Parent', depth: 0, parent: null, review: parent.id }, { key: 'child.jsonl', title: 'Child', depth: 1, parent: 0, review: child.id }], branches });
  assert.equal(r.kind, 'conversation');
  const notes = r.files.find(f => f.path === 'notes.md');
  assert.deepEqual(notes.agents, [0, 1]);
  const both = await reviews.file(r.id, 'notes.md');
  assert.equal(both.old.text, 'first', 'before the first agent\u2019s edit');
  assert.equal(both.next.text, 'third', 'after the last agent\u2019s edit');
  assert.deepEqual(r.steps.map(s => s.call), ['same-id', 'a1:same-id'], 'a sub-agent\u2019s step ids cannot collide with the parent\u2019s');
  const childStep = r.steps.find(s => s.agent === 1).call;
  assert.equal((await reviews.file(r.id, 'notes.md', childStep)).old.text, 'second', 'one step still shows only its own change');
  // The commits, read from git.
  const committedFile = r.branchFiles.find(f => f.path === 'proj@one: a.txt');
  assert.ok(committedFile);
  const read = await reviews.file(r.id, committedFile.path, '', false, 'branch');
  assert.deepEqual([read.old.text, read.next.text], ['zero', 'three']);
  assert.equal(read.changedSince, false, 'the worktree still holds the committed version');
  const added = await reviews.file(r.id, 'proj@two: c.txt', '', false, 'branch');
  assert.equal(added.old.absent, true);
  const comment = await reviews.comment(r.id, { path: committedFile.path, scope: 'branch', side: 'next', line: 1, text: 'Why three?' });
  assert.equal(comment.scope, 'branch'); assert.equal(comment.quote, 'three');
  const message = (await reviews.prepare(r.id, 'parent.jsonl')).message;
  assert.match(message, /Commits on proj@one .*: [0-9a-f]{40}\.\.[0-9a-f]{40} · 2 made in this conversation, 1 by others/);
  assert.match(message, /\[committed version on a branch\]/);
  // The same inputs give the same review.
  const again = await reviews.createConversation({ key: 'parent.jsonl', project: 'proj', title: 'Whole conversation',
    agents: [{ key: 'parent.jsonl', title: 'Parent', depth: 0, parent: null, review: parent.id }, { key: 'child.jsonl', title: 'Child', depth: 1, parent: 0, review: child.id }], branches });
  assert.equal(again.id, r.id);
  await fs.writeFile(path.join(w1, 'a.txt'), 'edited later');
  assert.equal((await reviews.file(r.id, committedFile.path, '', false, 'branch')).changedSince, true);
});

test('a finished agent\u2019s review is reused while its session and checkpoints are unchanged', async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'conv-cache-')));
  const cleanup = fixtureCleanup(t, () => fs.rm(dir, { recursive: true, force: true }));
  const cp = new CheckpointStore(path.join(dir, 'private')), reviews = new ChangeReviews(cp);
  cleanup.add(() => cp.close());
  const session = path.join(dir, 's.jsonl'); await fs.writeFile(session, '{}\n');
  const sig = reviews.agentSignature(session, await fs.stat(session));
  assert.equal(reviews.cachedAgent(session, sig), undefined);
  reviews.rememberAgent(session, sig, null);
  assert.equal(reviews.cachedAgent(session, sig), null, 'an agent that changed nothing is remembered too');
  await fs.appendFile(session, '{"more":1}\n');
  assert.equal(reviews.cachedAgent(session, reviews.agentSignature(session, await fs.stat(session))), undefined, 'a longer session is read again');
});
